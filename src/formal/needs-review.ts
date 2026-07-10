/**
 * Per-group `unknown`/timeout → `FND_NEEDS_REVIEW`; whole-run budget →
 * `ERR_SOLVER_TIMEOUT` (AC-4-7).
 *
 * research-smt.md §2.3 and explore-solvers.md §3 draw a hard boundary that
 * this module exists to enforce:
 *
 *   - A PER-GROUP solver check that comes back `unknown` (which z3-solver
 *     also returns when a per-check `timeout` fires — there is no
 *     operationally distinguishable "timed out" vs "genuinely undecidable"
 *     signal on this API surface) is NEVER interpreted as "no conflict". It
 *     is reported as an info-severity `FND_NEEDS_REVIEW` finding naming that
 *     group's requirement ids, and the run CONTINUES to the next group.
 *   - The `ERR_SOLVER_TIMEOUT` error code is reserved STRICTLY for a
 *     WHOLE-RUN failure — the overall `--solver-budget-ms` wall-clock budget
 *     exhausted before every context group could be checked. That aborts the
 *     run with an error envelope; it is never raised for a single group.
 *
 * ## Relationship to `contradiction.ts` (AC-4-3)
 *
 * This module does not duplicate the contradiction detector's solver-driving
 * loop. It reuses `contradiction.ts`'s pure, solver-free grouping primitives
 * (`planContextGroups`, `contextAtomsOf`) to plan the SAME context groups —
 * the whole point of the AC-4-7 boundary is that it rides on the identical
 * group discipline AC-4-3 established (grouping mistakes there would be
 * grouping mistakes here too) — and adds the group→member-ids projection
 * `planContextGroups` deliberately omits (that projection has exactly one
 * consumer: naming a `FND_NEEDS_REVIEW` finding's `requirementIds`).
 *
 * The actual per-group SOLVER CHECK is behind an injectable {@link
 * GroupChecker} rather than hard-wired to a live `z3-solver` call, so a unit
 * test can FORCE the `unknown` outcome deterministically (per the spec's own
 * verification wording: "forced per-group timeout/unknown") without relying
 * on a genuinely hard SAT instance and real wall-clock timing, which would be
 * flaky. The default checker still runs a real solver check with the
 * `timeoutMs` per-group timeout, so `findNeedsReview` is directly usable
 * on its own, independent of `findContradictions`.
 */

import { atomize as realAtomize } from './atomize.js'
import type { Z3Context } from './backend.js'
import { getContext } from './backend.js'
import { type ContextGroup, contextAtomsOf, planContextGroups } from './contradiction.js'
import {
  type Atomize,
  type EncodableRequirement,
  type EncodedRequirement,
  encode,
  materialize,
  type Z3Bool,
} from './encode.js'

/** A live `z3-solver` Solver instance, as produced by {@link Z3Context}. */
type Z3Solver = InstanceType<Z3Context['Solver']>

/** A per-group needs-review finding (Appendix B `FND_NEEDS_REVIEW`, severity `info`). */
export interface NeedsReviewFinding {
  readonly code: 'FND_NEEDS_REVIEW'
  readonly severity: 'info'
  /** The context group's requirement ids, deduplicated and lexicographically sorted. */
  readonly requirementIds: string[]
  readonly message: string
}

/** `ERR_*` codes this module can raise. Just the one — the whole-run boundary case. */
export const NEEDS_REVIEW_ERROR_CODES = ['ERR_SOLVER_TIMEOUT'] as const
export type NeedsReviewErrorCode = (typeof NEEDS_REVIEW_ERROR_CODES)[number]

/**
 * Thrown by {@link findNeedsReview} when the overall `--solver-budget-ms`
 * wall-clock budget is exhausted before every context group could be
 * checked (AC-4-7). Carries the same `{error, code, suggestions}` shape as
 * the sibling `BinaryBackendError`/`LeanDiscoveryError` classes so the CLI
 * error-envelope layer (AC-6-2/AC-6-10) can handle it uniformly. This is a
 * WHOLE-RUN failure — never raised for a single inconclusive group, which is
 * always a `FND_NEEDS_REVIEW` finding instead (see module doc comment).
 */
