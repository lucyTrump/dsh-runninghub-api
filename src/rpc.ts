/** Host Remote backing `ctx.remote.runninghub` for the settings card (workflow fetch/validate). */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RunningHubGateway } from './gateway.ts'
import { enrichNodeDefaults, type ObjectInfoCache } from './nodeinfo.ts'
import { buildWorkflowGraph, validateWorkflowDefinition } from './payload.ts'
import type { RunningHubConfig } from './settings.ts'
import { parseDescribeAnswer } from './describe.ts'
import { parseWorkflowPrompt } from './workflow.ts'
import type { WorkflowNodeInfo } from './workflow.ts'
import type {
  DescribeWorkflowData, DescribeWorkflowRequest,
  FetchWorkflowData, FetchWorkflowRequest,
  RunTestData, RunTestRequest,
  ValidateWorkflowData, ValidateWorkflowRequest,
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
            content: [{ type: 'text', text: workflowDigest(request.workflow) }],
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
        const { description, attention } = parseDescribeAnswer(text, valid, zh)
        if (description !== '') {
          return {
            description,
            ...(attention.length > 0 ? { attention } : {}),
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
    await this.requireGateway()
    // Graph mode when the raw prompt is stored: card runs carry no media, so
    // every media slot is cut from the graph (never placeholder-filled).
    let nodeInfoList = validation.nodeInfoList
    let workflowRaw: string | undefined
    if (workflow.prompt !== undefined && workflow.prompt !== '') {
      workflowRaw = buildWorkflowGraph(workflow, [], workflow.mediaSlots)
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
}

export default RunningHubController

/** Compact plain-text digest of one workflow for the description prompt (capped at 4000 chars). */
function workflowDigest(workflow: DescribeWorkflowRequest['workflow']): string {
  const lines: string[] = [`label: ${workflow.label}`, `workflowId: ${workflow.workflowId}`]
  let nodes: WorkflowNodeInfo[] | undefined
  if (workflow.prompt !== undefined && workflow.prompt !== null) {
    try {
      nodes = parseWorkflowPrompt(JSON.stringify(workflow.prompt)).nodes
    } catch {
      nodes = undefined
    }
  }
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
  if (workflow.mediaNote !== undefined && workflow.mediaNote !== '') {
    lines.push(`media note: ${workflow.mediaNote}`)
  }
  if (workflow.mediaSlots.length > 0) {
    lines.push('media: ' + workflow.mediaSlots.map(slot =>
      `${slot.label}(${slot.type})${slot.attention === true ? ' ★' : ''}`).join('; '))
  }
  const text = lines.join('\n')
  return text.length > 4000 ? text.slice(0, 4000) : text
}

function workflowLogLabel(request: DescribeWorkflowRequest): string {
  return `${request.workflow.label} (${request.workflow.workflowId})`
}

const DESCRIBE_SYSTEM_ZH = [
  '你是 ComfyUI 工作流分析器。根据用户给出的工作流摘要，输出恰好两行：',
  '第一行以「描述：」开头：一段供 AI 在多个工作流中快速挑选的中文描述，固定格式 <类型>：<一句话用途>。输入：<所需输入>；输出：<产出内容>，不超过 80 字。',
  '第二行以「关注：」开头：使用时最值得用户调整的参数（提示词、风格、尺寸等；种子、内部固定参数不算），用 nodeId.fieldName 逗号分隔，最多 5 个；没有则写「无」。',
  '只输出这两行，不要解释、不要引号。',
].join('\n')
const DESCRIBE_SYSTEM_EN = [
  'You analyze ComfyUI workflows. Given a workflow digest, output exactly two lines:',
  'Line one starts with "description:": a catalog description another AI can use to pick this workflow out of a list, in the fixed format "<type>: <one-sentence purpose>. Input: <required inputs>; Output: <result>", 160 characters max.',
  'Line two starts with "attention:": the params a user would most likely adjust per run (prompts, style, sizes — not seeds or internal fixed wiring), as comma-separated nodeId.fieldName keys, at most 5; write "none" when nothing qualifies.',
  'Output those two lines only — no explanation, no quotes.',
].join('\n')
