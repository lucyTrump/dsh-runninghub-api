/**
 * ComfyUI node-registry (`/proxy/{apiKey}/object_info`) enrichment.
 *
 * The api-format workflow JSON carries raw values only — `denoise: 1` gives no
 * hint that the widget is a FLOAT. The registry is the authoritative type
 * source (the same one the RunningHub web editor uses): each class's
 * `input.required`/`input.optional` maps a field name to `[type, options]`,
 * where `type` is a string like `INT`/`FLOAT`/`STRING`/`BOOLEAN`, or an array
 * of choices for a combo dropdown.
 */

import type { NodeParamOverride } from './settings.ts'

/** Registry shape we consume (per class type). */
export interface ObjectInfoClass {
  input?: {
    required?: Record<string, unknown>
    optional?: Record<string, unknown>
  }
}

export type ObjectInfoRegistry = Record<string, ObjectInfoClass>

/** Widget metadata resolved from the registry for one input field. */
export interface NodeInputMeta {
  kind: NodeParamOverride['kind']
  options?: string[]
  min?: number
  max?: number
  step?: number
}

/** Look up one input's registry metadata. */
export function inputMetaFor(
  registry: ObjectInfoRegistry,
  classType: string,
  fieldName: string,
): NodeInputMeta | undefined {
  const input = registry[classType]?.input
  const spec = input?.required?.[fieldName] ?? input?.optional?.[fieldName]
  if (!Array.isArray(spec) || spec.length === 0) return undefined
  const [type, opts] = spec as [unknown, unknown]
  const bounds = boundsOf(opts)

  // Combo: the first tuple element is the choice list.
  if (Array.isArray(type)) {
    const options = type.map(choice => String(choice))
    return options.length > 0 ? { kind: 'select', options, ...bounds } : undefined
  }
  switch (String(type).toUpperCase()) {
    case 'INT':
      return { kind: 'int', ...bounds }
    case 'FLOAT':
      return { kind: 'float', ...bounds }
    case 'BOOLEAN':
      return { kind: 'boolean', ...bounds }
    case 'STRING':
      return { kind: 'text' }
    default:
      // IMAGE/MODEL/custom link types: not editable scalars — keep inference.
      return undefined
  }
}

/** min/max/step live on the spec's second tuple element. */
function boundsOf(opts: unknown): { min?: number; max?: number; step?: number } {
  if (typeof opts !== 'object' || opts === null) return {}
  const record = opts as Record<string, unknown>
  return {
    ...(typeof record.min === 'number' ? { min: record.min } : {}),
    ...(typeof record.max === 'number' ? { max: record.max } : {}),
    ...(typeof record.step === 'number' ? { step: record.step } : {}),
  }
}

/**
 * Rewrite inferred defaults with registry metadata. A field the registry does
 * not know keeps its inferred kind (custom nodes may be absent upstream).
 * @param defaults - defaults parsed from the workflow prompt.
 * @param classOf - nodeId → class_type lookup from the same parse.
 * @param registry - the object_info registry, when it could be fetched.
 * @returns enriched defaults (same array untouched when no registry).
 */
export function enrichNodeDefaults(
  defaults: NodeParamOverride[],
  classOf: ReadonlyMap<string, string>,
  registry: ObjectInfoRegistry | undefined,
): NodeParamOverride[] {
  if (registry === undefined) return defaults
  return defaults.map((param) => {
    const classType = classOf.get(param.nodeId)
    if (classType === undefined) return param
    const meta = inputMetaFor(registry, classType, param.fieldName)
    if (meta === undefined) return param
    return { ...param, kind: meta.kind, ...stripUndefined(meta) }
  })
}

function stripUndefined(meta: NodeInputMeta): Partial<NodeParamOverride> {
  const out: Partial<NodeParamOverride> = {}
  if (meta.options !== undefined) out.options = meta.options
  if (meta.min !== undefined) out.min = meta.min
  if (meta.max !== undefined) out.max = meta.max
  if (meta.step !== undefined) out.step = meta.step
  return out
}

/**
 * In-memory object_info cache. The registry weighs ~37 MB and changes only
 * when RunningHub deploys node updates, so one TTL'd copy per process is the
 * ceiling — ponytail: memory-only; persist gzipped to disk if cold-start
 * fetch latency ever matters.
 */
export class ObjectInfoCache {
  private entry: { at: number; registry: ObjectInfoRegistry } | undefined
  private inflight: Promise<ObjectInfoRegistry | undefined> | undefined

  constructor(private readonly ttlMs = 30 * 60_000) {}

  /** Get the cached registry, refetching when stale; undefined on failure. */
  async get(fetch: () => Promise<ObjectInfoRegistry>): Promise<ObjectInfoRegistry | undefined> {
    if (this.entry !== undefined && Date.now() - this.entry.at < this.ttlMs) return this.entry.registry
    this.inflight ??= fetch()
      .then((registry) => {
        this.entry = { at: Date.now(), registry }
        return registry
      })
      .catch(() => undefined)
      .finally(() => { this.inflight = undefined })
    return this.inflight
  }
}
