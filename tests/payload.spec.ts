/** Payload tests: nodeInfoList build, structural validation, override reconciliation. */

import { describe, expect, it } from 'vitest'
import { applyParamOverrides, buildNodeInfoList, buildWorkflowGraph, mediaSlotKeys, validateWorkflowDefinition } from '../src/payload.ts'
import type { WorkflowDefinition } from '../src/settings.ts'

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

  it('cuts unfilled media nodes, cleans links, clears ref_* inputs, keeps the main chain', () => {
    const out = parse(buildWorkflowGraph(def, [], def.mediaSlots))
    expect(out['102']).toBeUndefined()
    expect(out['106']).toBeUndefined()
    expect(out['105']!.inputs['audio']).toBeUndefined() // link to removed 106 cleaned
    expect(out['105']!.inputs['duration']).toBe(5)      // orphan intermediate stays
    expect(out['164']!.inputs['ref_images.ref_image_0']).toBeUndefined()
    expect(out['164']!.inputs['ref_audios.ref_audio_1']).toBeUndefined()
    expect(out['164']!.inputs['prompt']).toEqual(['121', 0])
    expect(out['73']!.inputs['latent_image']).toEqual(['164', 1]) // main chain intact
    expect(out['55']!.inputs['conditioning']).toEqual(['164', 0])
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
})
