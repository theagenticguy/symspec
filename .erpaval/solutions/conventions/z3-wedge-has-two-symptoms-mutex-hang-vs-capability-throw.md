---
title: The z3-solver abandonment wedge has TWO symptoms — the low-level API THROWS, the high-level API HANGS behind an asyncMutex; a guard test written for one silently passes on the other
track: knowledge
category: conventions
module: packages/symspec/src/formal/solver-service.ts
component: z3-solver
severity: high
tags: [z3, wasm, asyncify, interruption, mutex, guards-must-fire, effect]
applies_when:
  - writing a regression test for the Z3 abandonment wedge
  - deciding whether an interruption guard actually detects a sabotaged canceler
  - debugging a solver call that never resolves rather than throwing
pattern: |
  Refines `z3-asyncify-interrupt-not-abandon.md`. The discipline in that file is
  unchanged and correct — ONE interruptibleSolve, canceler runs Z3_interrupt then
  AWAITS, never parallelize. What it got wrong is the wedge's OBSERVABLE SHAPE,
  and that difference decides whether a guard test can fail.

  Spike S3 recorded the wedge as a THROW: Asyncify's single global `capability`
  slot makes `async_call` raise "you can't execute multiple async functions at
  the same time". That is exactly right for the LOW-LEVEL `Z3.*` entry points —
  which is what the spike probed, and what a Spacer/Fixedpoint tier uses.

  But the HIGH-LEVEL API — `solver.check()`, which is what every ordinary tier
  calls — routes through an `async_mutex`:

    z3-solver/build/high-level/high-level.js:19    const asyncMutex = new Mutex()
    ...:1514  await asyncMutex.runExclusive(() => check(Z3.solver_check_assumptions(...)))

  So on the high-level path the SAME abandonment manifests as an UNBOUNDED
  QUEUE, not a throw: the next `check()` simply never resolves. Measured on one
  abandoned query, both probes against the same module:

    probe path                    after abandon              after interrupt+await
    high-level solver.check()     HANGS (timed out @1500ms)   unsat in ~20ms
    low-level Z3.solver_check()   THROWS one-slot error       accepted

  **Why this is a test-design problem, not trivia.** A guard written as "abandon,
  then assert the canary THROWS" does two bad things on the high-level path: it
  times the whole test out (a 20s vitest failure that reads like a hang, not an
  assertion), and — much worse — a SABOTAGED canceler passes it. Verified:
  deleting `await pending` from the canceler and re-running a high-level-canary
  suite gave 6/6 green, because the mutex made the wedge look like latency
  instead of failure.

  **The observation point that actually discriminates.** Probe the LOW-LEVEL API
  in the SAME TICK that `Fiber.interrupt` returns. `Fiber.interrupt` awaits the
  canceler, so at that instant a correct canceler has released the slot and a
  broken one has not. Both halves of the discipline are then detectable:

    canceler                                  probe result
    interrupt() then await pending  (correct)  accepted        <- test passes
    interrupt() with NO await                  one-slot THROW  <- test FAILS
    no interrupt at all (bare abandon)         one-slot THROW  <- test FAILS

  Two things must not slip:
  - the probe has to be in ONE `Effect.sync` with nothing awaited between the
    interrupt returning and the probe, or a microtask settles `pending` and the
    slot frees itself — masking the very thing under test;
  - it has to be low-level, because the high-level mutex queues instead of
    throwing (that is the whole finding).

  Also: run wedge tests against a SACRIFICIAL module (`Layer.fresh` + reset the
  memo after), since a deliberate wedge is process-wide and would poison every
  later test in the file.
example_files:
  - packages/symspec/src/formal/solver-service.test.ts
  - .erpaval/solutions/conventions/z3-asyncify-interrupt-not-abandon.md
---

# Why this matters

This is a guards-must-fire failure that had already happened invisibly: the first
draft of the G2a interruption suite passed 6/6 with the `await` deleted from the
canceler. The discipline was correct in the code and the test could not tell.
Shipping that combination is strictly worse than having no test, because the green
run is evidence for a claim it does not support.

The general lesson is about wrapped libraries: a mutex, a queue, a retry, or a
pool between your call and the resource CHANGES the failure into latency. When
writing a guard for a resource-level hazard, find the observation point closest
to the resource, and confirm the guard fails by breaking the thing it guards —
not by reasoning that it would.

# What NOT to do

Do not "fix" a hanging guard test by raising the timeout. The hang IS the wedge on
that path; a longer timeout just makes the suite slower while still not
distinguishing a correct canceler from a broken one.

Do not delete the high-level assertion either. It is the path the tiers use, so
"a real solve succeeds after a cancelled one" is the property that matters to
production — it just needs a timeout race to express, and it cannot stand alone as
the discipline's guard.
