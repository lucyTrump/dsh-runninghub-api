/** Config tests: the profile entry's form only serves fields the schema marks volatile. */

import { describe, expect, it } from 'vitest'
import { Config, RUNNINGHUB_NS } from '../src/settings.ts'

/** Every field of the entry config — the whole set the browser card reads or writes. */
const CARD_FIELDS = [
  'apiKey', 'apiKeyEnv', 'baseUrl', 'defaultWorkflowLabel', 'pollIntervalMs', 'runTimeoutMs',
  'queueTimeoutMs', 'maxConcurrentTasks', 'uploadUseLegacy', 'taskPanelEnabled', 'describeModel',
  'workflows',
]

/** The schema node shape the settings service walks (`dict` + per-field `meta`). */
interface Node {
  meta: { volatile?: boolean; role?: string }
  dict?: Record<string, Node>
}

const schema = Config as unknown as Node

describe('runninghub entry config', () => {
  it('is the profile entry id the card binds its form to', () => {
    expect(RUNNINGHUB_NS).toBe('runninghub')
  })

  // A field without `.volatile()` is stripped from the Host form: the card then
  // reads undefined forever and never becomes available — the whole section
  // disappears. This is the regression that hid the card.
  it('marks every card field volatile so the Host serves it as a live form', () => {
    const dict = schema.dict ?? {}
    expect(Object.keys(dict).sort()).toEqual([...CARD_FIELDS].sort())
    for (const field of CARD_FIELDS) {
      expect(dict[field]?.meta.volatile, `${field} must be .volatile()`).toBe(true)
    }
  })

  it('keeps the API key a redacted secret slot', () => {
    expect(schema.dict?.['apiKey']?.meta.role).toBe('secret')
  })
})
