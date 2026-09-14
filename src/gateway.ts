/**
 * RunningHub OpenAPI HTTP gateway — pure transport with no DSH dependencies.
 * The plugin holds the `apiKey` secret and injects it here; the browser never
 * sees plaintext. Every error string is masked before it escapes this module.
 * @module @deepseek-ai/dsh-runninghub
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ObjectInfoRegistry } from './nodeinfo.ts'

export const DEFAULT_BASE_URL = 'https://www.runninghub.cn'

export interface GatewayOptions {
  /**
   * Resolve the API key at request time. The literal never lives on the
   * gateway: the owning plugin resolves it from the credentials domain (or a
   * literal config fallback) so a redacted settings snapshot carries nothing.
   */
  resolveApiKey: () => Promise<string | undefined>
  baseUrl?: string
  /** Injectable fetch (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

/** One `nodeInfoList` item: node → input field → value. */
export interface NodeInfoItem {
  nodeId: string
  fieldName: string
  fieldValue: JsonValue
}

// ── endpoint A: getJsonApiFormat ────────────────────────────────────────────
export interface FetchWorkflowJsonResult {
  workflowId: string
  /** The workflow JSON as a string (parse with JSON.parse). */
  prompt: string
}

// ── endpoint B: task/openapi/create ─────────────────────────────────────────
export interface CreateTaskInput {
  workflowId: string
  nodeInfoList?: NodeInfoItem[]
  addMetadata?: Record<string, unknown>
  webhookUrl?: string
  workflow?: unknown
  instanceType?: string
  usePersonalQueue?: boolean
  retainSeconds?: number
  accessPassword?: string
}

export interface CreateTaskResult {
  taskId: string
  taskStatus: string
  clientId?: string
  promptTips?: unknown
  netWssUrl?: string
}

// ── endpoint C: task/openapi/outputs ────────────────────────────────────────
export type OutputsCode = 0 | 804 | 813 | 805

export interface ResultItem {
  fileUrl?: string
  fileName?: string
  fileType?: string
  nodeId?: string
  [key: string]: unknown
}

export interface FailureDetail {
  node_name?: string
  exception_message?: string
  traceback?: string
  [key: string]: unknown
}

export interface OutputsResult {
  code: OutputsCode
  data?: ResultItem[]
  failedReason?: FailureDetail
  msg?: string
  promptTips?: { node_errors?: Record<string, unknown>; [key: string]: unknown }
}

// ── endpoint D: task/openapi/cancel ─────────────────────────────────────────
export interface CancelResult {
  code: number
  msg?: string
}

// ── endpoints E/F: media upload ─────────────────────────────────────────────
export interface UploadResult {
  fileName: string
  downloadUrl?: string
  type?: string
  size?: string
  fileType?: string
}

export interface UploadFile {
  /** File name with extension (drives MIME + upload name). */
  name: string
  /** Raw bytes. */
  data: Uint8Array
  /** Optional explicit MIME type override. */
  mimeType?: string
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  zip: 'application/zip',
}

function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase()
}

function mimeFor(name: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream'
}

/** Replace the apiKey (and a Bearer token) in any string with `***`. */
export function maskSecret(text: string, apiKey: string): string {
  if (apiKey === '') return text
  let out = text.split(apiKey).join('***')
  out = out.split('Bearer ***').join('Bearer ***')
  return out
}

function maskError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  return maskSecret(raw, apiKey)
}

/** A transport-level RunningHub failure (network, HTTP status, or bad body). */
export class RunningHubError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RunningHubError'
  }
}

interface ApiEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

