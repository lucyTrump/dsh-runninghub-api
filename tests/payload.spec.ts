/** Payload tests: nodeInfoList build, structural validation, override reconciliation. */

import { describe, expect, it } from 'vitest'
import { applyParamOverrides, buildNodeInfoList, buildWorkflowGraph, carryUserMarks, describeParamConstraints, findIllegalComboValues, formatComboOptions, mediaSlotKeys, validateWorkflowDefinition } from '../src/payload.ts'
import type { ObjectInfoRegistry } from '../src/nodeinfo.ts'
import type { MediaSlot, NodeParamOverride, WorkflowDefinition } from '../src/settings.ts'

const base: WorkflowDefinition = {
  label: 'demo',
  workflowId: '42',
  nodeDefaults: [
    { nodeId: '3', fieldName: 'text', fieldValue: 'a cat', kind: 'text' },
    { nodeId: '4', fieldName: 'seed', fieldValue: 42, kind: 'number' },
    { nodeId: '4', fieldName: 'steps', kind: 'number', required: true },
    { nodeId: '5', fieldName: 'ckpt', kind: 'text' },
  ],
  mediaSlots: [
    { nodeId: '6', fieldName: 'image', label: '输入图片', order: 0, type: 'image', required: true },
    { nodeId: '7', fieldName: 'audio', label: '音频', order: 1, type: 'audio' },
  ],
}

describe('buildNodeInfoList', () => {
  it('drops empty defaults and keeps filled ones in order', () => {
    const list = buildNodeInfoList(base)
    expect(list).toEqual([
      { nodeId: '3', fieldName: 'text', fieldValue: 'a cat' },
      { nodeId: '4', fieldName: 'seed', fieldValue: 42 },
    ])
  })
})

describe('validateWorkflowDefinition', () => {
  it('reports missing required params, required media, and optional empties', () => {
    const result = validateWorkflowDefinition(base)
    expect(result.ok).toBe(false)
    expect(result.missingParams).toEqual(['4.steps'])
    expect(result.requiredMedia).toEqual(['6.image (image)'])
    expect(result.optionalEmpty).toEqual(['5.ckpt'])
  })

  it('is ok once every required param has a value', () => {
    const filled: WorkflowDefinition = {
      ...base,
      nodeDefaults: base.nodeDefaults.map(p => p.fieldName === 'steps' ? { ...p, fieldValue: 20 } : p),
    }
    expect(validateWorkflowDefinition(filled).ok).toBe(true)
  })
})

describe('applyParamOverrides', () => {
  it('overwrites matching defaults and appends unknown ones', () => {
    const next = applyParamOverrides(base, [
      { nodeId: '3', fieldName: 'text', fieldValue: 'a dog', kind: 'text' },
      { nodeId: '9', fieldName: 'extra', fieldValue: true, kind: 'boolean' },
    ])
    expect(next.nodeDefaults.find(p => p.nodeId === '3')?.fieldValue).toBe('a dog')
    expect(next.nodeDefaults.find(p => p.nodeId === '9')?.fieldValue).toBe(true)
    expect(base.nodeDefaults.find(p => p.nodeId === '3')?.fieldValue).toBe('a cat')
  })
})

describe('mediaSlotKeys', () => {
  it('keys every media slot', () => {
    expect(mediaSlotKeys(base)).toEqual(['6\u0000image', '7\u0000audio'])
  })
})

