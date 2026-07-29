/**
 * Bounded-LTL feasibility + polarity gate for the temporal tier (AC-33-0,
 * rewired and re-pointed at the SHIPPED lowering by AC-2-8).
 *
 * Before any temporal encoding is committed, symspec must prove that a
 * REPRESENTATIVE bounded-LTL → SMT problem discharges within acceptable
 * latency on the SAME in-process Z3-WASM the SMT tier already uses
 * (`src/formal/backend.ts:getContext`). If this is infeasible in-process, the
 * temporal tier ships external-backend-only (spec AC-33-0). This script IS the
 * benchmark; it prints one machine-readable line per bound plus a clear
 * FEASIBLE / INFEASIBLE verdict with the measured latency.
 *
 * ## Two defects this file used to have, and what replaced them
 *
 * **(1) It gated nothing (V19).** The budget, the warm-up, and the non-zero
 * exit were all here — but the script was referenced in no `package.json`
 * script, no `lefthook.yml` job, and no workflow. Only `knip.json` type-checked
 * it. A gate nobody runs is documentation. It is now `pnpm gate:temporal`,
 * chained into `pnpm check` (so GitHub Actions runs it) and into the pre-push
 * hook.
 *
 * **(2) It re-implemented the lowering by hand.** The old body built its own
 * `G(trig → F resp)` unrolling inline, which meant it benchmarked a DIFFERENT
 * encoding than the one that ships — and, measured, it had frozen the
 * PRE-AC-2-6 defective semantics (`F φ ≡ ⋁_{i≤k} φ@i`, with no pending
 * literal). It now calls the exported {@link findTemporalContradictions} over
 * requirements built by the exported {@link earsToTemporal}, so the numbers
 * below describe the shipped code and the gate cannot silently drift from it.
 *
 * ## The two-factor verdict, now three-factor
 *
 * Latency alone is not a gate: an encoding that answers instantly because it
 * proves nothing is worse than a slow one. So the verdict is a conjunction over
 * a POLARITY PAIR at every bound:
 *
 *   - the CONFLICTING set must yield exactly one `FND_TEMPORAL_CONTRADICTION`
 *     naming both culprits (soundness/recall — the encoding still refutes);
 *   - the CONSISTENT set must yield NO finding (the encoding does not
 *     manufacture conflicts — this is the direction AC-2-6 repaired, and the
 *     direction a horizon-collapse regression breaks first); and
 *   - the representative (largest) bound must land within
 *     {@link LATENCY_BUDGET_MS} (feasibility).
 *
 * The fixtures are real EARS requirements, not hand-built formulas, so
 * `earsToTemporal`'s pattern mapping is in the gate too:
 *
 *   - CONFLICT — `event-driven` "when the tank pressure exceeds the limit, the
 *     valve controller shall open the relief valve" → `G(T → F open)`, against
 *     `ubiquitous` + `negated` "the valve controller shall not open the relief
 *     valve" → `G(¬open)`. With `T` asserted reachable, `F open` and `G ¬open`
 *     cannot both hold: a genuine bounded refutation, exactly the shape
 *     `FND_TEMPORAL_CONTRADICTION` relies on.
 *   - CONSISTENT — two `event-driven` obligations on disjoint triggers and
 *     disjoint responses. LTL-satisfiable at every bound. Pre-AC-2-6 this
 *     family is what the collapsing eventuality lowering turned into false
 *     `unsat` at `error` severity.
 *
 * ## Measured on this machine (2026-07-29, warm-up excluded)
 *
 * Via the shipped `findTemporalContradictions`, 2 requirements:
 *
 *   | bound k | conflict (finds it) | consistent (stays quiet) |
 *   |---------|---------------------|--------------------------|
 *   | 10      | 9.2 ms  ✓           | 14.3 ms ✓                |
 *   | 20      | 19.6 ms ✓           | 14.1 ms ✓                |
 *   | 50      | 22.5 ms ✓           | 34.5 ms ✓                |
 *   | 100     | 47.8 ms ✓           | 90.2 ms ✓                |
 *
 * The sweep runs `[10, 15, 20]` and the representative bound is k=20, where the
 * worst measured leg is ~20 ms against a 1000 ms budget — a ~50× margin, ample
 * for a slower CI runner. (For reference, the same call at k=200 is 143/266 ms,
 * still inside budget; the encoding only becomes expensive at N≫2 — see the
 * `--temporal-bound` ceiling in `src/cli/index.ts` for that axis.)
 *
 * Grounded in Latvala/Biere (linear bounded-LTL encoding) and Li/Vardi/Rozier
 * (MLTL-to-SMT). Run with:  pnpm gate:temporal
 */

