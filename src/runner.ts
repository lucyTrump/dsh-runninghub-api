/** RunningHub task runner: submit → poll → save, with a local concurrency gate and DSH background jobs. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { RunningHubGateway } from './gateway.ts'
import type { NodeInfoItem, ResultItem } from './gateway.ts'
import { LedgerStore, RUNNINGHUB_OUTPUTS } from './ledger.ts'
import type { TaskRecord } from './ledger.ts'
import type { RunningHubConfig } from './settings.ts'
import { DEFAULT_RUN_TIMEOUT_MS } from './settings.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    runninghub: 'runninghub'
  }
}

export interface SubmitInput {
  workflowId: string
  label?: string
  nodeInfoList: NodeInfoItem[]
  /** Raw api-format workflow JSON string; submitted as `workflow`, overriding the server-side graph. */
  workflowRaw?: string
  /** Instance type passthrough (e.g. `plus` for the 48G-VRAM pool). */
  instanceType?: string
  owner?: Agent
}

const TEARDOWN_REASONS = new Set(['owner disposed', 'jobs service disposed'])

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>]/g, '_').trim()
  return cleaned === '' ? 'output' : cleaned
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export class RunningHubTaskRunner {
  private active = 0
  private queue: TaskRecord[] = []
  private readonly owners = new Map<string, Agent | undefined>()

  constructor(
    private readonly getConfig: () => RunningHubConfig,
    private readonly resolveApiKey: () => Promise<string | undefined>,
    private readonly ledger: LedgerStore,
    private readonly jobs: JobRegistry | undefined,
  ) {}

  maxConcurrent(): number {
    const max = this.getConfig().maxConcurrentTasks
    return max !== undefined && max > 0 ? max : 3
  }

  get(localId: string): TaskRecord | undefined {
    return this.ledger.get(localId)
  }

  list(): TaskRecord[] {
    return this.ledger.list()
  }

  /** Enqueue a task (PENDING) and drain the local gate. */
  submit(input: SubmitInput): TaskRecord {
    const record: TaskRecord = {
      localId: randomUUID(),
      status: 'PENDING',
      workflowId: input.workflowId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      nodeInfoList: input.nodeInfoList,
      ...(input.workflowRaw !== undefined ? { workflowRaw: input.workflowRaw } : {}),
      ...(input.instanceType !== undefined ? { instanceType: input.instanceType } : {}),
      createdAt: new Date().toISOString(),
    }
    this.owners.set(record.localId, input.owner)
    this.ledger.upsert(record)
    void this.ledger.save()
    this.queue.push(record)
    this.drain()
    return record
  }

  /**
   * Cancel a queued or running task (PENDING tasks drop out of the local
   * queue). Callers without an agent identity (the settings/panel RPCs) leave
   * `owner` undefined: the submit-time owner stands in, since the jobs fence
   * rejects a no-agent caller for owned jobs.
   */
  cancel(localId: string, owner?: Agent): 'requested' | 'not-found' | 'already-finished' {
    const record = this.ledger.get(localId)
    if (record === undefined) return 'not-found'
    if (record.status === 'PENDING') {
      this.queue = this.queue.filter(queued => queued.localId !== localId)
      record.status = 'CANCELLED'
      record.finishedAt = new Date().toISOString()
      this.ledger.upsert(record)
      void this.ledger.save()
      return 'requested'
    }
    if (this.jobs === undefined || record.jobId === undefined) return 'already-finished'
    try {
      return this.jobs.kill(JobId(record.jobId), owner ?? this.owners.get(localId))
    } catch {
      // Stale or foreign job handle (poller gone, or owned by a dead session):
      // settle the record locally and cancel at the platform directly. A
      // surviving foreign poller converges to a terminal state on its own.
      if (record.taskId !== undefined) {
        void this.gateway().cancel(record.taskId).catch(() => {})
      }
      record.status = 'CANCELLED'
      record.finishedAt = new Date().toISOString()
      this.ledger.upsert(record)
      void this.ledger.save()
      return 'requested'
    }
  }

  /**
   * One-shot platform re-query for every non-terminal record: the panel's
   * manual refresh, and the recovery path for a record whose poller is gone.
   * Per-task failures leave the stale status in place.
   */
  async refresh(): Promise<void> {
    const gateway = this.gateway()
    for (const record of this.ledger.live()) {
      if (record.taskId === undefined) continue
      try {
        const result = await gateway.outputs(record.taskId)
        if (result.code === 0) {
          record.outputs = await this.saveResults(gateway, result.data ?? [], record)
          record.status = 'SUCCEEDED'
          record.finishedAt = new Date().toISOString()
        } else if (result.code === 804) {
          record.status = 'RUNNING'
        } else if (result.code === 813) {
          record.status = 'QUEUED'
        } else if (result.code === 805) {
          record.status = 'FAILED'
          record.error = this.failureMessage(result)
          record.finishedAt = new Date().toISOString()
        }
        this.ledger.upsert(record)
      } catch {
        // Keep the stale record; the next refresh or poller retries.
      }
    }
    void this.ledger.save()
  }

  gateway(): RunningHubGateway {
    const config = this.getConfig()
    return new RunningHubGateway({
      resolveApiKey: this.resolveApiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    })
  }

  private drain(): void {
    const max = this.maxConcurrent()
    while (this.active < max && this.queue.length > 0) {
      const record = this.queue.shift()
      if (record === undefined) break
      this.startTask(record)
    }
  }

  private startTask(record: TaskRecord): void {
    this.active++
    try {
      if (this.jobs === undefined) throw new Error('background jobs unavailable (load @deepseek-ai/dsh-jobs + @deepseek-ai/dsh-tool-jobs)')
      const owner = this.owners.get(record.localId)
      const id = this.jobs.start({
        kind: 'runninghub',
        label: record.label ?? record.workflowId,
        ...(owner !== undefined ? { owner } : {}),
        run: () => this.runLoop(record),
      })
      record.jobId = id
      record.startedAt = new Date().toISOString()
      this.ledger.upsert(record)
    } catch (error) {
      this.active--
      record.status = 'FAILED'
      record.error = error instanceof Error ? error.message : String(error)
      record.finishedAt = new Date().toISOString()
      this.ledger.upsert(record)
      void this.ledger.save()
      this.drain()
    }
  }

  /** M5: after a restart, resume RUNNING/QUEUED tasks (re-query) then re-submit PENDING tasks (FIFO). */
  async recover(): Promise<void> {
    await this.ledger.load()
    for (const record of this.ledger.live()) {
      if (record.taskId !== undefined) this.resumeTask(record)
    }
    for (const record of this.ledger.pending()) {
      this.queue.push(record)
    }
    this.drain()
  }

  private resumeTask(record: TaskRecord): void {
    this.active++
    try {
      if (this.jobs === undefined) throw new Error('background jobs unavailable (load @deepseek-ai/dsh-jobs + @deepseek-ai/dsh-tool-jobs)')
      const id = this.jobs.start({
        kind: 'runninghub',
        label: record.label ?? record.workflowId,
        run: () => this.resumeLoop(record),
      })
      record.jobId = id
      record.startedAt = new Date().toISOString()
      this.ledger.upsert(record)
    } catch (error) {
      this.active--
      record.status = 'FAILED'
      record.error = error instanceof Error ? error.message : String(error)
      record.finishedAt = new Date().toISOString()
      this.ledger.upsert(record)
      void this.ledger.save()
      this.drain()
    }
  }

  private runLoop(record: TaskRecord): JobHooks {
    return this.loop(record, async (gateway, signal) => {
      record.status = 'QUEUED'
      this.ledger.upsert(record)
      const created = await gateway.createTask(
        {
          workflowId: record.workflowId,
          // Graph mode bakes params+media into the raw workflow; sending
          // nodeInfoList too could reference nodes the surgery cut.
          ...(record.workflowRaw !== undefined
            ? { workflow: record.workflowRaw }
            : { nodeInfoList: record.nodeInfoList }),
          ...(record.instanceType !== undefined ? { instanceType: record.instanceType } : {}),
        },
        signal,
      )
      record.taskId = created.taskId
      record.status = 'RUNNING'
      this.ledger.upsert(record)
    })
  }

  /** Resume polling an already-submitted task (its `taskId` is persisted). */
  private resumeLoop(record: TaskRecord): JobHooks {
    return this.loop(record, async () => {
      record.status = 'RUNNING'
      this.ledger.upsert(record)
    })
  }

  private loop(
    record: TaskRecord,
    establishTask: (gateway: RunningHubGateway, signal: AbortSignal) => Promise<void>,
  ): JobHooks {
    const controller = new AbortController()
    let cancelled = false
    let cancelReason: string | undefined
    const gateway = this.gateway()

    const done = (async (): Promise<JobOutcome> => {
      try {
        await establishTask(gateway, controller.signal)
        return await this.poll(gateway, record, controller.signal)
      } catch (error) {
        if (cancelled || controller.signal.aborted) {
          record.status = 'CANCELLED'
          record.finishedAt = new Date().toISOString()
          return { status: 'killed', detail: cancelReason ?? 'cancelled' }
        }
        record.status = 'FAILED'
        record.error = error instanceof Error ? error.message : String(error)
        record.finishedAt = new Date().toISOString()
        return { status: 'failed', detail: record.error }
      } finally {
        this.active--
        this.owners.delete(record.localId)
        void this.ledger.save()
        this.drain()
      }
    })()

    return {
      cancel: (reason) => {
        cancelled = true
        cancelReason = reason
        controller.abort()
        // User-initiated cancel reaches RunningHub; teardown only stops the local poller.
        if (!TEARDOWN_REASONS.has(reason ?? '') && record.taskId !== undefined) {
          void gateway.cancel(record.taskId).catch(() => {})
        }
        if (record.status !== 'SUCCEEDED' && record.status !== 'FAILED') {
          record.status = 'CANCELLED'
          record.finishedAt = new Date().toISOString()
          this.ledger.upsert(record)
        }
      },
      done,
    }
  }

  private async poll(
    gateway: RunningHubGateway,
    record: TaskRecord,
    signal: AbortSignal,
  ): Promise<JobOutcome> {
    const config = this.getConfig()
    const interval = config.pollIntervalMs !== undefined && config.pollIntervalMs > 0
      ? config.pollIntervalMs : 5000
    // Timeout split (§6.9): queueTimeoutMs bounds the platform-side QUEUED
    // phase (0 = unlimited); runTimeoutMs starts counting only once the task
    // first reports RUNNING (0 = unlimited).
    const runTimeoutMs = config.runTimeoutMs !== undefined && config.runTimeoutMs > 0
      ? config.runTimeoutMs : DEFAULT_RUN_TIMEOUT_MS
    const queueTimeoutMs = config.queueTimeoutMs !== undefined && config.queueTimeoutMs > 0
      ? config.queueTimeoutMs : 0
    const queuedSince = Date.now()
    let runDeadline: number | undefined

    for (;;) {
      if (signal.aborted) return { status: 'killed' }
      const result = await gateway.outputs(record.taskId ?? '', signal)
      if (result.code === 0) {
        const outputs = await this.saveResults(gateway, result.data ?? [], record)
        record.status = 'SUCCEEDED'
        record.outputs = outputs
        record.finishedAt = new Date().toISOString()
        this.ledger.upsert(record)
        return {
          status: 'completed',
          detail: `${outputs.length} result file(s) saved`,
          output: JSON.stringify(outputs, null, 2),
        }
      }
      if (result.code === 804) {
        if (runDeadline === undefined && runTimeoutMs > 0) runDeadline = Date.now() + runTimeoutMs
        record.status = 'RUNNING'
        if (runDeadline !== undefined && Date.now() >= runDeadline) {
          record.status = 'TIMEOUT'
          record.error = 'run timeout; the task may still be running on RunningHub — re-check with runninghub_get_task'
          record.finishedAt = new Date().toISOString()
          this.ledger.upsert(record)
          return { status: 'failed', detail: record.error }
        }
      } else if (result.code === 813) {
        record.status = 'QUEUED'
        if (queueTimeoutMs > 0 && Date.now() - queuedSince >= queueTimeoutMs) {
          record.status = 'TIMEOUT'
          record.error = 'queue timeout; the task may still be queued on RunningHub — re-check with runninghub_get_task or cancel it'
          record.finishedAt = new Date().toISOString()
          this.ledger.upsert(record)
          return { status: 'failed', detail: record.error }
        }
      } else if (result.code === 805) {
        record.status = 'FAILED'
        record.error = this.failureMessage(result)
        record.finishedAt = new Date().toISOString()
        this.ledger.upsert(record)
        return { status: 'failed', detail: record.error }
      }
      this.ledger.upsert(record)
      await sleep(interval, signal)
    }
  }

  private failureMessage(result: { failedReason?: { exception_message?: string; node_name?: string }; msg?: string }): string {
    const node = result.failedReason?.node_name
    const message = result.failedReason?.exception_message ?? result.msg ?? 'unknown failure'
    return node !== undefined ? `${node}: ${message}` : message
  }

  private async saveResults(
    gateway: RunningHubGateway,
    items: ResultItem[],
    record: TaskRecord,
  ): Promise<ResultItem[]> {
    const dir = join(RUNNINGHUB_OUTPUTS, record.localId)
    await mkdir(dir, { recursive: true })
    const saved: ResultItem[] = []
    for (const item of items) {
      const url = typeof item.fileUrl === 'string' ? item.fileUrl : undefined
      if (url === undefined || url === '') {
        saved.push(item)
        continue
      }
      const name = item.fileName ?? basename(url.split('?')[0] ?? 'output')
      try {
        const response = await gateway.download(url)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const dest = join(dir, sanitizeFileName(name))
        await writeFile(dest, bytes)
        saved.push({ ...item, savedPath: dest })
      } catch {
        saved.push({ ...item, fileUrl: url })
      }
    }
    return saved
  }
}
