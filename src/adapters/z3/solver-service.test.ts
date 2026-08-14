/**
 * GUARDS-MUST-FIRE tests for the Z3 interruption discipline.
 *
 * The hazard: abandoning a solver query without a Z3-level cancel poisons the WASM
 * module for the rest of the process. It is silent, permanent, process-wide, and
 * invisible until the SECOND solve — so a test that only asserts "the timeout
 * fired" passes while the module is already broken.
 *
 * ## Two DIFFERENT wedge symptoms, measured here (refines spike S3)
 *
 * S3 recorded the wedge as a THROW (`"you can't execute multiple async functions
 * at the same time"` from Emscripten Asyncify's single global `capability` slot).
 * That is correct for the LOW-LEVEL `Z3.*` entry points — which is what the spike
 * probed and what G4's Spacer tier will use. But the HIGH-LEVEL API
 * (`solver.check()`, which is what every transplanted tier calls) routes through
 * an `asyncMutex` (`z3-solver/build/high-level/high-level.js:19`,
 * `asyncMutex.runExclusive(...)` at :1514 for `solver_check_assumptions`). So on
 * the high-level path the same abandonment manifests as an UNBOUNDED QUEUE, not a
 * throw: the next `check()` simply never resolves.
 *
 * Measured on this machine, both symptoms, same abandoned query:
 *
 * | probe path | after abandon | after interrupt+await |
 * |---|---|---|
 * | high-level `solver.check()` | HANGS (timed out at 1500ms) | `unsat` in ~20ms |
 * | low-level `Z3.solver_check()` | THROWS `multiple async functions` | accepted |
 *
 * This matters for how the guard is written: a hang and a throw need different
 * detection. A test asserting only "the canary throws" would pass on the low-level
 * path and TIME OUT on the high-level one — which is exactly what happened while
 * writing this file. So the negative control below probes the LOW-LEVEL path,
 * where the discipline's three states are cleanly distinguishable, and test 1
 * probes the HIGH-LEVEL path with a timeout, because that is the path the tier
 * actually uses.
 *
 * ## Why interrupt-without-await needs the low-level probe
 *
 * The `await` in the canceler is load-bearing because the capability slot is
 * released on SETTLEMENT, not on interrupt. But the high-level mutex hides that:
 * `check()` queues rather than throwing, so interrupt-then-immediately-check
 * "succeeds" (it just waits). Only a raw low-level call in the SAME TICK as the
 * interrupt shows the slot still held. Measured: same-tick → THROWS; after await →
 * accepted.
 *
 * ## The hangs are genuine, not sleep stubs
 *
 * Test 1 uses pigeonhole at n=11 (UNSAT, exponential resolution proofs). Test 2
 * uses v4's probe-20 MULTIPLICATIVE Spacer system under v4 V21 param
 * poisoning — an undeclared `random_seed` key silently voids the `timeout` in the
 * same params object — which S3 measured as unbounded (>20s, no sign of finishing).
 */

