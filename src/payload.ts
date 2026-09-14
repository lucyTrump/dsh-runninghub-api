/** Pure helpers that assemble the RunningHub submit payload and dry-run validation. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { NodeInfoItem } from './gateway.ts'
import { clearRefLinksToAffected, downstreamAffected, removeWorkflowNodes, setGraphInput, type ApiWorkflow } from './workflow.ts'
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

/**
 * Build the final submit-time graph from a saved definition:
 *  1. start from the stored raw api-format prompt (the exact fetched graph);
 *  2. write every param default (with user overrides already merged) into the
 *     graph's node inputs — mirrors legacy nodeInfoList semantics;
 *  3. write supplied media values (uploaded fileName / URL) into their Load
 *     nodes;
 *  4. CUT media slots with no supplied media: remove the Load node, clean
 *     links to it, and clear downstream ref_* inputs (Omni-Canvas semantics —
 *     never a blank placeholder).
 * Returns the stringified workflow for createTask's `workflow` field.
 */
export function buildWorkflowGraph(
  def: WorkflowDefinition,
  mediaValues: readonly NodeInfoItem[],
  unfilledSlots: readonly MediaSlot[],
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
    const affected = downstreamAffected(graph, removed)
    graph = removeWorkflowNodes(graph, removed)
    graph = clearRefLinksToAffected(graph, affected)
  }
  return JSON.stringify(graph)
}
