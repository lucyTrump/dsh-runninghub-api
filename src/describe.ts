/** Parsing helpers for the LLM workflow-description answer (pure, unit-tested). */

/** Collapse the model's answer to one flat line within the hard length ceiling. */
export function normalizeDescription(text: string, zh: boolean): string {
  const limit = zh ? 120 : 240
  const flat = text.replace(/["'「『"']+$/u, '').replace(/^["'「『"']+/u, '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) : flat
}

/**
 * Keep the usage-notes section readable for a prompt: one bullet per line,
 * no wrapping prose, capped so a chatty model cannot bloat the settings file.
 */
export function normalizeUsageNote(text: string): string {
  const cleaned = text
    .split('\n')
    // Bullets and numbered lists are formatting; `4.aspect_ratio` is content.
    .map(line => line.replace(/^[\s\-*•]+/u, '').replace(/^\d+[.、)]\s+/u, '').replace(/\s+/gu, ' ').trim())
    .filter(line => line !== '' && !/^(无|none|n\/a)[.。]?$/i.test(line))
    .slice(0, 5)
  const out = cleaned.join('\n')
  return out.length > 240 ? out.slice(0, 240) : out
}

type Section = 'description' | 'attention' | 'note'

const SECTION_MARKER = /(描述|description|关注|attention|注意|note)\s*[:：]\s*/gi

function sectionKindOf(marker: string): Section {
  switch (marker.toLowerCase()) {
    case '关注':
    case 'attention':
      return 'attention'
    case '注意':
    case 'note':
      return 'note'
    default:
      return 'description'
  }
}

/**
 * Split the answer into its labelled sections. A marker may sit on its own line
 * OR be glued onto prose, so every section runs from its marker to the next one;
 * an answer with no marker at all stays a single description.
 */
function sectionsOf(text: string): { kind: Section; body: string }[] {
  const markers = [...text.matchAll(SECTION_MARKER)]
  if (markers.length === 0) return [{ kind: 'description', body: text }]
  return markers.map((marker, index) => ({
    kind: sectionKindOf(marker[1] ?? '描述'),
    body: text.slice((marker.index ?? 0) + marker[0].length, markers[index + 1]?.index ?? text.length),
  }))
}

/**
 * Parse the model's three-section answer (描述:/description: + 关注:/attention:
 * + 注意:/note:) into the catalog description, the proposed attention keys, and
 * the usage notes. Proposed keys are validated against the workflow's real
 * params so prose or hallucinated keys never mark anything.
 */
export function parseDescribeAnswer(
  text: string,
  validKeys: ReadonlySet<string>,
  zh: boolean,
): { description: string, attention: string[], usageNote: string } {
  const sections = sectionsOf(text)
  const sectionText = (kind: Section) => sections
    .filter(section => section.kind === kind)
    .map(section => section.body)
    .join('\n')
  const attention = sectionText('attention')
    .split(/[,，、;；\n]/)
    .map(key => key.trim())
    .filter(key => validKeys.has(key))
    .slice(0, 5)
  return {
    description: normalizeDescription(sectionText('description'), zh),
    attention,
    usageNote: normalizeUsageNote(sectionText('note')),
  }
}
