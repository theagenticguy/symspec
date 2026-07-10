---
title: EARS→SMT conflict checks must assert per-context-group reachability — global conjunctions are unsound in both directions
track: knowledge
category: architecture
module: src/formal/contradiction.ts
component: z3-solver
severity: high
tags: [smt, z3, ears, contradiction, unsat-core, guarded-implication]
applies_when:
  - encoding guarded requirements (trigger/precondition ⇒ response) for conflict detection
  - a solver check finds nothing on an obviously-conflicting spec, or flags mutually-exclusive-trigger pairs
pattern: |
  (X ⇒ Y) ∧ (X ⇒ ¬Y) is SAT — the solver just sets X=false. So a naive
  conjunction of all requirement formulas finds NO conflicts. The opposite
  fix — asserting all triggers true globally — manufactures spurious
  conflicts between requirements whose triggers can never co-occur.

  Sound discipline (implemented in findContradictions):
  1. Group requirements by their context-atom set (trigger/precondition atoms).
  2. Per group: assert THAT group's context atoms true, include EVERY
     requirement's guarded formula (whole-spec — ubiquitous ¬R must be able
     to clash with an event-driven T⇒R), check with requirement-id assumption
     literals only.
  3. Add a baseline empty-context group so two ubiquitous requirements R/¬R
     conflict with no trigger needed.
  4. Unsat core = assumption literals = requirement ids; since context
     assertions are add()'d (not assumptions) they can never pollute the core.
  5. Z3 cores are not minimal even with smt.core.minimize — run deletion-based
     minimization before reporting ids, or an innocent whole-spec bystander
     lands in the blame set.

  All of it only works because atoms unify: negation must be a polarity flag
  on the SAME positive atom (never baked into atom text), scoped per
  systemName, with an antonym table for grant/revoke-style lexical opposites.
example_files:
  - src/formal/contradiction.ts
  - src/formal/atomize.ts
  - src/pipeline/__tests__/check.test.ts
---

# Why this matters

This is the difference between a formal tier that provably works and one that
silently returns "no conflicts" forever (the SAT-by-false-guard trap) — the
kind of bug no per-module unit test catches unless someone knows to plant it.

# What NOT to do

Do not check pairs in isolation from the whole spec (misses ubiquitous-vs-
guarded conflicts), and do not report raw z3 cores as culprit lists.
