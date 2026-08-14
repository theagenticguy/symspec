/**
 * `data.budgetHint` — the arithmetic, the absences, and the one property that
 * matters (spec AC-A-8).
 *
 * ## Why these tests assert SHAPE, not milliseconds
 *
 * The recommendation is derived from the run's own wall clock, so its value on any
 * given machine is a machine artifact. Pinning `recommendedBudgetMs === 65000` would
 * encode this devbox's load average as a contract — the exact mistake the module
 * header records having nearly made at the design stage (N=20 measured 1818ms quiet
 * and 8161ms at loadavg 21.7, a 4.5x spread on identical work).
 *
 * So the assertions are relational and total: the recommendation always EXCEEDS the
 * budget it replaces, always exceeds the time the run measured, never DECREASES as the
 * shortfall grows, and the absences are asserted as absences. The end-to-end "applying the
 * hint un-demotes the run" claim lives in `../operations/check.test.ts`, where a real
 * pipeline can produce a real truncation.
 *
 * ## Two of these tests were WRONG, and the record of that is deliberate
 *
 * The first version asserted the recommendation grows with unrun work and extrapolates
 * "~linearly in pairs" on a truncated run. Both presumed an observable solver rate that a
 * truncated run does not have: the arithmetic divided by `report.pairsChecked`, which counts
 * candidate pairs IDENTIFIED rather than solved, and therefore concluded a run that had
 * solved nothing had done a third of its work. The tests passed because they were checking a
 * ratio built on the same misreading as the code.
 *
 * What exposed it was the FULL PARALLEL SUITE, not these unit tests: in isolation the
 * machine was quiet enough that even the under-estimate exceeded the real cost, and only
 * under contention did the recommendation stop covering the run. The replacements pin the
 * arithmetic (`does NOT treat pairsChecked as completed work`) rather than the outcome, so
 * they cannot pass again for the same reason.
 */

import { describe, expect, it } from 'vitest'
import type { CheckReport, CoverageDemotion } from '../engine/pipeline/check.ts'
import {
  BUDGET_HEADROOM,
  BUDGET_HEADROOM_THRESHOLD,
  budgetHintFor,
  MIN_RECOMMENDED_BUDGET_MS,
  NO_EVIDENCE_BUDGET_MS,
  wasTruncated,
} from './budget-hint.ts'
import { repairForDemotion } from './repair.ts'

// ---------------------------------------------------------------------------
// Fixtures — a minimal CheckReport, varying only what each test is about
// ---------------------------------------------------------------------------

/** The truncation demotion the pipeline builds, with its exact unrun-count sentence. */
const truncationDemotion = (tier: string, skipped: number, budgetMs: number): CoverageDemotion => ({
  reason: 'solver-budget-exhausted',
  requirementIds: [],
  // VERBATIM the pipeline's sentence shape (check.ts:1450-1461), because
  // `unrunUnitsOf` parses it. A test that paraphrased it would pass while the parse
  // silently failed in production.
  action:
    `The ${tier} tier stopped after the whole-run --solver-budget-ms deadline ` +
    `(${budgetMs}ms) expired, leaving ${skipped} unit(s) of work unrun, so ` +
    'this run compared less than it would have. Raise --solver-budget-ms (or reduce the ' +
    'document / raise --similarity-threshold to shrink the candidate-pair set), then re-run ' +
    '`symspec check`. Waiving a finding cannot discharge this — the comparison did not happen.',
})

const reportOf = (args: {
  readonly pairs?: number
  readonly encoded?: number
  readonly unmatchedAtoms?: number
  readonly participating?: number
  readonly demotions?: readonly CoverageDemotion[]
}): CheckReport => {
  const participating = args.participating ?? 0
  return {
    findings: [],
    excluded: [],
    pairsChecked: args.pairs ?? 100,
    waived: 0,
    counts: { error: 0, warn: 0, info: 0 },
    residualRisk: {
      similarUnunifiedPairs: 0,
      semanticSuggestions: 0,
      pairsChecked: args.pairs ?? 100,
      noPairsChecked: (args.pairs ?? 100) === 0,
      excludedRequirements: 0,
      unmatchedAtoms: args.unmatchedAtoms ?? 0,
      uncoveredRequirements: 0,
    },
    coverage: {
      requirements: Array.from({ length: participating }, (_, i) => ({
        id: `req-${i}`,
        participates: true,
        unmatchedAtoms: [],
      })),
      openOppositionCandidates: 0,
      demotions: [...(args.demotions ?? [])],
      encoded: args.encoded ?? 20,
      excluded: 0,
      pairsCheckedNote: '',
    },
    verified: (args.demotions ?? []).length === 0,
  }
}

