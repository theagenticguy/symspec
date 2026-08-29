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
 * ## Both bodies must be contingent before either implication is evidence
 *
 * `implies` proves a relation between two formulas, not between two requirements.
 * A valid body is implied by everything and an unsatisfiable body implies
 * everything, so a single degenerate body reports `FND_SUBSUMPTION` against every
 * counterparty in the document and names the counterparty as the one to delete.
 * {@link contingent} screens both bodies first; {@link sharesAtom}'s lemma is why
 * that screen changes no verdict on a document of Boolean atoms, and
 * {@link contingent} is why it stays a verdict once a theory leaf appears.
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
 * Decide whether `f` has at least one satisfying model, i.e. `check()` answers
 * `sat`.
 *
 * `unsat` and `unknown` both answer `false`, so a timed-out probe reads as "not
 * known to be satisfiable". Every caller uses this to DISQUALIFY a pair, so
 * failing closed here withholds a finding rather than admitting one.
 */
async function satisfiable(ctx: Z3Context, f: Formula, timeoutMs?: number): Promise<boolean> {
  const solver = new ctx.Solver()
  if (timeoutMs !== undefined) solver.set('timeout', timeoutMs)
  solver.add(materialize(ctx, f))
  return (await solver.check()) === 'sat'
}

/**
 * Per-requirement-id contingency answers for one tier run, so the tier pays
 * O(N) satisfiability solves instead of O(N²).
 *
 * Scoped to a single {@link checkSubsumption} call: ids are unique within one
 * `encodedById`, so a hit always answers about the same body.
 */
export type ContingencyMemo = Map<string, boolean>

/**
 * True when `e.body` is CONTINGENT — some model satisfies it AND some model
 * falsifies it.
 *
 * ## Why a subsumption verdict requires it
 *
 * `implies()` answers about a pair, but a degenerate body makes it answer
 * without consulting the counterparty at all: `implies(X, bodyB)` is valid for
 * EVERY `X` when `bodyB` is valid, and `implies(bodyA, Y)` is valid for every
 * `Y` when `bodyA` is unsatisfiable. One degenerate body therefore reports
 * `FND_SUBSUMPTION` against every counterparty in the document, and two report
 * each other as `FND_REDUNDANCY` — findings about the shape of a formula, told
 * to an author as a fact about two requirements, with the narrower id named as
 * the one to delete. Contingency of both bodies is exactly what makes a valid
 * implication evidence that one requirement's behaviour constrains the other's.
 *
 * ## Cost, and why it buys no verdict today
 *
 * {@link sharesAtom}'s lemma proves every body {@link encode} emits is already
 * contingent, so on a document of Boolean atoms this probe answers `true`
 * everywhere and changes no finding. It is the guard for the leaf the lemma does
 * not cover: a body carrying a theory term, where `q < 30 ∨ q ≥ 30` is valid and
 * no name disjointness rules that out.
 *
 * A cached `false` from a timed-out solve stays `false` for the rest of the run,
 * which is the withholding direction.
 */
async function contingent(
  ctx: Z3Context,
  e: EncodedRequirement,
  timeoutMs: number | undefined,
  memo: ContingencyMemo | undefined,
): Promise<boolean> {
  const hit = memo?.get(e.id)
  if (hit !== undefined) return hit
  const value =
    (await satisfiable(ctx, e.body, timeoutMs)) && (await satisfiable(ctx, not(e.body), timeoutMs))
  memo?.set(e.id, value)
  return value
}

/**
 * The atom names a body formula references. Used only by {@link sharesAtom} for
 * the pre-solver prune.
 *
 * The `cmp` arm contributes nothing: a comparison carries no propositional atom,
 * because the numeric tier owns arithmetic. Naming its quantity here would make
 * two bodies over the same quantity share a name and so reach the solver — which
 * is the coarsening {@link sharesAtom} documents as REQUIRED once a theory
 * exists, and which is unsound to add before every caller of `implies` screens
 * degenerate bodies (see {@link contingent}). Bodies `encode` emits contain no
 * `cmp`; the arm is enumerated for totality.
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
 * The lemma is about LOGICAL INDEPENDENCE, and name disjointness is the proxy it
 * uses to establish it. That proxy holds exactly while every leaf of a body is a
 * free, uninterpreted, mutually unconstrained Bool — two distinct names then have
 * two independently assignable truth values, and nothing relates them. Every step
 * below spends that property:
 *
 *   - Atom names are namespaced `sys__<system>__<kind>__<body>` by
 *     `atomize.ts`, so a `trig` atom, a `pre` atom and a `resp` atom can never
 *     be the same name.
 *   - A body is either `resp` (ubiquitous) or `(context) ⇒ resp`, where
 *     `context` is a conjunction of `pre`/`trig` literals. Since context atoms
 *     and the response atom are drawn from disjoint name spaces, no body is a
 *     tautology (falsify the response, satisfy the context) and none is
 *     unsatisfiable (satisfy the response). Every body is therefore both
 *     SATISFIABLE and FALSIFIABLE — the contingency {@link contingent} screens
 *     for, guaranteed here rather than probed.
 *   - Take a model `M_A` satisfying `bodyA` and a model `M_B` falsifying
 *     `bodyB`. Their variable sets are disjoint, so `M_A ∪ M_B` is a
 *     well-defined model satisfying `bodyA ∧ ¬bodyB` — i.e. `bodyA ⇒ bodyB` is
 *     NOT valid. Symmetrically for `bodyB ⇒ bodyA`.
 *
 * So neither direction can hold, and `checkSubsumptionPair` would return
 * `undefined` after two guaranteed-`sat` implication solves. Skipping is
 * behavior-preserving, not a soundness trade.
 *
 * ## What this predicate must become once a theory exists
 *
 * A theory leaf breaks the proxy in both directions. `q < 30` and `q ≥ 30` are
 * different leaves that share no name and are nonetheless jointly unsatisfiable
 * and jointly exhaustive, so disjoint NAMES no longer imply independent MODELS:
 * `M_A ∪ M_B` need not exist, and a body over one quantity can be valid or
 * unsatisfiable on its own.
 *
 * The predicate that survives is "the two bodies share no top-level SYMBOL",
 * counting each `cmp`'s quantity as a symbol alongside every atom name. That is
 * strictly COARSER: every pair it prunes, this one prunes too, and it prunes
 * strictly fewer — so migrating to it can only add solver work and findings,
 * never remove them. It is safe only once every `implies` caller screens
 * degenerate bodies, which is why {@link contingent} is a precondition for the
 * coarsening rather than a companion to it.
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
 * actual subsumption), and when either body is degenerate.
 *
 * The direction of any valid implication is mapped back to `a`/`b` by id, per
 * the pinned-direction contract above.
 *
 * ## The contingency pre-check, and why it lives HERE
 *
 * Both bodies must be contingent — satisfiable and falsifiable — before either
 * `implies` solve is worth running, because a valid or unsatisfiable body makes
 * `implies` answer about the formula's shape instead of about the pair (see
 * {@link contingent}). This function is the narrowest place that holds for a
 * direct caller as well as for {@link checkSubsumption}, so the guard sits here
 * rather than in the tier loop; the tier passes `contingency` so the two answers
 * per requirement are solved once for the whole run.
 *
 * It runs after the tier's `bounds.budget` check, so the extra solves are inside
 * the same deadline as the pair they screen.
 */
