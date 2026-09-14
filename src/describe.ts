/** Parsing helpers for the LLM workflow-description answer (pure, unit-tested). */

/** Collapse the model's answer to one flat line within the hard length ceiling. */
export function normalizeDescription(text: string, zh: boolean): string {
  const limit = zh ? 120 : 240
  const flat = text.replace(/["'「『"']+$/u, '').replace(/^["'「『"']+/u, '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) : flat
}

/**
 * Split the model's two-section answer (描述:/description: + 关注:/attention:).
 * The attention section starts at the first marker — on its own line OR glued
 * onto the description line — and runs to the end of the output; proposed keys
 * are validated against the workflow's real params so prose or hallucinated
 * keys never mark anything.
 */
export function parseDescribeAnswer(
  text: string,
  validKeys: ReadonlySet<string>,
  zh: boolean,
): { description: string, attention: string[] } {
  const marker = /(?:关注|attention)\s*[:：]\s*/i.exec(text)
  const descRaw = (marker === null ? text : text.slice(0, marker.index))
    .replace(/^\s*(?:描述|description)\s*[:：]\s*/i, '')
  const description = normalizeDescription(descRaw, zh)
  const attention = marker === null ? [] : text
    .slice(marker.index + marker[0].length)
    .split(/[,，、;；]/)
    .map(key => key.trim())
    .filter(key => validKeys.has(key))
    .slice(0, 5)
  return { description, attention }
}
