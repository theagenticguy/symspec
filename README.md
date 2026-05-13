# ears-validated

**Type a requirement's slots; get back a CRDT-merged graph, a rendered EARS sentence, and a three-tier solver verdict (deterministic → two-model Bedrock ensemble → Claude Opus 4.7 arbiter).** One core, two surfaces (CLI + MCP), one canonical SysML-v2-shaped JSON export.

## Quick start

```bash
pnpm install
pnpm smoke:all     # concurrent-merge demo + incremental-edits demo + solver demo (mocked LLM)
pnpm test          # vitest unit tests
pnpm check         # full quality gate: biome ci + tsc + vitest + knip
```

CLI:

```bash
pnpm cli init reqs.automerge
pnpm cli add reqs.automerge --pattern event-driven --system "auth service" \
  --response "issue a session token" --trigger "the user submits valid credentials"
pnpm cli analyze reqs.automerge
pnpm cli export  reqs.automerge
```

MCP server (stdio):

```bash
REQ_DOC=./reqs.automerge pnpm mcp
```

Live solver run against Bedrock (off by default; smoke uses a mock):

```bash
BEDROCK_LIVE=1 AWS_REGION=us-east-1 pnpm smoke:solvers
```

That's the whole user-facing surface. Everything below is how it works.

---

## Deep dive: how it works

The system is one core (`src/core`) plus three thin layers that compose on top:

```
┌─────────────────────────────────────────────────────────────────┐
│  Surfaces:    req CLI (commander)        MCP server (@mcp/sdk)  │
├─────────────────────────────────────────────────────────────────┤
│  Solver:      runSolvers()  ──▶  free tier ──▶ LLM ensemble    │
│                                              ──▶ Opus 4.7 arbiter│
├─────────────────────────────────────────────────────────────────┤
│  Analysis:    analyze()  → DanglingRef / MissingSlot /          │
│                            CycleDetected / OrphanRequirement     │
├─────────────────────────────────────────────────────────────────┤
│  Public API:  applyChange(doc, Change)  +  merge(a, b)          │
│               Change = CreateRequirement | UpdateAttribute |    │
│                        AddRelationship | RemoveRelationship |   │
│                        DeleteRequirement                         │
├─────────────────────────────────────────────────────────────────┤
│  Domain:      Requirement = EARS slots + typed metadata +       │
│               typed edge arrays (derives/satisfies/verifies/    │
│               refines)                                          │
├─────────────────────────────────────────────────────────────────┤
│  Storage:     Automerge CRDT (flat-map of UUID → Requirement)   │
└─────────────────────────────────────────────────────────────────┘
```

### Storage layer — Automerge CRDT (`src/core/doc.ts`)

The document is a flat map keyed by UUID:

```ts
type RequirementsDoc = {
  schemaVersion: number
  requirements: Record<string, Requirement>
}
```

Flat-map (rather than array) is deliberate — there are no array indices for replicas to fight over, so concurrent inserts/deletes converge cleanly.

Mutations happen inside `Automerge.change(doc, draft => { ... })`. The wrapper hides that ceremony behind one function — `applyChange(doc, change)` — so the rest of the codebase stays in plain TypeScript.

`merge(a, b)` is exposed even though Automerge does it for you, just so the smoke scripts can demonstrate the property explicitly. Ordering doesn't matter: `merge(merge(base, alice), bob)` and `merge(merge(base, bob), alice)` produce equivalent state — the smoke script asserts this.

### Public API — Change records (`src/core/schema.ts`)

Five Change types, all referencing elements by stable UUID, never by JSON path:

| Change | Idempotency |
|---|---|
| `CreateRequirement` | throws on duplicate id (collisions should be surfaced, not silently merged) |
| `UpdateAttribute` | re-applying the same value is a no-op; `null` clears optional attrs (`preCondition`, `trigger`, `verificationMethod`); `null` on a required attr throws |
| `AddRelationship` | adding the same edge twice = one edge |
| `RemoveRelationship` | removing a missing edge is a no-op |
| `DeleteRequirement` | tombstone semantics; missing id is a no-op; inbound edges become dangling refs (caught by `analyze()`, not prevented here) |

A `Commit` is just a batch of Changes applied atomically.

The discriminated-union `ChangeSchema`, the per-tool MCP input shapes, and the on-disk `RequirementSchema` all compose from the **same atomic field schemas** in `core/schema.ts`. Adding an attribute means editing exactly one place. Each atomic field carries a rich `.describe()` covering what / why / one example, and those descriptions propagate into the JSON Schema the MCP SDK exposes to the LLM in `tools/list` — so there is no second schema layer to drift.