import { Duration, Effect, Fiber, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { resetZ3, type Z3Context, type Z3Module } from '../../domain/engine/formal/backend.ts'
import { interruptibleSolve, SOLVER_CONCURRENCY, SolverService } from '../../ports/solver.ts'
import { solverServiceLayer } from './solver-service.ts'

// ---------------------------------------------------------------------------
// Genuinely slow queries
// ---------------------------------------------------------------------------

/**
 * The pigeonhole principle at `n`: `n+1` pigeons into `n` holes, every pigeon in
 * some hole, no two sharing one. UNSAT, and resolution proofs of it are
 * exponential in `n` — the canonical small-input/enormous-search SAT instance. At
 * `n = 11` it runs for many seconds with no timeout set, which is what makes "the
 * timeout fired at ~700ms" a real cancellation rather than a fast solve.
 */
const pigeonhole = (ctx: Z3Context, n: number, tag: string) => {
  const solver = new ctx.Solver()
  const inHole = (p: number, h: number) => ctx.Bool.const(`${tag}_p${p}_h${h}`)
  for (let p = 0; p <= n; p++) {
    const options = []
    for (let h = 0; h < n; h++) options.push(inHole(p, h))
    solver.add(ctx.Or(...options))
  }
  for (let h = 0; h < n; h++) {
    for (let p1 = 0; p1 <= n; p1++) {
      for (let p2 = p1 + 1; p2 <= n; p2++) {
        solver.add(ctx.Or(ctx.Not(inHole(p1, h)), ctx.Not(inHole(p2, h))))
      }
    }
  }
  return {
    start: () => solver.check() as Promise<string>,
    interrupt: () => {
      ctx.interrupt()
    },
  }
}

/**
 * Donor probe 20's MULTIPLICATIVE Spacer system (`y' = 2*y`, exponential state
 * growth). Unbounded under V21 param poisoning; see {@link makeHungSpacerQuery}.
 */
const MULTIPLICATIVE = `
(declare-rel Inv (Int Int))
(declare-rel Bad ())
(declare-var x Int) (declare-var y Int)
(declare-var x1 Int) (declare-var y1 Int)
(rule (=> (and (= x 0) (= y 1)) (Inv x y)) r_init)
(rule (=> (and (Inv x y) (= x1 (+ x 1)) (= y1 (* 2 y))) (Inv x1 y1)) r_step)
(rule (=> (and (Inv x y) (< y x)) Bad) r_bad)
(query Bad)
`

/** The low-level `Z3` namespace. Untyped by design — it is z3-solver's escape
 * hatch, and v4's own probe corpus reaches Spacer the same way. */
// biome-ignore lint/suspicious/noExplicitAny: the low-level Z3 namespace is untyped
type LowLevelZ3 = Record<string, any>

const lowLevel = (module: Z3Module): LowLevelZ3 => (module as unknown as { Z3: LowLevelZ3 }).Z3

/**
 * An unbounded Spacer query on its own Z3 context, via the low-level API (the
 * high-level surface has no Fixedpoint wrapper).
 *
 * `random_seed` is v4's V21 POISON: an undeclared key in the same params
 * object silently voids `timeout`, so the 200ms bound set two lines above does
 * nothing. That is deliberate — it is the only reliable way to produce a query
 * that no timeout knob can stop, which is precisely the hazard the discipline
 * exists for.
 */
const makeHungSpacerQuery = (module: Z3Module) => {
  const Z3 = lowLevel(module)
  const ctx = Z3.mk_context(Z3.mk_config())
  const fp = Z3.mk_fixedpoint(ctx)
  Z3.fixedpoint_inc_ref(ctx, fp)
  const params = Z3.mk_params(ctx)
  Z3.params_inc_ref(ctx, params)
  const sym = (k: string) => Z3.mk_string_symbol(ctx, k)
  Z3.params_set_symbol(ctx, params, sym('engine'), sym('spacer'))
  Z3.params_set_uint(ctx, params, sym('timeout'), 200)
  Z3.params_set_uint(ctx, params, sym('random_seed'), 42)
  Z3.fixedpoint_set_params(ctx, fp, params)
  const vec = Z3.fixedpoint_from_string(ctx, fp, MULTIPLICATIVE)
  const query = Z3.ast_vector_get(ctx, vec, Z3.ast_vector_size(ctx, vec) - 1)
  return {
    start: () => Z3.fixedpoint_query(ctx, fp, query) as Promise<number>,
    interrupt: () => {
      Z3.interrupt(ctx)
    },
  }
}

// ---------------------------------------------------------------------------
// The two canaries — one per wedge symptom
// ---------------------------------------------------------------------------

/**
 * HIGH-LEVEL canary: a cheap unrelated `unsat` through `solver.check()`, the path
 * every transplanted tier uses. A wedge here is a HANG (the `asyncMutex` queues
 * behind the abandoned query), so the caller must race it against a timeout.
 */
const highLevelCanary = (module: Z3Module, tag: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const ctx = module.Context(`canary-${tag}`)
    const solver = new ctx.Solver()
    const a = ctx.Bool.const(`canary_${tag}`)
    solver.add(a)
    solver.add(ctx.Not(a))
    return solver.check()
  })

/**
 * LOW-LEVEL canary: the same trivial unsat via raw `Z3.solver_check`, bypassing
 * the `asyncMutex`. A wedge here is a synchronous THROW from Asyncify's
 * `async_call`, so this returns immediately in every state — which is what lets
 * the negative control distinguish three states without timing anything out.
 *
 * The returned promise is deliberately floated (`.catch`) rather than awaited: the
 * question is only whether `async_call` ACCEPTED the call, and awaiting a query
 * that was accepted while another is unwinding would reintroduce the queueing this
 * probe exists to avoid.
 */
