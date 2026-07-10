# symspec · Module map

`symspec` is a library-first EARS requirements engine; the CLI is a thin formatter over it. `src/index.ts` (156 LOC) is the public library entry point: it re-exports every subsystem grouped by `src/` directory, so a consumer can `import { applyChange, analyze, checkGtWRules } from 'symspec'` and reach the same functions the `dist/cli.mjs` binary invokes — nothing is CLI-only (`src/index.ts:1-19`). Its re-exports mirror the eight top-level module directories documented below.

## core

Owns the document model: schema, byte-stable JSON persistence, the sole mutation path, load-time validation, structural analysis, and SysML export.

- `schema.ts` — single source of truth for every Zod schema; atomic fields carry `.describe()` that flows into the manifest and generated agent docs (`src/core/schema.ts:1-19`). (572 LOC)
- `changes.ts` — `applyChange` is the ONLY sanctioned mutation; validates a Change against `ChangeSchema` and returns a new document, never mutating the input (`src/core/changes.ts:74`). (216 LOC)
- `codes.ts` — the closed, append-only `ERR_*` operational-error code enum plus a per-code `.describe()` corpus the manifest reads (`src/core/codes.ts:1-31`). (227 LOC)
- `storage.ts` — plain-JSON persistence with sorted keys and atomic temp-file+rename writes; a failed write throws typed `IoError`/`ERR_IO` (`src/core/storage.ts:1-21`). (146 LOC)
- `analyze.ts` — Tier-0 structural pass over a document snapshot: dangling refs, missing EARS slots, `derives` cycles, orphans (`src/core/analyze.ts:27`). (168 LOC)
- `load.ts` — the single funnel that validates on-disk bytes: `ERR_DOC_PARSE` vs forward-looking `ERR_SCHEMA_VERSION`, kept disjoint (`src/core/load.ts:1-27`). (109 LOC)
- `sysml-export.ts` — flavored SysML-v2 JSON export: each requirement → `RequirementUsage`, each edge → typed relationship (`src/core/sysml-export.ts:1-15`). (91 LOC)
- `doc.ts` — plain-object `Doc` facade over storage + changes; `emptyDoc`, no `merge()` (`src/core/doc.ts:1-12`). (72 LOC)
- `render.ts` — pure EARS sentence renderer from the 5 slots; `negated` flips the modal to `shall not` without editing stored text (`src/core/render.ts:1-31`). (55 LOC)

## parse

The NL parse ladder: Tier-1 regex cascade → Tier-2 wink-nlp repair → Tier-3 error envelope, plus batch, normalization, and the per-line result union.

- `tier2.ts` — Tier-2 POS-driven clause repair, lazily importing the ~4.5 MB wink-nlp model ONLY on an escalation trigger; loader is injectable for testing (`src/parse/tier2.ts:1-23`). (536 LOC)
- `tier1.ts` — zero-dependency Tier-1 cascade (complex → unwanted → event → state → optional → ubiquitous); order is load-bearing, a rung matches only when its main clause parses (`src/parse/tier1.ts:239`). (331 LOC)
- `tier3.ts` — Tier-3 "agent punt": typed `ERR_PARSE_*` envelope carrying partial slots and mechanical rewrite suggestions (`src/parse/tier3.ts:1-22`). (338 LOC)
- `result.ts` — the `ParseResult` discriminated union: `ok` / `skipped` (no-modal prose) / `error` (Tier-3) per line (`src/parse/result.ts:1-24`). (261 LOC)
- `normalize.ts` — event-synonym → `when` and non-`shall` modal → `shall` normalization with provenance notes and a `medium` confidence floor (`src/parse/normalize.ts:1-24`). (201 LOC)
- `batch.ts` — pure core of `parse --file`/`--stdin`: one `ParseResult` per line plus an `{ok, skipped, error}` summary; blanks and `#` comments dropped (`src/parse/batch.ts:1-23`). (164 LOC)
- `negation.ts` — modal-adjacent negation extraction (`not`/`never`/`not be able to`) as a polarity flag, keeping the positive response atom for atomization (`src/parse/negation.ts:1-13`). (109 LOC)
- `preprocess.ts` — strip leading REQ-IDs, ASCII-fold smart quotes, collapse whitespace, drop trailing punctuation before Tier-1 (`src/parse/preprocess.ts:1-13`). (35 LOC)
- `index.ts` — barrel re-exporting the ladder (`classifyTier1`, `KW`, `MAIN`, `preprocess`) (`src/parse/index.ts:1-8`). (42 LOC)

## lint

INCOSE Guide to Writing Requirements (GtWR) v4 lint layer — the free-tier surface checks feeding the exclusion gate.

- `gtwr.ts` — 24 T1 (regex/lexicon) GtWR rules, each a stable `GTWR_Rn` code with severity/span/suggestions; `checkGtWRules` per-statement (`src/lint/gtwr.ts:74`) and `checkGtWRulesSet` set-level (`src/lint/gtwr.ts:833`). (885 LOC)
- `codes.ts` — the closed, append-only `GtwrCodeSchema` enum (71 members) with a per-code `.describe()` corpus the manifest reads (`src/lint/codes.ts:1-16`). (147 LOC)

