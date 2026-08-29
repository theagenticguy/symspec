/**
 * Numeric contradiction detection (AC-30-3).
 *
 * Consumes the per-slot numeric predicates (AC-30-2), sorts them into
 * (reachable context, canonical per-system quantity, base unit) cells, and asks Z3
 * whether the conjunction of every CO-LIVE requirement's predicate in a cell is
 * jointly satisfiable. On `unsat`, the minimal unsat core names exactly the
 * culprit requirement ids — the same assumption-literal-guard technique the
 * propositional contradiction check uses (`contradiction.ts`), so the two tiers
 * report conflicts identically.
 *
 * ## Why per-quantity grouping
 *
 * Two predicates only conflict if they constrain the SAME quantity. "latency ≤
 * 200" and "retries ≤ 3" are independently satisfiable; grouping by quantity
 * before the solver call keeps each check tiny and the core precise.
 *
 * ## Why the sweep is (context group) × (quantity, baseUnit)
 *
 * A requirement's bound holds where its GUARD holds. Asserting every
 * requirement's bounds on one quantity as simultaneous facts is the "assert all
 * triggers true at once" pattern `contradiction.ts` names unacceptable in its own
 * header, and it fabricated an error-severity FND_NUMERIC_CONTRADICTION: `While
 * the temperature is above 5 degrees celsius, open the vent` and `While the
 * temperature is below 3 degrees celsius, close the vent` are two mutually
 * exclusive antecedents, and handing Z3 `temp > 5 ∧ temp < 3` proves a conflict
 * the document does not contain.
 *
 * So the sweep runs per CONTEXT GROUP — the same distinct-guard-atom-set partition
 * `planContextGroups` builds for the propositional tier, planned by the same
 * `planGroups` over this tier's own per-requirement contexts — and within a group
 * only the requirements that are `liveIn` it contribute. Two disjoint guards in the
 * same slot kind produce two groups, each hosting one requirement, and a cell with
 * fewer than two distinct requirement ids never reaches the solver.
 *
 * DIRECTION: this SPLITS, and the two halves of that claim are not equally strong.
 *
 *   - SAFETY holds unconditionally. Every cell's assertion set is a SUBSET of the
 *     single global set one pass per (quantity, baseUnit) would have fed the solver,
 *     and unsat is monotone under supersets, so anything a cell proves unsat the
 *     global set proved unsat too. The partition cannot invent a conflict.
 *   - The COUNT can rise. One global pass per quantity reports one core per
 *     quantity; the partition can hand two cells two DIFFERENT minimal cores, and
 *     each becomes its own finding. Measured through `findNumericContradictions`:
 *     one quantity, `r1`/`r2` guarded by the same atom with `>=1000`/`<=500` and
 *     `r8`/`r9` unconditional with `>=100`/`<=10`, yields TWO findings where a
 *     single cell yields one. Both are real conflicts, so `counts.error` going up
 *     is a precision gain, not a fabrication — but "can only remove findings" is
 *     false and must not be relied on.
 *
 * A ubiquitous requirement has an empty guard, `[] ⊆ anything`, so it stays live in
 * every group; an all-unconditional document therefore has the one baseline group
 * and exactly one cell per (quantity, baseUnit).
 *
 * ## Why the group is (quantity, baseUnit) and NOT quantity alone
 *
 * A quantity key names the *thing* being bounded; `baseUnit` names the scale the
 * value was normalized onto (`''` = unitless, magnitude UNKNOWN). Two bounds are
 * only arithmetically comparable when they landed on the SAME base — so the
 * comparison group is the pair, and predicates whose `baseUnit` differs go into
 * separate solver calls and are never asserted together.
 *
 * Without that partition the tier fabricated an error-severity false positive
 * (the cardinal sin under sound-modulo-atomization): "respond within 5" (unitless,
 * value 5) and "respond over 2000 ms" (value 2000) share the label "respond", so
 * they shared a quantity key and Z3 was handed `q <= 5 ∧ q > 2000` → UNSAT. But 5
 * *seconds* is 5000 ms — strictly greater than 2000 ms — and there is no conflict
 * at all. The unitless bound's magnitude is simply unknown; ASSUMING a unit for it
 * (either direction) would fabricate a magnitude, so the only sound move is to
 * decline the comparison. Declining is a MISS — the honest failure direction —
 * whereas comparing invents a verdict. This mirrors the guard the propose-only
 * quantity-alias tier already had (`quantity-alias.ts`: `if (pa.baseUnit !==
 * pb.baseUnit) continue`); the DECIDE tier, where a false positive is
 * unrecoverable, must be at least as strict as the tier that may only suggest.
 *
 * The group is PARTITIONED, not skipped: a quantity carrying both a unitless and
 * an `ms` bound still has its `ms` bounds proved against each other. Skipping the
 * whole quantity would trade one false positive for a new false negative.
 *
 * The emitted `evidence.numeric.quantity` stays the bare quantity key — the unit
 * is already reported per predicate as `unit` — so a genuine same-unit conflict's
 * evidence is byte-identical to before this partition existed.
 *
 * ## Determinism
 *
 * LIA/LRA is convex + decidable; Z3's SAT/UNSAT verdict and unsat core are
 * reproducible. This tier introduces no approximation — it is verdict-eligible
 * (`error`), unlike the fuzzy propose-only tiers.
 *
 * Reproducible means reproducible from the requirement SET, which is stronger than
 * reproducible from an identical call. WHICH minimal core Z3 returns is a function
 * of the sequence it was fed, and a quantity can admit more than one, so the
 * predicates are asserted in id order rather than document order — otherwise the
 * blamed requirement would be a function of its line number.
 */

