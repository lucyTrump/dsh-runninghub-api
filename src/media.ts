/** Media upload cache keyed by content SHA-256, persisted under `~/.dsh/runninghub`. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RunningHubGateway, UploadFile, UploadResult } from './gateway.ts'

export interface MediaCacheEntry {
  /** Content SHA-256 hex — the cache key. */
  sha256: string
  /** RunningHub file name returned at upload time. */
  fileName: string
  /** RunningHub download URL returned at upload time. */
  downloadUrl?: string
  /** Content type used for the upload. */
  fileType: string
  uploadedAt: string
}

interface MediaCacheDocument {
  entries: MediaCacheEntry[]
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export class MediaCache {
  private entries: MediaCacheEntry[] = []
  private loaded = false
  private readonly file: string

  constructor(root: string = dshHomePath('runninghub')) {
    this.file = join(root, 'media-cache.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as MediaCacheDocument
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      this.entries = []
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ entries: this.entries } satisfies MediaCacheDocument, null, 2))
  }

  get(sha256: string): MediaCacheEntry | undefined {
    return this.entries.find(entry => entry.sha256 === sha256)
  }

  put(entry: MediaCacheEntry): void {
    const index = this.entries.findIndex(existing => existing.sha256 === entry.sha256)
    if (index === -1) this.entries.push(entry)
    else this.entries[index] = entry
  }
}

export interface CachedUploadOptions {
  gateway: RunningHubGateway
  cache: MediaCache
  /** File bytes to upload. */
  data: Uint8Array
  /** File name with extension (drives MIME + upload name). */
  name: string
  /** Media kind (`image`/`audio`/`video`/`zip`); used by the legacy endpoint. */
  fileType: string
  /** Legacy endpoint (E/F) toggle; mirrors `uploadUseLegacy`. */
  useLegacy?: boolean
}

export interface CachedUploadResult extends UploadResult {
  /** True when the upload reused a cached entry instead of uploading again. */
  cached: boolean
  sha256: string
}

/**
 * Upload a media file, deduplicating by content hash. A cache hit returns the
 * previously uploaded `fileName`/`downloadUrl` without a network upload.
 */
export async function cachedUpload(options: CachedUploadOptions): Promise<CachedUploadResult> {
  await options.cache.load()
  const sha256 = sha256Hex(options.data)
  const hit = options.cache.get(sha256)
  if (hit !== undefined) {
    return {
      fileName: hit.fileName,
      ...(hit.downloadUrl !== undefined ? { downloadUrl: hit.downloadUrl } : {}),
      fileType: hit.fileType,
      cached: true,
      sha256,
    }
  }
  const upload: UploadFile = { name: options.name, data: options.data }
  const result = options.useLegacy === true
    ? await options.gateway.uploadLegacy(upload, options.fileType)
    : await options.gateway.uploadBinary(upload)
  options.cache.put({
    sha256,
    fileName: result.fileName,
    ...(result.downloadUrl !== undefined ? { downloadUrl: result.downloadUrl } : {}),
    fileType: options.fileType,
    uploadedAt: new Date().toISOString(),
  })
  await options.cache.save()
  return { ...result, cached: false, sha256 }
}