## formal

The SMT-backed formal tier — atomization, guarded-implication encoding, Z3 backends, and the detector suite whose soundness is "modulo atomization."

- `contradiction.ts` — per-context-group contradiction detection asserting shared context reachable, avoiding both the `X=false` false-negative and the all-triggers-true false-positive (`src/formal/contradiction.ts:1-16`). (327 LOC)
- `binary-backend.ts` — optional external z3/cvc5 cross-check over the emitted `.smt2`; discovery order `--solver-path` → `SYMSPEC_Z3` → PATH (`src/formal/binary-backend.ts:1-16`). (275 LOC)
- `needs-review.ts` — per-group `unknown`/timeout → info `FND_NEEDS_REVIEW` (run continues); whole-run budget → `ERR_SOLVER_TIMEOUT` (`src/formal/needs-review.ts:1-16`). (261 LOC)
- `encode.ts` — guarded-implication encoder `REQ-i ⇒ (context ⇒ response)` with per-req assumption literals for named unsat cores (`src/formal/encode.ts:1-14`). (251 LOC)
- `embed.ts` — local `Xenova/bge-base-en-v1.5` sentence embeddings on the ONNX WASM runtime with CLS pooling + L2 norm; the PROPOSE half of the semantic tier (`src/formal/embed.ts:1-13`). (240 LOC)
- `model-cache.ts` — fetches the ~110 MB `.onnx` weights + tokenizer on first use into an OS cache dir, verifies each against a pinned sha256 (`src/formal/model-cache.ts:1-13`). (237 LOC)
- `incomplete.ts` — completeness heuristic: SAT of `¬(C1 ∨ … ∨ Cn)` per same-trigger family → info `FND_INCOMPLETE`; a lint hint, not a proof (`src/formal/incomplete.ts:1-14`). (207 LOC)
- `codes.ts` — the closed, append-only `FND_*` finding-code enum spanning all four tiers (`src/formal/codes.ts:1-14`). (184 LOC)
- `finding.ts` — pure `evidence`-field enrichment layer mapping a detector's requirement ids to the audited atom table (`src/formal/finding.ts:1-16`). (171 LOC)
- `atomize.ts` — the load-bearing pure text→Boolean-atom function; every formal finding is only as sound as this (`src/formal/atomize.ts:1-13`). (165 LOC)
- `subsumption.ts` — per-pair `FND_SUBSUMPTION` (one direction valid) / `FND_REDUNDANCY` (both) over pairwise candidates (`src/formal/subsumption.ts:1-14`). (164 LOC)
- `emit-smt2.ts` — portable SMT-LIB2 emitter: `(set-logic ALL)`, never a solver-specific option baked into the prelude (`src/formal/emit-smt2.ts:1-16`). (161 LOC)
- `antonyms.ts` — curated 15-pair seed antonym table unifying polar-opposite verbs onto one atom with opposite polarity; grows only by explicit edit (`src/formal/antonyms.ts:40`). (137 LOC)
- `semantic.ts` — paraphrase finder: cosine ≥ threshold → info `FND_SIMILAR_SEMANTIC` suggesting a `glossary add` merge; never a verdict (`src/formal/semantic.ts:1-13`). (132 LOC)
- `similar.ts` — `FND_SIMILAR_UNUNIFIED` review prompt for near-synonyms outside the seed table (`src/formal/similar.ts:1-13`). (132 LOC)
- `vacuity.ts` — relational vacuity: guard unsatisfiable given the rest of the spec = dead requirement; explicitly not "guard is unsat" (`src/formal/vacuity.ts:1-14`). (118 LOC)
- `backend.ts` — in-process WASM Z3 backend; memoizes the ~110 ms one-time `init()` and hands back a fresh named `Context` per session (`src/formal/backend.ts:1-15`). (79 LOC)

## certify

Optional Lean 4 certification tier — toolchain discovery, batched `.lean` emission, and `lean --json` invocation.

- `run.ts` — spawns `lean --json` and parses NDJSON diagnostics into a certified/failed verdict; `parseLeanNdjson` at `src/certify/run.ts:76`, `certify` orchestrator at `src/certify/run.ts:305`. (347 LOC)
- `emit.ts` — emits ONE self-contained `.lean` file batching every theorem so the ~0.4s Lean startup cost is paid once; minimal core-Lean imports, no Mathlib (`src/certify/emit.ts:1-13`). (133 LOC)
- `discover.ts` — probes for a `lean` executable via `--version`, surfacing `ERR_LEAN_TOOLCHAIN_MISSING` early rather than a cryptic downstream spawn error (`src/certify/discover.ts:1-12`). (123 LOC)

## solvers

Two-tier solver orchestrator: an always-on free tier and an opt-in injected formal tier.

