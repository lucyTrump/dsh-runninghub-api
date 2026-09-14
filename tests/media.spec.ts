/** Media cache tests: content-hash dedup across cachedUpload calls. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunningHubGateway } from '../src/gateway.ts'
import { cachedUpload, MediaCache, sha256Hex } from '../src/media.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runninghub-media-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Gateway double counting uploads, always returning the same fileName. */
function fakeGateway() {
  let uploads = 0
  const gateway = new RunningHubGateway({
    resolveApiKey: async () => 'k',
    fetchImpl: (async () => {
      uploads++
      return new Response(JSON.stringify({ code: 0, data: { fileName: 'remote.png', downloadUrl: 'https://x/remote.png' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })
  return { gateway, uploads: () => uploads }
}

describe('sha256Hex', () => {
  it('is stable per content and differs across contents', () => {
    expect(sha256Hex(new Uint8Array([1, 2]))).toBe(sha256Hex(new Uint8Array([1, 2])))
    expect(sha256Hex(new Uint8Array([1, 2]))).not.toBe(sha256Hex(new Uint8Array([1, 3])))
  })
})

describe('cachedUpload', () => {
  it('uploads once per unique content and reuses the cache for repeats', async () => {
    const { gateway, uploads } = fakeGateway()
    const cache = new MediaCache(dir)
    const data = new Uint8Array([1, 2, 3])

    const first = await cachedUpload({ gateway, cache, data, name: 'a.png', fileType: 'image' })
    expect(first.cached).toBe(false)
    expect(first.fileName).toBe('remote.png')
    expect(uploads()).toBe(1)

    const second = await cachedUpload({ gateway, cache, data, name: 'a.png', fileType: 'image' })
    expect(second.cached).toBe(true)
    expect(second.fileName).toBe('remote.png')
    expect(uploads()).toBe(1)
  })

  it('persists the cache across MediaCache instances in the same directory', async () => {
    const { gateway, uploads } = fakeGateway()
    const data = new Uint8Array([9, 9])
    await cachedUpload({ gateway, cache: new MediaCache(dir), data, name: 'b.png', fileType: 'image' })

    const fresh = new MediaCache(dir)
    const hit = await cachedUpload({ gateway, cache: fresh, data, name: 'b.png', fileType: 'image' })
    expect(hit.cached).toBe(true)
    expect(uploads()).toBe(1)
  })

  it('routes through the legacy endpoint when useLegacy is set', async () => {
    let url = ''
    const gateway = new RunningHubGateway({
      resolveApiKey: async () => 'k',
      fetchImpl: (async (u: string | URL | Request) => {
        url = String(u)
        return new Response(JSON.stringify({ code: 0, data: { fileName: 'l.png' } }), { status: 200 })
      }) as typeof fetch,
    })
    await cachedUpload({ gateway, cache: new MediaCache(dir), data: new Uint8Array([7]), name: 'c.png', fileType: 'image', useLegacy: true })
    expect(url).toContain('/task/openapi/upload')
  })
})
