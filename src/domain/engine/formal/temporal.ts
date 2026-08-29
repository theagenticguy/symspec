/**
 * Bounded LTL → SMT lowering + temporal contradiction detection (AC-33-2,
 * eventuality handling repaired by AC-2-6).
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
 * ## The two directions of truncation, and which one used to be wrong
 *
 * `G` is the safe direction: unrolling `G φ` to `⋀_{i=t..k} φ@i` makes a safety
 * obligation WEAKER than its real semantics, so it can only MISS a violation
 * that first happens past the horizon (a false negative) — never manufacture
 * one.
 *
 * The eventualities are the dangerous direction, and before AC-2-6 they were
 * unsound. A naive `F φ ≡ ⋁_{i=t..k} φ@i` collapses to `φ@k` when instantiated
 * at `t = k` — which `G` does, at every step, for every `event-driven`
 * requirement (`G(trig → F resp)`). Likewise `X φ` at `t = k` lowered to
 * literally `false`, and `φ U ψ` at `t = k` collapsed to `ψ@k`. Each of those is
 * STRONGER than the real semantics, so `unsat` stopped implying a real conflict.
 * Measured false positives at `error` severity: `G(a → F b) ∧ G(a → ¬b) ∧
 * G(b → F a)` was reported `unsat` at k = 2, 4, 8, 12 even though the period-2
 * lasso `{a,¬b} → {¬a,b} ↺` satisfies it; `G(a → X b) ∧ a@k` and
 * `G(a → (p U q)) ∧ a@k ∧ ¬q@k` were `unsat` at k = 2, 5.
 *
 * ## Pending eventualities + a PER-EVENTUALITY abstract tail (the AC-2-6 repair)
 *
 * The horizon no longer has to discharge an eventuality. For each DISTINCT
 * eventuality subformula `ε` (`F φ` or `φ U ψ`) the encoding mints two fresh,
 * content-addressed symbols:
 *
 *   - a **pending literal** `pend_ε`, disjoined into `ε`'s lowering:
 *     `F φ @ t ⟶ ⋁_{i=t..k} φ@i ∨ pend_ε` (and the same `∨ pend_ε` on `U`), so
 *     the obligation may escape past `k` instead of being forced at `k`; and
 *   - an **abstract tail index** `τ_ε`, a symbolic timestep standing for "some
 *     step after the horizon at which `ε` is finally discharged".
 *
 * `X φ` at `t = k` becomes a free Bool for "φ at the step after the horizon"
 * instead of `false`.
 *
 * Choosing `pend_ε` true is then paid for, in {@link buildBoundedSolver}, by two
 * families of assertions — both guarded by `pend_ε` AND by the owning
 * requirement id, so they rebuild per candidate subset during core minimization
 * and stay attributable in an unsat core:
 *
 *   1. every top-level `G` body must hold at `τ_ε` (sound: a `G` body holds at
 *      EVERY step, so `τ_ε` is a legitimate step); and
 *   2. `pend_ε → target(ε)@τ_ε`, where `target(F φ) = φ` and `target(φ U ψ) = ψ`
 *      — the discharge that makes the pending mean something.
 *
 * Together those two recover full recall: on `G(T → F R) + G(¬R)` the tail says
 * `pend → R@τ` and `pend → ¬R@τ`, forcing `pend` false and collapsing back to
 * the bounded encoding, which is `unsat` — the real conflict is still proved.
 *
 * ### One tail index per eventuality. NEVER shared.
 *
 * Sharing one `τ` across eventualities is UNSOUND, and it is not a subtle
 * margin: measured, `G(t → F r) + G(c → F d) + G(¬(r ∧ d))` comes back `unsat`
 * with a shared tail (both pendings force `r` and `d` at the SAME step, which
 * `G(¬(r ∧ d))` forbids) where per-eventuality tails correctly return `sat` —
 * `r` and `d` simply happen at different steps. A shared tail silently asserts
 * that all outstanding obligations complete simultaneously.
 *
 * ### Why this is a STRICT RELAXATION of the pre-AC-2-6 encoding
 *
 * Every model of the old encoding extends to a model of this one: set every
 * `pend_ε` and every past-the-horizon `X` Bool to `false`. Under that
 * assignment `⋁_{i≤k} φ@i ∨ pend_ε` is exactly `⋁_{i≤k} φ@i`, `X` at the
 * horizon is exactly `false`, and every tail assertion is `pend_ε → …` with a
 * false antecedent, i.e. vacuous. So the new encoding can only ever be MORE
 * satisfiable — it adds disjuncts and freshly-guarded implications and nothing
 * else. It can therefore lose no recall it did not deserve to lose, and review
 * reduces to checking that property.
 *
 * ## Sound-for-UNSAT (the honest limit, stated up front)
 *
 * The encoding remains **loop-free**: sound for UNSAT, not complete for SAT.
 * With the repair, `unsat` at bound `k` means no trace satisfies the set GIVEN
 * that every guarded trigger occurs within the first `k` steps — the
 * reachability premise {@link buildBoundedSolver} adds to avoid vacuous
 * satisfaction. `sat` at `k` is NOT a consistency certificate: a conflict may
 * first appear past the horizon. The envelope therefore reports
 * `{ bound: k, complete: false }`, mirroring the SMT tier's "silence is not a
 * consistency certificate" discipline, and a finding is emitted only on `unsat`.
 * A verdict is still relative to `k`, so the finding message says so rather than
 * claiming (as it wrongly did pre-AC-2-6) that it is "not bound-dependent".
 *
 * ## Determinism
 *
 * The lowering is a pure function of `(formula, t, k)`. Every fresh symbol the
 * pending/tail scheme mints is CONTENT-ADDRESSED via {@link formulaKey} — never
 * from a counter, nonce, or map insertion order — so `lowerAt` returns the same
 * expression string on every call and two structurally identical eventualities
 * in different requirements share one pending (dedupe) while two different ones
 * can never collide (soundness). Z3's SAT/UNSAT verdict and unsat core are
 * reproducible; no randomness, no approximation on the reported (UNSAT) path.
 *
 * Reproducible means reproducible from the requirement SET, which is stronger than
 * reproducible from an identical call. The unsat core Z3 returns is a function of
 * the sequence it was fed, and a spec can admit more than one minimal core, so
 * {@link findTemporalContradictions} sorts the requirements on id before asserting
 * them — otherwise the reported culprits would be a function of where in the file
 * an author put a rule.
 */

