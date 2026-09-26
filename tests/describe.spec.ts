import { describe, expect, it } from 'vitest'
import { normalizeDescription, normalizeUsageNote, parseDescribeAnswer } from '../src/describe.ts'

const VALID = new Set(['3.text', '5.seed'])

describe('parseDescribeAnswer', () => {
  it('parses the three-line contract', () => {
    const out = parseDescribeAnswer('描述：图像生成：文字变插画。输入：提示词；输出：图片。\n关注：3.text, 5.seed', VALID, true)
    expect(out).toEqual({
      description: '图像生成：文字变插画。输入：提示词；输出：图片。',
      attention: ['3.text', '5.seed'],
      usageNote: '',
    })
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
    expect(out).toEqual({ description: 'text to image. input: prompt; output: image.', attention: [], usageNote: '' })
  })

  it('yields an empty description for an attention-only answer', () => {
    expect(parseDescribeAnswer('关注：3.text', VALID, true).description).toBe('')
  })

  it('reads the usage notes and keeps attention from swallowing them', () => {
    const out = parseDescribeAnswer(
      '描述：图像编辑：多图重绘。\n关注：3.text\n注意：- 4.aspect_ratio 竖版只能填 9:16 (Portrait Widescreen)\n- 需要 instanceType: plus',
      VALID,
      true,
    )
    expect(out.attention).toEqual(['3.text'])
    expect(out.usageNote).toBe('4.aspect_ratio 竖版只能填 9:16 (Portrait Widescreen)\n需要 instanceType: plus')
  })

  it('treats「无」as no note', () => {
    expect(parseDescribeAnswer('描述：x。\n注意：无', VALID, true).usageNote).toBe('')
    expect(parseDescribeAnswer('描述：x。\n注意：无。\n注意：4.aspect_ratio 只能填合法值', VALID, true).usageNote).toBe('4.aspect_ratio 只能填合法值')
  })
})

describe('normalizeDescription', () => {
  it('flattens whitespace and enforces the ceiling', () => {
    expect(normalizeDescription('a\nb  c', true)).toBe('a b c')
    expect(normalizeDescription('字'.repeat(200), true)).toHaveLength(120)
    expect(normalizeDescription('x'.repeat(300), false)).toHaveLength(240)
  })
})

describe('normalizeUsageNote', () => {
  it('flattens bullets, drops blanks, and caps at five lines', () => {
    expect(normalizeUsageNote('- a\n\n* b\n  1. c ')).toBe('a\nb\nc')
    expect(normalizeUsageNote('1. a\n2. b\n3. c\n4. d\n5. e\n6. f').split('\n')).toHaveLength(5)
    expect(normalizeUsageNote('x'.repeat(400))).toHaveLength(240)
  })
})
