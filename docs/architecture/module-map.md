# symspec · Module map

Top-level grouping is by directory under `src/` plus the sibling `scripts/` and `bin/` trees. The repo has 19 TypeScript source files outside tests. Source totals roughly 3270 LOC. Tests add 316 LOC across three files. Smoke scripts add 930 LOC.

## src/core

The single source of truth for the document shape, the EARS schema, the CRDT wrapper, and the SysML projection. 943 LOC across four files.

`schema.ts` is the largest at 512 LOC. It declares every atomic Zod field with rich `.describe()` text. The discriminated `ChangeSchema`, the per-tool input shapes, the `RequirementSchema`, and `renderSentence()` all compose from those atomic fields. Source: `src/core/schema.ts:1-512`.

`doc.ts` is the Automerge wrapper at 189 LOC. It exports `emptyDoc`, `loadDoc`, `saveDoc`, `applyChange`, `applyChanges`, `merge`, `listRequirements`, `getRequirement`, `snapshot`, `newId`. Source: `src/core/doc.ts:24-189`.

`analyze.ts` runs the structural pass at 152 LOC. It returns `Finding[]` covering dangling refs, missing-slot rules per pattern, derive cycles, and orphans. Cycle detection is DFS with canonical-rotation dedup. Source: `src/core/analyze.ts:23-100`. Cycle dedup detail: `src/core/analyze.ts:102-140`. The human-readable formatter is `summarizeFindings()` at `src/core/analyze.ts:142-147`.

`sysml-export.ts` projects `Doc` into the SysML JSON shape. 90 LOC. Source: `src/core/sysml-export.ts:49-90`.

## src/cli

One file: `index.ts`. 205 LOC. It defines 11 subcommands. The names are `init`, `add`, `update`, `derive`, `satisfy`, `remove-edge`, `delete`, `list`, `show`, `analyze`, `export`, `merge`. Source: `src/cli/index.ts:40-203`. Each command loads the doc, applies one Change, and saves. The `--pattern` enum reuses `EARS_PATTERNS` from `src/core/schema.ts:31`. The entry executable is `bin/symspec.mjs:1-2`.

## src/mcp

One file: `server.ts`. 276 LOC. It registers 8 tools through `McpServer.tool()`. The tool names are `requirement_create`, `requirement_update`, `relationship_add`, `relationship_remove`, `requirement_delete`, `requirements_list`, `analysis_run`, `sysml_export`. Source: `src/mcp/server.ts:59-273`. Each mutating tool's input shape is imported verbatim from `src/core/schema.ts`. The JSON Schema the LLM sees in `tools/list` therefore carries the same `.describe()` text the rest of the codebase uses. The default doc path resolves from `process.env.SYMSPEC_DOC` with fallback `./requirements.automerge`. Default doc path: `src/mcp/server.ts:43`. The entry executable is `bin/symspec-mcp.mjs:1-2`.

## src/solvers — orchestrator

The orchestrator and shared types live at the root. 235 LOC across two files.

`index.ts` exports `runSolvers(doc, opts)`. 124 LOC. The free tier always runs. The LLM tier runs when `opts.llm` is provided. The `CallModel` and optional `CallArbiter` are dependency-injected. Source: `src/solvers/index.ts:49-110`. LLM pair calls cap at `maxLlmPairs ?? 50` per `src/solvers/index.ts:83-84`.

`types.ts` defines the `SolverFinding` discriminated union, `CandidatePair`, `ReqView`, and the `asView()` projector. 111 LOC. Source: `src/solvers/types.ts:30-111`.

## src/solvers/free — deterministic tier

Three files totaling 269 LOC. Deterministic and in-process.

`duplicates.ts` hashes the full slot tuple. 46 LOC. It emits one finding per pair within a duplicate group. Source: `src/solvers/free/duplicates.ts:12-46`.

`ambiguity.ts` scans against a curated 35-phrase weasel-word list. 122 LOC. The scan uses word-boundary checks at `src/solvers/free/ambiguity.ts:75-98`. The phrase list lives at `src/solvers/free/ambiguity.ts:17-57`. 11 phrases carry `SUGGESTED_REWRITES` per `src/solvers/free/ambiguity.ts:59-73`.

`pairwise-filter.ts` applies three structural rules. 101 LOC. The rules: same trigger and different response gives a contradiction candidate; overlapping precondition gives a subsumption candidate; high lexical similarity gives a near-duplicate candidate. The Jaccard threshold defaults to 0.7. Source: `src/solvers/free/pairwise-filter.ts:40-101`.

## src/solvers/llm — Bedrock judges and arbiter

Five files totaling 894 LOC.

