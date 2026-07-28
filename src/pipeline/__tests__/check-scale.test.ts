/**
 * AC-1-7 scale gate: `--solver-budget-ms` must bound a run at a document size the
 * rest of the suite never reaches.
 *
 * Before AC-1-7 the repo's largest fixture was 10 requirements — small enough
 * that the unbounded O(N²) subsumption tier looked free. Measured on the built
 * CLI at N=100 (4950 candidate pairs): 49.7s wall clock, of which subsumption was
 * 36.4s, and `--solver-budget-ms 2000` bounded NOTHING while the run still
 * reported `verified: true`. This file is the committed regression gate for both
 * halves of that defect:
 *
 *   1. LATENCY — a budgeted run at N=100 completes within a committed ceiling.
 *   2. HONESTY — the truncated run reports `verified: false` with a
 *      `solver-budget-exhausted` demotion, so the speed is not bought by lying.
 *
 * ## Why the ceiling is generous
 *
 * Following the committed-feasibility-gate precedent at
 * `scripts/temporal-feasibility.ts` (a latency budget with a non-zero exit), the
 * assertion is a CEILING on a loaded machine, not a benchmark. Measured in-suite:
 * ~2.2s budgeted against a 2000ms budget, ~5.4s unbounded. The ceiling is set at
 * 8× the solver budget so a busy CI runner cannot flake it, while still failing
 * loudly if the plumbing regresses — a regression puts this run back at ~40s+,
 * an order of magnitude over the ceiling.
 *
 * The RELATIVE assertion is the sharper one and does not depend on machine speed
 * at all: the budgeted run must be measurably faster than the same document
 * unbounded. If the budget stops bounding, that comparison collapses regardless
 * of how fast the box is.
 *
 * ## Why the fixture avoids bare numbers
 *
 * A first attempt at this fixture numbered the ledgers (`ledger 37`), which
 * tripped `GTWR_R6_MISSING_UNITS` at ERROR severity on all 100 requirements. The
 * AC-3-7 gate then excluded every one of them, the formal tier received an empty
 * set, and the "scale" test exercised no solver at all. Word-based identifiers
 * keep all 100 requirements gate-INCLUDED, which the test asserts explicitly so
 * the fixture can never silently degrade into a no-op again.
 */

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import type { Embedder } from '../../formal/embed.js'
import { runCheck } from '../check.js'

/** Requirement count for the scale fixture (the repo's largest by 10×). */
const SCALE_N = 100

/** The whole-run solver budget the gate exercises. */
const SCALE_BUDGET_MS = 2000

/**
 * Requirement count for the budgeted-vs-unbounded COMPARISON case, which needs an
 * unbounded baseline run and so cannot use `SCALE_N` without dominating
 * `pnpm check` (anti-goal). Still 5× the repo's previous largest fixture, and
 * 1225 candidate pairs — plenty for a relative-timing claim. See that test's
 * comment for the measured reason this is not 100.
 */
const COMPARISON_N = 50

/** Budget for the comparison case, scaled to `COMPARISON_N`'s smaller workload. */
const COMPARISON_BUDGET_MS = 300

/**
 * Committed latency ceiling: 8× the solver budget. Generous on purpose (see the
 * header) — a regression to unbounded solving lands ~20× over this.
 */
const LATENCY_CEILING_MS = SCALE_BUDGET_MS * 8

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
  'yankee',
  'zulu',
] as const

/** A distinct word-based ledger name per index — never a bare number (see header). */
function ledgerName(i: number): string {
  const first = WORDS[i % WORDS.length]
  if (i < WORDS.length) return first as string
  return `${first}-${WORDS[Math.floor(i / WORDS.length) % WORDS.length]}`
}

/**
 * Generate `n` event-driven requirements under ONE system, with triggers cycling
 * over 7 values so context atoms are widely shared (the shape that makes every
 * pair a candidate and drives the O(N²) tier hard) and `n` distinct responses.
 */
function scaleDoc(n: number): RequirementsDoc {
  const doc = emptyDoc()
  for (let i = 0; i < n; i++) {
    const base: Requirement = {
      id: randomUUID(),
      patternType: 'event-driven',
      systemName: 'payment gateway',
      systemResponse: `record the settlement for ledger ${ledgerName(i)}`,
      trigger: `a settlement request for channel ${WORDS[i % 7]} is received`,
      negated: false,
      sentence: '',
      priority: 'medium',
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    }
    base.sentence = renderSentence(base)
    doc.requirements[base.id] = base
  }
  return doc
}

