/**
 * `SolverService` — the transplanted Z3-WASM formal tier behind ONE Effect Layer,
 * and {@link interruptibleSolve}, the ONLY sanctioned way to reach the solver.
 *
 * ## What the Layer buys, and why it is nearly free
 *
 * The donor reached Z3 through a module-level memoized promise
 * (`donor/formal/backend.ts`: `let inflight: Promise<Z3Module> | undefined`). That
 * is a global no caller can scope, restart, or dispose. A Layer can be `fresh`ed,
 * built into a `ManagedRuntime`, and disposed, and its scope OWNS the WASM
 * lifetime.
 *
 * The transplant cost is one injection point, not a ~7.8k-LOC Effect-ization.
 * Measured on the donor: `backend.ts` is the ONLY importer of `z3-solver`, and
 * exactly three non-test files call `getContext()`. So {@link solverServiceLayer}'s
 * acquire boots the module and PRIMES that memo, and every tier below —
 * contradiction, subsumption, vacuity, incomplete, needs-review, numeric, temporal
 * — transparently uses the Layer-owned instance with no signature change at all.
 * This is the "wrap in place, do not copy-then-wrap" recommendation from spike S3,
 * and the spike proved byte-identical findings on the hardest adversarial fixture
 * with zero edits to any other tier file.
 *
 * ## Effect v4 beta.102 API reality (verified against the installed .d.ts)
 *
 * - `Layer.scoped` DOES NOT EXIST. `Layer.effect` IS the scoped constructor — its
 *   signature's `Exclude<R, Scope.Scope>` is the tell: the construction effect may
 *   require a `Scope` and the Layer discharges it. So acquire/release is
 *   `Layer.effect(Key)(Effect.acquireRelease(acquire, release))`.
 * - `Context.Service<Self, Shape>()('Id')` is the class-style key; there is no
 *   `Context.Tag`. The class carries `.use`, `.useSync`, `.of`, `.context`.
 * - `Effect.async` DOES NOT EXIST — it is `Effect.callback`, and its RETURN VALUE
 *   is the canceler, which MAY ITSELF BE AN EFFECT. That last fact is the only
 *   reason the async Z3 finalizer below is expressible at all.
 *
 * ## THE INTERRUPTION DISCIPLINE (non-negotiable — see the module's guard test)
 *
 * `z3-solver` is compiled with Emscripten Asyncify, which holds ONE GLOBAL
 * `capability` slot (`z3-built.js`: `async_call` THROWS "you can't execute multiple
 * async functions at the same time" when a previous async call has not settled).
 * Three consequences, all measured in spike S3, all counter-intuitive:
 *
 * 1. **The event loop stays LIVE during a query.** `Effect.timeout` fires on
 *    schedule and the fiber interrupts on time. The donor's V14 prior ("hangs are
 *    unkillable from JS, no `Promise.race`/abort escape") meant the race could not
 *    STOP Z3 — not that it never resolved.
 * 2. **Bare abandonment does not leak — it WEDGES.** After a fiber interrupt with
 *    no Z3-level cancel, EVERY later solve in the process throws, on any context,
 *    forever. Strictly worse than a leak, and invisible until the SECOND solve —
 *    exactly the shape of bug that survives a test suite and fails in production.
 *    A process in that state also cannot drain: measured `SIGTERM` after >20s.
 * 3. **`Z3_interrupt(ctx)` is the escape, and the canceler must AWAIT.**
 *    Interrupting cancels an in-flight query in ~5ms and the module is fully
 *    reusable — but interrupt-then-immediately-solve STILL throws. The interrupted
 *    promise has to be awaited to release the slot, which is why the canceler is an
 *    `Effect.promise` rather than an `Effect.sync`.
 *
 * So: {@link interruptibleSolve} is the only sanctioned solver call, and
 * {@link solverServiceLayer} exposes nothing that bypasses it.
 *
 * ## NEVER parallelize solver calls
 *
 * The same one-slot rule means concurrent solver calls are impossible in one WASM
 * instance. The transplanted tier is already serial (`asyncMutex` in z3-solver's
 * `high-level.js` serializes `solver_check_assumptions`), so nothing changes — but
 * a future "optimization" adding `Effect.forEach({ concurrency: n })` over solver
 * calls would wedge the module. {@link SOLVER_CONCURRENCY} states the bound as a
 * value rather than a comment.
 */

