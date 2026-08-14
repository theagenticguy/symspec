/**
 * `SolverService` — the transplanted Z3-WASM formal tier behind ONE Effect Layer,
 * and {@link interruptibleSolve}, the ONLY sanctioned way to reach the solver.
 *
 * ## What the Layer buys, and why it is nearly free
 *
 * v4 reached Z3 through a module-level memoized promise
 * (`engine/formal/backend.ts`: `let inflight: Promise<Z3Module> | undefined`). That
 * is a global no caller can scope, restart, or dispose. A Layer can be `fresh`ed,
 * built into a `ManagedRuntime`, and disposed, and its scope OWNS the WASM
 * lifetime.
 *
 * The transplant cost is one injection point, not a ~7.8k-LOC Effect-ization.
 * Measured on v4: `backend.ts` is the ONLY importer of `z3-solver`, and
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
 *    schedule and the fiber interrupts on time. v4's V14 prior ("hangs are
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

import { Effect, Layer, Scope } from 'effect'
import { primeZ3, resetZ3, type Z3Module } from '../../domain/engine/formal/backend.ts'
import { type BootedSolver, interruptibleSolve, SolverService } from '../../ports/solver.ts'

// ---------------------------------------------------------------------------
// The Layer
// ---------------------------------------------------------------------------

/**
 * ACQUIRE: boot the WASM module, then PRIME the transplanted tier's memo.
 *
 * `Effect.promise` (not `tryPromise`) because a WASM boot failure is a DEFECT, not
 * a recoverable typed error — it means the installed `z3-solver` is broken, which
 * no `ERR_*` code and no agent-facing suggestion can act on. This matches v4,
 * where `getContext` simply rejects.
 *
 * The `primeZ3(module)` call is the entire seam. See the header note in
 * `engine/formal/backend.ts`.
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
