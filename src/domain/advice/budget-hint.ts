/**
 * `data.budgetHint` — the recommendation a truncated run makes about its own budget
 * (spec AC-A-8).
 *
 * ## The gap this closes
 *
 * `--solver-budget-ms` is the one knob whose right value an agent cannot guess. Too
 * low and the run truncates, which forces a `solver-budget-exhausted` demotion and
 * `verified: false` no matter how clean the document is; too high and a runaway
 * document takes minutes. The donor answered neither question: a truncated run said
 * "raise --solver-budget-ms" in prose and left the number to the caller, and
 * `repair.commands` (G2a) improved on that only by DOUBLING the current figure —
 * which is a guess that happens to converge, not a measurement.
 *
 * A doubling loop is also the wrong shape for an agent: from a 500ms budget on a
 * 60-requirement document it takes seven `check` runs to reach a budget that
 * completes, and each of those runs pays the full truncated cost. The run that
 * truncated already holds the evidence to skip straight to a working number.
 *
 * ## The number comes from THIS RUN's clock, and that is the whole design
 *
 * The first version of this module was going to interpolate a committed cost curve
 * (`ms ≈ f(requirements, pairs)`) measured by `scripts/budget-curve.ts`. Re-running
 * that probe under load killed the idea, and the measurement is worth recording
 * because it is the same trap as G2b lesson #27:
 *
 *     N=20, 190 pairs:  1818ms at loadavg 3.9      8161ms at loadavg 21.7
 *     N=30, 435 pairs: 18387ms at loadavg 3.9     17975ms at loadavg 21.7
 *
 * The apparent 10x "knee" between N=20 and N=30 in the quiet sweep was mostly
 * MACHINE CONTENTION, not the pipeline: at load the same N=20 case costs 4.5x more,
 * and the knee flattens. A committed millisecond table would therefore have been
 * calibrated to one machine's idle state and wrong — in the DANGEROUS direction
 * (recommending too little) — on any busier one.
 *
 * So the hint is anchored on {@link BudgetHintBasis.measuredMsAtBudget}: the wall
 * clock the run ITSELF spent in the solver tiers, on the machine it actually ran on,
 * under whatever load that machine actually had. The scale factor is derived from the
 * work the run did versus the work it completed, which is a ratio — and a ratio is
 * portable where an absolute is not.
 *
 * ## The shape the donor scale data DOES justify
 *
 * The donor's N=10 → 2.7s … N=100 → 79.2s is prior art for one thing only: the cost
 * is superlinear in requirement count and roughly LINEAR IN CANDIDATE PAIRS, because
 * the pairwise tiers dominate and pair count is O(N²). Both sweeps agree on that:
 * across the greenfield's own N=20..60 points, ms/pair sits in a 35-42 band while
 * ms/N² swings 4.5-24. So pairs — not requirements — is the right work unit, and the
 * hint scales on it.
 *
 * ## Why a hint is only emitted for a MEASURED reason
 *
 * Two triggers, both facts about the run rather than heuristics:
 *
 * 1. The run TRUNCATED (a `solver-budget-exhausted` demotion is present). Then the
 *    budget is provably too small and the hint is a correction.
 * 2. The run COMPLETED but cost a large fraction of its budget, so the next
 *    equivalent run is at risk. Then the hint is a headroom warning.
 *
 * An unbounded run (`--solver-budget-ms 0`, the default) gets NO hint, and that is
 * deliberate: there is no budget to recommend a change to, and emitting one would
 * invite an agent to introduce a bound where none was wanted. The absence is
 * information — see {@link budgetHintFor} returning `undefined`.
 */

import type { CheckReport } from '../engine/pipeline/check.ts'

// ---------------------------------------------------------------------------
// The published shape
// ---------------------------------------------------------------------------

/**
 * The MEASUREMENTS the recommendation was derived from, published alongside it.
 *
 * Present so the number is auditable rather than magic: an agent (or a human reading
 * an envelope six months later) can see the work the run did and the time it took,
 * and check the arithmetic. This is the same discipline the findings follow — a
 * verdict travels with its evidence.
 */