describe('findIllegalComboValues', () => {
  const RATIOS = ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)']
  const registry: ObjectInfoRegistry = {
    ResolutionSelector: { input: { required: { aspect_ratio: ['COMBO', { options: RATIOS }] } } },
  }
  const def = (aspectRatio: unknown): WorkflowDefinition => ({
    label: 'qwen',
    workflowId: '2102365430202585090',
    prompt: JSON.stringify({
      '4': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)' } },
    }),
    // Saved before the COMBO fix: inferred as text, no options stored.
    nodeDefaults: [{ nodeId: '4', fieldName: 'aspect_ratio', fieldValue: aspectRatio as never, kind: 'text' }],
    mediaSlots: [],
  })

  it('flags the value RunningHub would only reject after a paid task', () => {
    const found = findIllegalComboValues(def('9:16 (Portrait)'), registry)
    expect(found).toEqual([{ nodeId: '4', fieldName: 'aspect_ratio', value: '9:16 (Portrait)', options: RATIOS }])
  })

  it('accepts a legal value and stays quiet without a registry', () => {
    expect(findIllegalComboValues(def('9:16 (Portrait Widescreen)'), registry)).toEqual([])
    expect(findIllegalComboValues(def('9:16 (Portrait)'))).toEqual([])
  })

  it('uses the choices a previous enrichment stored, and skips non-strings', () => {
    const { prompt: _noPrompt, ...storedBase } = def('euler')
    const stored: WorkflowDefinition = {
      ...storedBase,
      nodeDefaults: [{ nodeId: '3', fieldName: 'sampler_name', fieldValue: 'euler', kind: 'select', options: ['euler', 'ddim'] }],
    }
    expect(findIllegalComboValues(stored)).toEqual([])
    expect(findIllegalComboValues({ ...stored, nodeDefaults: [{ nodeId: '3', fieldName: 'sampler_name', fieldValue: 'nope', kind: 'select', options: ['euler', 'ddim'] }] }))
      .toHaveLength(1)
    expect(findIllegalComboValues({ ...stored, nodeDefaults: [{ nodeId: '4', fieldName: 'megapixels', fieldValue: 2, kind: 'float' }] })).toEqual([])
  })

  it('truncates long choice lists for prompts', () => {
    expect(formatComboOptions(['a', 'b', 'c'], 2)).toBe('a, b … (3 total)')
    expect(formatComboOptions(['a', 'b'], 2)).toBe('a, b')
  })

  it('hands the description model the registry\'s own enum values', () => {
    const text = describeParamConstraints(def('16:9 (Widescreen)'), registry)
    expect(text).toContain('#4 aspect_ratio: one of [1:1 (Square), 9:16 (Portrait Widescreen), 16:9 (Widescreen)]')
    expect(describeParamConstraints(def('x'))).toBe('')
  })

  // The proxy's registry lists whatever models sit on *its* folder — a saved
  // checkpoints name absent from it still runs, so file combos are not enums.
  it('never rejects or quotes a model-file combo', () => {
    const files: ObjectInfoRegistry = {
      UNETLoader: { input: { required: { unet_name: ['COMBO', { options: ['flux1-dev-fp8.safetensors'] }] } } },
    }
    const def: WorkflowDefinition = {
      label: 'qwen',
      workflowId: '1',
      prompt: JSON.stringify({ '56': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_bf16.safetensors' } } }),
      nodeDefaults: [{ nodeId: '56', fieldName: 'unet_name', fieldValue: 'qwen_image_2.1_bf16.safetensors', kind: 'text' }],
      mediaSlots: [],
    }
    expect(findIllegalComboValues(def, files)).toEqual([])
    expect(describeParamConstraints(def, files)).toBe('')
  })
})

