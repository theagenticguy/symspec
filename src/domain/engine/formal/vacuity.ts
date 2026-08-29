/**
 * Relational vacuity over the whole spec (AC-4-5).
 *
 * A requirement is *vacuous* when its guard (the context that makes it fire)
 * can never hold given the rest of the spec — so the requirement is dead code.
 *
 * ## Why relational, not "unsatisfiable guard"
 *
 * A guard atom, or a conjunction of DISTINCT guard atoms, is ALWAYS satisfiable
 * in isolation — there is always a model that sets them all true. So vacuity is
 * emphatically NOT "the guard is unsat" (AC-4-5 forbids that formally-wrong
 * clause). Instead it is relational: assert every OTHER requirement's body plus
 * this requirement's context/guard literals, and check for `unsat`. `unsat`
 * means no model of the rest of the spec lets this guard hold — the guard is
 * unreachable, the requirement vacuous.
 *
 * ## Why it is narrow, and who it blames
 *
 * `kind` is part of atom identity — `renderAtom` writes `sys__<scope>__<kind>__<body>` — so a
 * RESPONSE atom is never a PRECONDITION atom, and no response can contradict a guard by naming
 * the same condition. One shape is left: two OTHER requirements force a single `resp` atom at
 * OPPOSITE polarity, and each of their context sets is a subset of the target's, so asserting
 * the target's guard activates both and the conjunction goes `unsat`.
 *
 * The finding therefore names the requirement whose guard was asserted, while the contradiction
 * lives entirely in the other two — a bystander, told its rule can never fire. Findings are
 * emitted at `confidence: 'low'` and `warn` severity (Appendix B `FND_VACUITY`), so this never
 * reaches an exit code. `vacuity.test.ts` pins both the path and the misattribution.
 *
 * ## Purity boundary
 *
 * Atomizer-agnostic: consumes {@link EncodedRequirement}s (from the pure
 * {@link encode}) and a {@link Z3Context}, touching the solver only via
 * {@link materialize}. It never imports `atomize.ts` or `z3-solver` directly.
 */

import type { Z3Context } from './backend.ts'
import type { SolverBounds } from './budget.ts'
import { and, atom, type EncodedRequirement, type Formula, materialize } from './encode.ts'

/** A relational vacuity finding (Appendix B `FND_VACUITY`, warn, low confidence). */
export interface VacuityFinding {
  code: 'FND_VACUITY'
  severity: 'warn'
  /** Labeled lower confidence — this heuristic is narrow under regex parsing (AC-4-5). */
  confidence: 'low'
  /** The requirement whose guard is unreachable given the rest of the spec. */
  requirementId: string
  message: string
}

/**
 * The guard literals of an encoded requirement: the context atoms (precondition
 * / trigger) that must hold for the requirement to fire. Ubiquitous requirements
 * have no context slots and therefore no guard — they are never vacuity
 * candidates (a bare `R` always "fires"). Returns `undefined` for those.
 */
function guardLiterals(e: EncodedRequirement): Formula | undefined {
  const contextAtoms = e.atoms.filter((row) => row.kind !== 'resp')
  if (contextAtoms.length === 0) return undefined
  const lits = contextAtoms.map((row) => (row.negated ? notAtom(row.atom) : atom(row.atom)))
  return and(lits)
}

/** Local negated-atom constructor (avoids importing `not` just for one call site). */
function notAtom(name: string): Formula {
  return { op: 'not', arg: atom(name) }
}

/**
 * Check a single requirement for relational vacuity against the whole spec.
 * Returns `undefined` when the requirement has no guard, when the guard is
 * reachable (`sat`), or when the solver is inconclusive (`unknown` — never
 * reported as vacuous).
 *
 * `bounds.timeoutMs` bounds this check's single solve (AC-1-7). The existing
 * `res !== 'unsat'` guard already treats the `unknown` a timeout produces
 * conservatively (no finding), so a per-solver timeout can only withhold a
 * vacuity finding, never manufacture one.
 */
export async function checkVacuityOf(
  ctx: Z3Context,
  target: EncodedRequirement,
  all: readonly EncodedRequirement[],
  bounds: SolverBounds = {},
): Promise<VacuityFinding | undefined> {
  const guard = guardLiterals(target)
  if (guard === undefined) return undefined

  const solver = new ctx.Solver()
  if (bounds.timeoutMs !== undefined) solver.set('timeout', bounds.timeoutMs)
  // Assert every OTHER requirement's body (its behavioural constraint, minus the
  // per-req assumption guard which is irrelevant here).
  for (const other of all) {
    if (other.id === target.id) continue
    solver.add(materialize(ctx, other.body))
  }
  // Assert this requirement's guard holds. unsat ⇒ unreachable ⇒ vacuous.
  solver.add(materialize(ctx, guard))

  const res = await solver.check()
  if (res !== 'unsat') return undefined

  return {
    code: 'FND_VACUITY',
    severity: 'warn',
    confidence: 'low',
    requirementId: target.id,
    message: `${target.id}'s guard is unreachable given the rest of the spec; the requirement can never fire (low confidence — regex-level heuristic).`,
  }
}

/**
 * Run relational vacuity over the whole spec, one guarded requirement at a time.
 * Whole-spec (not pairwise): every other requirement participates in each check,
 * because a guard's unreachability can be forced by any combination of other
 * requirements' responses (AC-4-5, research-smt.md §1.5).
 *
 * Bounded per AC-1-7: `bounds.timeoutMs` bounds each per-requirement solve, and
 * `bounds.budget` is the whole-run deadline, consulted BEFORE each requirement's
 * check so a check never half-runs past it. On truncation the unrun requirement
 * count lands on the budget ledger and the pipeline demotes `verified` — a
 * truncated sweep never passes as a completed one.
 */
export async function checkVacuity(
  ctx: Z3Context,
  all: readonly EncodedRequirement[],
  bounds: SolverBounds = {},
): Promise<VacuityFinding[]> {
  const findings: VacuityFinding[] = []
  for (const [index, target] of all.entries()) {
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('vacuity', all.length - index)
      break
    }
    const finding = await checkVacuityOf(ctx, target, all, bounds)
    if (finding !== undefined) findings.push(finding)
  }
  return findings
}
