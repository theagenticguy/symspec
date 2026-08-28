/**
 * Numeric contradiction detection (AC-30-3).
 *
 * Consumes the per-slot numeric predicates (AC-30-2), groups them by canonical
 * per-system quantity, and asks Z3 whether the conjunction of every requirement's
 * predicate on that quantity is jointly satisfiable. On `unsat`, the minimal
 * unsat core names exactly the culprit requirement ids — the same
 * assumption-literal-guard technique the propositional contradiction check uses
 * (`contradiction.ts`), so the two tiers report conflicts identically.
 *
 * ## Why per-quantity grouping
 *
 * Two predicates only conflict if they constrain the SAME quantity. "latency ≤
 * 200" and "retries ≤ 3" are independently satisfiable; grouping by quantity
 * before the solver call keeps each check tiny and the core precise. A quantity
 * with a single predicate can never self-conflict, so groups of size < 2 are
 * skipped without a solver call.
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

/**
 * Find numeric contradictions across a set of requirements' predicates.
 *
 * For each (quantity, base unit) referenced by ≥2 requirements, assert every
 * contributing requirement's predicate under its own guard literal and `check`.
 * On `unsat`, emit a finding naming the core's requirement ids. Bounds on one
 * quantity that normalized to DIFFERENT base units (including unitless vs
 * united) land in different groups and are never compared — see the module
 * header for why that is the only sound choice in a verdict-eligible tier.
 */
export async function findNumericContradictions(
  ctx: Z3Context,
  reqPreds: readonly RequirementPredicates[],
  bounds: SolverBounds = {},
): Promise<NumericContradictionFinding[]> {
  // Group ((quantity, baseUnit) → list of {id, predicate}), preserving a human
  // label and the bare quantity key for the evidence block.
  const byQuantity = new Map<
    string,
    {
      quantity: string
      label: string
      entries: Array<{ id: string; pred: NumericPredicate }>
    }
  >()
  for (const rp of reqPreds) {
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

  const findings: NumericContradictionFinding[] = []

  let checkedGroups = 0
  for (const { quantity, label, entries } of byQuantity.values()) {
    // AC-1-7 check-before-work: consult the whole-run deadline before starting a
    // group, never mid-group, so a group is either fully decided or not started.
    // A truncated sweep is a strict prefix, so it can only MISS a numeric
    // conflict — never invent one — and the pipeline demotes `verified` for it.
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('numeric-contradiction', byQuantity.size - checkedGroups)
      break
    }
    checkedGroups += 1
    // A quantity constrained by fewer than two requirements cannot self-conflict.
    const distinctIds = new Set(entries.map((e) => e.id))
    if (distinctIds.size < 2) continue

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

    const contributing = entries.filter((e) => culprits.includes(e.id))
    findings.push({
      code: 'FND_NUMERIC_CONTRADICTION',
      severity: 'error',
      requirementIds: [...culprits].sort(),
      message:
        `Requirements ${[...culprits].sort().join(', ')} place jointly unsatisfiable numeric ` +
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
            sourceText: e.pred.sourceText,
          })),
        },
      },
    })
  }

  return findings
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
