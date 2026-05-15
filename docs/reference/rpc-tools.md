# symspec · MCP tool reference

The MCP server registers 8 tools through `@modelcontextprotocol/sdk`'s `McpServer.tool()` API over a `StdioServerTransport` (`src/mcp/server.ts:50-53`, `src/mcp/server.ts:275-276`). All tool input shapes are imported verbatim from `src/core/schema.ts` so the JSON Schema the LLM sees in `tools/list` carries the same `.describe()` text every other layer uses (`src/mcp/server.ts:1-19`).

Document path: resolved at server start from `process.env.REQ_DOC` with fallback `./requirements.automerge` (`src/mcp/server.ts:43`). The doc is created on first access if missing (`src/mcp/server.ts:46-48`).

## Mutation tools

### `requirement_create`

Create a new EARS requirement node and return its assigned UUID (`src/mcp/server.ts:59-90`).

```ts
input: RequirementCreateInputShape  // src/core/schema.ts:319-328
{
  patternType: 'ubiquitous'|'event-driven'|'state-driven'|'optional-feature'|'unwanted-behavior',
  systemName:  string,
  systemResponse: string,
  trigger?:        string,
  preCondition?:   string,
  priority?:       'low'|'medium'|'high'|'critical',     // default 'medium'
  status?:         'draft'|'approved'|'implemented'|'verified',  // default 'draft'
  verificationMethod?: 'test'|'inspection'|'analysis'|'demonstration'
}
```

The runtime generates the UUID, renders the canonical sentence via `renderSentence`, and fills in defaults (`src/mcp/server.ts:71-79`). Pattern-required slots are not enforced; missing slots surface as findings on the next `analysis_run` call.

Returns: `Created <uuid>\n<rendered sentence>`.

### `requirement_update`

Patch exactly one typed attribute on an existing requirement (`src/mcp/server.ts:92-117`).

```ts
input: RequirementUpdateInputShape  // src/core/schema.ts:330-334
{ id: string, attr: UpdatableAttr, value: string | null }
```

`UpdatableAttr` is one of `patternType | preCondition | trigger | systemName | systemResponse | priority | status | verificationMethod` (`src/core/schema.ts:47-57`). EARS-slot updates re-render the sentence; metadata updates don't (`src/core/doc.ts:118-127`). `value: null` clears an optional attr (`preCondition`, `trigger`, `verificationMethod`); null on a required attr throws (`src/core/doc.ts:108-113`). Errors when `id` does not resolve.

### `relationship_add`

Add a typed directional edge from one requirement to another (`src/mcp/server.ts:119-148`).

```ts
input: RelationshipAddInputShape  // src/core/schema.ts:336-351
{ from: string, relation: 'derives'|'satisfies'|'verifies'|'refines', to: string }
```

Idempotent — adding the same edge twice produces a single edge (`src/core/doc.ts:135-136`). Errors if `from` does not exist; if `to` later disappears the edge becomes a dangling reference surfaced by `analysis_run` (`src/core/doc.ts:133-138`).

### `relationship_remove`

Remove a typed edge (`src/mcp/server.ts:150-178`).

```ts
input: RelationshipRemoveInputShape  // src/core/schema.ts:353-357
{ from: string, relation: 'derives'|'satisfies'|'verifies'|'refines', to: string }
```

No-op if the edge isn't present, including if the source no longer exists (`src/core/doc.ts:142-147`).

### `requirement_delete`

Tombstone a requirement (`src/mcp/server.ts:180-199`).

```ts
input: RequirementDeleteInputShape  // src/core/schema.ts:359-367
{ id: string }
```

Inbound edges from surviving requirements become dangling references — they are not auto-removed (`src/core/doc.ts:151-157`).

## Read tools

### `requirements_list`

Compact JSON array of `{ id, patternType, priority, status, sentence }` per requirement (`src/mcp/server.ts:205-228`).

```ts
input: {}
```

Returns enough to scan the spec at a glance without fetching every full node.

### `analysis_run`

Run the analysis pass and return findings (`src/mcp/server.ts:230-253`).

```ts
input: {}
```

Returns two text blocks: the human-readable summary plus the JSON `Finding[]` array. Findings cover dangling references, missing EARS slots, derive cycles, orphans (`src/core/analyze.ts:23-100`). Read-only — does not modify the doc.

### `sysml_export`

SysML-v2-flavored JSON of the requirements graph (`src/mcp/server.ts:255-273`).

```ts
input: {}
```

Returns one text block containing the JSON: `{ '@context': 'https://www.omg.org/spec/SysML/v2', schemaVersion, elements: RequirementUsage[], relationships: (DeriveRequirement|Satisfy|Verify|Refine)[] }` (`src/core/sysml-export.ts:35-40`, `src/core/sysml-export.ts:42-47`). Read-only.

## Tool description conventions

Every tool description follows `<what> / <when> / <returns + side effects> / <idempotency + error modes>`, and every mutating tool ends with a hint about calling `analysis_run` next (`src/mcp/server.ts:9-19`). Per-argument descriptions live on the field schemas in `src/core/schema.ts`, not on the tool registrations — this is the single-source-of-truth design (`src/mcp/server.ts:6-8`).

## Wiring into Claude Code

The `.mcp.json` snippet at `integration/mcp-config.json:1-19` shows the canonical wiring. Env knobs:

| Variable | Default | Purpose |
|---|---|---|
| `REQ_DOC` | `./requirements.automerge` | per-session doc path (`src/mcp/server.ts:43`) |
| `AWS_REGION` | `us-east-1` | Bedrock region (`src/solvers/llm/bedrock-client.ts:53`, `src/solvers/llm/arbiter.ts:76`) |
| `BEDROCK_MODEL_PRIMARY` | `amazon.nova-2-lite-v1:0` | primary judge (`src/solvers/llm/bedrock-client.ts:114`) |
| `BEDROCK_MODEL_SECONDARY` | `zai.glm-5-v1:0` | secondary judge (`src/solvers/llm/bedrock-client.ts:115`) |
| `BEDROCK_ARBITER_MODEL` | `global.anthropic.claude-opus-4-7-v1:0` | arbiter model (`src/solvers/llm/arbiter.ts:87`) |
| `BEDROCK_ARBITER_EFFORT` | `xhigh` | adaptive-thinking effort (`src/solvers/llm/arbiter.ts:93`) |
| `BEDROCK_ARBITER_MAX_TOKENS` | `64000` | output ceiling (`src/solvers/llm/arbiter.ts:98`) |

The `analysis_run` tool currently runs the four-check pass in `src/core/analyze.ts:23-100`, not the solver pipeline in `src/solvers/index.ts:49-110` — the structural-checks-only path. To expose solver findings (Contradiction / Subsumption / Ambiguity / NeedsReview) the tool would need to call `runSolvers` instead. See `insights/tech-debt.md` for the gap.

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [Public API](public-api.md)
- [Data flow](../architecture/data-flow.md)