describe('buildWorkflowGraph', () => {
  // MiniMax-like graph: 164 consumes a direct LoadImage ref and a LoadAudio
  // through a ZNGB_AudioCrop intermediate; 73 is the main-chain sampler.
  const graph = {
    '55': { class_type: 'BasicGuider', inputs: { model: ['174', 0], conditioning: ['164', 0] } },
    '56': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
    '73': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['56', 0], guider: ['55', 0], latent_image: ['164', 1] } },
    '102': { class_type: 'LoadImage', inputs: { image: 'big-sheet.png' } },
    '105': { class_type: 'ZNGB_AudioCrop', inputs: { audio: ['106', 0], duration: 5 } },
    '106': { class_type: 'LoadAudio', inputs: { audio: 'voice.mp3' } },
    '121': { class_type: 'Text', inputs: { text: 'hello' } },
    '164': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: { prompt: ['121', 0], 'ref_images.ref_image_0': ['102', 0], 'ref_audios.ref_audio_1': ['105', 0], length: 124 },
    },
    '174': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'x.safetensors', strength_model: 1 } },
  }
  const def: WorkflowDefinition = {
    label: 'g',
    workflowId: '1',
    prompt: JSON.stringify(graph),
    nodeDefaults: [
      { nodeId: '121', fieldName: 'text', fieldValue: 'a pig flies', kind: 'text' },
      { nodeId: '164', fieldName: 'length', fieldValue: 124, kind: 'int' },
    ],
    mediaSlots: [
      { nodeId: '102', fieldName: 'image', label: 'img', order: 0, type: 'image' },
      { nodeId: '106', fieldName: 'audio', label: 'aud', order: 1, type: 'audio' },
    ],
  }
  const parse = (json: string) => JSON.parse(json) as Record<string, { inputs: Record<string, unknown> }>

  it('cuts unfilled media nodes and the intermediates left without input, keeps the main chain', () => {
    const out = parse(buildWorkflowGraph(def, [], def.mediaSlots))
    expect(out['102']).toBeUndefined()
    expect(out['106']).toBeUndefined()
    expect(out['105']).toBeUndefined() // only ever fed by the removed 106
    expect(out['164']!.inputs['ref_images.ref_image_0']).toBeUndefined()
    expect(out['164']!.inputs['ref_audios.ref_audio_1']).toBeUndefined()
    expect(out['164']!.inputs['prompt']).toEqual(['121', 0])
    expect(out['73']!.inputs['latent_image']).toEqual(['164', 1]) // main chain intact
    expect(out['55']!.inputs['conditioning']).toEqual(['164', 0])
  })

  // Regression: a cut LoadImage once left `easy imageScaleDownToSize` behind
  // without its required `images` input → "Required input is missing".
  it('cuts a two-hop LoadImage chain but spares the consumer that still has inputs', () => {
    const qwen = {
      '20': { class_type: 'LoadImage', inputs: { image: 'sheet.png' } },
      '21': { class_type: 'easy imageScaleDownToSize', inputs: { images: ['20', 0], size: 1024 } },
      '6': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['13', 0], text: 'hi', 'images.image_1': ['21', 0] } },
      '13': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors' } },
    }
    const cutSlot = { nodeId: '20', fieldName: 'image', label: 'img', order: 0, type: 'image' as const }
    const out = parse(buildWorkflowGraph({ ...def, prompt: JSON.stringify(qwen) }, [], [cutSlot]))
    expect(out['20']).toBeUndefined()
    expect(out['21']).toBeUndefined() // dead weight: nothing left to scale
    expect(out['6']!.inputs['images.image_1']).toBeUndefined()
    expect(out['6']!.inputs['clip']).toEqual(['13', 0])
    expect(out['6']!.inputs['text']).toBe('hi')
  })

  it('writes supplied media into the Load node and cuts only the unfilled slot', () => {
    const out = parse(buildWorkflowGraph(def, [{ nodeId: '102', fieldName: 'image', fieldValue: 'api/x.png' }], [def.mediaSlots[1]!]))
    expect(out['102']!.inputs['image']).toBe('api/x.png')
    expect(out['164']!.inputs['ref_images.ref_image_0']).toEqual(['102', 0])
    expect(out['106']).toBeUndefined()
    expect(out['164']!.inputs['ref_audios.ref_audio_1']).toBeUndefined()
  })

  it('bakes param defaults (with overrides merged) into node inputs', () => {
    const merged = applyParamOverrides(def, [{ nodeId: '164', fieldName: 'length', fieldValue: 200, kind: 'int' }])
    const out = parse(buildWorkflowGraph(merged, [], []))
    expect(out['121']!.inputs['text']).toBe('a pig flies')
    expect(out['164']!.inputs['length']).toBe(200)
    expect(out['102']!.inputs['image']).toBe('big-sheet.png') // untouched slot
  })

  // Regression (多图编辑minimax): `easy imageScaleDownToSize` also takes `size`
  // from a shared Int, so "no links left" never fires — it survived with its
  // required `images` gone → "Required input is missing".
  it('cuts a scale node that kept only its shared `size` link, spares optional consumers', () => {
    const minimax = {
      '86': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      '126': { class_type: 'Int', inputs: { value: 1024 } },
      '88': { class_type: 'easy imageScaleDownToSize', inputs: { mode: true, images: ['86', 0], size: ['126', 0] } },
      '77': {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: { clip: ['49', 0], prompt: ['53', 0], ref_image_size: 'max', length: 5, 'ref_images.ref_image_0': ['88', 0] },
      },
      '49': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors' } },
      '53': { class_type: 'CR Text', inputs: { text: 'hi' } },
      '54': { class_type: 'VAEDecode', inputs: { samples: ['45', 0] } },
      '45': { class_type: 'KSampler', inputs: { seed: 1, latent_image: ['77', 1] } },
    }
    const registry: ObjectInfoRegistry = {
      'easy imageScaleDownToSize': { input: { required: { images: [], size: [], mode: [] } } },
      // `ref_images` is optional here: losing it must NOT delete the consumer.
      MiniMaxH3ReferenceToVideo: { input: { required: { clip: [], prompt: [], ref_image_size: [], length: [] }, optional: { ref_images: [] } } },
      VAEDecode: { input: { required: { samples: [] } } },
      KSampler: { input: { required: { seed: [], latent_image: [] } } },
    }
    const cutSlot = { nodeId: '86', fieldName: 'image', label: 'img', order: 0, type: 'image' as const }
    const out = parse(buildWorkflowGraph({ ...def, prompt: JSON.stringify(minimax) }, [], [cutSlot], registry))
    expect(out['86']).toBeUndefined()
    expect(out['88']).toBeUndefined() // kept `size`, still unusable → gone
    expect(out['77']!.inputs['ref_images.ref_image_0']).toBeUndefined()
    expect(out['77']!.inputs['prompt']).toEqual(['53', 0]) // optional loss, node keeps running
    expect(out['45']!.inputs['latent_image']).toEqual(['77', 1])
  })

  it('is conservative without a registry: only the link-only rule applies', () => {
    const graph = {
      '86': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      '126': { class_type: 'Int', inputs: { value: 1024 } },
      '88': { class_type: 'easy imageScaleDownToSize', inputs: { mode: true, images: ['86', 0], size: ['126', 0] } },
    }
    const cutSlot = { nodeId: '86', fieldName: 'image', label: 'img', order: 0, type: 'image' as const }
    const out = parse(buildWorkflowGraph({ ...def, prompt: JSON.stringify(graph) }, [], [cutSlot]))
    expect(out['88']).toBeDefined()
  })
})