import type { Z3Context } from './backend.ts'
import type { SolverBounds } from './budget.ts'
import { liveIn, planGroups } from './contradiction.ts'
import { cmp, materialize } from './encode.ts'
import type { Evidence } from './finding.ts'
import type { NumericPredicate } from './numeric.ts'

/** A numeric-contradiction finding (Appendix B `FND_NUMERIC_CONTRADICTION`, error). */
export interface NumericContradictionFinding {
  readonly code: 'FND_NUMERIC_CONTRADICTION'
  readonly severity: 'error'
  /** The culprit requirement ids, from the minimal unsat core. */
  readonly requirementIds: string[]
  readonly message: string
  /** AC-4-6 evidence: empty atom table (numeric tier is arithmetic, not atoms) + the numeric block. */
  readonly evidence: Evidence
}

/** One requirement's numeric predicates, tagged with the owning requirement id. */
export interface RequirementPredicates {
  readonly id: string
  /**
   * The requirement's GUARD atoms — the context its predicates hold under, in the
   * same projection `contradiction.ts`'s `contextAtomsOf` returns.
   *
   * Required, with no default: `[]` reads as "unconditional, therefore live in
   * every context group", which is the COARSEST possible reading and the one that
   * co-asserts bounds no requirement placed together. A caller that cannot supply
   * the context has to say so by writing `[]`.
   */
  readonly contextAtoms: readonly string[]
  readonly predicates: readonly NumericPredicate[]
}

/**
 * Group key for the comparison partition: the canonical quantity PLUS the base
 * unit its value was normalized onto. `|` cannot occur in either component
 * (`quantityKey` emits `[a-z0-9_]`, `baseUnit` is a `DIMENSIONS` base or `''`),
 * so the join is unambiguous.
 *
 * Units are part of the key rather than a post-hoc filter because comparability
 * is a property of the pair, not of one predicate: `ms` bounds are mutually
 * comparable, unitless bounds are mutually comparable, and the two sets never
 * mix. Keying makes that partition total — every predicate lands in exactly one
 * arithmetically-coherent group.
 */
function comparisonKey(pred: NumericPredicate): string {
  return `${pred.quantity}|${pred.baseUnit}`
}

/** One (context group, quantity, base unit) cell: the bounds that genuinely co-hold. */
export interface ComparisonCell {
  /** The {@link comparisonKey} this cell is the arithmetic partition of. */
  readonly key: string
  /** The bare quantity key, for the evidence block. */
  readonly quantity: string
  /** The human quantity label, for the evidence block and the message. */
  readonly label: string
  /** The live requirements' predicates, in document order (the evidence order). */
  readonly entries: ReadonlyArray<{ id: string; pred: NumericPredicate }>
  /** The distinct requirement ids contributing to the cell — always ≥2. */
  readonly distinctIds: ReadonlySet<string>
}

