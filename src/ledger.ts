/** Durable RunningHub task ledger persisted under `~/.dsh/runninghub`. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { NodeInfoItem, ResultItem } from './gateway.ts'

export type TaskStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'

export interface TaskRecord {
  /** Locally generated, stable across restarts. */
  localId: string
  /** RunningHub task id, present once the platform accepted the submit. */
  taskId?: string
  /** DSH background job id (in-session only; invalid after restart). */
  jobId?: string
  status: TaskStatus
  workflowId: string
  label?: string
  nodeInfoList: NodeInfoItem[]
  /** Raw api-format workflow JSON string; when set, create submits it instead of referencing workflowId's server-side graph. */
  workflowRaw?: string
  /** Instance type passthrough (e.g. `plus` for the 48G-VRAM pool). */
  instanceType?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Saved result files (with `savedPath` appended when written locally). */
  outputs?: ResultItem[]
}

export const RUNNINGHUB_HOME = dshHomePath('runninghub')
export const RUNNINGHUB_OUTPUTS = dshHomePath('runninghub', 'outputs')

interface LedgerDocument {
  tasks: TaskRecord[]
}

export class LedgerStore {
  private records: TaskRecord[] = []
  private loaded = false
  private readonly file: string

  constructor(root: string = RUNNINGHUB_HOME) {
    this.file = join(root, 'ledger.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as LedgerDocument
      this.records = Array.isArray(parsed.tasks) ? parsed.tasks : []
    } catch {
      this.records = []
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const document: LedgerDocument = { tasks: this.records }
    await writeFile(this.file, JSON.stringify(document, null, 2))
  }

  upsert(record: TaskRecord): void {
    const index = this.records.findIndex(existing => existing.localId === record.localId)
    if (index === -1) this.records.push(record)
    else this.records[index] = record
  }

  get(localId: string): TaskRecord | undefined {
    return this.records.find(record => record.localId === localId)
  }

  byTaskId(taskId: string): TaskRecord | undefined {
    return this.records.find(record => record.taskId === taskId)
  }

  list(): TaskRecord[] {
    return [...this.records]
  }

  pending(): TaskRecord[] {
    return this.records.filter(record => record.status === 'PENDING')
  }

  live(): TaskRecord[] {
    // TIMEOUT tasks keep their taskId and may still be alive on the platform —
    // recovery re-queries them.
    return this.records.filter(record =>
      record.status === 'RUNNING' || record.status === 'QUEUED' || record.status === 'TIMEOUT')
  }
}
