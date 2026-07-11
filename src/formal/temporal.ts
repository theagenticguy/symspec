/**
 * Bounded LTL → SMT lowering + temporal contradiction detection (AC-33-2).
 *
 * The propositional SMT tier evaluates one snapshot; this tier reasons about
 * ORDER over a finite trace of length `k`. It lowers a {@link TemporalFormula}
 * (from `temporal-patterns.ts`, itself derived from EARS via `earsToTemporal`)
 * to a plain propositional `z3-solver` formula over per-timestep atom variables
 * (`<atom>@<t>` for t in 0..k), then asks Z3 whether the conjunction of every
 * requirement's bounded encoding is jointly satisfiable. On `unsat`, the minimal
 * unsat core names the culprit requirement ids — the same assumption-literal
 * guard technique the propositional `contradiction.ts` uses.
 *
 * ## Sound-for-UNSAT (the honest limit, stated up front)
 *
 * This is a **bounded, loop-free** encoding: `G φ` unrolls to `⋀_{t≤k} φ@t`,
 * `F φ` to `⋁_{t≤k} φ@t`, `X φ` shifts to `t+1` (false past the horizon), and
 * `φ U ψ` to its bounded expansion. Without a loopback lasso it is
 * **sound for UNSAT but not complete for SAT**: an `unsat` verdict is a genuine
 * temporal contradiction (no trace of any length ≤ k satisfies the set, and
 * because `G`/response obligations only get HARDER to satisfy with more steps, a
 * contradiction found at k is real), but a `sat`-at-k result is NOT a
 * consistency certificate — a conflict might first appear past the horizon. The
 * envelope therefore reports `{ bound: k, complete: false }`, mirroring the SMT
 * tier's "silence is not a consistency certificate" discipline. We only ever
 * EMIT a finding on `unsat`, so we never over-report.
 *
 * ## Determinism
 *
 * The lowering is a pure function of `(formula, k)`; Z3's SAT/UNSAT verdict and
 * unsat core are reproducible. No randomness, no approximation on the reported
 * (UNSAT) path.
 */

import type { Z3Context } from './backend.js'
import type { Z3Bool } from './encode.js'
import type { Evidence } from './finding.js'
import type { TemporalFormula } from './temporal-patterns.js'

/** A temporal-contradiction finding (Appendix B `FND_TEMPORAL_CONTRADICTION`, error). */
export interface TemporalContradictionFinding {
  readonly code: 'FND_TEMPORAL_CONTRADICTION'
  readonly severity: 'error'
  /** The culprit requirement ids, from the minimized+dequoted unsat core. */
  readonly requirementIds: string[]
  readonly message: string
  /** AC-4-6 evidence: the bounded-check parameters (empty atom table). */
  readonly evidence: Evidence
}

/** One requirement's temporal formula, tagged with its id (the guard literal). */
export interface RequirementTemporal {
  readonly id: string
  readonly formula: TemporalFormula
}

/**
 * Lower a {@link TemporalFormula} to a propositional `z3-solver` Bool evaluated
 * at timestep `t` over a bounded trace of length `k` (steps 0..k inclusive).
 * Loop-free (sound for UNSAT). `X` past the horizon and unsatisfiable bounded
 * `F`/`U` obligations lower to `false`.
 */
export function lowerAt(ctx: Z3Context, f: TemporalFormula, t: number, k: number): Z3Bool {
  switch (f.op) {
    case 'atom':
      // A distinct Bool per (atom, timestep).
      return ctx.Bool.const(`${f.name}@${t}`)
    case 'not':
      return ctx.Not(lowerAt(ctx, f.arg, t, k))
    case 'and':
      return ctx.And(...f.args.map((a) => lowerAt(ctx, a, t, k)))
    case 'or':
      return ctx.Or(...f.args.map((a) => lowerAt(ctx, a, t, k)))
    case 'implies':
      return ctx.Implies(lowerAt(ctx, f.lhs, t, k), lowerAt(ctx, f.rhs, t, k))
    case 'G': {
      // G φ  ≡  ⋀_{i=t..k} φ@i  (loop-free: the safety obligation over the horizon).
      const conj: Z3Bool[] = []
      for (let i = t; i <= k; i++) conj.push(lowerAt(ctx, f.arg, i, k))
      return ctx.And(...conj)
    }
    case 'F': {
      // F φ  ≡  ⋁_{i=t..k} φ@i  (bounded eventuality; false if never within k).
      const disj: Z3Bool[] = []
      for (let i = t; i <= k; i++) disj.push(lowerAt(ctx, f.arg, i, k))
      return disj.length > 0 ? ctx.Or(...disj) : ctx.Bool.val(false)
    }
    case 'X':
      // X φ  ≡  φ@(t+1); past the horizon there is no next state → false.
      return t + 1 <= k ? lowerAt(ctx, f.arg, t + 1, k) : ctx.Bool.val(false)
    case 'U': {
      // φ U ψ at t  ≡  ⋁_{i=t..k} ( ψ@i ∧ ⋀_{t≤j<i} φ@j )  (bounded until).
      const disj: Z3Bool[] = []
      for (let i = t; i <= k; i++) {
        const holdsUntil: Z3Bool[] = []
        for (let j = t; j < i; j++) holdsUntil.push(lowerAt(ctx, f.lhs, j, k))
        const psiAtI = lowerAt(ctx, f.rhs, i, k)
        disj.push(holdsUntil.length > 0 ? ctx.And(psiAtI, ...holdsUntil) : psiAtI)
      }
      return disj.length > 0 ? ctx.Or(...disj) : ctx.Bool.val(false)
    }
  }
}

