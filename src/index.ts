/**
 * RunningHub API plugin, host half: registers the `runninghub` settings
 * namespace (runtime limits + workflow definitions), the
 * `ctx.remote.runninghub` controller (workflow fetch/validate/test-run), the
 * durable task runner (submit → poll → save with a concurrency gate +
 * background jobs), and the model-facing RunningHub tools.
 *
 * The API key never lives in the settings document the browser reads: the
 * settings card writes it through the credentials domain under the
 * `apiKeyEnv` reference (default `RUNNINGHUB_API_KEY`), and this host resolves
 * that reference per request (a literal `apiKey` in the composition layer
 * remains a fallback, e.g. for headless deployments).
 * @module @deepseek-ai/dsh-runninghub
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import { Config, DEFAULT_API_KEY_ENV, RUNNINGHUB_NS, type RunningHubConfig } from './settings.ts'
import type { WorkflowDefinition } from './settings.ts'
import { RunningHubController } from './rpc.ts'
import { LedgerStore } from './ledger.ts'
import { ObjectInfoCache } from './nodeinfo.ts'
import { RunningHubTaskRunner } from './runner.ts'
import { MediaCache } from './media.ts'
import { registerRunningHubTools } from './tools.ts'

export {
  Config, RUNNINGHUB_NS, type RunningHubConfig,
  DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MAX_CONCURRENT_TASKS, DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_QUEUE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS,
} from './settings.ts'
export type { MediaSlot, NodeParamOverride, WorkflowDefinition } from './settings.ts'
export type { ParsedWorkflow, WorkflowNodeInfo } from './workflow.ts'
export type { NodeInfoItem } from './gateway.ts'
export { RunningHubController } from './rpc.ts'
export type {
  DescribeWorkflowRequest, DescribeWorkflowData,
  FetchWorkflowRequest, FetchWorkflowData,
  RunTestRequest, RunTestData,
  ValidateWorkflowRequest, ValidateWorkflowData, JsonValue,
} from './types.ts'

export const name = 'runninghub'

export const inject: string[] = ['tools']

/**
 * Register the settings section, mount the workflow-management Remote, create
 * the durable task runner, and register the model-facing tools. The mounted
 * cordis config is the composition base; the browser card edits the user layer
 * over it. `current` is the live accessor to the resolved config.
 */
export function apply(ctx: Context, config: RunningHubConfig = {}): void {
  let current: () => RunningHubConfig = () => config
  let settingsProvider: SettingsProvider | undefined

  // Resolve the API key per call: literal section value first (headless
  // deployments), then the credentials domain under the configured reference.
  const resolveApiKey = async (): Promise<string | undefined> => {
    const resolved = current()
    if (resolved.apiKey !== undefined && resolved.apiKey.length > 0) return resolved.apiKey
    const ref = credentialRef(resolved.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    return (await credentials.resolve(ref))?.value
  }

  const ledger = new LedgerStore()
  const mediaCache = new MediaCache()
  const jobs = ctx.get('jobs')
  const runner = new RunningHubTaskRunner(() => current(), resolveApiKey, ledger, jobs)
  const objectInfos = new ObjectInfoCache()

  ctx.inject(['settings'], (settingsCtx) => {
    settingsProvider = settingsCtx.settings
    settingsCtx.settings.installSection(ctx, RUNNINGHUB_NS, Config, config, {
      setSource: (source) => { current = source },
      onChange: () => {},
    })
  })

  ctx.plugin(RunningHubController, { getConfig: () => current(), resolveApiKey, objectInfos, getRunner: () => runner })

  registerRunningHubTools(ctx, {
    getConfig: () => current(),
    runner,
    resolveApiKey,
    objectInfos,
    mediaCache,
    saveWorkflows: async (workflows: WorkflowDefinition[]) => {
      if (settingsProvider === undefined) throw new Error('settings service unavailable')
      await settingsProvider.update(RUNNINGHUB_NS, { workflows })
    },
  })

  // Built-in usage skill: teaches the model the run_workflow flow (needs_input
  // handling, media upload, task polling) without touching the user skill dirs.
  ctx.get('skills')?.register({
    name: 'runninghub',
    description: 'Run RunningHub cloud ComfyUI workflows: pick a saved workflow, fill required params/media, submit, and collect results.',
    content: SKILL_CONTENT,
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  })

  // M5: startup recovery — resume RUNNING/QUEUED tasks (re-query) and re-submit PENDING tasks.
  void runner.recover()
  void mediaCache.load()
}

const SKILL_CONTENT = `# RunningHub

Run cloud ComfyUI workflows through the \`runninghub_*\` tools.

## Flow

1. \`runninghub_list_workflows\` — see what the user has saved. If the target
   workflow is missing, ask for its workflowId and use
   \`runninghub_fetch_workflow\` (the user can also save it in Settings →
   Plugins → RunningHub).
2. \`runninghub_run_workflow\` — submit by label or workflowId, with optional
   \`params\` overrides (\`nodeId\`, \`fieldName\`, \`fieldValue\`).
   - When it returns \`status: "needs_input"\`, fill each \`missing\` entry and
     retry; do NOT guess values the user must supply.
   - Media inputs: upload local files first with \`runninghub_upload_file\`,
     then pass the returned \`fileName\` as the slot's \`fieldValue\`.
3. \`runninghub_get_task\` — poll until SUCCESS/FAILED/TIMEOUT. Tasks keep
   running in the background; you do not need to busy-poll.
4. On SUCCESS the result lists output files (fileUrl/fileName). Present them
   to the user.

## Notes

- Tasks cost the user money on RunningHub — confirm before submitting, and
  never retry a paid run in a loop.
- Reference media is the model's call: decide from context whether the task
  needs reference images, upload them with \`runninghub_upload_file\`, then map
  each returned fileName onto its slot via overrides, e.g.
  \`{"102.image": "api/xxx.png"}\`. Explicit slot values win over
  chat-attachment auto-matching.
- Submissions send the edited graph JSON (create API's \`workflow\` field):
  param defaults/overrides are baked into node inputs and media slots with
  NO supplied media are CUT from the graph (Load node removed, links cleaned,
  downstream ref_* inputs cleared — never placeholder-filled). So "no
  reference image" really means no reference chain.
- Params and media slots marked \`★\` are user-curated attention items:
  always review them when running. Unmarked params are intentionally fixed —
  do not analyze or override them unless the user asks; unmarked media slots
  are internal wiring. \`*\` still means required. A workflow's
  \`media note\` line is the user's media usage rule (counts, mapping
  order) — follow it instead of re-deriving it.
- \`instanceType: "plus"\` selects the 48G-VRAM pool.
- \`runninghub_cancel_task\` cancels by local task id.
- \`runninghub_refresh_workflow\` re-fetches a saved workflow's latest
  defaults when the user says the workflow changed upstream.
`
