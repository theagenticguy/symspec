/**
 * Subsumption and redundancy over pairwise candidates (AC-4-5).
 *
 * Given the candidate pairs from the pairwise filter (AC-3-4) and the pure
 * encodings (AC-4-2), this module decides, per pair, whether one requirement's
 * behaviour logically implies the other's:
 *
 *   - one direction valid  → `FND_SUBSUMPTION` (directional)
 *   - both directions valid → `FND_REDUNDANCY` (logical duplicate)
 *   - neither / inconclusive → no finding
 *
 * ## The pinned direction (a subtle hazard worth stating)
 *
 * A subsumption direction MUST be decided by *which SMT implication is valid*
 * (`bodyA ⇒ bodyB` vs `bodyB ⇒ bodyA`) and mapped back to the actual
 * requirement ids — never assigned positionally from whichever slot (`a` or
 * `b`) the requirement happened to occupy in the candidate pair. `moreGeneral`
 * is always the id on the implied side, `moreSpecific` the id on the implying
 * side, regardless of pair ordering.
 *
 * So `moreGeneral`/`moreSpecific` are populated from the direction of the valid
 * implication (AC-4-5): `moreGeneral` is the requirement whose formula logically
 * implies the other's — equivalently the one that fires in the SUPERSET of
 * cases. A tautology anchors the mapping: for a broad `X ⇒ Y` (event-driven) and
 * a narrow `(P ∧ X) ⇒ Y` (complex), `(X⇒Y) ⇒ ((P∧X)⇒Y)` is valid, so the broad
 * requirement is `moreGeneral`. `subsumption.test.ts` pins this by putting the
 * general requirement in the pair's `b` slot, where a positional assignment
 * would be provably wrong.
 *
 * ## Why BODIES, not guarded formulas
 *
 * The encoder's `.formula` is `guard ⇒ body`, where `guard` is a fresh per-req
 * assumption literal (needed for unsat-core naming in contradiction, AC-4-4).
 * `formulaA ⇒ formulaB` with two distinct free guard literals is never valid, so
 * subsumption compares `.body` (`context ⇒ response`) directly — matching
 * research-smt.md §1.4's `(=> X Y)` vs `(=> (and P X) Y)` shapes.
 *
 * ## Purity boundary
 *
 * The module is atomizer-agnostic: it consumes {@link EncodedRequirement}s
 * (produced by the pure {@link encode}) and a {@link Z3Context}, and touches the
 * solver only through {@link materialize}. It never imports `atomize.ts` or
 * `z3-solver` directly.
 */

import type { CandidatePair } from '../solvers/types.js'
import type { Z3Context } from './backend.js'
import { type EncodedRequirement, type Formula, materialize, not } from './encode.js'

/** A directional subsumption finding (Appendix B `FND_SUBSUMPTION`, warn). */
export interface SubsumptionFinding {
  code: 'FND_SUBSUMPTION'
  severity: 'warn'
  /** The requirement whose formula implies the other's (fires in the superset of cases). */
  moreGeneral: string
  /** The narrower requirement (fires in the subset of cases). */
  moreSpecific: string
  /** Both ids, order-stable as `[a, b]` from the candidate pair, for reporting. */
  requirementIds: [string, string]
  message: string
}

/** A bi-implication finding (Appendix B `FND_REDUNDANCY`, warn). */
export interface RedundancyFinding {
  code: 'FND_REDUNDANCY'
  severity: 'warn'
  requirementIds: [string, string]
  message: string
}

/** What a single pair check can yield. */
export type SubsumptionResult = SubsumptionFinding | RedundancyFinding

/**
 * Decide whether `bodyA ⇒ bodyB` is VALID, i.e. `bodyA ∧ ¬bodyB` is `unsat`.
 * Returns `false` on `sat` or `unknown` (conservative — an inconclusive solver
 * result is never reported as a proven implication).
 */
async function implies(ctx: Z3Context, bodyA: Formula, bodyB: Formula): Promise<boolean> {
  const solver = new ctx.Solver()
  solver.add(materialize(ctx, bodyA))
  solver.add(materialize(ctx, not(bodyB)))
  const res = await solver.check()
  return res === 'unsat'
}

/**
 * Check one candidate pair for subsumption/redundancy. Returns `undefined` when
 * neither implication direction is valid (the pair is merely a candidate, not an
 * actual subsumption).
 *
 * The direction of any valid implication is mapped back to `a`/`b` by id, per
 * the pinned-direction contract above.
 */
export async function checkSubsumptionPair(
  ctx: Z3Context,
  a: EncodedRequirement,
  b: EncodedRequirement,
): Promise<SubsumptionResult | undefined> {
  const aImpliesB = await implies(ctx, a.body, b.body)
  const bImpliesA = await implies(ctx, b.body, a.body)

  if (aImpliesB && bImpliesA) {
    return {
      code: 'FND_REDUNDANCY',
      severity: 'warn',
      requirementIds: [a.id, b.id],
      message: `${a.id} and ${b.id} are logically equivalent (bi-implication); one is redundant.`,
    }
  }

  if (aImpliesB) {
    // a's formula implies b's ⇒ a is the more general requirement.
    return subsumption(a.id, b.id, [a.id, b.id])
  }

  if (bImpliesA) {
    // b's formula implies a's ⇒ b is the more general requirement, even though
    // it occupies the `b` slot. This is the whichOf-trap-defeating branch.
    return subsumption(b.id, a.id, [a.id, b.id])
  }

  return undefined
}

/** Build a directional subsumption finding with the ids mapped, never positional. */
function subsumption(
  moreGeneral: string,
  moreSpecific: string,
  requirementIds: [string, string],
): SubsumptionFinding {
  return {
    code: 'FND_SUBSUMPTION',
    severity: 'warn',
    moreGeneral,
    moreSpecific,
    requirementIds,
    message: `${moreGeneral} subsumes ${moreSpecific} (more general implies more specific).`,
  }
}

/**
 * Run subsumption/redundancy over every candidate pair. The candidate generator
 * (AC-3-4) is the ONLY source of pairs — subsumption/redundancy are pairwise
 * checks, not whole-spec ones (contradiction/vacuity are whole-spec, AC-4-3/4-5).
 *
 * Pairs whose ids are absent from `encodedById` (excluded by the pipeline gate,
 * AC-3-7) are skipped silently.
 */
export async function checkSubsumption(
  ctx: Z3Context,
  encodedById: ReadonlyMap<string, EncodedRequirement>,
  pairs: readonly CandidatePair[],
): Promise<SubsumptionResult[]> {
  const findings: SubsumptionResult[] = []
  for (const pair of pairs) {
    const a = encodedById.get(pair.a)
    const b = encodedById.get(pair.b)
    if (a === undefined || b === undefined) continue
    const result = await checkSubsumptionPair(ctx, a, b)
    if (result !== undefined) findings.push(result)
  }
  return findings
}