/**
 * Plan every cell the solver will be asked about: one per
 * (context group × quantity × base unit) that ≥2 co-live requirements constrain.
 *
 * Pure and solver-free, so the partition is unit testable without a WASM boot, and
 * so the whole-run budget can be told exactly how many cells went unrun.
 *
 * Two groups can host the SAME set of live requirements for a quantity — a
 * ubiquitous pair is live in every group — and re-checking that cell would spend a
 * solver call to emit a duplicate finding. Cells are therefore keyed on
 * (comparison key, live id set), which is exactly the input the solver call is a
 * function of. `entries` is built by walking `reqPreds` in order, so the retained
 * cell's evidence is in document order regardless of which group reached it first.
 *
 * EXPORTED for its own gate. Collapsing duplicate cells has no effect on the emitted
 * findings — the finding map de-duplicates a repeated core anyway — so its only
 * observables are the solver-call count and the `budget.truncate` skipped figure, and
 * a test driving `findNumericContradictions` cannot tell this key's presence from its
 * absence. The cell list is that observable, and `numeric-contradiction.test.ts`
 * asserts on it directly rather than leaving a mechanism no test can reach.
 */
export function planComparisonCells(reqPreds: readonly RequirementPredicates[]): ComparisonCell[] {
  const cells: ComparisonCell[] = []
  const seen = new Set<string>()
  for (const group of planGroups(reqPreds.map((rp) => rp.contextAtoms))) {
    // (quantity, baseUnit) → the live bounds on it, preserving a human label and
    // the bare quantity key for the evidence block.
    const byQuantity = new Map<
      string,
      {
        quantity: string
        label: string
        entries: Array<{ id: string; pred: NumericPredicate }>
      }
    >()
    for (const rp of reqPreds) {
      // A requirement whose guard is not fully asserted in this group is not live
      // here, and its bounds are not facts here.
      //
      // The exact reach of that fence, because it is narrower than "mutually
      // exclusive guards never meet". A group is some ONE requirement's guard-atom
      // set (plus the baseline), and `liveIn` is a SUBSET test. So two exclusive
      // guards in the same slot kind can never share a group — a requirement has
      // one `preCondition` and one `trigger`, so nothing can name both spellings of
      // one slot — but a requirement that names one in `preCondition` and the other
      // in `trigger` mints a group containing BOTH atoms, and the two single-guard
      // requirements are then co-live there.
      //
      // That bridge is an OPEN fabrication surface this tier does not fence.
      // Measured through `runCheck`: `While the temperature is above 5 degrees
      // celsius, the vent controller shall open the vent.` + `When the temperature
      // is below 3 degrees celsius, the vent controller shall close the vent.` +
      // `While the temperature is above 5 degrees celsius, when the temperature is
      // below 3 degrees celsius, the vent controller shall log the fault.` reports
      // FND_NUMERIC_CONTRADICTION at error severity naming the first two, which do
      // not conflict. The bridging requirement's guard is arithmetically
      // unsatisfiable — it is vacuous, and `FND_VACUITY` says so on the same run —
      // so the document contains no requirement conflict at all. Fencing it needs a
      // per-group feasibility check on the guard bounds, which no code path here
      // performs; `src/testing/fabrication.ts` carries the document as a
      // known-open case so the gap has a name and a reproducer.
      if (!liveIn(group, rp.contextAtoms)) continue
      for (const pred of rp.predicates) {
        const key = comparisonKey(pred)
        let g = byQuantity.get(key)
        if (g === undefined) {
          g = { quantity: pred.quantity, label: pred.label, entries: [] }
          byQuantity.set(key, g)
        }
        g.entries.push({ id: rp.id, pred })
      }
    }
    for (const [key, g] of byQuantity) {
      const distinctIds = new Set(g.entries.map((e) => e.id))
      // A cell needs two contributors to be worth a solver call, and the reason is
      // narrower than it looks. One requirement CAN carry two opposed bounds on one
      // key — two guard slots do it: `While the temperature is above 5 degrees
      // celsius, when the temperature is below 3 degrees celsius, …` puts `> 5` and
      // `< 3` on the quantity `temperature` from `pre` and `trig`. (A response-slot
      // example does not: `keep the temperature below 3` labels the quantity `keep
      // the temperature`, a different key from the guard's `temperature`, so those
      // two bounds never meet in one cell.)
      //
      // Such a requirement IS reported. `minimizeNumericCore` refuses to SHRINK a
      // core below two ids, but it does not constrain the core it is handed: a core
      // that already names one id passes through, and `culprits` keeps it. Measured
      // through `runCheck`, the two-requirement document above plus `While the
      // temperature is above 5 degrees celsius, the vent controller shall open the
      // vent.` emits FND_NUMERIC_CONTRADICTION at error severity with a
      // SINGLE-id `requirementIds` and a message reading `Requirements <one id>
      // place jointly unsatisfiable …`.
      //
      // So this skip only hides the case where the self-conflicting requirement is
      // the cell's ONLY contributor. What that leaves genuinely open is a different
      // gap: a self-inconsistent guard is a VACUOUS requirement, and reporting it as
      // an error-severity numeric contradiction (rather than as the `FND_VACUITY`
      // the same run also emits) overstates it. A one-id finding cannot CERTIFY a
      // run — check.ts's `decideTierCrossReqFired` requires ≥2 ids — but it does
      // suppress the `FND_NO_PAIRS_CHECKED` disclaimer, through this code's
      // membership in `CROSS_REQUIREMENT_FND_CODES` rather than through the id count.
      if (distinctIds.size < 2) continue
      const cellKey = JSON.stringify([key, [...distinctIds].sort()])
      if (seen.has(cellKey)) continue
      seen.add(cellKey)
      cells.push({ key, quantity: g.quantity, label: g.label, entries: g.entries, distinctIds })
    }
  }
  return cells
}

