/** Host Remote backing `ctx.remote.runninghub` for the settings card (workflow fetch/validate). */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RunningHubGateway } from './gateway.ts'
import { enrichNodeDefaults, type ObjectInfoCache, type ObjectInfoRegistry } from './nodeinfo.ts'
import { buildWorkflowGraph, describeParamConstraints, findIllegalComboValues, formatComboOptions, validateWorkflowDefinition } from './payload.ts'
import type { RunningHubConfig, WorkflowDefinition } from './settings.ts'
import { parseDescribeAnswer } from './describe.ts'
import { parseStoredPrompt, parseWorkflowPrompt } from './workflow.ts'
import type { WorkflowNodeInfo } from './workflow.ts'
import type {
  DescribeWorkflowData, DescribeWorkflowRequest,
  FetchWorkflowData, FetchWorkflowRequest,
  RunTestData, RunTestRequest,
  ValidateWorkflowData, ValidateWorkflowRequest,
  CancelTaskData, CancelTaskRequest,
  ListTasksData,
} from './types.ts'
import type { RunningHubTaskRunner } from './runner.ts'

export interface RunningHubControllerDeps {
  getConfig: () => RunningHubConfig
  /** Resolve the API key (credentials domain → literal fallback). */
  resolveApiKey: () => Promise<string | undefined>
  /** Shared TTL'd object_info registry (authoritative widget types). */
  objectInfos: ObjectInfoCache
  getRunner: () => RunningHubTaskRunner
}

/** Host service backing `ctx.remote.runninghub` (workflow management before any task runs). */
export class RunningHubController extends TypertRemoteService {
  static inject = ['typert']

  private readonly getConfig: () => RunningHubConfig
  private readonly resolveApiKey: () => Promise<string | undefined>
  private readonly objectInfos: ObjectInfoCache
  private readonly getRunner: () => RunningHubTaskRunner

  constructor(ctx: Context, deps: RunningHubControllerDeps) {
    super(ctx, 'runninghubController', { namespace: 'runninghub' })
    this.getConfig = deps.getConfig
    this.resolveApiKey = deps.resolveApiKey
    this.objectInfos = deps.objectInfos
    this.getRunner = deps.getRunner
  }

