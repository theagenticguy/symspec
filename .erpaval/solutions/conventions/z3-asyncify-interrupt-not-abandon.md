---
title: Abandoning a z3-solver query WEDGES the module (Asyncify one-slot) — Z3_interrupt(ctx) + await is the escape; V14/V21 revised
track: knowledge
category: conventions
module: src/formal/backend.ts
component: z3-solver
severity: high
tags: [z3, wasm, asyncify, interruption, effect, layer, spacer, hang]
applies_when:
  - adding timeouts/cancellation around any z3-solver call
  - designing the G2 SolverService Layer or G4 Spacer reachability tier
  - tempted to parallelize solver calls
pattern: |
  Measured in spike S3 (session-d4dc8e, effect 4.0.0-beta.102, z3-solver 5.x):

  1. The event loop stays LIVE during a Z3 query (Emscripten Asyncify) — V14's
     "no Promise.race escape" meant the race can't STOP Z3, not that it never
     resolves.
  2. Bare abandonment (fiber interrupt without cleanup) does not leak — it
     WEDGES: Asyncify holds ONE global capability slot; after abandoning a
     query, every later solve on any fresh Context throws `async_call` forever.
     Invisible until the second solve.
  3. `Z3_interrupt(ctx)` cancels even the V21 param-poisoned Fixedpoint hang
     from JS in ~5ms and the module is fully reusable afterward.
  4. The canceler MUST await the interrupted promise to release the slot —
     interrupt-then-immediately-solve still throws.
  5. `PThread.terminateAllThreads()` is a red herring (work is main-thread).
  6. Process exit: abandon → wedged >20s SIGTERM; interrupt → natural exit 0.

  Discipline: one `interruptibleSolve` primitive is the only sanctioned solver
  call (Effect.callback whose returned canceler runs Z3_interrupt then awaits);
  NEVER parallelize solver calls (one Asyncify slot); worker isolation is NOT
  needed unless a query ignores Z3_interrupt — add an interrupt-responsiveness
  probe to the G4 hazard catalog.
example_files:
  - .erpaval/sessions/session-d4dc8e/spikes/S3-LAYER-FINDINGS.md
---

# Why this matters

The donor's V14/V21 hazards said Spacer hangs are unkillable; the priced
mitigation was worker-thread isolation. The spike showed the cheaper, correct
escape (interrupt + await) and a NEW failure mode (module wedge on abandon)
that a timeout-only design would ship. Also: `backend.ts` is the only importer
of z3-solver, so wrapping the memoized init in a Layer's acquire is ~5 lines
in 1 file — wrap in place, don't copy.
