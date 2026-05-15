# symspec · Dead code

`pnpm knip` exits clean. No findings against the `knip.json` config that scans `src/**/*.ts` and `scripts/**/*.ts`. The config sets `dependencies: error`, `devDependencies: warn`, `unlisted: error`, and `ignoreExportsUsedInFile: true`. Source: `knip.json:1-10`. The repo also runs `knip --no-progress` as a `pre-push` hook at `lefthook.yml:21-22`. At this size the audit is meaningful. The repo has 19 source files and 4 entry points. The entry points are `bin/req.mjs`, `bin/req-mcp.mjs`, and the smoke scripts.

## Unreferenced exports

knip is configured with `exports: off`, so per-export reports are suppressed at `knip.json:7`. A manual scan against the actual import graph follows.

| Symbol | File | Status |
|---|---|---|
| `_listRequirements` | `src/core/analyze.ts:152` | Re-export-as-side-effect to suppress unused-import warning when only `Finding` is type-imported. Intentional. The `_` prefix marks the convention. |
| `reconcilePair` | `src/solvers/llm/ensemble.ts:202-219` | Exposed only for tests per its docstring. Tests do not currently import it. No `ensemble.test.ts` exists. Effectively unused by both runtime and tests. |
| `reconcileAmbiguity` | `src/solvers/llm/ensemble.ts:231-263` | Same as `reconcilePair`. Exposed but no test consumer. |

## Unreferenced files

None. Every TS file under `src/` is reachable from at least one of the CLI entry, the MCP entry, a smoke script, or a test file.

| File | Reachability |
|---|---|
| `src/cli/index.ts` | `bin/req.mjs:2` |
| `src/mcp/server.ts` | `bin/req-mcp.mjs:2` |
| `src/core/doc.ts` | imported by cli, mcp, all smoke scripts, tests |
| `src/core/schema.ts` | imported by every other src file |
| `src/core/analyze.ts` | cli, mcp, smoke.ts, tests |
| `src/core/sysml-export.ts` | cli, mcp, smoke.ts |
| `src/solvers/index.ts` | smoke-solvers.ts |
| `src/solvers/types.ts` | every solver file |
| `src/solvers/free/*.ts` | `src/solvers/index.ts:16-18` |
| `src/solvers/llm/*.ts` | `src/solvers/index.ts:19-21`, `scripts/smoke-solvers.ts:20-23` |

## Unreferenced imports

None detected. Every `import` statement in `src/` resolves to a symbol used in the file. Spot-checks below:

- `src/core/doc.ts:12-22` uses every imported symbol. The symbols are `randomUUID`, `readFile`, `writeFile`, `Automerge`, `ChangeSchema`, `NULLABLE_ATTRS`, `Requirement`, `RequirementsDoc`, `renderSentence`, `SCHEMA_VERSION`.
- `src/mcp/server.ts:21-41` uses every import.
- `src/solvers/llm/arbiter.ts:40-42` uses every import.

## Build-tooling reachability

The full quality gate is `pnpm check`. The gate runs `biome ci && tsc --noEmit && vitest run && knip` per `package.json:27`. All four run against the same surface. Nothing is gated behind an environment variable except live Bedrock calls at `BEDROCK_LIVE=1` in `scripts/smoke-solvers.ts:180`. The optional `BEDROCK_ARBITER_*` env knobs at `src/solvers/llm/arbiter.ts:87-99` are also opt-in.

## Confidence

Knip's `unlisted: error` mode catches dependency drift. The `pre-push` hook means dead code that lands on `main` would have to bypass git hooks. Amazon git-defender wouldn't, per `.erpaval/solutions/conventions/lefthook-vs-amazon-git-defender-hookspath.md`. The two `reconcile*` functions are the only legitimate "dead until tested" surface. Documenting them is enough.

## See also

- [Contract map](../insights/contract-map.md)
- [Behavioral sequences](../diagrams/behavioral/sequences.md)
- [Dependency graph](../diagrams/structural/dependency-graph.md)
- [Impact analysis](../insights/impact-analysis.md)
