/**
 * Workflow prompt (api-format JSON) parsing: turn RunningHub's `data.prompt`
 * into editable node-default params and media slots. Pure — no DSH deps.
 * @module @deepseek-ai/dsh-runninghub
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ObjectInfoRegistry } from './nodeinfo.ts'
import type { MediaSlot, NodeParamOverride } from './settings.ts'

export interface WorkflowNodeInfo {
  nodeId: string
  classType: string
  title?: string
}

export interface ParsedWorkflow {
  nodes: WorkflowNodeInfo[]
  nodeDefaults: NodeParamOverride[]
  mediaSlots: MediaSlot[]
}

interface RawNode {
  class_type?: string
  type?: string
  inputs?: Record<string, unknown>
  _meta?: { title?: string }
}

const MEDIA_LOADERS: Record<string, { type: MediaSlot['type']; viaUrl: boolean; fieldNames: readonly string[] }> = {
  LoadImage: { type: 'image', viaUrl: false, fieldNames: ['image', 'upload'] },
  LoadImages: { type: 'zip', viaUrl: false, fieldNames: ['image', 'upload'] },
  LoadAudio: { type: 'audio', viaUrl: false, fieldNames: ['audio', 'upload'] },
  LoadVideo: { type: 'video', viaUrl: false, fieldNames: ['video', 'upload'] },
  LoadImageFromUrl: { type: 'image', viaUrl: true, fieldNames: ['image', 'url'] },
}

/** Infer a node param kind from its default value. */
export function inferKind(value: unknown): NodeParamOverride['kind'] {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? 'url' : 'text'
  }
  return 'json'
}

/** True when a node input value is a ComfyUI link (`["<nodeId>", <slot>]`). */
function isLink(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === 'string'
}

/**
 * Parse the api-format workflow prompt.
 * @param prompt - `data.prompt` string from endpoint A.
 * @returns nodes, editable node defaults, and media slots (order ascending).
 */