/** Lower a whole-trace obligation: the formula must hold from the initial state. */
function lowerInitial(ctx: Z3Context, f: TemporalFormula, k: number): Z3Bool {
  return lowerAt(ctx, f, 0, k)
}

/**
 * Find temporal contradictions across a set of requirement temporal formulas at
 * bound `k`. Asserts each requirement's bounded encoding under a guard literal
 * (= requirement id) and checks joint satisfiability. On `unsat`, emits
 * `FND_TEMPORAL_CONTRADICTION` naming the minimized unsat core.
 *
 * Sound-for-UNSAT: a finding is emitted ONLY on `unsat` (a real contradiction);
 * `sat`/`unknown` yield no finding and are NOT read as "consistent".
 */
export async function findTemporalContradictions(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  k = 10,
): Promise<TemporalContradictionFinding[]> {
  if (reqTemporals.length < 2) return []

  const ids = reqTemporals.map((r) => r.id)
  const solver = buildBoundedSolver(ctx, reqTemporals, k)
  const guards = ids.map((id) => ctx.Bool.const(id))
  const res = await solver.check(...guards)
  if (res !== 'unsat') return []

  const coreIds = dequoteCore(solver.unsatCore(), new Set(ids))
  const minimal = await minimizeTemporalCore(ctx, reqTemporals, coreIds, k)
  const culprits = (minimal.length > 0 ? minimal : ids).slice().sort()

  return [
    {
      code: 'FND_TEMPORAL_CONTRADICTION',
      severity: 'error',
      requirementIds: culprits,
      message:
        `Requirements ${culprits.join(', ')} are temporally inconsistent: no trace of length ≤ ${k} ` +
        'satisfies them jointly (bounded LTL→SMT). A sound contradiction; not bound-dependent to refute.',
      evidence: { atomTable: [], temporal: { bound: k, complete: false } },
    },
  ]
}

/**
 * The antecedent of a top-level guarded-response obligation, or null. Matches
 * the `earsToTemporal` shapes `G(ante → …)` (event/state/optional/unwanted) —
 * the `ante` is the trigger/state/feature literal whose reachability must be
 * asserted so the conflict is not vacuously satisfiable. Ubiquitous `G(resp)`
 * has no antecedent and returns null (always reachable, nothing to assert).
 */
function guardedAntecedent(f: TemporalFormula): TemporalFormula | null {
  if (f.op === 'G' && f.arg.op === 'implies') return f.arg.lhs
  if (f.op === 'implies') return f.lhs
  return null
}

/** A stable key for an antecedent formula so identical triggers dedupe. */
function antecedentKey(f: TemporalFormula): string {
  return JSON.stringify(f)
}

/** Strip Z3's `|...|` quoting (applied to digit-leading symbols) and keep known ids. */
function dequoteCore(core: Iterable<{ toString(): string }>, known: Set<string>): string[] {
  const ids: string[] = []
  for (const c of core) {
    const name = c.toString().replace(/^\|(.*)\|$/, '$1')
    if (known.has(name)) ids.push(name)
  }
  return ids
}

/**
 * Build a solver asserting each requirement's bounded encoding under its guard,
 * PLUS an `F(antecedent)` reachability assertion per distinct guarded trigger
 * (the temporal analogue of contradiction.ts's "assert the context reachable").
 * A `G(ante → cons)` obligation is vacuously satisfiable by keeping `ante` false
 * forever, which would hide a real response-vs-absence conflict on a shared
 * trigger; asserting the antecedent reachable at SOME step exposes it. Shared
 * antecedents dedupe by atom name, so two requirements on the same trigger
 * become reachable together without asserting mutually-exclusive triggers.
 */
function buildBoundedSolver(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  k: number,
): InstanceType<Z3Context['Solver']> {
  const solver = new ctx.Solver()
  for (const { id, formula } of reqTemporals) {
    solver.add(ctx.Implies(ctx.Bool.const(id), lowerInitial(ctx, formula, k)))
  }
  const antecedents = new Map<string, TemporalFormula>()
  for (const { formula } of reqTemporals) {
    const ante = guardedAntecedent(formula)
    if (ante !== null) antecedents.set(antecedentKey(ante), ante)
  }
  for (const ante of antecedents.values()) {
    const disj: Z3Bool[] = []
    for (let i = 0; i <= k; i++) disj.push(lowerAt(ctx, ante, i, k))
    if (disj.length > 0) solver.add(ctx.Or(...disj))
  }
  return solver
}

/** Deletion-based core minimization: drop each id; keep the smallest still-unsat set. */
async function minimizeTemporalCore(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  core: string[],
  k: number,
): Promise<string[]> {
  let current = [...new Set(core)]
  for (const candidate of [...current]) {
    const trial = current.filter((id) => id !== candidate)
    if (trial.length < 2) continue
    const subset = reqTemporals.filter((r) => trial.includes(r.id))
    const solver = buildBoundedSolver(ctx, subset, k)
    if ((await solver.check(...trial.map((id) => ctx.Bool.const(id)))) === 'unsat') current = trial
  }
  return current
}
