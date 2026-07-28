/**
 * The whole-run solver deadline shared by every solver-driving tier (AC-1-7).
 *
 * Two knobs bound a `check` run, and they are different things:
 *
 *   - `--timeout-ms` is a PER-SOLVER timeout handed to `solver.set('timeout', …)`.
 *     It bounds ONE `check()` call. A solver that hits it returns `unknown`,
 *     which every tier already treats conservatively (never a finding, never
 *     "no conflict") — see the `unknown` handling at `subsumption.ts`'s
 *     `implies`, `incomplete.ts`'s `res !== 'sat'` guard, and
 *     `contradiction.ts`'s `minimizeCore`. A per-solver timeout therefore
 *     cannot manufacture a finding; it can only withhold one.
 *   - `--solver-budget-ms` is a WHOLE-RUN wall-clock deadline across every
 *     tier. It is what this module owns.
 *
 * ## Why a shared mutable object rather than a deadline number
 *
 * A bare deadline would bound the run but leave no trace, and a run that
 * stopped early must not be able to claim it compared everything. So the budget
 * doubles as the truncation LEDGER: a tier that stops early calls
 * {@link SolverBudget.truncate}, and the pipeline turns every recorded
 * truncation into a `solver-budget-exhausted` coverage demotion, which forces
 * `verified` to `false` (`src/pipeline/check.ts`). Silence about a truncation
 * would be exactly the "per-tier counter behind a whole-run claim" failure the
 * coverage-disclaimer lesson warns about.
 *
 * ## The check-BEFORE-work discipline
 *
 * Every consumer calls {@link SolverBudget.expired} *before* starting a unit of
 * work, never in the middle of one — the pattern `findNeedsReview` established
 * (`src/formal/needs-review.ts:242-244`). A unit therefore never partially runs
 * past the deadline, so a truncated run is always a PREFIX of the untruncated
 * run: the findings it did emit are exactly the findings the full run would have
 * emitted for those units. Truncation can only cause false NEGATIVES (a conflict
 * that was never looked for), never a false positive.
 *
 * ## Relationship to `ERR_SOLVER_TIMEOUT`
 *
 * This module never throws. `ERR_SOLVER_TIMEOUT` stays reserved for the one
 * whole-run abort `findNeedsReview` raises (`SolverBudgetExceededError`,
 * `src/formal/needs-review.ts:78`), which the pipeline reaches by handing that
 * tier the REMAINING budget while some remains. Tier truncation is the ordinary,
 * reportable outcome; the error envelope is the extreme one. Neither can report
 * `verified: true`.
 */

/** One tier's record of stopping early because the whole-run deadline passed. */
export interface BudgetTruncation {
  /** The tier that stopped, e.g. `'subsumption'`. Stable, used in the demotion action text. */
  readonly tier: string
  /**
   * How many units of work (pairs, requirements, groups) the tier did NOT run.
   * `0` is legal and meaningful: the tier was skipped entirely before its first
   * unit, and the count of units was not knowable to it.
   */
  readonly skipped: number
}

/** Options for {@link SolverBudget}. */
export interface SolverBudgetOptions {
  /**
   * Injectable clock, defaulting to `Date.now`. Mirrors
   * {@link import('./needs-review.js').FindNeedsReviewOptions.now} so a test can
   * force deadline exhaustion deterministically instead of sleeping.
   */
  now?: () => number
}

/**
 * A whole-run wall-clock deadline plus the ledger of tiers that hit it.
 *
 * The clock starts at construction, so the pipeline constructs it immediately
 * before the first solver tier — the budget measures SOLVER time, not document
 * load or lint time, which no solver knob governs.
 */
export class SolverBudget {
  /** The configured whole-run budget in ms (echoed into the demotion action). */
  readonly budgetMs: number

  private readonly startedAt: number
  private readonly clock: () => number
  private readonly ledger: BudgetTruncation[] = []

  constructor(budgetMs: number, options: SolverBudgetOptions = {}) {
    this.budgetMs = budgetMs
    this.clock = options.now ?? Date.now
    this.startedAt = this.clock()
  }

  /** Wall-clock ms consumed since the budget started. */
  elapsedMs(): number {
    return this.clock() - this.startedAt
  }

  /**
   * Ms left before the deadline. May be zero or negative once exhausted — the
   * signed value is deliberate: it is passed straight to `findNeedsReview`'s
   * own `solverBudgetMs`, where a non-positive remainder correctly triggers the
   * documented whole-run `ERR_SOLVER_TIMEOUT` abort.
   */
  remainingMs(): number {
    return this.budgetMs - this.elapsedMs()
  }

  /**
   * True once the deadline has passed. Callers check this BEFORE each unit of
   * work; see the check-before-work discipline in the module doc.
   */
  expired(): boolean {
    return this.elapsedMs() > this.budgetMs
  }

  /**
   * Record that `tier` stopped early with `skipped` units of work unrun.
   * Repeated calls from one tier accumulate as separate entries; the pipeline
   * aggregates by tier name.
   */
  truncate(tier: string, skipped: number): void {
    this.ledger.push({ tier, skipped })
  }

  /** Every recorded truncation, in the order the tiers hit the deadline. */
  truncations(): readonly BudgetTruncation[] {
    return this.ledger
  }

  /** Total units skipped by `tier` across its truncation records. */
  skippedBy(tier: string): number {
    let total = 0
    for (const t of this.ledger) if (t.tier === tier) total += t.skipped
    return total
  }

  /** True when any tier stopped early — the signal that `verified` must demote. */
  truncated(): boolean {
    return this.ledger.length > 0
  }
}

/**
 * The bounding options every solver-driving tier accepts. Both members are
 * optional, so a call that supplies neither behaves exactly as it did before
 * AC-1-7: no per-solver timeout is set and no deadline is consulted.
 */
export interface SolverBounds {
  /**
   * Per-solver timeout in ms, applied via `solver.set('timeout', timeoutMs)` to
   * every solver the tier constructs. Omitted ⇒ the solver runs unbounded, the
   * pre-AC-1-7 behavior.
   */
  timeoutMs?: number
  /**
   * The shared whole-run deadline. Omitted ⇒ no whole-run bound; the tier runs
   * every unit of work.
   */
  budget?: SolverBudget
}
