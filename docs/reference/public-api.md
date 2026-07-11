# symspec · Public API

symspec is a **library first, CLI second**. Every command in `src/cli/index.ts` is a thin formatter over functions re-exported from `src/index.ts`: `symspec add` calls `applyChange` + `writeDocFile`, `symspec check` calls `runCheck`, and so on. Nothing the CLI does is reachable only through a subprocess — any Node program can `import { runCheck, applyChange, analyze } from 'symspec'` and get the exact behavior the `dist/cli.mjs` binary invokes (`src/index.ts:1-11`).

```ts
import { runCheck, applyChange, analyze, loadRequirementsDoc } from 'symspec'
```

The package `exports` map points `.` at the build output (`dist/index.mjs` + `dist/index.d.ts`), so a workspace or published-package consumer resolves `symspec` as a library; `bin/symspec.mjs` remains the independent CLI entry (`src/index.ts:13-18`).

Re-exports are grouped by subsystem mirroring `src/`: `core/*`, `parse/*`, `lint/*`, `pipeline/*`, `certify/*`, `formal/*` + `solvers/*`, and the `cli/*` envelope/manifest contract (`src/index.ts:20-46`). Two same-named types are re-exported explicitly to avoid TS2308 ambiguity: `AtomKind` (declared independently in both `atomize.ts` and `encode.ts`, so each module's surface is re-exported by name — `src/index.ts:94-115`) and `solvers/types.ts`'s `Confidence`, renamed `SolverConfidence` at the barrel to disambiguate it from the parse ladder's `Confidence` (`src/index.ts:174-185`).

---

## core

The document schema, storage, load-time validation, the Change-record mutation path, structural analysis, and SysML export.

### RequirementsDoc

```ts
export type RequirementsDoc = {
  schemaVersion: number
  requirements: Record<string, Requirement>
  glossary: GlossaryEntry[]
}
```

The root in-memory / on-disk document: a schema-version tag, a flat UUID-keyed map of requirement nodes, and an optional synonym glossary. `src/core/schema.ts:566`. Current schema is `export const SCHEMA_VERSION = 2` (`src/core/schema.ts:573`).

### RequirementsDocSchema

```ts
export const RequirementsDocSchema = z
  .object({
    schemaVersion: z.number().int(),
    requirements: z.record(f.id, RequirementSchema),
    glossary: z.array(GlossaryEntrySchema).default([]).describe(/* … */),
  })
  .describe(/* … */)
```

The load-time Zod validator for the whole document; `z.record(f.id, …)` rejects any non-UUID key. `src/core/schema.ts:337`. `RequirementSchema` (the single node, `src/core/schema.ts:277`) and `ChangeSchema` (the discriminated-union mutation record, `src/core/schema.ts:445`) compose from the same atomic-field corpus in `f` (`src/core/schema.ts:212`), whose `.describe()` text propagates into the CLI manifest.

### applyChange / applyChanges

```ts
export function applyChange(doc: RequirementsDoc, raw: unknown): RequirementsDoc
export function applyChanges(doc: RequirementsDoc, changes: unknown[]): RequirementsDoc
```

The ONLY sanctioned document mutation path. Validates `raw` against `ChangeSchema`, deep-clones the input (never mutated), and returns a new document. `CreateRequirement` on an existing id throws `ChangeError('ERR_DUPLICATE_ID')`; nulling a required attr throws `ChangeError('ERR_NULL_REQUIRED')`; any EARS-slot edit re-renders `sentence`; `AddRelationship` is idempotent and `Remove`/`Delete` are safe no-ops. `applyChanges` threads a sequence left-to-right. `src/core/changes.ts:74`, `src/core/changes.ts:212`.

### ChangeError

```ts
export class ChangeError extends Error {
  readonly code: ChangeErrorCode
  readonly suggestions: string[]
  constructor(code: ChangeErrorCode, message: string, suggestions: string[])
}
```

Carries the `{code, suggestions}` shape shared with `DocLoadError` / `IoError` so callers pattern-match on `.code` uniformly. `CHANGE_ERROR_CODES = ['ERR_DUPLICATE_ID', 'ERR_NULL_REQUIRED']`. `src/core/changes.ts:58`, `src/core/changes.ts:49`.

### analyze

```ts
export function analyze(doc: RequirementsDoc): Finding[]
```

Tier-0 structural pass over a document snapshot — no solver, no storage coupling. Surfaces `DanglingReference`, `MissingTrigger`, `MissingPreCondition`, `CycleDetected` (on the `derives` DAG), `OrphanRequirement`, and `LeafUnverifiable` findings. `src/core/analyze.ts:27`. The `Finding` union is defined at `src/core/schema.ts:519` (6 structural kinds). `summarizeFindings(findings): string` renders a human summary (`src/core/analyze.ts:190`).

### loadRequirementsDoc / parseRequirementsDoc

```ts
export async function loadRequirementsDoc(path: string)
export function parseRequirementsDoc(text: string)
```

The single funnel every command runs a document through. Validates against `RequirementsDocSchema` and the current `SCHEMA_VERSION`, throwing a typed `DocLoadError` with code `ERR_DOC_PARSE` (bad JSON or schema failure) or `ERR_SCHEMA_VERSION` (well-formed but wrong version). `src/core/load.ts:106`, `src/core/load.ts:61`. `DocLoadError` is at `src/core/load.ts:42`.

### saveDoc / loadDoc / emptyDoc

```ts
export async function saveDoc(doc: Doc, path: string): Promise<void>
export async function loadDoc(path: string): Promise<Doc>
export function emptyDoc(): Doc
```

Plain-object document facade. `saveDoc` persists pretty-printed, sorted-key JSON written atomically; `loadDoc` reads it back; `emptyDoc()` constructs a fresh document at the current schema version. `Doc` is an alias for `RequirementsDoc`. `src/core/doc.ts:49`, `src/core/doc.ts:41`, `src/core/doc.ts:28`. Helpers: `newId()`, `listRequirements(doc)`, `getRequirement(doc, id)` (`src/core/doc.ts:54`).

### Storage primitives

```ts
export async function writeDocFile<T>(path: string, doc: T): Promise<void>
export async function atomicWriteFile(path: string, contents: string): Promise<void>
```

Doc-shape-agnostic JSON persistence with byte-stable, lexicographically sorted keys. A failed atomic write throws `IoError` (`ERR_IO`) rather than a raw `fs` error; the original file is never touched until the final `rename()`. `src/core/storage.ts:135`, `src/core/storage.ts:109`. `IoError` at `src/core/storage.ts:42`; `IO_ERROR_CODES = ['ERR_IO']` at `src/core/storage.ts:28`.

### renderSentence

```ts
export function renderSentence(
  r: Pick<Requirement, 'patternType' | 'preCondition' | 'trigger' | 'systemName' | 'systemResponse'> & { negated?: boolean },
): string
```

Renders the canonical EARS sentence from the structured slots (`shall` / `shall not` per `negated`). `src/core/render.ts:33`.

### exportSysml

```ts
export function exportSysml(doc: Doc): SysmlExport
```

Exports the internal model to a SysML-v2-flavored JSON shape: each requirement becomes a `RequirementUsage`-shaped element, each outbound edge a typed relationship (`derives`→`DeriveRequirement`, etc.). `src/core/sysml-export.ts:49`.

### Error-code catalog

```ts
export const ErrCodeSchema = z.enum([/* ERR_USAGE … ERR_EMBED_MODEL_MISSING */])
export const ErrCodes = ErrCodeSchema.options
export const ErrCodeMeta = { /* z.literal(code).describe(meaning) per code */ }
export function errCodeCatalog(): CodeCatalogEntry<ErrCode>[]
```

The closed, append-only `ERR_*` enum (20 codes: `ERR_USAGE`, `ERR_DOC_NOT_FOUND`, `ERR_DOC_PARSE`, `ERR_SCHEMA_VERSION`, `ERR_IO`, `ERR_DUPLICATE_ID`, `ERR_NOT_FOUND`, `ERR_INVALID_RELATION`, `ERR_INVALID_ATTR`, `ERR_NULL_REQUIRED`, `ERR_PARSE_NO_MODAL`, `ERR_PARSE_AMBIGUOUS_CLAUSES`, `ERR_PARSE_COMPOUND`, `ERR_PARSE_NOT_A_REQUIREMENT`, `ERR_SOLVER_MISSING`, `ERR_SOLVER_TIMEOUT`, `ERR_SOLVER_INCONCLUSIVE`, `ERR_LEAN_TOOLCHAIN_MISSING`, `ERR_DOC_EXISTS`, `ERR_EMBED_MODEL_MISSING`) plus its per-code `.describe()` corpus, which the manifest reads to build its error-code table. `src/core/codes.ts:48`, `src/core/codes.ts:86`, `src/core/codes.ts:95`, `src/core/codes.ts:225`.

---

## pipeline

The full `check`-command pipeline that wires Tier-0 structural, lint, ambiguity, and formal-SMT tiers into one report. Never touches the Lean tier.

### runCheck

```ts
export async function runCheck(doc: Doc, options: CheckOptions = {}): Promise<CheckReport>
```

Runs the default `check` pipeline over a loaded document in this order: structural analysis → GtWR lint (per-statement + set-level) → the always-on deterministic ambiguity family → the gate partition → the free + SMT formal tier via `runSolvers`. The formal closure runs contradiction / subsumption / vacuity / completeness / similarity / needs-review over the gate-INCLUDED subset, the numeric/arithmetic conflict tier over ALL requirements, the bounded temporal tier over ALL requirements when `options.temporal` is set, and the semantic paraphrase pass + embedding similarity graph when `options.semantic` is set. Returns a `CheckReport` with normalized `findings[]`, `excluded[]`, `pairsChecked`, and severity `counts`. `src/pipeline/check.ts:311`.

### CheckOptions

```ts
export interface CheckOptions {
  similarityThreshold?: number
  timeoutMs?: number
  solverBudgetMs?: number
  semantic?: {
    embedder: Embedder
    threshold?: number
  }
  temporal?: {
    bound?: number
  }
}
```

Knobs threaded to the tiers: lexical-similarity threshold, per-group solver timeout (default 2000ms), whole-run solver budget, the opt-in semantic paraphrase pass (an injected `Embedder` proposing `FND_SIMILAR_SEMANTIC` glossary merges plus the similarity graph — off by default so base `check` never loads the model), and the opt-in bounded temporal tier (EARS→LTL bounded LTL→SMT, default trace bound 10, sound-for-UNSAT). `src/pipeline/check.ts:118`.

### CheckReport / CheckFinding

```ts
export interface CheckReport {
  findings: CheckFinding[]
  excluded: Exclusion[]
  pairsChecked: number
  counts: { error: number; warn: number; info: number }
}
export interface CheckFinding {
  code: string
  severity: CheckSeverity
  tier: CheckTier
  requirementIds: string[]
  message: string
  span?: [number, number]
  suggestion?: string
  evidence?: Evidence
}
```

Every tier's native finding shape projects into one normalized `CheckFinding` — a stable `code` (`FND_*` / `GTWR_*`), a `severity` the exit-code contract keys on, `tier` (`'structural' | 'lint' | 'formal'`), `requirementIds[]`, `message`, and optional `span` / `suggestion` (lint) / `evidence` (formal). `src/pipeline/check.ts:150`, `src/pipeline/check.ts:103`, `src/pipeline/check.ts:91`.

### encodeIncluded / toEncodable

```ts
export function encodeIncluded(doc: Doc): EncodedRequirement[]
export function toEncodable(view: ReqView): EncodableRequirement
```

`encodeIncluded` exports the exact encoded requirement set `check` would evaluate — the same input `--emit-smt2` writes and `--solver z3-bin`/`cvc5` cross-checks. Pure and Z3-free. `toEncodable` projects a stored view into the encodable shape, resolving negation. `src/pipeline/check.ts:224`, `src/pipeline/check.ts:204`.

---

## formal

The SMT-backed formal tier: encoder, atomizer, the propositional contradiction / subsumption / vacuity / completeness / similarity checks, the v3 numeric / temporal / ambiguity / embedding tiers, the SMT-LIB2 emitter, the external-binary backend, and the local sentence-embedding backend.

### encode

```ts
export function encode(req: EncodableRequirement, atomize: Atomize): EncodedRequirement
```

Pure encoding of one requirement into its guarded-implication `Formula` (`guard ⇒ (context ⇒ response)`). No solver contact. The response atom threads `req.negated`. `src/formal/encode.ts:205`. Formula constructors `atom`, `not`, `and`, `or`, `implies` and the Z3-lowering `materialize(ctx, f)` are also exported (`src/formal/encode.ts:115`).

### atomize

```ts
export function atomize(args: AtomizeArgs): Atom
```

Turns one EARS slot into a scoped Boolean `Atom` (`{ name, negated }`). Pure and deterministic. For `resp` slots it applies glossary canonicalization, then antonym unification. `src/formal/atomize.ts:135`. `AtomKind = 'trig' | 'pre' | 'resp'`. Companions: `glossaryIndex(entries)` builds the alias→canonical lookup (`src/formal/atomize.ts:96`); `normalize(text)` is the conservative normalization pipeline (`src/formal/atomize.ts:120`).

### findContradictions

```ts
export async function findContradictions(
  reqs: readonly EncodableRequirement[],
  options: FindContradictionsOptions = {},
): Promise<ContradictionFinding[]>
```

Whole-spec contradiction detection via per-context-group reachability checks. Returns one `FND_CONTRADICTION` per distinct conflicting requirement-id set, naming a minimized unsat core. Detectable only when two responses resolve to the same atom with opposite polarity. `src/formal/contradiction.ts:229`.

### checkSubsumption / checkVacuity

```ts
export async function checkSubsumption(
  ctx: Z3Context,
  encodedById: ReadonlyMap<string, EncodedRequirement>,
  pairs: readonly CandidatePair[],
): Promise<SubsumptionResult[]>
export async function checkVacuity(
  ctx: Z3Context,
  all: readonly EncodedRequirement[],
): Promise<VacuityFinding[]>
```

`checkSubsumption` runs subsumption / redundancy over the free-tier candidate pairs (pairwise). `checkVacuity` flags a requirement (`FND_VACUITY`, `warn`, confidence `low`) whose guard is unreachable given the rest of the spec. `src/formal/subsumption.ts:150`, `src/formal/vacuity.ts:108`.

### extractNumericPredicates / NumericPredicate

```ts
export function extractNumericPredicates(text: string, systemName: string): NumericPredicate[]
export interface NumericPredicate {
  readonly quantity: string
  readonly label: string
  readonly comparator: NumericComparator
  readonly value: number
  readonly baseUnit: string
  readonly sourceText: string
}
```

Lifts every `(quantity, comparator, value, unit)` numeric predicate in one slot, deterministically, with unit normalization (seconds→ms, kb→B, …) and a canonical per-system quantity key. Returns `[]` when no predicate is present — a missed extraction is a false negative, never a fabricated constraint. `src/formal/numeric.ts:196`, `src/formal/numeric.ts:33`.

### findNumericContradictions

```ts
export async function findNumericContradictions(
  ctx: Z3Context,
  reqPreds: readonly RequirementPredicates[],
): Promise<NumericContradictionFinding[]>
```

The v3.0 numeric/arithmetic conflict tier (default-on, LIA/LRA). Groups predicates by canonical quantity; for each quantity referenced by ≥2 requirements it asserts every contributing predicate under a guard literal and checks joint satisfiability, emitting `FND_NUMERIC_CONTRADICTION` (severity `error`) naming the unsat core's ids. `src/formal/numeric-contradiction.ts:55`. `RequirementPredicates` at `src/formal/numeric-contradiction.ts:43`.

### earsToTemporal / TemporalFormula

```ts
export function earsToTemporal(req: ReqView): TemporalFormula
```

Pure, total EARS→LTL mapping (Dwyer/SPS/FRET patterns) — never throws; a missing slot yields a well-formed empty-token atom. Companion constructors: `tAtom`, `tNot`, `tImplies`, `tAnd`, `tOr` and the modal `G`, `F`, `X`, `U` (`src/formal/temporal-patterns.ts:168`, `src/formal/temporal-patterns.ts:75-108`). `TemporalFormula` is the plain-data formula AST (`src/formal/temporal-patterns.ts:58`).

### findTemporalContradictions / lowerAt

```ts
export async function findTemporalContradictions(
  ctx: Z3Context,
  reqTemporals: readonly RequirementTemporal[],
  k = 10,
): Promise<TemporalContradictionFinding[]>
export function lowerAt(ctx: Z3Context, f: TemporalFormula, t: number, k: number): Z3Bool
```

The v3.3 bounded LTL→SMT temporal tier (opt-in). Asserts each requirement's bounded encoding under a guard literal and checks joint satisfiability at trace bound `k`; on `unsat` emits `FND_TEMPORAL_CONTRADICTION` (severity `error`) naming the minimized core, with evidence `{bound, complete:false}`. Sound-for-UNSAT, not complete-for-SAT: `sat`/`unknown` yield no finding and are NOT read as "consistent". `lowerAt` lowers a `TemporalFormula` to a propositional Z3 Bool at timestep `t` over a loop-free trace of length `k`. `src/formal/temporal.ts:118`, `src/formal/temporal.ts:62`. `RequirementTemporal` at `src/formal/temporal.ts:51`; `TemporalContradictionFinding` at `src/formal/temporal.ts:40`.

### detectAmbiguity

```ts
export function detectAmbiguity(reqs: readonly ReqView[]): AmbiguityFinding[]
```

The v3.1 deterministic ambiguity family (default-on, PURE/SYNC — no solver, model, async, or I/O; byte-reproducible in a fixed order). Emits `AmbiguityCode = 'FND_AMBIGUOUS_VAGUE' | 'FND_AMBIGUOUS_QUANTIFIER' | 'FND_AMBIGUOUS_REFERENCE' | 'FND_AMBIGUITY_NEEDS_JUDGMENT'`. Only the mechanical un-parenthesized `and…or` coordination case is verdict-eligible (`warn`); every other category is `info` (propose-only). `src/formal/ambiguity.ts:442`, `src/formal/ambiguity.ts:40`. `AmbiguityFinding` at `src/formal/ambiguity.ts:82`.

### buildSimilarityGraph

```ts
export async function buildSimilarityGraph(
  reqs: readonly GraphRequirement[],
  embedder: Embedder,
  options: GraphOptions = {},
): Promise<GraphFinding[]>
```

The v3.2 deterministic kNN similarity graph. Proposes (info-only, never a verdict) missing trace links (`FND_MISSING_TRACE_LINK`) and near-duplicate clusters (`FND_DUPLICATE_CLUSTER`) using quantized cosine, id tiebreak, and union-find. Async only because embedding is; pure given the embedder. `src/formal/graph.ts:102`. `GraphFinding = MissingTraceLinkFinding | DuplicateClusterFinding` (`src/formal/graph.ts:65`); `GraphRequirement` / `GraphOptions` at `src/formal/graph.ts:32` / `src/formal/graph.ts:68`.

### findSimilarSemantic

```ts
export async function findSimilarSemantic(
  reqs: readonly SemanticRequirement[],
  embedder: Embedder,
  options: FindSimilarSemanticOptions = {},
): Promise<SimilarSemanticFinding[]>
```

Embeds response phrasings and reports high-cosine pairs that did NOT already unify to one atom, as `FND_SIMILAR_SEMANTIC` propose-only findings suggesting glossary merges. Requires an injected `Embedder` (the `check --semantic` path loads it lazily). `src/formal/semantic.ts:76`.

### loadEmbedder / Embedder / cosine / EmbedModelMissingError

```ts
export async function loadEmbedder(options: LoadEmbedderOptions = {}): Promise<Embedder>
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>
export function cosine(a: Float32Array, b: Float32Array): number
export class EmbedModelMissingError extends Error {
  readonly code = 'ERR_EMBED_MODEL_MISSING'
  readonly suggestions: string[]
}
```

`loadEmbedder` loads the pinned `Xenova/bge-base-en-v1.5` model on the ONNX WASM runtime — lazy and offline by default (the model must be cached unless `allowRemote` or `SYMSPEC_EMBED_ALLOW_REMOTE=1` is set, otherwise it throws `EmbedModelMissingError`). Propose-only. `Embedder` maps text to one L2-normalized vector per input; `cosine` is a dot product of two normalized vectors (mismatched lengths return 0). `EmbedModelMissingError` never blocks the SMT/lint tiers. `src/formal/embed.ts:205`, `src/formal/embed.ts:64`, `src/formal/embed.ts:231`, `src/formal/embed.ts:46`.

### downloadModelAssets / modelCacheDir / DownloadReport

```ts
export async function downloadModelAssets(): Promise<DownloadReport>
export function modelCacheDir(): string
export interface DownloadReport {
  readonly model: string
  readonly revision: string
  readonly cacheDir: string
  readonly assets: readonly AssetReport[]
  readonly alreadyComplete: boolean
}
```

`downloadModelAssets` force-fetches all pinned model assets (~110 MB `.onnx` + two tokenizer files) into the cache, sha256-verifying each, and reports per-asset cached-vs-fetched status — backing the `download-model` command. `modelCacheDir()` resolves the cache directory, honoring `SYMSPEC_MODEL_DIR`, then `XDG_CACHE_HOME`, falling back to `~/.cache` (pinned per model revision). `src/formal/model-cache.ts:218`, `src/formal/model-cache.ts:101`, `src/formal/model-cache.ts:198`. `AssetReport` at `src/formal/model-cache.ts:188`.

### emitSmt2

```ts
export function emitSmt2(
  encoded: readonly EncodedRequirement[],
  options: EmitSmt2Options = {},
): string
```

Emits a portable, self-contained SMT-LIB2 script (`(set-logic ALL)`) for the encoded requirement set, sorted by id so byte-identical input yields byte-identical output. Pure — no solver contact, no I/O; the caller writes the string to disk. `src/formal/emit-smt2.ts:132`.

### discoverSolverBinary / runSolverBinary

```ts
export function discoverSolverBinary(options: DiscoverSolverBinaryOptions = {}): DiscoveredSolver
export function runSolverBinary(
  smt2: string,
  discovered: DiscoveredSolver,
  options: RunSolverBinaryOptions = {},
): BinaryCheckResult
```

The optional external-binary backend (z3/cvc5 cross-check). `discoverSolverBinary` resolves a binary by the discovery order `--solver-path` → `SYMSPEC_Z3` env → PATH (`z3` then `cvc5`), throwing `BinaryBackendError` (`ERR_SOLVER_MISSING`) when the highest-precedence supplied source does not resolve. `runSolverBinary` runs an SMT-LIB2 artifact through the discovered binary, degrading a spawn failure to `{ status: 'unknown', core: [] }` rather than throwing. `src/formal/binary-backend.ts:151`, `src/formal/binary-backend.ts:248`.

### FND finding-code catalog

```ts
export const FndCodeSchema = z.enum([/* FND_DANGLING_REFERENCE … FND_TEMPORAL_CONTRADICTION */])
export const FndCodes = FndCodeSchema.options
export const FndCodeMeta = { /* z.literal(code).describe(meaning) per code */ }
export const structuralKindToFndCode: Record<string, FndCode>
export const solverKindToFndCode: Record<string, FndCode>
export function certifiedToFndCode(certified: boolean): FndCode
```

The single closed `FND_*` enum spanning every tier — structural, free-lint, formal-SMT, completeness, certify, semantic, numeric, DAG, embedding-graph, ambiguity, and temporal codes — plus its per-code `.describe()` corpus (which the manifest reads) and the reachability bridges mapping each producer's discriminant to its code. `src/formal/codes.ts:54`, `src/formal/codes.ts:96`, `src/formal/codes.ts:103`, `src/formal/codes.ts:223`, `src/formal/codes.ts:237`, `src/formal/codes.ts:242`.

---

## lint

The INCOSE Guide to Writing Requirements (GtWR) v4 rule engine — 24 T1 (regex/lexicon) rules.

### checkGtWRules / checkGtWRulesSet

```ts
export function checkGtWRules(requirement: Requirement, sentence: string): GtWRFinding[]
export function checkGtWRulesSet(
  requirements: readonly { requirement: Requirement; sentence: string }[],
): GtWRFinding[]
```

`checkGtWRules` runs the per-statement rules over a rendered EARS sentence, returning `GtWRFinding`s each with a stable `GTWR_Rn` `code`, `severity`, character `span`, `message`, and optional `suggestion`. `checkGtWRulesSet` runs the set-level checks that cannot be decided from a single statement (currently R40 decimal-format consistency). `src/lint/gtwr.ts:74`, `src/lint/gtwr.ts:833`. `GtWRFinding` at `src/lint/gtwr.ts:17`.

### GTWR rule-code catalog

```ts
export const GtwrCodeSchema = z.enum([/* GTWR_R1_PATTERN … GTWR_R40_DECIMAL_FORMAT */])
export const GtwrCodes = GtwrCodeSchema.options
export const GtwrCodeMeta = { /* z.literal(code).describe(meaning) per code */ }
```

The closed, append-only `GTWR_*` enum (24 rules) plus its per-code `.describe()` corpus the manifest reads to build its GtWR table. `src/lint/codes.ts:33`, `src/lint/codes.ts:69`, `src/lint/codes.ts:76`.

---

## parse

The natural-language requirement-prose parse ladder (`src/parse/index.ts:1`).

### classifyTier1 / runTier2

```ts
export { classifyTier1, KW, MAIN, preprocess, systemEscalationNotes } from './tier1.js'
export { defaultTier2Loader, ESCALATION_TRIGGERS, escalationTriggers, MAX_TIER1_TOKENS, repairWithWink, runTier2 } from './tier2.js'
```

Tier 1 is the zero-dependency regex cascade (`classifyTier1`, returning `Tier1Ok | Tier1Miss`); Tier 2 is the wink-nlp escalation (`runTier2`). The `Confidence` type (`'high' | 'medium' | 'low'`) and the `Tier1*` / `Tier2*` result types are re-exported through this barrel. Also re-exported: `parseBatch`, `parseLine`, `makeTier3Envelope`, `PARSE_ERROR_CODES`, and the `normalize`/`negation`/`preprocess` helpers (`src/index.ts:160-163`).

---

## certify

The Lean 4 toolchain discovery, emitter, and NDJSON-parsing runner. A separate command from `check` — `check` never touches Lean.

### certify

```ts
export async function certify(
  theorems: readonly LeanTheoremSpec[],
  options: CertifyOptions = {},
): Promise<CertifyResult>
```

Emits a batched `.lean` file (with `#print axioms` per theorem), runs it through `lean --json`, and — only where certification succeeds — retains the `.lean` file plus a `lean-toolchain` pin as a re-checkable artifact. `src/certify/run.ts:305`. `CertifyResult` (`src/certify/run.ts:285`) extends the run result with axiom provenance and the optional retained `artifact` paths.

### discoverLeanToolchain / emitLeanFile

```ts
export function discoverLeanToolchain(): void
export function emitLeanFile(theorems, options?): string
```

`discoverLeanToolchain()` throws `ERR_LEAN_TOOLCHAIN_MISSING` when no Lean toolchain is found (`src/certify/discover.ts:72`); `probeLeanToolchain()` is the non-throwing probe (`src/certify/discover.ts:114`). `emitLeanFile` renders the batched theorem source (`src/certify/emit.ts:85`).

---

## cli contract

The envelope/manifest shapes an agent validates CLI `--json` output against — exported for library parity.

### success / failure

```ts
export function success<T>(type: string, data: T): SuccessEnvelope<T>
export function failure(opts: FailureOptions): ErrorEnvelope
```

Constructors for the two envelope shapes. Success is `{ apiVersion, type, data }` (`type` = the command name); failure is the superset `{ apiVersion, type: 'error', error, code, suggestions, partial? }`. `partial` is omitted unless a Tier-3 parse recovered a slot skeleton. `API_VERSION = 1` is the envelope-contract integer, distinct from the package version and the document `schemaVersion`. `src/index.ts:58-69`.

### Envelope types

```ts
export interface SuccessEnvelope<T = unknown> { readonly apiVersion: typeof API_VERSION; readonly type: string; readonly data: T }
export interface ErrorEnvelope { readonly apiVersion: typeof API_VERSION; readonly type: 'error'; readonly error: string; readonly code: …; readonly suggestions: readonly string[]; readonly partial?: PartialSlots }
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope
```

`Envelope` is discriminated on `type` (`'error'` = failure). Zod validators `SuccessEnvelopeSchema`, `ErrorEnvelopeSchema`, and `PartialSlotsSchema` are exported alongside (`src/index.ts:58-69`).

### EnvelopeTypeSchema

```ts
export const EnvelopeTypeSchema = z.enum([
  'manifest', 'init', 'add', 'update', 'parse', 'check', 'certify', 'list',
  'show', 'derive', 'satisfy', 'remove-edge', 'delete', 'export', 'error',
  'glossary', 'download-model',
])
```

The closed, append-only enum of envelope `type` discriminants — one per result-bearing command (the success `type` equals the command name) plus the reserved `'error'`. `EnvelopeTypes` is the inner tuple. `src/index.ts:71`.

### buildManifest / Manifest

```ts
export function buildManifest(): Manifest
export const ManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  apiVersion: z.literal(API_VERSION),
  globalOptions: JsonSchemaValue,
  commands: z.array(ManifestCommandSchema),
  types: z.array(z.string()),
  codes: z.object({ error: …, gtwr: …, fnd: … }),
  scope: ScopeSchema,
  backends: BackendsReportSchema.optional(),
})
export type Manifest = z.infer<typeof ManifestSchema>
```

`buildManifest` builds the self-describing manifest an agent fetches once to learn symspec's entire surface — command inventory, each command's JSON-Schema argument shape, the closed `types` set, and the `error`/`gtwr`/`fnd` code catalogs. Pure and byte-stable. The CLI's `buildManifestWithBackends()` attaches a live backend-availability probe. `src/index.ts:70`.


## See also

- [symspec · Module map](../architecture/module-map.md) — 25 shared source citations
- [symspec · Business logic](../insights/business-logic.md) — 10 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 9 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 8 shared source citations
- [symspec · Processes](../behavior/processes.md) — 8 shared source citations
