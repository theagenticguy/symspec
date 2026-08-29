---
title: A finding that means the tool FAILED to decide must be excluded from every "a comparison happened" predicate — enumerate a code set by what the code MEANS, never by which tier emitted it
track: bug
category: architecture
module: src/domain/engine/pipeline/check.ts
component: symspec
severity: high
tags: [verified, propose-decide, coverage, code-set, needs-review, incomplete, certification, unknown, closed-set]
applies_when:
  - a predicate over a finding-code SET decides whether coverage was achieved or a verdict certified
  - adding a finding code that reports inconclusiveness, ineligibility, or "not attempted"
  - a code set is named after a tier or a provenance rather than after a meaning
pattern: |
  symspec's `verified` is a COVERAGE claim, and one of its conditions is "a decide-tier
  cross-requirement comparison actually happened". That was implemented as a predicate over finding
  codes:

      f.requirementIds.length >= 2 && !PROPOSE_ONLY_FND_CODES.has(f.code)

  Two codes were in NEITHER `PROPOSE_ONLY_FND_CODES` nor `COVERAGE_GAP_FND_CODES`, and both name
  two or more requirement ids:

    - `FND_NEEDS_REVIEW` — the solver returned `unknown` on a context group. It means "I could not
      decide". It was counting as a decide-tier comparison, so an UNDECIDED group CERTIFIED
      `verified: true`.
    - `FND_INCOMPLETE` — a heuristic that a trigger group's preconditions may not be exhaustive. It
      is eligibility, not comparison. Same effect.

  Both are emitted from the formal tier, which is exactly why they slipped through: the set was
  reasoned about as "the propose-only tiers' codes" rather than as "codes that do not evidence a
  comparison". A code from a decide tier can still mean the decision did not happen.

  The fix is to enumerate the set by MEANING. A code belongs to the not-a-comparison set when it
  reports any of: the tool declined, the tool timed out, the tool was not run, the tool found the
  input ineligible, or the tool is guessing. `unknown` is the load-bearing case, because it is
  produced by the same function that produces a proof and differs only in the answer.
example_files:
  - src/domain/engine/pipeline/check.ts
  - src/domain/engine/formal/needs-review.test.ts
---

# Why this matters

This is the propose/decide wall breached from an unexpected side. The doctrine is usually stated as
"a fuzzy score must not reach a verdict", and everyone checks the embedding tier. Here nothing fuzzy
was involved: a DETERMINISTIC solver call, in the decide tier, returned `unknown`, and the absence
of an answer was recorded as the presence of one.

An honest-scope tool's worst output is a certificate over work it did not do. `verified: true`
plus a timed-out solver is precisely that, and it is silent — there is no error, no demotion, and
the run looks like a clean pass.

The transferable diagnostic: for every code set that drives a coverage or certification predicate,
read each member and ask "does this code assert the tool DID something, or that it did not?" If the
set was assembled by tier, provenance, or severity rather than by that question, it is probably
wrong. Severity in particular is not a proxy: both codes here are `info`, and so are codes that
legitimately evidence a comparison.

See [[verified-is-decide-tier-not-any-comparison]] for the doctrine and the original split between
"a comparison happened" (broad) and "consistency was verified" (strict) — this is a third case that
belongs on the strict side and was on the broad one.
[[coverage-disclaimer-must-account-for-all-tiers]] is the same category error pointed at a
disclaimer instead of a verdict.

# What NOT to do

Do not name a finding-code set after the tier that emits its members. `PROPOSE_ONLY_FND_CODES` is a
statement about what the codes MEAN, and the moment a decide tier emits a code meaning "I could not
decide", a tier-shaped mental model puts it in the wrong set. And do not assume a closed
string-literal union protects you: adding a code to the union is a compile error only where a switch
is exhaustive, never where the code is merely absent from a `Set`.