`bedrock-client.ts` defines the `CallModel` type and the `bedrockCallModel` impl. 116 LOC. The impl uses the Bedrock Converse API with forced tool use. Source: `src/solvers/llm/bedrock-client.ts:48-107`. `MODELS` resolves env vars `BEDROCK_MODEL_PRIMARY` and `BEDROCK_MODEL_SECONDARY`. Defaults are `amazon.nova-2-lite-v1:0` and `zai.glm-5-v1:0` per `src/solvers/llm/bedrock-client.ts:113-116`.

`judge-pair.ts` calls `report_pair_judgment` with the `JUDGMENT_SCHEMA`. 104 LOC. The classification is one of `contradiction`, `subsumption`, `redundant`, `compatible`. Source: `src/solvers/llm/judge-pair.ts:30-104`.

`judge-ambiguity.ts` calls `report_ambiguity`. 83 LOC. It flags contextual ambiguity that the lexical scan misses. Source: `src/solvers/llm/judge-ambiguity.ts:26-83`.

`ensemble.ts` reconciles two-model verdicts. 263 LOC. The pair path is `ensemblePair()` and the ambiguity path is `ensembleAmbiguity()`. On disagreement it either invokes the arbiter or emits `NeedsReview`. Source: `src/solvers/llm/ensemble.ts:39-80`. `applyArbiterVerdict()` translates the verdict into a `SolverFinding` at `src/solvers/llm/ensemble.ts:136-196`.

`arbiter.ts` calls Opus 4.7 via `InvokeModel`. 328 LOC. It uses adaptive thinking, `xhigh` effort, forced tool-use of `report_arbitration`, and an XML-tagged user message. Source: `src/solvers/llm/arbiter.ts:276-328`. Env-driven config lives in the `ARBITER` const at `src/solvers/llm/arbiter.ts:86-99`.

## scripts — smoke tests

Three files totaling 930 LOC.

`smoke.ts` is the concurrent-merge demo. 200 LOC. A shared base forks into Alice and Bob replicas. The replicas perform concurrent edits including a delete-vs-add-edge race. The script then merges, analyzes, and exports SysML. It also asserts merge-order equivalence. Source: `scripts/smoke.ts:29-200`.

`smoke-incremental.ts` covers 12 incremental scenarios. 339 LOC. The scenarios include save/load roundtrip, EARS-slot updates that re-render the sentence, metadata updates that don't, null-clear of optional attrs, idempotent `AddRelationship`, no-op `RemoveRelationship`, duplicate-create error, persistence, concurrent edits to different attrs, and concurrent edits to the same attr. Source: `scripts/smoke-incremental.ts:64-336`.

`smoke-solvers.ts` seeds 8 requirements with planted issues. 391 LOC. The script first runs the free-only path. Then it runs an ensemble without an arbiter and asserts `NeedsReview`. Then it runs an ensemble with the arbiter and asserts an arbitrated `Subsumption`. Setting `BEDROCK_LIVE=1` swaps the mocks for real Bedrock calls. Source: `scripts/smoke-solvers.ts:37-389`.

## bin

Two entry shims totaling 4 LOC. `symspec.mjs` does `import("../dist/cli/index.js")` per `bin/symspec.mjs:1-2`. `symspec-mcp.mjs` does `import("../dist/mcp/server.js")` per `bin/symspec-mcp.mjs:1-2`. They point at the compiled `dist/` output so the shims work both inside a checkout (after `pnpm build`) and in a globally installed tarball.

## integration

Drop-in artifacts for vendoring this MCP into a Claude Code project. `SKILL.md` carries the skill description, the mental model, four named workflows, and an anti-pattern catalog. Source: `integration/SKILL.md:1-138`. `mcp-config.json` is an `.mcp.json` snippet at `integration/mcp-config.json:1-19`. `README.md` carries wiring instructions at `integration/README.md:1-31`.

## .erpaval

Four `conventions/` lesson files plus an `INDEX.md` pointer. They document the canonical-TypeScript-stack edge cases this POC's setup hit. Source: `.erpaval/INDEX.md:9-14`. Lesson files use frontmatter so future sessions can grep by tag. The frontmatter fields are `title`, `track`, `category`, `module`, `severity`, `tags`, and `applies_when`.

## Tests

Three files totaling 316 LOC.

`schema.test.ts` covers `renderSentence` for all five EARS patterns. 143 LOC. It also covers `RequirementSchema` defaults and `CreateRequirementAttrsSchema`. Source: `src/core/__tests__/schema.test.ts:4-143`.

`analyze.test.ts` has six unit tests covering the five `Finding` kinds. 81 LOC. Source: `src/core/__tests__/analyze.test.ts:23-81`.

`duplicates.test.ts` covers `detectExactDuplicates` and `detectAmbiguity`. 92 LOC. Source: `src/solvers/free/__tests__/duplicates.test.ts:20-92`.

## See also

- [Public API](../reference/public-api.md)
- [Processes](../behavior/processes.md)
- [Business logic](../insights/business-logic.md)
- [Tech debt register](../insights/tech-debt.md)