import type { Z3Context } from './backend.ts'
import type { SolverBounds } from './budget.ts'
import type { Z3Bool } from './encode.ts'
import type { Evidence } from './finding.ts'
import type { TemporalFormula } from './temporal-patterns.ts'

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
 * A stable content address for a formula — the basis of every fresh symbol the
 * pending/tail scheme mints, and the dedupe key for guarded antecedents.
 * Content-addressed, never counter-addressed, so `lowerAt` is a pure function of
 * `(formula, t, k)` and structurally identical eventualities in different
 * requirements share exactly one pending literal.
 */
function formulaKey(f: TemporalFormula): string {
  return JSON.stringify(f)
}

/**
 * The pending literal for one distinct eventuality subformula (`F φ` / `φ U ψ`):
 * "this obligation is still outstanding at the horizon." Disjoined into the
 * eventuality's lowering so the horizon never has to discharge it, and paid for
 * by the tail assertions in {@link buildBoundedSolver}.
 */
function pendingLiteral(ctx: Z3Context, ev: TemporalFormula): Z3Bool {
  return ctx.Bool.const(`pend#${formulaKey(ev)}`)
}

/**
 * The abstract tail step for one distinct eventuality — the symbolic "step after
 * the horizon where this obligation is finally discharged".
 *
 * **Keyed on the eventuality, so it is NEVER shared between two of them.** A
 * shared tail asserts that all outstanding obligations complete at the SAME
 * step, which is unsound: measured, `G(t → F r) + G(c → F d) + G(¬(r ∧ d))`
 * returns `unsat` under a shared tail (both pendings force `r` and `d` at one
 * step) where per-eventuality tails correctly return `sat` (`r` and `d` simply
 * happen at different steps).
 */
