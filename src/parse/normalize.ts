/**
 * Event synonyms + modal normalization + provenance (AC-2-3).
 *
 * Extracts, as a standalone hardened module, the two normalization concerns
 * AC-2-3 names as a single named, extensible resource:
 *
 *   1. **Event synonyms** — `upon`, `once`, `after`, `as soon as`,
 *      `on receipt of`, `whenever`, `in the event that` — all normalize to the
 *      canonical EARS keyword `when` (research-nlparse.md §1.2). `KW.when` in
 *      `tier1.ts` already accepts every one of these as leading alternatives in
 *      the cascade — that is what makes "Upon receipt of…" classify as
 *      `event-driven` — but the cascade never records *which* literal synonym
 *      fired. This module is that record: a pure lookup that reports the
 *      matched synonym, the canonical form it maps to, and a provenance note
 *      (`event-synonym:<slug>`) a caller can attach alongside Tier-1's own
 *      `notes` array.
 *   2. **Non-`shall` modals** — `must`, `will`, `should` — all normalize to the
 *      canonical modal `shall`, carrying the `nonstandard-modal` provenance
 *      note and a downgraded confidence floor of `medium` (research-nlparse.md
 *      §1.2; ISO 29148 modal-verb discipline). Tier-1's `buildResult` already
 *      applies this exact downgrade inline; {@link normalizeModal} is the
 *      extracted, independently-tested version of that rule, and the constants
 *      it exports (`NONSTANDARD_MODAL_NOTE`, `NONSTANDARD_MODAL_CONFIDENCE`)
 *      are the single source of truth both `tier1.ts` and this module agree on
 *      by convention.
 *
 * Neither function here rewrites text — the canonical `shall`/`when` form is
 * never spliced back into `systemResponse`/`trigger`/`preCondition`; the
 * response text following a modal or a leading keyword is emitted verbatim.
 * "Normalize to the canonical keyword/`shall` form" is satisfied at the
 * *pattern* and *rendering* layers instead: `patternType` is always one of the
 * 5 canonical EARS patterns regardless of which synonym matched (AC-1-3's
 * `renderSentence` always emits the literal word "shall"), and neither the
 * matched synonym nor the matched modal ever leaks into a slot value. This
 * module's job is strictly the *provenance* half of AC-2-3 — reporting which
 * non-canonical vocabulary fired and by how much confidence should drop.
 *
 * Scope boundary: this module does not (yet) wire into `tier1.ts`'s cascade —
 * matching the established pattern from T-AC-2-4 (`negation.ts`) and T-AC-2-5
 * (`preprocess.ts`), which likewise extracted hardened, independently-tested
 * pieces without rewiring the owned `tier1.ts` cascade. `tier1.ts` remains the
 * source of truth for END-TO-END classification behavior (its own `KW.when`
 * alternation and `nonstandard-modal` downgrade already satisfy AC-2-3's
 * stated verification cases); this module is the extensible, named lookup
 * table AC-4-2a's antonym-table sibling references, and the piece a future
 * wiring task (e.g. AC-2-8's `ParseResult` assembly) can attach richer
 * per-synonym provenance from.
 */

import type { Confidence } from './tier1.js'

/**
 * Event-driven keyword synonyms recognized in addition to the canonical
 * `when` (research-nlparse.md §1.2, AC-2-3). `whenever` is listed explicitly
 * because — despite sharing a stem with the canonical keyword — AC-2-3 names
 * it as its own normalization case, distinct from bare `when`.
 */
export const EVENT_SYNONYMS = [
  'upon',
  'once',
  'after',
  'as soon as',
  'on receipt of',
  'whenever',
  'in the event that',
] as const

export type EventSynonym = (typeof EVENT_SYNONYMS)[number]

/** The canonical EARS event keyword every synonym normalizes to. */
export const CANONICAL_EVENT_KEYWORD = 'when'

/** Provenance note prefix recorded when a leading keyword was a synonym, not the canonical keyword itself. */
const EVENT_SYNONYM_NOTE_PREFIX = 'event-synonym'

/**
 * Modal verbs accepted in the main clause besides the canonical `shall`
 * (research-nlparse.md §1.2, ISO 29148 modal-verb discipline, AC-2-3).
 */
export const NONSTANDARD_MODALS = ['must', 'will', 'should'] as const

export type NonstandardModal = (typeof NONSTANDARD_MODALS)[number]

/** The canonical EARS modal every non-standard modal normalizes to. */
export const CANONICAL_MODAL = 'shall'

/** Provenance note recorded when a non-`shall` modal is normalized (AC-2-3). */
export const NONSTANDARD_MODAL_NOTE = 'nonstandard-modal'

/** Confidence a nonstandard-modal parse is downgraded to — never upgraded (AC-2-3). */
export const NONSTANDARD_MODAL_CONFIDENCE: Confidence = 'medium'