import { performance } from 'node:perf_hooks'
import { makeAtomize } from '../src/formal/atomize.js'
import { getContext } from '../src/formal/backend.js'
import { findTemporalContradictions } from '../src/formal/temporal.js'
import { earsToTemporal } from '../src/formal/temporal-patterns.js'
import type { ReqView } from '../src/solvers/types.js'

/**
 * Acceptable in-process latency ceiling for a representative bound (ms).
 *
 * Measured worst leg at the representative bound k=20 on this machine: ~20 ms
 * (see the table in the header). 1000 ms is a ~50× headroom ceiling, not a
 * benchmark — it must not flake on a loaded CI runner, while a regression to a
 * genuinely infeasible encoding lands orders of magnitude over it.
 */
const LATENCY_BUDGET_MS = 1000

const SYSTEM = 'valve controller'
const RESPONSE = 'open the relief valve'
const TRIGGER = 'the tank pressure exceeds the limit'

/** Build a minimal {@link ReqView} for the fixtures (no doc, no storage). */
function view(id: string, patternType: ReqView['patternType'], extra: Partial<ReqView>): ReqView {
  return {
    id,
    patternType,
    systemName: SYSTEM,
    systemResponse: RESPONSE,
    negated: false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    ...extra,
  }
}

/**
 * The CONFLICTING fixture: a response obligation against a global absence on
 * the same response. `G(T → F open) ∧ G(¬open)` with `T` reachable — provably
 * unsatisfiable at every bound. The gate requires this to be FOUND.
 */
const CONFLICT: readonly ReqView[] = [
  view('conflict-response', 'event-driven', { trigger: TRIGGER }),
  view('conflict-absence', 'ubiquitous', { negated: true }),
]

/**
 * The CONSISTENT fixture: two response obligations over disjoint triggers and
 * disjoint responses. LTL-satisfiable at every bound. The gate requires this to
 * stay SILENT — the polarity canary a horizon-collapse regression trips first.
 */
const CONSISTENT: readonly ReqView[] = [
  view('safe-response', 'event-driven', { trigger: TRIGGER }),
  view('safe-other', 'event-driven', {
    trigger: 'the operator presses the reset button',
    systemResponse: 'clear the fault log',
  }),
]

/** One leg of the polarity pair at one bound. */
interface Leg {
  readonly findings: number
  readonly culprits: readonly string[]
  readonly elapsedMs: number
}

/**
 * Run the SHIPPED temporal tier over a fixture at bound `k` on the shared
 * in-process Z3-WASM, and time the encode-plus-check. Deliberately goes through
 * `earsToTemporal` + `findTemporalContradictions` — the exported production
 * path — so the gate cannot benchmark an encoding that is not the one shipping.
 */
async function runLeg(label: string, reqs: readonly ReqView[], k: number): Promise<Leg> {
  const ctx = await getContext(`temporal-feasibility-${label}-k${k}`)
  // AC-2-7: `earsToTemporal` now REQUIRES the shared atomizer, so the temporal
  // tier can no longer be called in a configuration where it is blind to the
  // glossary/antonym commitments the propositional tier sees. This gate has no
  // document, hence no committed glossary or antonym pairs, so it passes the
  // seed-only atomizer — which is exactly what `check` builds for a document
  // whose `glossary` and `antonyms` are empty, so the benchmark still measures
  // the shipped path.
  const atomize = makeAtomize()
  const mapped = reqs.map((r) => ({ id: r.id, formula: earsToTemporal(r, atomize) }))
  const start = performance.now()
  const findings = await findTemporalContradictions(ctx, mapped, k, { timeoutMs: 5000 })
  const elapsedMs = performance.now() - start
  return { findings: findings.length, culprits: findings[0]?.requirementIds ?? [], elapsedMs }
}

