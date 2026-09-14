/** Workflow mapping tests: api-format prompt → nodes/defaults/media slots. */

import { describe, expect, it } from 'vitest'
import { inferKind, parseWorkflowPrompt } from '../src/workflow.ts'

const PROMPT = JSON.stringify({
  '3': {
    class_type: 'CLIPTextEncode',
    _meta: { title: '正向提示词' },
    inputs: {
      text: 'a cat',
      clip: ['1', 0],
    },
  },
  '4': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 20, denoise: 0.8, model: ['2', 0] },
  },
  '5': {
    class_type: 'LoadImage',
    _meta: { title: '输入图片' },
    inputs: { image: 'example.png', upload: true },
  },
  '6': {
    class_type: 'LoadImageFromUrl',
    inputs: { url: 'https://example.com/in.png' },
  },
})

describe('inferKind', () => {
  it('maps value types to param kinds', () => {
    expect(inferKind(1)).toBe('number')
    expect(inferKind(true)).toBe('boolean')
    expect(inferKind('https://x')).toBe('url')
    expect(inferKind('plain')).toBe('text')
    expect(inferKind({ a: 1 })).toBe('json')
  })
})

describe('parseWorkflowPrompt', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseWorkflowPrompt('not json')).toThrow('not valid JSON')
  })

  it('collects every node with its class type and title', () => {
    const parsed = parseWorkflowPrompt(PROMPT)
    expect(parsed.nodes.map(n => n.nodeId).sort()).toEqual(['3', '4', '5', '6'])
    expect(parsed.nodes.find(n => n.nodeId === '3')?.title).toBe('正向提示词')
  })

  it('maps editable inputs to defaults, skipping ComfyUI links', () => {
    const parsed = parseWorkflowPrompt(PROMPT)
    const keys = parsed.nodeDefaults.map(p => `${p.nodeId}.${p.fieldName}`).sort()
    expect(keys).toEqual(['3.text', '4.denoise', '4.seed', '4.steps'])
    const seed = parsed.nodeDefaults.find(p => p.fieldName === 'seed')
    expect(seed?.kind).toBe('number')
    expect(seed?.fieldValue).toBe(42)
  })

  it('routes loader nodes to media slots instead of defaults', () => {
    const parsed = parseWorkflowPrompt(PROMPT)
    expect(parsed.mediaSlots).toHaveLength(2)
    const image = parsed.mediaSlots.find(s => s.nodeId === '5')
    expect(image).toMatchObject({ type: 'image', viaUrl: false, label: '输入图片', order: 0 })
    const fromUrl = parsed.mediaSlots.find(s => s.nodeId === '6')
    expect(fromUrl).toMatchObject({ type: 'image', viaUrl: true, order: 1 })
  })
})
