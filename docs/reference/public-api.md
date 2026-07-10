# symspec · Public API

symspec is a **library first, CLI second**. Every command in `src/cli/index.ts` is a thin formatter over functions re-exported from `src/index.ts`: `symspec add` calls `applyChange` + `saveDoc`, `symspec check` calls `analyze`/lint/formal functions, and so on. Nothing the CLI does is reachable only through a subprocess — any Node program can `import { runCheck, applyChange, analyze } from 'symspec'` and get the exact behavior the `dist/cli.mjs` binary invokes (`src/index.ts:1`).

```ts
import { runCheck, applyChange, analyze, loadRequirementsDoc } from 'symspec'
```

The package `exports` map points `.` at the build output (`dist/index.mjs` + `dist/index.d.mts`), so a workspace or published-package consumer resolves `symspec` as a library; `bin/symspec.mjs` remains the independent CLI entry (`package.json:27`, `src/index.ts:12`).

Re-exports are grouped by subsystem mirroring `src/`: `core/*`, `parse/*`, `lint/*`, `pipeline/*`, `certify/*`, `formal/*` + `solvers/*`, and the `cli/*` envelope/manifest contract (`src/index.ts:20`). Two same-named types are re-exported explicitly to avoid ambiguity: `AtomKind` (from both `atomize.ts` and `encode.ts`) and `solvers/types.ts`'s `Confidence`, which is renamed `SolverConfidence` at the barrel (`src/index.ts:38`).

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

The root in-memory / on-disk document: a schema-version tag, a flat UUID-keyed map of requirement nodes, and an optional synonym glossary. `src/core/schema.ts:566`. Current schema is `export const SCHEMA_VERSION = 2` (`src/core/schema.ts:572`).

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

### applyChange

```ts
export function applyChange(doc: RequirementsDoc, raw: unknown): RequirementsDoc
```

The ONLY sanctioned document mutation path. Validates `raw` against `ChangeSchema`, deep-clones the input (never mutated), and returns a new document. `CreateRequirement` on an existing id throws `ChangeError('ERR_DUPLICATE_ID')`; nulling a required attr throws `ChangeError('ERR_NULL_REQUIRED')`; any EARS-slot edit re-renders `sentence`; `AddRelationship` is idempotent and `Remove`/`Delete` are safe no-ops. `src/core/changes.ts:74`.

### applyChanges

```ts
export function applyChanges(doc: RequirementsDoc, changes: unknown[]): RequirementsDoc
```

Apply a sequence of Change records left-to-right, threading the result. `src/core/changes.ts:212`.

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

Tier-0 structural pass over a document snapshot — no solver, no storage coupling. Surfaces `DanglingReference`, `MissingTrigger`, `MissingPreCondition`, `CycleDetected` (on the `derives` DAG), and `OrphanRequirement` findings. `src/core/analyze.ts:27`. The `Finding` union is defined at `src/core/schema.ts:519`. `summarizeFindings(findings): string` renders a human summary (`src/core/analyze.ts:160`).

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

Plain-object document facade. `saveDoc` persists pretty-printed, sorted-key JSON written atomically (temp file + rename); `loadDoc` reads it back (schema validation is layered separately via `loadRequirementsDoc`); `emptyDoc()` constructs a fresh document at the current schema version. `Doc` is an alias for `RequirementsDoc`. `src/core/doc.ts:49`, `src/core/doc.ts:41`, `src/core/doc.ts:28`. Helpers: `newId()`, `listRequirements(doc)`, `getRequirement(doc, id)`, `snapshot(doc)` (`src/core/doc.ts:54`).

### Storage primitives

```ts
export async function writeDocFile<T>(path: string, doc: T): Promise<void>
export async function readDocFile<T = unknown>(path: string): Promise<T>
export async function atomicWriteFile(path: string, contents: string): Promise<void>
export function serializeDoc<T>(doc: T): string
```

