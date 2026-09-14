/**
 * Workflow prompt (api-format JSON) parsing: turn RunningHub's `data.prompt`
 * into editable node-default params and media slots. Pure — no DSH deps.
 * @module @deepseek-ai/dsh-runninghub
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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

// ── Graph surgery (api-format prompt editing) ───────────────────────────────
// Ported from Omni-Canvas src/lib/runninghub/workflow.ts: the submit-time
// normalization for /task/openapi/create's `workflow` field. A media slot
// with no supplied media is CUT from the graph (its Load node removed, links
// cleaned, downstream ref_* inputs cleared) — never replaced with a blank
// placeholder.

export type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>

function isGraphLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
}

/** Remove the given nodes and every link input pointing to them. */
export function removeWorkflowNodes(workflow: ApiWorkflow, removeIds: ReadonlySet<string>): ApiWorkflow {
  if (removeIds.size === 0) return workflow
  const next: ApiWorkflow = {}
  for (const [id, node] of Object.entries(workflow)) {
    if (removeIds.has(id)) continue
    const inputs = node.inputs ?? {}
    const cleaned: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(inputs)) {
      if (isGraphLink(value) && removeIds.has(value[0])) continue
      cleaned[name] = value
    }
    next[id] = { ...node, inputs: cleaned }
  }
  return next
}

/**
 * Nodes downstream of `startIds` via links (including intermediates and the
 * final consumers — e.g. removing a LoadAudio also taints the ZNGB_AudioCrop
 * it fed and the MiniMaxH3ReferenceToVideo behind that).
 */
export function downstreamAffected(workflow: ApiWorkflow, startIds: ReadonlySet<string>): Set<string> {
  const affected = new Set<string>()
  const queue = [...startIds]
  const seen = new Set<string>(startIds)
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const [id, node] of Object.entries(workflow)) {
      if (seen.has(id)) continue
      const inputs = node.inputs ?? {}
      for (const value of Object.values(inputs)) {
        if (isGraphLink(value) && value[0] === cur) {
          seen.add(id)
          affected.add(id)
          queue.push(id)
          break
        }
      }
    }
  }
  return affected
}

const REF_INPUT_RE = /^ref_(images|videos|audios)\./

/**
 * Clear ref_* inputs (ref_images.ref_image_N etc.) that link to affected
 * nodes. The ref-prefix guard keeps the main sampling chain (whose nodes are
 * also "affected" downstream) intact.
 */
export function clearRefLinksToAffected(workflow: ApiWorkflow, affectedIds: ReadonlySet<string>): ApiWorkflow {
  if (affectedIds.size === 0) return workflow
  const next: ApiWorkflow = {}
  for (const [id, node] of Object.entries(workflow)) {
    const inputs = node.inputs ?? {}
    let changed = false
    const cleaned: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(inputs)) {
      if (REF_INPUT_RE.test(name) && isGraphLink(value) && affectedIds.has(value[0])) {
        changed = true
        continue
      }
      cleaned[name] = value
    }
    next[id] = changed ? { ...node, inputs: cleaned } : node
  }
  return next
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
