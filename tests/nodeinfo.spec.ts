/** object_info enrichment tests: registry widget types correct inferred kinds. */

import { describe, expect, it } from 'vitest'
import { enrichNodeDefaults, inputMetaFor, ObjectInfoCache, type ObjectInfoRegistry } from '../src/nodeinfo.ts'
import type { NodeParamOverride } from '../src/settings.ts'

const REGISTRY: ObjectInfoRegistry = {
  KSampler: {
    input: {
      required: {
        seed: ['INT', { min: 0, max: 2 ** 63, step: 1 }],
        steps: ['INT', { min: 1, max: 150 }],
        denoise: ['FLOAT', { min: 0, max: 1, step: 0.01 }],
        sampler_name: [['dpmpp_2m', 'euler', 'ddim'], {}],
      },
    },
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }] } },
  },
  ImageResize: {
    input: { required: { megapixels: ['FLOAT', { min: 0.01, max: 16, step: 0.05 }] } },
  },
  ResolutionSelector: {
    input: { required: { aspect_ratio: ['COMBO', { options: ['1:1 (Square)', '16:9 (Widescreen)', '9:16 (Portrait Widescreen)'] }] } },
  },
}

const classOf = new Map([
  ['3', 'KSampler'],
  ['6', 'CLIPTextEncode'],
  ['93', 'ImageResize'],
])

describe('inputMetaFor', () => {
  it('maps INT/FLOAT/STRING and combo choices with bounds', () => {
    expect(inputMetaFor(REGISTRY, 'KSampler', 'seed')).toMatchObject({ kind: 'int', min: 0 })
    expect(inputMetaFor(REGISTRY, 'KSampler', 'denoise')).toMatchObject({ kind: 'float', step: 0.01 })
    expect(inputMetaFor(REGISTRY, 'CLIPTextEncode', 'text')).toEqual({ kind: 'text' })
    expect(inputMetaFor(REGISTRY, 'KSampler', 'sampler_name')).toMatchObject({
      kind: 'select',
      options: ['dpmpp_2m', 'euler', 'ddim'],
    })
  })

  it('returns undefined for unknown classes, fields, and link types', () => {
    expect(inputMetaFor(REGISTRY, 'Nope', 'x')).toBeUndefined()
    expect(inputMetaFor(REGISTRY, 'KSampler', 'model')).toBeUndefined()
  })

  // Regression: RunningHub's registry now spells combos the ComfyUI V3 way;
  // missing this turned every enum into a free-text box.
  it('reads ComfyUI V3 combos (["COMBO", { options }]) as a select', () => {
    expect(inputMetaFor(REGISTRY, 'ResolutionSelector', 'aspect_ratio')).toMatchObject({
      kind: 'select',
      options: ['1:1 (Square)', '16:9 (Widescreen)', '9:16 (Portrait Widescreen)'],
    })
    expect(inputMetaFor(REGISTRY, 'ResolutionSelector', 'nope')).toBeUndefined()
  })

  // Both registry generations must keep working: a RunningHub deploy that rolls
  // back (or a cached older registry) still has to yield dropdowns.
  it('keeps the legacy combo shape, bounds included', () => {
    const legacy: ObjectInfoRegistry = {
      Old: {
        input: {
          required: {
            mode: [['fast', 'slow'], { min: 0, max: 2, step: 1 }],
            scale: [[1, 2, 4], {}],
          },
        },
      },
    }
    expect(inputMetaFor(legacy, 'Old', 'mode')).toEqual({ kind: 'select', options: ['fast', 'slow'], min: 0, max: 2, step: 1 })
    expect(inputMetaFor(legacy, 'Old', 'scale')).toEqual({ kind: 'select', options: ['1', '2', '4'] })
  })

  it('tolerates the V3 spelling variants and falls back to inference when unusable', () => {
    const newStyle: ObjectInfoRegistry = {
      New: {
        input: {
          required: {
            lower: ['combo', { options: ['a'] }],
            bare: ['COMBO', ['a', 'b']],
            empty: ['COMBO', { options: [] }],
            optionless: ['COMBO', {}],
          },
        },
      },
    }
    expect(inputMetaFor(newStyle, 'New', 'lower')).toEqual({ kind: 'select', options: ['a'] })
    expect(inputMetaFor(newStyle, 'New', 'bare')).toEqual({ kind: 'select', options: ['a', 'b'] })
    expect(inputMetaFor(newStyle, 'New', 'empty')).toBeUndefined()
    expect(inputMetaFor(newStyle, 'New', 'optionless')).toBeUndefined()
  })
})

describe('enrichNodeDefaults', () => {
  const defaults: NodeParamOverride[] = [
    { nodeId: '3', fieldName: 'denoise', fieldValue: 1, kind: 'number' },
    { nodeId: '93', fieldName: 'megapixels', fieldValue: 1, kind: 'number' },
    { nodeId: '6', fieldName: 'text', fieldValue: 'hi', kind: 'text' },
    { nodeId: '3', fieldName: 'custom_widget', fieldValue: 5, kind: 'number' },
  ]

  it('corrects int-looking floats and keeps values untouched', () => {
    const enriched = enrichNodeDefaults(defaults, classOf, REGISTRY)
    expect(enriched[0]).toMatchObject({ kind: 'float', fieldValue: 1, step: 0.01 })
    expect(enriched[1]).toMatchObject({ kind: 'float', fieldValue: 1, min: 0.01, max: 16 })
    expect(enriched[2]).toMatchObject({ kind: 'text' })
    // Registry-unknown fields keep their inferred kind.
    expect(enriched[3]).toMatchObject({ kind: 'number' })
  })

  it('passes defaults through when the registry is unavailable', () => {
    expect(enrichNodeDefaults(defaults, classOf, undefined)).toBe(defaults)
  })
})

describe('ObjectInfoCache', () => {
  it('caches within the TTL and dedupes inflight fetches', async () => {
    let fetches = 0
    const cache = new ObjectInfoCache(60_000)
    const fetch = async () => {
      fetches++
      return REGISTRY
    }
    const [a, b] = await Promise.all([cache.get(fetch), cache.get(fetch)])
    expect(a).toBe(REGISTRY)
    expect(b).toBe(REGISTRY)
    expect(fetches).toBe(1)
    expect(await cache.get(fetch)).toBe(REGISTRY)
    expect(fetches).toBe(1)
  })

  it('returns undefined on fetch failure and retries next time', async () => {
    let fetches = 0
    const cache = new ObjectInfoCache(60_000)
    expect(await cache.get(async () => {
      fetches++
      throw new Error('boom')
    })).toBeUndefined()
    expect(await cache.get(async () => {
      fetches++
      return REGISTRY
    })).toBe(REGISTRY)
    expect(fetches).toBe(2)
  })

  it('refetches after the TTL expires', async () => {
    let fetches = 0
    const cache = new ObjectInfoCache(-1)
    await cache.get(async () => {
      fetches++
      return REGISTRY
    })
    await cache.get(async () => {
      fetches++
      return REGISTRY
    })
    expect(fetches).toBe(2)
  })
})
