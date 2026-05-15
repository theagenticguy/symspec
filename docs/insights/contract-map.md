# symspec · Contract map

What each module assumes about its callers and callees. The single-source-of-truth design (atomic Zod fields → composed schemas → MCP shapes) means most contracts live inside `src/core/schema.ts`; the contracts here are the ones *between* modules that span more than one file.

## `applyChange` ⇄ Automerge proxy

Producer: callers (CLI, MCP, smoke scripts).
Consumer: `Automerge.change(doc, draft => …)` (`src/core/doc.ts:62-159`).

- **Shape:** `Change` validated by `ChangeSchema` (`src/core/schema.ts:375-432`).
- **Contract:**
  - Caller passes `unknown`; `applyChange` parses (`src/core/doc.ts:59`). Callers are not required to pre-validate.
  - Inside the proxy callback, **Automerge rejects `undefined`** — only set fields that have a defined value. The optional-slot guards at `src/core/doc.ts:94-97` exist for exactly this reason.
  - Inside the proxy callback, **`null` is a sentinel for "delete this key"** for `NULLABLE_ATTRS` only. Implemented via `delete target[change.attr]` (`src/core/doc.ts:114`).
  - Mutations on the proxy must complete synchronously; Automerge is not async-safe inside `change(...)`.

## `applyChange` ⇄ `renderSentence`

Producer: `applyChange` (CreateRequirement and UpdateAttribute branches).
Consumer: `renderSentence(r)` (`src/core/schema.ts:443-464`).

- **Shape:** `Pick<Requirement, 'patternType'|'preCondition'|'trigger'|'systemName'|'systemResponse'>`.
- **Contract:** the renderer accepts undefined `preCondition`/`trigger` and emits `''` placeholders for missing required slots (`src/core/schema.ts:454-462`). This is by design — pattern-required slots are not enforced at write time; missing slots become `Finding`s.

## CLI / MCP ⇄ `applyChange`

Producer: `src/cli/index.ts:60`, `:84`, `:98`, `:113`, `:133`, `:148` and `src/mcp/server.ts:74`, `:106`, `:132`, `:162`, `:195`.
Consumer: `applyChange` (`src/core/doc.ts:58-160`).

- **Shape:** raw object literals matching `ChangeSchema` discriminants.
- **Contract:**
  - Callers must NOT include `undefined` in object literals — Automerge bubbles this up as an internal error inside the proxy. The CLI's `add` command relies on commander never passing `undefined` for `--<flag>` options that weren't given (commander omits the key).
  - The MCP server's `requirement_create` tool has a similar invariant: it spreads the `args` shape and the per-tool input shape's `.optional()` Zod marker means missing args arrive as omitted properties, not as `undefined` (`src/mcp/server.ts:74-78`, `src/core/schema.ts:319-328`).
  - Callers DO own UUID generation for `CreateRequirement` (`src/cli/index.ts:59`, `src/mcp/server.ts:73`); the runtime never auto-assigns from inside `applyChange`.

## MCP server ⇄ `@modelcontextprotocol/sdk`

Producer: tool registrations in `src/mcp/server.ts:59-273`.
Consumer: `McpServer.tool(name, description, inputShape, handler)` (`@modelcontextprotocol/sdk/server/mcp`).

- **Shape:** `inputShape` is a `ZodRawShape` — a plain object whose values are Zod schemas. The SDK derives the JSON Schema from this for `tools/list`.
- **Contract:**
  - The `.describe()` text on every Zod field schema is what the LLM sees in `tools/list`. Field schemas live in `src/core/schema.ts:199-257`; reusing them via `*InputShape` exports is the design that prevents description drift.
  - Tool handlers return `{ content: [{ type: 'text', text }] }`. The SDK serializes to the MCP wire protocol.
  - Tool names follow `noun_verb` so `tools/list` groups by domain object (`src/mcp/server.ts:11-12`).

## `runSolvers` ⇄ `CallModel`

Producer: `runSolvers` (`src/solvers/index.ts:75-94`).
Consumer: any `CallModel` impl — `bedrockCallModel` (production) or a mock (tests).

- **Shape:** `CallModel = (args: CallModelArgs) => Promise<{ output: Record<string, unknown>; rawText?: string }>` (`src/solvers/llm/bedrock-client.ts:48-51`).
- **Contract:**
  - The implementation MUST force the model to call the named tool and return the tool input as `output`. Bedrock validates the tool input against `toolInputSchema` on its side.
  - The implementation MUST throw if the model didn't call the tool (`src/solvers/llm/bedrock-client.ts:98-101`). Tests rely on this for fail-fast diagnostics.
  - Mocks must mimic the full schema; the smoke-test mock at `scripts/smoke-solvers.ts:187-264` returns the exact `judgment | confidence | rationale` shape.

