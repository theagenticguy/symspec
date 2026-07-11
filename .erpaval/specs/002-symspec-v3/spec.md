# symspec v3 — EARS specification

Closes the four honest-scope limits the v2 disclosure lists (`src/cli/scope-text.ts`):
numeric/arithmetic reasoning, contextual-ambiguity checking, temporal/ordering
logic, and the propositional-snapshot ceiling — plus a generative-adversarial
harness that proves detection under increasing difficulty.

## The governing invariant (applies to every AC below)

**Propose/decide determinism split.** A finding may carry a verdict-eligible
severity (`error`/`warn`, entering the byte-reproducibility contract) ONLY if it
recomputes bit-identically from `(doc + committed glossary + pinned model/tagger)`.
Every fuzzy or LLM-derived signal emits `severity: 'info'` and proposes a next
action; it never decides a verdict and never enters the reproducibility hash.
This is the v2 embeddings-propose/glossary-decide lesson generalized
(`.erpaval/solutions/architecture/embeddings-propose-smt-decide.md`).

Grounding for the design decisions below lives in this session's three research
briefs (temporal/numeric SOTA; ambiguity-detection SOTA; embedding-graph + DAG
SOTA), summarized inline where an AC cites a source.

---

## Increment v3.0 — Numeric / arithmetic conflict tier (deterministic)

Highest value-to-risk: LIA/LRA is already supported by the bundled `z3-solver`
WASM, decidable, convex, and deterministic. Extends the existing propositional
flow rather than replacing it.

**AC-30-1 [P]** — Ubiquitous: symspec shall extend the `Formula` AST
(`src/formal/encode.ts`) with an arithmetic-comparison node
`{ op: 'cmp'; quantity: string; comparator: '<'|'<='|'='|'>='|'>'|'!='; value: number }`
and a numeric-atom variant, keeping the AST Z3-free and synchronously testable.
`materialize` gains a `cmp` case lowering to a `z3-solver` `Int`/`Real`
comparison over a per-quantity variable. Verification: unit (encode a `cmp`
formula; materialize into a Z3 arithmetic expr; pure/no-solver in encode).

**AC-30-2 [P]** — Ubiquitous: symspec shall provide a numeric-predicate
extractor that recognizes `(quantity, comparator, value, unit)` tuples in EARS
slot text (e.g. "within 200 ms" → `latency <= 200 ms`; "at most 3 retries" →
`retries <= 3`; "temperature above 40" → `temperature > 40`). It normalizes
units to a canonical base per dimension (ms/s → ms, °C/°F → °C, etc.) and
resolves quantity-identity so two requirements about the same quantity share one
variable. Extraction is regex/lexicon-first (deterministic), returns `[]` when no
numeric predicate is present, and never guesses. Verification: unit (a table of
phrasings → expected tuples; unit conversion; quantity-identity collisions;
no-numeric → empty).

**AC-30-3** — Event-driven: When `check` runs and two or more requirements under
the same system assert numeric predicates over the SAME quantity that are jointly
unsatisfiable (e.g. `temp >= 40` and `temp < 30`), symspec shall emit
`FND_NUMERIC_CONTRADICTION` (error) naming exactly the culprit requirement ids
via the Z3 unsat core, with evidence carrying the arithmetic-atom table (quantity,
normalized comparator, value, unit, source requirement). Depends on AC-30-1,
AC-30-2. Verification: pipeline (contradictory numeric pair → FND with both ids +
evidence; satisfiable pair → no finding; mixed units normalized before compare).

**AC-30-4 [P]** — Ubiquitous: `FND_NUMERIC_CONTRADICTION` shall be appended to
the closed `FndCodeSchema` enum (`src/formal/codes.ts`) with a per-code
`.describe()`, so the manifest code table and AGENTS.md derive it automatically
(no drift). Verification: manifest snapshot + AGENTS.md drift gate green.

**AC-30-5** — Ubiquitous: the honest-scope disclosure (`src/cli/scope-text.ts`)
shall be updated to state that numeric conflict detection is now performed over
linear integer/real arithmetic (LIA/LRA), and that nonlinear-integer arithmetic
remains out of scope (undecidable). Verification: scope snapshot test updated;
manifest `scope` reflects it.

---

## Increment v3.1 — Ambiguity finding family (three sub-tiers by determinism)

"Flagging ambiguity is the whole point." One always-on `Ambiguity` family;
verdict-eligible only for the mechanically deterministic subset. Grounded in
Berry & Kamsties taxonomy, SREE recall-first stance, Chantree nocuous/innocuous,
Ezzini anaphora detection.