export async function checkSubsumptionPair(
  ctx: Z3Context,
  a: EncodedRequirement,
  b: EncodedRequirement,
  bounds: SolverBounds = {},
  contingency?: ContingencyMemo,
): Promise<SubsumptionResult | undefined> {
  if (!(await contingent(ctx, a, bounds.timeoutMs, contingency))) return undefined
  if (!(await contingent(ctx, b, bounds.timeoutMs, contingency))) return undefined

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

/** What one whole-tier run reports. */
export interface SubsumptionTierResult {
  /** The subsumption/redundancy findings, in candidate-pair order. */
  readonly findings: readonly SubsumptionResult[]
  /**
   * Candidate pairs that reached the tier and never reached an `implies` solve:
   * absent from `encodedById`, atom-disjoint ({@link sharesAtom}), or carrying a
   * degenerate body ({@link contingent}).
   *
   * The pipeline subtracts this from its candidate-pair count, so the number it
   * publishes as `pairsChecked` counts COMPARISONS rather than candidates. That
   * is the only instrument that can observe the prune growing or shrinking: a
   * pruned pair and a compared-but-inconclusive pair emit the same empty output,
   * so a prune that starts eating real pairs is otherwise invisible.
   *
   * Budget-truncated pairs are deliberately NOT counted here. They are recorded
   * on the budget ledger instead, which raises a `solver-budget-exhausted`
   * demotion naming the unrun count — a louder channel than a shrunk statistic.
   */
  readonly pruned: number
}

/**
 * Run subsumption/redundancy over every candidate pair. The candidate generator
 * (AC-3-4) is the ONLY source of pairs — subsumption/redundancy are pairwise
 * checks, not whole-spec ones (contradiction/vacuity are whole-spec, AC-4-3/4-5).
 *
 * Pairs whose ids are absent from `encodedById` (excluded by the pipeline gate,
 * AC-3-7) are skipped, and counted in {@link SubsumptionTierResult.pruned} with
 * every other pair that reaches no solve.
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
 * trade. Contingency is answered once per requirement through the run-scoped
 * {@link ContingencyMemo}, so the degenerate-body screen costs two solves per
 * requirement rather than four per pair.
 */
export async function checkSubsumption(
  ctx: Z3Context,
  encodedById: ReadonlyMap<string, EncodedRequirement>,
  pairs: readonly CandidatePair[],
  bounds: SolverBounds = {},
): Promise<SubsumptionTierResult> {
  const findings: SubsumptionResult[] = []
  const contingency: ContingencyMemo = new Map()
  let pruned = 0
  for (const [index, pair] of pairs.entries()) {
    // Check-before-work: the deadline is consulted before a pair's first solve,
    // so no pair ever half-runs past it.
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('subsumption', pairs.length - index)
      break
    }
    const a = encodedById.get(pair.a)
    const b = encodedById.get(pair.b)
    if (a === undefined || b === undefined) {
      pruned += 1
      continue
    }
    if (!sharesAtom(a, b)) {
      pruned += 1
      continue
    }
    // Asked here, and again inside `checkSubsumptionPair`, because the tier owes a
    // count and the pair checker owes soundness to a direct caller. The memo makes
    // the second ask an answered question rather than a second pair of solves.
    if (
      !(await contingent(ctx, a, bounds.timeoutMs, contingency)) ||
      !(await contingent(ctx, b, bounds.timeoutMs, contingency))
    ) {
      pruned += 1
      continue
    }
    const result = await checkSubsumptionPair(ctx, a, b, bounds, contingency)
    if (result !== undefined) findings.push(result)
  }
  return { findings, pruned }
}
