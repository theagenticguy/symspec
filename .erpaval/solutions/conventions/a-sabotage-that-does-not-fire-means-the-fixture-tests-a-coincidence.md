---
title: A sabotage that does not fire usually means the FIXTURE is wrong, not that the code is robust — the two overlapping cases must overlap where the rule applies
track: bug
category: conventions
module: src/domain/engine/formal/atomize.test.ts
component: symspec
severity: medium
tags: [sabotage, test-quality, fixture-design, ordering, atomization]
applies_when:
  - writing a test for a rule about ORDER (longest-first, left-to-right, this-stage-before-that)
  - a sabotage of that rule leaves the suite green
pattern: |
  Two tests for the term-substitution rule passed under sabotages that should have broken them,
  and both times the fixture — not the code — was at fault. The shape repeats, so it is worth
  naming.

  1. LONGEST-ALIAS-FIRST. Fixture: aliases `token` and `session token`, input
     `issue a session token`. Sabotaged to shortest-first: still green. Why — at position 2 the
     bare `token` does not match (`session` is there), and by the time position 3 is reached the
     two-token alias has already consumed it. The short alias sat AFTER the long one, so probe
     order was irrelevant. Fixed by making them overlap at the SAME start position: aliases
     `token` and `token vault`, input `issue a token vault`. Shortest-first now yields
     `issue_a_shard_vault` instead of `issue_a_vault_record`.

  2. SUBSTITUTION-BEFORE-COPULA-STRIP. Fixture: term `chamber sealed` → `vault sealed`, input
     `the chamber sealed is true`. Sabotaged by moving the substitution after the strip: still
     green, because the term did not SPAN the copula, so both orders produced `vault_sealed_true`.
     Fixed by putting the copula inside the alias: `chamber is sealed` → `vault sealed`, input
     `the chamber is sealed`. After-strip now yields `chamber_sealed`.

  The general rule: a test for an ORDERING rule must construct the case where the two orders
  DIVERGE. That means the two competing matches have to contend for the same position (case 1),
  or the rewrite has to straddle the boundary being reordered (case 2). A fixture where the
  orders agree is asserting a coincidence, and it will keep passing after someone removes the
  rule.
example_files:
  - src/domain/engine/formal/atomize.test.ts
---

# Why this matters

CLAUDE.md already says a sabotage that does not break the test "either proves the assertion is
robust for a reason worth naming, or shows the test is asserting something other than what its
name says." Both of these were the second case, and neither was obvious from reading the test —
each looked like a direct assertion of its rule.

The cheap diagnostic: after a sabotage fails to fire, do not conclude robustness. Compute the
expected output under BOTH the correct and the sabotaged implementation by hand. If they are the
same string, the fixture cannot discriminate and the test is decoration.

Related: [[oracle-non-vacuity-assertions-find-the-blind-spots]] is the same instinct applied to
whole oracles rather than single fixtures.

# What NOT to do

Do not "fix" a non-firing sabotage by weakening the sabotage until something goes red. That
finds a test, not a bug. Fix the fixture so the rule under test is actually load-bearing for the
asserted output.
