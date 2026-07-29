/**
 * AC-1-7 scale gate: `--solver-budget-ms` must bound a run at a document size the
 * rest of the suite never reaches. Plus the AC-2-8 TEMPORAL scale gate (second
 * describe block).
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
 *
 * ## AC-2-8: the temporal tier needs its own scale gate, and why
 *
 * Everything above ran with `--temporal` OFF, so a temporal blowup was invisible
 * to CI — the exact V19 shape this AC forbids. The temporal tier is the one that
 * most needs a gate:
 *
 *   - it runs over ALL requirements (`check.ts` comment above its invocation),
 *     not the gate-INCLUDED subset the pairwise tiers use;
 *   - its lowering is `O(k²)` per `F`-under-`G` and `O(k³)` per `U`-under-`G`,
 *     so it scales in a second dimension the AC-1-7 gate does not touch; and
 *   - AC-2-6's pending/tail machinery has an `O(P·N)` worst case in distinct
 *     eventualities, pruned by `relevantBodyIndices` — and that prune is
 *     load-bearing, not an optimization: unpruned it exhausted the Z3 WASM
 *     `small_object_allocator` and died with `memory access out of bounds` at
 *     N=100/k=10. A crash, not a slowdown. Nothing in CI covered it.
 *
 * Measured in-suite (this machine, 2026-07-29, warm-up excluded):
 *
 *   | config                        | latency | verified |
 *   |-------------------------------|---------|----------|
 *   | N=100 k=10 budget 2000ms      | ~2.2s   | false (temporal truncates) |
 *   | N=25  k=100 unbounded         | ~1.3s   | true     |
 *   | N=25  k=100 budget 300ms      | ~0.31s  | false (temporal truncates) |
 *   | N=25  temporal OFF unbounded  | ~0.39s  | true     |
 *
 * The regression signal is loud in the `k` dimension: N=25 at k=200 is ~3.7s and
 * at k=300 is ~8.8s, so an encoding regression that reintroduces the unpruned
 * tail cross-product blows straight through the ceiling (or crashes the WASM
 * heap, which fails just as visibly).
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

// ---------------------------------------------------------------------------
// AC-2-8 temporal scale gate constants
// ---------------------------------------------------------------------------

/**
 * Trace bound for the temporal scale gate's `k`-dimension case. 10× the CLI
 * default of 10, so the `O(k²)`/`O(k³)` axis is genuinely exercised rather than
 * nominally enabled, and half the committed `--temporal-bound` ceiling of 200 —
 * inside the surface an operator can actually request.
 */
const TEMPORAL_BOUND = 100

/**
 * Requirement count for the `k`-dimension case. Not `SCALE_N`: at N=100 the
 * earlier `O(N²)` tiers eat the whole budget and the temporal tier is SKIPPED
 * before it starts (check-before-work), so a k-scaling regression would hide
 * behind an unrelated truncation. N=25 leaves the temporal tier as the dominant
 * cost — measured 0.39s temporal-OFF vs 1.3s at k=100, ~3.3× — which is what
 * makes the relative assertion below mean something.
 */
const TEMPORAL_N = 25

/**
 * Whole-run budget for the temporal TRUNCATION case, sized from measurement:
 * N=25/k=100 needs ~1.3s unbounded, so 300ms lands the deadline mid-run and the
 * temporal tier reliably records a truncation (verified across a 1/50/200/800/
 * 3200ms sweep — see the monotonicity case).
 */
const TEMPORAL_BUDGET_MS = 300

/**
 * Committed latency ceiling for the temporal cases: 8× the temporal-tier
 * workload, following `LATENCY_CEILING_MS`'s multiplier idiom rather than a bare
 * absolute number, so a busy CI runner cannot flake it.
 *
 * The base is the measured unbounded N=25/k=100 cost (~1.3s), rounded up to
 * 1500ms; 8× is 12s. Generous on purpose: the point is a CEILING on a loaded
 * machine, not a benchmark. A regression to the unpruned `O(P·N)` tail
 * cross-product either crashes the WASM heap or lands far past this — for scale,
 * merely raising `k` from 100 to 300 at this N is already ~8.8s, and the failure
 * modes this catches are order-of-magnitude, not marginal.
 */
