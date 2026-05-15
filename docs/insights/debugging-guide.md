# symspec · Debugging guide

When something breaks, where to look. Failure modes mapped to error surfaces and first-checks ladders.

## Failure-mode index

| Symptom | Most likely cause | First file to read |
|---|---|---|
| `Requirement <id> already exists` | Duplicate `CreateRequirement` with the same UUID — caller didn't generate a fresh `newId()` | `src/core/doc.ts:65-66` |
| `Requirement <id> not found` (UpdateAttribute) | Stale id; the doc was reloaded from disk and the id is from an in-memory state | `src/core/doc.ts:103-104` |
| `Requirement <id> not found` (AddRelationship) | Edge added before the source node was created; or the source was deleted concurrently | `src/core/doc.ts:133-134` |
| `Cannot null required attribute "<attr>"` | Caller tried to clear a non-`NULLABLE_ATTRS` field | `src/core/doc.ts:111-113`, `src/core/schema.ts:60-64` |
| ZodError on `applyChange` | Raw Change shape doesn't match `ChangeSchema` — usually a missing required field or wrong enum value | `src/core/schema.ts:375-432`, `src/core/doc.ts:59` |
| Sentence didn't re-render after update | Edit was on a metadata attr, not an EARS slot — by design | `src/core/doc.ts:118-127` |
| MCP tool call returns text but the agent reports JSON parse error | `analysis_run` returns *two* text content blocks: a summary plus the JSON. The agent must read the second block. | `src/mcp/server.ts:246-250` |
| `Model <id> did not call <toolName>` | Bedrock model returned prose instead of the forced tool call. Usually a model-id typo or a regional inference-profile mismatch | `src/solvers/llm/bedrock-client.ts:98-101` |
| `Arbiter <id> did not call report_arbitration` | Same, but for Opus 4.7 over InvokeModel | `src/solvers/llm/arbiter.ts:308-317` |
| HTTP 400 from Bedrock arbiter | Likely the `thinking` shape — Opus 4.7 rejects `{ enabled, budget_tokens }`, requires `{ type: 'adaptive', display: 'summarized' }` | `src/solvers/llm/arbiter.ts:277-284` |
| `pnpm install` repeatedly fails or `pnpm exec` errors after a fresh clone | pnpm 11 `verify-deps-before-run` fired the `prepare` hook in a non-git dir | `.erpaval/solutions/conventions/pnpm11-prepare-script-and-git-init-order.md` |
| lefthook hooks silently never fire | Amazon corp laptop's git-defender set `core.hooksPath` globally | `.erpaval/solutions/conventions/lefthook-vs-amazon-git-defender-hookspath.md` |
| TS error: `Type X is not assignable to type Y { foo?: T }` with `exactOptionalPropertyTypes` | Caller passed `{ foo: undefined }` instead of omitting `foo` | `.erpaval/solutions/conventions/exact-optional-property-types-omit-key-idiom.md`, `tsconfig.json:9` |
| Biome warns on `arr[i]!` in tight loops | `style/noNonNullAssertion` was double-warning the `noUncheckedIndexedAccess` idiom | `biome.json:21` (rule turned off), `.erpaval/solutions/conventions/biome-noNonNullAssertion-off-when-noUncheckedIndexedAccess.md` |

## Error surfaces

The codebase has a small, deliberate set of throw sites:

| Source | Throws on | File |
|---|---|---|
| `applyChange` (CreateRequirement) | duplicate id | `src/core/doc.ts:66` |
| `applyChange` (UpdateAttribute) | unknown id | `src/core/doc.ts:104` |
| `applyChange` (UpdateAttribute) | null on required attr | `src/core/doc.ts:112` |
| `applyChange` (AddRelationship) | unknown source id | `src/core/doc.ts:134` |
| `bedrockCallModel` | model didn't call the forced tool | `src/solvers/llm/bedrock-client.ts:100` |
| `bedrockArbiter` | arbiter didn't call `report_arbitration` | `src/solvers/llm/arbiter.ts:314` |
| Mock arbiter (test only) | arbiter invoked on a pair that wasn't supposed to disagree | `scripts/smoke-solvers.ts:330-332` |

`ChangeSchema.parse` and `RequirementSchema.parse` throw `ZodError` directly; the catch site is the caller's responsibility (the CLI prints the stack and exits non-zero, the MCP server returns the error to the client per `@modelcontextprotocol/sdk` conventions).

## Logging surfaces

There's no logging layer. Three observable surfaces:

- **CLI stdout/stderr.** `console.log` for happy paths, `console.error` then `process.exit(1)` on failure (`src/cli/index.ts:128-131`, `:171-173`).
- **MCP text-content blocks.** Tools return `{ content: [{ type: 'text', text }] }`; failure modes throw the same way Zod does (`src/mcp/server.ts:81-89`, `:113-117`, etc.).
- **Smoke-script `console.log` headers.** Each step prints a `=`-bordered banner (`scripts/smoke.ts:22-26`).

## First-checks ladder

When debugging an unknown breakage, walk this top to bottom:

1. **Is the doc shape valid?** `pnpm cli show <doc> <id>` — if Zod throws on the snapshot (`src/core/doc.ts:187-189`) the doc was written by an older schema version. `SCHEMA_VERSION` is at `src/core/schema.ts:512`.
2. **Are tests green?** `pnpm test`. The suite is fast (3 files, 316 LOC). A failing schema test usually means the renderer or `Finding` union changed without updating the test.
3. **Does typecheck pass?** `pnpm typecheck`. The repo runs `tsc --noEmit` with `strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes` (`tsconfig.json:6-9`); type errors here are usually the `exactOptionalPropertyTypes` idiom (omit-the-key, not `undefined`-assign — see `.erpaval/solutions/conventions/exact-optional-property-types-omit-key-idiom.md`).
4. **Does Biome pass?** `pnpm lint`. Failures are mechanical; `pnpm lint:fix` solves most.
5. **Is knip clean?** `pnpm knip`. A new finding here means an import was added without a corresponding `package.json` entry.
6. **Smoke scripts.** `pnpm smoke:all` runs all three end-to-end. The incremental script (`scripts/smoke-incremental.ts:62-336`) is the densest behavior catalog and catches edge cases the unit tests don't.
7. **Live Bedrock.** `BEDROCK_LIVE=1 pnpm smoke:solvers` (`scripts/smoke-solvers.ts:180`). Network errors here mean AWS credentials or region; "did not call tool" means model-id mismatch.

## Recovery from broken state

- **Corrupted `.automerge` file.** Delete it; `symspec init` creates a fresh empty doc (`src/cli/index.ts:43-45`).
- **MCP server stuck on a bad doc.** Set `SYMSPEC_DOC=/tmp/scratch.automerge` and restart (`src/mcp/server.ts:43`).
- **Concurrent-edit confusion.** `symspec merge a b out` to flatten, then `symspec analyze out` to see what the CRDT couldn't resolve (`src/cli/index.ts:194-203`).

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [Tech debt register](tech-debt.md)
- [Processes](../behavior/processes.md)
