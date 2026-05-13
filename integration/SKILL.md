---
name: ears-validated
description: Use when authoring, refining, or validating EARS requirement specs through the ears-validated MCP server. Triggers when the user asks to "spec out", "write requirements for", "structure", or "review the spec for" a feature with non-trivial behavior; when CL-RIGOR routes to the EARS substep; when extending an existing requirements graph stored in `.erpaval/specs/*/requirements.automerge`; or when preparing a Gate 1 review artifact that includes consistency findings (contradictions, dangling references, ambiguities). Do NOT trigger for one-line bug fixes (CL-COMPLEXITY=1-file-fix), pure code edits, free-form prose specs where structure would hurt, or tasks with no testable behavior.
---

# ears-validated

A typed-graph requirements layer with CRDT-backed storage and a three-tier solver pipeline (deterministic heuristics → two-model LLM ensemble on Bedrock → Claude Opus 4.7 arbiter at `xhigh` effort). You author EARS requirements by populating structured slots, not by writing sentences; the renderer produces the canonical sentence and the solver pipeline produces the Gate 1 findings.

## Mental model

<data_model>
Each requirement is a node in a SysML-v2-shaped graph stored in Automerge. The node carries:

- **EARS slots** (the structural primitives — these are what you author):
  - `patternType`: ubiquitous | event-driven | state-driven | optional-feature | unwanted-behavior
  - `preCondition`: state phrase, present-tense, no leading "while/where"
  - `trigger`: event phrase, present-tense, no leading "when/if"
  - `systemName`: subject noun phrase, no leading "the"
  - `systemResponse`: verb phrase, no "shall"
- **Typed metadata** (tuning knobs — set after the human reviews the slot tuple):
  - `priority`: low | medium | high | critical (default `medium`)
  - `status`: draft | approved | implemented | verified (default `draft`)
  - `verificationMethod`: test | inspection | analysis | demonstration (optional)