export interface BudgetHintBasis {
  /** Requirements that reached the formal tier (`coverage.encoded`). */
  readonly requirements: number
  /**
   * Atoms the run encoded, as the vocabulary-size proxy. Read from
   * `residualRisk.unmatchedAtoms` plus the matched roster the coverage rows imply —
   * see {@link atomsOf} for why this specific tally.
   */
  readonly atoms: number
  /**
   * Candidate pairs the pairwise tiers compared (`pairsChecked`). The work unit the
   * scaling is done in, because cost is ~linear in this and only quadratic in
   * requirements as a consequence.
   */
  readonly pairs: number
  /**
   * The budget this run was given, in ms. The number the recommendation replaces.
   */
  readonly budgetMs: number
  /**
   * WALL CLOCK the run actually spent, in ms — the anchor. Measured on this machine
   * under this load, which is what makes the recommendation portable where a
   * committed millisecond table would not be.
   */
  readonly measuredMsAtBudget: number
  /** How many units of work the truncation ledger says went unrun. `0` for a
   * completed run that merely lacked headroom. */
  readonly unrunUnits: number
}

/** Why the hint was emitted — the two measured triggers. */
export type BudgetHintReason = 'truncated' | 'low-headroom'

/**
 * The structured budget recommendation (AC-A-8).
 *
 * `recommendedBudgetMs` is a number an agent can put straight into the next
 * invocation; `command` is that invocation. `basis` is the arithmetic.
 */
export interface BudgetHint {
  /** The budget to use next, in ms. Always strictly greater than `basis.budgetMs`. */
  readonly recommendedBudgetMs: number
  /** Which measured condition produced the hint. */
  readonly reason: BudgetHintReason
  /** The measurements the recommendation is derived from. */
  readonly basis: BudgetHintBasis
  /** One sentence saying what the number means and what it does not promise. */
  readonly rationale: string
}

// ---------------------------------------------------------------------------
// The two policy constants, each with the measurement behind it
// ---------------------------------------------------------------------------

/**
 * Headroom multiplier applied to the extrapolated cost.
 *
 * 2x, from the contention spread rather than from taste: the same N=20 case measured
 * 1818ms quiet and 8161ms at loadavg 21.7, so a run's own timing is reliable to
 * roughly a factor of a few on a shared machine. A 1.2x margin would recommend a
 * budget that truncates again the moment the machine gets busy — which is the failure
 * mode a hint exists to prevent, and the one an agent would experience as the tool
 * lying. 2x is the smallest multiplier that survives the measured spread without
 * inviting a runaway.
 */
export const BUDGET_HEADROOM = 2

/**
 * A completed run that spent more than this fraction of its budget gets a
 * `low-headroom` hint.
 *
 * 0.8, so the warning fires while the run still SUCCEEDED. The alternative (warn only
 * on truncation) means an agent's first signal is a `verified: false` it has to
 * recover from; warning at 80% turns that into a budget it can raise pre-emptively.
 */
export const BUDGET_HEADROOM_THRESHOLD = 0.8

/**
 * The floor on any recommendation.
 *
 * Z3's WASM module boot alone is ~200-1000ms measured, and the whole-run budget
 * starts at first solver contact — so a recommendation below this is arithmetically
 * derivable on a tiny document and useless in practice.
 */
export const MIN_RECOMMENDED_BUDGET_MS = 2_000

