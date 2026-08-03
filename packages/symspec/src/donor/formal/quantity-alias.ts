/**
 * Quantity-alias candidate detection (propose-only).
 *
 * ## The blind spot this closes
 *
 * The numeric tier (`numeric.ts` → `numeric-contradiction.ts`) proves a conflict
 * only when two bounds land on the SAME per-system quantity key. That key is
 * derived from the noun phrase immediately before the comparator, so the SAME
 * physical quantity described with two different verbs splits into two keys and
 * the joint bound is never seen:
 *
 *     "complete the infusion within at most 30 minutes"  → qty `complete_the_infusion`  (≤ 30 min)
 *     "run the infusion for at least 60 minutes"         → qty `run_the_infusion`        (≥ 60 min)
 *
 * ≤ 30 ∧ ≥ 60 on one duration is UNSAT, but the two keys never meet, so `check`
 * reported `verified=true` (GitHub issue #2, reproducer a).
 *
 * ## Why this is propose-only, not an automatic merge
 *
 * We must NOT strip the verb and force the two keys together: "transmit the
 * packet" and "receive the packet" also share the object "the packet" but are
 * genuinely different quantities — auto-merging them would MANUFACTURE a false
 * numeric contradiction. Whether two verb-phrasings name one physical quantity
 * is an authoring judgment, exactly like the paraphrase/opposition proposals
 * (`semantic.ts`). So this tier follows the same PROPOSE/DECIDE discipline:
 *
 *   - PROPOSE (here, deterministic + conservative): flag same-system,
 *     same-trigger numeric bounds whose quantity labels share a common object
 *     SUFFIX but differ in their leading verb, and whose comparators are
 *     directionally OPPOSED (one upper, one lower) in a comparable unit — the
 *     only shape that could be jointly unsatisfiable if unified. Emit an
 *     info-tier `FND_QUANTITY_ALIAS_CANDIDATE` carrying a ready-to-run
 *     `symspec glossary add` command. This DEMOTES `verified` (a possible
 *     numeric conflict went unexamined) but is never a verdict.
 *   - DECIDE (elsewhere, already built): if the author confirms the quantities
 *     are one, `symspec glossary add "<a>" "<b>"` commits the alias; `atomize`
 *     /`quantityKey` route both labels' normalized form to one canonical key, so
 *     the existing LIA tier compares the bounds and proves the conflict.
 *
 * ## High precision by design
 *
 * The common-suffix + differing-verb-prefix test is the specific signature of
 * "one quantity, two verbs". It deliberately does NOT fire on labels that share
 * a leading noun but differ in their tail ("account balance" vs "account age") —
 * those are distinct quantities that merely start the same, not a verb split.
 */

import { normalize } from './atomize.ts'
import type { NumericComparator } from './encode.ts'
import type { NumericPredicate } from './numeric.ts'

/** One requirement's numeric predicates + the context needed to group it. */
export interface QuantityAliasInput {
  readonly id: string
  /** Per-system scope (predicates already bake this into their quantity key). */
  readonly systemName: string
  /** Normalized trigger text; `''` when the requirement has no trigger. */
  readonly triggerKey: string
  readonly predicates: readonly NumericPredicate[]
}

/** A propose-only quantity-alias-candidate finding (info; DEMOTES `verified`). */
export interface QuantityAliasCandidateFinding {
  readonly code: 'FND_QUANTITY_ALIAS_CANDIDATE'
  readonly severity: 'info'
  /** The two requirement ids whose bounds might constrain one quantity. */
  readonly requirementIds: string[]
  readonly message: string
}

/** Tokens that are never the shared "object" of a quantity label. */
const LABEL_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'for',
  'by',
  'at',
  'in',
  'on',
  'with',
  'its',
  'their',
  // Comparator / bound words that the numeric keyer leaves ON the label when
  // they lead a compound bound ("complete the infusion WITHIN at most 30 min" →
  // label "infusion within"). We drop them HERE, in the propose-only matcher,
  // rather than in numeric.ts's KEY — stripping them from the sound key would
  // collapse phrasal-verb nouns ("carry OVER" vs "carry") and fabricate a false
  // contradiction. Dropping them only for object-suffix comparison is safe: this
  // tier can only DEMOTE + suggest a glossary alias, never assert a conflict.
  'within',
  'under',
  'over',
  'above',
  'below',
  'exceeding',
  'exceed',
])

/** Is `c` an upper bound (`<`, `<=`)? */
const isUpper = (c: NumericComparator): boolean => c === '<' || c === '<='
/** Is `c` a lower bound (`>`, `>=`)? */
const isLower = (c: NumericComparator): boolean => c === '>' || c === '>='

/**
 * Two comparators are directionally OPPOSED — the only shape that can be jointly
 * unsatisfiable once the two bounds share a quantity. An equality opposes any
 * strict bound in the other direction, and two opposed inequalities oppose. Two
 * same-direction bounds only TIGHTEN when unified (never conflict), so they are
 * not worth demoting `verified` over.
 */