describe('carryUserMarks', () => {
  it('keeps ★ attention / * required / labels across a refresh', () => {
    const previous: NodeParamOverride[] = [
      { nodeId: '4', fieldName: 'aspect_ratio', fieldValue: '1:1', kind: 'select' as const, label: '画幅', required: true, attention: true },
      { nodeId: '9', fieldName: 'gone', fieldValue: 1, kind: 'number' as const, attention: true },
    ]
    const refreshed: NodeParamOverride[] = [
      { nodeId: '4', fieldName: 'aspect_ratio', fieldValue: '1:1', kind: 'select' as const, options: ['1:1', '9:16'] },
      { nodeId: '5', fieldName: 'new', fieldValue: 2, kind: 'number' as const },
    ]
    expect(carryUserMarks(previous, refreshed)).toEqual([
      { nodeId: '4', fieldName: 'aspect_ratio', fieldValue: '1:1', kind: 'select', options: ['1:1', '9:16'], label: '画幅', required: true, attention: true },
      { nodeId: '5', fieldName: 'new', fieldValue: 2, kind: 'number' },
    ])
  })

  it('keeps a refreshed media slot title over the stored label', () => {
    const previous: MediaSlot[] = [{ nodeId: '6', fieldName: 'image', label: '我的图', order: 0, type: 'image', attention: true }]
    const refreshed: MediaSlot[] = [{ nodeId: '6', fieldName: 'image', label: '加载图像', order: 0, type: 'image' }]
    expect(carryUserMarks(previous, refreshed)).toEqual([
      { nodeId: '6', fieldName: 'image', label: '加载图像', order: 0, type: 'image', attention: true },
    ])
  })
})
