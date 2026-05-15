# symspec · Dependency graph

Internal modules are blue. External npm dependencies that participate in the runtime are gold. Test-runner deps such as vitest, lint deps such as Biome, and dead-code deps such as knip are omitted because they don't appear in the runtime call graph.

```mermaid
flowchart LR
  classDef internal fill:#1e3a5f,stroke:#4a8bc2,color:#fff
  classDef external fill:#705a1a,stroke:#d4a437,color:#fff

  bin_req[bin/symspec.mjs]:::internal
  bin_mcp[bin/symspec-mcp.mjs]:::internal
  cli[src/cli]:::internal
  mcp[src/mcp]:::internal
  core[src/core]:::internal
  solvers[src/solvers]:::internal
  scripts[scripts/]:::internal

  zod[(zod)]:::external
  automerge[(@automerge/automerge)]:::external
  commander[(commander)]:::external
  mcp_sdk[(@modelcontextprotocol/sdk)]:::external
  bedrock[(@aws-sdk/client-bedrock-runtime)]:::external
  node[(node:crypto / node:fs)]:::external

  bin_req --> cli
  bin_mcp --> mcp
  cli --> core
  cli --> commander
  mcp --> core
  mcp --> mcp_sdk
  scripts --> core
  scripts --> solvers
  scripts --> automerge
  solvers --> core
  solvers --> bedrock
  core --> automerge
  core --> zod
  core --> node
```

## Legend

| Node | Resolves to | Source |
|---|---|---|
| `bin/symspec.mjs` | dynamic import of `dist/cli.mjs` | `bin/symspec.mjs:1-2` |
| `bin/symspec-mcp.mjs` | dynamic import of `dist/mcp.mjs` | `bin/symspec-mcp.mjs:1-2` |
| `src/cli` | `src/cli/index.ts` | `src/cli/index.ts:19-32` |
| `src/mcp` | `src/mcp/server.ts` | `src/mcp/server.ts:21-41` |
| `src/core` | `schema.ts`, `doc.ts`, `analyze.ts`, `sysml-export.ts` | — |
| `src/solvers` | free + llm subtrees plus `index.ts` and `types.ts` | — |
| `zod` | `^3.23.8` | `package.json:39` |
| `@automerge/automerge` | `^2.2.8` | `package.json:35` |
| `commander` | `^12.1.0` | `package.json:38` |
| `@modelcontextprotocol/sdk` | `^1.0.0` | `package.json:37` |
| `@aws-sdk/client-bedrock-runtime` | `^3.1045.0` | `package.json:36` |
| `node:crypto` and `node:fs/promises` | Node ≥ 24 stdlib | `src/core/doc.ts:12-13`, `package.json:31` |

The graph is a strict DAG. Every internal arrow flows downward toward `core`. The two surfaces, `cli` and `mcp`, are siblings. Neither depends on the other. Both go through `applyChange` for behavior parity. The `solvers` module depends on `core` for `Doc` and `Requirement` types, but the inverse does not hold. The structural analysis pass in `core` does not call into the LLM tier.

## See also

- [Dead code](../../analysis/dead-code.md)
- [Module map](../../architecture/module-map.md)
- [System overview](../../architecture/system-overview.md)
- [Data flow](../../architecture/data-flow.md)