// ---------------------------------------------------------------------------
// The absences — each one is information, not an omission
// ---------------------------------------------------------------------------

describe('no hint is emitted when there is nothing measured to say', () => {
  it('emits NOTHING for an unbounded run, even a slow one', () => {
    // `--solver-budget-ms 0` is the default. There is no budget to correct, and
    // suggesting one would push a bound onto a caller who deliberately ran without.
    expect(budgetHintFor(reportOf({}), 0, 120_000)).toBeUndefined()
  })

  it('emits NOTHING for a bounded run with comfortable headroom', () => {
    // A hint on every clean run is noise, and noise is how an agent learns to ignore
    // a field.
    const hint = budgetHintFor(reportOf({}), 100_000, 1_000)
    expect(hint).toBeUndefined()
  })

  it('emits NOTHING when the measured time is non-positive', () => {
    // No anchor ⇒ no arithmetic. A clock anomaly must not produce a confident number.
    expect(budgetHintFor(reportOf({}), 10_000, 0)).toBeUndefined()
    expect(budgetHintFor(reportOf({}), 10_000, -5)).toBeUndefined()
  })

  it('fires at the headroom threshold and not below it', () => {
    const budget = 10_000
    const below = budgetHintFor(reportOf({}), budget, budget * (BUDGET_HEADROOM_THRESHOLD - 0.05))
    const above = budgetHintFor(reportOf({}), budget, budget * (BUDGET_HEADROOM_THRESHOLD + 0.05))
    expect(below).toBeUndefined()
    expect(above?.reason).toBe('low-headroom')
  })
})

// ---------------------------------------------------------------------------
// The truncated case — the one the field exists for
// ---------------------------------------------------------------------------