**AC-31-1 [P]** — Ubiquitous: symspec shall formalize the existing lexical
weasel/vagueness scan (`src/solvers/free/ambiguity.ts`) as
`FND_AMBIGUOUS_VAGUE` (info by default; kept short + high-precision to avoid
false-positive fatigue), carrying the offending span + phrase as evidence.
Verification: unit (known vague terms flagged; clean text silent; span correct).

**AC-31-2 [P]** — Ubiquitous: symspec shall detect quantifier/scope ambiguity
deterministically — bare-plural subject of a `shall`, leading "all/each/every",
and un-parenthesized `and … or` coordination — as `FND_AMBIGUOUS_QUANTIFIER`.
The mechanical `and…or`-without-grouping case may be `warn` (verdict-eligible);
softer cases are `info`. Verification: unit (each pattern; parenthesized `and/or`
not flagged; severity per case).

**AC-31-3 [P]** — Ubiquitous: symspec shall detect referential/anaphoric
ambiguity deterministically — a pronoun ("it", "this", "they") or bare definite
NP ("the system" when >1 system is in scope) with ≥2 candidate antecedents —
as `FND_AMBIGUOUS_REFERENCE` (always info; detection is recall-first per Ezzini,
resolution is punted). Evidence lists the candidate antecedents. Verification:
unit (≥2 antecedents → flag with candidates; single antecedent → silent).

**AC-31-4** — Event-driven: When `check --semantic` runs, symspec shall emit the
DUAL of the existing synonym bridge — `FND_TERM_INCONSISTENT` (info): a term used
in embedding-distant contexts (homonym drift) proposes a disambiguation/split.
Reuses the pinned embedding model; deterministic scores, propose-only effect.
Depends on the v2 embed tier. Verification: unit with injected fake embedder
(distant-context term → proposal; consistent term → silent).

**AC-31-5 [P]** — Ubiquitous: symspec shall replace the SILENT contextual-
ambiguity punt with a STRUCTURED one — `FND_AMBIGUITY_NEEDS_JUDGMENT` (info,
mirroring `FND_NEEDS_REVIEW`) that names the requirement and states pragmatic
ambiguity was not assessed deterministically, suggesting an LLM/agent review.
Any opt-in LLM ambiguity pass emits info-only findings tagged `source: 'llm'`,
explicitly excluded from the reproducibility contract (temp-0 LLMs are not
byte-reproducible). Verification: unit (finding shape + severity + exclusion
tag); scope-text updated so "contextual ambiguity is not checked" becomes "is
surfaced for review, not decided".

**AC-31-6 [P]** — Ubiquitous: all new `FND_AMBIGUOUS_*` / `FND_TERM_INCONSISTENT`
/ `FND_AMBIGUITY_NEEDS_JUDGMENT` codes shall append to `FndCodeSchema` with
`.describe()` metadata and `suggestions[]`, so an agent switches on the code.
Verification: manifest + AGENTS.md drift gate green.

---

## Increment v3.2 — Embedding similarity graph + requirement DAG invariants

The "hard non-negotiable": embedding + pairwise + DAG becomes core, as a
DETERMINISTIC proposal engine. CPU/ONNX-WASM is what makes an always-on graph
byte-reproducible (GPU embeddings are not). Grounded in trace-link-recovery
literature (must be human-confirmed) + KAOS/SysML DAG invariants.

**AC-32-1 [P]** — Ubiquitous: symspec shall build a deterministic k-nearest-
neighbor similarity graph over requirement embeddings: fixed batch size = 1
(kills batch-invariance FP nondeterminism), cosine quantized to a fixed decimal
precision before threshold comparison, ties broken by requirement id. Pure given
`(doc + pinned model)`. Verification: unit with injected embedder (kNN edges
stable; quantization prevents ULP flip; deterministic tie-break).

**AC-32-2** — Event-driven: When the similarity graph is built, symspec shall run
seeded community detection (pinned seed + id-ordered iteration) and emit info-tier
findings: near-duplicate candidates (feeds the existing glossary-merge flow),
coverage-gap singletons, and incoherent-cluster warnings. Depends on AC-32-1.
Verification: unit (clusters deterministic across two runs; singleton flagged).

**AC-32-3 [P]** — Ubiquitous: symspec shall extend the structural DAG analyzer
(`src/core/analyze.ts`) with two verdict-tier invariants from the KAOS/SysML
canon: leaf-must-be-verifiable (`FND_LEAF_UNVERIFIABLE` — a `refines`/`derives`
sink with no `verifies` edge and no testable EARS obligation) and refinement
acyclicity already covered by cycle detection. Pure graph algorithms, fully
deterministic. Verification: unit (unverifiable leaf → finding; verifiable leaf →
silent).