import { Context, Effect, Layer, Scope } from 'effect'
import { primeZ3, resetZ3, type Z3Context, type Z3Module } from '../donor/formal/backend.ts'

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

// ---------------------------------------------------------------------------
// The Layer
// ---------------------------------------------------------------------------

/**
 * ACQUIRE: boot the WASM module, then PRIME the transplanted tier's memo.
 *
 * `Effect.promise` (not `tryPromise`) because a WASM boot failure is a DEFECT, not
 * a recoverable typed error — it means the installed `z3-solver` is broken, which
 * no `ERR_*` code and no agent-facing suggestion can act on. This matches the
 * donor, where `getContext` simply rejects.
 *
 * The `primeZ3(module)` call is the entire seam. See the header note in
 * `donor/formal/backend.ts`.
 */
const acquire: Effect.Effect<BootedSolver> = Effect.promise(async () => {
  const { init } = await import('z3-solver')
  const module = (await init()) as Z3Module
  primeZ3(module)
  return { module, version: module.getVersionString() }
})

/**
 * RELEASE: clear the memo and drop the reference.
 *
 * The honest finding from spike S3: `z3-solver` exposes NO module-level teardown.
 * `Z3HighLevel & Z3LowLevel` has no `dispose`/`terminate`/`destroy`/`free` — only
 * per-context `interrupt()`, per-object `del_*` in the low-level namespace, and the
 * untyped `em` escape hatch. And `em.PThread.terminateAllThreads()` is a red
 * herring: it exists, but the Z3 work is on the MAIN thread under Asyncify, so it
 * neither stops a query nor lets the process drain (measured: `SIGTERM` either
 * way). So release is honestly "un-prime the memo and let the Emscripten heap go
 * with the process", not a real free — and the thing that ACTUALLY lets a process
 * with a pending query exit is {@link interruptibleSolve}'s canceler, not this.
 *
 * `resetZ3()` is what makes `Layer.fresh` genuinely re-init rather than silently
 * reusing a module whose owning scope has closed.
 */
const release = Effect.sync(() => {
  resetZ3()
})

/**
 * THE LAYER. `Layer.effect(Key)(...)` — v4's scoped layer constructor, since
 * `Layer.scoped` does not exist.
 *
 * Three things happen here, and each is load-bearing:
 *
 * 1. **The Layer's own `Scope` is captured** (`yield* Scope.Scope`). `Layer.effect`
 *    discharges a `Scope` requirement from its construction effect — that is what
 *    the signature's `Exclude<R, Scope.Scope>` means — so the scope is reachable
 *    here and it is the one whose close should release the module.
 * 2. **The `acquireRelease` is given that scope explicitly.** Wrapping it in
 *    `Effect.cached` alone does NOT work: `cached` defers the effect, and by the
 *    time a caller yields it the construction effect has returned and the ambient
 *    `Scope` is gone — the probe failed with `Service not found: effect/Scope`.
 *    Providing the captured scope means the deferred acquire still registers its
 *    finalizer on the LAYER's scope, so ownership survives the deferral.
 * 3. **`Effect.cached` makes the boot lazy AND once.** Verified: unused → zero
 *    boots; used twice → one boot, one release on scope close.
 *
 * Layers are also memoized per BUILD, so two consumers of this service share one
 * Layer instance and therefore one `cached` cell. `Layer.fresh` defeats that and
 * genuinely re-inits.
 */
export const solverServiceLayer: Layer.Layer<SolverService> = Layer.effect(SolverService)(
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const boot = yield* Effect.cached(
      Effect.acquireRelease(acquire, () => release).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    return SolverService.of({
      boot,
      context: (name = 'symspec') => Effect.map(boot, ({ module }) => module.Context(name)),
      solve: interruptibleSolve,
    })
  }),
)