function tailStep(ev: TemporalFormula): string {
  return `tail#${formulaKey(ev)}`
}

/** The virtual step `X` shifts into when `t + 1` is past the horizon. */
function virtualStep(i: number): string {
  return `next#${i}`
}

/**
 * The subformula a pending eventuality must discharge at its tail step:
 * `target(F φ) = φ`, `target(φ U ψ) = ψ`.
 */
function eventualityTarget(ev: TemporalFormula & { op: 'F' | 'U' }): TemporalFormula {
  return ev.op === 'F' ? ev.arg : ev.rhs
}

/**
 * Lower a formula at a SYMBOLIC step (an abstract tail step, or the virtual step
 * one past the horizon) rather than a numeric one. Atoms become
 * `<atom>@<step>`; the step tokens all contain `#`, which no numeric step does,
 * so a symbolic step can never collide with a real one.
 *
 * `G φ` contributes `φ` at the symbolic step (a `G` body holds at every step, so
 * asserting only the body there is correct and weaker than the full obligation),
 * and a nested `F`/`X`/`U` becomes a single free Bool keyed on `(subformula,
 * step)`. Both are RELAXATIONS: replacing a subformula uniformly by a fresh free
 * variable can only widen the model set (any model of the original extends by
 * assigning the variable that subformula's value), so `unsat` conclusions
 * survive. Nested eventualities are discharged by their own pendings anyway.
 */
function lowerAtSymbolic(ctx: Z3Context, f: TemporalFormula, step: string): Z3Bool {
  switch (f.op) {
    case 'atom':
      return ctx.Bool.const(`${f.name}@${step}`)
    case 'not':
      return ctx.Not(lowerAtSymbolic(ctx, f.arg, step))
    case 'and':
      return ctx.And(...f.args.map((a) => lowerAtSymbolic(ctx, a, step)))
    case 'or':
      return ctx.Or(...f.args.map((a) => lowerAtSymbolic(ctx, a, step)))
    case 'implies':
      return ctx.Implies(lowerAtSymbolic(ctx, f.lhs, step), lowerAtSymbolic(ctx, f.rhs, step))
    case 'G':
      return lowerAtSymbolic(ctx, f.arg, step)
    case 'F':
    case 'X':
    case 'U':
      return ctx.Bool.const(`opaque#${formulaKey(f)}@${step}`)
  }
}

/**
 * Collect the DISTINCT eventuality subformulas (`F φ`, `φ U ψ`) of a formula,
 * keyed by {@link formulaKey} — the same keys {@link lowerAt} mints pendings
 * from, so {@link buildBoundedSolver}'s tail assertions line up with the
 * lowering exactly. Pure; mutates only the caller's accumulator.
 */
function collectEventualities(f: TemporalFormula, into: Map<string, TemporalFormula>): void {
  switch (f.op) {
    case 'atom':
      return
    case 'not':
    case 'G':
    case 'X':
      collectEventualities(f.arg, into)
      return
    case 'and':
    case 'or':
      for (const a of f.args) collectEventualities(a, into)
      return
    case 'implies':
      collectEventualities(f.lhs, into)
      collectEventualities(f.rhs, into)
      return
    case 'F':
      into.set(formulaKey(f), f)
      collectEventualities(f.arg, into)
      return
    case 'U':
      into.set(formulaKey(f), f)
      collectEventualities(f.lhs, into)
      collectEventualities(f.rhs, into)
      return
  }
}