Doc-shape-agnostic JSON persistence with byte-stable, lexicographically sorted keys. A failed atomic write throws `IoError` (`ERR_IO`) rather than a raw `fs` error; the original file is never touched until the final `rename()`. `src/core/storage.ts:135`, `src/core/storage.ts:143`, `src/core/storage.ts:109`, `src/core/storage.ts:82`. `IoError` at `src/core/storage.ts:42`.

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

Exports the internal model to a SysML-v2-flavored JSON shape: each requirement becomes a `RequirementUsage`-shaped element, each outbound edge a typed relationship (`derives`→`DeriveRequirement`, etc.), EARS slots map to typed attributes. `src/core/sysml-export.ts:49`.

---

## pipeline

The full `check`-command pipeline that wires Tier-0 structural, lint, and formal-SMT tiers into one report. Never touches the Lean tier (AC-5-5).

### runCheck

```ts
export async function runCheck(doc: Doc, options: CheckOptions = {}): Promise<CheckReport>
```

Runs the default `check` pipeline over a loaded document: structural analysis → GtWR lint (per-statement + set-level) → the AC-3-7 gate partition → the SMT formal tier (contradiction / subsumption / vacuity / completeness / similarity / needs-review) over the INCLUDED subset only. Returns a `CheckReport` with normalized `findings[]`, `excluded[]`, `pairsChecked`, and severity `counts`. `src/pipeline/check.ts:293`.

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
}
```

Knobs threaded to the tiers: lexical-similarity threshold, per-group solver timeout (default 2000ms), whole-run solver budget, and the opt-in semantic paraphrase pass (an injected `Embedder` proposing `FND_SIMILAR_SEMANTIC` glossary merges — off by default so base `check` never loads the model). `src/pipeline/check.ts:112`.

### CheckReport / CheckFinding

```ts
export interface CheckReport {
  findings: CheckFinding[]
  excluded: Exclusion[]
  pairsChecked: number
  counts: { error: number; warn: number; info: number }
}
```

Every tier's native finding shape projects into one normalized `CheckFinding` — a stable `code` (`FND_*` / `GTWR_*`), a `severity` the exit-code contract keys on, `tier`, `requirementIds[]`, `message`, and optional `span` / `suggestion` (lint) / `evidence` (formal). `src/pipeline/check.ts:133`, `src/pipeline/check.ts:97`. `encodeIncluded(doc)` (`src/pipeline/check.ts:207`) exports the exact encoded requirement set `check` would evaluate.

---

## formal

The SMT-backed formal tier: encoder, atomizer, contradiction / subsumption / vacuity checks, and the local sentence-embedding backend.

### encode

```ts
export function encode(req: EncodableRequirement, atomize: Atomize): EncodedRequirement
```

Pure encoding of one requirement into its guarded-implication `Formula` (`guard ⇒ (context ⇒ response)`). No solver contact. The response atom threads `req.negated` (AC-2-4). `src/formal/encode.ts:183`. Formula constructors `atom`, `not`, `and`, `or`, `implies` and the Z3-lowering `materialize(ctx, f)` are also exported (`src/formal/encode.ts:105`, `src/formal/encode.ts:238`).

### atomize

```ts
export function atomize(args: AtomizeArgs): Atom
```

Turns one EARS slot into a scoped Boolean `Atom` (`{ name, negated }`). Pure and deterministic. For `resp` slots it applies glossary canonicalization, then antonym unification (polar-opposite responses collapse to one atom at opposite polarity). `src/formal/atomize.ts:135`. `AtomKind = 'trig' | 'pre' | 'resp'` (`src/formal/atomize.ts:49`). Companions: `glossaryIndex(entries)` builds the normalized alias→canonical lookup (`src/formal/atomize.ts:96`); `normalize(text)` is the conservative normalization pipeline (`src/formal/atomize.ts:120`).

### findContradictions

```ts
export async function findContradictions(
  reqs: readonly EncodableRequirement[],
  options: FindContradictionsOptions = {},
): Promise<ContradictionFinding[]>
```

Whole-spec contradiction detection via per-context-group reachability checks (AC-4-3). Returns one `FND_CONTRADICTION` per distinct conflicting requirement-id set. A contradiction is detectable only when two responses resolve to the same atom with opposite polarity (sound modulo atomization). `src/formal/contradiction.ts:229`.

### checkSubsumption

```ts
export async function checkSubsumption(
  ctx: Z3Context,
  encodedById: ReadonlyMap<string, EncodedRequirement>,
  pairs: readonly CandidatePair[],
): Promise<SubsumptionResult[]>
```

Runs subsumption / redundancy over the free-tier candidate pairs (pairwise, not whole-spec). Pairs whose ids are gate-excluded are skipped. `src/formal/subsumption.ts:150`.

### checkVacuity

```ts
export async function checkVacuity(
  ctx: Z3Context,
  all: readonly EncodedRequirement[],
): Promise<VacuityFinding[]>
```

Whole-spec relational vacuity: flags a requirement (`FND_VACUITY`, severity `warn`, confidence `low`) whose guard is unreachable given the rest of the spec. `src/formal/vacuity.ts:108`.

### loadEmbedder

```ts
export async function loadEmbedder(options: LoadEmbedderOptions = {}): Promise<Embedder>
```

Loads a sentence embedder — the pinned `Xenova/bge-base-en-v1.5` model on the ONNX WASM runtime. Lazy and offline by default: the model must be cached unless `allowRemote` (or `SYMSPEC_EMBED_ALLOW_REMOTE=1`) is set, otherwise it throws `EmbedModelMissingError`. Propose-only — it produces similarity scores, never a verdict. `src/formal/embed.ts:205`.

### Embedder / cosine / EmbedModelMissingError

```ts
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>
export function cosine(a: Float32Array, b: Float32Array): number
export class EmbedModelMissingError extends Error {
  readonly code = 'ERR_EMBED_MODEL_MISSING'
  readonly suggestions: string[]
}
```

`Embedder` maps text to one L2-normalized vector per input. `cosine` is a plain dot product of two normalized vectors (mismatched lengths return 0). `EmbedModelMissingError` carries `ERR_EMBED_MODEL_MISSING` with a download suggestion; it never blocks the SMT/lint tiers. `src/formal/embed.ts:64`, `src/formal/embed.ts:231`, `src/formal/embed.ts:46`.

### downloadModelAssets

```ts
export async function downloadModelAssets(): Promise<DownloadReport>
```

Force-fetches all pinned model assets (~110 MB `.onnx` + two tokenizer files) into the cache, sha256-verifying each, and reports per-asset cached-vs-fetched status. Backs the `download-model` command / AC-9-4 pre-warm. `src/formal/model-cache.ts:218`.

### modelCacheDir / DownloadReport / AssetReport

```ts
export function modelCacheDir(): string
export interface DownloadReport {
  readonly model: string
  readonly revision: string
  readonly cacheDir: string
  readonly assets: readonly AssetReport[]
  readonly alreadyComplete: boolean
}
```

`modelCacheDir()` resolves the cache directory, honoring `SYMSPEC_MODEL_DIR`, then `XDG_CACHE_HOME`, falling back to `~/.cache` (pinned per model revision). `src/formal/model-cache.ts:101`, `src/formal/model-cache.ts:198`, `src/formal/model-cache.ts:188`.

---

## lint

The INCOSE Guide to Writing Requirements (GtWR) v4 rule engine — ~24 T1 (regex/lexicon) rules.

### checkGtWRules

```ts
export function checkGtWRules(requirement: Requirement, sentence: string): GtWRFinding[]
```

Runs the per-statement GtWR rules over a rendered EARS sentence, returning `GtWRFinding`s each with a stable `GTWR_Rn` `code`, `severity`, character `span`, `message`, and optional `suggestion`. Returns `[]` when clean. `src/lint/gtwr.ts:74`. `GtWRFinding` is at `src/lint/gtwr.ts:17`.

### checkGtWRulesSet

```ts
export function checkGtWRulesSet(
  requirements: readonly { requirement: Requirement; sentence: string }[],
): GtWRFinding[]
```

Set-level GtWR checks that cannot be decided from a single statement (currently R40 decimal-format consistency). Each finding carries `requirementId`. `src/lint/gtwr.ts:833`.

---

## parse

The natural-language requirement-prose parse ladder (`src/parse/index.ts:1`).

### classifyTier1 / runTier2

```ts
export { classifyTier1, KW, MAIN, preprocess, systemEscalationNotes } from './tier1.js'
export { defaultTier2Loader, ESCALATION_TRIGGERS, escalationTriggers, MAX_TIER1_TOKENS, repairWithWink, runTier2 } from './tier2.js'
```

Tier 1 is the zero-dependency regex cascade (`classifyTier1`, returning a `Tier1Result` = `Tier1Ok | Tier1Miss`); Tier 2 is the wink-nlp escalation (`runTier2`). The `Confidence` type (`'high' | 'medium' | 'low'`) and the `Tier1*` / `Tier2*` result types are re-exported through this barrel. `src/parse/index.ts:17`, `src/parse/index.ts:35`.

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

Full AC-5-3 pipeline: emit a batched `.lean` file (with `#print axioms` per theorem), run it through `lean --json`, and — only where certification succeeds — retain the `.lean` file plus a `lean-toolchain` pin as a re-checkable artifact. `src/certify/run.ts:305`. `CertifyResult` (`src/certify/run.ts:285`) extends `LeanRunResult` with axiom provenance and the optional retained `artifact` paths.

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

