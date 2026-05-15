# symspec · Public API

The repo is private (`package.json:4`) and not published to npm; "public" here means the symbols other modules import — the surface a vendor of `src/core` would treat as load-bearing. Grouped by file.

## `src/core/doc.ts` — Automerge wrapper

### `type Doc = Automerge.Doc<RequirementsDoc>`

Branded Automerge document type (`src/core/doc.ts:24`).

### `emptyDoc(): Doc`

Construct a new empty doc with `schemaVersion: SCHEMA_VERSION` and `requirements: {}` (`src/core/doc.ts:26-31`).

### `loadDoc(path: string): Promise<Doc>`

Read a `.automerge` binary file and parse via `Automerge.load` (`src/core/doc.ts:33-36`).

### `saveDoc(doc: Doc, path: string): Promise<void>`

Serialize via `Automerge.save` and write bytes to disk (`src/core/doc.ts:38-41`).

### `newId(): string`

`crypto.randomUUID()` wrapper for new requirement IDs (`src/core/doc.ts:43-45`).

### `applyChange(doc: Doc, raw: unknown): Doc`

Validate `raw` against `ChangeSchema`, dispatch on `kind` inside `Automerge.change`, return the new doc (`src/core/doc.ts:58-160`). Idempotency contract: `AddRelationship` no-ops on existing edge; `RemoveRelationship` no-ops on missing edge; `DeleteRequirement` no-ops on missing id; `CreateRequirement` throws on duplicate id (`src/core/doc.ts:50-57`). Throws on `UpdateAttribute` with missing id (`src/core/doc.ts:104`) and on null-clearing a required attr (`src/core/doc.ts:111-113`).

### `applyChanges(doc: Doc, changes: unknown[]): Doc`

Sequential fold of `applyChange` over an array (`src/core/doc.ts:162-166`).

### `merge(a: Doc, b: Doc): Doc`

Thin wrapper over `Automerge.merge`, exposed so smoke scripts can demonstrate convergence explicitly (`src/core/doc.ts:172-174`).

### `listRequirements(doc: Doc): Requirement[]`

`Object.values(doc.requirements)` (`src/core/doc.ts:176-178`).

### `getRequirement(doc: Doc, id: string): Requirement | undefined`

Direct map lookup (`src/core/doc.ts:180-182`).

### `snapshot(doc: Doc): RequirementsDoc`

`JSON.parse(JSON.stringify(doc))` — strips Automerge proxy wrappers (`src/core/doc.ts:187-189`).

## `src/core/schema.ts` — domain schemas + renderer

### `EARS_PATTERNS: readonly EarsPattern[]` and `type EarsPattern`

`['ubiquitous', 'event-driven', 'state-driven', 'optional-feature', 'unwanted-behavior']` (`src/core/schema.ts:26-33`).

### `PRIORITIES`, `STATUSES`, `VERIFICATION_METHODS`, `RELATIONS`, `UPDATABLE_ATTRS`

Const tuples + derived types for each enum (`src/core/schema.ts:35-57`).

### `NULLABLE_ATTRS: ReadonlySet<UpdatableAttr>`

`{ 'preCondition', 'trigger', 'verificationMethod' }` — the only attrs that may be set to `null` (`src/core/schema.ts:60-64`).

### `f` — atomic Zod field schemas

Object literal exposing every field schema with rich `.describe()` text: `id`, `patternType`, `preCondition`, `trigger`, `systemName`, `systemResponse`, `sentence`, `priority`, `status`, `verificationMethod`, edge arrays (`derives`, `satisfies`, `verifies`, `refines`), timestamps, `relation`, `attr`, `attrValue` (`src/core/schema.ts:199-257`). All composed schemas pull from this object.

### `RequirementSchema` and `type Requirement`

Full on-disk shape with defaults: `priority='medium'`, `status='draft'`, edge arrays default `[]` (`src/core/schema.ts:263-291`).

### `CreateRequirementAttrsSchema`

Initial attrs allowed at create time (`src/core/schema.ts:294-312`). `id`, `sentence`, `createdAt`, `updatedAt`, edge arrays are filled by the runtime.

### `RequirementCreateInputShape`, `RequirementUpdateInputShape`, `RelationshipAddInputShape`, `RelationshipRemoveInputShape`, `RequirementDeleteInputShape`

Raw `ZodRawShape` objects for direct reuse with `McpServer.tool()` (`src/core/schema.ts:319-367`).

### `ChangeSchema` and `type Change`

Discriminated union on `kind`: `CreateRequirement | UpdateAttribute | AddRelationship | RemoveRelationship | DeleteRequirement` (`src/core/schema.ts:375-432`).

### `renderSentence(r): string`

Render the canonical EARS sentence from EARS slots; combines pre + trigger as "While PRE, when TRIGGER, ..." (`src/core/schema.ts:443-464`).

### `type Finding`

Discriminated union: `DanglingReference | MissingTrigger | MissingPreCondition | CycleDetected | OrphanRequirement` (`src/core/schema.ts:470-496`).

### `type RequirementsDoc` and `SCHEMA_VERSION = 1`

Root doc shape and current schema version (`src/core/schema.ts:507-512`).

## `src/core/analyze.ts`

### `analyze(doc: Doc): Finding[]`