/** Result of normalizing a leading event keyword via {@link normalizeEventKeyword}. */
export interface EventKeywordNormalization {
  /** Always {@link CANONICAL_EVENT_KEYWORD} — the keyword every match normalizes to. */
  canonical: typeof CANONICAL_EVENT_KEYWORD
  /** The literal keyword text that matched, lowercased and whitespace-collapsed. */
  matched: string
  /** The remainder of the input after the leading keyword, trimmed. */
  rest: string
  /**
   * Provenance note, present only when {@link matched} was a synonym rather
   * than the canonical keyword itself (omitted, not `undefined`, for a bare
   * `when` match — exactOptionalPropertyTypes).
   */
  note?: string
}

// Longest-first so multi-word phrases (`on receipt of`, `as soon as`,
// `in the event that`) are tried before any shorter alternative could
// otherwise claim a shared prefix; ties among single-word synonyms don't
// conflict since none is a prefix of another.
const EVENT_KEYWORDS_BY_LENGTH_DESC = [...EVENT_SYNONYMS, CANONICAL_EVENT_KEYWORD].sort(
  (a, b) => b.length - a.length,
)

const EVENT_KEYWORD_LEAD = new RegExp(
  `^(?<kw>${EVENT_KEYWORDS_BY_LENGTH_DESC.map((s) => s.replace(/\s+/g, '\\s+')).join('|')})\\b\\s*(?<rest>.*)$`,
  'i',
)

const EVENT_SYNONYM_SET: ReadonlySet<string> = new Set(EVENT_SYNONYMS)

/**
 * Detect and normalize a leading event keyword (canonical `when` or one of
 * {@link EVENT_SYNONYMS}) at the start of `input`, reporting a provenance note
 * when the match was a synonym. Returns `undefined` when no event keyword
 * leads the input.
 *
 * @example
 * normalizeEventKeyword('Upon receipt of a shutdown command')
 * // → { canonical: 'when', matched: 'upon', rest: 'receipt of a shutdown command', note: 'event-synonym:upon' }
 *
 * @example
 * normalizeEventKeyword('Whenever an error occurs')
 * // → { canonical: 'when', matched: 'whenever', rest: 'an error occurs', note: 'event-synonym:whenever' }
 *
 * @example
 * normalizeEventKeyword('When the door opens')
 * // → { canonical: 'when', matched: 'when', rest: 'the door opens' }  (already canonical — no note)
 */
export function normalizeEventKeyword(input: string): EventKeywordNormalization | undefined {
  const m = EVENT_KEYWORD_LEAD.exec(input.trim())
  if (!m?.groups?.kw) return undefined
  const matched = m.groups.kw.toLowerCase().replace(/\s+/g, ' ')
  const rest = (m.groups.rest ?? '').trim()
  const isSynonym = EVENT_SYNONYM_SET.has(matched)
  return {
    canonical: CANONICAL_EVENT_KEYWORD,
    matched,
    rest,
    ...(isSynonym ? { note: `${EVENT_SYNONYM_NOTE_PREFIX}:${matched.replace(/\s+/g, '-')}` } : {}),
  }
}

/** Result of normalizing a modal verb via {@link normalizeModal}. */
export interface ModalNormalization {
  /** Always {@link CANONICAL_MODAL} — the modal every match normalizes to. */
  canonical: typeof CANONICAL_MODAL
  /** The literal modal text that matched, lowercased. */
  matched: string
  /**
   * Provenance note, present only when {@link matched} was non-standard
   * (omitted, not `undefined`, for a canonical `shall` match —
   * exactOptionalPropertyTypes).
   */
  note?: string
  /**
   * Downgraded confidence floor, present only alongside {@link note}. Callers
   * combine this with the rung's base confidence via their own downgrade
   * ladder (never upgrade past this floor).
   */
  confidence?: Confidence
}

/**
 * Normalize a matched modal verb (`shall`, or one of {@link NONSTANDARD_MODALS})
 * to the canonical `shall` form, reporting a `nonstandard-modal` provenance
 * note and a downgraded confidence floor when the modal was not already
 * canonical.
 *
 * @example
 * normalizeModal('must')
 * // → { canonical: 'shall', matched: 'must', note: 'nonstandard-modal', confidence: 'medium' }
 *
 * @example
 * normalizeModal('shall')
 * // → { canonical: 'shall', matched: 'shall' }  (already canonical — no note, no downgrade)
 */
export function normalizeModal(modal: string): ModalNormalization {
  const matched = modal.trim().toLowerCase()
  if (matched === CANONICAL_MODAL) {
    return { canonical: CANONICAL_MODAL, matched }
  }
  return {
    canonical: CANONICAL_MODAL,
    matched,
    note: NONSTANDARD_MODAL_NOTE,
    confidence: NONSTANDARD_MODAL_CONFIDENCE,
  }
}
