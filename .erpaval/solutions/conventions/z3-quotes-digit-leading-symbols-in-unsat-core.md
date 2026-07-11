---
title: Z3 wraps a symbol that isn't a legal SMT-LIB2 simple symbol (a UUID starting with a digit) in |...| — strip it when matching unsat-core members
track: knowledge
category: conventions
module: src/formal/numeric-contradiction.ts, src/formal/temporal.ts
component: z3-solver
severity: medium
tags: [z3, smt-lib2, unsat-core, symbol-quoting, uuid, string-matching]
applies_when:
  - using z3-solver assumption literals named after requirement ids to recover culprits from unsatCore()
  - the ids are UUIDs (or any string starting with a digit, or containing chars outside the simple-symbol set)
  - the unsat core comes back but your string match against known ids finds only SOME members
pattern: |
  The unsat-core-names-the-culprits technique asserts each item under a guard
  `ctx.Bool.const(id)` and maps unsatCore() members back to ids by string.
  z3-solver renders a Bool const whose name is NOT a legal SMT-LIB2 *simple
  symbol* — critically, one that STARTS WITH A DIGIT — as a `|...|`-quoted
  symbol. So a UUID guard like `2b1d473c-...` comes back from unsatCore() as
  `|2b1d473c-...|`, and a naive `knownIds.has(member.toString())` misses it,
  yielding a core with only the digit-safe ids. The finding then names one
  culprit instead of two.

  This bit BOTH new v3 tiers (numeric-contradiction.ts, temporal.ts) because both
  copied the pattern. Fix: strip the quotes before matching:
      const name = coreMember.toString().replace(/^\|(.*)\|$/, '$1')
      if (knownIds.has(name)) ...

  The propositional contradiction.ts sidesteps this without a strip because it
  builds a `guardByString` Map keyed on the SAME `g.toString()` (quoted) form it
  later looks up — so its keys and core members are quoted consistently. Any NEW
  core-mapping code that compares against the RAW id (not a toString-keyed map)
  must strip the quoting.
example_files:
  - src/formal/numeric-contradiction.ts
  - src/formal/temporal.ts
  - src/formal/contradiction.ts
---

# Why this matters

Requirement ids are UUIDs (crypto.randomUUID), and ~%6 of them start with a
digit. So this bug is intermittent-by-id: it passes tests with hand-picked ids
like 'A'/'B' and fails in production on exactly the UUIDs the runtime mints. A
finding that names one of two culprits looks plausible enough to ship. The
adversarial harness / a UUID-using pipeline test is what exposes it.

# What NOT to do

Do not assume unsatCore() members stringify to the raw symbol name. Either strip
the `|...|` quoting, or key a lookup Map on the same `.toString()` form you use
to build the assumption literals (contradiction.ts's approach).
