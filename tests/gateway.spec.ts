/** Gateway transport tests: every endpoint against a mocked fetch. */

import { describe, expect, it } from 'vitest'
import { RunningHubError, RunningHubGateway } from '../src/gateway.ts'

const KEY = 'SECRET-KEY-123'

/** Build a gateway whose fetch is the given handler; returns the recorded calls. */
function gatewayWith(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const gateway = new RunningHubGateway({
    resolveApiKey: async () => KEY,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return handler(String(url), init ?? {})
    }) as typeof fetch,
  })
  return { gateway, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('RunningHubGateway', () => {
  it('throws the canonical no-key error before any request when the key resolves to nothing', async () => {
    const gateway = new RunningHubGateway({ resolveApiKey: async () => undefined })
    await expect(gateway.fetchWorkflowJson('1')).rejects.toThrow('no RunningHub API key configured')
  })

  it('A: fetchWorkflowJson posts the key in header and JSON body and returns the prompt', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse({ code: 0, data: { prompt: '{"1":{}}' } }))
    const result = await gateway.fetchWorkflowJson('42')
    expect(result).toEqual({ workflowId: '42', prompt: '{"1":{}}' })
    const call = calls[0]!
    expect(call.url).toBe('https://www.runninghub.cn/api/openapi/getJsonApiFormat')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(call.init.body))).toMatchObject({ apiKey: KEY, workflowId: '42' })
  })

  it('A: fetchWorkflowJson rejects an empty prompt as an invalid-workflow error', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse({ code: 0, data: {} }))
    await expect(gateway.fetchWorkflowJson('nope')).rejects.toThrow('no workflow prompt')
  })

  it('B: createTask posts nodeInfoList and returns the taskId', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse({ code: 0, data: { taskId: 't-1', taskStatus: 'QUEUED' } }))
    const result = await gateway.createTask({
      workflowId: '42',
      nodeInfoList: [{ nodeId: '3', fieldName: 'text', fieldValue: 'a cat' }],
    })
    expect(result.taskId).toBe('t-1')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(calls[0]!.url).toContain('/task/openapi/create')
    expect(body.apiKey).toBe(KEY)
    expect(body.nodeInfoList).toEqual([{ nodeId: '3', fieldName: 'text', fieldValue: 'a cat' }])
  })

  it('B: createTask without a taskId throws', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse({ code: 0, data: {} }))
    await expect(gateway.createTask({ workflowId: '1', nodeInfoList: [] })).rejects.toThrow('no taskId')
  })

  it('C: outputs passes through 804 (running) and 813 (queued) without throwing', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse({ code: 804, msg: 'running' }))
    const running = await gateway.outputs('t-1')
    expect(running.code).toBe(804)
    const queued = new RunningHubGateway({
      resolveApiKey: async () => KEY,
      fetchImpl: (async () => jsonResponse({ code: 813 })) as typeof fetch,
    })
    expect((await queued.outputs('t-1')).code).toBe(813)
  })

  it('C: outputs maps code 0 data to the results array and 805 to failure details', async () => {
    const done = new RunningHubGateway({
      resolveApiKey: async () => KEY,
      fetchImpl: (async () => jsonResponse({ code: 0, data: [{ fileUrl: 'https://x/y.png' }] })) as typeof fetch,
    })
    expect((await done.outputs('t-1')).data).toEqual([{ fileUrl: 'https://x/y.png' }])
    const failed = new RunningHubGateway({
      resolveApiKey: async () => KEY,
      fetchImpl: (async () => jsonResponse({ code: 805, data: { failedReason: { error_message: 'boom' } } })) as typeof fetch,
    })
    const failure = await failed.outputs('t-1')
    expect(failure.code).toBe(805)
    expect(failure.failedReason?.error_message).toBe('boom')
  })

  it('throws a masked error for unexpected envelope codes', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse({ code: 421, msg: `key ${KEY} rejected` }))
    await expect(gateway.outputs('t-1')).rejects.toThrow('key *** rejected')
    await expect(gateway.outputs('t-1')).rejects.not.toThrow(KEY)
  })

  it('D: cancel posts the taskId and returns the envelope code', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse({ code: 0, msg: 'ok' }))
    const result = await gateway.cancel('t-9')
    expect(result.code).toBe(0)
    expect(calls[0]!.url).toContain('/task/openapi/cancel')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ apiKey: KEY, taskId: 't-9' })
  })

  it('E: uploadBinary posts multipart to the v2 endpoint and returns fileName', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse({ code: 0, data: { fileName: 'up.png' } }))
    const result = await gateway.uploadBinary({ name: 'a.png', data: new Uint8Array([1, 2, 3]) })
    expect(result.fileName).toBe('up.png')
    expect(calls[0]!.url).toContain('/openapi/v2/media/upload/binary')
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
  })

  it('F: uploadLegacy appends apiKey and fileType to the multipart form', async () => {
    let captured: FormData | undefined
    const gateway = new RunningHubGateway({
      resolveApiKey: async () => KEY,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        captured = init?.body as FormData
        return jsonResponse({ code: 0, data: { fileName: 'legacy.png' } })
      }) as typeof fetch,
    })
    const result = await gateway.uploadLegacy({ name: 'a.png', data: new Uint8Array([9]) }, 'image')
    expect(result.fileName).toBe('legacy.png')
    expect(captured?.get('apiKey')).toBe(KEY)
    expect(captured?.get('fileType')).toBe('image')
  })

  it('wraps network failures in RunningHubError with the key masked', async () => {
    const gateway = new RunningHubGateway({
      resolveApiKey: async () => KEY,
      fetchImpl: (async () => { throw new Error(`dial failed for ${KEY}`) }) as typeof fetch,
    })
    await expect(gateway.fetchWorkflowJson('1')).rejects.toThrow(RunningHubError)
    await expect(gateway.fetchWorkflowJson('1')).rejects.toThrow('dial failed for ***')
  })

  it('throws on non-2xx HTTP before reading the envelope', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse({}, 500))
    await expect(gateway.fetchWorkflowJson('1')).rejects.toThrow('HTTP 500')
  })
})
