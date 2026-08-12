---
title: When a differential oracle's donor leaves the repo, SPLIT the claims and delete what cannot survive — a repointed differential that compares a wrapper to its own callee is a tautology that reports green
track: knowledge
category: architecture
module: src/donor
component: testing
severity: high
tags: [differential-testing, oracle, transplant, tautology, guards-must-fire, vendoring, frozen-code]
applies_when:
  - a differential oracle's reference implementation is being removed from the repo
  - collapsing a two-package workspace where one package existed to be the oracle
  - a vendored/transplanted subtree is about to lose the original it was diffed against
  - deciding whether to repoint a test's imports or delete the test
pattern: |
  A differential oracle rests on there being TWO implementations. Remove one and the
  oracle is over, but it does not announce that — the imports still resolve, because a
  vendored copy of the donor is sitting right there in the package.

  The trap is repointing. `differential.test.ts` imported the donor's `runCheck` from
  outside the package; `src/donor/pipeline/check.ts` is a copy of exactly that file, so
  changing one specifier makes the suite green again. It is also now meaningless:
  `operations/check.ts` CALLS that same `runCheck`, so the test compares a wrapper
  against its own callee. Both sides run the same bytes. It can never fail, and it
  reports success in the same words it used when it was load-bearing. A deleted test
  leaves a hole a reader can see; a tautology leaves a hole that looks like coverage.

  So SPLIT the claims first and handle each by what it actually rests on. Three
  distinct claims were tangled together here:

  1. **Boundary equivalence** — the wrapper, the v3→v2 projection, and the envelope
     produce the tier's verdict unmodified. Needs two implementations. GONE.
  2. **Tier-body fidelity** — the vendored subtree is byte-identical to its origin.
     Needs the origin. GONE, and unreproducible: the 40 byte-diffs had nothing left
     to diff against.
  3. **Absolute correctness** — "this adversarial round must never look clean" is not
     an agreement claim at all. It needs only the FIXTURES, so it survives a copy of
     the fixture file. Notice this one, because it is the one a hasty deletion takes
     out for no reason.

  What replaces (1) and (2) is not a weaker version of them. It is a different, honestly
  scoped claim: the subtree is FROZEN, and the freeze is made enforceable rather than
  asserted. Three mechanisms, none of which pretend to be a differential:

  - a boundary test that RESOLVES every import specifier against its importer and
    fails if the result escapes the package — which a depth-counting regex cannot do,
    since `../../..` is fine from `src/a/b/c.ts` and escapes from `src/a.ts`;
  - the one legitimate crossing pinned as an exact list, so a second one is a review
    decision instead of an accident;
  - `knip`'s `ignore` on the subtree, because frozen code has unused exports BY DESIGN
    and letting a linter prune them is precisely the drift the freeze prevents — while
    reading in review like a tidy-up.

  The same reasoning applies to the PROSE. ~20 comments across production files
  justified a design decision by pointing at the oracle ("keep absence as absence,
  because the oracle canonicalizes JSON"), and one named a test file by path. Every one
  of those decisions was still correct; every justification was now false. The durable
  reason in each case was the same and simpler: the subtree is frozen, so nothing edits
  it. A comment that cites a deleted test is worse than no comment, because the next
  reader goes looking for the test.
anti_pattern: |
  Repointing a differential's imports at a vendored copy of the donor to keep the suite
  green. Deleting a whole test file because ONE of its imports crossed the boundary —
  `compat.test.ts` used `runCheck` only to make a projection observable and was never a
  differential, and `parse.test.ts` had 62 assertions of which 3 were the diff. Leaving
  a byte-equality guard as a substring grep, when the risk being guarded is a paraphrase
  that drifts toward reassurance and still reads fine.
resolution: |
  Deleted outright: donor-fidelity (transplant manifest + 40 byte-diffs), differential
  (the boundary oracle), adversarial (the scoreboard, whose fixtures lived outside).

  Decoupled surgically, keeping their independent coverage: compat.test.ts repointed at
  the vendored tier in one line; scope.test.ts traded a byte-diff against the donor for
  all seven honest-scope claims spelled out inline, keeping the substring assertions
  SEPARATE because those survive a lockstep edit to both copies; parse.test.ts dropped
  the ladder diff and the negative control that needed the UNFIXED donor, and gained a
  batch case asserting the line policy's real distinction (a no-modal bullet is
  `skipped`, i.e. content, not dropped, i.e. structure).

  Added: src/package-boundary.test.ts, which is what the fidelity test was actually for
  once there is nothing external to compare against.
see_also:
  - solutions/conventions/differential-oracle-is-blind-to-shared-input-bugs.md
  - solutions/architecture/donor-generated-fixtures-not-self-generated.md
  - solutions/conventions/oracle-non-vacuity-assertions-find-the-blind-spots.md
example_files:
  - src/package-boundary.test.ts
  - src/kernel/scope.test.ts
  - src/operations/parse.test.ts
  - src/formal/compat.test.ts
  - knip.jsonc
---

## The refinement this makes to the "do not weaken the oracle" rule

`differential-oracle-is-blind-to-shared-input-bugs.md` says: *"Do not weaken the oracle to
compensate (e.g. comparing against a snapshot instead of the live donor). The oracle is
sound for what it covers; it just does not cover this."*

That rule holds, and it is about a different situation: an oracle that still HAS two
implementations and is being softened to make a failure go away. When the second
implementation is genuinely leaving, softening is not on the table — the choice is between
deleting the claim and faking it.

The move is to **re-scope**, never to soften. Name what each assertion rests on, keep the
ones whose support survives, delete the ones whose support does not, and replace them with
a different claim that is true and enforceable. "This subtree is frozen and nothing imports
across the boundary" is a smaller claim than "this subtree is byte-identical to its
origin" — and it is checkable forever, which the larger one no longer is.

## Regenerating what was lost

The donor is a COMMIT, not a directory. `scripts/generate-import-fixtures.sh` reads a
`DONOR_REF` and materializes that tree in a throwaway `git worktree` to rebuild the import
fixtures, which keeps the anti-circularity property from
`donor-generated-fixtures-not-self-generated.md` intact: the op stream under test is still
the producer's, not one the consumer invented. Anything else that genuinely needs the old
implementation can be recovered the same way.