  /**
   * Build a gateway, failing fast with `runninghub/no-api-key` when no key
   * resolves (the settings card writes the key into the credentials domain).
   */
  private async requireGateway(): Promise<RunningHubGateway> {
    const key = await this.resolveApiKey()
    if (key === undefined || key === '') {
      throw new RemoteError('runninghub/no-api-key', 'no RunningHub API key configured', {})
    }
    const config = this.getConfig()
    return new RunningHubGateway({
      resolveApiKey: async () => key,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    })
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Why this workflow's recent runs died — the describe prompt's hardest evidence. */
  private recentFailures(workflow: WorkflowDefinition): string[] {
    return this.getRunner()
      .list()
      .filter(record => record.workflowId === workflow.workflowId && record.status === 'FAILED' && record.error !== undefined)
      .slice(-2)
      .map(record => record.error as string)
  }

  /** A: fetch + parse a workflow by id, enriched with registry widget types (no side effects). */
  @Remote
  async fetchWorkflow(request: FetchWorkflowRequest): Promise<FetchWorkflowData> {
    const { workflowId } = request
    const gateway = await this.requireGateway()
    try {
      const result = await gateway.fetchWorkflowJson(workflowId)
      const parsed = parseWorkflowPrompt(result.prompt)
      // Best-effort registry enrichment: the api-format JSON carries raw
      // values only, so `denoise: 1` reads as an int. object_info is the
      // authoritative INT/FLOAT/COMBO source (the RH web editor's own).
      const registry = await this.objectInfos.get(() => gateway.fetchObjectInfo())
      const classOf = new Map(parsed.nodes.map(node => [node.nodeId, node.classType]))
      const nodeDefaults = enrichNodeDefaults(parsed.nodeDefaults, classOf, registry)
      let prompt: JsonValue = null
      try {
        prompt = JSON.parse(result.prompt) as JsonValue
      } catch {
        prompt = null
      }
      return {
        workflowId,
        prompt,
        nodes: parsed.nodes,
        nodeDefaults,
        mediaSlots: parsed.mediaSlots,
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('runninghub/fetch-failed', this.describe(error), {})
    }
  }

  /**
   * Probe the RunningHub connection with a real request. A dummy workflowId
   * distinguishes "key rejected" from "key accepted, workflow not found":
   * a workflow-level failure still proves the key passed auth.
   */
  @Remote
  async testConnection(): Promise<boolean> {
    const gateway = await this.requireGateway()
    try {
      await gateway.fetchWorkflowJson('0')
      return true
    } catch (error) {
      const message = this.describe(error)
      // The endpoint accepted the request but no prompt came back — the key works.
      if (/workflow/i.test(message)) return true
      throw new RemoteError('runninghub/auth-failed', message, {})
    }
  }

  /** Free dry-run: assemble the payload and report missing required params (no task submitted). */
  @Remote
  async validateWorkflow(request: ValidateWorkflowRequest): Promise<ValidateWorkflowData> {
    const { workflow } = request
    try {
      const validation = validateWorkflowDefinition(workflow)
      return {
        nodeInfoList: validation.nodeInfoList,
        ...(validation.missingParams.length > 0 ? { missingParams: validation.missingParams } : {}),
        ...(validation.requiredMedia.length > 0 ? { requiredMedia: validation.requiredMedia } : {}),
        ...(validation.optionalEmpty.length > 0 ? { optionalEmpty: validation.optionalEmpty } : {}),
      }
    } catch (error) {
      throw new RemoteError('runninghub/validate-failed', this.describe(error), {})
    }
  }

  /**
   * Summarize one workflow into the fixed one-line catalog description with
   * the user's default model. The card fires this after a successful fetch and
   * fills the description field; failures are the card's to swallow.
   */
  @Remote
  async describeWorkflow(request: DescribeWorkflowRequest): Promise<DescribeWorkflowData> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      throw new RemoteError('runninghub/llm-unavailable', 'no LLM service configured', {})
    }
    // Optional 'provider/model' override from settings; empty = the agent default model.
    const override = this.getConfig().describeModel?.trim() ?? ''
    let provider: string
    let model: string
    if (override !== '') {
      const slash = override.indexOf('/')
      if (slash <= 0 || slash === override.length - 1) {
        throw new RemoteError('runninghub/describe-failed', `describeModel must be "provider/model", got "${override}"`, {})
      }
      provider = override.slice(0, slash)
      model = override.slice(slash + 1)
    } else {
      const defaultModel = this.ctx.get('agentDefaultModel')
      if (defaultModel === undefined) {
        throw new RemoteError('runninghub/llm-unavailable', 'no LLM service or default model configured', {})
      }
      const route = defaultModel.currentSelection()
      provider = route.provider
      model = route.model
    }
    const zh = request.locale?.startsWith('zh') === true
    // Optional context, both best-effort: the node registry turns "what values
    // does this enum accept" from a guess into a lookup, and the ledger's own
    // failures tell the model which gotchas this workflow already hit.
    const registry = await this.objectInfos.get(async () => (await this.requireGateway()).fetchObjectInfo())
    const digest = workflowDigest(request.workflow, registry, this.recentFailures(request.workflow))
    try {
      // One transport-level retry: proxied reasoning streams (Responses API
      // gateways) sometimes drop mid-thinking, and a fresh attempt is cheap.
      let lastEmpty = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        const assembler = new BlockAssembler()
        // A hung provider must not pin the remote call forever.
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [createUserMessage({
            content: [{ type: 'text', text: digest }],
            source: { kind: 'plugin', plugin: 'dsh-runninghub-api' },
          })],
          system: zh ? DESCRIBE_SYSTEM_ZH : DESCRIBE_SYSTEM_EN,
          // No maxTokens (adapters omit the cap and the provider uses the
          // model's own limit) and no reasoningEffort override — adapters
          // reject effort values a model does not advertise.
          signal: AbortSignal.timeout(180_000),
        })) assembler.push(chunk)
        const blocks = assembler.blocks()
        const text = blocks
          .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        const valid = new Set(request.workflow.nodeDefaults.map(param => `${param.nodeId}.${param.fieldName}`))
        const { description, attention, usageNote } = parseDescribeAnswer(text, valid, zh)
        if (description !== '') {
          return {
            description,
            ...(attention.length > 0 ? { attention } : {}),
            ...(usageNote !== '' ? { usageNote } : {}),
          }
        }
        const finish = assembler.finish
        const shape = blocks.map(block => block.type).join(',') || 'none'
        const cause = finish.kind === 'error' || finish.kind === 'aborted'
          ? ` ${finish.failure.code}: ${finish.failure.message}`
          : ''
        lastEmpty = `model ${provider}/${model} returned no usable text (finish=${finish.kind}${cause}, blocks=${shape}, textChars=${text.length})`
        // Only transport-failure finishes are worth a retry.
        if (finish.kind !== 'error' && finish.kind !== 'aborted') break
      }
      throw new RemoteError('runninghub/describe-failed', lastEmpty, {})
    } catch (error) {
      // Host-side log: the settings card swallows this failure by design, so
      // the server log is the only place the cause survives.
      this.ctx.logger.warn(`runninghub: describeWorkflow failed for ${workflowLogLabel(request)} via ${provider}/${model}: ${this.describe(error)}`)
      if (error instanceof RemoteError) throw error
      throw new RemoteError('runninghub/describe-failed', this.describe(error), {})
    }
  }

  /**
   * Real test run: submit the workflow's current defaults as one PAID task
   * through the local concurrency gate. Required params must have values and
   * required media slots are not auto-filled here (no chat context) — a
   * workflow with required media cannot be test-run from the settings card.
   */
  @Remote
  async runTest(request: RunTestRequest): Promise<RunTestData> {
    const { workflow } = request
    const validation = validateWorkflowDefinition(workflow)
    if (validation.missingParams.length > 0) {
      throw new RemoteError('runninghub/validate-failed', `missing required params: ${validation.missingParams.join(', ')}`, {})
    }
    if (validation.requiredMedia.length > 0) {
      throw new RemoteError('runninghub/validate-failed', `required media slots unfilled: ${validation.requiredMedia.join(', ')}`, {})
    }
    // Throws runninghub/no-api-key when the key is missing.
    const gateway = await this.requireGateway()
    const registry = await this.objectInfos.get(() => gateway.fetchObjectInfo())
    const illegal = findIllegalComboValues(workflow, registry)
    if (illegal.length > 0) {
      throw new RemoteError('runninghub/invalid-params', illegal.map(v => `#${v.nodeId}.${v.fieldName} must be one of [${formatComboOptions(v.options)}], got "${v.value}"`).join('; '), {})
    }
    // Graph mode when the raw prompt is stored: card runs carry no media, so
    // every media slot is cut from the graph (never placeholder-filled).
    let nodeInfoList = validation.nodeInfoList
    let workflowRaw: string | undefined
    if (workflow.prompt !== undefined && workflow.prompt !== '') {
      workflowRaw = buildWorkflowGraph(workflow, [], workflow.mediaSlots, registry)
      nodeInfoList = []
    }
    const record = this.getRunner().submit({
      workflowId: workflow.workflowId,
      label: workflow.label,
      nodeInfoList,
      ...(workflowRaw !== undefined ? { workflowRaw } : {}),
    })
    return {
      localId: record.localId,
      status: record.status,
      nodeInfoList: validation.nodeInfoList,
    }
  }

  /** Live ledger read for the floating task panel (oldest first). */
  @Remote
  async listTasks(): Promise<ListTasksData> {
    const tasks = this.getRunner().list().map(record => ({
      localId: record.localId,
      ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
      status: record.status,
      ...(record.label !== undefined ? { label: record.label } : {}),
      workflowId: record.workflowId,
      createdAt: record.createdAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    }))
    return { tasks }
  }

  /** Manual re-query of every non-terminal task (the panel's refresh button). */
  @Remote
  async refreshTasks(): Promise<ListTasksData> {
    await this.getRunner().refresh()
    return this.listTasks()
  }

  /** Panel cancel: the runner falls back to the submit-time owner for the jobs fence. */
  @Remote
  async cancelTask(request: CancelTaskRequest): Promise<CancelTaskData> {
    return { outcome: this.getRunner().cancel(request.localId) }
  }
}

