/** Runner tests: RunningHub's `code 0` + empty `data` must not read as success. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The ledger/output roots are resolved at module load, so point DSH_HOME at a
// scratch dir before importing anything that reads them.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-runninghub-test-'))
const { LedgerStore } = await import('../src/ledger.ts')
const { RunningHubTaskRunner } = await import('../src/runner.ts')

type Hooks = { done: Promise<unknown> }

/** A jobs registry that runs the task inline and hands back its hooks. */
function inlineJobs(sink: (hooks: Hooks) => void) {
  return {
    start: (init: { run: () => Hooks }) => {
      sink(init.run())
      return 'job-1'
    },
  }
}

function runnerWith(outputs: () => unknown, sink: (hooks: Hooks) => void) {
  vi.stubGlobal('fetch', async (url: string) => new Response(
    JSON.stringify(String(url).endsWith('/outputs')
      ? outputs()
      : { code: 0, data: { taskId: 't-1', taskStatus: 'QUEUED' } }),
    { headers: { 'Content-Type': 'application/json' } },
  ))
  const ledger = new LedgerStore(mkdtempSync(join(tmpdir(), 'dsh-runninghub-ledger-')))
  return new RunningHubTaskRunner(
    () => ({ pollIntervalMs: 1, baseUrl: 'https://example.test' }),
    async () => 'KEY',
    ledger,
    inlineJobs(sink) as never,
  )
}

afterEach(() => { vi.unstubAllGlobals() })

describe('RunningHubTaskRunner', () => {
  it('fails a task whose outputs are code 0 with no files, instead of going green', async () => {
    let hooks: Hooks | undefined
    const runner = runnerWith(() => ({ code: 0, data: [] }), (h) => { hooks = h })
    const record = runner.submit({ workflowId: '42', nodeInfoList: [] })
    await hooks!.done
    const settled = runner.get(record.localId)!
    expect(settled.status).toBe('FAILED')
    expect(settled.error).toContain('no result files')
  })

  it('still succeeds when the re-check finds files', async () => {
    let calls = 0
    let hooks: Hooks | undefined
    const runner = runnerWith(
      () => (++calls === 1
        ? { code: 0, data: [] }
        : { code: 0, data: [{ fileUrl: 'https://example.test/x.png', fileName: 'x.png' }] }),
      (h) => { hooks = h },
    )
    const record = runner.submit({ workflowId: '42', nodeInfoList: [] })
    await hooks!.done
    expect(runner.get(record.localId)!.status).toBe('SUCCEEDED')
  })
})
