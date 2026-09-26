/** Pure helpers that assemble the RunningHub submit payload and dry-run validation. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { NodeInfoItem } from './gateway.ts'
import { inputMetaFor, type ObjectInfoRegistry } from './nodeinfo.ts'
import { parseStoredPrompt, removeWorkflowNodes, setGraphInput, type ApiWorkflow } from './workflow.ts'
import type { MediaSlot, NodeParamOverride, WorkflowDefinition } from './settings.ts'

/** A value that counts as "not filled in" for a default param. */
function isEmptyValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value === ''
  return false
}

/** Assemble the nodeInfoList from a workflow's default params (media slots are filled at run time). */
export function buildNodeInfoList(def: WorkflowDefinition): NodeInfoItem[] {
  const list: NodeInfoItem[] = []
  for (const param of def.nodeDefaults) {
    if (isEmptyValue(param.fieldValue)) continue
    const fieldValue = param.fieldValue
    if (fieldValue === undefined || fieldValue === null) continue
    list.push({ nodeId: param.nodeId, fieldName: param.fieldName, fieldValue })
  }
  return list
}

export interface ValidationResult {
  ok: boolean
  nodeInfoList: NodeInfoItem[]
  /** `nodeId.fieldName` labels for required params that still lack a value. */
  missingParams: string[]
  /** `nodeId.fieldName (type)` labels for required media slots (filled at run time). */
  requiredMedia: string[]
  /** `nodeId.fieldName` labels for every default param that is optional-but-unfilled. */
  optionalEmpty: string[]
}

/**
 * Free structural validation (no API call): builds the payload from defaults and
 * reports which required params/slots are still missing. Media slots are only
 * annotated (they are filled with uploaded media when the task actually runs).
 */
export function validateWorkflowDefinition(def: WorkflowDefinition): ValidationResult {
  const missingParams: string[] = []
  const optionalEmpty: string[] = []
  for (const param of def.nodeDefaults) {
    if (isEmptyValue(param.fieldValue)) {
      if (param.required) missingParams.push(`${param.nodeId}.${param.fieldName}`)
      else optionalEmpty.push(`${param.nodeId}.${param.fieldName}`)
    }
  }
  const requiredMedia = def.mediaSlots
    .filter(slot => slot.required)
    .map(slot => `${slot.nodeId}.${slot.fieldName} (${slot.type})`)
  const nodeInfoList = buildNodeInfoList(def)
  return {
    ok: missingParams.length === 0,
    nodeInfoList,
    missingParams,
    requiredMedia,
    optionalEmpty,
  }
}