export default RunningHubController

/**
 * Compact plain-text digest of one workflow for the description prompt (capped
 * at 4000 chars). `registry` adds the node types' hard constraints and
 * `failures` the errors this workflow already produced — both optional.
 */
function workflowDigest(
  workflow: DescribeWorkflowRequest['workflow'],
  registry?: ObjectInfoRegistry,
  failures?: readonly string[],
): string {
  const lines: string[] = [`label: ${workflow.label}`, `workflowId: ${workflow.workflowId}`]
  const nodes: WorkflowNodeInfo[] | undefined = parseStoredPrompt(workflow.prompt)?.nodes
  if (nodes !== undefined && nodes.length > 0) {
    lines.push('nodes: ' + nodes.map(node =>
      `#${node.nodeId} ${node.classType}${node.title !== undefined ? `(${node.title})` : ''}`).join(', '))
  }
  if (workflow.nodeDefaults.length > 0) {
    lines.push('params: ' + workflow.nodeDefaults.map((param) => {
      const value = param.fieldValue === undefined ? '' : JSON.stringify(param.fieldValue)
      const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value
      return `${param.label ?? param.fieldName}(${param.kind})${shown === '' ? '' : `=${shown}`}`
    }).join('; '))
  }
  const constraints = describeParamConstraints(workflow, registry)
  if (constraints !== '') lines.push(`constraints: ${constraints}`)
  if (workflow.mediaNote !== undefined && workflow.mediaNote !== '') {
    lines.push(`media note: ${workflow.mediaNote}`)
  }
  if (workflow.usageNote !== undefined && workflow.usageNote !== '') {
    lines.push(`usage note already recorded: ${workflow.usageNote}`)
  }
  if (workflow.mediaSlots.length > 0) {
    lines.push('media: ' + workflow.mediaSlots.map(slot =>
      `${slot.label}(${slot.type})${slot.attention === true ? ' ★' : ''}`).join('; '))
  }
  if (failures !== undefined && failures.length > 0) {
    lines.push('recent failed runs: ' + failures.map(failure => failure.length > 200 ? `${failure.slice(0, 200)}…` : failure).join(' | '))
  }
  const text = lines.join('\n')
  return text.length > 4000 ? text.slice(0, 4000) : text
}