/**
 * Lower a {@link TemporalFormula} to a propositional `z3-solver` Bool evaluated
 * at timestep `t` over a bounded trace of length `k` (steps 0..k inclusive).
 * Loop-free, so still sound-for-UNSAT-only.
 *
 * `G` unrolls to the per-step conjunction over `[t, k]` — the safe direction
 * (weaker than the real obligation, so it can only miss a violation past the
 * horizon). The eventualities do NOT collapse at the horizon (AC-2-6): `F φ` and
 * `φ U ψ` carry a {@link pendingLiteral} disjunct so the obligation may escape
 * past `k`, and `X φ` past the horizon lowers into the virtual step `t+1` rather
 * than to `false`. Pending literals are only ever discharged — and hence only
 * ever cost anything — inside {@link buildBoundedSolver}, which asserts each
 * pending's abstract tail state; a caller lowering a formula in isolation gets
 * the relaxed (free-pending) reading, which is the sound direction.
 *
 * Pure and deterministic in `(f, t, k)`: every minted symbol is content-addressed
 * (see {@link formulaKey}), never drawn from a counter or nonce, so two calls
 * return identical expressions.
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
      // F φ  ≡  ⋁_{i=t..k} φ@i  ∨  pend_{F φ}.
      // The trailing pending disjunct is the AC-2-6 repair: WITHOUT it this
      // collapses to φ@k at t=k — which `G` instantiates at every step — forcing
      // the eventuality AT the horizon and manufacturing false `unsat`s.
      const disj: Z3Bool[] = []
      for (let i = t; i <= k; i++) disj.push(lowerAt(ctx, f.arg, i, k))
      disj.push(pendingLiteral(ctx, f))
      return ctx.Or(...disj)
    }
    case 'X':
      // X φ  ≡  φ@(t+1). Past the horizon there is no numbered next state, so
      // lower φ at the VIRTUAL step t+1 (free atoms) instead of `false` — `false`
      // made `G(a → X b)` force ¬a@k, an unsound over-constraint (AC-2-6).
      return t + 1 <= k
        ? lowerAt(ctx, f.arg, t + 1, k)
        : lowerAtSymbolic(ctx, f.arg, virtualStep(t + 1))
    case 'U': {
      // φ U ψ at t  ≡  ⋁_{i=t..k} ( ψ@i ∧ ⋀_{t≤j<i} φ@j )  ∨  pend_{φ U ψ}.
      // Same AC-2-6 repair as `F`: at t=k the bounded expansion collapses to ψ@k.
      const disj: Z3Bool[] = []
      for (let i = t; i <= k; i++) {
        const holdsUntil: Z3Bool[] = []
        for (let j = t; j < i; j++) holdsUntil.push(lowerAt(ctx, f.lhs, j, k))
        const psiAtI = lowerAt(ctx, f.rhs, i, k)
        disj.push(holdsUntil.length > 0 ? ctx.And(psiAtI, ...holdsUntil) : psiAtI)
      }
      disj.push(pendingLiteral(ctx, f))
      return ctx.Or(...disj)
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
  bounds: SolverBounds = {},
): Promise<TemporalContradictionFinding[]> {
  if (reqTemporals.length < 2) return []

  // AC-1-7 check-before-work: this tier is ONE whole-spec unit of work (a single
  // bounded check over every requirement at once), so the deadline is checked
  // before starting it. If the budget is already spent the tier is skipped
  // wholesale and records the requirement count as unrun — the pipeline turns
  // that into a `solver-budget-exhausted` demotion, so a skipped temporal tier
  // never reads as "temporally consistent". Sound-for-UNSAT already means a
  // non-finding is not a certificate; this makes the SKIP explicit too.
  if (bounds.budget?.expired() === true) {
    bounds.budget.truncate('temporal', reqTemporals.length)
    return []
  }

  // The solver-facing sequence is id-sorted, never document-ordered. A spec can
  // admit more than one minimal unsat core — `G(t → F p)` plus two `G(¬p)` gives
  // `{a,b}` and `{a,c}`, either of which is a real inconsistency — and which one
  // `unsatCore()` names is a function of the sequence the solver was fed. The
  // culprit ids are output bytes (`requirementIds`, and the ids in `message`), so
  // a document-ordered sequence would make the blamed requirement a function of
  // file position. Reporting either overlapping core is sound; the unreported one
  // is a MISS, the honest direction. Which one it is must not be a line number.
  const ordered = [...reqTemporals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids = ordered.map((r) => r.id)
  const solver = buildBoundedSolver(ctx, ordered, k, bounds)
  const guards = ids.map((id) => ctx.Bool.const(id))
  const res = await solver.check(...guards)
  if (res !== 'unsat') return []

  const coreIds = dequoteCore(solver.unsatCore(), new Set(ids))
  const minimal = await minimizeTemporalCore(ctx, ordered, coreIds, k, bounds)
  const culprits = (minimal.length > 0 ? minimal : ids).slice().sort()

  return [
    {
      code: 'FND_TEMPORAL_CONTRADICTION',
      severity: 'error',
      requirementIds: culprits,
      message:
        `Requirements ${culprits.join(', ')} are temporally inconsistent: no trace satisfies them ` +
        `jointly with every guarded trigger occurring within ${k} steps (bounded LTL→SMT, bound ` +
        `k=${k}). Eventualities are allowed to complete past the horizon, so this is not a ` +
        'truncation artifact — but the verdict is relative to that reachability premise: a ' +
        `counterexample needing a trigger later than step ${k} would refute it. Re-check at a ` +
        'larger --temporal-bound to widen the premise.',
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
 * (the temporal analogue of contradiction.ts's "assert the context reachable"),
 * PLUS the AC-2-6 abstract tail state for every pending eventuality.
 *
 * **Reachability.** A `G(ante → cons)` obligation is vacuously satisfiable by
 * keeping `ante` false forever, which would hide a real response-vs-absence
 * conflict on a shared trigger; asserting the antecedent reachable at SOME step
 * in the FULL `[0, k]` window exposes it. Shared antecedents dedupe by atom name,
 * so two requirements on the same trigger become reachable together without
 * asserting mutually-exclusive triggers. This window is load-bearing and must not
 * be narrowed — see
 * `.erpaval/solutions/architecture/temporal-bounded-ltl-reachability-subtlety.md`.
 *
 * **Tail state (AC-2-6).** `lowerAt` lets an eventuality escape the horizon via a
 * `pend_ε` disjunct. Choosing `pend_ε` is paid for here: for each distinct
 * eventuality `ε` reachable from a requirement's formula, and at `ε`'s OWN
 * abstract tail step `τ_ε` (never a shared one — see {@link tailStep}), assert
 *
 *   - `id ∧ pend_ε → G-body@τ_ε` for every top-level `G` in the set (sound: a `G`
 *     body holds at every step, so `τ_ε` is a legitimate step); and
 *   - `id ∧ pend_ε → target(ε)@τ_ε` (the discharge itself).
 *
 * Both are guarded by the requirement id as well as by `pend_ε`, so they rebuild
 * per candidate subset inside {@link minimizeTemporalCore} and stay attributable
 * in an unsat core. Every added assertion is an implication out of a FRESH
 * literal, so this cannot strengthen the encoding: assigning every `pend_ε` false
 * makes all of it vacuous and recovers the pre-AC-2-6 model set exactly.
 *
 * This is the ONLY `new ctx.Solver()` site in this module, so applying
 * `bounds.timeoutMs` here bounds both the main check and every minimization
 * re-check (AC-1-7). A timeout surfaces as `unknown`, which the sound-for-UNSAT
 * discipline already discards (a finding is emitted only on `unsat`).
 */