const TEMPORAL_WORKLOAD_MS = 1500
const TEMPORAL_CEILING_MS = TEMPORAL_WORKLOAD_MS * 8

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

// ---------------------------------------------------------------------------
// AC-2-8 — the temporal tier's committed feasibility gate
// ---------------------------------------------------------------------------

describe(`AC-2-8 temporal scale gate — bounded LTL→SMT at N=${TEMPORAL_N}, k=${TEMPORAL_BOUND}`, () => {
  it(
    `bounds a k=${TEMPORAL_BOUND} run within ${TEMPORAL_CEILING_MS}ms and reports verified:false when truncated`,
    async () => {
      // TWO runs of the SAME document back every assertion here — a budgeted one
      // and an unbounded one — because the sharp claim is RELATIVE (see below)
      // and a relative claim needs both legs. Both are cheap at TEMPORAL_N.
      const doc = scaleDoc(TEMPORAL_N)

      const budgetedStart = performance.now()
      const budgeted = await runCheck(doc, {
        solverBudgetMs: TEMPORAL_BUDGET_MS,
        semantic: { embedder: fakeEmbedder },
        temporal: { bound: TEMPORAL_BOUND },
      })
      const budgetedMs = performance.now() - budgetedStart

      const unboundedStart = performance.now()
      const unbounded = await runCheck(doc, {
        semantic: { embedder: fakeEmbedder },
        temporal: { bound: TEMPORAL_BOUND },
      })
      const unboundedMs = performance.now() - unboundedStart

      // Logged on SUCCESS too, so a CI log shows the trend before it becomes a
      // failure (the temporal-feasibility precedent prints its latency as well).
      console.log(
        `AC-2-8 temporal scale gate: N=${TEMPORAL_N}, k=${TEMPORAL_BOUND}, ` +
          `budgeted(${TEMPORAL_BUDGET_MS}ms) ${budgetedMs.toFixed(0)}ms verified=${budgeted.verified} vs ` +
          `unbounded ${unboundedMs.toFixed(0)}ms verified=${unbounded.verified} ` +
          `(ceiling ${TEMPORAL_CEILING_MS}ms)`,
      )

      // (1) LATENCY — the committed ceiling, on the run that does the most work.
      expect(unboundedMs).toBeLessThan(TEMPORAL_CEILING_MS)

      // (2) The fixture really reached the temporal tier. It runs over ALL
      // requirements rather than the gate-included subset, so `encoded` is the
      // propositional-gate check; asserting it here keeps the same guard the
      // AC-1-7 cases have against this degrading into a no-op.
      expect(unbounded.coverage.encoded).toBe(TEMPORAL_N)
      expect(unbounded.coverage.excluded).toBe(0)

      // (3) The RELATIVE assertion — machine-independent, and the sharper one.
      // Enabling the temporal tier at 10× the default bound must be measurably
      // more work than the budgeted run that stops partway through it. If the
      // budget stopped reaching the temporal tier, these two would converge no
      // matter how fast the box is.
      expect(budgetedMs).toBeLessThan(unboundedMs)

      // (4) HONESTY — the truncated run does NOT claim to have verified anything,
      // and it names the temporal tier specifically. Without this, a temporal
      // blowup could be "fixed" by silently skipping the tier.
      expect(budgeted.verified).toBe(false)
      const budgetDemotions = budgeted.coverage.demotions.filter(
        (d) => d.reason === 'solver-budget-exhausted',
      )
      expect(budgetDemotions.length).toBeGreaterThan(0)
      expect(budgetDemotions.some((d) => d.action.includes('temporal'))).toBe(true)

      // (5) The same document unbounded IS verified, so the `verified: false`
      // above is caused by the DEADLINE and not by the temporal tier finding
      // something (or by some property of the fixture).
      expect(unbounded.coverage.demotions.map((d) => d.reason)).not.toContain(
        'solver-budget-exhausted',
      )
      expect(unbounded.verified).toBe(true)
    },
    TEMPORAL_CEILING_MS * 4,
  )

  it(
    'degradation is MONOTONE in the budget with the temporal tier enabled',
    async () => {
      // The `degradation-must-be-monotone-in-its-budget` lesson: a resource knob
      // must never have a middle band that fails harder than both a tighter and a
      // looser setting. That lesson was learned with `--temporal` OFF; enabling a
      // tier whose encode phase is O(k²)–O(k³) and NOT interruptible by the
      // per-solver timeout is exactly the kind of change that could reintroduce
      // the ERR_SOLVER_TIMEOUT band, so the sweep is re-run with it on.
      //
      // The invariant is the lesson's disjunction, not a conjunction: every
      // budget either produced the verdict or ADMITTED it was cut short — never
      // a throw, never silence. Measured sweep on this machine (N=25, k=100):
      //   budget=1ms    → 20ms,   verified=false, 6 truncations (incl. temporal)
      //   budget=50ms   → 67ms,   verified=false, 5 truncations (incl. temporal)
      //   budget=200ms  → 220ms,  verified=false, 5 truncations (incl. temporal)
      //   budget=800ms  → 1407ms, verified=true,  0 truncations
      //   budget=3200ms → 1272ms, verified=true,  0 truncations
      // Truncation counts are non-increasing and no band errors. Whole sweep ~3s.
      const doc = scaleDoc(TEMPORAL_N)
      const budgets = [1, 50, 200, 800, 3200] as const
      const rows: { budget: number; verified: boolean; truncations: number }[] = []

      for (const budget of budgets) {
        // A throw here IS the failure mode the lesson names (exit 2, no report at
        // all, where a tighter budget returned a usable partial verdict), so this
        // await is deliberately not wrapped: an unhandled rejection fails the gate.
        const report = await runCheck(doc, {
          solverBudgetMs: budget,
          semantic: { embedder: fakeEmbedder },
          temporal: { bound: TEMPORAL_BOUND },
        })
        rows.push({
          budget,
          verified: report.verified,
          truncations: report.coverage.demotions.filter(
            (d) => d.reason === 'solver-budget-exhausted',
          ).length,
        })
      }

      console.log(
        `AC-2-8 temporal monotonicity (N=${TEMPORAL_N}, k=${TEMPORAL_BOUND}): ` +
          rows.map((r) => `${r.budget}ms→verified=${r.verified}/${r.truncations}trunc`).join(' '),
      )

      // (1) EVERY band returned a report — the disjunction's "never silence, never
      // a hard error where a softer setting succeeds" half.
      expect(rows).toHaveLength(budgets.length)

      // (2) EVERY band is honest: it either verified, or it disclosed truncation.
      // Never both, never neither.
      for (const r of rows) {
        expect(r.verified ? r.truncations === 0 : r.truncations > 0).toBe(true)
      }

      // (3) MONOTONE: a looser budget never discloses MORE truncated tiers than a
      // tighter one, and never un-verifies a run a tighter budget verified. This
      // is the assertion that would have caught the 2000ms error band.
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!
        const cur = rows[i]!
        expect(cur.truncations).toBeLessThanOrEqual(prev.truncations)
        if (prev.verified) expect(cur.verified).toBe(true)
      }

      // (4) The sweep is not vacuous in either direction — the tightest budget
      // truncated and the loosest verified, so the monotone chain above spans a
      // real transition rather than five identical rows.
      expect(rows[0]!.truncations).toBeGreaterThan(0)
      expect(rows.at(-1)!.verified).toBe(true)
    },
    TEMPORAL_CEILING_MS * 4,
  )
})