/** Deterministic low-cosine embedder, so no semantic noise perturbs the timing. */
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t, i) => {
    const v = new Float32Array(4)
    v[i % 4] = 1
    v[3] = t.length % 2 === 0 ? 0.01 : 0.02
    return v
  })

describe(`AC-1-7 scale gate — ${SCALE_N} requirements under a ${SCALE_BUDGET_MS}ms budget`, () => {
  it(
    `bounds the run within ${LATENCY_CEILING_MS}ms, and reports verified:false for the truncation`,
    async () => {
      // ONE budgeted run backs every assertion in this case, so the gate stays
      // cheap enough not to dominate `pnpm check` (anti-goal) while still
      // covering latency, fixture validity, and honesty together.
      const doc = scaleDoc(SCALE_N)
      const started = performance.now()
      const report = await runCheck(doc, {
        solverBudgetMs: SCALE_BUDGET_MS,
        semantic: { embedder: fakeEmbedder },
      })
      const elapsedMs = performance.now() - started

      // Reported so a CI log shows the trend even when the gate passes (the
      // temporal-feasibility precedent prints its measured latency too).
      console.log(
        `AC-1-7 scale gate: N=${SCALE_N}, budget ${SCALE_BUDGET_MS}ms, ` +
          `elapsed ${elapsedMs.toFixed(0)}ms (ceiling ${LATENCY_CEILING_MS}ms), ` +
          `verified=${report.verified}`,
      )

      // (1) LATENCY — the whole point of the task.
      expect(elapsedMs).toBeLessThan(LATENCY_CEILING_MS)

      // (2) The fixture really exercised the hot path: all 100 gate-INCLUDED and
      // the full n(n-1)/2 candidate set. Guards against this degrading into a
      // no-op scale test (see the header's bare-number story).
      expect(report.coverage.encoded).toBe(SCALE_N)
      expect(report.coverage.excluded).toBe(0)
      expect(report.pairsChecked).toBe((SCALE_N * (SCALE_N - 1)) / 2)

      // (3) HONESTY — the speed is not bought by lying.
      expect(report.verified).toBe(false)
      const budgetDemotions = report.coverage.demotions.filter(
        (d) => d.reason === 'solver-budget-exhausted',
      )
      expect(budgetDemotions.length).toBeGreaterThan(0)
      // Subsumption dominates at this scale, so it is the tier that must appear.
      expect(budgetDemotions.some((d) => d.action.includes('subsumption'))).toBe(true)
    },
    LATENCY_CEILING_MS * 4,
  )

  it(
    'the budgeted run is faster than the same document unbounded, which IS verified',
    async () => {
      // Two claims from one budgeted/unbounded pair, both machine-independent:
      //   - the budget genuinely bounds (if it stopped bounding, the two timings
      //     would converge — no absolute threshold needed);
      //   - `verified: false` above is caused by the DEADLINE, not by some
      //     property of a large document.
      //
      // Run at COMPARISON_N, not SCALE_N. The claim needs an UNBOUNDED run for
      // its baseline, and an unbounded N=100 run costs ~5s of solid CPU — enough,
      // measured, to starve a concurrently-scheduled subprocess test past its
      // default 5s timeout while vitest runs files in parallel. That is the
      // anti-goal about not letting this gate dominate `pnpm check`. N=50 is
      // still 5× the repo's previous largest fixture and 1225 candidate pairs,
      // so the comparison is just as meaningful at a quarter of the cost.
      const doc = scaleDoc(COMPARISON_N)

      const budgetedStart = performance.now()
      const budgeted = await runCheck(doc, {
        solverBudgetMs: COMPARISON_BUDGET_MS,
        semantic: { embedder: fakeEmbedder },
      })
      const budgetedMs = performance.now() - budgetedStart

      const unboundedStart = performance.now()
      const unbounded = await runCheck(doc, { semantic: { embedder: fakeEmbedder } })
      const unboundedMs = performance.now() - unboundedStart

      console.log(
        `AC-1-7 scale gate: N=${COMPARISON_N} budgeted ${budgetedMs.toFixed(0)}ms vs ` +
          `unbounded ${unboundedMs.toFixed(0)}ms`,
      )
      // The budget bit: it truncated, and it finished sooner.
      expect(budgeted.verified).toBe(false)
      expect(budgetedMs).toBeLessThan(unboundedMs)
      // The same document unbounded is verified — truncation is the only cause of
      // the `verified: false` above.
      expect(unbounded.coverage.demotions.map((d) => d.reason)).not.toContain(
        'solver-budget-exhausted',
      )
      expect(unbounded.verified).toBe(true)
    },
    LATENCY_CEILING_MS * 8,
  )
})