function buildBoundedSolver(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  k: number,
  bounds: SolverBounds = {},
): InstanceType<Z3Context['Solver']> {
  const solver = new ctx.Solver()
  if (bounds.timeoutMs !== undefined) solver.set('timeout', bounds.timeoutMs)
  for (const { id, formula } of reqTemporals) {
    solver.add(ctx.Implies(ctx.Bool.const(id), lowerInitial(ctx, formula, k)))
  }
  const antecedents = new Map<string, TemporalFormula>()
  for (const { formula } of reqTemporals) {
    const ante = guardedAntecedent(formula)
    if (ante !== null) antecedents.set(formulaKey(ante), ante)
  }
  for (const ante of antecedents.values()) {
    const disj: Z3Bool[] = []
    for (let i = 0; i <= k; i++) disj.push(lowerAt(ctx, ante, i, k))
    if (disj.length > 0) solver.add(ctx.Or(...disj))
  }
  addPendingTailStates(ctx, solver, reqTemporals)
  return solver
}

/**
 * Assert the abstract tail state for every pending eventuality in the set
 * (AC-2-6). Split out of {@link buildBoundedSolver} only for readability — it
 * must run inside it, so core minimization rebuilds these assertions per
 * candidate subset (a tail obligation owed by a dropped requirement must vanish
 * with it, or minimization would blame the wrong ids).
 *
 * Note the tail assertions are independent of `k`: they describe steps BEYOND the
 * horizon, so they are lowered symbolically (see {@link lowerAtSymbolic}).
 *
 * One assertion is emitted per (requirement, eventuality) pair, conjoining the
 * RELEVANT `G` bodies with the discharge — see {@link relevantBodyIndices} for
 * why the irrelevant ones are safe to leave out, and why leaving them in is not
 * (it exhausts the Z3 WASM heap at N=100).
 */
