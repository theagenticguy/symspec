/**
 * The pure EARS sentence renderer.
 *
 * ## Ported verbatim (behavior), retyped (surface)
 *
 * The five EARS templates and the `negated` polarity rule are the donor's
 * `src/core/render.ts` byte-for-byte in their OUTPUT: the same clause order, the
 * same punctuation, the same `While <pre>, when <trigger>, …` combination case.
 * The document format changed in v5; the sentences it renders did not, which is
 * what lets the donor's fixtures and the import round-trip compare rendered text
 * across the two implementations.
 *
 * ## Why `sentence` is stored at all
 *
 * It is a DENORMALIZED view, never authored directly: reviewers scan a document
 * as prose, and a stored sentence makes `git diff` on a requirements file
 * readable without a tool. Every write path re-renders it from the slots, so the
 * slots stay the single source of truth and the stored text cannot drift — the
 * one exception being a hand-edited file, which `import` and the store disclose
 * rather than silently rewrite.
 *
 * Pure: no I/O, no clock, no mutation of its argument.
 */

import type { EarsPattern } from './document.ts'

/** The slot subset {@link renderSentence} reads. Deliberately narrower than a
 * full requirement so the parse tier (G2) can render a partial before a
 * requirement exists. */
export interface SentenceSlots {
  readonly patternType: EarsPattern
  readonly preCondition?: string | undefined
  readonly trigger?: string | undefined
  readonly systemName: string
  readonly systemResponse: string
  readonly negated?: boolean | undefined
}

/**
 * Render the canonical EARS sentence from its structured slots.
 *
 * Response polarity: `negated: true` renders `shall not <systemResponse>` while
 * leaving `systemResponse` itself POSITIVE. That is what lets `shall X` and
 * `shall not X` share one atom at opposite polarity so the formal tier (G2) sees
 * them as contradictory rather than as two different strings.
 */
export const renderSentence = (r: SentenceSlots): string => {
  const shall = r.negated === true ? 'shall not' : 'shall'
  const resp = `the ${r.systemName} ${shall} ${r.systemResponse}`
  switch (r.patternType) {
    case 'ubiquitous':
      return `The ${r.systemName} ${shall} ${r.systemResponse}.`
    case 'event-driven':
      return r.preCondition !== undefined && r.preCondition !== ''
        ? `While ${r.preCondition}, when ${r.trigger ?? ''}, ${resp}.`
        : `When ${r.trigger ?? ''}, ${resp}.`
    case 'state-driven':
      return `While ${r.preCondition ?? ''}, ${resp}.`
    case 'optional-feature':
      return `Where ${r.preCondition ?? ''}, ${resp}.`
    case 'unwanted-behavior':
      return `If ${r.trigger ?? ''}, then ${resp}.`
  }
}