/** Reconcile runtime overrides (from a tool call) onto a workflow definition. */
export function applyParamOverrides(
  def: WorkflowDefinition,
  overrides: readonly NodeParamOverride[],
): WorkflowDefinition {
  if (overrides.length === 0) return def
  const byKey = new Map(def.nodeDefaults.map(param => [`${param.nodeId}\u0000${param.fieldName}`, param]))
  for (const override of overrides) {
    const key = `${override.nodeId}\u0000${override.fieldName}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { ...override })
    } else {
      // Copy before merging: the map seeded from `def` shares its param
      // objects, and mutating them would corrupt the caller's definition.
      const merged = { ...existing }
      if (override.fieldValue !== undefined) merged.fieldValue = override.fieldValue
      const label = override.label ?? existing.label
      if (label !== undefined) merged.label = label
      byKey.set(key, merged)
    }
  }
  return { ...def, nodeDefaults: [...byKey.values()] }
}

/** The media slots a definition still expects, keyed for run-time mapping. */
export function mediaSlotKeys(def: WorkflowDefinition): string[] {
  return def.mediaSlots.map(slot => `${slot.nodeId}\u0000${slot.fieldName}`)
}

export type { MediaSlot }

/** A per-param / per-slot entry, as far as its user-curated marks go. */
interface Markable {
  nodeId: string
  fieldName: string
  label?: string
  required?: boolean
  attention?: boolean
}

/**
 * Carry the marks a user (or the describe pass) put on params/slots across a
 * refresh. `runninghub_refresh_workflow` rebuilds both lists from the fetched
 * prompt, which only ever yields registry data — overwriting wholesale would
 * silently clear every ★ attention, * required and custom label. Entries the
 * refreshed prompt no longer has are dropped; a label the refreshed data does
 * carry (a media slot's node title) wins, since the node was renamed upstream.
 */
export function carryUserMarks<T extends Markable>(previous: readonly T[], next: readonly T[]): T[] {
  const marks = new Map(previous.map(item => [`${item.nodeId}\u0000${item.fieldName}`, item]))
  return next.map((item) => {
    const prev = marks.get(`${item.nodeId}\u0000${item.fieldName}`)
    if (prev === undefined) return item
    return {
      ...item,
      ...(prev.label !== undefined && item.label === undefined ? { label: prev.label } : {}),
      ...(prev.required !== undefined ? { required: prev.required } : {}),
      ...(prev.attention !== undefined ? { attention: prev.attention } : {}),
    }
  })
}

/** One param whose value is not one of the combo choices its node declares. */
export interface ComboViolation {
  nodeId: string
  fieldName: string
  value: string
  options: string[]
}

/** Legal values, trimmed for prompts: nobody needs 163 sampler names in an error. */
export function formatComboOptions(options: readonly string[], max = 8): string {
  const head = options.slice(0, max).join(', ')
  return options.length > max ? `${head} … (${options.length} total)` : head
}

const ASSET_EXT_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl|pth|ya?ml|json|mp3|wav|flac|mp4)$/i

/**
 * Combo choices that are really a *file list* are not closed enums: the proxy's
 * registry and the server's own model folder disagree (a saved
 * `qwen_image_2.1_bf16.safetensors` is missing from the registry yet runs
 * fine), so never reject — or quote — those.
 */
function closedChoices(value: string, options: readonly string[]): string[] | undefined {
  if (ASSET_EXT_RE.test(value) || options.every(option => ASSET_EXT_RE.test(option))) return undefined
  return [...options]
}

/**
 * Find values outside a combo's choice list. RunningHub only rejects them once
 * a paid task reaches the node (`prompt_outputs_failed_validation / Value not
 * in list`), which is exactly how four runs produced nothing; the node registry
 * — or the options a previous enrichment already stored — knows the list
 * up front. Unknown classes/fields are left alone (custom nodes).
 */
export function findIllegalComboValues(
  def: WorkflowDefinition,
  registry?: ObjectInfoRegistry,
): ComboViolation[] {
  const classTypes = classTypesOf(def.prompt)
  const violations: ComboViolation[] = []
  for (const param of def.nodeDefaults) {
    const value = param.fieldValue
    if (typeof value !== 'string' || value === '') continue
    const declared = comboOptionsFor(param, classTypes, registry)
    const options = declared === undefined ? undefined : closedChoices(value, declared)
    if (options === undefined || options.includes(value)) continue
    violations.push({ nodeId: param.nodeId, fieldName: param.fieldName, value, options })
  }
  return violations
}

function comboOptionsFor(
  param: NodeParamOverride,
  classTypes: ReadonlyMap<string, string>,
  registry: ObjectInfoRegistry | undefined,
): string[] | undefined {
  if (param.kind === 'select' && param.options !== undefined && param.options.length > 0) return param.options
  const classType = classTypes.get(param.nodeId)
  if (classType === undefined || registry === undefined) return undefined
  return inputMetaFor(registry, classType, param.fieldName)?.options
}

/** nodeId → class_type, read back out of the stored api-format graph. */
function classTypesOf(prompt: WorkflowDefinition['prompt']): Map<string, string> {
  return new Map((parseStoredPrompt(prompt)?.nodes ?? []).map(node => [node.nodeId, node.classType]))
}

/**
 * One line of hard, registry-declared facts about this workflow's editable
 * params — the enum choices and numeric bounds the node type itself enforces.
 * Handed to the description model so its usage notes quote real values instead
 * of inventing them. Capped: a 49-param workflow must not crowd out the digest.
 */
export function describeParamConstraints(def: WorkflowDefinition, registry?: ObjectInfoRegistry): string {
  if (registry === undefined) return ''
  const classTypes = classTypesOf(def.prompt)
  const parts: string[] = []
  let length = 0
  for (const param of def.nodeDefaults) {
    const classType = classTypes.get(param.nodeId)
    if (classType === undefined) continue
    const meta = inputMetaFor(registry, classType, param.fieldName)
    if (meta === undefined) continue
    const choices = meta.options === undefined ? undefined : closedChoices('', meta.options)
    const part = choices !== undefined && choices.length > 0
      ? `#${param.nodeId} ${param.fieldName}: one of [${formatComboOptions(choices, 12)}]`
      : (meta.min !== undefined || meta.max !== undefined)
        ? `#${param.nodeId} ${param.fieldName} (${meta.kind}): ${meta.min ?? ''}..${meta.max ?? ''}`
        : ''
    if (part === '') continue
    if (length + part.length > 1200) break
    length += part.length + 2
    parts.push(part)
  }
  return parts.join('; ')
}

/**
 * Build the final submit-time graph from a saved definition:
 *  1. start from the stored raw api-format prompt (the exact fetched graph);
 *  2. write every param default (with user overrides already merged) into the
 *     graph's node inputs — mirrors legacy nodeInfoList semantics;
 *  3. write supplied media values (uploaded fileName / URL) into their Load
 *     nodes;
 *  4. CUT media slots with no supplied media: remove the Load node, and with
 *     it every downstream node that has nothing left to run on (Omni-Canvas
 *     semantics — never a blank placeholder).
 * Returns the stringified workflow for createTask's `workflow` field.
 */
export function buildWorkflowGraph(
  def: WorkflowDefinition,
  mediaValues: readonly NodeInfoItem[],
  unfilledSlots: readonly MediaSlot[],
  registry?: ObjectInfoRegistry,
): string {
  const raw = def.prompt
  let graph: ApiWorkflow = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ApiWorkflow

  for (const param of def.nodeDefaults) {
    if (param.fieldValue === undefined) continue // keep the graph's own default
    graph = setGraphInput(graph, param.nodeId, param.fieldName, param.fieldValue)
  }
  for (const media of mediaValues) {
    graph = setGraphInput(graph, media.nodeId, media.fieldName, media.fieldValue)
  }

  const removed = new Set(unfilledSlots.map(slot => slot.nodeId).filter(id => graph[id] !== undefined))
  if (removed.size > 0) {
    graph = removeWorkflowNodes(graph, removed, registry)
  }
  return JSON.stringify(graph)
}
