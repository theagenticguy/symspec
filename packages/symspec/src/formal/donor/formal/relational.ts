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
 * ## Two recognized shapes (both require a shared trigger — same context)
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
  /** Normalized trigger text; `''` when the requirement has no trigger. */
  readonly triggerKey: string
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
 * (system, non-empty trigger); within each group of ≥2, emits one finding
 * naming the participating ids when either recognized shape holds:
 *
 *   A. ≥2 members carry a numeric bound AND ≥1 of them has an unmatched atom;
 *   B. ≥2 members use inter-entity relational language.
 *
 * Deterministic and order-independent (ids sorted, groups keyed on the
 * normalized (system, trigger)). At most one finding per group.
 */
export function findRelationalUnchecked(
  inputs: readonly RelationalInput[],
): RelationalUncheckedFinding[] {
  const groups = new Map<string, RelationalInput[]>()
  for (const r of inputs) {
    if (r.triggerKey === '') continue // no shared context → nothing to co-constrain
    const key = `${normalize(r.systemName)}||${r.triggerKey}`
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [r])
    else g.push(r)
  }

  const findings: RelationalUncheckedFinding[] = []
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
    findings.push({ requirementIds: [...ids].sort() })
  }

  return findings
}
