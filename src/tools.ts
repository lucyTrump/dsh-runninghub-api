/** RunningHub tools: workflow listing/fetch, task submit/query/cancel, media upload. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RunningHubGateway } from './gateway.ts'
import type { NodeInfoItem } from './gateway.ts'
import { cachedUpload } from './media.ts'
import type { MediaCache } from './media.ts'
import { collectCurrentMedia, readMediaBytes } from './context-media.ts'
import type { MediaAsset } from './context-media.ts'
import { applyParamOverrides, buildNodeInfoList, buildWorkflowGraph } from './payload.ts'
import type { RunningHubTaskRunner } from './runner.ts'
import type { MediaSlot, NodeParamOverride, RunningHubConfig, WorkflowDefinition } from './settings.ts'
import { enrichNodeDefaults, type ObjectInfoCache } from './nodeinfo.ts'
import { parseWorkflowPrompt, type ParsedWorkflow } from './workflow.ts'

export interface RunningHubToolDeps {
  getConfig: () => RunningHubConfig
  runner: RunningHubTaskRunner
  /** Resolve the API key (credentials domain → literal fallback). */
  resolveApiKey: () => Promise<string | undefined>
  /** Shared TTL'd object_info registry (authoritative widget types). */
  objectInfos: ObjectInfoCache
  mediaCache: MediaCache
  saveWorkflows: (workflows: WorkflowDefinition[]) => Promise<void>
}

const JSON_SCHEMA = { type: 'json' as const }

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
}

/** Normalize a plain data graph to lossless JSON (drops `undefined` keys). */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function findWorkflow(config: RunningHubConfig, selector: string): WorkflowDefinition | undefined {
  const workflows = config.workflows ?? []
  const byId = workflows.find(workflow => workflow.workflowId === selector)
  if (byId !== undefined) return byId
  return workflows.find(workflow => workflow.label === selector)
}

function describeParam(param: NodeParamOverride): string {
  return `${param.nodeId}.${param.fieldName}${param.required ? ' *' : ''}${param.attention === true ? ' ★' : ''}`
}

function describeMedia(slot: MediaSlot): string {
  return `${slot.nodeId}.${slot.fieldName} (${slot.type})${slot.required ? ' *' : ''}${slot.attention === true ? ' ★' : ''}`
}

function inferFileType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'video'
  if (ext === 'zip') return 'zip'
  return 'file'
}

function matchAssetIndex(assets: MediaAsset[], slotType: string, used: Set<number>): number {
  for (let index = 0; index < assets.length; index++) {
    if (used.has(index)) continue
    const asset = assets[index]
    if (asset === undefined) continue
    if (slotType === 'image' && asset.kind === 'image') return index
    if (slotType !== 'image' && asset.kind === 'file' && inferFileType(asset.name ?? '') === slotType) return index
  }
  return -1
}

interface MediaAssignment {
  slot: MediaSlot
  asset: MediaAsset
}

/** Pure matching pass: map context media to slots (ascending `order`), no I/O. */
function matchMediaSlots(assets: MediaAsset[], slots: MediaSlot[]): { assignments: MediaAssignment[]; unassignedRequired: MediaSlot[] } {
  const sorted = [...slots].sort((a, b) => a.order - b.order)
  const used = new Set<number>()
  const assignments: MediaAssignment[] = []
  const unassignedRequired: MediaSlot[] = []
  for (const slot of sorted) {
    const assetIndex = matchAssetIndex(assets, slot.type, used)
    if (assetIndex === -1) {
      if (slot.required) unassignedRequired.push(slot)
      continue
    }
    const asset = assets[assetIndex]
    if (asset === undefined) continue
    used.add(assetIndex)
    assignments.push({ slot, asset })
  }
  return { assignments, unassignedRequired }
}

/**
 * Upload each matched asset (deduplicated by content hash) and turn it into the
 * slot's fieldValue — `downloadUrl` for `viaUrl` slots, the RunningHub
 * `fileName` otherwise.
 */
