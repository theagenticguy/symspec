/**
 * Z3-WASM bounded-LTL feasibility benchmark (AC-33-0, the v3.3 GATE).
 *
 * Before any temporal encoding is committed, symspec must prove that a
 * REPRESENTATIVE bounded-LTL → SMT problem discharges within acceptable
 * latency on the SAME in-process Z3-WASM the SMT tier already uses
 * (`src/formal/backend.ts:getContext`). If this is infeasible in-process, the
 * temporal tier ships external-backend-only (spec AC-33-0). This script IS the
 * benchmark; it prints a machine-readable line plus a clear FEASIBLE /
 * INFEASIBLE verdict with the measured latency.
 *
 * What it encodes — a linear (Latvala/Biere "Simple Bounded LTL Model
 * Checking") unrolling of the Response-pattern property `G(trig → F resp)`
 * over a bounded trace of k steps, conjoined with a contradicting scenario so
 * the problem is provably UNSAT at the bound:
 *
 *   - one Boolean per step for each atom: trig_0..trig_k, resp_0..resp_k;
 *   - `G φ` over a finite prefix  :=  ⋀_{i=0..k} φ@i;
 *   - `F resp` evaluated at step i :=  ⋁_{j=i..k} resp_j   (no-loop suffix
 *     semantics — the honest bounded reading, matching the SAT-at-k caveat the
 *     temporal tier will report);
 *   - contradiction: assert `trig_0` true and every `resp_j` false. Then
 *     `F resp @ 0` is false while `trig_0 → F resp @ 0` is required, so the
 *     conjunction is UNSAT — a sound bounded refutation, exactly the shape
 *     AC-33-2's `FND_TEMPORAL_CONTRADICTION` relies on.
 *
 * Grounded in Latvala/Biere (linear bounded-LTL encoding) and Li/Vardi/Rozier
 * (MLTL-to-SMT). Run with:  pnpm exec tsx scripts/temporal-feasibility.ts
 */

import { performance } from 'node:perf_hooks'
import { getContext, type Z3Context } from '../src/formal/backend.js'

/** A `z3-solver` Bool expression, as produced by a {@link Z3Context}. */
type Z3Bool = ReturnType<Z3Context['Bool']['const']>

/** Acceptable in-process latency ceiling for a representative bound (ms). */
const LATENCY_BUDGET_MS = 1000

/**
 * Encode the bounded Response property + its contradiction at bound `k` and
 * discharge it on the shared in-process Z3-WASM. Returns the sat result and
 * the wall-clock latency of the encode-plus-check.
 */
async function runBoundedResponse(
  k: number,
): Promise<{ bound: number; satResult: string; elapsedMs: number }> {
  const ctx = await getContext(`temporal-feasibility-k${k}`)
  const { Solver, Bool, Not, And, Or, Implies } = ctx

  const start = performance.now()

  // One Boolean per step per atom (Latvala/Biere linear unrolling).
  const trig: Z3Bool[] = []
  const resp: Z3Bool[] = []
  for (let i = 0; i <= k; i++) {
    trig.push(Bool.const(`trig_${i}`))
    resp.push(Bool.const(`resp_${i}`))
  }

  const solver = new Solver()
  solver.set('timeout', 5000)

  // G(trig → F resp)  :=  ⋀_i ( trig_i → ⋁_{j≥i} resp_j ).
  for (let i = 0; i <= k; i++) {
    const eventuallyResp = Or(...resp.slice(i))
    solver.add(Implies(trig[i]!, eventuallyResp))
  }

  // Contradicting scenario: trig fires at step 0, response never occurs.
  solver.add(trig[0]!)
  solver.add(And(...resp.map((r) => Not(r))))

  const satResult = await solver.check()
  const elapsedMs = performance.now() - start
  return { bound: k, satResult, elapsedMs }
}

async function main(): Promise<void> {
  // Warm the WASM init once (its ~110 ms one-time cost is not part of the
  // per-check latency we are gating on) with a throwaway small bound.
  await runBoundedResponse(1)

  const bounds = [10, 15, 20]
  const results: { bound: number; satResult: string; elapsedMs: number }[] = []
  for (const k of bounds) {
    const r = await runBoundedResponse(k)
    results.push(r)
    console.log(JSON.stringify(r))
  }

  // The gate: the representative bound (largest, k=20) must prove UNSAT within
  // budget. UNSAT is the correctness signal (the contradiction is refuted);
  // latency is the feasibility signal.
  const representative = results.at(-1)!
  const provedUnsat = representative.satResult === 'unsat'
  const withinBudget = representative.elapsedMs <= LATENCY_BUDGET_MS
  const feasible = provedUnsat && withinBudget

  console.log('')
  console.log(`AC-33-0 bounded-LTL feasibility gate (in-process Z3-WASM)`)
  console.log(
    `  representative bound k=${representative.bound}: ` +
      `${representative.satResult} in ${representative.elapsedMs.toFixed(1)} ms ` +
      `(budget ${LATENCY_BUDGET_MS} ms)`,
  )
  console.log(
    `  VERDICT: ${feasible ? 'FEASIBLE' : 'INFEASIBLE'} — ` +
      (feasible
        ? 'bounded temporal LTL/MLTL can ship in-process.'
        : provedUnsat
          ? 'sound but over latency budget; ship temporal tier external-backend-only.'
          : 'representative encoding did not refute — encoding is unsound, do NOT ship.'),
  )

  // Non-zero exit if infeasible so a CI gate can branch on it.
  process.exit(feasible ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error('temporal-feasibility benchmark failed:', err)
  process.exit(2)
})
