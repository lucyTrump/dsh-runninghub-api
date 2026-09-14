/** Auto-detect media attached to the current user message and read its bytes via `ctx.attachments`. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** One media attachment from the current user message. */
export interface MediaAsset {
  kind: 'image' | 'file'
  name?: string
  ref: ImageAttachmentRef | FileAttachmentRef
}

/**
 * Enumerate the image/file blocks of the current human message (the last
 * `role === 'user'` message whose `source.kind === 'user'`). Tool results and
 * plugin context are also `role: 'user'` but carry a different `source.kind`.
 */
export function collectCurrentMedia(agent: Agent | undefined): MediaAsset[] {
  if (agent === undefined) return []
  const messages = agent.session.deriveMessages()
  const current = [...messages].reverse().find(message => message.role === 'user' && message.source.kind === 'user')
  if (current === undefined) return []
  const assets: MediaAsset[] = []
  for (const block of current.content) {
    if (block.type === 'image') {
      assets.push({ kind: 'image', ...(block.attachment.name !== undefined ? { name: block.attachment.name } : {}), ref: block.attachment })
    } else if (block.type === 'file') {
      assets.push({ kind: 'file', ...(block.attachment.name !== undefined ? { name: block.attachment.name } : {}), ref: block.attachment })
    }
  }
  return assets
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Read one media asset's verbatim bytes (image or file) through the attachment store. */
export async function readMediaBytes(ctx: Context, asset: MediaAsset, signal?: AbortSignal): Promise<Uint8Array> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('attachment store unavailable (load @deepseek-ai/dsh-attachment + an implementation)')
  if (asset.kind === 'image') {
    const stored = await attachments.readImage(asset.ref as ImageAttachmentRef, signal)
    return stored.data
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of attachments.readFileStream(asset.ref as FileAttachmentRef, signal)) {
    chunks.push(chunk)
  }
  return concat(chunks)
}

export type { AttachmentStore }