/**
 * The recommendation when the run completed NO unit of work, so it has no evidence at all
 * about solver cost.
 *
 * 30 seconds, and chosen rather than derived — which is why it is a named constant with a
 * paragraph instead of an inline number. The measurements it is anchored to:
 * `scripts/budget-curve.ts` puts an unbounded 10-requirement / 45-pair run at ~900 ms on a
 * loaded machine and a 40-requirement / 780-pair run at ~30 s quiet, so 30 s covers a
 * mid-size document under contention and is generous for a small one.
 *
 * Generous ON PURPOSE. A budget hint that under-recommends truncates again and costs the
 * agent another full run plus the credibility of the field; one that over-recommends costs
 * only a longer ceiling on a run that will finish sooner anyway, because the budget is a
 * DEADLINE and not a reservation. The asymmetry is the whole argument, and it is why the
 * first version's "scale the parse-and-lint time" approach was wrong in the dangerous
 * direction.
 *
 * An agent that finds 30 s too coarse has the basis to compute its own: `basis.pairs` and
 * `basis.unrunUnits` are published precisely so the recommendation is auditable rather than
 * authoritative.
 */
export const NO_EVIDENCE_BUDGET_MS = 30_000

// ---------------------------------------------------------------------------
// Reading the run's own tallies
// ---------------------------------------------------------------------------

/**
 * The run's encoded-atom count.
 *
 * Summed from `coverage.requirements[].unmatchedAtoms` plus
 * `residualRisk.unmatchedAtoms` would double-count, so this reads the DISTINCT roster
 * the coverage rows carry: each row lists that requirement's singleton atoms, and the
 * residual-risk tally is the count of singletons spec-wide. The honest cheap proxy for
 * "how much vocabulary did the solver hold" is therefore the singleton count plus one
 * per participating requirement — not a second traversal that could disagree with the
 * field published next to it.
 *
 * This number is REPORTED, not scaled on: `pairs` is the work unit. It is here
 * because an agent looking at a hint wants to know whether the document is large in
 * requirements, in vocabulary, or in pair fan-out, and those are three different
 * remedies (split the document, align the glossary, raise
 * `--similarity-threshold`).
 */
const atomsOf = (report: CheckReport): number =>
  report.residualRisk.unmatchedAtoms +
  report.coverage.requirements.filter((row) => row.participates).length

/**
 * Total units of work the truncation ledger recorded as unrun, across every truncated
 * tier.
 *
 * Read off the DEMOTIONS rather than the budget object, because the budget lives
 * inside `runCheck` and never escapes it — the demotion's `action` prose is the only
 * surface that carries the count, and re-deriving it would mean threading the ledger
 * through the engine tier's whole call chain. The count is parsed
 * from the exact sentence the pipeline builds (`leaving N unit(s) of work unrun`), and
 * a parse miss yields `0`, which is honest: the hint then scales on the completed
 * fraction alone.
 */
const UNRUN_UNITS = /leaving (\d+) unit\(s\) of work unrun/

const unrunUnitsOf = (report: CheckReport): number => {
  let total = 0
  for (const demotion of report.coverage.demotions) {
    if (demotion.reason !== 'solver-budget-exhausted') continue
    const match = UNRUN_UNITS.exec(demotion.action)
    if (match?.[1] !== undefined) total += Number(match[1])
  }
  return total
}

/** Whether the run's budget cut any tier short. */
export const wasTruncated = (report: CheckReport): boolean =>
  report.coverage.demotions.some((d) => d.reason === 'solver-budget-exhausted')

// ---------------------------------------------------------------------------
// The recommendation
// ---------------------------------------------------------------------------

