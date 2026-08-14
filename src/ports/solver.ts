/**
 * `SolverService` — the Z3 capability as a contract.
 *
 * The SHAPE (one sanctioned `solve`, an explicit boot, per-check contexts), the
 * interruptible-solve primitive it promises, and the concurrency bound live
 * here; the WASM boot and the Layer that owns the module live in
 * `adapters/z3/solver-service.ts`. `domain/reachability` and the operations
 * name this key; only the composition root names the Layer.
 */

import { Context, Effect } from 'effect'
import type { Z3Context, Z3Module } from '../domain/engine/formal/backend.ts'

// ---------------------------------------------------------------------------
// The concurrency bound, as a value
// ---------------------------------------------------------------------------

/**
 * The maximum number of solver calls that may be in flight against one WASM
 * instance. It is `1`, structurally: Asyncify holds one global `capability` slot.
 *
 * Exported as a constant so a future parallel-solving change has to CONFRONT it
 * rather than not notice it. The only safe route to parallelism is N WASM
 * instances (i.e. N workers), which the S3 spike priced and deferred.
 */
export const SOLVER_CONCURRENCY = 1

// ---------------------------------------------------------------------------
// The interruptible solve primitive
// ---------------------------------------------------------------------------

/**
 * A cancellable in-flight Z3 query: the thing to start, and the context-level
 * interrupt that cancels it.
 *
 * Deliberately minimal and deliberately NOT tied to `Z3Context`. The high-level
 * API's `context.interrupt()` and the low-level `Z3.interrupt(ctxPtr)` both fit,
 * which is what lets the same primitive wrap a `Solver.check()` and a Spacer
 * `fixedpoint_query` (G4) without a second mechanism.
 */
export interface CancellableQuery<A> {
  /** Start the query. Called exactly once, synchronously, by
   * {@link interruptibleSolve}. */
  readonly start: () => Promise<A>
  /** `Z3_interrupt` on the OWNING context. Must be the context the query runs on
   * — interrupting a different context does nothing. */
  readonly interrupt: () => void
}

/**
 * Run a Z3 query so that fiber interruption is a REAL kill and the WASM module
 * survives it.
 *
 * The shape is forced by the three measured facts in the module header:
 *
 * - `Effect.callback` because its return value is the canceler (there is no
 *   `Effect.async` in v4);
 * - the canceler calls `interrupt()` so Z3 actually stops, rather than the fiber
 *   walking away from a query that has bricked the module;
 * - the canceler is an `Effect.promise` that AWAITS the in-flight promise, because
 *   the Asyncify `capability` slot is released on settlement, not on interrupt.
 *
 * `.catch(() => undefined)` twice, for two different reasons: the `pending.then`
 * rejection handler keeps an interrupted query from becoming an unhandled
 * rejection, and the canceler's `.catch` lets the finalizer complete when the
 * query settles as a REJECTION (which is how an interrupted low-level query can
 * come back).
 *
 * @param query the query to run, plus its owning context's interrupt
 * @param onInterrupted the value to resume with if the promise rejects. A query
 *   that rejects is not a defect here — an interrupted Z3 query legitimately
 *   rejects — so the caller supplies the conservative answer for its tier
 *   (`'unknown'` for a check, `-1` for a raw query code).
 */
export const interruptibleSolve = <A>(
  query: CancellableQuery<A>,
  onInterrupted: A,
): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    const pending = query.start()
    pending.then(
      (value) => resume(Effect.succeed(value)),
      () => resume(Effect.succeed(onInterrupted)),
    )
    // THE CANCELER. Interrupt Z3, then WAIT for the query to unwind — the await is
    // what releases Asyncify's one capability slot. Dropping the await leaves the
    // module wedged for the rest of the process (guard test: `solver-service.test.ts`
    // → "the await-after-interrupt discipline").
    return Effect.promise(async () => {
      query.interrupt()
      await pending.catch(() => undefined)
    })
  })

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * What a consumer of the formal tier may do with Z3.
 *
 * ## `boot` is an EFFECT, and that is the whole laziness mechanism
 *
 * Every capability is behind {@link SolverShape.boot} rather than sitting on the
 * shape as a plain value, because of a v4 behavior that is the opposite of what
 * "lazy layer" suggests:
 *
 *   **A provided Layer is BUILT EAGERLY, whether or not any consumer reaches its
 *   service.** Probed directly on beta.102: `Effect.succeed(1).pipe(
 *   Effect.provide(layer))` runs the layer's construction effect, and
 *   `Layer.mergeAll(cheap, expensive)` builds BOTH even when only `cheap` is
 *   yielded.
 *
 * So a shape carrying `module: Z3Module` would boot the WASM module on `symspec
 * version` — a ~200-1000ms tax on every command in the tool, for a capability only
 * `check` uses. Putting the boot behind an `Effect.cached` inside the shape moves
 * the cost to FIRST USE while keeping the Layer's ownership of the lifetime: the
 * `acquireRelease` runs in the LAYER's scope (explicitly provided, see
 * {@link solverServiceLayer}), so release still fires on scope close, and `cached`
 * guarantees one boot no matter how many callers ask.
 *
 * ## Everything that reaches the solver goes through `solve`
 *
 * Narrow on purpose: `context` hands out a Z3 `Context` for TERM BUILDING (pure, it
 * does not touch the Asyncify slot); the moment a query is issued it is
 * {@link interruptibleSolve}'s job. There is no second path an "optimization" could
 * take.
 */
export interface SolverShape {
  /**
   * Boot (or reuse) the WASM module and its Z3 version string.
   *
   * Memoized via `Effect.cached`: the FIRST call pays the init, every later call is
   * free, and the module is released when the Layer's scope closes. Yielding this
   * is what a tier does to say "I actually need Z3 now".
   */
  readonly boot: Effect.Effect<BootedSolver>
  /**
   * A fresh named Z3 `Context` off the shared instance, booting on first use.
   * Contexts are cheap relative to the one-time WASM init, so one per
   * context-group check is fine.
   */
  readonly context: (name?: string) => Effect.Effect<Z3Context>
  /**
   * THE sanctioned solver call. `interruptibleSolve` itself, exposed on the service
   * so a tier holding the service cannot reach a solver without it.
   */
  readonly solve: <A>(query: CancellableQuery<A>, onInterrupted: A) => Effect.Effect<A>
}

/** The booted module plus the one thing worth reading off it eagerly. */
export interface BootedSolver {
  /**
   * The Layer-owned WASM module. Exposed for the low-level `Z3` namespace the
   * Spacer tier (G4) needs. Holding it does not usefully bypass the discipline — a
   * raw query still has to be wrapped to be interruptible, and
   * {@link SolverShape.solve} is that wrapper.
   */
  readonly module: Z3Module
  /** The Z3 version string, read once at boot. */
  readonly version: string
}

/**
 * The service key. `Context.Service<Self, Shape>()('Id')` — v4's class-style key
 * (there is no `Context.Tag`). The class value IS the Context key and carries
 * `.use` / `.useSync` / `.of` directly.
 */
export class SolverService extends Context.Service<SolverService, SolverShape>()(
  'symspec/SolverService',
) {}