- `pairwise-filter.ts` — cheap O(n²) candidate generator for the pairwise subsumption/redundancy checks; does NOT gate contradiction/vacuity, and feeds `FND_SIMILAR_UNUNIFIED` via Jaccard (`src/solvers/free/pairwise-filter.ts:1-13`). (134 LOC)
- `ambiguity.ts` — lexical scan for weasel words/vague quantifiers, curated short and high-precision from INCOSE/IEEE 830/ISO 29148 (`src/solvers/free/ambiguity.ts:1-13`). (122 LOC)
- `types.ts` — shared solver types drawing the free (deterministic, microseconds) vs formal (Z3 proof) tier boundary (`src/solvers/types.ts:1-12`). (114 LOC)
- `index.ts` — orchestrator running the free tier always and the formal tier only when a `FormalTier` runner is injected via `opts.formal` (`src/solvers/index.ts:1-13`). (100 LOC)
- `duplicates.ts` — exact structural duplicates keyed on the full slot tuple incl. `negated`, so `shall X` / `shall not X` never collapse (`src/solvers/free/duplicates.ts:1-11`). (50 LOC)

## pipeline

Wires all tiers into one report and enforces the forced parse → lint → symbolize → solve order.

- `check.ts` — the default `check` pipeline joining Tier-0 structural, free+GtWR lint, and formal findings; `runCheck` is the entry (`src/pipeline/check.ts:293`). (421 LOC)
- `gate.ts` — the exclusion gate (AC-3-7): marks parse-failed or `error`-severity statements as excluded from symbolization so the SMT layer never gets unsound input (`src/pipeline/gate.ts:1-13`). (132 LOC)

## cli

The thin agent-facing formatter: every command resolves a doc path, loads+validates, runs a pure core, saves on mutation, and emits a typed envelope.

- `index.ts` — Commander command registration; all commands share one spine (`manifest`/`init`/`add`/`update`/`parse`/`check`/`certify`/`list`/`show`/`derive`) (`src/cli/index.ts:157-514`). (871 LOC)
- `manifest.ts` — the self-describing JSON blob an agent fetches once; every arg schema derived by `z.toJSONSchema` over the runtime Zod fields, never a hand-list (`src/cli/manifest.ts:1-10`). (415 LOC)
- `dense.ts` — `--dense` lossless-modulo-defaults projection of the AC-6-2 envelope with three pinned reductions (`src/cli/dense.ts:1-10`). (370 LOC)
- `add.ts` — the `add` core: auto-mints a UUID and accepts either structured slots or a prose line through the Tier-1..3 ladder (`src/cli/add.ts:1-11`). (222 LOC)
- `envelope.ts` — the typed `{apiVersion, type, data}` success / `{…, error, code, suggestions, partial?}` failure wrappers sharing one discriminant (`src/cli/envelope.ts:1-10`). (203 LOC)
- `output.ts` — JSON envelope is the zero-flag default; prose rendering is opt-in via `--pretty`/`--human` (`src/cli/output.ts:1-10`). (192 LOC)
- `errors.ts` — maps every invalid/missing argument to the `ERR_*` catalog (e.g. `ERR_USAGE`) instead of a stack trace (`src/cli/errors.ts:1-11`). (194 LOC)
- `descriptions.ts` — the single what/when/returns command-prose map read by both Commander `.description()` and the manifest `summary` (`src/cli/descriptions.ts:1-10`). (185 LOC)
- `resolve-doc.ts` — the one document-path resolver: positional `<file>` → `SYMSPEC_DOC` → `./requirements.json` (`src/cli/resolve-doc.ts:1-10`). (183 LOC)
- `update.ts` — two explicit surfaces: `update <id> <attr> <value>` (SET) vs `update --clear <id> <attr>` (CLEAR), no stringly-typed nulls (`src/cli/update.ts:1-11`). (173 LOC)
- `exit.ts` — pure `Envelope` → POSIX exit-code mapping for the `check` edit/CI loop (`src/cli/exit.ts:1-10`). (157 LOC)
- `scope-text.ts` — single source of the formal tier's honest-scope disclosure surfaced in manifest and finding output (`src/cli/scope-text.ts:1-10`). (146 LOC)
- `backends.ts` — `manifest` backends-availability report so an agent can query-then-decide before invoking a solver (`src/cli/backends.ts:1-10`). (132 LOC)
- `glossary.ts` — the `glossary` command core: manages committed synonym groups (the DECIDE half of the semantic tier) (`src/cli/glossary.ts:1-11`). (107 LOC)
- `types-enum.ts` — the closed, append-only enum of envelope `type` discriminants (`src/cli/types-enum.ts:1-11`). (96 LOC)
- `version.ts` — single-source version re-exported from `package.json` for `--version` and the manifest (`src/cli/version.ts:1-9`). (37 LOC)


## See also

- [symspec · Public API](../reference/public-api.md) — 25 shared source citations
- [symspec · Debugging guide](../insights/debugging-guide.md) — 16 shared source citations
- [symspec · Processes](../behavior/processes.md) — 16 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 15 shared source citations
- [symspec · Business logic](../insights/business-logic.md) — 12 shared source citations