describe('a truncated run recommends a budget derived from the work it DID do', () => {
  const truncated = (pairs: number, unrun: number, budgetMs: number) =>
    reportOf({ pairs, demotions: [truncationDemotion('subsumption', unrun, budgetMs)] })

  it('reports `truncated` and reads the unrun count out of the demotion', () => {
    const hint = budgetHintFor(truncated(100, 400, 5_000), 5_000, 4_800)
    expect(hint?.reason).toBe('truncated')
    expect(hint?.basis.unrunUnits).toBe(400)
    expect(hint?.basis.pairs).toBe(100)
    expect(hint?.basis.budgetMs).toBe(5_000)
    expect(hint?.basis.measuredMsAtBudget).toBe(4_800)
  })

  it('sums the unrun counts across every truncated tier', () => {
    const report = reportOf({
      pairs: 100,
      demotions: [
        truncationDemotion('subsumption', 300, 5_000),
        truncationDemotion('needs-review', 120, 5_000),
      ],
    })
    expect(budgetHintFor(report, 5_000, 4_900)?.basis.unrunUnits).toBe(420)
  })

  /**
   * MONOTONICITY, restated for the model that is actually sound.
   *
   * The first version of this test asserted the recommendation GROWS with unrun work, which
   * presumed an observable solver rate that a truncated run does not have (see
   * `extrapolate`'s header for how that presumption produced a real under-estimate). What
   * holds instead is the weaker and true claim: more unrun work never recommends LESS. A
   * truncated run reports no evidence and lands on the no-evidence figure regardless of how
   * much was left unrun, which is flat — and flat satisfies monotone.
   *
   * Keeping the assertion rather than deleting it matters: it is what would catch a future
   * change that made the recommendation SHRINK as the shortfall grew, which is the direction
   * that would actually hurt.
   */
  it('is MONOTONE (never decreasing) in the work left unrun', () => {
    const at = (unrun: number) =>
      budgetHintFor(truncated(100, unrun, 5_000), 5_000, 4_800)?.recommendedBudgetMs ?? 0
    const values = [0, 50, 200, 800, 3_200].map(at)
    for (let i = 1; i < values.length; i++) {
      expect(values[i], 'the recommendation DECREASED as unrun work grew').toBeGreaterThanOrEqual(
        values[i - 1] as number,
      )
    }
  })

  /**
   * A truncated run has NO observable rate, so it does not extrapolate — it admits it.
   *
   * This replaces an assertion that the extrapolation was "~linear in pairs" on a truncated
   * run. That assertion passed against arithmetic that divided by `pairsChecked` (candidate
   * pairs IDENTIFIED, not solved) and was therefore measuring a ratio built on a
   * misreading — which is exactly how the under-estimate shipped.
   */
  it('reports NO EVIDENCE on a truncated run rather than inventing a rate', () => {
    const hint = budgetHintFor(truncated(100, 100, 5_000), 5_000, 4_000)
    expect(hint?.reason).toBe('truncated')
    expect(hint?.recommendedBudgetMs).toBe(NO_EVIDENCE_BUDGET_MS)
  })

  /**
   * The LOW-HEADROOM case is the only one with a real rate, and it is where the
   * linear-in-pairs shape both sweeps agree on actually applies: the run truncated nothing,
   * so its measured time genuinely bought its pair count.
   */
  it('extrapolates from the measured time when the run COMPLETED its work', () => {
    const hint = budgetHintFor(reportOf({ pairs: 100 }), 5_000, 4_500)
    expect(hint?.reason).toBe('low-headroom')
    // measured * headroom, rounded up to a readable step — no unit scaling, because
    // nothing was left unrun.
    expect(hint?.recommendedBudgetMs).toBe(9_000)
    expect(hint?.recommendedBudgetMs).toBeGreaterThanOrEqual(4_500 * BUDGET_HEADROOM)
  })

  it('degrades honestly when NO unit completed at all', () => {
    // A run truncated before its first pair. Same no-evidence answer as any other truncated
    // run, which is the point: the model does not pretend the zero-pair case is special when
    // every truncated case is equally rate-less.
    const hint = budgetHintFor(
      reportOf({ pairs: 0, demotions: [truncationDemotion('contradiction', 40, 100)] }),
      100,
      90,
    )
    expect(hint?.reason).toBe('truncated')
    expect(hint?.basis.pairs).toBe(0)
    expect(hint?.recommendedBudgetMs).toBe(NO_EVIDENCE_BUDGET_MS)
    expect(hint?.recommendedBudgetMs).toBeGreaterThanOrEqual(MIN_RECOMMENDED_BUDGET_MS)
    expect(Number.isFinite(hint?.recommendedBudgetMs)).toBe(true)
  })

  /**
   * The regression guard for the actual bug, pinned by ARITHMETIC rather than by outcome.
   *
   * The defect was invisible in isolation and only surfaced in the full parallel suite,
   * because on a quiet machine the under-estimate (2000 ms) still exceeded the real cost
   * (~650 ms). Under load the same document cost ~880 ms and the floor stopped covering it.
   * A test that passes because the machine is fast is not a passing test, so this pins the
   * one thing that is machine-independent: the recommendation must NOT be derived from
   * `pairsChecked` as if it measured completed work.
   */
  it('does NOT treat `pairsChecked` as completed work on a truncated run', () => {
    // The exact numbers from the 10-requirement document that exposed it: 45 candidate
    // pairs identified, 76 units reported unrun, ~120ms of parse-and-lint measured.
    const hint = budgetHintFor(truncated(45, 76, 1), 1, 120)
    expect(hint?.basis.pairs).toBe(45)
    expect(hint?.basis.unrunUnits).toBe(76)
    // The buggy arithmetic was 120 * (121/45) * 2 ≈ 646 → floored to 2000. Anything at or
    // below that floor means the ratio is back.
    expect(hint?.recommendedBudgetMs).toBeGreaterThan(MIN_RECOMMENDED_BUDGET_MS)
    expect(hint?.recommendedBudgetMs).toBe(NO_EVIDENCE_BUDGET_MS)
  })

  it('yields `0` unrun units — not a crash — when the action prose does not parse', () => {
    // The count is parsed out of the pipeline's own sentence. If a future donor edit
    // rewords it, the hint must degrade to "scale on the completed fraction" rather
    // than throw or report a wrong number.
    const report = reportOf({
      pairs: 100,
      demotions: [
        { reason: 'solver-budget-exhausted', requirementIds: [], action: 'reworded upstream' },
      ],
    })
    const hint = budgetHintFor(report, 5_000, 4_800)
    expect(hint?.reason).toBe('truncated')
    expect(hint?.basis.unrunUnits).toBe(0)
    expect(hint?.recommendedBudgetMs).toBeGreaterThan(5_000)
  })
})

