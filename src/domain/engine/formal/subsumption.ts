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

import type { CandidatePair } from '../solvers/types.ts'
import type { Z3Context } from './backend.ts'
import type { SolverBounds } from './budget.ts'
import { type EncodedRequirement, type Formula, materialize, not } from './encode.ts'

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
 *
 * `timeoutMs` bounds this single `check()` via `solver.set('timeout', …)`
 * (AC-1-7), the same idiom `contradiction.ts` uses. A solver that hits the
 * timeout returns `unknown`, which falls into the existing `!== 'unsat'`
 * conservative branch — so a per-solver timeout can only WITHHOLD a finding,
 * never manufacture one.
 */
async function implies(
  ctx: Z3Context,
  bodyA: Formula,
  bodyB: Formula,
  timeoutMs?: number,
): Promise<boolean> {
  const solver = new ctx.Solver()
  if (timeoutMs !== undefined) solver.set('timeout', timeoutMs)
  solver.add(materialize(ctx, bodyA))
  solver.add(materialize(ctx, not(bodyB)))
  const res = await solver.check()
  return res === 'unsat'
}

/**
 * The atom names a body formula references. Used only by {@link sharesAtom} for
 * the pre-solver prune; the `cmp` arm carries no propositional atom (the numeric
 * tier owns arithmetic), and a body never contains one, but it is enumerated for
 * totality.
 */
function atomsOf(f: Formula, into: Set<string>): void {
  switch (f.op) {
    case 'atom':
      into.add(f.name)
      return
    case 'not':
      atomsOf(f.arg, into)
      return
    case 'and':
    case 'or':
      for (const a of f.args) atomsOf(a, into)
      return
    case 'implies':
      atomsOf(f.lhs, into)
      atomsOf(f.rhs, into)
      return
    case 'cmp':
      return
  }
}

/**
 * True when the two bodies reference at least one atom in common.
 *
 * ## Why a disjoint-atom pair can be skipped SOUNDLY (AC-1-7, cheap pruning)
 *
 * Two requirements whose bodies share NO atom cannot subsume each other, so the
 * two `implies` solves are provably wasted work. The argument rests on the atom
 * namespacing `atomize.ts` guarantees — every atom is
 * `sys__<system>__<kind>__<body>`, so a `trig` atom, a `pre` atom and a `resp`
 * atom can never be the same name:
 *
 *   - A body is either `resp` (ubiquitous) or `(context) ⇒ resp`, where
 *     `context` is a conjunction of `pre`/`trig` literals. Since context atoms
 *     and the response atom are drawn from disjoint name spaces, no body is a
 *     tautology (falsify the response, satisfy the context) and none is
 *     unsatisfiable (satisfy the response). Every body is therefore both
 *     SATISFIABLE and FALSIFIABLE.
 *   - Take a model `M_A` satisfying `bodyA` and a model `M_B` falsifying
 *     `bodyB`. Their variable sets are disjoint, so `M_A ∪ M_B` is a
 *     well-defined model satisfying `bodyA ∧ ¬bodyB` — i.e. `bodyA ⇒ bodyB` is
 *     NOT valid. Symmetrically for `bodyB ⇒ bodyA`.
 *
 * So neither direction can hold, and `checkSubsumptionPair` would return
 * `undefined` after two guaranteed-`sat` solves. Skipping is
 * behavior-preserving, not a soundness trade.
 *
 * Scope note: this prunes pairs in the PAIRWISE tier only. It never drops a
 * context group — the contradiction/vacuity tiers run per-context-group over the
 * whole spec, independent of the candidate-pair set
 * (`solvers/free/pairwise-filter.ts:5-13`), and are untouched here.
 */
function sharesAtom(a: EncodedRequirement, b: EncodedRequirement): boolean {
  const atomsA = new Set<string>()
  atomsOf(a.body, atomsA)
  const atomsB = new Set<string>()
  atomsOf(b.body, atomsB)
  for (const name of atomsB) if (atomsA.has(name)) return true
  return false
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
  bounds: SolverBounds = {},
): Promise<SubsumptionResult | undefined> {
  const aImpliesB = await implies(ctx, a.body, b.body, bounds.timeoutMs)
  const bImpliesA = await implies(ctx, b.body, a.body, bounds.timeoutMs)

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
 *
 * ## Bounding (AC-1-7) — this is the O(N²) hot path
 *
 * Two unbounded `implies()` solves per pair made this the dominant cost of a
 * large run (measured: 36.4s of a 37.3s solver budget at N=100 / 4950 pairs).
 * Both knobs now apply:
 *
 *   - `bounds.timeoutMs` bounds each individual solve.
 *   - `bounds.budget` is the whole-run deadline, checked BEFORE each pair (never
 *     mid-pair), so a pair is either fully checked or not started. A truncated
 *     run is therefore a strict PREFIX of the full run and can only miss
 *     findings, never invent them. On truncation the tier records the unrun pair
 *     count on the budget ledger, which the pipeline surfaces as a
 *     `solver-budget-exhausted` demotion — a truncated run can never report
 *     `verified: true`.
 *
 * Pairs whose bodies share no atom are pruned before any solver contact; see
 * {@link sharesAtom} for why that is behavior-preserving rather than a soundness
 * trade.
 */
export async function checkSubsumption(
  ctx: Z3Context,
  encodedById: ReadonlyMap<string, EncodedRequirement>,
  pairs: readonly CandidatePair[],
  bounds: SolverBounds = {},
): Promise<SubsumptionResult[]> {
  const findings: SubsumptionResult[] = []
  for (const [index, pair] of pairs.entries()) {
    // Check-before-work: the deadline is consulted before a pair's first solve,
    // so no pair ever half-runs past it.
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('subsumption', pairs.length - index)
      break
    }
    const a = encodedById.get(pair.a)
    const b = encodedById.get(pair.b)
    if (a === undefined || b === undefined) continue
    if (!sharesAtom(a, b)) continue
    const result = await checkSubsumptionPair(ctx, a, b, bounds)
    if (result !== undefined) findings.push(result)
  }
  return findings
}
