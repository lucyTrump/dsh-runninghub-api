import { describe, expect, it } from 'vitest'
import { normalizeDescription, parseDescribeAnswer } from '../src/describe.ts'

const VALID = new Set(['3.text', '5.seed'])

describe('parseDescribeAnswer', () => {
  it('parses the two-line contract', () => {
    const out = parseDescribeAnswer('描述：图像生成：文字变插画。输入：提示词；输出：图片。\n关注：3.text, 5.seed', VALID, true)
    expect(out).toEqual({ description: '图像生成：文字变插画。输入：提示词；输出：图片。', attention: ['3.text', '5.seed'] })
  })

  it('handles the marker glued onto the description line', () => {
    const out = parseDescribeAnswer('描述：图像生成：文字变插画。关注：3.text', VALID, true)
    expect(out.description).toBe('图像生成：文字变插画。')
    expect(out.attention).toEqual(['3.text'])
  })

  it('drops hallucinated keys and caps at five', () => {
    const out = parseDescribeAnswer('描述：x。\n关注：3.text, 9.nope, 5.seed', VALID, true)
    expect(out.attention).toEqual(['3.text', '5.seed'])
  })

  it('parses answers without an attention section', () => {
    const out = parseDescribeAnswer('description: text to image. input: prompt; output: image.', VALID, false)
    expect(out).toEqual({ description: 'text to image. input: prompt; output: image.', attention: [] })
  })

  it('yields an empty description for an attention-only answer', () => {
    expect(parseDescribeAnswer('关注：3.text', VALID, true).description).toBe('')
  })
})

describe('normalizeDescription', () => {
  it('flattens whitespace and enforces the ceiling', () => {
    expect(normalizeDescription('a\nb  c', true)).toBe('a b c')
    expect(normalizeDescription('字'.repeat(200), true)).toHaveLength(120)
    expect(normalizeDescription('x'.repeat(300), false)).toHaveLength(240)
  })
})