## `runSolvers` ⇄ `CallArbiter`

Producer: `ensemblePair` (`src/solvers/llm/ensemble.ts:57-67`).
Consumer: any `CallArbiter` impl.

- **Shape:** `(input: ArbitrationInput) => Promise<ArbitrationVerdict>` (`src/solvers/llm/arbiter.ts:48-70`).
- **Contract:**
  - Called only when the two judges disagree (the agreement path skips the arbiter). Bound: at most one arbiter call per candidate pair per `runSolvers` invocation.
  - Verdict's `whichOf` is interpreted relative to the *caller's* `input.a` and `input.b`, not absolute by node id. Mock arbiters must compute `whichOf` from the input order (`scripts/smoke-solvers.ts:316-318` shows the idiom).
  - Verdict's `agreedWith` is informational; the ensemble doesn't gate on it.

## `analyze` ⇄ doc shape

Producer: `analyze` (`src/core/analyze.ts:23`).
Consumer: callers reading `Finding[]` (CLI `req analyze`, MCP `analysis_run`).

- **Shape:** `Finding[]` discriminated on `kind` (`src/core/schema.ts:470-496`).
- **Contract:**
  - `analyze` runs over a `snapshot()`'d doc — Automerge proxies are stripped first (`src/core/analyze.ts:24`). Callers never receive Automerge proxy objects in findings.
  - `OrphanRequirement` is suppressed when `reqs.length === 1` — a single-node doc is not an orphan (`src/core/analyze.ts:90`). Callers should treat this as a deliberate threshold, not an off-by-one.
  - Findings are read-only diagnostics. `analyze` does not mutate the doc and is safe to call any number of times (`src/mcp/server.ts:239`).

## `bedrockArbiter` ⇄ Anthropic Messages format

Producer: `bedrockArbiter` (`src/solvers/llm/arbiter.ts:276-328`).
Consumer: Bedrock's `InvokeModel` with the Anthropic-on-Bedrock body shape.

- **Shape contract** for Opus 4.7:
  - `anthropic_version: 'bedrock-2023-05-31'` (`src/solvers/llm/arbiter.ts:278`).
  - `thinking: { type: 'adaptive', display: 'summarized' }` — the only supported shape for Opus 4.7. Older `{ enabled, budget_tokens }` is rejected with HTTP 400 (`src/solvers/llm/arbiter.ts:283`).
  - `output_config: { effort: 'low'|'medium'|'high'|'xhigh'|'max' }` controls thinking depth; `xhigh` is the default and the recommended starting point for arbitration (`src/solvers/llm/arbiter.ts:284`).
  - `tool_choice: { type: 'tool', name: 'report_arbitration' }` forces the model to emit the structured verdict (`src/solvers/llm/arbiter.ts:293`).
  - User message is XML-tagged (`<requirement_a>`, `<requirement_b>`, `<free_tier_reason>`, `<prior_judgment role="...">`, `<task>`, `<instructions>`) per Anthropic prompting conventions (`src/solvers/llm/arbiter.ts:189-209`).
  - Critical instructions at the top of the system prompt AND the bottom of the user message (`src/solvers/llm/arbiter.ts:111-141`, `:200-208`).

## `RequirementSchema` ⇄ `.automerge` on disk

Producer: `Automerge.save(doc)` over a doc whose root matches `RequirementsDoc` (`src/core/schema.ts:507-510`).
Consumer: `Automerge.load` followed by reads through `applyChange` / `analyze` / `exportSysml`.

- **Contract:**
  - `schemaVersion: number` is at the doc root (`src/core/schema.ts:508`). Currently `1` (`src/core/schema.ts:512`); migrating to v2 would require a migrator that runs at load time (none exists yet — see `insights/tech-debt.md`).
  - `requirements: Record<string, Requirement>` is a flat map keyed by UUID (`src/core/schema.ts:509`). Flat-map shape is the CRDT-friendly choice — no array indices for replicas to fight over (`src/core/schema.ts:502-510`, README "deep dive" makes the case explicit at `README.md:73-79`).

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [Tech debt register](tech-debt.md)
- [Dead code](../analysis/dead-code.md)