### Domain — Requirement node

Every node has three groups of fields:

- **EARS slots** (the structural primitives): `patternType`, `preCondition`, `trigger`, `systemName`, `systemResponse`. The canonical sentence is **rendered** from these by `renderSentence()` — never authored by hand. Sentence renders re-fire on every EARS-slot edit; metadata edits leave the sentence untouched.
- **Typed metadata** (Gate-1-revision-time tuning knobs): `priority`, `status`, `verificationMethod`.
- **Typed edges** (the DAG): `derives`, `satisfies`, `verifies`, `refines`. Each is its own array; relationship semantics live in the type, not in a string label.

Pattern → required slot:

| Pattern | Renders | Required |
|---|---|---|
| `ubiquitous` | `The X shall Y.` | — |
| `event-driven` | `When TRIGGER, the X shall Y.` | `trigger` |
| `state-driven` | `While PRE, the X shall Y.` | `preCondition` |
| `optional-feature` | `Where PRE, the X shall Y.` | `preCondition` |
| `unwanted-behavior` | `If TRIGGER, then the X shall Y.` | `trigger` |

Both pre + trigger? Use `event-driven`; the renderer produces `While PRE, when TRIGGER, the X shall Y.`

### Analysis layer — `analyze()` (`src/core/analyze.ts`)

Runs over a converged snapshot and surfaces what the CRDT couldn't (and shouldn't) prevent:

- `DanglingReference` — an edge points at a UUID that no longer exists (the canonical concurrent-edit case: Alice adds an edge to a node Bob deletes).
- `MissingTrigger` / `MissingPreCondition` — pattern's required slot is empty.
- `CycleDetected` — cycle in `derives` (decomposition must be acyclic). DFS-based; cycles are deduped by canonical rotation.
- `OrphanRequirement` — node with no inbound or outbound edges (likely incomplete).

Findings are read-only diagnostics. The expected loop: agent makes a Commit → replicas merge → `analyze()` runs → findings render as clarifying questions in the review UI (the Kiro "analyze-then-clarify" pattern).

### Solver layer — three tiers (`src/solvers/`)

`analyze()` catches structural breakage. The solver layer catches **semantic** problems: contradictions, subsumption, near-duplicates, ambiguity.

**Tier 1 — free, deterministic, in-process** (`src/solvers/free/`):

- `detectExactDuplicates` — full-tuple hash over `(patternType, preCondition, trigger, systemName, systemResponse)`. Anything caught here is high-confidence and skips the LLM tier.
- `detectAmbiguity` — lexical scan for INCOSE/IEEE-830 weasel words (`fast`, `robust`, `as needed`, `etc.`, `appropriate`). Curated short list; high precision; false positives would train authors to ignore the linter.
- `emitCandidatePairs` — emits the small set of pairs worth running through the LLM judge, using three structural rules: **same system + same trigger + different response** (contradiction candidate), **same system + overlapping precondition** (subsumption candidate), **high lexical similarity on the rendered sentence** (near-duplicate candidate). Avoids the n²/2 LLM-call explosion.

**Tier 2 — two-model Bedrock ensemble** (`src/solvers/llm/`):

Two models run in parallel via the **Bedrock Converse API + forced tool use**. Forced tool use means the model is required to call our `report_judgment` tool, whose `inputSchema` is a JSON Schema we author. Bedrock validates on its side, so the response is guaranteed-shaped — no "model returned prose when I asked for JSON" failure mode.

- `judgePair` classifies a candidate pair as `contradiction | subsumption | redundant | compatible`, plus `whichOf` for subsumption direction and a rationale.
- `judgeAmbiguity` flags context-dependent vagueness the lexical scan misses (e.g., "handle high load" — no weasel words, still vague).

The ensemble (`ensemble.ts`) reconciles the two judgments:

- both agree on contradiction / both agree on subsumption (same direction) / both agree on redundant → **high-confidence finding**.
- both agree on compatible → drop.
- disagreement → escalate to Tier 3 if an arbiter is configured, otherwise emit `NeedsReview` for the human.

`CallModel` is injected — tests pass a deterministic mock keyed by `(modelId, requirement pair)`, production wires up `bedrockCallModel`. `scripts/smoke-solvers.ts` runs both modes; `BEDROCK_LIVE=1` flips to the real client.

**Tier 3 — Claude Opus 4.7 arbiter** (`src/solvers/llm/arbiter.ts`):

