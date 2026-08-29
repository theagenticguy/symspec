/**
 * Relational / aggregate blind-spot detection (propose-only, demotion-only).
 *
 * ## The blind spot this discloses
 *
 * symspec's numeric tier is PAIRWISE and SAME-QUANTITY only: it proves a
 * conflict when two bounds land on one per-system quantity key. It has no theory
 * for the conflict families GitHub issue #2 enumerates:
 *
 *   1. aggregate / conservation — N disjoint reservations of one finite
 *      resource whose SUM exceeds capacity (each pair satisfiable);
 *   2. cross-quantity arithmetic — triangle inequality, `end = start + duration`,
 *      rate/efficiency cascades relating DISTINCT quantities;
 *   4. emergent structural impossibility — graph 2-coloring odd cycle,
 *      pigeonhole/cardinality, functional uniqueness, transitivity cycles.
 *
 * Reproducer (b) is family 4: five sensors in a ring, each required to differ
 * from its neighbor's channel, only two channels available — 2-coloring an odd
 * cycle, graph-theoretically impossible. All C(6,2) pairs are individually
 * satisfiable, so the pairwise tier reports `verified=true`.
 *
 * ## Why detect-and-demote, not solve
 *
 * These families are NOT soundly recoverable from natural language by a
 * deterministic extractor — "the channel of sensor two" is an inter-entity
 * reference the atomizer flattens to an opaque atom, and inferring the finite
 * resource / arithmetic relation would require guessing. Guessing violates the
 * sound-modulo-atomization contract (a fabricated constraint is a false
 * contradiction). The issue itself says: "the doctrine is right; `verified=true`
 * is a positive claim the aggregate/relational blind spot doesn't support."
 *
 * So this tier honors DEMOTION-ONLY: it recognizes the STRUCTURAL SHAPE where
 * such a conflict could hide and emits an info-tier `FND_RELATIONAL_UNCHECKED`
 * that DEMOTES `verified` (an honest "this reasoning was not attempted" caveat),
 * never a verdict. It cannot manufacture a false contradiction because it never
 * asserts one — it only declines to certify.
 *
 * ## Two recognized shapes (both require a shared guard — same context)
 *
 *   A. AGGREGATE: ≥2 same-trigger requirements each carry a numeric bound, and
 *      at least one of them has an unmatched (singleton) atom — the shape where
 *      per-requirement bounds on a shared resource never get summed.
 *   B. RELATIONAL: ≥2 same-trigger requirements use inter-entity comparison
 *      language ("differs from", "the same … as", "distinct from") — the shape
 *      where cardinality / graph-coloring / transitivity conflicts hide.
 *
 * Conservative by construction: it fires only on a shared non-empty trigger with
 * ≥2 participating requirements, so a lone relational requirement (nothing to
 * conflict with) stays silent.
 */

import { normalize } from './atomize.ts'

/** One requirement's projection for relational/aggregate shape detection. */
export interface RelationalInput {
  readonly id: string
  readonly systemName: string
  /**
   * Normalized guard context spanning BOTH EARS guard slots (precondition and
   * trigger); `''` when the requirement is wholly unguarded. Built by
   * `pipeline/check.ts`'s `guardKeyOf`, the same derivation
   * `findQuantityAliasCandidates` groups on, so the two co-liveness tiers agree
   * on what "the same context" means.
   */
  readonly guardKey: string
  /**
   * The raw guard slots, which this tier groups on directly.
   *
   * `guardKey` is retained because the finding's MESSAGE names the context it found, and because
   * `''` is still the "wholly unguarded, skip" signal. But grouping reads these, one group per
   * non-empty slot — see {@link findRelationalUnchecked} for why a discloser wants a coarser key
   * than the prover it shares `guardKeyOf` with.
   */
  readonly preCondition?: string | undefined
  readonly trigger?: string | undefined
  /** Raw response text (scanned for inter-entity relational language). */
  readonly responseText: string
  /** True when this requirement carries ≥1 numeric bound (from numeric.ts). */
  readonly hasNumericBound: boolean
  /** True when this requirement owns ≥1 singleton atom (uncompared surface). */
  readonly hasUnmatchedAtom: boolean
}

/** A propose-only relational-blind-spot finding (info; DEMOTES `verified`). */
export interface RelationalUncheckedFinding {
  readonly requirementIds: string[]
}

