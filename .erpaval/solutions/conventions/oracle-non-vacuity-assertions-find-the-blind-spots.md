---
title: Write the NON-VACUITY assertion first — it is what finds the oracle's blind spots, and it fails honestly when the fixtures cannot reach a path
track: knowledge
category: conventions
module: packages/symspec/src/formal/differential.test.ts
component: testing
severity: high
tags: [differential-testing, oracle, non-vacuity, guards-must-fire, fixtures, coverage, blind-spot]
applies_when:
  - standing up or extending a differential oracle
  - adding a claim to a suite that already passes ("the lint tier agrees", "the semantic tier agrees")
  - a gate's fixtures were authored for a different purpose than the claim being added
pattern: |
  A differential oracle can pass because both sides did NOTHING. The sibling lesson
  (`differential-oracle-is-blind-to-shared-input-bugs`) covers one route to that: a bug
  in the shared INPUT PATH, which both sides consume identically. This is the other
  route, and it is found by a different move.

  **Write the non-vacuity assertion BEFORE the parity assertion, and treat its failure
  as information rather than as a test to fix.**

  Measured, twice, extending the G2a oracle in G2b:

  ## Case 1 — the exclusion partition (a REAL gap)

  Adding "the lint tier agrees" to a suite that already diffed lint findings looked
  redundant: `tier: 'lint'` was already inside the canonical diff, and 32 of 63 findings
  on the corpus were lint findings. So the parity claim was already covered.

  Then the non-vacuity assertion — "at least one fixture must actually EXCLUDE a
  requirement" — failed. Measured across all 14 fixtures (12 adversarial + 2 production):

      excluded requirements:            0
      error-severity lint findings:     0
      lint findings that DO fire:      32, every one `warn`

  So the AC-3-7 exclusion gate — the parse→lint→symbolize ordering the tool calls
  "forced" because a lint failure makes symbolization unsound, and the thing the lint
  tier actually DECIDES — was inside the diff and never once exercised by it. Six lint
  rules are `error` severity and each excludes its requirement from the solver; an
  implementation that dropped the exclusion step would encode requirements the oracle
  refuses to encode, and every pinned fixture would still pass.

  Closed with ONE purpose-built document that straddles the decision (two requirements
  accepted, two blocked on DIFFERENT error rules) plus the waiver case, which is the one
  path where an exclusion REVERSES. Sabotage-verified twice: disabling the gate's
  blocking branch → 2 failures (was 0); dropping `waivers` at the boundary → 2 failures.

  ## Case 2 — the semantic tier (NOT a gap, and the assertion had to change)

  Adding "the semantic tier agrees" hit the same wall for a different reason: under the
  deterministic test stub the tier proposes NOTHING, because the stub's cosines are
  meaningless by construction. Asserting "the tier produced findings" would have been
  unsatisfiable without shipping the real 110 MB model into CI.

  The fix was to find the right OBSERVABLE rather than to weaken the claim: the tier
  having RUN is what discharges the `semantic-tier-skipped` demotion. Measured: 12 such
  demotions with the tier off, 0 with it on. That is a strictly better non-vacuity
  signal than a finding count, because it is the demotion whose entire purpose is to
  make an absent detector VISIBLE — i.e. it is the tier's own liveness bit.

  ## The rule

  For every claim added to a gate, ask "what would be different if this tier did
  nothing?" and assert THAT first. Three outcomes, all useful:

  1. it passes → the claim is worth adding and the fixtures reach it;
  2. it fails and the path is genuinely unreachable by the fixtures → **a blind spot**,
     closed by one observable case per decision (not by adding fixtures until one
     happens to cover it);
  3. it fails because the observable was wrong → find the tier's real liveness bit,
     which is usually a piece of DISCLOSURE the design already emits for exactly this
     purpose.
example_files:
  - packages/symspec/src/formal/differential.test.ts
---

# Why this matters

Both cases would have shipped as green parity blocks that proved nothing about the
tier they named — and worse, would have read in review as evidence the tier was
covered. Case 1 in particular is a gate whose named purpose ("the differential oracle
is green") was satisfied while the single most load-bearing decision in the tier had
never been executed by it.

The reason writing the non-vacuity assertion FIRST works is ordering: written second,
it is a formality appended to something already passing, and the temptation on failure
is to soften it. Written first, its failure is the only information available, so it
gets investigated.

# What NOT to do

Do not respond to a failing non-vacuity assertion by deleting it. Its failure is the
finding.

Do not respond by adding fixtures until one happens to cover the path — that is
unbounded and never tells you when you are done. Enumerate what the boundary DECIDES
(here: included vs excluded, plus the re-admission case) and write one observable case
per decision.

Do not put a per-case non-vacuity assertion where the claim is about a SET. Asserting
"every operation's descriptions cross-reference a flag" failed for five of eight ops
that legitimately have nothing to cross-reference, and satisfying it would have meant
inventing text. The surface-level form ("some description does") keeps the guard
meaningful without distorting the thing under test.