function addPendingTailStates(
  ctx: Z3Context,
  solver: InstanceType<Z3Context['Solver']>,
  reqTemporals: readonly RequirementTemporal[],
): void {
  // Every top-level `G` body in the surviving subset — legitimate at any step,
  // therefore legitimate at any tail step.
  const globalBodies = reqTemporals
    .filter(({ formula }) => formula.op === 'G')
    .map(({ formula }) => (formula as TemporalFormula & { op: 'G' }).arg)
  const bodySymbols = globalBodies.map((body) => {
    const syms = new Set<string>()
    collectTailSymbols(body, syms)
    return syms
  })

  for (const { id, formula } of reqTemporals) {
    const guard = ctx.Bool.const(id)
    const eventualities = new Map<string, TemporalFormula>()
    collectEventualities(formula, eventualities)
    for (const ev of eventualities.values()) {
      if (ev.op !== 'F' && ev.op !== 'U') continue
      const target = eventualityTarget(ev)
      const tau = tailStep(ev)
      const conjuncts: Z3Bool[] = [lowerAtSymbolic(ctx, target, tau)]
      for (const i of relevantBodyIndices(target, bodySymbols)) {
        conjuncts.push(lowerAtSymbolic(ctx, globalBodies[i] as TemporalFormula, tau))
      }
      solver.add(ctx.Implies(ctx.And(guard, pendingLiteral(ctx, ev)), ctx.And(...conjuncts)))
    }
  }
}

/**
 * Collect the symbol names {@link lowerAtSymbolic} would emit for a formula at a
 * tail step, ignoring the step suffix — i.e. atom names, plus one opaque key per
 * nested `F`/`X`/`U` (which `lowerAtSymbolic` replaces wholesale, so its inner
 * atoms are NOT reachable at that step). Mirrors `lowerAtSymbolic`'s recursion
 * exactly; if the two ever diverge, {@link relevantBodyIndices}'s prune stops
 * being recall-preserving.
 */
function collectTailSymbols(f: TemporalFormula, into: Set<string>): void {
  switch (f.op) {
    case 'atom':
      into.add(f.name)
      return
    case 'not':
    case 'G':
      collectTailSymbols(f.arg, into)
      return
    case 'and':
    case 'or':
      for (const a of f.args) collectTailSymbols(a, into)
      return
    case 'implies':
      collectTailSymbols(f.lhs, into)
      collectTailSymbols(f.rhs, into)
      return
    case 'F':
    case 'X':
    case 'U':
      into.add(`opaque#${formulaKey(f)}`)
      return
  }
}

