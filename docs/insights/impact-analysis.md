# symspec · Impact analysis

What breaks if you change one of the load-bearing surfaces. Ordered by blast radius.

## f, the atomic Zod field schemas

Source: `src/core/schema.ts:199-257`. Every other schema in the project composes from `f`. Touching one field's `.describe()` text propagates to MCP `tools/list`. The LLM sees the change. The Zod runtime validation also picks it up. Adding a new attribute is "edit one place" only because every consumer pulls from `f`.

Downstream effects of a change to `f.<field>`:

| Downstream | Effect |
|---|---|
| `RequirementSchema` at `src/core/schema.ts:263-291` | shape and runtime defaults shift; on-disk parse may reject older docs |
| `CreateRequirementAttrsSchema` at `src/core/schema.ts:294-312` | CLI `--<flag>` and MCP `requirement_create` accept new fields; missing-arg validation tightens |
| The five `*InputShape` exports at `src/core/schema.ts:319-367` | MCP `tools/list` JSON Schema regenerates; LLM tool-call args change shape |
| `ChangeSchema` at `src/core/schema.ts:375-432` | `applyChange` accepts or rejects different inputs; CLI and MCP both inherit the change |
| Sentence renderer at `src/core/schema.ts:443-464` | only impacted if the new field is one of the five EARS slots already enumerated in the switch |
| Solver `ReqView` at `src/solvers/types.ts:86-97` | unchanged unless the new field is added to the projection |

If the change adds a new EARS slot, both the renderer switch and `analyze`'s missing-slot rules need updating in lockstep.

## applyChange

Source: `src/core/doc.ts:58-160`. The only path through which mutations enter the doc. Every CLI subcommand and every mutating MCP tool funnels here. Three categories of consequence follow.

The first is the idempotency contracts. They are documented at `src/core/doc.ts:50-57`. Changing `AddRelationship` to error on duplicate edges would break `scripts/smoke-incremental.ts:188-237`. Changing `DeleteRequirement` to throw on missing id would break the MCP `relationship_remove` "safe to call defensively" guarantee at `src/mcp/server.ts:153-156`.

The second is the sentence re-render gate. The five-way `if` at `src/core/doc.ts:118-127` decides which `UpdateAttribute` calls re-render the sentence. Adding a slot to the gate without adding it to the renderer switch produces stale sentences silently.

The third is the null-clear policy. The `NULLABLE_ATTRS` set is the only gate on null assignment at `src/core/doc.ts:108-113`. Adding an attr to `NULLABLE_ATTRS` at `src/core/schema.ts:60-64` without making it optional in the schema produces a doc that fails `RequirementSchema.parse` after the next read.

## renderSentence

Source: `src/core/schema.ts:443-464`. Pure. Output is denormalized into every requirement node's `sentence` field. Changing the rendering rules without re-saving every existing doc leaves stored sentences inconsistent with the slots they were rendered from. The renderer is exhaustively exercised at `src/core/__tests__/schema.test.ts:4-76`. The `event-driven` plus preCondition combination is the one non-obvious case at `src/core/schema.ts:454-456`.

## analyze

Source: `src/core/analyze.ts:23-100`. Output drives the CLI `req analyze` UX at `src/cli/index.ts:181-184`. Output also drives the MCP `analysis_run` tool's text and JSON content at `src/mcp/server.ts:245-251`. The five `Finding.kind` discriminants are part of the CLAUDE-side contract. The SKILL.md workflow references each by name at `integration/SKILL.md:74-83`. Adding a new finding kind requires four edits:

1. A new branch in the `Finding` union at `src/core/schema.ts:470-496`.
2. Detection logic in `analyze()`.
3. A formatting branch in `summarizeFindings` at `src/core/analyze.ts:142-147`.
4. An entry in the SKILL.md "resolve_findings" priority order so the agent knows where to file it. Reference: `integration/SKILL.md:74-83`.

## runSolvers

Source: `src/solvers/index.ts:49-110`. The solver orchestrator. The `analysis_run` MCP tool currently does *not* call this. It calls only the structural `analyze()` at `src/mcp/server.ts:230-253`. Wiring `runSolvers` into `analysis_run` is a deliberate gap. Making the change requires four decisions:

1. Decide where `CallModel` and `CallArbiter` are configured. Options are env-driven, like `BEDROCK_*`, or per-call args.
2. Decide whether to merge `Finding[]` and `SolverFinding[]` into one envelope or return them separately.
3. Update the MCP tool description so the agent knows the new finding kinds. The new kinds are Contradiction, Subsumption, Ambiguity, NeedsReview. Reference: `src/mcp/server.ts:230-241`.
4. Update `integration/SKILL.md` workflows at `integration/SKILL.md:74-83`. They already reference these kinds because the SKILL was written assuming the integration would happen.

## bedrockArbiter

Source: `src/solvers/llm/arbiter.ts:276-328`. Fragile against three things.

The first is Bedrock's model-id format for the global cross-region inference profile. The current value is `global.anthropic.claude-opus-4-7-v1:0`. It is configurable via `BEDROCK_ARBITER_MODEL`.

The second is Anthropic's prompt-format conventions. The conventions are XML tags and instructions-at-top-and-bottom.

The third is the `thinking` parameter shape. Opus 4.7 only accepts `{ type: 'adaptive', display: 'summarized' }`. It rejects the older `{ enabled, budget_tokens }` shape with HTTP 400. Source: `src/solvers/llm/arbiter.ts:277-284`. A model upgrade that flips back to manual budgeting would require a code change here, not a config change.

## MCP tool input shapes

Source: `src/core/schema.ts:319-367`. Importing these into `src/mcp/server.ts:34-40` is what gives the LLM rich field descriptions in `tools/list`. Replacing any `*InputShape` with a hand-rolled Zod schema would silently lose the `.describe()` text on every field. The LLM would see "string" instead of "Phrase as a discrete event in present tense, no leading 'when' or 'if'" from `src/core/schema.ts:99-106`.

## Things that are not impactful

`merge()` at `src/core/doc.ts:172-174` is a pure pass-through to Automerge. Only the CLI `req merge` subcommand and smoke-test demonstrations use it. Removing it would force callers to import `Automerge.merge` directly. There is no semantic change.

`snapshot()` at `src/core/doc.ts:187-189` is `JSON.parse(JSON.stringify(doc))`. `analyze` and `exportSysml` use it internally to strip Automerge proxies. Replacing with a different deep-clone strategy is mechanical.

`summarize()` at `src/solvers/index.ts:116-124` is a formatter only. Its output is for human eyes, not parsed.

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [Processes](../behavior/processes.md)
- [Tech debt register](tech-debt.md)
