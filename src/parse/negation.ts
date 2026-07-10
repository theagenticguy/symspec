/**
 * Modal-adjacent negation extraction (AC-2-4).
 *
 * When a requirement's main clause carries an explicit negator immediately
 * after the modal — `not`, `never`, or `not be able to` — symspec sets
 * `negated: true` and retains the POSITIVE response atom, so the formal tier
 * receives `¬R` on the SAME atom rather than a string containing "not".
 *
 * This is the load-bearing contract for atomization (AC-4-2a): the atom table
 * consumes the `negated` flag to emit `¬R` on the identical atom that the
 * un-negated form would produce. That is only sound if negation is stripped
 * here as a POLARITY FLAG, never folded into the response text and never
 * inverted lexically.
 *
 * Scope — explicit negation ONLY. The three negators above are grammatical,
 * modal-adjacent negation. Deeper *lexical* negation — "shall prevent X",
 * "shall reject X", "shall disable X" — is NOT handled here and MUST NOT be
 * inverted into a positive atom (research-nlparse.md §1.3, §1.6). Those verbs
 * are left verbatim for the AC-4-2a antonym table to unify at atom time
 * (`enable ↔ disable`, `grant ↔ revoke`, …). Inverting them here ("reject" →
 * `¬accept`) is too error-prone and would make Tier 1 unsound.
 *
 * Purity: {@link extractNegation} is a pure, deterministic function of its
 * input string — no I/O, no shared state — matching the atomize contract it
 * feeds.
 */

/**
 * The explicit modal-adjacent negators recognized by AC-2-4, in canonical form.
 * `not be able to` is a distinct phrase (not a synonym of bare `not`) so that
 * provenance can distinguish "shall not X" from "shall not be able to X".
 */
export const NEGATORS = ['not be able to', 'never', 'not'] as const

/** Canonical negator token attached to a negated result for provenance. */
export type Negator = (typeof NEGATORS)[number]

/**
 * A leading explicit negator, stripped to a polarity flag plus the positive
 * response atom. Alternation is ordered longest-first so `not be able to` wins
 * over bare `not`. `\b` after the negator keeps "notify"/"nevertheless"/
 * "notable" from being read as negation. A trailing `(?:\s+…)?$` requires the
 * negator to be a standalone token, not a prefix.
 */
const LEADING_NEGATOR = /^(?<neg>not\s+be\s+able\s+to|never|not)\b(?:\s+(?<rest>.+))?$/i

/** Result of {@link extractNegation}. */
export interface NegationResult {
  /** True when an explicit modal-adjacent negator led the response. */
  negated: boolean
  /**
   * The positive response atom. When {@link negated} is true the leading
   * negator has been stripped; otherwise this is the input, trimmed.
   */
  response: string
  /**
   * The matched negator, canonicalized. Present only when {@link negated} is
   * true (omitted, not `undefined`, otherwise — exactOptionalPropertyTypes).
   */
  negator?: Negator
}

/** Collapse internal whitespace so `not   be  able to` canonicalizes cleanly. */
function canonicalizeNegator(raw: string): Negator {
  const collapsed = raw.trim().replace(/\s+/g, ' ').toLowerCase()
  if (collapsed === 'not be able to') return 'not be able to'
  if (collapsed === 'never') return 'never'
  return 'not'
}

/**
 * Extract a leading explicit negator from a response clause (the text AFTER the
 * modal), returning a polarity flag and the positive response atom.
 *
 * The response passed in is the portion of the main clause following the modal
 * verb — e.g. from "the system shall not store plaintext", pass
 * `"not store plaintext"`. The returned `response` is the positive atom
 * (`"store plaintext"`) with `negated: true`.
 *
 * Only the three explicit negators of {@link NEGATORS} are recognized. Lexical
 * negation verbs ("prevent", "reject", "disable") are returned unchanged with
 * `negated: false`.
 *
 * @example
 * extractNegation('not store plaintext passwords')
 * // → { negated: true, response: 'store plaintext passwords', negator: 'not' }
 *
 * @example
 * extractNegation('never allow anonymous access')
 * // → { negated: true, response: 'allow anonymous access', negator: 'never' }
 *
 * @example
 * extractNegation('not be able to modify audit logs')
 * // → { negated: true, response: 'modify audit logs', negator: 'not be able to' }
 *
 * @example
 * extractNegation('reject expired tokens')
 * // → { negated: false, response: 'reject expired tokens' }  (lexical → antonym table)
 */
export function extractNegation(response: string): NegationResult {
  const trimmed = response.trim()
  const m = LEADING_NEGATOR.exec(trimmed)
  if (!m?.groups?.neg) {
    return { negated: false, response: trimmed }
  }
  const negator = canonicalizeNegator(m.groups.neg)
  const rest = m.groups.rest?.trim() ?? ''
  return { negated: true, response: rest, negator }
}
