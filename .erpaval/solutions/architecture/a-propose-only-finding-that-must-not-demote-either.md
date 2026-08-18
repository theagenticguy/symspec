---
title: DEMOTION-ONLY grants permission, it does not compel — a finding that reports a WORDING risk rather than a coverage gap must not demote, or it becomes a build gate an author can only clear by waiving it
track: knowledge
category: architecture
module: src/domain/terminology/terminology-codes.ts, src/app/operations/check.ts
component: symspec
severity: medium
tags: [propose-decide, demotion-only, verified, strict-gate, exit-code, coverage-disclaimer, info-severity, splice-seam]
applies_when:
  - adding a propose-only finding to a tool that already has a DEMOTION-ONLY doctrine
  - the new finding reports a risk the tool DID examine, rather than something it could not check
  - deciding where to splice a new tier's findings into an existing findings[] array
pattern: |
  symspec's doctrine (`verified-is-decide-tier-not-any-comparison`) is DEMOTION-ONLY:
  propose-only findings may demote `verified` but never promote it. Read as a default it
  says "demote"; read correctly it says "you MAY demote". The distinction decides whether a
  new finding is usable.

  A demotion is not a severity — it is an OBLIGATION. `check --strict` exits 3 while any
  demotion stands, and `coverage.demotions` publishes a discharging command per reason, so
  the agent loop is: exit 3 -> apply the op -> re-check -> exit 0. That contract only works
  when every demotion names something the tool COULD NOT CHECK.

  `FND_TERM_INCONSISTENT` (a committed vocabulary entry applied across two unrelated
  contexts) and `FND_ACRONYM_UNDEFINED` are not coverage gaps. The solver checked everything
  it was going to check; what they say is that the author's WORDS may not mean what the atoms
  assume. There is no op that discharges "this might be two concepts" — the correct answer is
  often "leave it". Demoting on that makes a wording opinion fail a build, and an author who
  cannot honestly discharge it will `waive` it, which costs the signal its meaning and trains
  the reflex on every other demotion too.

  So the test for a new propose-only finding is not its severity, it is: IS THERE AN OP THAT
  DISCHARGES IT? If yes, demote. If the honest response may be "no change", do not.

  Two mechanics make "does not demote" a checked property rather than a promise:
    - the finding type declares `severity: 'info'` as a LITERAL, so an `error` from the tier
      is a `tsc` failure; `counts.error` is the only number `exitCodeForEnvelope` reads;
    - the report type carries NO demotion channel at all, so adding one is a type change in
      review rather than a quiet `push`.

  THE SPLICE POSITION IS ALSO LOAD-BEARING, and for a non-obvious reason. The coverage
  disclaimer `FND_NO_PAIRS_CHECKED` is suppressed whenever any finding spans >= 2 requirement
  ids. A vocabulary finding names two ids — but it compared those requirements for WORDING,
  never for consistency. Splicing it inside the engine would quiet a disclaimer over a
  comparison that never happened, which is the `coverage-disclaimer-must-account-for-all-tiers`
  hazard pointed the other way: not a disclaimer firing wrongly, but a true one going silent.
  Splicing at the app boundary AFTER the engine returns makes that structurally impossible.
  Assert the PROPERTY (the disclaimer is still present) and not the seam, so moving the splice
  cannot take the disclaimer with it.
example_files:
  - src/domain/terminology/terminology-codes.ts
  - src/app/operations/check.ts
  - src/app/operations/check.test.ts
---

# Why this matters

An honest-scope tool's demotion set is its work list. Every entry an agent cannot discharge
is an entry that teaches the agent to suppress the list rather than work it. The failure is
not loud — `verified: false` is a legal value — it is the slow erosion of a gate everything
else depends on.

Note this is the mirror of the bug the doctrine was written for. There, a fuzzy PROPOSAL
flipped `verified` to true and sounded an all-clear nobody had earned. Here, a fuzzy proposal
would flip it to false and raise an alarm nobody can clear. Both are a propose-only score
reaching a gate; the doctrine forbids one direction explicitly and the other by omission.

See [[verified-is-decide-tier-not-any-comparison]] for the doctrine,
[[coverage-disclaimer-must-account-for-all-tiers]] for the disclaimer half, and
[[detect-and-demote-vs-solve-for-intractable-blind-spots]] for the case where demoting IS
right — a blind spot the tool genuinely cannot reason about, which a budget or a bound can
discharge.

# What NOT to do

Do not reach for a demotion to signal that a finding is important. Severity communicates
importance; a demotion communicates "I could not check this" and obliges someone to act. If
the honest remedy for your finding may be "no change", `info` with no demotion is the whole
mechanism, and the absence of a demotion channel on the report type is how you keep it.
