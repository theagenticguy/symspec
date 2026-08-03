/**
 * In-process WASM Z3 backend (AC-4-1).
 *
 * symspec's default formal-methods tier runs entirely in-process via the
 * `z3-solver` npm package (Z3 compiled to WASM) — no external `z3`/`cvc5`
 * binary is required for a working `symspec check`. This module owns the
 * one-time WASM init and hands back a fresh, named `Context` per logical
 * session so downstream modules (encoder, contradiction/subsumption/vacuity
 * checks) never touch `z3-solver`'s module surface directly.
 *
 * Design notes:
 *   - `init()` from `z3-solver` is expensive (~110 ms measured) and must run
 *     exactly once per process. We memoize the in-flight promise so
 *     concurrent callers (e.g. multiple context-group checks kicked off in
 *     parallel) share one WASM instantiation instead of racing separate
 *     inits.
 *   - The `z3-solver` import itself is dynamic (`await import('z3-solver')`)
 *     so that any code path that never calls into the formal tier (parse,
 *     lint-only `check`, `add`, etc.) never pays the WASM load cost and,
 *     just as important, never requires the dependency to resolve if it is
 *     ever made optional. Static analysis (knip) still sees the import.
 *   - This module intentionally exposes only the pieces every consumer of
 *     the formal tier needs: a fresh `Context`, and an `isAvailable` probe
 *     for `manifest --backends` (AC-6-14) to report `z3-wasm` availability
 *     without booting a full solver session.
 *
 * ## THE LAYER SEAM (transplant edit #4 of 4 — the only functional one)
 *
 * This is the whole cost of putting ~7.8k LOC of formal tier behind an Effect
 * Layer. Measured on the donor: this file is the ONLY importer of `z3-solver`, and
 * exactly three non-test files call {@link getContext}. So priming this module's
 * memoized `inflight` promise from the Layer's `acquire` gives every tier below —
 * contradiction, subsumption, vacuity, incomplete, needs-review, numeric,
 * temporal — the Layer-owned WASM instance with NO signature change anywhere. The
 * S3 spike proved byte-identical findings on the hardest adversarial fixture with
 * zero edits to any other tier file.
 *
 * {@link primeZ3} and {@link resetZ3} are the two functions added. Everything else
 * in this file is the donor's, unchanged — including `loadZ3`'s lazy dynamic
 * import, which still serves a direct library caller who never built the Layer.
 *
 * `resetZ3` exists for the Layer's RELEASE and for `Layer.fresh`: without it, a
 * released Layer would leave a stale module in the memo and the next build would
 * silently reuse a WASM instance whose owner is gone.
 */

import type { Z3HighLevel, Z3LowLevel } from 'z3-solver'

/** The subset of the z3-solver top-level API this module re-exports to callers. */
export type Z3Module = Z3HighLevel & Z3LowLevel

/** A context obtained from `getContext()`, ready to construct a `Solver`. */
export type Z3Context = ReturnType<Z3Module['Context']>

let inflight: Promise<Z3Module> | undefined

/**
 * Hand a Layer-booted module to this module's memo, so every tier below reaches
 * THAT instance through the unchanged {@link getContext}.
 *
 * The single injection point the wrap-in-place strategy rests on. Called only
 * from the `SolverService` Layer's acquire (`../../solver-service.ts`).
 */
export function primeZ3(module: Z3Module): void {
  inflight = Promise.resolve(module)
}

/**
 * Clear the memo. Called from the Layer's release so a `Layer.fresh` rebuild
 * genuinely re-inits rather than reusing a module whose owning scope has closed.
 */
export function resetZ3(): void {
  inflight = undefined
}

/**
 * Lazily import and initialize the z3-solver WASM module exactly once per
 * process. Safe to call concurrently — all callers share the same init.
 */
async function loadZ3(): Promise<Z3Module> {
  if (!inflight) {
    inflight = (async () => {
      const { init } = await import('z3-solver')
      return init()
    })()
  }
  return inflight
}

/**
 * Obtain a fresh named Z3 `Context` backed by the shared in-process WASM
 * instance. Each call returns an independent context (Z3 contexts are
 * cheap relative to the one-time WASM init), so callers may create one per
 * context-group check without re-paying init cost.
 */
export async function getContext(name = 'symspec'): Promise<Z3Context> {
  const z3 = await loadZ3()
  return z3.Context(name)
}

/**
 * Probe backend availability without retaining any solver state — used by
 * `manifest --backends` (AC-6-14) to report the z3-wasm backend as always
 * available, and by smoke tests to prove a fresh install runs the SMT tier
 * with no PATH binary. Resolves the Z3 version string on success so the
 * manifest can surface it.
 */
export async function probeBackend(): Promise<
  { available: true; version: string } | { available: false; error: string }
> {
  try {
    const z3 = await loadZ3()
    return { available: true, version: z3.getVersionString() }
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) }
  }
}
