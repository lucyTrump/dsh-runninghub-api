/** Settings namespace, schema, and shared types for the RunningHub plugin. */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Settings namespace the Plugins page edits (this bundle's `plugins.bundle.config` entry). */
export const RUNNINGHUB_NS = 'runninghub'

export const DEFAULT_BASE_URL = 'https://www.runninghub.cn'
export const DEFAULT_POLL_INTERVAL_MS = 5000
export const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000
export const DEFAULT_QUEUE_TIMEOUT_MS = 0
export const DEFAULT_MAX_CONCURRENT_TASKS = 3
/** Credential reference the plugin resolves when no literal `apiKey` is configured. */
export const DEFAULT_API_KEY_ENV = 'RUNNINGHUB_API_KEY'

/** One editable node input (default parameter). */
export interface NodeParamOverride {
  nodeId: string
  fieldName: string
  /** Default value (same shape as the workflow JSON); empty when user marks it required. */
  fieldValue?: JsonValue
  /** Friendly name (e.g. 「正向提示词」, 「步数」). */
  label?: string
  /**
   * Widget kind. `int`/`float`/`select` come from the ComfyUI node registry
   * (object_info); `number` is the pre-registry inferred kind kept for
   * previously saved definitions.
   */
  kind: 'text' | 'number' | 'int' | 'float' | 'boolean' | 'url' | 'select' | 'json'
  /** Combo choices when kind is `select`. */
  options?: string[]
  /** Registry bounds for int/float widgets. */
  min?: number
  max?: number
  step?: number
  /** Required = no usable default; the caller must provide it explicitly at run time. */
  required?: boolean
  /**
   * User-curated "check me first" marker: the model always reviews these when
   * running the workflow; unmarked params are intentionally fixed and should
   * not be re-analyzed.
   */
  attention?: boolean
}

/** A media input slot on a LoadImage/LoadImages(zip)/LoadAudio/LoadVideo/LoadImageFromUrl node. */
export interface MediaSlot {
  nodeId: string
  fieldName: string
  label: string
  /** Deterministic media-assignment order (ascending). */
  order: number
  type: 'image' | 'audio' | 'video' | 'zip'
  /** true = fill a URL (LoadImageFromUrl); false = upload and fill fileName. */
  viaUrl?: boolean
  required?: boolean
  /**
   * User-curated "feed me media" marker, same semantics as param attention:
   * marked slots are the ones the model must actively supply at run time;
   * unmarked slots are internal/fixed and not worth re-analyzing.
   */
  attention?: boolean
}

/** A saved RunningHub workflow with its editable params and media slots. */
export interface WorkflowDefinition {
  /** Unique conversation-facing name. */
  label: string
  description?: string | undefined
  workflowId: string
  /** Latest fetched api-format prompt (JSON). */
  prompt?: JsonValue
  fetchedAt?: string
  nodeDefaults: NodeParamOverride[]
  mediaSlots: MediaSlot[]
  /**
   * One workflow-level media usage note for the model (e.g. "参考图 0–9
   * 张，按顺序对应 9 个参考图槽位") — declared once instead of repeated
   * per slot.
   */
  mediaNote?: string
  /**
   * One line per gotcha this workflow has actually hit (legal enum values,
   * required instance type, how to cut unused slots). Written by the describe
   * pass from the node registry, or recorded after a failed run — it is the
   * channel for "this workflow needs X" without a plugin release.
   */
  usageNote?: string
}

/**
 * Resolved RunningHub settings section. `apiKey` is `role('secret')`: the
 * browser writes it but never reads plaintext back. `apiKeyEnv` names the
 * credentials-domain reference the plugin resolves the key through (the
 * settings card writes the key there, never into this section).
 */
export interface RunningHubConfig {
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  defaultWorkflowLabel?: string
  pollIntervalMs?: number
  runTimeoutMs?: number
  queueTimeoutMs?: number
  maxConcurrentTasks?: number
  uploadUseLegacy?: boolean
  /** Floating task-panel overlay in the web UI; off hides it entirely. */
  taskPanelEnabled?: boolean
  /** 'provider/model' route for LLM workflow-description generation; empty = the agent default model. */
  describeModel?: string
  workflows?: WorkflowDefinition[]
}

/**
 * The row plugin's own Cordis `Config`. The profile entry id (`runninghub`, the
 * same string as {@link RUNNINGHUB_NS}) is the configuration form's namespace,
 * so a `.volatile()` field is what the browser card edits live: the value lands
 * in the profile's Cordis patch and reaches {@link apply} without a remount.
 * Secrets still ride `role('secret')` and are redacted from form responses.
 */
export interface Config {
  /** Literal key; prefer {@link Config.apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved per request. */
  apiKeyEnv: Volatile<string>
  /** OpenAPI base URL. */
  baseUrl: Volatile<string>
  /** Label a run uses when the caller names no workflow. */
  defaultWorkflowLabel: Volatile<string | undefined>
  /** Status poll interval. */
  pollIntervalMs: Volatile<number>
  /** Run-phase timeout; 0 = unlimited. */
  runTimeoutMs: Volatile<number>
  /** Queue-phase timeout; 0 = unlimited. */
  queueTimeoutMs: Volatile<number>
  /** Local concurrency gate. */
  maxConcurrentTasks: Volatile<number>
  /** Legacy multipart upload endpoint. */
  uploadUseLegacy: Volatile<boolean>
  /** Floating task-panel overlay in the web UI. */
  taskPanelEnabled: Volatile<boolean>
  /** 'provider/model' route for description generation; empty = agent default. */
  describeModel: Volatile<string | undefined>
  /** Saved workflow definitions the card edits. */
  workflows: Volatile<WorkflowDefinition[]>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  defaultWorkflowLabel: z.string().volatile(),
  pollIntervalMs: z.number().step(1).min(1000).default(DEFAULT_POLL_INTERVAL_MS).volatile(),
  runTimeoutMs: z.number().step(1).min(0).default(DEFAULT_RUN_TIMEOUT_MS).volatile(),
  queueTimeoutMs: z.number().step(1).min(0).default(DEFAULT_QUEUE_TIMEOUT_MS).volatile(),
  maxConcurrentTasks: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_TASKS).volatile(),
  uploadUseLegacy: z.boolean().default(false).volatile(),
  taskPanelEnabled: z.boolean().default(true).volatile(),
  describeModel: z.string().volatile(),
  workflows: z.any<WorkflowDefinition[]>().default([]).volatile(),
})
