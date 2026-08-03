---
title: Prove-twice needs a MAXIMAL frame, not the declared one — "strict vs framed" reads as a boolean and is unsound as one
track: knowledge
category: architecture
module: packages/symspec/src/formal/reachability.ts
component: spacer-reachability
severity: high
tags: [spacer, frame, soundness, ac-2-5, v16, reachability, false-positive]
applies_when:
  - implementing the AC-2-5 prove-twice protocol
  - deciding what a reachability "counterexample" is allowed to assume
  - reporting an error-severity finding from an unbounded reachability query
pattern: |
  The AC-2-5 decision doc specifies "prove twice, report the strongest verdict"
  with a per-variable `frame: stable | volatile` defaulting to volatile. That
  reads as a boolean — run once strict, once framed — and implementing it as one
  is UNSOUND in the reporting direction.

  THE BUG: if the framed run pins only the variables declared `frame: stable`,
  then a document declaring NONE makes the two runs byte-identical. `reachable`
  in both is trivially true, so the lattice's "reachable both ways => VIOLATED"
  cell fires on every constraint. Result: confident error-severity findings about
  defects the document does not contain.

  MEASURED on the worked lock/grant fixture: a lock-count constraint
  (`granted <= 1`) reported VIOLATED by a requirement that only touches `idle`,
  because with nothing pinned `granted` may jump spontaneously between steps. The
  trace read `init -> TX-A3 -> TX-C1` and TX-A3 does not mention `granted`.

  THE FIX: the two runs need two DIFFERENT frames, and neither is the declared one.

    - run 1, frame NONE: nothing pinned. Sound for proving UNREACHABLE — if no
      violation exists even when everything may change freely, none exists under
      any weaker assumption.
    - run 2, frame FULL: every variable no effect writes is pinned. Sound for
      reporting REACHABLE — every step of the witness is a change some requirement
      makes, so the counterexample is a real behavior of the described system.

  The DECLARED set does not disappear; it moves from "which run to perform" to
  "how tight is the disclosed hypothesis". On a PROVED_UNDER_HYPOTHESES verdict,
  re-run with frame=declared: if the author's own declarations carry the proof, the
  disclosure names exactly what they wrote down instead of all N variables. That is
  decision-doc design rule 3 (minimize the frame set) implemented as one extra
  query, and only on the path that needs it.

  COROLLARY worth knowing before writing fixtures: with more than one state
  variable, the frame-NONE run is essentially always reachable, so `PROVED`
  frame-closed is a property of single-variable models rather than of a working
  tier. The honest common outcome for a real document is
  `PROVED_UNDER_HYPOTHESES` with the relied-upon variables named. That is
  `frame: volatile` doing its job — a missing declaration WEAKENS the claim — and
  a gate that demands frame-closed proof is testing the fixture's shape, not the
  tier. (Cost one gate rewrite to learn.)
example_files:
  - packages/symspec/src/formal/reachability.ts
  - packages/symspec/src/formal/reachability-worked.test.ts
  - packages/symspec/scripts/reachability-feasibility.ts
---

# Why this matters

V16 is about the frame fabricating a PROOF. This is the mirror image — the frame's
absence fabricating a DEFECT — and the decision doc names it in prose ("strict is
the UNSOUND direction for reporting reachable") without saying what to encode. The
boolean reading satisfies every sentence in the doc and still ships false
error-severity findings.

It was caught by the worked end-to-end fixture, not by any unit test: the unit
fixtures were single-variable, where frame-none and frame-full coincide. That is
the argument for building a realistic multi-variable example BEFORE trusting a
tier, and for reading its output rather than only its assertions.