/**
 * Which top-level `G` bodies can possibly constrain one eventuality's discharge
 * at its own tail step: the transitive atom-sharing closure of the eventuality's
 * target. Without this prune the tail block is the full `O(P·N)` cross-product —
 * 10,300 assertions at N=100/k=10, measured, which exhausts the Z3 WASM
 * `small_object_allocator` and dies with `memory access out of bounds` mid-check.
 * That is a crash, not a slowdown, so the prune is load-bearing.
 *
 * It costs no soundness and no recall:
 *
 *   - **Soundness (UNSAT stays real).** Dropping assertions only ever widens the
 *     model set, and this tier reports only on `unsat`.
 *   - **Recall.** A tail step `τ_ε` is unique to `ε`, so `name@τ_ε` atoms appear
 *     nowhere else in the encoding. The tail block therefore forces `pend_ε`
 *     false exactly when its conjuncts are jointly unsatisfiable as a
 *     single-step propositional formula. A body outside the closure shares no
 *     symbol with the closure, so it cannot participate in such a conflict
 *     WITH the target; the only conflict it could join is one among the excluded
 *     bodies alone — and those same bodies are already asserted at every step in
 *     `[0, k]` by the main encoding, so a propositional clash between them makes
 *     the whole check `unsat` at step 0 and the finding fires anyway. (The
 *     implication holds in the right direction because `lowerAtSymbolic` weakens
 *     nested temporal subformulas to free variables: unsat under that
 *     abstraction implies unsat under the real expansion.)
 */
function relevantBodyIndices(
  target: TemporalFormula,
  bodySymbols: readonly Set<string>[],
): number[] {
  const reached = new Set<string>()
  collectTailSymbols(target, reached)
  const kept: number[] = []
  const taken = new Set<number>()
  let grew = true
  while (grew) {
    grew = false
    for (let i = 0; i < bodySymbols.length; i++) {
      if (taken.has(i)) continue
      const syms = bodySymbols[i] as Set<string>
      let touches = false
      for (const s of syms) {
        if (reached.has(s)) {
          touches = true
          break
        }
      }
      if (!touches) continue
      taken.add(i)
      kept.push(i)
      for (const s of syms) reached.add(s)
      grew = true
    }
  }
  return kept
}

/**
 * Deletion-based core minimization: drop each id; keep the smallest still-unsat
 * set. `bounds.timeoutMs` reaches each re-check through `buildBoundedSolver`; an
 * `unknown` from a timeout fails the `=== 'unsat'` test and so KEEPS the
 * candidate — the conservative direction (a wider blame set, never a wrongly
 * exonerated culprit). The whole-run budget is deliberately not consulted:
 * minimization only runs after `unsat` is already proved, and an owed finding is
 * reported at full precision (same rationale as `minimizeNumericCore`).
 *
 * The visit order is canonicalized on requirement id, for the same reason
 * `minimizeNumericCore` does it: deletion keeps whichever minimal subset the input
 * order reaches, and `core` arrives in `unsatCore()` order. `findTemporalContradictions`
 * already feeds the solver an id-sorted sequence, so this is belt-and-suspenders —
 * it makes the result a function of the core's MEMBERSHIP even if a future solver
 * returned the same core in a different order.
 */
async function minimizeTemporalCore(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  core: string[],
  k: number,
  bounds: SolverBounds = {},
): Promise<string[]> {
  let current = [...new Set(core)].sort()
  for (const candidate of [...current]) {
    const trial = current.filter((id) => id !== candidate)
    if (trial.length < 2) continue
    const subset = reqTemporals.filter((r) => trial.includes(r.id))
    const solver = buildBoundedSolver(ctx, subset, k, bounds)
    if ((await solver.check(...trial.map((id) => ctx.Bool.const(id)))) === 'unsat') current = trial
  }
  return current
}