When the two judges disagree, we escalate to Opus 4.7 over Bedrock's `InvokeModel` (not Converse) — InvokeModel is the native Anthropic Messages surface and is what gives first-class control over `thinking` and `output_config.effort`.

- **Adaptive thinking**: Opus 4.7 only supports `thinking: { type: "adaptive" }`. The older manual `enabled` + `budget_tokens` shape is rejected with 400. Depth is controlled by `output_config.effort` ∈ `{ low, medium, high, xhigh, max }`. Default `xhigh` — Anthropic's recommended starting point for agentic / long-horizon work, including arbitration.
- **Forced tool use**: `tool_choice: { type: "tool", name: "report_arbitration" }` guarantees structured JSON.
- **XML-tagged user message**: per Anthropic's prompting conventions, each input chunk lives inside a semantic XML tag (`<requirement_a>`, `<prior_judgment model="...">`, `<free_tier_reason>`, `<task>`, `<instructions>`). Critical instructions appear at both the **top of the system prompt** and the **bottom of the user message** — the two locations Anthropic guidance flags as reliably attended.
- **`thinking.display: "summarized"`** — Opus 4.7 defaults to `omitted` (signature only); we opt back into summarized so the audit trail can include the reasoning summary.
- **Output ceiling**: `max_tokens=64000` so the model has room to think *and* emit the tool call at xhigh/max effort.

Verdict shape: `{ finalJudgment, whichOf, confidence, agreedWith: 'primary'|'secondary'|'neither', rationale, caveat?, thinkingSignature? }`. The signature is opaque and round-trips for audit.

Configuration matrix (env vars):

| Variable | Default | Notes |
|---|---|---|
| `AWS_REGION` | — | required; cross-region inference profile region |
| `BEDROCK_MODEL_PRIMARY` | from `MODELS.primary` | primary judge |
| `BEDROCK_MODEL_SECONDARY` | from `MODELS.secondary` | secondary judge |
| `BEDROCK_ARBITER_MODEL` | global Opus 4.7 inference profile | overridable per account |
| `BEDROCK_ARBITER_EFFORT` | `xhigh` | one of `low | medium | high | xhigh | max` |
| `BEDROCK_ARBITER_MAX_TOKENS` | `64000` | output ceiling |

### Surfaces — CLI + MCP, both over the same core

- **`req` CLI** (`src/cli/index.ts`, `bin/req.mjs`) — commander-based; commands map 1:1 to Change records. Exists for human use and for shell-driven tests.
- **MCP server** (`src/mcp/server.ts`, `bin/req-mcp.mjs`) — `@modelcontextprotocol/sdk` over stdio. Exposes 8 tools. Tool names follow `noun_verb` so `tools/list` groups by domain object. The per-tool input shapes are imported directly from `core/schema.ts` — there is **no second schema layer**. Tool descriptions follow a consistent shape: *what / when / returns + side effects / idempotency + error modes*. Mutating tools end with a hint about calling `analysis_run` next, so the agent learns the verification half of the loop without being told inline.

| MCP tool | Action |
|---|---|
| `requirement_create` | create node, returns assigned UUID |
| `requirement_update` | patch one attribute |
| `relationship_add` / `relationship_remove` | typed edges |
| `requirement_delete` | tombstone |
| `requirements_list` | read |
| `analysis_run` | three-tier solver report |
| `sysml_export` | SysML-v2-flavored JSON |

### Export — `exportSysml()` (`src/core/sysml-export.ts`)

Each requirement becomes a `RequirementUsage`-shaped element; each outbound edge becomes a `DeriveRequirement | Satisfy | Verify | Refine` relationship element; EARS slots become typed attributes; the rendered sentence is `documentation`. **Flavored**, not spec-compliant — swapping the export for the OMG Systems Modeling API (Part 3) OpenAPI payloads is a ~200-line change.

### What this POC deliberately doesn't do

- **Real SysML v2 wire format** — see export note above.
- **Grammar-constrained generation from natural prose** — Change records arrive structured. EARS-from-prose extraction would sit *in front* of this layer (e.g., Claude tool-use over the same MCP server).
- **Property-based test generation** — next step. Each EARS slot tuple has enough structure to derive `forAll` properties (the Kiro "Correctness" pillar).
- **Referential integrity at the CRDT layer** — dangling refs are caught by `analyze()`, not prevented at write time. Rich-CRDT approaches (ElectricSQL, Synql 2024) would push this earlier; for a POC it's overkill.

---

## File layout

