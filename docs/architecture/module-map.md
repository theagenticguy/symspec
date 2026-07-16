# symspec · Module map

`symspec` is a library-first EARS requirements engine; the CLI is a thin formatter over it. `src/index.ts` is the public library entry point: it re-exports every subsystem grouped by `src/` directory, so a consumer can `import { applyChange, analyze, checkGtWRules } from 'symspec'` and reach the same functions the `dist/cli.mjs` binary invokes — nothing is CLI-only (`src/index.ts:1-11`). Its re-exports mirror the top-level module directories documented below, and CLI-contract types (`API_VERSION`, envelopes, `buildManifest`) re-export at `src/index.ts:58-71`.

## core

Owns the document model: schema, byte-stable JSON persistence, the sole mutation path, load-time validation, structural analysis, and SysML export.

- `schema.ts` — single source of truth for every Zod schema; `SCHEMA_VERSION=2`, the `Finding` union carries 6 structural kinds incl. `LeafUnverifiable` (`src/core/schema.ts:721,679`). (~720 LOC)
- `analyze.ts` — Tier-0 structural pass: dangling refs, missing EARS slots, `derives` cycles, orphans, leaf-unverifiable (`src/core/analyze.ts:27`, `summarizeFindings` `:201`). (~200 LOC)
- `changes.ts` — `applyChange` is the ONLY sanctioned mutation; validates against `ChangeSchema` and returns a new document, never mutating the input (`src/core/changes.ts:74`, `applyChanges` `:217`). (~230 LOC)
- `codes.ts` — the closed, append-only `ERR_*` operational-error enum plus a per-code `.describe()` corpus the manifest reads (`errCodeCatalog` `src/core/codes.ts:234`). (~230 LOC)
- `storage.ts` — plain-JSON persistence with sorted keys and atomic temp-file+rename writes; a failed write throws typed `IoError`/`ERR_IO` (`atomicWriteFile` `src/core/storage.ts:109`). (~150 LOC)
- `load.ts` — the single funnel validating on-disk bytes: `ERR_DOC_PARSE` vs forward-looking `ERR_SCHEMA_VERSION`, kept disjoint (`parseRequirementsDoc` `src/core/load.ts:61`, `loadRequirementsDoc` `:106`). (~120 LOC)
- `sysml-export.ts` — SysML-v2 JSON export: each requirement → `RequirementUsage`, each edge → typed relationship (`src/core/sysml-export.ts:49`). (~90 LOC)
- `doc.ts` — plain-object `Doc` facade over storage + changes; `emptyDoc`/`loadDoc`/`saveDoc`/`newId` (`src/core/doc.ts:28,41,49,54`). (~70 LOC)
- `render.ts` — pure EARS sentence renderer from the 5 slots; `negated` flips the modal to `shall not` without editing stored text (`src/core/render.ts:33`). (~55 LOC)

## parse

The NL parse ladder: Tier-1 regex cascade → Tier-2 wink-nlp repair → Tier-3 error envelope, plus batch, normalization, and the per-line result union.

- `tier2.ts` — Tier-2 POS-driven clause repair, lazily importing the wink-nlp model ONLY on an escalation trigger; loader injectable for testing (`runTier2` `src/parse/tier2.ts:652`). (~660 LOC)
- `tier3.ts` — Tier-3 "agent punt": typed `ERR_PARSE_*` envelope carrying partial slots and mechanical rewrite suggestions (`makeTier3Envelope` `src/parse/tier3.ts:283`, `PARSE_ERROR_CODES` `:67`). (~340 LOC)
- `tier1.ts` — zero-dependency Tier-1 cascade; order is load-bearing, a rung matches only when its main clause parses (`classifyTier1` `src/parse/tier1.ts:239`, `MAIN` regex `:111`). (~330 LOC)
- `result.ts` — the `ParseResult` discriminated union: `ok` / `skipped` / `error` per line (`parseLine` `src/parse/result.ts:258`, `ParseResultSchema` `:129`). (~260 LOC)
- `normalize.ts` — event-synonym → `when` and non-`shall` modal → `shall` normalization with provenance notes (`normalizeEventKeyword` `src/parse/normalize.ts:142`, `CANONICAL_MODAL` `:85`). (~200 LOC)
- `batch.ts` — pure core of `parse --file`/`--stdin`: one `ParseResult` per line plus an `{ok, skipped, error}` summary (`parseBatch` `src/parse/batch.ts:157`). (~165 LOC)
- `negation.ts` — modal-adjacent negation extraction (`not`/`never`/`not be able to`) as a polarity flag (`extractNegation` `src/parse/negation.ts:100`, `NEGATORS` `:33`). (~110 LOC)
- `preprocess.ts` — strip leading REQ-IDs, ASCII-fold smart quotes, collapse whitespace before Tier-1 (`preprocess` `src/parse/preprocess.ts:27`). (~35 LOC)