export class SolverBudgetExceededError extends Error {
  readonly code: NeedsReviewErrorCode
  readonly suggestions: string[]

  constructor(message: string, suggestions: string[]) {
    super(message)
    this.name = 'SolverBudgetExceededError'
    this.code = 'ERR_SOLVER_TIMEOUT'
    this.suggestions = suggestions
  }
}

function budgetExceededError(solverBudgetMs: number): SolverBudgetExceededError {
  return new SolverBudgetExceededError(
    `Overall solver budget of ${solverBudgetMs}ms exhausted before every context group could be checked.`,
    ['Raise --solver-budget-ms to allow more time for the whole run.'],
  )
}

/**
 * Adapter from the AC-4-2a `atomize({ kind, text, systemName, negated })`
 * shape to the encoder's positional `Atomize` contract. Mirrors
 * `contradiction.ts`'s identical adapter (not exported there, so this is a
 * small, deliberate leaf-level duplication rather than a cross-file import
 * of a private helper).
 */
const defaultAtomize: Atomize = (kind, slotText, systemName, negated) => {
  const a = realAtomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}

/** A planned context group (AC-4-3's {@link ContextGroup}) plus its member requirement ids. */
export interface NeedsReviewGroup extends ContextGroup {
  /** Ids of the requirements whose context normalizes to exactly this group's key. */
  readonly memberIds: string[]
}

/** The sorted, deduplicated context-atom key for one encoded requirement (matches `planContextGroups`). */
function groupKeyOf(e: EncodedRequirement): string {
  return [...new Set(contextAtomsOf(e))].sort().join(' ')
}

/**
 * Plan the AC-4-3 context groups for a set of encoded requirements, with each
 * group's member requirement ids attached. Pure and solver-free — reuses
 * `contradiction.ts`'s `planContextGroups`/`contextAtomsOf` so the grouping
 * discipline is identical to the contradiction detector's, then projects the
 * member ids `planContextGroups` itself does not need.
 */
export function planNeedsReviewGroups(encoded: readonly EncodedRequirement[]): NeedsReviewGroup[] {
  return planContextGroups(encoded).map((group) => ({
    ...group,
    memberIds: encoded
      .filter((e) => groupKeyOf(e) === group.key)
      .map((e) => e.id)
      .sort(),
  }))
}

/** The solver verdict a per-group check can terminate on. */
export type GroupCheckStatus = 'sat' | 'unsat' | 'unknown'

/** Everything the default {@link GroupChecker} (and any override) needs to run one group's check. */
export interface GroupCheckContext {
  readonly ctx: Z3Context
  /** Every requirement's materialized `guard ⇒ body` formula (whole-spec, per AC-4-3). */
  readonly formulaAsts: readonly Z3Bool[]
  /** Every requirement's guard assumption literal, in the same order as `formulaAsts`. */
  readonly guardAsts: readonly Z3Bool[]
  /** The per-group solver timeout in ms. */
  readonly timeoutMs: number
}

/**
 * A per-group solver-check function. Injectable so a unit test can FORCE an
 * `unknown` (or any) outcome for a specific group deterministically, without
 * depending on real solver timing or a genuinely hard SAT instance.
 */
export type GroupChecker = (
  group: NeedsReviewGroup,
  helpers: GroupCheckContext,
) => Promise<GroupCheckStatus>

/**
 * Default {@link GroupChecker}: assert every requirement's whole-spec formula
 * plus this group's context atoms, then `check(...guardAsts)` under the
 * per-group timeout — the identical shape `contradiction.ts` uses for its own
 * per-group check (AC-4-3).
 */
