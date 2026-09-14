/** Settings namespace, schema, and shared types for the RunningHub plugin. */

import z from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Settings namespace the Plugins page edits (`settings.plugin.item` key). */
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
  /** 'provider/model' route for LLM workflow-description generation; empty = the agent default model. */
  describeModel?: string
  workflows?: WorkflowDefinition[]
}

export const Config: z<RunningHubConfig> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  defaultWorkflowLabel: z.string(),
  pollIntervalMs: z.number().step(1).min(1000).default(DEFAULT_POLL_INTERVAL_MS),
  runTimeoutMs: z.number().step(1).min(0).default(DEFAULT_RUN_TIMEOUT_MS),
  queueTimeoutMs: z.number().step(1).min(0).default(DEFAULT_QUEUE_TIMEOUT_MS),
  maxConcurrentTasks: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_TASKS),
  uploadUseLegacy: z.boolean().default(false),
  describeModel: z.string(),
  workflows: z.any<WorkflowDefinition[]>().default([]),
})