## lint

INCOSE Guide to Writing Requirements (GtWR) lint layer — the free-tier surface checks feeding the exclusion gate.

- `gtwr.ts` — 24 T1 (regex/lexicon) GtWR rules, each a stable `R<n>_*` code with severity/span/suggestions; `checkGtWRules` per-statement (`src/lint/gtwr.ts:285`) and `checkGtWRulesSet` set-level (`src/lint/gtwr.ts:1056`). R6 (units) was rewritten to broaden recognized units (mass/volume/rate/distance/currency/calendar) with a `[0,1]` ratio escape, exporting `R6_RECOGNIZED_UNITS`/`R6_MULTIWORD_UNITS`/`R6_SYMBOL_UNITS` for the manifest (`src/lint/gtwr.ts:116,212,224`). (~1108 LOC)
- `codes.ts` — the closed, append-only `GtwrCodeSchema` enum with a per-code `.describe()` corpus the manifest reads (`src/lint/codes.ts:33-64`). (~147 LOC)

## formal

The SMT + neural tiers: atomization, guarded-implication encoding, Z3 backends, the propositional detector suite, plus the numeric, temporal, ambiguity, and embedding-graph tiers, the two issue-#2 propose-only blind-spot detectors, and the coverage disclosures. Every fuzzy component here is PROPOSE-only; only a z3 UNSAT result DECIDEs.