const defaultGroupChecker: GroupChecker = async (
  group,
  { ctx, formulaAsts, guardAsts, timeoutMs },
): Promise<GroupCheckStatus> => {
  const solver: Z3Solver = new ctx.Solver()
  solver.set('timeout', timeoutMs)
  for (const f of formulaAsts) solver.add(f)
  for (const name of group.contextAtoms) solver.add(ctx.Bool.const(name))
  return solver.check(...guardAsts)
}

/** Options for {@link findNeedsReview}. */
export interface FindNeedsReviewOptions {
  /** Atom-table function (AC-4-2a). Defaults to the real `atomize`; injectable for tests. */
  atomize?: Atomize
  /** Per-group solver timeout in ms (research-smt.md §2.3). Default 2000. */
  timeoutMs?: number
  /**
   * Overall wall-clock budget in ms across every group's check
   * (`--solver-budget-ms`, research-smt.md §2.3). `undefined` (default)
   * means no whole-run budget is enforced — only per-group `timeoutMs`
   * applies.
   */
  solverBudgetMs?: number
  /**
   * Injectable clock for deterministic whole-run-budget tests (per the
   * spec's own "forced whole-run budget exhaustion" verification wording).
   * Defaults to `Date.now`.
   */
  now?: () => number
  /** Injectable per-group checker; defaults to {@link defaultGroupChecker}. */
  checkGroup?: GroupChecker
}

/**
 * Detect per-group solver inconclusiveness across a whole spec (AC-4-7).
 *
 * For each AC-4-3 context group (baseline + every distinct context-atom
 * set), runs the group's solver check. A group whose check returns
 * `unknown` — including one that hit the per-group `timeoutMs` — is reported
 * as an info-severity `FND_NEEDS_REVIEW` finding naming that group's
 * requirement ids, and the loop CONTINUES to the next group: an inconclusive
 * result is never treated as "no conflict" AND never aborts the run.
 *
 * Before each group's check, the cumulative elapsed wall-clock time is
 * compared against `options.solverBudgetMs` (when supplied). Once that
 * whole-run budget is exhausted, {@link findNeedsReview} throws {@link
 * SolverBudgetExceededError} (`ERR_SOLVER_TIMEOUT`) and the run ABORTS —
 * this is the one and only whole-run failure boundary AC-4-7 defines; it is
 * never raised for a single group's `unknown`/timeout.
 */
export async function findNeedsReview(
  reqs: readonly EncodableRequirement[],
  options: FindNeedsReviewOptions = {},
): Promise<NeedsReviewFinding[]> {
  if (reqs.length === 0) return []

  const atomize = options.atomize ?? defaultAtomize
  const timeoutMs = options.timeoutMs ?? 2000
  const now = options.now ?? Date.now
  const checkGroup = options.checkGroup ?? defaultGroupChecker
  const solverBudgetMs = options.solverBudgetMs

  const encoded = reqs.map((r) => encode(r, atomize))
  const ctx = await getContext('symspec-needs-review')

  const formulaAsts = encoded.map((e) => materialize(ctx, e.formula))
  const guardAsts = encoded.map((e) => ctx.Bool.const(e.guard))

  const groups = planNeedsReviewGroups(encoded)
  const start = now()

  const findings: NeedsReviewFinding[] = []

  for (const group of groups) {
    if (solverBudgetMs !== undefined && now() - start > solverBudgetMs) {
      throw budgetExceededError(solverBudgetMs)
    }

    const status = await checkGroup(group, { ctx, formulaAsts, guardAsts, timeoutMs })
    if (status !== 'unknown') continue
    if (group.memberIds.length === 0) continue // baseline group with no ubiquitous members: nothing to name

    findings.push({
      code: 'FND_NEEDS_REVIEW',
      severity: 'info',
      requirementIds: group.memberIds,
      message:
        `Per-group solver check for ${group.memberIds.join(', ')} returned unknown or ` +
        'exceeded the per-group timeout; never interpreted as "no conflict" (AC-4-7).',
    })
  }

  return findings
}