```
src/
  core/
    schema.ts          # zod schemas (single source of truth) + sentence renderer
    doc.ts             # Automerge wrapper: load/save/applyChange/merge
    analyze.ts         # dangling refs, missing slots, cycles, orphans
    sysml-export.ts    # SysML-v2-flavored JSON projection
  cli/index.ts         # commander CLI
  mcp/server.ts        # MCP stdio server
  solvers/
    free/              # exact duplicates, ambiguity (lexical), pairwise filter
    llm/               # Bedrock Converse pair-judge + ambiguity-judge + ensemble
    llm/arbiter.ts     # Opus 4.7 InvokeModel + adaptive thinking + xhigh effort
    index.ts           # runSolvers() orchestrator
    types.ts           # SolverFinding, CandidatePair, ReqView
scripts/
  smoke.ts             # concurrent-edits demo + analysis assertions
  smoke-incremental.ts # incremental-edits, idempotency, persistence, null-clear
  smoke-solvers.ts     # solver pipeline; live with BEDROCK_LIVE=1
bin/
  req.mjs              # CLI entry
  req-mcp.mjs          # MCP server entry
integration/           # ERPAVal wiring: SKILL.md + mcp-config.json + CLAUDE.md.snippet
.erpaval/              # see /erpaval below
```

---

## /erpaval — captured lessons

This project uses ERPAVal's **lesson capture convention** to record non-obvious tooling and convention decisions that bit us once and would bite us again.

```
.erpaval/
  INDEX.md                          # category-grouped pointers; loaded into Claude's session
  solutions/
    conventions/                    # one .md per lesson
      <slug>.md
```

Claude Code's session-start hook surfaces this index so prior lessons are in context before any work begins. Each lesson file uses front-matter for grep-ability:

```yaml
---
title: <human title>
track: knowledge
category: conventions | architecture | infra | testing
module: <file or area>
component: <tool>
severity: info | medium | high
tags: [<tags>]
applies_when:
  - <triggering condition>
pattern: |
  <prose explanation, with code snippets>
example_files:
  - <path>
---

# Why this matters
# Example
# What NOT to do
```

The four current lessons (all `conventions`) document the canonical-TypeScript-stack edge cases this repo hit:

| Lesson | What it captures |
|---|---|
| `pnpm11-prepare-script-and-git-init-order.md` | pnpm 11's `verify-deps-before-run` re-fires `prepare` on every `pnpm exec`; if `prepare` runs `lefthook install` in a non-git directory, every subsequent `pnpm exec` fails opaquely. **Fix**: move hook install to `hooks:install`, set `verify-deps-before-run=false` in `.npmrc`, and add `pnpm.onlyBuiltDependencies` for native builders. |
| `lefthook-vs-amazon-git-defender-hookspath.md` | Amazon corp laptops set `core.hooksPath` globally to git-defender's read-only dir. `lefthook install` either errors or silently never fires. **Fix**: `git config --local core.hooksPath .git/hooks` per-repo, then `lefthook install --force`. |
| `exact-optional-property-types-omit-key-idiom.md` | With `exactOptionalPropertyTypes: true`, `{ foo?: T }` ≠ `{ foo?: T \| undefined }`. The clean fix is to **omit the key** (build the object, then conditionally assign) or use a conditional spread — never widen the type just to silence the compiler. |
| `biome-noNonNullAssertion-off-when-noUncheckedIndexedAccess.md` | With `noUncheckedIndexedAccess: true`, guarded `arr[i]!` in tight loops is the canonical idiom. Biome's `style/noNonNullAssertion` double-warns the same case stylistically. **Fix**: turn the lint rule **off** — the type-system control is the load-bearing one. |

### When to add a lesson

Add one when **a future you (or a teammate) would lose 15+ minutes** rediscovering the same edge case. Specifically:

- A tool's default behavior interacts badly with another tool's default behavior, and the failure is opaque or silent.
- A strict-mode TypeScript flag has a non-obvious idiom that the official docs underemphasize.
- A package manager / hook tool / linter has version-specific behavior we depend on.
- A workaround that looks weird in the diff and would be reverted by an unsuspecting refactor.

### When NOT to add a lesson

- The fix is obvious from the code or commit message.
- The decision is documented in CLAUDE.md or in the project README's deep dive.
- It's a one-off bug whose fix is in the diff.

### Adding a lesson

1. Drop a new `<slug>.md` under `.erpaval/solutions/<category>/` using the front-matter shape above.
2. Add a one-line pointer to the relevant category in `.erpaval/INDEX.md`.
3. Bump the recent-additions line at the bottom of `INDEX.md` so the next session sees what's new.

The lessons are part of the repo on purpose — they travel with the code and with anyone who clones it.
