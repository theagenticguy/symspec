---
title: A sabotage that does not fire usually means the FIXTURE is wrong, not that the code is robust — five ways a fixture fails to discriminate
track: bug
category: conventions
module: src/domain/engine/formal/atomize.test.ts, src/app/operations/check.test.ts, src/domain/engine/lint/gtwr.test.ts
component: symspec
severity: medium
tags: [sabotage, test-quality, fixture-design, ordering, atomization, vacuous-assertion, lexicon]
applies_when:
  - writing a test for a rule about ORDER (longest-first, left-to-right, this-stage-before-that)
  - asserting that adding something CHANGED NOTHING about an existing value
  - asserting that every member of a collection behaves, by looping over that collection
  - a sabotage of any of the above leaves the suite green
pattern: |
  Five tests across two increments passed under sabotages that should have broken them, and
  every time the fixture — not the code — was at fault. The shapes repeat, so they are worth
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

  3. THE BASELINE ALREADY SATISFIES THE ASSERTION. Test: "adding this tier leaves `verified`
     unchanged". Sabotaged by making the tier push a coverage demotion: still green. Why — the
     fixture document had disjoint vocabulary, so it was ALREADY demoted for another reason and
     `verified` was `false` either way. The assertion could not distinguish one demotion from
     two. Fixed by measuring a document that reaches `verified: true` with `demotions: []`
     (two requirements sharing one trigger) and asserting over that, so a single pushed
     demotion flips a `true` to a `false`.

  4. THE ASSERTION MATCHES ON A NAME THE SABOTAGE NEED NOT USE. The same test filtered
     demotion reasons by substring — `r.includes('term') || r.includes('acronym')`. A sabotage
     pushing a demotion under a BORROWED reason name (`open-opposition-candidate`) was
     invisible to it. Fixed by comparing the full demotion arrays between the two runs, which
     is blind to what the reason is called.

  5. AN EXHAUSTIVE LOOP OVER THE THING UNDER TEST. Test: "every entry in `COMMON_ACRONYMS` is
     silenced", written as `for (const a of COMMON_ACRONYMS)`. Sabotaged by DELETING an entry:
     still green, because a smaller set satisfies the loop trivially. A loop over a collection
     can catch a member that misbehaves and never one that vanished — so a membership pin is a
     separate assertion, not the same one.

  The general rule: a fixture must make the correct and sabotaged implementations produce
  DIFFERENT output. For an ordering rule that means the competing matches contend for one
  position (case 1) or the rewrite straddles the reordered boundary (case 2). For a
  "nothing changed" claim it means the baseline must have somewhere to move FROM (case 3).
  For a "nothing was added" claim the comparison must not key on what the addition is called
  (case 4). And for "every member behaves" it means the membership is pinned separately from
  the behavior (case 5). A fixture where both implementations agree is asserting a coincidence,
  and it will keep passing after someone removes the rule.
example_files:
  - src/domain/engine/formal/atomize.test.ts
  - src/app/operations/check.test.ts
  - src/domain/engine/lint/gtwr.test.ts
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