function workflowLogLabel(request: DescribeWorkflowRequest): string {
  return `${request.workflow.label} (${request.workflow.workflowId})`
}

const DESCRIBE_SYSTEM_ZH = [
  '你是 ComfyUI 工作流分析器。根据用户给出的工作流摘要，输出恰好三行：',
  '第一行以「描述：」开头：一段供 AI 在多个工作流中快速挑选的中文描述，固定格式 <类型>：<一句话用途>。输入：<所需输入>；输出：<产出内容>，不超过 80 字。',
  '第二行以「关注：」开头：使用时最值得用户调整的参数（提示词、风格、尺寸等；种子、内部固定参数不算），用 nodeId.fieldName 逗号分隔，最多 5 个；没有则写「无」。',
  '第三行以「注意：」开头：这个工作流实际会踩的坑，最多 3 条、每条一行、每条不超过 40 字，例如某个枚举参数只能填哪个值、需要哪个实例档位、某个槽位该怎么处理；没有则写「无」。',
  '只输出这三行，不要解释、不要引号。摘要里的 constraints 是节点类型给出的硬约束（枚举合法值、上下限），照抄不要改写，更不要编造其它取值。',
].join('\n')
const DESCRIBE_SYSTEM_EN = [
  'You analyze ComfyUI workflows. Given a workflow digest, output exactly three lines:',
  'Line one starts with "description:": a catalog description another AI can use to pick this workflow out of a list, in the fixed format "<type>: <one-sentence purpose>. Input: <required inputs>; Output: <result>", 160 characters max.',
  'Line two starts with "attention:": the params a user would most likely adjust per run (prompts, style, sizes — not seeds or internal fixed wiring), as comma-separated nodeId.fieldName keys, at most 5; write "none" when nothing qualifies.',
  'Line three starts with "note:": up to 3 gotchas this workflow actually hits, one per line, 40 characters each — the only legal values a enum param accepts, the instance tier it needs, how a slot must be handled; write "none" when nothing qualifies.',
  'Output those three lines only — no explanation, no quotes. The constraints in the digest are hard node-type facts: copy them, never invent other values.',
].join('\n')
