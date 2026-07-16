---
title: For a sound checker's blind spots, split tractable-from-not — SOLVE what's soundly recoverable, DETECT-AND-DEMOTE what isn't; never fabricate a solver
track: knowledge
category: architecture
module: src/formal/quantity-alias.ts, src/formal/relational.ts, src/formal/coverage.ts, src/pipeline/check.ts
component: symspec
severity: high
tags: [demotion-only, propose-decide, sound-modulo-atomization, verified, coverage, adversarial-eval, false-confidence, numeric-tier]
applies_when:
  - an adversarial eval shows `verified=true` (or a clean gate) over a class of conflicts the checker's tier structurally cannot see
  - tempted to extend a sound/deterministic tier to cover aggregate / cross-quantity / emergent-structural conflicts recoverable only by guessing from NL
  - a "positive claim" flag (verified / certified / clean) outruns what the engine actually compared
pattern: |
  symspec's numeric tier is PAIRWISE + SAME-QUANTITY only (bounds keyed off the
  response verb phrase). A red-team (GitHub #2) drove `verified=true` on z3-unsat
  specs via four blind-spot families: (1) same physical quantity under two verbs
  ("complete the infusion within ≤30 min" vs "run the infusion for ≥60 min" →
  two keys, never compared); (2) aggregate/conservation (N reservations summing
  past capacity, never summed); (3) cross-quantity arithmetic (end=start+dur);
  (4) emergent structural impossibility (odd-cycle 2-coloring, pigeonhole).

  The doctrine (DEMOTION-ONLY + sound-modulo-atomization) dictates a SPLIT, and
  the issue itself endorsed it ("the doctrine is right; verified=true is a
  positive claim the blind spot doesn't support"):

  - TRACTABLE (family 1): keep it PROPOSE/DECIDE. A deterministic detector emits
    a propose-only `FND_QUANTITY_ALIAS_CANDIDATE` that DEMOTES `verified` and
    hands the author the EXACT `glossary add` command; committing it routes both
    phrasings to one quantity key so the existing LIA solver proves the real
    z3-unsat. The tool solves nothing it can't keep sound — the author's
    committed glossary is the decide artifact.
  - INTRACTABLE (families 2-4): DETECT-AND-DEMOTE, never solve. A deterministic
    detector recognizes the STRUCTURAL SHAPE (shared trigger + numeric bounds
    with singleton atoms, OR inter-entity relational language) and emits a
    propose-only `FND_RELATIONAL_UNCHECKED` that DEMOTES `verified` with an
    honest "aggregate/relational reasoning not attempted" caveat. It CANNOT
    manufacture a false contradiction because it never asserts one — it only
    declines to certify. Inferring the finite resource / arithmetic relation
    from prose would require guessing, which violates sound-modulo-atomization.

  Wiring: `verified = demotions.length === 0`. New demotion reasons append to the
  one demotion block; the codes go in PROPOSE_ONLY_FND_CODES so they can only
  demote (never promote / never mark a requirement as a decide-tier participant).
  Also surface coverage as a FIRST-CLASS loud signal: `coverage.{encoded,
  excluded}` + a per-excluded-requirement `FND_EXCLUDED_FROM_FORMAL` (a lint
  exclusion that removes a requirement from the solver must DEMOTE, not silently
  pass — the "0 contradictions, verified:true, but a third was never checked"
  trap both feedback sources hit).
example_files:
  - src/formal/quantity-alias.ts
  - src/formal/relational.ts
  - src/formal/coverage.ts
  - src/pipeline/check.ts
  - adversarial/eval-rounds.ts
---

# Why this matters

A checker that answers a class of question it structurally cannot see is worse
than one that abstains: the false all-clear lands exactly where the user most
needs the truth. The move that preserves both soundness and usefulness is to
solve only what a committed, reviewed artifact makes provable, and to convert
every remaining blind spot into a LOUD, actionable demotion — so `verified`
never means more than "the deterministic tier actually compared this." A missed
conflict becomes an explicit "not attempted" caveat with a discharge path, not a
silent pass. See [[verified-is-decide-tier-not-any-comparison]] for the
demotion-only rule this extends and [[embeddings-propose-smt-decide]] for the
propose/decide split the quantity-alias detector reuses.

# What NOT to do

Do not extend the sound tier to "handle" families it can only guess at, and do
not let a coverage gap (excluded requirement, unsummed aggregate, unrelated
quantities) leave `verified` untouched. Detect the shape, demote, and hand the
author the next step.