export class RunningHubGateway {
  private readonly resolveApiKey: () => Promise<string | undefined>
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GatewayOptions) {
    this.resolveApiKey = options.resolveApiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  /** Resolve the key or throw the canonical no-key error. */
  private async key(): Promise<string> {
    const apiKey = await this.resolveApiKey()
    if (apiKey === undefined || apiKey === '') {
      throw new RunningHubError('no RunningHub API key configured (set one in Settings → Plugins → RunningHub)')
    }
    return apiKey
  }

  /** Mask the resolved key out of a server/error string (defense-in-depth). */
  private async mask(text: string): Promise<string> {
    return maskSecret(text, await this.resolveApiKey() ?? '')
  }

  private async post(path: string, body: unknown, signal?: AbortSignal, multipart?: FormData): Promise<ApiEnvelope> {
    const apiKey = await this.key()
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
    const isForm = multipart !== undefined
    let payload: BodyInit
    if (isForm) {
      // Multipart bodies carry their own Content-Type boundary; do not set it.
      payload = multipart
    } else {
      headers['Content-Type'] = 'application/json'
      // JSON bodies also carry the key (RunningHub accepts both channels).
      payload = JSON.stringify({ ...(typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}), apiKey })
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: payload,
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      throw new RunningHubError(`RunningHub request failed: ${maskError(error, apiKey)}`)
    }
    if (!response.ok) {
      throw new RunningHubError(`RunningHub HTTP ${response.status}`, response.status)
    }
    let envelope: ApiEnvelope
    try {
      envelope = (await response.json()) as ApiEnvelope
    } catch {
      throw new RunningHubError(`RunningHub returned non-JSON (HTTP ${response.status})`)
    }
    if (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== 804 && envelope.code !== 813 && envelope.code !== 805) {
      throw new RunningHubError(maskSecret(envelope.msg ?? `RunningHub code ${envelope.code}`, apiKey), envelope.code, envelope.data)
    }
    return envelope
  }

  /** A: fetch the api-format workflow JSON for a workflowId. */
  async fetchWorkflowJson(workflowId: string, signal?: AbortSignal): Promise<FetchWorkflowJsonResult> {
    const env = await this.post('/api/openapi/getJsonApiFormat', { workflowId }, signal)
    const data = (env.data ?? {}) as { prompt?: string }
    if (typeof data.prompt !== 'string' || data.prompt === '') {
      throw new RunningHubError('RunningHub returned no workflow prompt (workflowId may be invalid)')
    }
    return { workflowId, prompt: data.prompt }
  }

  /** Download a result/media file by absolute URL (RunningHub serves result URLs directly). */
  async download(url: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(url, {
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) {
      throw new RunningHubError(`download HTTP ${response.status}`, response.status)
    }
    return response
  }

  /**
   * ComfyUI node registry via the native proxy (`/proxy/{apiKey}/object_info`,
   * non-enveloped, ~37 MB). Authoritative widget types/bounds for enrichment;
   * callers should cache the result.
   */
  async fetchObjectInfo(signal?: AbortSignal): Promise<ObjectInfoRegistry> {
    const apiKey = await this.key()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/proxy/${encodeURIComponent(apiKey)}/object_info`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      throw new RunningHubError(`RunningHub object_info request failed: ${maskError(error, apiKey)}`)
    }
    if (!response.ok) {
      throw new RunningHubError(`RunningHub object_info HTTP ${response.status}`, response.status)
    }
    return await response.json() as ObjectInfoRegistry
  }

  /** B: create (submit) a task. */
  async createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<CreateTaskResult> {
    const body = {
      workflowId: input.workflowId,
      nodeInfoList: input.nodeInfoList,
      ...(input.addMetadata !== undefined ? { addMetadata: input.addMetadata } : {}),
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
      ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
      ...(input.instanceType !== undefined ? { instanceType: input.instanceType } : {}),
      ...(input.usePersonalQueue !== undefined ? { usePersonalQueue: input.usePersonalQueue } : {}),
      ...(input.retainSeconds !== undefined ? { retainSeconds: input.retainSeconds } : {}),
      ...(input.accessPassword !== undefined ? { accessPassword: input.accessPassword } : {}),
    }
    const env = await this.post('/task/openapi/create', body, signal)
    const data = (env.data ?? {}) as Partial<CreateTaskResult>
    if (typeof data.taskId !== 'string' || data.taskId === '') {
      throw new RunningHubError(`RunningHub create returned no taskId: ${await this.mask(env.msg ?? 'unknown')}`, env.code)
    }
    return data as CreateTaskResult
  }

  /** C: query task status/outputs. `code` is 0 (done) | 804 (running) | 813 (queued) | 805 (failed). */
  async outputs(taskId: string, signal?: AbortSignal): Promise<OutputsResult> {
    const env = await this.post('/task/openapi/outputs', { taskId }, signal)
    const code = env.code as OutputsCode | undefined
    if (code === undefined) {
      throw new RunningHubError(`RunningHub outputs missing code: ${await this.mask(env.msg ?? 'unknown')}`)
    }
    const rawData = env.data
    // code 0 → array of result items; code 805 → object carrying failedReason/promptTips.
    const data = Array.isArray(rawData) ? rawData as ResultItem[] : undefined
    const detail = rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
      ? rawData as { failedReason?: FailureDetail; promptTips?: OutputsResult['promptTips'] }
      : undefined
    return {
      code,
      ...(data !== undefined ? { data } : {}),
      ...(detail?.failedReason !== undefined ? { failedReason: detail.failedReason } : {}),
      ...(env.msg !== undefined ? { msg: await this.mask(env.msg) } : {}),
      ...(detail?.promptTips !== undefined ? { promptTips: detail.promptTips } : {}),
    }
  }

  /** D: cancel a task. */
  async cancel(taskId: string, signal?: AbortSignal): Promise<CancelResult> {
    const env = await this.post('/task/openapi/cancel', { taskId }, signal)
    return {
      code: env.code ?? 0,
      ...(env.msg !== undefined ? { msg: await this.mask(env.msg) } : {}),
    }
  }

  /** E: v2 binary media upload (multipart). */
  async uploadBinary(file: UploadFile, signal?: AbortSignal): Promise<UploadResult> {
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(file.data).buffer], { type: mimeFor(file.name, file.mimeType) }), file.name)
    const env = await this.post('/openapi/v2/media/upload/binary', undefined, signal, form)
    const data = (env.data ?? {}) as Partial<UploadResult>
    if (typeof data.fileName !== 'string' || data.fileName === '') {
      throw new RunningHubError(`RunningHub upload returned no fileName: ${await this.mask(env.msg ?? 'unknown')}`, env.code)
    }
    return data as UploadResult
  }

  /** F: legacy media upload (multipart with apiKey + fileType). */
  async uploadLegacy(file: UploadFile, fileType: string, signal?: AbortSignal): Promise<UploadResult> {
    const form = new FormData()
    form.append('apiKey', await this.key())
    form.append('fileType', fileType)
    form.append('file', new Blob([Uint8Array.from(file.data).buffer], { type: mimeFor(file.name, file.mimeType) }), file.name)
    const env = await this.post('/task/openapi/upload', undefined, signal, form)
    const data = (env.data ?? {}) as Partial<UploadResult>
    if (typeof data.fileName !== 'string' || data.fileName === '') {
      throw new RunningHubError(`RunningHub upload returned no fileName: ${await this.mask(env.msg ?? 'unknown')}`, env.code)
    }
    return data as UploadResult
  }
}
