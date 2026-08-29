---
title: A finer partition key is not uniformly safer — the safe direction is OPPOSITE for a prover and a discloser, so two tiers may share a derivation and must not share a granularity
track: bug
category: architecture
module: src/domain/engine/formal/relational.ts, src/domain/engine/pipeline/check.ts
component: symspec
severity: high
tags: [propose-decide, demotion-only, verified, partition-key, context-group, fabrication, false-positive, disclosure, shared-derivation]
applies_when:
  - two tiers group requirements on a shared key and one PROVES while the other DISCLOSES
  - refining a partition key to fix a false positive, anywhere a second consumer reads the same key
  - a coverage disclosure stops firing and nothing fails
pattern: |
  symspec fixed a fabricated `FND_NUMERIC_CONTRADICTION` by making a guard key finer: from
  `trigger` alone to a composite `<preCondition>|<trigger>`, so two mutually exclusive states stop
  reading as one always-on context. Correct for the tier that motivated it, and the commit reasoned
  "splitting a key is safe, merging is not" — the rule the whole plan rests on.

  The key had a SECOND consumer. `findQuantityAliasCandidates` PROVES (it proposes a committed
  alias that makes a numeric conflict provable), while `findRelationalUnchecked` DISCLOSES (it emits
  only `info` plus a demotion). Under the finer key, a pair sharing a trigger and differing in
  precondition stopped grouping, the group fell below two, `FND_RELATIONAL_UNCHECKED` vanished, and
  with it `relational-reasoning-not-attempted` — the only demotion that document had.

  Measured consequence: a document the fabrication corpus files as a KNOWN OPEN GAP went from
  `verified: false` to `verified: true` while still emitting two error-severity findings. The worst
  pair of bytes the tool can emit, on the one document that is supposed to be a standing record of
  a fabrication. `check.ts` states the invariant in the present tense — propose-only findings and
  coverage stats may push `verified` toward `false`, never toward `true` — and it read as satisfied
  because `FND_RELATIONAL_UNCHECKED` *is* propose-only. The violation was not the finding's
  severity; it was the finding's ABSENCE.

  THE RULE:
    - a PROVER wants the FINER key. Too coarse co-asserts guards no requirement declared together,
      which fabricates.
    - a DISCLOSER wants the COARSER key. Too coarse over-discloses, which is harmless. Too fine
      DELETES a disclosure — and deleting a demotion moves the verdict toward `true`.

  So "splitting is safe, merging is not" is a rule about PROVERS. For a discloser it inverts, and
  the two cannot share one granularity. The fix keeps `guardKeyOf` as the shared derivation (so the
  tiers never disagree about what a context IS) and gives the discloser its own grouping: one group
  per non-empty guard SLOT rather than one per slot pair, deduped by id set.
example_files:
  - src/domain/engine/formal/relational.ts
  - src/domain/engine/formal/relational.test.ts
  - src/domain/engine/pipeline/check.ts
  - src/testing/fabrication.test.ts
---

# Why this matters

The generalizable trap is not the key; it is that **a deletion is invisible**. Every gate in the
repo scores whether something FIRED. Nothing scored whether a disclosure stopped firing, so a
change that removed coverage read exactly like a change that improved precision. The tier had no
behavioral test at all — the only mention of `FND_RELATIONAL_UNCHECKED` in any test file was inside
`advice/repair.test.ts`'s exhaustive reason list, which pins that a repair EXISTS for the reason and
never that the reason is reachable. That is how the false direction claim survived a review that
explicitly checked the direction claim.

The diagnostic: after refining any key, enumerate every consumer and ask of each whether it PROVES
or DISCLOSES. If the answer differs between two consumers, one of them now has the wrong
granularity, and the one that lost coverage will not tell you.

See [[verified-is-decide-tier-not-any-comparison]] for the doctrine the deletion violated,
[[a-propose-only-finding-that-must-not-demote-either]] for the case where NOT demoting is correct
(and note this is its mirror: there the finding should not demote, here it must), and
[[normalization-for-a-propose-signal-must-not-touch-the-decide-key]] for the sibling rule about
leniency and keys.

# What NOT to do

Do not reason about a partition key's safety without naming which consumer you mean. "Finer is
safer" and "coarser is safer" are both true, of different tiers, and a shared key with a shared
granularity silently picks one of them to be wrong. And do not accept a vanishing `info` finding as
a precision win — assert the disclosure fires, or the next refinement deletes it again.
