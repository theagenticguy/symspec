---
title: A coverage/"we-checked-nothing" disclaimer must be gated on ALL tiers that could have checked — a per-tier counter behind a whole-run claim is a contradictory signal
track: knowledge
category: architecture
module: src/pipeline/check.ts, src/formal/coverage.ts
component: symspec
severity: medium
tags: [findings, coverage, residual-risk, disclaimer, false-signal, pairs-checked, honest-scope]
applies_when:
  - emitting a "no comparison was performed / silence is not a certificate" disclosure
  - a coverage counter drives a user-facing claim but only counts ONE of several analysis tiers
  - a tool wants to surface residual risk (what it did NOT verify) prominently
pattern: |
  symspec emits an info-tier FND_NO_PAIRS_CHECKED ("nothing was compared across
  requirements — this is NOT a consistency certificate") when
  `pairsChecked === 0 && requirements.length >= 2`. But `pairsChecked` counts
  ONLY the pairwise subsumption/redundancy tier's candidate pairs. The
  contradiction, numeric, temporal, and vacuity tiers each run over ALL
  requirements (or per context-group), INDEPENDENT of that pair filter. So a
  `--temporal` run could PROVE two FND_TEMPORAL_CONTRADICTION errors while
  `pairsChecked` was still 0 — and the pipeline ALSO emitted "nothing was
  compared." Two true statements, one contradictory signal: the loud disclaimer
  read as whole-run coverage while the counter behind it was one-tier-only.

  Fix: gate the disclaimer on whether ANY cross-requirement finding fired, not
  on the single-tier counter. The robust predicate is
  `finding.requirementIds.length >= 2` (every genuine cross-req finding names
  the ≥2 ids its analysis spanned), with a known-cross-req FND_* code-set as a
  belt-and-suspenders backstop for a degenerate unsat core that minimized to one
  id. Emit only when `pairsChecked === 0 && reqs >= 2 && !crossRequirementFired`.
  Verify single-requirement findings (vacuity on one req, ambiguity, per-req
  lint) do NOT suppress it — the disclaimer SHOULD still fire when truly nothing
  cross-requirement ran.

  Companion move — surface residual risk as a first-class SUMMARY, not just
  scattered info findings. A `residualRisk` object on the report
  (similarUnunifiedPairs, semanticSuggestions, pairsChecked, noPairsChecked,
  excludedRequirements, unmatchedAtoms) makes "what I did NOT check" readable at
  a glance so users don't over-trust silence. unmatchedAtoms (atoms owned by
  exactly one requirement) was cheap to compute from the already-in-scope
  encoded atom roster — count singletons in an atom→owner-set map, no new solver
  contact. Compute all counts from the KEPT (post-waiver) finding set so a
  waived residual-risk finding drops out of the summary too. Survives --dense
  (only per-finding `evidence` is elided; a top-level summary object stays).
example_files:
  - src/pipeline/check.ts
  - src/formal/coverage.ts
  - src/pipeline/__tests__/check-wishlist.test.ts
---

# Why this matters

An honest-scope tool's credibility lives in its disclaimers. A disclaimer that
fires ALONGSIDE the very findings it claims don't exist teaches users to
distrust it — worse than no disclaimer, because it's actively wrong in exactly
the case (a real conflict was found) where trust matters most. The root cause is
a category error: a coverage claim scoped to the whole run, driven by a counter
scoped to one tier.

# What NOT to do

Do not drive a whole-run coverage/"nothing checked" claim off a counter that
only reflects one analysis tier. When multiple independent tiers can each
"check," gate the disclosure on the union of their outputs (findings that span
≥2 requirements), not on any single tier's bookkeeping. Do not bury residual
risk in individual info findings only — roll it into a named summary the default
output surfaces.
