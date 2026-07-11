---
title: A generative-adversarial bad-spec harness finds real detector gaps a green test suite misses — wire it as a regression gate
track: knowledge
category: architecture
module: adversarial/generate.ts, adversarial/harness.ts, src/formal/numeric.ts
component: symspec
severity: high
tags: [adversarial, testing, regression-gate, detectors, proposer-judge, false-negatives]
applies_when:
  - building a tool whose job is to DETECT defects (linter, validator, conflict checker, security scanner)
  - unit tests pass but you have no evidence the detector catches defects it has never been shown
  - you want a standing guarantee that detection quality does not regress
pattern: |
  symspec v3 added four defect detectors (numeric, ambiguity, temporal, missing-link),
  each with green unit tests. But unit tests prove a detector fires on the ONE
  input the author imagined — they say nothing about the inputs the author didn't.
  A generative-adversarial harness closes that gap and is the single
  highest-leverage thing built this session.

  The shape (adversarial/):
  - A deterministic GENERATOR emits labelled bad specs — {doc, kind, tier,
    expectedCodes, culpritIds} — across every defect class, at escalating
    difficulty tiers (1 = blatant verbatim, 4 = buried under distractors +
    paraphrase + unit mismatch). Pure function of a seed, so it is a reproducible
    regression fixture; it ALSO accepts LLM-authored cases in the same shape for
    open-ended pressure.
  - A HARNESS runs the real tool over each case and scores DETECTION (did an
    expected code fire?) and LOCALIZATION (did the finding name the planted
    culprit ids?), escalating tier by tier with a gap report and a tier-1
    regression floor (100% or the harness fails).

  Running it for the first time immediately surfaced THREE real gaps a full green
  suite had hidden:
  1. the numeric tier ran only over gate-INCLUDED requirements, so a
     missing-units lint ERROR excluded (and hid) a real numeric contradiction —
     fixed by running numeric over ALL requirements (it's independent of the
     propositional-encoding soundness the gate protects);
  2. quantity-label capture kept trailing prepositions ("respond in" vs
     "respond"), splitting one quantity so a conflict escaped;
  3. "no less than" also matched the substring "less than", emitting a spurious
     opposite predicate — fixed by tracking claimed char ranges.

  None of these had a failing test. The adversary found them because it generates
  inputs the author would never hand-write. This is the coach-builder
  proposer-judge-ratchet pattern applied to a linter: the generator proposes
  ever-harder defects, the tool judges, misses ratchet into fixes.
example_files:
  - adversarial/generate.ts
  - adversarial/harness.ts
  - adversarial/__tests__/harness.test.ts
  - src/formal/numeric.ts
---

# Why this matters

A detector's promise is "I catch defect class X." A green unit suite only proves
"I catch these three examples of X." The gap between those is where every missed
conflict lives — and for a spec validator whose whole value is "conflict-free
specs", a false negative is the expensive failure. The adversarial harness turns
that gap into a measurable, escalating, autonomous score with a regression floor.

# What NOT to do

Do not treat the generator's fixtures as sacred — when the harness reports a
miss, first check whether the FIXTURE is actually a valid instance of the defect
(dropping a `negated` flag or double-negating a pattern can make a "contradiction"
fixture secretly consistent). A miss is either a real detector gap OR an invalid
fixture; both are worth fixing, but they are different fixes. Do not let the
generator author verdicts — it labels ground truth, the tool under test decides.