async function uploadAssignments(
  ctx: Context,
  assignments: MediaAssignment[],
  gateway: RunningHubGateway,
  cache: MediaCache,
  useLegacy: boolean,
): Promise<{ nodeInfoList: NodeInfoItem[]; assigned: string[] }> {
  const nodeInfoList: NodeInfoItem[] = []
  const assigned: string[] = []
  for (const { slot, asset } of assignments) {
    const bytes = await readMediaBytes(ctx, asset)
    const name = asset.name ?? `${slot.type}-${slot.order}`
    const upload = await cachedUpload({ gateway, cache, data: bytes, name, fileType: slot.type, useLegacy })
    const fieldValue = slot.viaUrl === true ? upload.downloadUrl : upload.fileName
    if (fieldValue !== undefined && fieldValue !== '') {
      nodeInfoList.push({ nodeId: slot.nodeId, fieldName: slot.fieldName, fieldValue })
      assigned.push(describeMedia(slot))
    }
  }
  return { nodeInfoList, assigned }
}

export function registerRunningHubTools(ctx: Context, deps: RunningHubToolDeps): void {
  const { getConfig, runner, resolveApiKey, objectInfos, mediaCache, saveWorkflows } = deps

  /** Build a gateway, failing fast with a clear error when no API key resolves. */
  async function requireGateway(): Promise<RunningHubGateway> {
    const key = await resolveApiKey()
    if (key === undefined || key === '') {
      throw new Error('no RunningHub API key configured (set one in Settings → Plugins → RunningHub)')
    }
    const config = getConfig()
    return new RunningHubGateway({
      resolveApiKey: async () => key,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    })
  }

  /** Enrich parsed defaults with registry widget types (best-effort). */
  async function enrich(gateway: RunningHubGateway, parsed: ParsedWorkflow): Promise<ParsedWorkflow> {
    const registry = await objectInfos.get(() => gateway.fetchObjectInfo())
    if (registry === undefined) return parsed
    const classOf = new Map(parsed.nodes.map(node => [node.nodeId, node.classType]))
    return {
      ...parsed,
      nodeDefaults: enrichNodeDefaults(parsed.nodeDefaults, classOf, registry),
    }
  }

  // ── list_workflows ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_list_workflows',
    description: 'List the RunningHub workflows saved in settings, with their editable params and media slots.',
    parameters: {},
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute() {
      const workflows = getConfig().workflows ?? []
      const items = workflows.map(workflow => ({
        label: workflow.label,
        ...(workflow.description !== undefined ? { description: workflow.description } : {}),
        ...(workflow.mediaNote !== undefined ? { mediaNote: workflow.mediaNote } : {}),
        workflowId: workflow.workflowId,
        params: workflow.nodeDefaults.map(describeParam),
        media: workflow.mediaSlots.map(describeMedia),
      }))
      const summary = workflows.length === 0
        ? 'No RunningHub workflows saved yet. Add one in Settings → Plugins → RunningHub.'
        : `${workflows.length} workflow(s):\n` + items.map(item =>
          `- ${item.label} (${item.workflowId})` + (item.description !== undefined ? ` — ${item.description}` : '') + (item.mediaNote !== undefined ? `\n  media note: ${item.mediaNote}` : '') + (item.params.length > 0 ? `\n  params: ${item.params.join(', ')}` : '') + (item.media.length > 0 ? `\n  media: ${item.media.join(', ')}` : '')).join('\n')
      return toJson({ workflows: items, summary })
    },
  }))

  // ── fetch_workflow ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_fetch_workflow',
    description: 'Fetch a RunningHub workflow by workflowId and return its editable node params and media slots (no task is submitted).',
    parameters: {
      workflowId: { type: 'string', required: true, description: 'The RunningHub workflowId (a decimal string).' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { workflowId: string }) {
      const gateway = await requireGateway()
      const data = await gateway.fetchWorkflowJson(args.workflowId)
      const parsed = await enrich(gateway, parseWorkflowPrompt(data.prompt))
      const summary = [
        `workflow ${args.workflowId}: ${parsed.nodes.length} node(s)`,
        parsed.nodeDefaults.length > 0 ? `params:\n${parsed.nodeDefaults.map(p => `  - ${describeParam(p)} (${p.kind}) = ${JSON.stringify(p.fieldValue)}`).join('\n')}` : '',
        parsed.mediaSlots.length > 0 ? `media slots:\n${parsed.mediaSlots.map(describeMedia).map(s => `  - ${s}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')
      return toJson({
        workflowId: args.workflowId,
        nodes: parsed.nodes,
        nodeDefaults: parsed.nodeDefaults,
        mediaSlots: parsed.mediaSlots,
        summary,
      })
    },
  }))

  // ── run_workflow ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_run_workflow',
    description: 'Submit a saved RunningHub workflow as a task. Resolves the workflow by label or workflowId, applies optional param overrides, and returns a local task id for runninghub_get_task/runninghub_cancel_task. With workflowJsonPath, runs a local api-format JSON file instead of the server-side graph (the file IS the graph, so node edits/removals are honored).',
    parameters: {
      workflow: { type: 'string', description: 'The saved workflow label or workflowId. Optional when workflowJsonPath is given.' },
      workflowJsonPath: { type: 'string', description: 'Absolute path to a local api-format workflow JSON file; when set, that exact graph is submitted (workflowId is ignored by RunningHub).' },
      overrides: { type: 'object', additionalProperties: true, description: 'Overrides keyed by "nodeId.fieldName". Param fields set node params (e.g. {"121.text": "a pig"}); media-slot fields set reference media directly with the fileName from runninghub_upload_file or a URL for url-slots (e.g. {"102.image": "api/xxx.png"}). Explicit media overrides win over chat-attachment auto-matching.' },
      instanceType: { type: 'string', description: 'Optional instance type passthrough, e.g. "plus" for the 48G-VRAM pool.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
      presentationMeta: (_args, value) => {
        const v = value as {
          localId?: string
          status?: string
          workflowId?: string
          label?: string
          nodeInfoList?: JsonValue
          assignedMedia?: JsonValue
        }
        return {
          localId: v.localId ?? null,
          status: v.status ?? null,
          workflowId: v.workflowId ?? null,
          label: v.label ?? null,
          nodeInfoList: v.nodeInfoList ?? null,
          assignedMedia: v.assignedMedia ?? null,
        }
      },
    },
    async execute(args: {
      workflow?: string
      workflowJsonPath?: string
      overrides?: Record<string, JsonValue>
      instanceType?: string
    }, exec) {
      const config = getConfig()
      let workflow: WorkflowDefinition | undefined
      // Ad-hoc raw-graph run: the local file IS the workflow (server-side graph ignored).
      if (args.workflowJsonPath !== undefined && args.workflowJsonPath !== '') {
        const filePrompt = await readFile(args.workflowJsonPath, 'utf8')
        const parsed = parseWorkflowPrompt(filePrompt)
        const base = args.workflowJsonPath.split('/').pop() ?? 'workflow.json'
        workflow = {
          label: args.workflow ?? base.replace(/\.json$/i, ''),
          workflowId: '0',
          prompt: filePrompt,
          nodeDefaults: parsed.nodeDefaults,
          mediaSlots: parsed.mediaSlots,
        }
      } else {
        if (args.workflow === undefined || args.workflow === '') {
          throw new Error('pass workflow (saved label/id) or workflowJsonPath (local api-format JSON)')
        }
        workflow = findWorkflow(config, args.workflow)
        if (workflow === undefined) {
          throw new Error(`no saved RunningHub workflow matches "${args.workflow}" (use runninghub_list_workflows to see saved workflows)`)
        }
      }
      // Split overrides: a key naming a media slot fills that slot directly
      // (fileName from runninghub_upload_file, or a URL for viaUrl slots);
      // anything else is a param override.
      const mediaValues: NodeInfoItem[] = []
      const mediaKeys = new Set<string>()
      const paramOverrides: NodeParamOverride[] = []
      for (const [key, value] of Object.entries(args.overrides ?? {})) {
        const dot = key.indexOf('.')
        if (dot <= 0 || dot === key.length - 1) continue
        const nodeId = key.slice(0, dot)
        const fieldName = key.slice(dot + 1)
        const slot = workflow.mediaSlots.find(s => s.nodeId === nodeId && s.fieldName === fieldName)
        if (slot !== undefined) {
          mediaValues.push({ nodeId, fieldName, fieldValue: value })
          mediaKeys.add(`${nodeId}\u0000${fieldName}`)
        } else {
          paramOverrides.push({ nodeId, fieldName, fieldValue: value as JsonValue, kind: 'json' as const })
        }
      }
      const merged = applyParamOverrides(workflow, paramOverrides)
      const textNodeInfoList = buildNodeInfoList(merged)
      const missingParams = merged.nodeDefaults.filter(p => p.required && (p.fieldValue === undefined || p.fieldValue === ''))
      // Pre-check media matching WITHOUT uploading: a needs_input outcome must
      // not submit (no billing) and not even upload.
      const assets = collectCurrentMedia(exec.agent)
      const matched = matchMediaSlots(assets, merged.mediaSlots.filter(s => !mediaKeys.has(`${s.nodeId}\u0000${s.fieldName}`)))
      const missing = [
        ...missingParams.map(p => ({
          nodeId: p.nodeId,
          fieldName: p.fieldName,
          label: p.label ?? p.fieldName,
          why: 'required parameter has no value (pass it via overrides, e.g. {"<nodeId>.<fieldName>": value})',
        })),
        ...matched.unassignedRequired.map(s => ({
          nodeId: s.nodeId,
          fieldName: s.fieldName,
          label: s.label,
          why: `required ${s.type} media slot has no value: upload one with runninghub_upload_file and re-run with overrides {"${s.nodeId}.${s.fieldName}": "<fileName>"}`,
        })),
      ]
      if (missing.length > 0) {
        const summary = [
          `needs_input: workflow "${workflow.label}" cannot be submitted yet (nothing was submitted or uploaded).`,
          `missing:\n${missing.map(m => `  - ${m.nodeId}.${m.fieldName} (${m.label}): ${m.why}`).join('\n')}`,
          'Collect the values from the user and re-run runninghub_run_workflow with them.',
        ].join('\n')
        return toJson({ status: 'needs_input', workflowId: workflow.workflowId, label: workflow.label, missing, summary })
      }
      const gateway = await requireGateway()
      const media = await uploadAssignments(ctx, matched.assignments, gateway, mediaCache, config.uploadUseLegacy === true)
      const allMedia = [...media.nodeInfoList, ...mediaValues]
      let nodeInfoList = [...textNodeInfoList, ...allMedia]
      let workflowRaw: string | undefined
      if (workflow.prompt !== undefined && workflow.prompt !== '') {
        // Graph mode: bake params + supplied media into the stored raw graph
        // and CUT media slots with no supplied media (remove the Load node,
        // clean links, clear downstream ref_* inputs — never a placeholder).
        // nodeInfoList is then redundant and could reference cut nodes.
        const filledKeys = new Set(allMedia.map(m => `${m.nodeId}\u0000${m.fieldName}`))
        const unfilled = merged.mediaSlots.filter(slot => !filledKeys.has(`${slot.nodeId}\u0000${slot.fieldName}`))
        workflowRaw = buildWorkflowGraph(merged, allMedia, unfilled)
        nodeInfoList = []
      }
      const record = runner.submit({
        workflowId: workflow.workflowId,
        label: workflow.label,
        nodeInfoList,
        ...(workflowRaw !== undefined ? { workflowRaw } : {}),
        ...(args.instanceType !== undefined ? { instanceType: args.instanceType } : {}),
        ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
      })
      const summary = [
        workflowRaw !== undefined
          ? `submitted workflow "${workflow.label}" (${workflow.workflowId}) as edited graph JSON (unfilled media slots cut from the graph)`
          : `submitted workflow "${workflow.label}" (${workflow.workflowId})`,
        `local task id: ${record.localId}`,
        nodeInfoList.length > 0
          ? `payload (nodeInfoList):\n${JSON.stringify(nodeInfoList, null, 2)}`
          : 'payload: baked into the submitted graph JSON',
        media.assigned.length > 0 ? `media mapped from chat: ${media.assigned.join(', ')}` : '',
        mediaValues.length > 0 ? `media set via overrides: ${mediaValues.map(m => `${m.nodeId}.${m.fieldName}`).join(', ')}` : '',
      ].filter(Boolean).join('\n')
      return toJson({
        localId: record.localId,
        jobId: record.jobId,
        status: record.status,
        workflowId: workflow.workflowId,
        label: workflow.label,
        nodeInfoList,
        assignedMedia: media.assigned,
        summary,
      })
    },
  }))

  // ── get_task ───────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_get_task',
    description: 'Query one RunningHub task by its local id (from runninghub_run_workflow) or the platform taskId, returning status, error, and saved result files.',
    parameters: {
      task: { type: 'string', required: true, description: 'The local task id (runninghub_run_workflow output) or RunningHub taskId.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { task: string }) {
      const record = runner.get(args.task) ?? runner.list().find(r => r.taskId === args.task)
      if (record === undefined) {
        return toJson({ found: false, summary: `no RunningHub task matches "${args.task}"` })
      }
      const summary = [
        `task ${record.localId}: ${record.status}`,
        record.taskId !== undefined ? `RunningHub taskId: ${record.taskId}` : '',
        record.error !== undefined ? `error: ${record.error}` : '',
        record.outputs !== undefined && record.outputs.length > 0
          ? `result files:\n${record.outputs.map(o => `  - ${o.savedPath ?? o.fileUrl ?? ''}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n')
      return toJson({ ...record, summary })
    },
  }))

  // ── list_tasks ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_list_tasks',
    description: 'List recent RunningHub tasks (all statuses), newest last, from the local ledger.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum tasks to return (default 20).' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { limit?: number }) {
      const limit = args.limit !== undefined && args.limit > 0 ? args.limit : 20
      const tasks = runner.list().slice(-limit).map(record => ({
        localId: record.localId,
        taskId: record.taskId,
        status: record.status,
        label: record.label,
        workflowId: record.workflowId,
        createdAt: record.createdAt,
        error: record.error,
      }))
      const summary = tasks.length === 0
        ? 'No RunningHub tasks yet.'
        : `${tasks.length} task(s):\n` + tasks.map(t => `- ${t.localId} ${t.status} (${t.label ?? t.workflowId})`).join('\n')
      return toJson({ tasks, summary })
    },
  }))

  // ── cancel_task ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_cancel_task',
    description: 'Cancel a queued or running RunningHub task by its local id (from runninghub_run_workflow).',
    parameters: {
      task: { type: 'string', required: true, description: 'The local task id returned by runninghub_run_workflow.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { task: string }, exec) {
      const outcome = runner.cancel(args.task, exec.agent)
      return toJson({ outcome, summary: `cancel ${args.task}: ${outcome}` })
    },
  }))

  // ── upload_file ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_upload_file',
    description: 'Upload a local media file (image/audio/video/zip) to RunningHub and return its fileName + downloadUrl for use as a LoadImage/LoadAudio/LoadVideo/LoadImages fieldValue.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute local file path to upload.' },
      fileType: { type: 'string', enum: ['image', 'audio', 'video', 'zip'], description: 'Media kind; inferred from extension when omitted.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { path: string; fileType?: 'image' | 'audio' | 'video' | 'zip' }) {
      const config = getConfig()
      const bytes = await readFile(args.path)
      const name = args.path.split('/').pop() ?? 'upload'
      const fileType = args.fileType ?? inferFileType(name)
      const result = await cachedUpload({
        gateway: await requireGateway(),
        cache: mediaCache,
        data: bytes,
        name,
        fileType,
        useLegacy: config.uploadUseLegacy === true,
      })
      const summary = `${result.cached ? 'reused cached' : 'uploaded'} ${name} as ${result.fileName}\ndownload_url: ${result.downloadUrl ?? '(none)'}`
      return toJson({ fileName: result.fileName, downloadUrl: result.downloadUrl, fileType, cached: result.cached, summary })
    },
  }))

  // ── refresh_workflow ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'runninghub_refresh_workflow',
    description: 'Re-fetch a saved RunningHub workflow and update its saved params/media slots from the latest RunningHub data.',
    parameters: {
      workflow: { type: 'string', required: true, description: 'The saved workflow label or workflowId to refresh.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [text((value as { summary?: string }).summary ?? JSON.stringify(value, null, 2))],
    },
    async execute(args: { workflow: string }) {
      const config = getConfig()
      const workflow = findWorkflow(config, args.workflow)
      if (workflow === undefined) {
        throw new Error(`no saved RunningHub workflow matches "${args.workflow}"`)
      }
      const gateway = await requireGateway()
      const data = await gateway.fetchWorkflowJson(workflow.workflowId)
      const parsed = await enrich(gateway, parseWorkflowPrompt(data.prompt))
      const next: WorkflowDefinition = {
        ...workflow,
        prompt: JSON.parse(data.prompt) as JsonValue,
        fetchedAt: new Date().toISOString(),
        nodeDefaults: parsed.nodeDefaults,
        mediaSlots: parsed.mediaSlots,
      }
      const workflows = (config.workflows ?? []).map(existing =>
        existing.workflowId === workflow.workflowId ? next : existing)
      await saveWorkflows(workflows)
      const summary = `refreshed workflow "${next.label}" (${next.workflowId}): ${parsed.nodes.length} nodes, ${parsed.nodeDefaults.length} params, ${parsed.mediaSlots.length} media slots`
      return toJson({ workflow: next, summary })
    },
  }))
}