- **Outbound edges** (the DAG ERPAVal's Plan phase reads):
  - `derives`: decomposition; the parent decomposes into the children
  - `satisfies`: this requirement satisfies a higher-level goal
  - `verifies`: this verification requirement confirms the target
  - `refines`: this is a more specific restatement of the target

The canonical sentence is **auto-rendered** from the slots; never write it by hand. The graph is the source of truth; markdown is a derived view.
</data_model>

<pattern_selection_rules>
- `ubiquitous`: always-on rule. Renders "The X shall Y."
  → Use for invariants with no precondition or trigger.
- `event-driven`: requires `trigger`. Renders "When TRIGGER, the X shall Y."
  → Use when an event activates the requirement.
- `state-driven`: requires `preCondition`. Renders "While PRE, the X shall Y."
  → Use when the requirement applies during a state.
- `optional-feature`: requires `preCondition`. Renders "Where PRE, the X shall Y."
  → Use for feature-gated behavior (configuration, tenant, plan).
- `unwanted-behavior`: requires `trigger`. Renders "If TRIGGER, then the X shall Y."
  → Use for error / failure / abuse handling.

If you find yourself wanting both a precondition and a trigger, choose `event-driven` and put the precondition there too — the renderer handles "While PRE, when TRIGGER, ...".
</pattern_selection_rules>

## Canonical workflows

<workflow name="author_new_spec">
1. Call `requirements_list` first. Even on a "new" spec the doc may have prior content.
2. For each acceptance criterion, call `requirement_create` with the minimal slots needed to render a sentence. Don't fill `priority`, `status`, `verificationMethod` yet — they're Gate-1-revision-time knobs, not authoring-time ones.
3. After all nodes exist, wire up the DAG with `relationship_add ... relation=derives`. Reflect ERPAVal's `Dependencies: AC-X-Y` annotations as `derives` edges from parent to child.
4. Call `analysis_run`. Treat each finding as a TODO. Do not declare the spec done until findings are resolved or explicitly accepted by the human.
5. Call `sysml_export` to produce the JSON the Plan phase consumes.
</workflow>

<workflow name="extend_existing_spec">
1. `requirements_list` to enumerate current node ids — never assume continuity from a prior turn.
2. `analysis_run` BEFORE editing. Pre-existing findings tell you which slots are fragile and which edges might be load-bearing.
3. Use `requirement_update` (one attribute per call). EARS-slot edits re-render the sentence automatically; metadata edits do not.
4. After your batch, `analysis_run` again. New findings that weren't in step 2 are caused by your edits — resolve them before declaring done.
</workflow>

<workflow name="prepare_gate1_report">
1. `analysis_run` and capture the findings JSON verbatim.
2. Group findings: high-confidence first (Contradiction, ExactDuplicate, free-tier issues), then arbiter-resolved (LLM with high confidence), then NeedsReview last.
3. For each Contradiction, propose a concrete fix inline (tighten one side's slot tuple, or split into two non-overlapping requirements).
4. For each NeedsReview, surface the rationale verbatim — these are arbiter-couldn't-decide cases that need the human.
5. `sysml_export` and include element + relationship counts in the report header.
</workflow>

<workflow name="resolve_findings">
Order findings by this priority and resolve top-down:

1. `DanglingReference` (free, high) — stale edge after a delete. Fix with `relationship_remove`.
2. `Contradiction` (LLM, high) — spec is broken. Fix the slot tuple on one side or split.
3. `MissingTrigger` / `MissingPreCondition` (free) — required slot empty for chosen pattern. Either add the slot or change `patternType`.
4. `CycleDetected` (free) — derive cycle. Break by removing one edge.
5. `Subsumption` (LLM, high) — merge with `requirement_delete` on the more specific node (after removing its inbound edges), or accept and document.
6. `Ambiguity` (free or LLM) — apply `suggestedRewrites`, or replace vague phrases with numeric/observable bounds.
7. `NeedsReview` (low) — escalate to the human. Do not auto-resolve.
</workflow>

## Tool reference

The MCP server exposes 8 tools. Each carries detailed descriptions and per-parameter docs you can read at `tools/list`; the summaries below tell you which to reach for.

<tools>
- **`requirement_create`** — create a new node. Returns the assigned UUID; remember it. Idempotency: a fresh UUID is generated server-side, so retries create duplicates — only retry on genuine error responses.
- **`requirement_update`** — patch exactly one attribute. Use `value: null` to clear an optional attribute (`preCondition`, `trigger`, `verificationMethod` only); null on a required attribute throws.
- **`relationship_add`** — add a typed edge. Idempotent (same edge twice = one edge). Source must exist; target may be deleted later, in which case `analysis_run` surfaces the dangling ref.
- **`relationship_remove`** — remove an edge. No-op if absent; safe to call defensively.
- **`requirement_delete`** — tombstone a node. Inbound edges become dangling refs. Always remove inbound edges first (find them with `analysis_run`).
- **`requirements_list`** — compact summary of every node (id, pattern, priority, status, sentence). Call before any mutation batch so you have the current ids.
- **`analysis_run`** — three-tier solver. Returns deterministic findings + LLM-ensemble findings + arbiter-resolved findings. Read-only; safe to call as often as you like.
- **`sysml_export`** — emit the graph as SysML-v2-shaped JSON. Read-only; call at hand-off points to ERPAVal Plan or to a downstream tool.
</tools>

**Order discipline**: list → mutate → analyze → list. Never mutate without listing first; never declare done without analyzing.

## Anti-patterns

<anti_patterns>
- **Writing the EARS sentence as a free-form string.** The sentence is rendered from slots; populating it directly bypasses the renderer and breaks consistency with future updates.
- **Authoring metadata at create time.** `priority`, `status`, `verificationMethod` are tuning knobs that belong to the Gate-1 revision pass. Setting them up front front-loads bikeshedding before the slots have stabilized.
- **Adding edges before both endpoints exist.** `relationship_add` errors when the source is missing. Author all nodes first, then all edges.
- **Skipping `analysis_run` because "the spec looks right".** Free-tier findings are deterministic, sub-millisecond, and catch real issues you missed. There is no excuse for skipping.
- **Treating `NeedsReview` as noise.** A `NeedsReview` finding means the two-model ensemble disagreed *and* the Opus 4.7 arbiter at `xhigh` couldn't decide. These almost always indicate real ambiguity worth a human eye.
- **Calling `requirement_delete` to "clean up".** Deletes leave dangling references on every inbound edge. Find inbound edges with `analysis_run` first, remove them with `relationship_remove`, then delete.
- **Paraphrasing tool output.** `analysis_run` returns both a summary line and a JSON blob. When the user asks "what's wrong with my spec", show them the JSON, not your interpretation of it.
- **One giant batch of mutations followed by one `analysis_run`.** Findings cascade — fix the high-confidence ones first, re-run, then look at what's left. Iterating cheaply is the point.
</anti_patterns>

## Integration with ERPAVal

This skill is the canonical home for the EARS substep that `CL-RIGOR` routes to. When triggered from CL-RIGOR:

1. Read the HMW brainstorm (if present) at `.erpaval/brainstorms/NNN-<slug>-requirements.md`.
2. Run the **author_new_spec** workflow above against `.erpaval/specs/NNN-<slug>/requirements.automerge` (set `REQ_DOC` via env or the launcher).
3. Export to `.erpaval/specs/NNN-<slug>/spec.md` via `sysml_export` for the Plan phase to consume.
4. Attach the findings JSON to the Gate 1 review artifact so the human reviewer sees consistency results alongside the draft task graph.

Edges authored as `derives` become ERPAVal's `Dependencies: AC-X-Y` directly — there is no separate parallel-safety flag to author, because absence of a `derives` edge between siblings *is* the parallel-safety signal.

## Effort guidance

When you (the agent) reason about a complex spec, raise `effort` to `xhigh` for the planning step; lower to `medium` for individual tool-call sequences once the plan is set. The MCP tools themselves don't consume your effort budget — the budget is yours.

The arbiter (Claude Opus 4.7) inside the MCP server runs at `xhigh` by default; you don't control it from the tool call, but you can override at server-start time via `BEDROCK_ARBITER_EFFORT`.

## Output expectations

- When responding to the user about a spec, **show the canonical sentence**, not your own restatement.
- When reporting findings, **preserve the `kind`, `source`, and `confidence` fields** — they're how the user (and the audit log) knows whether to trust the finding.
- When handing off to Plan, **always run `sysml_export` last** so the JSON is fresh.