/**
 * Find numeric contradictions across a set of requirements' predicates.
 *
 * For each (context group, quantity, base unit) cell constrained by ≥2 co-live
 * requirements, assert every contributing requirement's predicate under its own
 * guard literal and `check`. On `unsat`, emit a finding naming the core's
 * requirement ids. Bounds on one quantity that normalized to DIFFERENT base units
 * (including unitless vs united) land in different cells and are never compared —
 * see the module header for why that, and the context partition, are the only sound
 * choices in a verdict-eligible tier.
 */
export async function findNumericContradictions(
  ctx: Z3Context,
  reqPreds: readonly RequirementPredicates[],
  bounds: SolverBounds = {},
): Promise<NumericContradictionFinding[]> {
  const cells = planComparisonCells(reqPreds)
  // Keyed by (comparison key, culprit ids), because two cells can reach the same
  // conflict: a nested pair of context groups hosts overlapping live sets, and a
  // ubiquitous pair is live in every group, so the same core is provable more than
  // once. One conflict is one finding — the same `unique.join(',')` de-duplication
  // `findContradictions` applies across its own group loop.
  const findings = new Map<string, NumericContradictionFinding>()

  let checkedCells = 0
  for (const { key, quantity, label, entries, distinctIds } of cells) {
    // AC-1-7 check-before-work: consult the whole-run deadline before starting a
    // cell, never mid-cell, so a cell is either fully decided or not started.
    // A truncated sweep is a strict prefix, so it can only MISS a numeric
    // conflict — never invent one — and the pipeline demotes `verified` for it.
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('numeric-contradiction', cells.length - checkedCells)
      break
    }
    checkedCells += 1

    // The solver-facing sequence is id-sorted, never document-ordered: a quantity
    // can admit more than one minimal unsat core (`lag >= 100` conflicts with
    // `lag <= 10` and with `lag <= 20` independently, while the two upper bounds
    // co-hold), and which one `unsatCore()` names is a function of the sequence
    // the solver was fed. `requirementIds` and the ids in `message` are output
    // bytes, so a document-ordered sequence would make the blamed requirement a
    // function of file position — move a bound up three lines and a different one
    // is named. `entries` itself stays in document order, because the evidence
    // block below should list predicates the way the document does.
    const solverEntries = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const solver = new ctx.Solver()
    // AC-1-7: bound this group's solve. A timeout returns `unknown`, which the
    // `res !== 'unsat'` guard below already treats as "no conflict proved" — so
    // the timeout can only withhold an error-severity finding, never emit one.
    if (bounds.timeoutMs !== undefined) solver.set('timeout', bounds.timeoutMs)
    // Assert each predicate implied by its requirement guard, so the unsat core
    // is exactly the set of requirement ids whose predicates cannot co-hold.
    for (const { id, pred } of solverEntries) {
      const guard = ctx.Bool.const(id)
      const predFormula = materialize(ctx, cmp(pred.quantity, pred.comparator, pred.value))
      solver.add(ctx.Implies(guard, predFormula))
    }
    const guards = [...distinctIds].sort().map((id) => ctx.Bool.const(id))
    const res = await solver.check(...guards)
    if (res !== 'unsat') continue

    // Map the unsat core back to requirement ids; minimize by deletion so an
    // innocent requirement sharing the quantity cannot ride along.
    // Z3 renders a symbol whose text is not a legal SMT-LIB2 *simple* symbol
    // (e.g. a UUID starting with a digit) as a `|...|`-quoted symbol, so the
    // core member comes back quoted; strip the delimiters before matching.
    const coreIds: string[] = []
    for (const c of solver.unsatCore()) {
      const name = c.toString().replace(/^\|(.*)\|$/, '$1')
      if (distinctIds.has(name)) coreIds.push(name)
    }
    const minimal = await minimizeNumericCore(ctx, solverEntries, coreIds, bounds)
    const culprits = minimal.length > 0 ? minimal : [...distinctIds]

    const blamed = [...culprits].sort()
    const findingKey = JSON.stringify([key, blamed])
    if (findings.has(findingKey)) continue

    const contributing = entries.filter((e) => culprits.includes(e.id))
    findings.set(findingKey, {
      code: 'FND_NUMERIC_CONTRADICTION',
      severity: 'error',
      requirementIds: blamed,
      message:
        `Requirements ${blamed.join(', ')} place jointly unsatisfiable numeric ` +
        `constraints on "${label}".`,
      evidence: {
        atomTable: [],
        numeric: {
          quantity,
          label,
          predicates: contributing.map((e) => ({
            requirementId: e.id,
            comparator: e.pred.comparator,
            value: e.pred.value,
            unit: e.pred.baseUnit,
            slot: e.pred.slot,
            sourceText: e.pred.sourceText,
          })),
        },
      },
    })
  }

  return [...findings.values()]
}

