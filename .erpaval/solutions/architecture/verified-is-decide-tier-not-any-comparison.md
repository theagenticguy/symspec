---
title: "Compared something" and "verified consistency" are different claims — a propose-only fuzzy finding may suppress a coverage disclaimer but must NEVER flip a `verified` boolean or an exit-code gate
track: knowledge
category: architecture
module: src/pipeline/check.ts, src/cli/exit.ts
component: symspec
severity: high
tags: [propose-decide, verified, exit-code, strict-gate, residual-risk, false-signal, coverage, determinism]
applies_when:
  - adding a first-class "verified: true|false" flag or a strict exit-code gate to a checker that also has propose-only fuzzy findings
  - a set of "cross-requirement finding codes" is reused to drive BOTH a coverage disclaimer AND a verification claim
pattern: |
  symspec added data.verified (#5) — false when >=2 requirements produced no
  cross-requirement comparison — plus a `--strict` gate that exits 3
  (EXIT_INCONCLUSIVE) on an inconclusive run. The first implementation computed
  `verified` from the SAME predicate that suppresses the FND_NO_PAIRS_CHECKED
  disclaimer: "any finding spanning >=2 ids, or any code in
  CROSS_REQUIREMENT_FND_CODES, fired". That set included the propose-only info
  codes (FND_SIMILAR_SEMANTIC, and newly FND_OPPOSITION_CANDIDATE), which name 2
  ids.

  The bug (adversarial review, low-sev but real): a propose-only fuzzy proposal —
  an embedding cosine crossing a 0.5 floor — then flipped `verified` to true and
  made `--strict` exit 0 instead of 3. A fuzzy SUGGESTION is the OPPOSITE of a
  verification, yet it quieted the "silence is not a consistency certificate"
  signal the gate exists to raise. That is a fuzzy score reaching an exit code —
  the exact propose/decide violation the tool forbids.

  The fix is to SPLIT the two claims that were conflated:
    - "A comparison happened" (drives the disclaimer): keep broad — ANY
      cross-requirement finding, incl. propose-only, means the pairwise tier
      wasn't silent, so FND_NO_PAIRS_CHECKED must not fire alongside it. (Keeps
      the coverage-disclaimer lesson intact.)
    - "Consistency was VERIFIED" (drives data.verified + --strict): STRICTER —
      only a DECIDE-tier finding spanning >=2 reqs counts, OR the pairwise tier
      actually checked a pair (pairsChecked > 0, a clean subsumption/redundancy
      run IS a verification). Exclude a PROPOSE_ONLY_FND_CODES set
      (SIMILAR_SEMANTIC, SIMILAR_UNUNIFIED, OPPOSITION_CANDIDATE,
      MISSING_TRACE_LINK, DUPLICATE_CLUSTER) from the verified predicate.

  Keep exit.ts pure: `verified`/gate resolution happens in runCheck (it has the
  findings + flags), which stamps `strictGate: 'pass'|'fail'` onto the report;
  exitCodeForEnvelope reads data.strictGate structurally and maps 'fail' →
  EXIT_INCONCLUSIVE, with an error-severity finding OUTRANKING it (→ 1). A default
  run leaves strictGate undefined so exit 0/1/2 is byte-unchanged.
example_files:
  - src/pipeline/check.ts
  - src/cli/exit.ts
  - src/cli/__tests__/exit.test.ts
  - src/pipeline/__tests__/check-wishlist.test.ts
---

# Why this matters

An honest-scope tool's `verified: false` and its inconclusive exit code are the
machine-readable form of "I could not check this". If a fuzzy proposal can flip
them to "clean", the signal is actively wrong in exactly the case (nothing was
proven) where an agent most needs the truth. Reusing one code-set for both a
disclaimer and a verdict-adjacent flag silently couples a lenient claim to a
strict one. See [[coverage-disclaimer-must-account-for-all-tiers]] for the
disclaimer half and [[embeddings-propose-smt-decide]] for the propose/decide rule
this enforces at the exit-code boundary.

# What NOT to do

Do not drive a "verified" flag or an exit-code gate off the same "cross-req
finding fired" predicate that governs a coverage disclaimer — a propose-only
finding legitimately suppresses the disclaimer (a comparison happened) but must
not assert verification. Split the predicates.

# Update (2026-07-13): verified is now a WHOLE-DOCUMENT claim (full demotion)

The Run 3 adversarial eval defeated the "any checked pair flips verified"
predicate 25/30: dense shared guard vocabulary bought one Jaccard pair
(verified=true) while the conflicting responses sat on singleton atoms nobody
compared. Hardened predicate — `verified=true` iff ALL hold:

1. PARTICIPATION: every gate-included requirement shares ≥1 atom with a peer
   (or is named by a decide-tier cross-req finding);
2. zero untriaged `FND_OPPOSITION_CANDIDATE` (waived = triaged, stops demoting);
3. a decide-tier cross-requirement comparison happened (the original rule);
4. the semantic tier ran (an embedder was supplied) when ≥2 requirements exist.

The dual principle now has a name: DEMOTION-ONLY. Propose-only findings and
coverage stats may demote `verified` (raise the alarm) but never promote it
(sound the all-clear). `data.coverage.demotions` lists every reason with its
exact discharging command, so the agent loop converges:
`check --strict` (exit 3) → apply listed ops (`antonym add`/`glossary add`/
`waive`/rewrite) → re-check → exit 0.
