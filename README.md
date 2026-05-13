# ears-validated POC

A working proof-of-concept that demonstrates the architecture we converged on in chat:

- **Storage layer:** Automerge CRDT — JSON-shaped, automatic merge of concurrent edits, full history DAG.
- **Public API layer:** typed Change records (`CreateRequirement`, `UpdateAttribute`, `AddRelationship`, `RemoveRelationship`, `DeleteRequirement`) referencing elements by stable UUID, never by JSON path.
- **Domain layer:** SysML-v2-shaped Requirement nodes with EARS slots (`patternType`, `preCondition`, `trigger`, `systemName`, `systemResponse`) plus typed metadata (`priority`, `status`, `verificationMethod`) and typed relationship arrays (`derives`, `satisfies`, `verifies`, `refines`).
- **Analysis layer:** dangling-reference detection, EARS slot validation, derive-cycle detection, orphan detection. Findings shape matches the Kiro "analyze requirements then clarify" loop.
- **Two surfaces** over the same core: a `req` CLI and an MCP server (using `@modelcontextprotocol/sdk`). An agent can drive the graph through MCP tools; a human can drive the same graph through the CLI; both serialize through the same Change-record API.
- **SysML v2-flavored JSON export** as the interchange format.

## Setup

```bash
pnpm install
pnpm smoke         # concurrent-edits demo: two replicas, merge, dangling-ref analysis
pnpm smoke:inc     # incremental-updates demo: sequential edits, null clears, idempotency, persistence
pnpm smoke:all     # both
```

## CLI usage

```bash
pnpm cli init reqs.automerge
pnpm cli add reqs.automerge --pattern event-driven --system "auth service" \
  --response "issue a session token" --trigger "the user submits valid credentials"
pnpm cli list reqs.automerge
pnpm cli analyze reqs.automerge
pnpm cli export reqs.automerge
```

The merge demo (without the CLI) is in `scripts/smoke.ts` — it forks the doc into two replicas, makes concurrent edits (one adds an edge, the other deletes the target), merges, and shows the dangling reference surfaced by the analysis pass.

## MCP server

```bash
REQ_DOC=./reqs.automerge pnpm mcp
```

Speaks MCP over stdio. Tools exposed:

- `requirement_create` — create a typed EARS node
- `requirement_update` — patch one typed slot
- `relationship_add` / `relationship_remove` — typed edges
- `requirement_delete` — tombstone
- `requirements_list` — read
- `analysis_run` — surface findings
- `sysml_export` — emit SysML-v2-flavored JSON

An agent connecting over MCP issues structured tool calls (which are the Change records); the server applies them to the Automerge doc; multiple agents/replicas can merge automatically.

## What this POC deliberately doesn't do

- **Real SysML v2 wire format.** The export is *flavored*, not spec-compliant. Swapping the export module for the Systems Modeling API OpenAPI payloads is a 200-line change.
- **Grammar-constrained generation from natural language.** The Change records arrive structured. The "EARS-from-prose" extraction would sit in front of this layer (e.g., Claude tool-use over the same MCP server).
- **Property-based test generation.** The next step. Each EARS slot set has enough structure to derive `forAll` properties — that's the Kiro "Correctness" workflow.
- **Referential integrity at the CRDT layer.** Dangling refs are caught by the analysis pass, not prevented at write time. Rich-CRDT approaches (ElectricSQL, Synql 2024) would push this earlier; for a POC it's overkill.

## File layout

```
src/
  core/
    schema.ts        # Requirement + Change + Finding zod schemas, EARS sentence rendering
    doc.ts           # Automerge wrapper: load/save/applyChange/merge
    analyze.ts       # dangling refs, missing slots, cycles, orphans
    sysml-export.ts  # JSON projection in SysML v2 shape
  cli/
    index.ts         # commander CLI
  mcp/
    server.ts        # @modelcontextprotocol/sdk stdio server
scripts/
  smoke.ts           # concurrent-edits demo + analysis assertions
bin/
  req.mjs            # CLI entry
  req-mcp.mjs        # MCP server entry
```
