# symspec v3 — derived tasks

Waves respect the propose/decide invariant and the manifest single-source
(codes/descriptions/types-enum/COMMAND_SPECS stay synced or drift tests fail).

## Wave A — v3.0 numeric (deterministic core)

- T-AC-30-1 [P] — extend `Formula` AST + `materialize` with `cmp` arithmetic node → `encode.ts`
- T-AC-30-2 [P] — numeric-predicate extractor (tuple parse, unit normalization, quantity-identity) → new `formal/numeric.ts`
- T-AC-30-3 — `FND_NUMERIC_CONTRADICTION` check over same-quantity predicates via Z3 unsat core → `formal/numeric-contradiction.ts`; wire into `pipeline/check.ts` (deps: 30-1, 30-2)
- T-AC-30-4 [P] — append code to `FndCodeSchema` + `.describe()` → `formal/codes.ts`
- T-AC-30-5 [P] — update `scope-text.ts` (numeric now checked; nonlinear out)

## Wave B — v3.1 ambiguity family (deterministic core + embedding dual)

- T-AC-31-1 [P] — `FND_AMBIGUOUS_VAGUE` formalize lexical scan → `solvers/free/ambiguity.ts`
- T-AC-31-2 [P] — `FND_AMBIGUOUS_QUANTIFIER` (bare plural / all / and-or) → ambiguity module
- T-AC-31-3 [P] — `FND_AMBIGUOUS_REFERENCE` (≥2 antecedents) → ambiguity module
- T-AC-31-4 — `FND_TERM_INCONSISTENT` homonym-drift dual → `formal/semantic.ts` (deps: v2 embed)
- T-AC-31-5 [P] — `FND_AMBIGUITY_NEEDS_JUDGMENT` structured punt → ambiguity module
- T-AC-31-6 [P] — append all ambiguity codes to `FndCodeSchema` + describe; update scope-text

## Wave C — v3.2 graph + DAG (deterministic proposal engine)

- T-AC-32-1 [P] — deterministic kNN similarity graph (batch=1, quantized cosine, id tie-break) → `formal/graph.ts` (deps: Wave B for embed reuse pattern)
- T-AC-32-2 — seeded community detection + near-dup/coverage/incoherent findings → graph module
- T-AC-32-3 [P] — `FND_LEAF_UNVERIFIABLE` DAG invariant → `core/analyze.ts`
- T-AC-32-4 — `FND_MISSING_TRACE_LINK` (high-cosine unlinked pair) → graph module
- T-AC-32-5 [P] — pin determinism params + CI reproducibility test

## Wave D — v3.3 temporal (feasibility-gated)

- T-AC-33-0 — Z3-WASM bounded-LTL feasibility benchmark (GATE) → `scripts/temporal-feasibility.ts`
- T-AC-33-1 [P] — EARS→SPS/FRET pattern mapping (pure) → `formal/temporal-patterns.ts`
- T-AC-33-2 — bounded-trace SMT encoding + `FND_TEMPORAL_CONTRADICTION` + bound/complete envelope (deps: 33-0, 33-1)
- T-AC-33-3 [P] — optional `temporal-backend` manifest entry → `cli/backends.ts`

## Wave E — v3.4 adversarial harness (after A–C)

- T-AC-34-1 [P] — adversarial bad-spec generator with ground-truth labels → `adversarial/generate.ts`
- T-AC-34-2 — run symspec over fixtures, score detection+localization, scoreboard (deps: 34-1, A–C)
- T-AC-34-3 — escalating-difficulty autonomous loop + gap report (deps: 34-2)

## Wave F — validate + compound

- full gate, per-tier end-to-end verification, adversarial run, regen AGENTS.md + docs, commit/push, extract lessons