**AC-32-4** — Event-driven: When both the similarity graph and the committed DAG
exist, symspec shall emit `FND_MISSING_TRACE_LINK` (info) for any requirement pair
with quantized cosine ≥ threshold but NO committed `refines`/`derives`/`satisfies`
edge — the trace-link-recovery task restricted to unlinked pairs, kept info-tier
because reported TLR precision is too low to auto-commit. Depends on AC-32-1.
Verification: unit with injected embedder (high-cosine unlinked pair → proposal;
linked pair → silent; low-cosine → silent).

**AC-32-5 [P]** — Ubiquitous: symspec shall pin the graph determinism parameters
(model hash, quantization precision, threshold, k, community seed, tokenizer
version) and ship a CI reproducibility test asserting byte-identical graph output
across two runs. Verification: the reproducibility test itself, green.

---

## Increment v3.3 — Bounded temporal LTL/MLTL → SMT (feasibility-gated)

Deepest R&D. Adopt Dwyer SPS + FRET EARS-slot→pmLTL mappings; discharge bounded
satisfiability on the in-process Z3-WASM. Unbounded checking goes behind an
optional external backend, mirroring the existing z3/cvc5 binary path.

**AC-33-0** — Ubiquitous (GATE): before any temporal encoding is committed,
symspec shall include a Z3-WASM bounded-LTL feasibility benchmark demonstrating a
representative bounded encoding solves within acceptable latency in-process. If
infeasible in-process, the temporal tier ships external-backend-only. Verification:
the benchmark script + a recorded latency figure.

**AC-33-1 [P]** — Ubiquitous: symspec shall map EARS patterns to Dwyer/SPS
patterns per FRET semantics — event-driven → Response `G(trig → F resp)`;
unwanted-behavior → Absence `G(cond → ¬resp)`; state-driven → Universality within
scope; ubiquitous → `G(resp)` — as a pure, documented, unit-tested mapping.
Verification: unit (each EARS pattern → expected temporal pattern shape).

**AC-33-2** — Event-driven: When `check --temporal` is passed (opt-in), symspec
shall encode the conjunction of requirement temporal formulas as a bounded-trace
SMT problem (bound k), discharge it on Z3-WASM, and emit
`FND_TEMPORAL_CONTRADICTION` (error) on a sound UNSAT with unsat core. The
envelope reports `{ bound: k, complete: bool }`; SAT-at-k is NOT a consistency
certificate (same honest-limit framing as the SMT tier). Depends on AC-33-0,
AC-33-1. Verification: pipeline (a temporally-contradictory pair → FND at some
bound; consistent pair → SAT with complete/bound reported).

**AC-33-3 [P]** — Ubiquitous: symspec shall add an optional `temporal-backend`
entry to the manifest `backends` report (`available: false` unless an external
LTL checker is discovered on PATH), used only when the user opts into unbounded
cross-check. Mirrors the z3/cvc5 binary-backend pattern. Verification: backends
report includes the entry; absent binary → available:false, never blocks.

---

## Increment v3.4 — Generative-adversarial detection harness

After v3.2 (numeric + ambiguity + graph all shipping), a self-scoring loop that
proves symspec catches increasingly subtle bad specs.

**AC-34-1 [P]** — Ubiquitous: symspec shall provide an adversarial generator (a
subagent-driven harness under `adversarial/` or `scripts/`) that emits BAD specs
across every tier — numeric contradictions, temporal ordering conflicts, ambiguous
phrasings, missing-link/DAG defects — each with a ground-truth label of the defect
kind and the requirement ids that should be flagged. Verification: the generator
produces labeled fixtures; each fixture is a valid symspec document.

**AC-34-2** — Event-driven: When the harness runs, symspec shall be executed over
each generated bad spec and scored on detection (did the right FND fire?) and
localization (did it name the right ids?), producing a per-difficulty-tier
scoreboard (precision/recall). Depends on AC-34-1 and the v3.0–v3.2 tiers.
Verification: the harness run emits a scoreboard; a regression floor is asserted
(known defects must stay caught).

**AC-34-3** — Event-driven: When the generator escalates difficulty (harder-to-
find defects each round) until a detection miss or a round budget, symspec shall
record which defect classes evade detection as a durable gap report — feeding the
next round of tier improvements. Autonomous: escalate → detect → score → record,
no human in the loop per round. Depends on AC-34-2. Verification: multi-round run
produces a gap report; misses are logged, not silently dropped.

---

## Out of scope for v3 (preserved honest limits)

- Full MTL (undecidable), STL / dense-signal logics, nonlinear-integer arithmetic
  (undecidable) — excluded to keep the core decidable + deterministic.
- LLM ambiguity judgments never gate a verdict or enter the reproducibility hash.
- Unbounded temporal satisfiability / realizability (nuXmv/Spot/Kind 2) — no
  npm/WASM path; optional external backend only.