/**
 * Deletion-based core minimization: drop each id and re-check; if still unsat
 * without it, it was not load-bearing. Yields a smallest still-unsat subset.
 *
 * `bounds.timeoutMs` bounds each re-check (AC-1-7). A re-check that times out
 * returns `unknown`, and the `=== 'unsat'` test below KEEPS the candidate — the
 * conservative direction, identical to `contradiction.ts`'s `minimizeCore`
 * treatment of `unknown`: a guard is only dropped on positive proof that it was
 * inessential, so a timeout can only leave the blame set larger, never wrongly
 * exonerate a culprit.
 *
 * The whole-run budget is deliberately NOT consulted here. Minimization runs only
 * AFTER a group already proved `unsat`, and abandoning it midway would report a
 * wider (less precise) culprit set for a conflict that is already established.
 * The budget bounds which groups get CHECKED (the caller's loop); once a finding
 * is owed, it is reported at full precision.
 *
 * The visit order is canonicalized on requirement id for the same reason
 * `contradiction.ts`'s `minimizeCore` does it: a quantity can admit more than
 * one minimal core (`lag >= 100` conflicts with `lag <= 10` and with `lag <= 20`
 * independently, while the two upper bounds co-hold), and deletion keeps whichever
 * the input order reaches. The culprit ids are output bytes.
 *
 * The scope of that, exactly: measured on this z3-solver build, `core` arrives from
 * `unsatCore()` already irreducible at two ids — this tier sets no
 * `smt.core.minimize`, so that is the default core, not an option's work — and the
 * `trial.length < 2` guard then deletes nothing. Which minimal core is reported is
 * therefore settled by the sequence {@link findNumericContradictions} feeds the
 * solver, which is why that sequence is id-sorted. This sort is the second line of
 * defence, holding if a solver returns the same core in a different order or a core
 * wide enough to shrink.
 */
export async function minimizeNumericCore(
  ctx: Z3Context,
  entries: ReadonlyArray<{ id: string; pred: NumericPredicate }>,
  core: readonly string[],
  bounds: SolverBounds = {},
): Promise<string[]> {
  let current = [...new Set(core)].sort()
  for (const candidate of [...current]) {
    const trial = current.filter((id) => id !== candidate)
    if (trial.length < 2) continue
    const solver = new ctx.Solver()
    if (bounds.timeoutMs !== undefined) solver.set('timeout', bounds.timeoutMs)
    for (const { id, pred } of entries) {
      if (!trial.includes(id)) continue
      const guard = ctx.Bool.const(id)
      solver.add(
        ctx.Implies(guard, materialize(ctx, cmp(pred.quantity, pred.comparator, pred.value))),
      )
    }
    const guards = trial.map((id) => ctx.Bool.const(id))
    if ((await solver.check(...guards)) === 'unsat') current = trial
  }
  return current
}
