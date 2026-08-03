---
title: A differential oracle is STRUCTURALLY blind to a bug in the SHARED input — sabotage the boundary, not just the implementation, and cover every projected field with a fixture that makes it observable
track: knowledge
category: conventions
module: packages/symspec/src/formal/compat.ts
component: testing
severity: high
tags: [differential-testing, oracle, guards-must-fire, fixtures, transplant, coverage]
applies_when:
  - standing up a differential oracle between two implementations
  - the two sides consume one document/config through a shared adapter or projection
  - claiming a transplant/rewrite is behavior-identical
pattern: |
  A differential oracle compares implementation A against implementation B on
  the same input. It catches drift in EITHER implementation. It cannot catch a
  bug in the INPUT PATH they share — both sides consume the same wrong value and
  agree perfectly.

  Measured, on the G2a formal-tier transplant. The oracle compares the donor
  `runCheck` against the greenfield `check` on 14 fixtures (12 adversarial eval
  rounds + 2 production documents), diffing findings, demotions, verified,
  counts, residualRisk, coverage, and full message text. Sabotage-tested by
  rewording ONE finding message in a transplanted tier: 2 of 22 assertions failed
  immediately. Good.

  Then a second sabotage: hardcode `negated: false` in the v3->v2 compat
  projection — dropping the single most load-bearing field the boundary carries.
  **All 22 assertions stayed GREEN.**

  Why, and both halves were measured rather than guessed:
    - the 12 adversarial documents contain ZERO `negated: true` requirements
      (they express opposition through antonym verb pairs like grant/revoke, a
      different mechanism entirely);
    - the 2 production documents DO carry them (2 of 25, 5 of 42), but flattening
      every flag produces a byte-identical 220-finding report on those particular
      documents — the negated requirements happen not to pair with a positive
      twin on the same atom.

  So both fixture sets were blind, and the projection sat UPSTREAM of the fork,
  so agreement was guaranteed regardless.

  The stakes were not cosmetic. On a minimal pair through the same pipeline:

    negated=true  -> FND_CONTRADICTION      (a proven conflict)
    negated=false -> FND_EXACT_DUPLICATE    (a duplicate report)

  i.e. the tool's core claim silently inverted, with a green oracle.

  ## The two things to do about it

  1. **Sabotage the BOUNDARY, not just the implementations.** "Break it and
     confirm the test fails" has to be applied to the adapter/projection/loader
     that feeds both sides, and it is the sabotage most likely to pass — which is
     exactly why it is the one worth running.

  2. **Test the boundary DIRECTLY, one case per projected field, with an input
     that makes that field OBSERVABLE in the OUTPUT.** Not by asserting the
     projection's own object (that only proves the projection agrees with
     itself — a `toEqual` on the output of the function under test is close to a
     tautology). Construct an input where losing the field changes the VERDICT,
     and assert the verdict. For fields with no consumer yet, assert the honest
     complement: that presence/absence changes nothing — which is the checkable
     form of "nothing reads it" and fails at exactly the right moment when
     something starts to.

  Rule of thumb for fixture coverage: for every field the boundary carries, ask
  "which fixture would FAIL if this field were dropped?" — and if the answer is
  none, the field is untested no matter how many fixtures pass.
example_files:
  - packages/symspec/src/formal/compat.test.ts
  - packages/symspec/src/formal/compat.ts
  - packages/symspec/src/formal/differential.test.ts
---

# Why this matters

The differential oracle was the named exit gate for a whole wave, on the argument
that comparing two running implementations is stronger than comparing output to
hand-written expectations. That argument is right (see the unsat-core-minimality
note in `z3-asyncify-interrupt-not-abandon.md` for why expectations are worse
here) — but "stronger" is not "sufficient", and the gate's blind spot is precisely
the new code the rewrite introduced: the adapter that did not exist before.

Stated generally: a differential oracle validates the FORK, and every rewrite also
introduces a JOIN. The join needs its own tests.

# What NOT to do

Do not respond by adding fixtures until one happens to cover the field. That is
unbounded and it does not tell you when you are done. Enumerate the boundary's
fields — they are a finite, readable list in one function — and write one
observable case per field.

Do not weaken the oracle to compensate (e.g. comparing against a snapshot instead
of the live donor). The oracle is sound for what it covers; it just does not cover
this.