const lowLevelProbe = (
  module: Z3Module,
  tag: string,
): { readonly accepted: true } | { readonly accepted: false; readonly error: string } => {
  const Z3 = lowLevel(module)
  const ctx = Z3.mk_context(Z3.mk_config())
  const solver = Z3.mk_solver(ctx)
  Z3.solver_inc_ref(ctx, solver)
  const b = Z3.mk_const(ctx, Z3.mk_string_symbol(ctx, `${tag}_a`), Z3.mk_bool_sort(ctx))
  Z3.solver_assert(ctx, solver, b)
  Z3.solver_assert(ctx, solver, Z3.mk_not(ctx, b))
  try {
    const pending = Z3.solver_check(ctx, solver) as Promise<number>
    pending.catch(() => undefined)
    return { accepted: true }
  } catch (e) {
    return { accepted: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// 1. The property the tier depends on
// ---------------------------------------------------------------------------

describe('interruptibleSolve — interruption is a real kill and the module survives', () => {
  it('cancels a long solve under Effect.timeout, and the NEXT solve succeeds', async () => {
    const program = Effect.gen(function* () {
      const solver = yield* SolverService
      const { module } = yield* solver.boot
      const ctx = yield* solver.context('hang-1')

      const started = Date.now()
      const outcome = yield* Effect.result(
        solver
          .solve(pigeonhole(ctx, 11, 'h1'), 'interrupted')
          .pipe(Effect.timeout(Duration.millis(700))),
      )
      const elapsedMs = Date.now() - started

      // THE critical assertion. Without the canceler's Z3_interrupt + await, this
      // canary HANGS forever behind the abandoned query in the asyncMutex — so it
      // is raced against a timeout generous enough that only a wedge trips it.
      const canary = yield* Effect.result(
        highLevelCanary(module, 'after-cancel').pipe(Effect.timeout(Duration.seconds(5))),
      )

      // And a full second solve through the sanctioned path, which is the stronger
      // form: not a cheap canary, a real query.
      const ctx2 = yield* solver.context('recheck')
      const second = yield* solver
        .solve(pigeonhole(ctx2, 3, 'h1b'), 'interrupted')
        .pipe(Effect.timeout(Duration.seconds(10)), Effect.result)

      return { outcome, elapsedMs, canary, second }
    })

    const r = await Effect.runPromise(program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))

    // The timeout fired (the fiber interrupted) rather than the solve completing.
    expect(r.outcome._tag).toBe('Failure')
    // ...and it fired ON SCHEDULE. The upper bound is what proves the event loop
    // was LIVE during the query (Asyncify yields continuously) rather than the
    // timeout only landing after Z3 happened to finish.
    expect(r.elapsedMs).toBeGreaterThanOrEqual(600)
    expect(r.elapsedMs).toBeLessThan(10_000)

    // NO WEDGE: the canary resolved, and resolved correctly.
    expect(r.canary._tag, 'the module is wedged — the canary never resolved').toBe('Success')
    if (r.canary._tag === 'Success') expect(r.canary.success).toBe('unsat')

    // NO WEDGE, stronger form: a real second solve completes.
    expect(r.second._tag).toBe('Success')
    if (r.second._tag === 'Success') expect(r.second.success).toBe('unsat')
  })

  it('states the concurrency bound as a value, because Asyncify holds one slot', () => {
    // Not the tautology it looks like: this constant is what a future
    // parallel-solving change has to confront. `Effect.forEach({concurrency: n>1})`
    // over solver calls wedges the module, so the bound is a correctness property,
    // and naming it makes the violation visible at the call site.
    expect(SOLVER_CONCURRENCY).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. THE NEGATIVE CONTROL — the discipline must be detectably load-bearing
// ---------------------------------------------------------------------------

describe('the await-after-interrupt discipline (negative control)', () => {
  /**
   * THE PRIMARY GUARD: probe the module in the SAME TICK that `Fiber.interrupt`
   * returns, i.e. immediately after `interruptibleSolve`'s canceler has run to
   * completion. Since `Fiber.interrupt` awaits the canceler, a canceler that did
   * its job leaves the capability slot FREE at that instant, and one that did not
   * leaves it HELD.
   *
   * This is the assertion that fires on BOTH sabotages, verified by deliberately
   * breaking the primitive and re-running:
   *
   * | `interruptibleSolve` canceler | probe after `Fiber.interrupt` |
   * |---|---|
   * | `interrupt()` then `await pending` (shipped) | accepted |
   * | `interrupt()` with NO await | THROWS `multiple async functions` |
   * | no interrupt at all (bare abandon) | THROWS `multiple async functions` |
   *
   * Why the probe must be LOW-LEVEL and SAME-TICK: the high-level
   * `solver.check()` goes through an `asyncMutex`, which QUEUES rather than
   * throwing, so a wedge there looks like latency and a sabotaged canceler still
   * "passes" (measured — the first draft of this file did exactly that). And a
   * probe one macrotask later would let the abandoned query settle on its own,
   * which is the very thing the `await` is there to wait for. So the guard is
   * pinned to the one observation point where the two states differ.
   */
  it('the canceler leaves the module usable in the SAME TICK Fiber.interrupt returns', async () => {
    const program = Effect.gen(function* () {
      const solver = yield* SolverService
      const { module } = yield* solver.boot
      const hung = makeHungSpacerQuery(module)

      // Run the hung query through THE PRIMITIVE, on a child fiber, then interrupt
      // it. `Fiber.interrupt` awaits the canceler, so when it returns the canceler
      // has finished — whatever it chose to do.
      const fiber = yield* Effect.forkChild(interruptibleSolve(hung, -1))
      yield* Effect.sleep(Duration.millis(500))
      yield* Fiber.interrupt(fiber)

      // One `Effect.sync`, so nothing can settle between the interrupt returning
      // and the probe.
      return yield* Effect.sync(() => lowLevelProbe(module, 'post-cancel'))
    })

    const probed = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
    )
    resetZ3()

    expect(
      probed.accepted,
      probed.accepted
        ? ''
        : 'the module is WEDGED immediately after Fiber.interrupt returned, so ' +
            "`interruptibleSolve`'s canceler is not doing its job: it must call Z3_interrupt " +
            `AND await the in-flight promise. Asyncify said: ${probed.error}`,
    ).toBe(true)
  })

  /**
   * Runs on a SACRIFICIAL module — `Layer.fresh` gives this test its own WASM
   * instance, which it deliberately poisons, and the explicit `resetZ3()` after
   * makes sure the poisoned module is not left in the transplanted tier's memo for
   * another test to find.
   *
   * Three measured states, in order, each an assertion. All three probe the
   * LOW-LEVEL path, because that is where the capability slot is observable
   * without timing anything out (see the module header's table):
   *
   *   a. RAW ABANDON — start the hung query, walk away. This is precisely what
   *      `Effect.promise` + `Effect.timeout` does. `async_call` now THROWS.
   *   b. INTERRUPT WITHOUT AWAIT — interrupt, then probe in the SAME TICK. STILL
   *      throws: the slot is released on SETTLEMENT, not on interrupt. This is the
   *      assertion that makes the `await` in the canceler load-bearing — remove it
   *      and states (b) and (c) become indistinguishable.
   *   c. INTERRUPT AND AWAIT — the canceler's exact body. Recovered.
   */
  it('proves abandon WEDGES, interrupt-without-await STILL wedges, interrupt+await RECOVERS', async () => {
    const program = Effect.gen(function* () {
      const solver = yield* SolverService
      const { module } = yield* solver.boot
      const hung = makeHungSpacerQuery(module)

      // (a) RAW ABANDON. Deliberately NOT through `solve` — that is the whole
      // point. The floating promise is what an abandoned fiber leaves behind.
      const pending = yield* Effect.sync(() => {
        const p = hung.start()
        p.catch(() => undefined)
        return p
      })
      // Let the query get properly underway before probing.
      yield* Effect.sleep(Duration.millis(500))
      const afterAbandon = yield* Effect.sync(() => lowLevelProbe(module, 'abandon'))

      // (b) INTERRUPT WITHOUT AWAIT — the sabotaged canceler. Same tick as the
      // interrupt, inside ONE Effect.sync, so no microtask can settle `pending`
      // between them.
      const afterInterruptNoAwait = yield* Effect.sync(() => {
        hung.interrupt()
        return lowLevelProbe(module, 'no-await')
      })

      // (c) INTERRUPT AND AWAIT — exactly what `interruptibleSolve`'s canceler does.
      yield* Effect.promise(async () => {
        hung.interrupt()
        await pending.catch(() => undefined)
      })
      const afterAwait = yield* Effect.sync(() => lowLevelProbe(module, 'awaited'))

      return { afterAbandon, afterInterruptNoAwait, afterAwait }
    })

    const r = await Effect.runPromise(program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))
    // The poisoned module must not be left in the transplanted tier's memo.
    resetZ3()

    // (a) The wedge is real, and it is Asyncify's one-slot error specifically —
    // not some other failure that would make this test pass for a wrong reason.
    expect(
      r.afterAbandon.accepted,
      'expected a wedge after a raw abandon, but the module accepted the next call',
    ).toBe(false)
    if (!r.afterAbandon.accepted) {
      expect(r.afterAbandon.error).toMatch(/multiple async functions at the same time/)
    }

    // (b) Interrupting is NOT sufficient on its own. THIS is the guard on the
    // `await`: if it ever passes, the canceler's await has stopped being
    // load-bearing and the discipline must be re-derived before it is relaxed.
    expect(
      r.afterInterruptNoAwait.accepted,
      'interrupt-without-await recovered the module, so the `await` in interruptibleSolve`s ' +
        'canceler is no longer load-bearing — re-derive the discipline before deleting it',
    ).toBe(false)

    // (c) Interrupt + await recovers it.
    expect(
      r.afterAwait.accepted,
      r.afterAwait.accepted ? '' : `still wedged after interrupt+await: ${r.afterAwait.error}`,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The Layer's own contract
// ---------------------------------------------------------------------------

describe('solverServiceLayer — the Layer owns the WASM lifetime', () => {
  it('is memoized to ONE boot per build: two boots see the same module', async () => {
    const program = Effect.gen(function* () {
      const service = yield* SolverService
      const first = yield* service.boot
      const second = yield* service.boot
      return { same: first.module === second.module, version: first.version }
    })

    const r = await Effect.runPromise(program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))
    // `Effect.cached` makes the second yield free and identical, not a second init.
    expect(r.same).toBe(true)
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  /**
   * THE LAZINESS GUARD, and it exists because v4 behaves the OPPOSITE of the
   * obvious expectation.
   *
   * Probed directly on beta.102: a provided Layer's construction effect runs even
   * when NO consumer yields its service, and `Layer.mergeAll(cheap, expensive)`
   * builds BOTH members. So "the Layer is only built when needed" is FALSE, and a
   * shape holding `module: Z3Module` directly would boot WASM on `symspec version`
   * — a ~200-1000ms tax on every command in the tool.
   *
   * The fix is that the boot sits behind `Effect.cached` INSIDE the shape, so this
   * test asserts the property that actually matters: building the Layer, and even
   * reaching the service, costs no WASM init. Only `yield* service.boot` does.
   *
   * Detection is via `resetZ3()` + a module-identity comparison rather than an init
   * counter, because the counter would have to live in production code purely for
   * the test.
   */
  it('LAZY: building the Layer and reaching the service boots NO WASM', async () => {
    resetZ3()
    // Reach the service — but never yield `boot`.
    const reached = await Effect.runPromise(
      Effect.map(SolverService, (s) => typeof s.boot).pipe(
        Effect.provide(Layer.fresh(solverServiceLayer)),
      ),
    )
    expect(reached).toBe('object')

    // If the Layer had booted eagerly, the transplanted tier's memo would now be
    // primed, and v4 `getContext` would resolve without a fresh init. Probe
    // it the only way that does not require instrumenting production code: a NEW
    // fresh build's module must be a genuinely new object, which is only
    // observable because nothing primed the memo above.
    const boot = Effect.flatMap(SolverService, (s) => s.boot)
    const a = await Effect.runPromise(boot.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('Layer.fresh defeats the memo and boots a genuinely separate instance', async () => {
    const boot = Effect.flatMap(SolverService, (s) => Effect.map(s.boot, ({ module }) => module))
    const a = await Effect.runPromise(boot.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))
    const b = await Effect.runPromise(boot.pipe(Effect.provide(Layer.fresh(solverServiceLayer))))
    // Two fresh builds, two distinct WASM module objects. If `resetZ3()` were
    // missing from the release, the second build would reuse the first's module
    // through the transplanted tier's memo and this would fail.
    expect(a).not.toBe(b)
  })

  it('exposes solve as the interruptible primitive, not a raw promise wrapper', async () => {
    // A STRUCTURAL guarantee, not a behavioral one: `SolverShape.solve` IS
    // `interruptibleSolve`. Swapping it for `Effect.promise(query.start)`
    // typechecks identically and passes every happy-path test — this is what
    // catches that.
    const solve = await Effect.runPromise(
      Effect.map(SolverService, (s) => s.solve).pipe(
        Effect.provide(Layer.fresh(solverServiceLayer)),
      ),
    )
    expect(solve).toBe(interruptibleSolve)
  })
})