Constructors for the two envelope shapes. Success is `{ apiVersion, type, data }` (`type` = the command name); failure is the superset `{ apiVersion, type: 'error', error, code, suggestions, partial? }`. `partial` is omitted (never `null`/`undefined`) unless a Tier-3 parse recovered a slot skeleton. `src/cli/envelope.ts:159`, `src/cli/envelope.ts:176`. `API_VERSION = 1` is the envelope-contract integer, distinct from the package version and the document `schemaVersion` (`src/cli/envelope.ts:69`).

### Envelope types

```ts
export interface SuccessEnvelope<T = unknown> { readonly apiVersion: typeof API_VERSION; readonly type: string; readonly data: T }
export interface ErrorEnvelope { readonly apiVersion: typeof API_VERSION; readonly type: 'error'; readonly error: string; readonly code: …; readonly suggestions: readonly string[]; readonly partial?: PartialSlots }
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope
```

`Envelope` is discriminated on `type` (`'error'` = failure). Zod validators `SuccessEnvelopeSchema`, `ErrorEnvelopeSchema`, and `PartialSlotsSchema` are exported alongside. `src/cli/envelope.ts:107`, `src/cli/envelope.ts:133`, `src/cli/envelope.ts:146`.

### EnvelopeTypeSchema

```ts
export const EnvelopeTypeSchema = z.enum([
  'manifest', 'init', 'add', 'update', 'parse', 'check', 'certify', 'list',
  'show', 'derive', 'satisfy', 'remove-edge', 'delete', 'export', 'error',
  'glossary', 'download-model',
])
```

The closed, append-only enum of envelope `type` discriminants — one per result-bearing command (the success `type` equals the command name) plus the reserved `'error'`. `EnvelopeTypes` is the inner tuple; `isEnvelopeType(t)` is the type guard. `src/cli/types-enum.ts:54`, `src/cli/types-enum.ts:82`.

### buildManifest

```ts
export function buildManifest(): Manifest
```

Builds the self-describing manifest an agent fetches once to learn symspec's entire surface — command inventory, each command's JSON-Schema argument shape (derived from the same Zod field corpus the runtime validates against), the closed `types` set, and the `error`/`gtwr`/`fnd` code catalogs. Pure and byte-stable. `src/cli/manifest.ts:379`. `buildManifestWithBackends()` (`src/cli/manifest.ts:412`) attaches a live backend-availability probe.

### Manifest

```ts
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

The manifest blob shape, validated against itself. `src/cli/manifest.ts:301`.


## See also

- [symspec · Module map](../architecture/module-map.md) — 25 shared source citations
- [symspec · Business logic](../insights/business-logic.md) — 10 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 9 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 8 shared source citations
- [symspec · Processes](../behavior/processes.md) — 8 shared source citations
