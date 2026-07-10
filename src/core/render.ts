/**
 * Pure EARS sentence renderer (AC-1-3).
 *
 * The EARS domain model is 5 pattern types (`ubiquitous`, `event-driven`,
 * `state-driven`, `optional-feature`, `unwanted-behavior`) built from the 5
 * slots `patternType, preCondition, trigger, systemName, systemResponse`. The
 * canonical `sentence` field is ALWAYS rendered from those slots by
 * {@link renderSentence} — it is never authored directly. Callers (the
 * Change-record mutation path in `changes.ts`) re-run this renderer whenever an
 * EARS slot changes and skip it for metadata-only edits (AC-1-6's five-way
 * re-render gate). The combined "While P, when T, …" case renders when an
 * event-driven requirement also carries a precondition.
 *
 * Pure: no I/O, no randomness, no mutation of its argument. Depends only on
 * the `Requirement`/EARS types in `schema.ts`, never the other direction —
 * this keeps the renderer safely importable from anywhere (CLI, parse tier,
 * tests) without pulling in Zod, storage, or the Change API.
 */

import type { Requirement } from './schema.js'

/**
 * Render an EARS sentence from its structured slots. Follows Mavin's
 * templates; pre-condition + trigger combine via "While <pre>, when
 * <trigger>, ...".
 *
 * Response polarity: when `negated` is true (AC-2-4, the parse-time / create
 * `--negated` flag), the modal renders `shall not <systemResponse>`. The
 * `systemResponse` slot itself stays POSITIVE — negation is never baked into
 * the stored text — so `shall X` and `shall not X` differ only by this flag.
 * A plain `ReqView`/partial slot object without `negated` renders positively.
 */
export function renderSentence(
  r: Pick<
    Requirement,
    'patternType' | 'preCondition' | 'trigger' | 'systemName' | 'systemResponse'
  > & { negated?: boolean },
): string {
  const shall = r.negated === true ? 'shall not' : 'shall'
  const resp = `the ${r.systemName} ${shall} ${r.systemResponse}`
  switch (r.patternType) {
    case 'ubiquitous':
      return `The ${r.systemName} ${shall} ${r.systemResponse}.`
    case 'event-driven':
      return r.preCondition
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