Run all four checks over a converged snapshot (`src/core/analyze.ts:23-100`).

### `summarizeFindings(findings: Finding[]): string`

Human-readable formatter (`src/core/analyze.ts:142-147`).

## `src/core/sysml-export.ts`

### `exportSysml(doc: Doc): SysmlExport`

Project the doc into `{ '@context': 'https://www.omg.org/spec/SysML/v2', schemaVersion, elements, relationships }` (`src/core/sysml-export.ts:49-90`). Each requirement becomes one `RequirementUsage` element; each outbound edge becomes one `DeriveRequirement | Satisfy | Verify | Refine` relationship element (`src/core/sysml-export.ts:42-47`).

## `src/solvers/index.ts`

### `runSolvers(doc, opts?: RunSolversOptions): Promise<SolverReport>`

Run free tier always, LLM tier when `opts.llm` is set (`src/solvers/index.ts:49-110`). `opts.llm.call` injects the `CallModel`; `opts.llm.arbiter` injects the optional `CallArbiter`; `opts.maxLlmPairs` caps LLM cost (default 50) (`src/solvers/index.ts:24-41`). Returns `{ findings, candidatePairs, llmPairsRun }` (`src/solvers/index.ts:43-47`).

### `summarize(report: SolverReport): string`

One-line summary plus `[kind / source / confidence] message` per finding (`src/solvers/index.ts:116-124`).

## `src/solvers/types.ts`

### `type SolverFinding`

Discriminated union: `ExactDuplicate | Contradiction | Subsumption | Ambiguity | NeedsReview` (`src/solvers/types.ts:30-72`).

### `type CandidatePair`

`{ a: string; b: string; reason: 'same-system-same-trigger-different-response' | 'same-system-overlapping-precondition' | 'near-duplicate-sentence' }` (`src/solvers/types.ts:75-83`).

### `type ReqView`

Solver-side projection of `Requirement` (omits sentence-irrelevant fields like timestamps and edge arrays) (`src/solvers/types.ts:86-97`).

### `asView(r: Requirement): ReqView`

Projector (`src/solvers/types.ts:99-111`).

## `src/solvers/free/`

### `detectExactDuplicates(reqs: ReqView[]): SolverFinding[]`

Hash-tuple grouping; emits one finding per pair within each duplicate group (`src/solvers/free/duplicates.ts:12-46`).

### `detectAmbiguity(reqs: ReqView[]): SolverFinding[]`

Word-boundary scan against `WEASEL_PHRASES` over `preCondition + trigger + systemResponse` (`src/solvers/free/ambiguity.ts:100-122`).

### `emitCandidatePairs(reqs: ReqView[], opts?: { similarityThreshold?: number }): CandidatePair[]`

Three-rule structural filter; default similarity threshold 0.7 (`src/solvers/free/pairwise-filter.ts:40-101`).

## `src/solvers/llm/`

### `type CallModel`

`(args: CallModelArgs) => Promise<{ output: Record<string, unknown>; rawText?: string }>` (`src/solvers/llm/bedrock-client.ts:48-51`).

### `bedrockCallModel: CallModel`

Production Converse-API impl with forced tool use (`src/solvers/llm/bedrock-client.ts:61-107`).

### `MODELS = { primary, secondary }`

Env-driven defaults: `BEDROCK_MODEL_PRIMARY` (`amazon.nova-2-lite-v1:0`), `BEDROCK_MODEL_SECONDARY` (`zai.glm-5-v1:0`) (`src/solvers/llm/bedrock-client.ts:113-116`).

### `judgePair(call, modelId, a, b, pair): Promise<PairJudgment>`

Pairwise judge; output schema enum: `contradiction | subsumption | redundant | compatible` (`src/solvers/llm/judge-pair.ts:88-104`).

### `judgeAmbiguity(call, modelId, r): Promise<AmbiguityJudgment>`

Single-requirement contextual ambiguity judge (`src/solvers/llm/judge-ambiguity.ts:69-83`).

### `ensemblePair(cfg, a, b, pair): Promise<SolverFinding[]>` and `ensembleAmbiguity(cfg, r): Promise<SolverFinding[]>`

Two-model reconciliation with optional arbiter escalation on disagreement (`src/solvers/llm/ensemble.ts:39-80`, `src/solvers/llm/ensemble.ts:223-229`).

### `reconcilePair`, `reconcileAmbiguity`

Pure reconciliation functions exposed for unit testing without I/O (`src/solvers/llm/ensemble.ts:202-219`, `src/solvers/llm/ensemble.ts:231-263`).

### `bedrockArbiter: CallArbiter` and `ARBITER` const

Opus 4.7 InvokeModel impl with adaptive thinking, configurable effort, forced tool use; `ARBITER.modelId`, `ARBITER.effort`, `ARBITER.maxTokens` resolve from env (`src/solvers/llm/arbiter.ts:86-99`, `src/solvers/llm/arbiter.ts:276-328`).

### `type ArbitrationInput`, `type ArbitrationVerdict`, `type CallArbiter`

Verdict shape: `{ finalJudgment, whichOf, confidence, agreedWith, rationale, caveat?, thinkingSignature? }` (`src/solvers/llm/arbiter.ts:48-70`).

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [MCP tool reference](rpc-tools.md)
- [Data flow](../architecture/data-flow.md)