/** Both legs of the polarity pair at one bound, plus the derived verdict bits. */
interface BoundResult {
  readonly bound: number
  readonly conflictFindings: number
  readonly conflictCulprits: readonly string[]
  readonly conflictMs: number
  readonly consistentFindings: number
  readonly consistentMs: number
  /** The conflict was refuted AND the consistent set was left alone. */
  readonly polarityOk: boolean
  /** The slower of the two legs — what the latency budget is compared against. */
  readonly worstMs: number
}

async function runBound(k: number): Promise<BoundResult> {
  const conflict = await runLeg('conflict', CONFLICT, k)
  const consistent = await runLeg('consistent', CONSISTENT, k)
  const polarityOk =
    conflict.findings === 1 && conflict.culprits.length === 2 && consistent.findings === 0
  return {
    bound: k,
    conflictFindings: conflict.findings,
    conflictCulprits: conflict.culprits,
    conflictMs: +conflict.elapsedMs.toFixed(1),
    consistentFindings: consistent.findings,
    consistentMs: +consistent.elapsedMs.toFixed(1),
    polarityOk,
    worstMs: +Math.max(conflict.elapsedMs, consistent.elapsedMs).toFixed(1),
  }
}

async function main(): Promise<void> {
  // Warm the WASM init once (its ~110 ms one-time cost is not part of the
  // per-check latency we are gating on) with a throwaway small bound.
  await runBound(1)

  const bounds = [10, 15, 20]
  const results: BoundResult[] = []
  for (const k of bounds) {
    const r = await runBound(k)
    results.push(r)
    console.log(JSON.stringify(r))
  }

  // The gate, three factors:
  //   - POLARITY at EVERY bound (not just the representative one): the conflict
  //     is refuted and the consistent set is not. A regression that only breaks
  //     at a small bound is still a regression.
  //   - LATENCY at the representative (largest) bound.
  const representative = results.at(-1)!
  const polarityHeld = results.every((r) => r.polarityOk)
  const withinBudget = representative.worstMs <= LATENCY_BUDGET_MS
  const feasible = polarityHeld && withinBudget

  console.log('')
  console.log('AC-33-0/AC-2-8 bounded-LTL feasibility + polarity gate (in-process Z3-WASM)')
  console.log(
    `  representative bound k=${representative.bound}: ` +
      `conflict ${representative.conflictFindings === 1 ? 'REFUTED' : 'MISSED'} in ` +
      `${representative.conflictMs} ms, consistent ` +
      `${representative.consistentFindings === 0 ? 'CLEAN' : 'FALSE-POSITIVE'} in ` +
      `${representative.consistentMs} ms ` +
      `(worst ${representative.worstMs} ms, budget ${LATENCY_BUDGET_MS} ms)`,
  )
  console.log(
    `  VERDICT: ${feasible ? 'FEASIBLE' : 'INFEASIBLE'} — ` +
      (feasible
        ? 'the shipped bounded temporal encoding is sound-for-UNSAT on the polarity pair and in budget.'
        : polarityHeld
          ? 'sound but over latency budget; ship temporal tier external-backend-only.'
          : 'the shipped encoding either MISSED the conflict or manufactured one on a satisfiable set — do NOT ship.'),
  )
  if (!polarityHeld) {
    for (const r of results.filter((x) => !x.polarityOk)) {
      console.error(
        `  polarity FAILED at k=${r.bound}: conflict findings=${r.conflictFindings} ` +
          `(expected 1, culprits=${JSON.stringify(r.conflictCulprits)}), ` +
          `consistent findings=${r.consistentFindings} (expected 0)`,
      )
    }
  }

  // Non-zero exit if infeasible so a CI gate can branch on it.
  process.exit(feasible ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error('temporal-feasibility benchmark failed:', err)
  process.exit(2)
})