// ---------------------------------------------------------------------------
// Invariants that hold on EVERY emitted hint
// ---------------------------------------------------------------------------

describe('every emitted hint satisfies the recommendation invariants', () => {
  /**
   * A table across both reasons and a wide range of budget/measurement/work
   * combinations, because the invariants are the actual contract — a recommendation
   * that did not exceed the budget it replaces would read as "raise it to what you
   * already have", which is worse than no hint at all.
   */
  const cases = [
    { label: 'truncated, tiny budget', pairs: 5, unrun: 500, budget: 100, measured: 95 },
    { label: 'truncated, mid budget', pairs: 200, unrun: 300, budget: 5_000, measured: 4_900 },
    {
      label: 'truncated, large budget',
      pairs: 1_500,
      unrun: 270,
      budget: 60_000,
      measured: 59_000,
    },
    { label: 'truncated, over budget', pairs: 100, unrun: 100, budget: 1_000, measured: 3_500 },
    { label: 'low headroom, small', pairs: 20, unrun: 0, budget: 3_000, measured: 2_700 },
    { label: 'low headroom, large', pairs: 900, unrun: 0, budget: 90_000, measured: 80_000 },
  ] as const

  for (const c of cases) {
    it(`${c.label}: recommends strictly more than the budget it replaces`, () => {
      const report =
        c.unrun > 0
          ? reportOf({
              pairs: c.pairs,
              demotions: [truncationDemotion('subsumption', c.unrun, c.budget)],
            })
          : reportOf({ pairs: c.pairs })
      const hint = budgetHintFor(report, c.budget, c.measured)
      expect(hint, c.label).toBeDefined()
      if (hint === undefined) return

      // 1. It MOVES. Otherwise the advice is a no-op dressed as a fix.
      expect(hint.recommendedBudgetMs).toBeGreaterThan(c.budget)
      // 2. It covers the time this run already demonstrably needed.
      expect(hint.recommendedBudgetMs).toBeGreaterThan(c.measured)
      // 3. It is never below the floor the WASM boot alone justifies.
      expect(hint.recommendedBudgetMs).toBeGreaterThanOrEqual(MIN_RECOMMENDED_BUDGET_MS)
      // 4. It is a readable number an agent can echo into a CI config.
      expect(hint.recommendedBudgetMs % 500).toBe(0)
      // 5. The basis is complete, so the arithmetic is auditable.
      expect(hint.basis.measuredMsAtBudget).toBe(Math.round(c.measured))
      expect(hint.basis.budgetMs).toBe(c.budget)
      // 6. The rationale states what the number is NOT.
      expect(hint.rationale.length).toBeGreaterThan(80)
    })
  }

  it('says the recommendation is a starting point, not a guarantee', () => {
    const hint = budgetHintFor(
      reportOf({ pairs: 100, demotions: [truncationDemotion('subsumption', 100, 5_000)] }),
      5_000,
      4_800,
    )
    // The honesty the whole repo runs on: a measured extrapolation under variable load
    // is advice, and the prose has to say so rather than implying a bound.
    expect(hint?.rationale).toContain('not a guarantee')
    expect(hint?.rationale).toContain(`${BUDGET_HEADROOM}x`)
  })

  it('reports the vocabulary size so a reader can tell WHICH axis is large', () => {
    // requirements / atoms / pairs point at three different remedies (split the
    // document, align the glossary, raise --similarity-threshold), which is why all
    // three are published rather than just the one the scaling uses.
    const hint = budgetHintFor(
      reportOf({ pairs: 190, encoded: 20, unmatchedAtoms: 12, participating: 8 }),
      10_000,
      9_000,
    )
    expect(hint?.basis.requirements).toBe(20)
    expect(hint?.basis.pairs).toBe(190)
    expect(hint?.basis.atoms).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// wasTruncated
// ---------------------------------------------------------------------------

describe('wasTruncated reads the demotion ledger, not a finding', () => {
  it('is true exactly when a solver-budget-exhausted demotion is present', () => {
    expect(wasTruncated(reportOf({}))).toBe(false)
    expect(
      wasTruncated(reportOf({ demotions: [truncationDemotion('subsumption', 10, 1_000)] })),
    ).toBe(true)
  })

  it('ignores every OTHER demotion reason', () => {
    // Truncation is a fact about the RUN; the other reasons are facts about the
    // document, and none of them says anything about the budget.
    const other = reportOf({
      demotions: [
        { reason: 'semantic-tier-skipped', requirementIds: [], action: 'x' },
        { reason: 'uncovered-requirement', requirementIds: ['a'], action: 'y' },
      ],
    })
    expect(wasTruncated(other)).toBe(false)
    expect(budgetHintFor(other, 10_000, 1_000)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The repair command and the hint are ONE answer
// ---------------------------------------------------------------------------

/**
 * `repairForDemotion` and `budgetHintFor` both answer "what budget should I use", and
 * an envelope that gave two different numbers in two adjacent fields would be
 * contradicting itself where an agent can see it.
 *
 * The end-to-end agreement is asserted in `../operations/check.test.ts` against a real
 * run. What is covered here is the SEAM's two branches: the measurement wins when
 * present, and the G2a doubling still works when it is not — because this module has
 * to remain usable by a direct library caller who measured nothing.
 */
describe('the raise-the-budget repair prefers the measurement over doubling', () => {
  const budgetDemotion = truncationDemotion('subsumption', 200, 5_000)
  const context = {
    exclusionsById: new Map(),
    findings: [],
    docPath: 'doc.json',
  } as const

  it('uses the MEASURED recommendation when one is available', () => {
    const repair = repairForDemotion(budgetDemotion, {
      ...context,
      solverBudgetMs: 5_000,
      recommendedBudgetMs: 41_500,
    })
    expect(repair.commands).toEqual(['symspec check doc.json --solver-budget-ms 41500'])
    // NOT the doubling — 10000 would be the G2a answer, and it is the one that takes
    // several runs to converge from a small budget.
    expect(repair.commands[0]).not.toContain('10000')
  })

  it('falls back to doubling for a caller with no measurement', () => {
    const repair = repairForDemotion(budgetDemotion, { ...context, solverBudgetMs: 5_000 })
    expect(repair.commands).toEqual(['symspec check doc.json --solver-budget-ms 10000'])
  })

  it('floors the fallback so a tiny budget does not suggest a tinier one', () => {
    const repair = repairForDemotion(budgetDemotion, { ...context, solverBudgetMs: 1 })
    expect(repair.commands).toEqual([
      `symspec check doc.json --solver-budget-ms ${MIN_RECOMMENDED_BUDGET_MS}`,
    ])
  })

  it('agrees with the hint on the same run`s numbers', () => {
    // The property, stated directly: feed both functions the same report and the
    // command names the hint's number.
    const report = reportOf({ pairs: 150, demotions: [budgetDemotion] })
    const hint = budgetHintFor(report, 5_000, 4_800)
    expect(hint).toBeDefined()
    if (hint === undefined) return
    const repair = repairForDemotion(budgetDemotion, {
      ...context,
      solverBudgetMs: 5_000,
      recommendedBudgetMs: hint.recommendedBudgetMs,
    })
    expect(repair.commands).toEqual([
      `symspec check doc.json --solver-budget-ms ${hint.recommendedBudgetMs}`,
    ])
  })
})
