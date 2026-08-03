---
title: Effect 4.0.0-beta.102 — a PROVIDED Layer is built EAGERLY (mergeAll builds every member); Effect.cached + an explicitly-provided Scope is the lazy-expensive-resource pattern
track: knowledge
category: conventions
module: packages/symspec/src/formal/solver-service.ts
component: effect
severity: high
tags: [effect, v4, layer, scope, cached, lazy-init, cold-start, wasm]
applies_when:
  - a Layer's acquire is EXPENSIVE (WASM boot, model load, DB connect, subprocess spawn)
  - merging that Layer into a composition root shared by cheap commands
  - assuming "the Layer only builds when a consumer needs it"
pattern: |
  Supplements the earlier beta.102 files (deltas 1-8, 9-14, 15-19). This is
  #20, found wiring the G2a solver Layer, and it is the first one that is a
  PERFORMANCE trap rather than a correctness one — which is why no test
  caught it and a benchmark did.

  20. **A PROVIDED Layer is BUILT EAGERLY, with or without a consumer.**
      Probed directly:

        let built = 0
        const layer = Layer.effect(Svc)(Effect.sync(() => { built++; ... }))

        Effect.runPromise(Effect.succeed('no consumer').pipe(Effect.provide(layer)))
        // => built === 1     <-- NOTHING yielded Svc

        Effect.runPromise(
          Effect.map(Other, o => o.w).pipe(Effect.provide(Layer.mergeAll(other, layer)))
        )
        // => built === 1     <-- only Other was reached; `layer` built anyway

      "Layers are lazy" is true about MEMOIZATION (one build per build, two
      consumers share) and false about DEMAND. `Layer.mergeAll` builds every
      member. So merging one expensive Layer into a composition root taxes
      EVERY command that root serves. Measured concretely: the z3 WASM boot is
      200-1000ms, and merging it naively would have put that on `symspec
      version` / `manifest` / `list` / `show` / `import`, all of which are
      ~125ms total today.

      **The fix — put the expensive thing behind `Effect.cached` INSIDE the
      service shape, and hand the acquireRelease the LAYER's own Scope:**

        export const layer = Layer.effect(Key)(
          Effect.gen(function* () {
            const scope = yield* Scope.Scope          // the LAYER's scope
            const boot = yield* Effect.cached(
              Effect.acquireRelease(acquire, release).pipe(
                Effect.provideService(Scope.Scope, scope),
              ),
            )
            return Key.of({ boot, /* ...cheap members... */ })
          }),
        )

      Two non-obvious halves:

      - `Effect.cached(self) => Effect<Effect<A,E,R>>` gives lazy-once
        semantics: yield the OUTER effect at construction, store the inner, and
        the first consumer to yield the inner pays the cost. Verified: unused
        => 0 acquires; used twice => 1 acquire, 1 release on scope close.
      - **The explicit `Effect.provideService(Scope.Scope, scope)` is
        mandatory.** `Effect.cached(Effect.acquireRelease(...))` alone fails at
        RUNTIME with `Service not found: effect/Scope` — `cached` defers the
        effect, and by the time a caller yields it the construction effect has
        returned and the ambient Scope is gone. Capturing the layer's scope and
        providing it means the deferred acquire still registers its finalizer on
        the LAYER's scope, so ownership survives the deferral.

      Consequence for the service SHAPE: expensive members cannot be plain
      values. `{ module: Z3Module }` forces the boot; `{ boot: Effect<Booted> }`
      does not. That reshapes every consumer (`yield* service.boot` instead of
      `service.module`), so decide it before writing the consumers.

      How to TEST it, given there is no init counter in production code: assert
      that reaching the service costs nothing observable, and that two
      `Layer.fresh` builds produce distinct resource identities (which also
      proves the release un-primed whatever global the acquire primed).
example_files:
  - packages/symspec/src/formal/solver-service.ts
  - packages/symspec/src/formal/solver-service.test.ts
  - .erpaval/sessions/session-d4dc8e/G2a-LATENCY-REPORT.md
---

# Why this matters

The recurring beta.102 theme has been "this beta's failure mode is silence" —
nine of nineteen deltas produced no error, just a wrong manifest, a wrong
default, or a wrong document. This one is quieter still: it produces a CORRECT
program that is uniformly slower, on every command, forever. Nothing fails.
Every test passes. The only instrument that sees it is a benchmark that
separates a no-op command from a working one.

The generalization worth carrying: for any Layer whose acquire is expensive,
"does providing this Layer cost anything when nobody uses it?" is a question to
ANSWER BY PROBE, not by reasoning about laziness. And the answer on beta.102 is
yes, it costs the whole acquire.

# What NOT to do

Do not "fix" this by removing the Layer from the composition root and building
it inside the handler. That gives up the scope: the handler would own the
resource's lifetime, finalizers would run at handler exit rather than at runtime
teardown, and a test could no longer substitute the resource. The `cached`
pattern keeps the Layer in charge and only defers the cost.

Do not reach for `Layer.suspend` or `Layer.fromBuildMemo` first — `suspend`
defers CONSTRUCTING the layer value, not building it, and neither addresses
demand. `cached` inside the shape is the smaller, testable change.