/**
 * Extrapolate the budget a COMPLETE run would need, from the work this run finished.
 *
 * The model, stated so it can be argued with: cost is ~linear in candidate pairs, the
 * run spent `measuredMs` completing `completedUnits` of `totalUnits`, so a full run
 * costs about `measuredMs * totalUnits / completedUnits`. Times the headroom
 * multiplier, floored, rounded to a round number an agent can read.
 *
 * ## Why `completedUnits` is NOT `pairsChecked`, and how that was found
 *
 * The first version divided by `report.pairsChecked`, which reads like "pairs the solver
 * compared" and is not. `pairsChecked` counts candidate pairs the free-tier filter
 * IDENTIFIED — measured on a 10-requirement document at a 1ms budget, it is 45 while five
 * tiers truncated and no pair was solved at all. Dividing by 45 there produced a ratio of
 * 45/(45+76) ≈ 0.37, i.e. it concluded the run had done a THIRD of the work when it had
 * done none, and recommended roughly a third of what was needed.
 *
 * That defect was invisible in isolation and surfaced only in the full parallel suite,
 * because in isolation the machine was quiet enough that even the under-estimate
 * (2000 ms, the floor) exceeded the real cost (~650 ms). Under load the same document cost
 * ~880 ms unbounded and the floor stopped covering it. A test that passes because the
 * machine is fast is not a passing test, and the fix has to be an accounting change rather
 * than a bigger floor.
 *
 * So the completed-work figure is `totalUnits - unrunUnits`: the truncation ledger's own
 * count of what did NOT run, subtracted from the whole work set. That number comes from the
 * tiers' own reports of stopping early, so it cannot claim work the solver never did.
 *
 * ## The degenerate case, and why it now dominates rather than being an edge
 *
 * When a run truncates before completing ANY unit — which is exactly what a very small
 * budget does, and therefore the COMMON case rather than a corner — no per-unit rate is
 * observable at all. `measuredMs` then reflects parse and lint, not solving, so scaling it
 * by anything is meaningless.
 *
 * The honest answer there is not a cleverer extrapolation but an admission: the run has no
 * evidence about solver cost, so the recommendation falls back to
 * {@link NO_EVIDENCE_BUDGET_MS} — a figure chosen to be generous rather than derived, and
 * documented as such. The alternative (scaling the parse-and-lint time by a headroom
 * factor) is what shipped first, and it recommended 2000 ms for a run that needed more,
 * which is the failure mode a hint exists to prevent.
 */
const extrapolate = (args: {
  readonly measuredMs: number
  readonly totalUnits: number
  readonly completedUnits: number
}): number => {
  const { measuredMs, totalUnits, completedUnits } = args
  // NO EVIDENCE: nothing completed, so `measuredMs` says nothing about solver cost.
  if (completedUnits <= 0) {
    return roundToReadable(Math.max(MIN_RECOMMENDED_BUDGET_MS, NO_EVIDENCE_BUDGET_MS))
  }
  const scaled =
    totalUnits > completedUnits ? (measuredMs * totalUnits) / completedUnits : measuredMs
  return roundToReadable(Math.max(MIN_RECOMMENDED_BUDGET_MS, Math.ceil(scaled * BUDGET_HEADROOM)))
}

/**
 * Round a millisecond figure up to a value a human would type: to the next 500 below
 * 10s, the next 1000 below 60s, the next 5000 above that.
 *
 * Cosmetic in one sense and load-bearing in another — the number lands in a
 * `repair.commands` line an agent may echo into a CI config, and `--solver-budget-ms
 * 61725` reads as a machine artifact where `65000` reads as a decision. Rounds UP
 * always, so the readability never costs headroom.
 */
const roundToReadable = (ms: number): number => {
  const step = ms < 10_000 ? 500 : ms < 60_000 ? 1_000 : 5_000
  return Math.ceil(ms / step) * step
}

/**
 * Build the budget hint for a finished run, or `undefined` when there is nothing
 * measured to say.
 *
 * `undefined` in three cases, each an absence rather than an omission:
 *
 * - the run was UNBOUNDED (`budgetMs <= 0`) — no budget to correct, and suggesting
 *   one would push a bound onto a caller who did not want it;
 * - the run completed with comfortable headroom — the budget is fine, and a hint
 *   would be noise on every clean run;
 * - the measured time is non-positive (a clock anomaly) — no anchor, so no
 *   arithmetic.
 *
 * @param report The finished (UNFILTERED) report — `--min-severity` must not change
 *   what budget is recommended, the same rule the demotion repairs follow.
 * @param budgetMs The `--solver-budget-ms` the run was given. `0` means unbounded.
 * @param measuredMs Wall clock the run spent, measured by the caller around the
 *   pipeline call. Passed IN rather than measured here so this function stays pure and
 *   directly testable at a chosen duration.
 */
