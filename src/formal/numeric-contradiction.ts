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
 * ## Determinism
 *
 * LIA/LRA is convex + decidable; Z3's SAT/UNSAT verdict and unsat core are
 * reproducible. This tier introduces no approximation — it is verdict-eligible
 * (`error`), unlike the fuzzy propose-only tiers.
 */

import type { Z3Context } from './backend.js'
import { cmp, materialize } from './encode.js'
import type { Evidence } from './finding.js'
import type { NumericPredicate } from './numeric.js'

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
 * Find numeric contradictions across a set of requirements' predicates.
 *
 * For each quantity referenced by ≥2 requirements, assert every contributing
 * requirement's predicate under its own guard literal and `check`. On `unsat`,
 * emit a finding naming the core's requirement ids.
 */
export async function findNumericContradictions(
  ctx: Z3Context,
  reqPreds: readonly RequirementPredicates[],
): Promise<NumericContradictionFinding[]> {
  // Group (quantity → list of {id, predicate}), preserving a human label.
  const byQuantity = new Map<
    string,
    { label: string; entries: Array<{ id: string; pred: NumericPredicate }> }
  >()
  for (const rp of reqPreds) {
    for (const pred of rp.predicates) {
      let g = byQuantity.get(pred.quantity)
      if (g === undefined) {
        g = { label: pred.label, entries: [] }
        byQuantity.set(pred.quantity, g)
      }
      g.entries.push({ id: rp.id, pred })
    }
  }

  const findings: NumericContradictionFinding[] = []

  for (const [quantity, { label, entries }] of byQuantity) {
    // A quantity constrained by fewer than two requirements cannot self-conflict.
    const distinctIds = new Set(entries.map((e) => e.id))
    if (distinctIds.size < 2) continue

    const solver = new ctx.Solver()
    // Assert each predicate implied by its requirement guard, so the unsat core
    // is exactly the set of requirement ids whose predicates cannot co-hold.
    for (const { id, pred } of entries) {
      const guard = ctx.Bool.const(id)
      const predFormula = materialize(ctx, cmp(pred.quantity, pred.comparator, pred.value))
      solver.add(ctx.Implies(guard, predFormula))
    }
    const guards = [...distinctIds].map((id) => ctx.Bool.const(id))
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
    const minimal = await minimizeNumericCore(ctx, entries, coreIds)
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
 */
async function minimizeNumericCore(
  ctx: Z3Context,
  entries: ReadonlyArray<{ id: string; pred: NumericPredicate }>,
  core: string[],
): Promise<string[]> {
  let current = [...new Set(core)]
  for (const candidate of [...current]) {
    const trial = current.filter((id) => id !== candidate)
    if (trial.length < 2) continue
    const solver = new ctx.Solver()
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