- `contradiction.ts` — per-context-group contradiction detection with deletion-based minimal unsat core (`findContradictions` `src/formal/contradiction.ts:230`, `planContextGroups` `:141`, `minimizeCore` `:190`). (~345 LOC)
- `binary-backend.ts` — optional external z3/cvc5 cross-check; discovery `--solver-path` → `SYMSPEC_Z3` env → PATH (`discoverSolverBinary` `src/formal/binary-backend.ts:151`, `runSolverBinary` `:248`). (~275 LOC)
- `needs-review.ts` — per-group `unknown`/timeout → info `FND_NEEDS_REVIEW`; whole-run budget → `ERR_SOLVER_TIMEOUT` (`findNeedsReview` `src/formal/needs-review.ts:218`, `SolverBudgetExceededError` `:78`). (~261 LOC)
- `numeric.ts` — NUMERIC tier: lifts `(quantity, comparator, value, unit)` predicates, unit-normalized (s→ms, kb→B) with per-system quantity keys; exports the `DIMENSIONS` table + `Dimension` type for the manifest, and deliberately does NOT strip comparator words from the quantity KEY (soundness) (`extractNumericPredicates` `src/formal/numeric.ts:240`, `NumericPredicate` `:34`, `DIMENSIONS` `:64`). (~316 LOC)
- `numeric-contradiction.ts` — proves same-quantity predicate sets jointly unsatisfiable over LIA/LRA via Z3; unsat core names the culprits → `FND_NUMERIC_CONTRADICTION`, error (`findNumericContradictions` `src/formal/numeric-contradiction.ts:55`). Runs over ALL requirements. (~160 LOC)
- `quantity-alias.ts` — NEW (issue #2 reproducer a): propose-only `findQuantityAliasCandidates`. One physical quantity described with two verbs splits into two quantity keys, so a `≤30 ∧ ≥60` conflict is never compared. Fires only on same-system + same-trigger + shared object suffix + differing leading verb + directionally opposed comparators + comparable unit, emitting `FND_QUANTITY_ALIAS_CANDIDATE` with a ready-to-run `symspec glossary add` command that DEMOTES `verified`; committing the alias routes both labels to one key so the LIA tier proves the real conflict (`findQuantityAliasCandidates` `src/formal/quantity-alias.ts:160`, `sharedObjectSuffix` `:132`, `opposed` `:114`). (~220 LOC)
- `relational.ts` — NEW (issue #2 reproducer b + aggregate/relational families): `findRelationalUnchecked` + `hasRelationalLanguage`. Detects the STRUCTURAL SHAPE of aggregate/conservation, cross-quantity, and emergent-structural (odd-cycle 2-coloring, pigeonhole) impossibilities the pairwise same-quantity numeric tier cannot see; emits `FND_RELATIONAL_UNCHECKED` with an honest "reasoning not attempted" caveat that DEMOTES `verified` and never asserts a conflict (`findRelationalUnchecked` `src/formal/relational.ts:100`, `hasRelationalLanguage` `:85`). (~134 LOC)
- `coverage.ts` — NEW: the loud coverage disclosures the pipeline pushes into `findings[]` — `noPairsCheckedFinding` (`FND_NO_PAIRS_CHECKED`), `excludedFromFormalFinding` (`FND_EXCLUDED_FROM_FORMAL`), `relationalUncheckedFinding` (`FND_RELATIONAL_UNCHECKED`); each info-severity but each DEMOTES `verified` so silence is never read as a consistency certificate (`src/formal/coverage.ts:33,59,93`). (~108 LOC)
- `lemma.ts` — NEW: closed, vendored English verb de-inflection for the LEADING response verb only (never the remainder). `deInflectHead` maps one lowercase token to its base form via a curated WordNet-derived irregular table then closed 3sg rules; pure, total, idempotent, so atomization stays bit-identical (`deInflectHead` `src/formal/lemma.ts:186`, `IRREGULAR_VERB_LEMMAS` `:42`). (~195 LOC)
- `graph.ts` — EMBEDDING graph (opt-in `--semantic`): deterministic kNN similarity graph → info-only `FND_MISSING_TRACE_LINK` + `FND_DUPLICATE_CLUSTER`; quantized cosine, union-find, id tiebreak. The trace-link proposal is trace-gated — it fires only when the doc already uses ≥1 committed trace link, so a doc with zero trace edges gets no `FND_MISSING_TRACE_LINK` spam; near-duplicate clusters are NOT gated (`buildSimilarityGraph` `src/formal/graph.ts:139`, trace-gate `:187`). (~286 LOC)
- `temporal.ts` — TEMPORAL tier (opt-in `--temporal`): bounded LTL→SMT unrolling on the shared Z3-WASM context; sound-for-UNSAT, not complete-for-SAT; evidence carries `{bound, complete:false}` (`findTemporalContradictions` `src/formal/temporal.ts:118`, `lowerAt` `:62`). (~224 LOC)
- `temporal-patterns.ts` — pure EARS→LTL mapper (Dwyer/SPS/FRET); temporal ctors `tAtom`/`tNot`/`tImplies`, modal `G`/`F`/`X`/`U` (`earsToTemporal` `src/formal/temporal-patterns.ts:168`). (~195 LOC)
- `emit-smt2.ts` — portable SMT-LIB2 emitter declaring `(set-logic ALL)`, never a solver-specific prelude option (`emitSmt2` `src/formal/emit-smt2.ts:132`). (~176 LOC)
- `atomize.ts` — the load-bearing pure text→Boolean-atom function; glossary-first canonicalization then antonym unification, with the leading response verb de-inflected via `lemma.ts` (`atomize` `src/formal/atomize.ts:227`, `normalize` `:146`, `glossaryIndex` `:122`, `deInflectHead` re-export `:62`). (~286 LOC)
- `encode.ts` — guarded-implication encoder `guard ⇒ (context ⇒ response)` with per-req assumption literals for named unsat cores (`encode` `src/formal/encode.ts:205`, `materialize` `:260`). (~251 LOC)
- `embed.ts` — local `Xenova/bge-base-en-v1.5` embeddings on ONNX-WASM + pure-JS tokenizer, CLS-pooled + L2-norm; the PROPOSE half of the semantic tier (`loadEmbedder` `src/formal/embed.ts:240`, `cosine` `:267`, `EMBED_MODEL` `:40`). (~240 LOC)
- `model-cache.ts` — fetches the `.onnx` weights + tokenizer into an OS cache dir, sha256-verifying each file (`downloadModelAssets` `src/formal/model-cache.ts:218`, `ensureModelAssets` `:177`). (~237 LOC)
- `ambiguity.ts` — AMBIGUITY family (deterministic, always-on): Berry & Kamsties taxonomy → `FND_AMBIGUOUS_*`/`FND_AMBIGUITY_NEEDS_JUDGMENT`; only mechanical `and…or` coordination is verdict-eligible `warn`, rest `info` (`detectAmbiguity` `src/formal/ambiguity.ts:442`, `AmbiguityCode` `:40`). (~460 LOC)
- `incomplete.ts` — completeness heuristic: SAT of `¬(C1 ∨ … ∨ Cn)` per same-trigger family → info `FND_INCOMPLETE` (`checkCompleteness` `src/formal/incomplete.ts:185`). (~207 LOC)
- `codes.ts` — the closed, append-only `FND_*` finding-code enum spanning every tier (now 30 codes, incl. the three issue-#2 additions `FND_EXCLUDED_FROM_FORMAL`/`FND_QUANTITY_ALIAS_CANDIDATE`/`FND_RELATIONAL_UNCHECKED`, all info-severity), with per-code `.describe()` and the structural/solver/certify bridges (`FndCodeSchema` `src/formal/codes.ts:54-121`, `structuralKindToFndCode` `:279`). (~300 LOC)
- `finding.ts` — pure `evidence`-field enrichment mapping detector requirement ids to the audited atom table (`attachEvidence` `src/formal/finding.ts:175`, `attachEvidenceToAll` `:193`). (~171 LOC)
- `subsumption.ts` — per-pair `FND_SUBSUMPTION` (one direction valid) / `FND_REDUNDANCY` (both) over pairwise candidates (`checkSubsumption` `src/formal/subsumption.ts:150`). (~164 LOC)
- `antonyms.ts` — curated seed antonym table (32 pairs) unifying polar-opposite verbs onto one atom with opposite polarity; `buildAntonymIndexWithDoc` folds in doc-committed pairs (`SEED_ANTONYM_PAIRS` `src/formal/antonyms.ts:67`, `ANTONYM_INDEX` `:181`). (~200 LOC)
- `semantic.ts` — paraphrase finder: cosine ≥ threshold (default 0.72, recall-favoring — `DEFAULT_SEMANTIC_THRESHOLD` `src/formal/semantic.ts:110`) → info `FND_SIMILAR_SEMANTIC` suggesting a `glossary add`; a same-trigger high-cosine pair also gets an inline `antonym add` hint (opposites embed close, so cosine cannot tell them from synonyms). `SemanticRequirement.trigger` is `string | undefined`. Also hosts `findOppositionCandidates` → `FND_OPPOSITION_CANDIDATE`; never a verdict (`findSimilarSemantic` `src/formal/semantic.ts:135`, `findOppositionCandidates` `:307`). (~391 LOC)
- `similar.ts` — `FND_SIMILAR_UNUNIFIED` review prompt for near-synonyms outside the seed table, via Jaccard (`findSimilarUnunified` `src/formal/similar.ts:86`). (~132 LOC)
- `vacuity.ts` — relational vacuity: guard unsatisfiable given the rest of the spec = dead requirement (`checkVacuity` `src/formal/vacuity.ts:108`). (~118 LOC)
- `backend.ts` — in-process WASM Z3 backend; memoizes the ~110 ms one-time `init()` and hands back a fresh named `Context` per session (`getContext` `src/formal/backend.ts:58`, `probeBackend` `:70`). (~79 LOC)

## solvers

Two-tier solver orchestrator: an always-on free tier and an opt-in injected formal tier.

- `index.ts` — orchestrator running the free tier always and the formal tier only when a `FormalTier` runner is injected via `opts.formal` (`runSolvers` `src/solvers/index.ts:68`, `summarize` `:92`). (~100 LOC)
- `types.ts` — shared solver types drawing the free vs formal boundary; `Confidence` → `SolverConfidence` at the barrel (`asView` `src/solvers/types.ts:101`, `SolverFinding` `:26`). (~114 LOC)
- `free/pairwise-filter.ts` — cheap lexical prefilter feeding pairwise subsumption; does NOT gate contradiction/vacuity (`emitCandidatePairs` `src/solvers/free/pairwise-filter.ts:69`). (~134 LOC)
- `free/ambiguity.ts` — free-tier weasel-word scan (distinct from `formal/ambiguity.ts`); superseded by GtWR in the pipeline (`detectAmbiguity` `src/solvers/free/ambiguity.ts:100`). (~122 LOC)
- `free/duplicates.ts` — exact structural duplicates keyed on the full slot tuple incl. `negated` → `FND_EXACT_DUPLICATE` (`detectExactDuplicates` `src/solvers/free/duplicates.ts:15`). (~50 LOC)

## pipeline

Wires all tiers into one report, enforces the forced parse → lint → symbolize → solve order, and computes the DEMOTION-ONLY verdict.

- `check.ts` — the default `check` pipeline joining structural, lint, always-on ambiguity, and the formal tiers, then computing `verified = demotions.length === 0` (`src/pipeline/check.ts:1289`). `runCheck` is the entry (`:678`); `encodeIncluded`/`toEncodable` build the gate-included encoding (`:590,570`; `CheckOptions` `:126`). Grown substantially for the issue-#2 hardening: it wires `findQuantityAliasCandidates` and `findRelationalUnchecked` (`:835,856`), emits the three coverage disclosures, and assembles the `CoverageReport` — `PROPOSE_ONLY_FND_CODES`/`COVERAGE_GAP_FND_CODES` sets (`:413,441`), the `CoverageDemotion.reason` union (`excluded-from-formal` / `quantity-alias-candidate` / `relational-reasoning-not-attempted` + the earlier four) (`:252`), and `CoverageReport.{encoded,excluded,pairsCheckedNote}` (`:291`). (~1350 LOC)
- `gate.ts` — the AC-3-7 exclusion gate, now WAIVER-AWARE: marks parse-failed (`'parse-failure'`) or `error`-severity (`'blocking-surface-check'`) statements as excluded from symbolization, but a committed waiver matching a blocking finding re-admits its requirement to the solver (`gate` `src/pipeline/gate.ts:134`, `gateRequirements` `:164`, `excludedIds` `:175`, `isWaivedBlocking` `:80`). (~177 LOC)

## certify

Optional Lean 4 certification tier — toolchain discovery, batched `.lean` emission, `lean --json` invocation. Never imported by the `check` path.

- `run.ts` — spawns `lean --json` and parses NDJSON diagnostics into a certified/failed verdict → `FND_CERTIFIED`/`FND_CERTIFY_FAILED` (`certify` `src/certify/run.ts:305`, `parseLeanNdjson` `:76`). (~347 LOC)
- `emit.ts` — emits ONE self-contained `.lean` file batching every theorem; minimal core-Lean imports, no Mathlib (`emitLeanFile` `src/certify/emit.ts:85`, `LEAN_TACTICS` `:27`). (~133 LOC)
- `discover.ts` — probes for a `lean` executable, surfacing `ERR_LEAN_TOOLCHAIN_MISSING` early (`discoverLeanToolchain` `src/certify/discover.ts:72`, `probeLeanToolchain` `:114`). (~123 LOC)

## cli

The thin agent-facing formatter: every command resolves a doc path, loads+validates, runs a pure core, saves on mutation, and emits a typed envelope.

- `index.ts` — Commander registration for the whole command tree: 20 top-level commands (`manifest`/`init`/`add`/`update`/`parse`/`check`/`certify`/`list`/`show`/`derive`/`satisfy`/`remove-edge`/`delete`/`export`/`download-model`/`apply`/`glossary`/`waive`/`antonym`/`install`) plus the sub-commands under `glossary`/`waive`/`antonym`. `check` carries `--similarity-threshold`/`--timeout-ms`/`--solver-budget-ms`/`--emit-smt2`/`--solver`/`--solver-path`/`--semantic`/`--semantic-threshold`/`--temporal`/`--temporal-bound`, and every command supports the new `--field` projection (`src/cli/index.ts:234-1078`). (~1347 LOC)
- `manifest.ts` — the self-describing JSON blob; every arg schema derived by `z.toJSONSchema` over the runtime Zod fields, and now exposing the numeric unit tables from `formal/numeric.ts` `DIMENSIONS` (`z.toJSONSchema` `src/cli/manifest.ts:593`, unit disclosure `:484-502`). (~657 LOC)
- `field.ts` — NEW: the `--field <paths>` jq-style OUTPUT projection. `projectFields` walks comma-separated dotted paths (numeric segments index arrays) and reassembles the found values into a nested object mirroring the request; unresolved paths are OMITTED (no `null`), never changing a command's data or exit code (`projectFields` `src/cli/field.ts:104`, `parseFieldPaths` `:30`, `resolvePath` `:48`). (~113 LOC)
- `dense.ts` — `--dense` lossless-modulo-defaults projection of the envelope (`src/cli/dense.ts:1-10`). (~370 LOC)
- `add.ts` — the `add` core: auto-mints a UUID, accepts structured slots or a prose line through the Tier-1..3 ladder (`src/cli/add.ts:1-11`). (~367 LOC)
- `envelope.ts` — the typed `{apiVersion, type, data}` success / `{…, error, code, suggestions}` failure wrappers; `API_VERSION = 1` (`src/cli/envelope.ts:69`). (~249 LOC)
- `errors.ts` — maps every invalid/missing argument to the `ERR_*` catalog (e.g. `ERR_USAGE`), naming the offending arg plus `--file`/`SYMSPEC_DOC` instead of a stack trace (`src/cli/errors.ts:1-11`). (~198 LOC)
- `output.ts` — JSON envelope is the zero-flag default; prose rendering opt-in via `--pretty`/`--human` (`src/cli/output.ts:1-10`). (~192 LOC)
- `glossary.ts` — the `glossary` command core: manages committed synonym groups (the DECIDE half of the semantic tier) (`src/cli/glossary.ts:1-11`). (~227 LOC)

## adversarial

Generative-adversarial detection harness plus the pinned regression fixtures from a real external red-team eval (an Opus 4.8 proposer against a blind judge panel with z3 as the oracle). The proposer beat an earlier symspec 25/30 under `--strict`, then 28/30 after the first hardening; issue #2 closed the remaining numeric-tier blind-spot escapes.

- `generate.ts` — `generateCases(tier, seed)` over `DEFECT_KINDS` with escalating difficulty (contradiction/numeric/temporal/ambiguity/missing-link generators), asserting symspec's verdict against z3 ground truth on the real embedding model (`adversarial/generate.ts:335`, `DEFECT_KINDS` `:323`, `DefectKind` `:28`). (~337 LOC)
- `harness.ts` — `runHarness` scores DETECTION + LOCALIZATION per labelled fixture, escalates tier-by-tier, emits a gap report (`adversarial/harness.ts:75`, `scoreCase` `:34`). (~161 LOC)
- `eval-rounds.ts` — `evalRoundCases()` pins the 12 winning rounds of the red-team eval as regression fixtures: proof cases assert `FND_CONTRADICTION`/`FND_NUMERIC_CONTRADICTION` fires and names the planted culprits; abstention cases assert the hardened `verified` DEMOTES with actionable coverage reasons rather than certifying a lie. The reproducer-a pair proves the full loop: abstain → commit the suggested glossary alias → z3 proves the conflict (`evalRoundCases` `adversarial/eval-rounds.ts:70`). Enforced by `adversarial/__tests__/eval-rounds.test.ts` (13 tests, all green). (~650 LOC)

## scripts

- `gen-agents.ts` — deterministic AGENTS.md generator from `buildManifest()`; `pnpm check:agents` guards staleness (`codeTable` `scripts/gen-agents.ts:25`, `commandTable` `:33`).
- `temporal-feasibility.ts` — v3.3 gate: Z3-WASM bounded-LTL feasibility benchmark printing FEASIBLE/INFEASIBLE (`runBoundedResponse` `scripts/temporal-feasibility.ts:45`, `main` `:79`). (~123 LOC)

## See also

- [Public API](../reference/public-api.md) — 31 shared source citations
- [Processes](../behavior/processes.md) — 28 shared source citations
- [Business logic](../insights/business-logic.md) — 20 shared source citations
- [Debugging guide](../insights/debugging-guide.md) — 20 shared source citations
- [Contract map](../insights/contract-map.md) — 19 shared source citations