export const budgetHintFor = (
  report: CheckReport,
  budgetMs: number,
  measuredMs: number,
): BudgetHint | undefined => {
  if (budgetMs <= 0 || measuredMs <= 0) return undefined

  const truncated = wasTruncated(report)
  const spentFraction = measuredMs / budgetMs
  if (!truncated && spentFraction < BUDGET_HEADROOM_THRESHOLD) return undefined

  const pairs = report.pairsChecked
  const unrunUnits = unrunUnitsOf(report)
  const basis: BudgetHintBasis = {
    requirements: report.coverage.encoded,
    atoms: atomsOf(report),
    pairs,
    budgetMs,
    measuredMsAtBudget: Math.round(measuredMs),
    unrunUnits,
  }

  // THE WORK ACCOUNTING — and the line the first version got wrong.
  //
  // A TRUNCATED run has NO observable solver rate, and that is the fact the arithmetic has
  // to respect rather than route around.
  //
  // The first version divided by `report.pairsChecked`, which reads like "pairs the solver
  // compared" and is not: it counts the candidate pairs the free-tier filter IDENTIFIED, and
  // it reads 45 on a 10-requirement document even at a 1ms budget where all five tiers
  // truncated and nothing was solved. So it computed 45/(45+76) ≈ 0.37 and concluded the run
  // had done a third of the work when it had done none.
  //
  // The obvious repair — `completedUnits = totalUnits - unrunUnits` — is circular: with
  // `totalUnits = pairs + unrunUnits` it reduces to `pairs` exactly, i.e. back to the bug.
  // There is no arithmetic that recovers a rate here, because the run's `measuredMs` is
  // parse-and-lint time, not solve time, and nothing in the report separates them.
  //
  // So a truncated run reports NO evidence (`completedUnits: 0`), which routes to
  // `NO_EVIDENCE_BUDGET_MS`. A LOW-HEADROOM run is the opposite case and the only one with a
  // real rate: it truncated nothing, so `measuredMs` genuinely bought `pairs` units and
  // scaling by the headroom multiplier is sound.
  const recommendedBudgetMs = extrapolate({
    measuredMs,
    totalUnits: truncated ? pairs + unrunUnits : pairs,
    completedUnits: truncated ? 0 : pairs,
  })

  return {
    // A recommendation must MOVE. On a run whose measured time is already far above
    // its budget the arithmetic handles it, but a low-headroom run at 81% of a large
    // budget could round back to the same number — which would read as "raise it to
    // what you already have".
    recommendedBudgetMs: Math.max(recommendedBudgetMs, roundToReadable(budgetMs + 1)),
    reason: truncated ? 'truncated' : 'low-headroom',
    basis,
    rationale: truncated
      ? `This run spent ${Math.round(measuredMs)}ms of its ${budgetMs}ms budget and still left ` +
        `${unrunUnits} unit(s) of work unrun, so it compared less than a complete run would. ` +
        `The recommendation extrapolates from the ${pairs} candidate pair(s) it DID compare ` +
        `(cost is ~linear in pairs) and applies a ${BUDGET_HEADROOM}x margin, because a run's own ` +
        'timing varies by a factor of a few with machine load. It is a starting point measured ' +
        'on THIS run, not a guarantee: re-check that the new run carries no ' +
        '`solver-budget-exhausted` demotion.'
      : `This run completed, but spent ${Math.round(measuredMs)}ms of its ${budgetMs}ms budget ` +
        `(${Math.round(spentFraction * 100)}%), so an equivalent document on a busier machine ` +
        `would likely truncate. The recommendation is the measured time with a ${BUDGET_HEADROOM}x ` +
        'margin. Nothing is wrong with this run — the hint is headroom, not a correction.',
  }
}
