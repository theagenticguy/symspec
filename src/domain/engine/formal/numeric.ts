/**
 * Numeric-predicate extraction for the arithmetic conflict tier (AC-30-2).
 *
 * The SMT tier is propositional: "temperature above 40" and "temperature below
 * 30" become two opaque Boolean atoms that never conflict. This module lifts
 * numeric predicates out of EARS slot text into typed
 * `(quantity, comparator, value, unit)` tuples so the encoder (AC-30-1) can emit
 * a `cmp` node over a shared per-quantity Real variable, and Z3 can prove
 * `temp >= 40 ∧ temp < 30` UNSAT — naming the culprit requirement ids.
 *
 * ## Two things that MUST be right or numeric conflicts silently escape
 *
 *  1. **Quantity identity.** "temperature", "the temperature", "temp" must map
 *     to ONE canonical quantity key, scoped per system (mirroring AC-4-2a atom
 *     scoping — two systems' "latency" are distinct quantities). Otherwise the
 *     two predicates land on different Real variables and never meet.
 *  2. **Unit normalization.** "within 2 s" and "at most 200 ms" are about the
 *     same quantity in different units; both normalize to a canonical base
 *     (ms) before comparison, or a real conflict (2000 ms vs 200 ms) is missed.
 *
 * ## Deterministic + conservative
 *
 * Extraction is pure regex/lexicon — no model, no guessing. A slot with no
 * recognizable numeric predicate yields `[]`. This mirrors the parse ladder's
 * "return a structured nothing rather than a low-confidence guess" discipline:
 * a missed extraction is a false negative (the honest failure direction), never
 * a fabricated constraint.
 */

import { normalize } from './atomize.ts'
import type { NumericComparator } from './encode.ts'

/** A numeric predicate extracted from one slot, normalized to a base unit. */
export interface NumericPredicate {
  /** Canonical per-system quantity key, e.g. `sys__auth__qty__latency`. */
  readonly quantity: string
  /** Human quantity label (for evidence), e.g. `latency`. */
  readonly label: string
  readonly comparator: NumericComparator
  /** Value normalized into `baseUnit` (e.g. seconds → ms). */
  readonly value: number
  /** The canonical base unit the value was normalized to (`''` if unitless). */
  readonly baseUnit: string
  /** The original slot substring the predicate came from (evidence). */
  readonly sourceText: string
}

/**
 * A unit dimension: a base unit and the multiplicative factor from each known
 * alias INTO the base. All values normalize to the base before comparison.
 */
export interface Dimension {
  readonly base: string
  /** alias (lowercased) → factor to multiply a value in that alias to get base. */
  readonly units: Readonly<Record<string, number>>
}

/**
 * Known unit dimensions. Extend conservatively; unknown units stay unitless.
 * Exported so the manifest can surface the numeric tier's recognized units (an
 * agent authoring bounds sees exactly which unit spellings normalize to a
 * shared base before comparison).
 */
export const DIMENSIONS: readonly Dimension[] = [
  {
    base: 'ms',
    units: {
      ms: 1,
      millisecond: 1,
      milliseconds: 1,
      s: 1000,
      sec: 1000,
      secs: 1000,
      second: 1000,
      seconds: 1000,
      m: 60_000,
      min: 60_000,
      mins: 60_000,
      minute: 60_000,
      minutes: 60_000,
      h: 3_600_000,
      hr: 3_600_000,
      hrs: 3_600_000,
      hour: 3_600_000,
      hours: 3_600_000,
    },
  },
  {
    base: 'B',
    units: {
      b: 1,
      byte: 1,
      bytes: 1,
      kb: 1000,
      kib: 1024,
      mb: 1_000_000,
      mib: 1_048_576,
      gb: 1_000_000_000,
      gib: 1_073_741_824,
    },
  },
]

/** Map a lowercased unit token to its dimension + factor, or null if unknown. */
function resolveUnit(unit: string): { base: string; factor: number } | null {
  const u = unit.toLowerCase()
  for (const dim of DIMENSIONS) {
    const factor = dim.units[u]
    if (factor !== undefined) return { base: dim.base, factor }
  }
  return null
}

/**
 * Comparator lexicon. Each phrasing maps to the comparator it asserts on the
 * quantity. "within/under/at most/no more than/below" are upper bounds; "at
 * least/over/above/no less than" are lower bounds; "exactly" is equality.
 * Longer phrases are matched first (see COMPARATOR_PATTERNS ordering).
 */