function opposed(a: NumericComparator, b: NumericComparator): boolean {
  if (a === '=' || b === '=') return a !== b
  return (isUpper(a) && isLower(b)) || (isLower(a) && isUpper(b))
}

/** Split a quantity label into lowercased word tokens (drops articles/preps). */
function contentTokens(label: string): string[] {
  return normalize(label)
    .split('_')
    .filter((t) => t.length > 0 && !LABEL_STOPWORDS.has(t))
}

/**
 * The "one quantity, two verbs" signature: the two labels share a non-empty
 * common SUFFIX of content tokens (the object noun phrase) and each has a
 * non-empty, DIFFERING residual prefix (the leading verb). Returns the shared
 * object phrase (for the message) or null when the shape does not hold.
 */
function sharedObjectSuffix(labelA: string, labelB: string): string | null {
  const a = contentTokens(labelA)
  const b = contentTokens(labelB)
  if (a.length === 0 || b.length === 0) return null
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
  if (n === 0) return null // no shared object → not the same quantity
  const prefixA = a.slice(0, a.length - n)
  const prefixB = b.slice(0, b.length - n)
  // The two labels must DIFFER in their residual prefix (the verb/qualifier that
  // split one object into two keys). We do NOT require BOTH prefixes to be
  // non-empty: after dropping a leaked comparator word, one side can reduce to
  // the bare object ("infusion within" → ["infusion"]) while the other keeps its
  // verb ("run the infusion" → ["run","infusion"]) — that is exactly the
  // same-quantity-two-verbs shape reproducer (a) exhibits. Equal prefixes would
  // mean identical token lists (already keyed together by the numeric tier, and
  // the caller skips pa.quantity === pb.quantity anyway), so reject only that.
  if (prefixA.join('_') === prefixB.join('_')) return null
  return a.slice(a.length - n).join(' ')
}

/**
 * Find quantity-alias candidates across a set of requirements' numeric
 * predicates. Deterministic and conservative — a false negative (missed
 * suggestion) is preferred over a false positive that nags the author. Emits at
 * most one finding per requirement pair (the first opposed, object-sharing bound
 * pair found), keyed by sorted id pair so the output is order-independent.
 */
export function findQuantityAliasCandidates(
  inputs: readonly QuantityAliasInput[],
): QuantityAliasCandidateFinding[] {
  const findings: QuantityAliasCandidateFinding[] = []
  const emittedPairs = new Set<string>()

  for (let i = 0; i < inputs.length; i += 1) {
    for (let j = i + 1; j < inputs.length; j += 1) {
      const ra = inputs[i]!
      const rb = inputs[j]!
      if (ra.id === rb.id) continue
      // Same context: same system and the SAME non-empty trigger. Requirements
      // under different triggers do not co-occur, so their bounds cannot form a
      // single-quantity conflict worth surfacing.
      if (ra.systemName !== rb.systemName) continue
      if (ra.triggerKey === '' || ra.triggerKey !== rb.triggerKey) continue

      const pairKey = [ra.id, rb.id].sort().join('|')
      if (emittedPairs.has(pairKey)) continue

      let hit: { pa: NumericPredicate; pb: NumericPredicate; object: string } | null = null
      for (const pa of ra.predicates) {
        for (const pb of rb.predicates) {
          // Already the same quantity → the numeric tier handles it; skip.
          if (pa.quantity === pb.quantity) continue
          // Comparable unit: both unitless or the same normalized base. A time
          // bound and a byte bound are genuinely different quantities.
          if (pa.baseUnit !== pb.baseUnit) continue
          if (!opposed(pa.comparator, pb.comparator)) continue
          const object = sharedObjectSuffix(pa.label, pb.label)
          if (object === null) continue
          hit = { pa, pb, object }
          break
        }
        if (hit !== null) break
      }
      if (hit === null) continue

      emittedPairs.add(pairKey)
      const [loId, hiId] = [ra.id, rb.id].sort() as [string, string]
      const { pa, pb, object } = hit
      // Deterministic canonical/alias order for the suggested command.
      const [labelLo, labelHi] = [pa.label, pb.label].sort() as [string, string]
      findings.push({
        code: 'FND_QUANTITY_ALIAS_CANDIDATE',
        severity: 'info',
        requirementIds: [loId, hiId],
        message:
          `${loId} and ${hiId} place opposed numeric bounds (${pa.sourceText} vs ${pb.sourceText}) ` +
          `under the same system and trigger, on quantities that share the object "${object}" but ` +
          `differ in their leading verb ("${pa.label}" vs "${pb.label}"), so they atomized to ` +
          'different quantity keys and were never compared. If both bounds constrain the SAME ' +
          `physical quantity, run \`symspec glossary add "${labelLo}" "${labelHi}"\` so the numeric ` +
          'tier keys them together and can prove any conflict, then re-run `symspec check`. If they ' +
          'are genuinely different quantities, waive this finding. This is a suggestion, not a verdict.',
      })
    }
  }

  return findings
}
