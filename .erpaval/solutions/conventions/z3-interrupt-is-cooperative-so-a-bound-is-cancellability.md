---
title: Z3_interrupt is COOPERATIVE — cancellation is bounded by the per-query timeout, so a bound is a cancellability mechanism (answers the G4 probe the asyncify lesson asked for)
track: knowledge
category: conventions
module: packages/symspec/src/formal/reachability.ts
component: z3-solver
severity: medium
tags: [z3, wasm, asyncify, interruption, spacer, fixedpoint, effect, timeout]
applies_when:
  - relying on interruption to bound a Spacer/Fixedpoint query
  - deciding whether worker isolation is needed for the solver tier
  - writing a test that interrupts an Effect fiber running a solver
pattern: |
  `z3-asyncify-interrupt-not-abandon.md` recommended adding an
  interrupt-responsiveness probe to the G4 hazard catalog, to settle whether
  worker isolation is needed. It is not — but the guarantee is weaker than
  "interrupt is ~5ms" suggests.

  MEASURED on z3-solver 5.0.0, Spacer via `fixedpoint_query`:

    raw Z3.interrupt(ctx), isolated, 300ms into a 10s-budgeted query  ->     3ms
    Fiber.interrupt through the tier, same model, timeoutMs 10_000    -> 10232ms

  The second number is the query's OWN timeout, not a coincidence. `Z3_interrupt`
  sets a cancel flag that Spacer checks at its own yield points and does NOT check
  at all of them; `interruptibleSolve`'s canceler must AWAIT the in-flight promise
  (that await is what releases Asyncify's one capability slot — dropping it wedges
  the module). So when the flag is not observed, the cancel costs what the query
  would have cost anyway.

  THE HONEST GUARANTEE: cancellation is bounded by the per-query timeout, and the
  module survives it. Consequence: **the per-query bound is a CANCELLABILITY
  mechanism, not merely a budget.** An unbounded query is an uncancellable one —
  a second, independent reason never to run a reachability tier with no timeout,
  on top of V14/V21's unkillable hang.

  Worker isolation stays deferred: Spacer DOES honor the flag, and the bound caps
  the worst case.

  ## Testing this on effect v4 beta.102 — two traps

  1. Interrupting a child fiber leaves the AMBIENT fiber carrying an interrupt
     signal, so the NEXT effect in the same `Effect.gen` dies before running.
     Bisected: `interrupt only` succeeds, `interrupt + a follow-up run` fails with
     "All fibers interrupted without error". Neither `Effect.result` around the
     interrupt, nor `Effect.uninterruptible` around the follow-up, nor
     `Effect.forkDetach` changes it. A plain `forkChild(Effect.sleep)` + interrupt
     does NOT reproduce it, so it is specific to interrupting real in-flight work.
     => Assert "interruption arrives" and "the module survives" as SEPARATE tests.
  2. Do not assert a small constant for cancel latency. Bound it by
     `timeoutMs * k`. A constant passed in isolation (387ms) and hung under the
     full suite — a green test that was wrong about the property it named.
example_files:
  - packages/symspec/src/formal/reachability-guards.test.ts
  - .erpaval/solutions/conventions/z3-asyncify-interrupt-not-abandon.md
---

# Why this matters

The asyncify lesson left one question open — "worker isolation is NOT needed
unless a query ignores `Z3_interrupt`" — and the answer turns out to be "it does
not ignore it, but it does not honor it promptly either". That distinction changes
what the timeout is FOR: not a performance knob but part of the cancellation
contract, which is worth knowing before someone offers a `--timeout-ms 0` for
"unbounded, thorough" runs.