const COMPARATOR_LEXICON: ReadonlyArray<{ phrase: string; comparator: NumericComparator }> = [
  { phrase: 'no more than', comparator: '<=' },
  { phrase: 'no less than', comparator: '>=' },
  { phrase: 'at most', comparator: '<=' },
  { phrase: 'at least', comparator: '>=' },
  { phrase: 'less than or equal to', comparator: '<=' },
  { phrase: 'greater than or equal to', comparator: '>=' },
  { phrase: 'less than', comparator: '<' },
  { phrase: 'greater than', comparator: '>' },
  { phrase: 'not exceeding', comparator: '<=' },
  { phrase: 'not exceed', comparator: '<=' },
  { phrase: 'exceeding', comparator: '>' },
  { phrase: 'exceed', comparator: '>' },
  { phrase: 'within', comparator: '<=' },
  { phrase: 'under', comparator: '<' },
  { phrase: 'below', comparator: '<' },
  { phrase: 'over', comparator: '>' },
  { phrase: 'above', comparator: '>' },
  { phrase: 'exactly', comparator: '=' },
  { phrase: 'equal to', comparator: '=' },
]

/** Number token: integer or decimal, optional thousands separators stripped. */
const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)`
/** Unit token: a short alphabetic run (ms, s, kb, retries handled as unitless). */
const UNIT = '([a-zA-Z]+)?'

/**
 * Normalize a quantity label into a canonical, per-system atom-style key.
 *
 * #3 (same-quantity-two-ways): before keying, the label is optionally routed
 * through a quantity-alias map — the committed synonym glossary, keyed by the
 * label's normalized form. This is what lets two responses that constrain the
 * SAME physical quantity through different phrasings ("token lifetime" via "keep
 * valid for" vs "expire after") land on ONE quantity key so the existing LIA/LRA
 * solver sees them together. Reuses the propose/decide discipline: the glossary
 * is the agent-confirmed, committed artifact; nothing fuzzy touches the key. A
 * no-op when no alias map is supplied or the label is not an alias, so the
 * default numeric path is byte-identical to before.
 *
 * SOUNDNESS: the key deliberately does NOT include `baseUnit`. A quantity key
 * names the *thing* bounded ("respond"), while `baseUnit` names the scale its
 * value was normalized onto; the two are separate facts and the key must keep
 * naming only the first. Comparability is a property of a PAIR of predicates, so
 * the unit belongs in the comparison partition, not the identity: see
 * `numeric-contradiction.ts` (`comparisonKey`), which groups on
 * `(quantity, baseUnit)` so a unitless bound is never compared against a united
 * one — and `quantity-alias.ts`, which skips a pair whose `baseUnit` differs.
 * Folding the unit in here would also rename the `quantity` in every emitted
 * `evidence.numeric` block and every SMT-LIB2 Real const, changing observable
 * output for genuine same-unit conflicts that were always correct.
 */
function quantityKey(
  systemName: string,
  label: string,
  quantityAliases?: ReadonlyMap<string, string>,
): string {
  const sys = systemName.trim().toLowerCase().replace(/\s+/g, '_')
  // Canonicalize the label through the alias map first (keyed on the same
  // `normalize` form the glossary index uses), then fall through to the
  // existing atom-style normalization so a non-aliased label keys exactly as
  // before.
  const canonicalLabel = quantityAliases?.get(normalize(label)) ?? label
  const q = canonicalLabel
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `sys__${sys}__qty__${q}`
}

/**
 * Candidate quantity label: the noun-ish phrase that owns the numeric bound.
 * We look immediately BEFORE the comparator phrase (e.g. "response latency
 * within 200 ms" → "response latency"). Kept deliberately shallow — a few
 * trailing words — because over-broad capture would split identical quantities.
 */
function labelBefore(text: string, comparatorStart: number): string | null {
  const before = text.slice(0, comparatorStart).trim()
  if (before === '') return null
  // Take up to the last 3 alphabetic words as the quantity label.
  let words = before.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w))
  if (words.length === 0) return null
  // Strip TRAILING prepositions/fillers so "respond in", "respond in no" and
  // "respond" all normalize to the same quantity — otherwise a unit/phrasing
  // variant splits one quantity into several and a real conflict escapes.
  const TRAILING_FILLER = new Set([
    'in',
    'of',
    'to',
    'for',
    'by',
    'at',
    'a',
    'an',
    'the',
    'no',
    'with',
    'be',
    'is',
    'are',
  ])
  // SOUNDNESS: we deliberately do NOT strip trailing comparator words (within/
  // under/over/above/below/exceeding) from the quantity KEY. There is no
  // syntactic way to tell a LEAKED compound-bound word ("complete the infusion
  // WITHIN at most 30 min") from a phrasal-verb noun tail ("the carry OVER at
  // least 100 mb", "the roll OVER", "the turn OVER") — both are
  // [word][comparator][number]. Stripping unconditionally collapsed "carry over"
  // and "carry" onto ONE key and fabricated a false FND_NUMERIC_CONTRADICTION
  // (the cardinal sin: a false positive in the decide tier). So the key stays
  // conservative; the SAME-QUANTITY-TWO-VERBS case (reproducer a) is instead
  // surfaced by the PROPOSE-ONLY quantity-alias detector (quantity-alias.ts),
  // where lenient object-matching is sound because it can only DEMOTE and
  // suggest a glossary alias — never assert a contradiction.
  while (words.length > 1 && TRAILING_FILLER.has(words[words.length - 1]!.toLowerCase())) {
    words = words.slice(0, -1)
  }
  const tail = words.slice(-3).join(' ')
  // Strip leading verb-ish stopwords so "shall respond with latency" → "latency".
  return tail.replace(/^(?:shall|be|is|are|the|a|an|with|of|to|have|has)\s+/i, '').trim() || null
}

/**
 * Extract every numeric predicate in one slot text, scoped to `systemName`.
 * Returns `[]` when no numeric predicate is present. Deterministic.
 *
 * `quantityAliases` (#3): an optional NORMALIZED label → canonical-label map
 * (built from the committed glossary, same shape as the atom glossary index) so
 * two phrasings of one physical quantity collapse to a single quantity key and
 * the arithmetic solver compares them. Omitted ⇒ unchanged behavior.
 */
export function extractNumericPredicates(
  text: string,
  systemName: string,
  quantityAliases?: ReadonlyMap<string, string>,
): NumericPredicate[] {
  const out: NumericPredicate[] = []
  const lower = text.toLowerCase()
  // Character ranges already consumed by a matched comparator phrase, so a
  // SHORTER phrase ("less than") can't re-match inside a longer one already
  // claimed ("no less than"). COMPARATOR_LEXICON lists longer phrases first.
  const claimed: Array<[number, number]> = []
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && s < end)

  for (const { phrase, comparator } of COMPARATOR_LEXICON) {
    let searchFrom = 0
    // Find each occurrence of this comparator phrase followed by a number.
    for (;;) {
      const idx = lower.indexOf(phrase, searchFrom)
      if (idx === -1) break
      searchFrom = idx + phrase.length
      if (overlaps(idx, idx + phrase.length)) continue

      // Match "<phrase> <number><unit?>" allowing filler words between.
      const after = text.slice(idx + phrase.length)
      const m = new RegExp(String.raw`^\s+(?:[a-zA-Z]+\s+){0,2}${NUMBER}\s*${UNIT}`).exec(after)
      if (m === null) continue
      const end = idx + phrase.length + m[0].length
      // Overlap must be checked over the FULL match range, not just the phrase:
      // in a compound bound like "within at most 30 minutes", the outer phrase
      // ("within") sits BEFORE the inner one ("at most") — its phrase span does
      // not overlap, but the filler-word allowance lets it re-claim the SAME
      // "30 minutes" the inner comparator already claimed. Without this, one
      // bound yields two predicates on two bogus quantity keys and a real
      // conflict escapes. COMPARATOR_LEXICON lists the tighter phrases first, so
      // the inner comparator claims the number and the outer preposition is
      // correctly dropped here (and stripped from the label as trailing filler).
      if (overlaps(idx, end)) continue
      claimed.push([idx, end])

      const rawValue = Number(m[1]!.replace(/,/g, ''))
      if (!Number.isFinite(rawValue)) continue
      const rawUnit = m[2] ?? ''
      const resolved = rawUnit !== '' ? resolveUnit(rawUnit) : null

      const label = labelBefore(text, idx)
      if (label === null) continue

      const value = resolved !== null ? rawValue * resolved.factor : rawValue
      const baseUnit = resolved !== null ? resolved.base : ''

      out.push({
        quantity: quantityKey(systemName, label, quantityAliases),
        label,
        comparator,
        value,
        baseUnit,
        sourceText: text.slice(idx, idx + phrase.length + (m[0]?.length ?? 0)).trim(),
      })
    }
  }

  return dedupe(out)
}

/** Drop exact-duplicate predicates (same quantity+comparator+value+unit). */
function dedupe(preds: NumericPredicate[]): NumericPredicate[] {
  const seen = new Set<string>()
  const out: NumericPredicate[] = []
  for (const p of preds) {
    const key = `${p.quantity}|${p.comparator}|${p.value}|${p.baseUnit}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}
