---
title: Close a "conflict hidden behind differently-named guards" gap by re-encoding the doc's own state-implications into the conjunction — never by widening candidate selection heuristically
track: knowledge
category: architecture
module: src/formal/guard-implication.ts, src/formal/contradiction.ts, src/formal/encode.ts
component: symspec
severity: high
tags: [smt, reachability, contradiction, transitive-conflict, soundness, guard, state-machine, z3, propose-decide]
applies_when:
  - a per-context-group SMT checker misses a conflict because the two rules guard on differently-named states
  - the spec itself contains a "bridge" requirement asserting one guard-state implies another (authenticated => verified)
  - tempted to widen candidate-pair / group selection with a fuzzy or heuristic "these guards are probably related" rule
pattern: |
  symspec's contradiction tier groups requirements by IDENTICAL context-atom sets
  (planContextGroups) and asserts each group's context true, so a conflict is only
  reachable when the conflicting rules share a guard atom. A rule guarded on
  `authenticated` and one guarded on `verified` therefore never meet — EVEN when
  the spec contains a bridge requirement "while authenticated, be verified"
  (authenticated => verified). The bridge doesn't help because its response
  atomizes to a RESPONSE atom (resp__verified), a different atom from the GUARD
  atom (pre__verified) the other rule keys on.

  The WRONG fix is to make candidate/group selection fuzzier ("guards that look
  related get grouped") — that manufactures false positives and breaks the
  sound-modulo-atomization contract. The RIGHT fix keeps the solver honest:
  extract the state-implication the bridge ALREADY asserts and add it to the
  whole-spec conjunction as `bridgeId => (context => stateAsGuard)`, guarded by
  the bridge's own id. Then the existing SMT machinery computes the transitive
  closure ITSELF — asserting `authenticated` in a group forces `verified` through
  the bridge, activating the verified-guarded rule — and the unsat core NAMES the
  bridge alongside the two conflicting rules. No grouping change; the seam is a
  new pure extractor whose output is materialized next to the requirement
  formulas.

  Soundness rests on two conservative guards, NOT on the parse being clever:
    1. A fixed state-establishment verb lexicon (be/become/mark/set/remain/…) —
       behavioral responses ("issue a token", "grant access") are excluded, so
       only responses that genuinely establish a queryable state bridge.
    2. INERT-DROP: the established state, re-atomized as a `pre` guard, must
       EXACTLY match a guard atom another requirement keys on, or the implication
       is dropped. A mis-recognized establishment can then only ADD an
       implication whose consequent some rule already guards on; it cannot invent
       an atom. (An adversarial review confirmed the real safety net is this
       exact-match drop, not the implication's semantic truth — polysemous verbs
       like "enter the queue" mis-extract, but the bare state rarely equals real
       guard text, and per-system scoping bounds it. State the guarantee as
       "sound because the false atom coincidentally matching a real guard is
       rare + per-system scoped", not "the implication is always true-to-doc".)

  Negation threads correctly by computing the response's polarity via the resp
  atomization (respNegated) and passing it to the pre-atomization, so "shall not
  be verified" establishes ¬verified. Verify ESTABLISH_VERBS ∩ antonym-heads = ∅
  so an antonym XOR-flip can never desync the resp-computed sign from the guard
  atom. minimizeCore keeps a load-bearing bridge in the core (dropping its
  assumption makes the subset sat), so the bridge is always named; the
  disjoint-enumeration loop can only lose a second conflict (false negative),
  never manufacture one.
example_files:
  - src/formal/guard-implication.ts
  - src/formal/contradiction.ts
  - src/formal/__tests__/guard-implication.test.ts
---

# Why this matters

This is the general recipe for widening what a sound reachability checker can
prove WITHOUT relaxing its soundness: don't loosen candidate selection — mine the
implications the artifact already asserts, re-express them in the checker's own
language guarded by their source id, and let the solver close the transitive
loop. The finding then names the bridge, so the result is auditable. See the
sibling [[embeddings-propose-smt-decide]] for the fuzzy-propose / committed-decide
half; this is the deterministic-all-the-way version (no model in the loop).

# What NOT to do

Do not make group/candidate selection fuzzy to "relate" differently-named
guards. Do not claim a heuristic extraction "only adds true-to-doc facts" — bound
it with an inert-drop (exact guard-atom match) + a fixed verb lexicon, and state
the guarantee as coincidence-is-rare, not truth-is-guaranteed.