export function parseWorkflowPrompt(prompt: string): ParsedWorkflow {
  let root: unknown
  try {
    root = JSON.parse(prompt)
  } catch (error) {
    throw new Error(`workflow prompt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const record = (root ?? {}) as Record<string, RawNode>
  const nodes: WorkflowNodeInfo[] = []
  const nodeDefaults: NodeParamOverride[] = []
  const mediaSlots: MediaSlot[] = []

  for (const [nodeId, raw] of Object.entries(record)) {
    if (typeof raw !== 'object' || raw === null) continue
    const classType = raw.class_type ?? raw.type ?? 'unknown'
    const title = raw._meta?.title
    nodes.push({ nodeId, classType, ...(title !== undefined ? { title } : {}) })
    const inputs = raw.inputs ?? {}
    const loader = MEDIA_LOADERS[classType]

    for (const [fieldName, value] of Object.entries(inputs)) {
      if (loader !== undefined) {
        // Media loader node: only its media field(s) become a media slot.
        if (loader.fieldNames.includes(fieldName) && typeof value === 'string') {
          mediaSlots.push({
            nodeId,
            fieldName,
            label: title ?? `${loader.type} ${mediaSlots.length + 1}`,
            order: mediaSlots.length,
            type: loader.type,
            viaUrl: loader.viaUrl,
          })
        }
        continue
      }
      if (isLink(value)) continue // ComfyUI link — not editable
      if (value === null || value === undefined) continue
      nodeDefaults.push({
        nodeId,
        fieldName,
        fieldValue: value as JsonValue,
        kind: inferKind(value),
      })
    }
  }

  return { nodes, nodeDefaults, mediaSlots }
}

/**
 * Parse a prompt held by a saved definition, which is either the parsed graph
 * (settings) or the raw JSON text (a `workflowJsonPath` run). Undefined when
 * the prompt is missing or unparseable — callers treat that as "no detail".
 */
export function parseStoredPrompt(prompt: JsonValue | undefined): ParsedWorkflow | undefined {
  if (prompt === undefined || prompt === null) return undefined
  try {
    return parseWorkflowPrompt(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))
  } catch {
    return undefined
  }
}

// ── Graph surgery (api-format prompt editing) ───────────────────────────────
// Ported from Omni-Canvas src/lib/runninghub/workflow.ts: the submit-time
// normalization for /task/openapi/create's `workflow` field. A media slot
// with no supplied media is CUT from the graph (its Load node removed and
// every node left without inputs along with it) — never replaced with a blank
// placeholder.

export type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>

function isGraphLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
}

/**
 * Drop the given nodes and every link input pointing to them.
 * @returns the stripped graph plus the ids that lost at least one link.
 */
function stripNodes(workflow: ApiWorkflow, goneIds: ReadonlySet<string>): { graph: ApiWorkflow, lost: Set<string> } {
  const graph: ApiWorkflow = {}
  const lost = new Set<string>()
  for (const [id, node] of Object.entries(workflow)) {
    if (goneIds.has(id)) continue
    const cleaned: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (isGraphLink(value) && goneIds.has(value[0])) {
        lost.add(id)
        continue
      }
      cleaned[name] = value
    }
    graph[id] = { ...node, inputs: cleaned }
  }
  return { graph, lost }
}

/**
 * Still runnable after losing links? No when nothing links in any more, nor
 * when a registry-required input is gone. The second half is the case a shared
 * scalar hides: `easy imageScaleDownToSize` keeps `size: ["126", 0]` (a shared
 * Int) after its `images` link is cut, so it looks fed but RunningHub rejects
 * it with "Required input is missing". Class types the registry does not know
 * fall back to the link-only rule.
 */
function hasUsableInputs(
  node: ApiWorkflow[string] | undefined,
  registry: ObjectInfoRegistry | undefined,
): boolean {
  const entries = Object.entries(node?.inputs ?? {})
  if (!entries.some(([, value]) => isGraphLink(value))) return false
  const classType = node?.class_type
  if (registry === undefined || classType === undefined) return true
  const required = Object.keys(registry[classType]?.input?.required ?? {})
  if (required.length === 0) return true
  const names = new Set<string>()
  for (const [name] of entries) {
    names.add(name)
    names.add(name.split('.')[0] ?? name)
  }
  return required.every(field => names.has(field))
}

/**
 * Remove the given nodes, then cascade: a node that just lost a link and can no
 * longer satisfy its required inputs was only serving the cut media (e.g.
 * `LoadImage → easy imageScaleDownToSize → TextEncodeQwenImage21.images.image_1`)
 * and is dead weight now — kept, RunningHub rejects it with "Required input is
 * missing". Nodes still fed by the rest of the graph (the optional `ref_*`
 * consumers, the main sampling chain) keep running without the link. A node
 * that never had a link input at all is untouched.
 */
export function removeWorkflowNodes(
  workflow: ApiWorkflow,
  removeIds: ReadonlySet<string>,
  registry?: ObjectInfoRegistry,
): ApiWorkflow {
  if (removeIds.size === 0) return workflow
  const gone = new Set(removeIds)
  let graph: ApiWorkflow
  for (;;) {
    const stripped = stripNodes(workflow, gone)
    graph = stripped.graph
    const lost = stripped.lost
    const drained = [...lost].filter(id => !hasUsableInputs(graph[id], registry))
    if (drained.length === 0) break
    for (const id of drained) gone.add(id)
  }
  return graph
}

/** Set one node input field in the graph (scalar or link). */
export function setGraphInput(workflow: ApiWorkflow, nodeId: string, fieldName: string, value: unknown): ApiWorkflow {
  const node = workflow[nodeId]
  if (node === undefined) return workflow
  const inputs: Record<string, unknown> = {}
  for (const [name, existing] of Object.entries(node.inputs ?? {})) {
    if (name !== fieldName) inputs[name] = existing
  }
  if (value !== undefined && value !== null) inputs[fieldName] = value
  return { ...workflow, [nodeId]: { ...node, inputs } }
}