/**
 * Inter-entity comparison language: a requirement asserting a relation BETWEEN
 * two named entities/quantities ("differs from the channel of sensor two", "the
 * same rate as", "distinct from"). This is exactly the language the atomizer
 * flattens to an opaque atom, so the relation is invisible to the solver. Kept
 * deliberately specific to comparison-between-entities to avoid firing on every
 * requirement that happens to contain "from" or "same".
 */
const RELATIONAL_LANGUAGE =
  /\b(?:differ(?:s|ent)?|distinct|separate|unequal|not\s+equal)\s+(?:from|to|than)\b|\b(?:the\s+same|identical|equal)\b[\w\s]{0,40}\bas\b|\bmatch(?:es|ing)?\s+the\b|\b(?:greater|less|larger|smaller|higher|lower|more|fewer)\s+than\s+(?:the\b|that\b|its\b|sensor|node|item|the\s+\w+\s+of)\b/i

/** Does `text` assert a relation between two named entities? */
export function hasRelationalLanguage(text: string): boolean {
  return RELATIONAL_LANGUAGE.test(text)
}

/**
 * Find relational / aggregate blind-spot groups. Groups requirements by
 * (system, EACH non-empty guard slot); within each group of ≥2, emits one finding
 * naming the participating ids when either recognized shape holds:
 *
 *   A. ≥2 members carry a numeric bound AND ≥1 of them has an unmatched atom;
 *   B. ≥2 members use inter-entity relational language.
 *
 * Deterministic and order-independent (ids sorted, groups keyed on the
 * normalized (system, guard)). At most one finding per group.
 */
export function findRelationalUnchecked(
  inputs: readonly RelationalInput[],
): RelationalUncheckedFinding[] {
  const groups = new Map<string, RelationalInput[]>()
  for (const r of inputs) {
    // Unguarded requirements are excluded: this tier declines to certify a SHAPE,
    // and an always-on group is the one context whose members a reader can already
    // see co-occur. Skipping it is an under-demotion, the safe direction for a
    // tier that can only push `verified` false.
    if (r.guardKey === '') continue
    // ONE GROUP PER GUARD SLOT, not one per slot PAIR — and the direction is why.
    //
    // `guardKey` is `<pre>|<trigger>`, a composite the quantity-alias tier needs because THERE a
    // shared context feeds a committed alias and then a proof: a key that is too coarse
    // co-asserts guards no requirement declared together, which fabricates. Finer is safer for a
    // PROVER.
    //
    // This tier is a DISCLOSER. Its only output is an info finding and a demotion, so it can only
    // push `verified` toward false. For it the safe direction is exactly inverted: a key that is
    // too coarse over-discloses (harmless), while a key that is too FINE deletes a disclosure —
    // and deleting a demotion moves `verified` toward TRUE, which is the direction the
    // demotion-only doctrine forbids. Measured: sharing the composite key silently dropped
    // `FND_RELATIONAL_UNCHECKED` for two requirements that share a trigger and differ in
    // precondition, which is how a document the fabrication corpus files as a KNOWN open gap
    // acquired `verified: true` alongside two error-severity findings.
    //
    // So membership is per non-empty slot: a requirement with both slots joins both groups, and
    // two requirements sharing EITHER slot are considered co-live here. Strictly coarser than the
    // composite, therefore strictly more disclosure.
    for (const slot of [r.preCondition, r.trigger]) {
      if (slot === undefined || slot === '') continue
      const key = `${normalize(r.systemName)}||${normalize(slot)}`
      const g = groups.get(key)
      if (g === undefined) groups.set(key, [r])
      else g.push(r)
    }
  }

  const findings: RelationalUncheckedFinding[] = []
  const seen = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue

    // Shape A — aggregate: ≥2 numeric-bounded members, ≥1 with a singleton atom.
    const numericMembers = group.filter((r) => r.hasNumericBound)
    const aggregate = numericMembers.length >= 2 && numericMembers.some((r) => r.hasUnmatchedAtom)

    // Shape B — relational: ≥2 members with inter-entity comparison language.
    const relationalMembers = group.filter((r) => hasRelationalLanguage(r.responseText))
    const relational = relationalMembers.length >= 2

    if (!aggregate && !relational) continue

    // Name exactly the participating members for the shape(s) that fired.
    const ids = new Set<string>()
    if (aggregate) for (const r of numericMembers) ids.add(r.id)
    if (relational) for (const r of relationalMembers) ids.add(r.id)
    const sorted = [...ids].sort()
    // DEDUP by id set. Per-slot membership means a pair sharing BOTH slots is grouped twice, and
    // two findings naming one id set would double-count the same blind spot in `residualRisk`.
    const key = sorted.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({ requirementIds: sorted })
  }

  return findings
}
