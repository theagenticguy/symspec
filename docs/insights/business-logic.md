# symspec · Business logic

The rules this codebase enforces — domain rules, validations, invariants, calculations. Each rule has a single source-of-truth location.

## EARS pattern → required slot rule

The five patterns are defined at `src/core/schema.ts:26-32` and dictate which structural slot the requirement must carry:

| Pattern | Required slot | Rendered shape |
|---|---|---|
| `ubiquitous` | — | `The X shall Y.` |
| `event-driven` | `trigger` | `When TRIGGER, the X shall Y.` (or `While PRE, when TRIGGER, ...` if both) |
| `state-driven` | `preCondition` | `While PRE, the X shall Y.` |
| `optional-feature` | `preCondition` | `Where PRE, the X shall Y.` |
| `unwanted-behavior` | `trigger` | `If TRIGGER, then the X shall Y.` |

Implemented in two places — the renderer at `src/core/schema.ts:443-464` (canonical sentence shape per pattern) and the analysis pass at `src/core/analyze.ts:46-64` (missing-slot detection per pattern). Adding a sixth pattern requires updating both.

The `event-driven` + `preCondition` combination is a deliberate non-obvious case: the renderer produces `While PRE, when TRIGGER, the X shall Y.` (`src/core/schema.ts:454-456`), and the SKILL.md guidance is "if you want both, use event-driven and put the precondition there" (`integration/SKILL.md:46`).

## Sentence is rendered, never authored

Invariant: the `sentence` field on every requirement is a denormalized projection of the EARS slots, maintained automatically. Sources of truth:

- Description on the field schema: "Maintained automatically — the renderer re-runs whenever any EARS slot changes... Do not write directly; update the slot fields instead." (`src/core/schema.ts:157-162`).
- Enforcement in `applyChange`: the create branch always renders before storing (`src/core/doc.ts:78-84`); the update branch re-renders on EARS-slot edits but skips on metadata edits (`src/core/doc.ts:118-127`).

There is no schema-level rejection of a hand-written sentence, but the next slot edit will overwrite it. The SKILL.md anti-pattern catalog calls this out explicitly (`integration/SKILL.md:106`).

## Idempotency contracts on Change records

Documented at `src/core/doc.ts:50-57`. Drives the MCP "safe to call defensively" guarantees:

| Change | On retry / collision |
|---|---|
| `CreateRequirement` | throws on duplicate id — collisions surface, not silently merged (`src/core/doc.ts:65-66`) |
| `UpdateAttribute` | re-applying the same value is a no-op; null clears optional, throws on required (`src/core/doc.ts:108-117`) |
| `AddRelationship` | adding the same edge twice produces one edge (`src/core/doc.ts:135-136`) |
| `RemoveRelationship` | removing a missing edge is a no-op (`src/core/doc.ts:141-149`) |
| `DeleteRequirement` | tombstone semantics; missing id is a no-op (`src/core/doc.ts:151-157`) |

Tested at `scripts/smoke-incremental.ts:188-237` (3× `AddRelationship` → 1 edge), `scripts/smoke-incremental.ts:226-237` (phantom `RemoveRelationship` no-ops).

## Nullable attributes whitelist

Only `preCondition`, `trigger`, `verificationMethod` may be null'd to clear (`src/core/schema.ts:60-64`). Attempting null on any other attr throws with message `Cannot null required attribute "<attr>" on <id>` (`src/core/doc.ts:111-113`). Test coverage at `scripts/smoke-incremental.ts:163-187`.

## Default values at create time

Filled by the runtime if absent in `CreateRequirementAttrsSchema`:

- `priority`: `'medium'` (`src/core/schema.ts:272`, `src/core/doc.ts:85`)
- `status`: `'draft'` (`src/core/schema.ts:273`, `src/core/doc.ts:86`)
- `derives`, `satisfies`, `verifies`, `refines`: `[]` (`src/core/schema.ts:275-278`, `src/core/doc.ts:87-90`)
- `createdAt`, `updatedAt`: ISO-8601 timestamp set on every applyChange (`src/core/doc.ts:60`, `:91-92`, `:128`, `:137`, `:147`)
- `id`, `sentence`: caller-provided id, runtime-rendered sentence (`src/core/doc.ts:74-84`)

## Cycle prohibition on `derives`

The decomposition relation must be acyclic. Cycles are surfaced as `CycleDetected` findings, not prevented at write time — `applyChange` doesn't reject `AddRelationship` calls that would create a cycle (`src/core/doc.ts:132-139`). Detection is DFS-based with canonical-rotation dedup (`src/core/analyze.ts:102-140`). The other three relations (`satisfies`, `verifies`, `refines`) are not cycle-checked.

## Orphan threshold

A node with zero inbound and zero outbound edges is an orphan *only when there is more than one node in the doc* (`src/core/analyze.ts:90`). The single-node case is intentionally not flagged — a one-requirement doc is not orphaned by definition.

## Exact-duplicate definition

Two requirements are exact duplicates when their full `(patternType, preCondition || '', trigger || '', systemName, systemResponse)` tuple matches (`src/solvers/free/duplicates.ts:14-25`). Two requirements with the same slots but different priority / status / verificationMethod are still duplicates — the metadata fields do not participate in the hash.

## Weasel-phrase ambiguity catalog

Curated short list of 35 phrases at `src/solvers/free/ambiguity.ts:17-57`, grouped into:

- Speed/performance: `fast`, `quickly`, `rapid`, `slow`, `as quickly as possible`
- Quality: `robust`, `user-friendly`, `easy to use`, `intuitive`, `appropriate`, `adequate`, `reasonable`, `acceptable`, `sufficient`
- Open-ended scope: `etc.`, `and so on`, `and the like`, `where applicable`, `as needed`, `as appropriate`, `as necessary`
- Vague quantifiers: `many`, `some`, `several`, `various`, `most`, `few`, `minimal`, `minimum`, `maximum`
- Subjective absolutes: `always`, `never`, `all`, `every`

Sourced from the INCOSE Guide for Writing Requirements and IEEE 830 / ISO 29148 ambiguity lists (`src/solvers/free/ambiguity.ts:9-12`). 11 entries carry suggested rewrites (`src/solvers/free/ambiguity.ts:59-73`). Word-boundary matching avoids false positives like `many` inside `Germany` (test at `src/solvers/free/__tests__/duplicates.test.ts:82-91`).

## Pairwise candidate-pair rules

Three structural heuristics that escalate to the LLM tier (`src/solvers/free/pairwise-filter.ts:55-99`):

1. **Same `systemName` + same `trigger` (case-insensitive) + different `systemResponse`** → `same-system-same-trigger-different-response` (contradiction candidate).
2. **Same `systemName` + overlapping `preCondition`** → `same-system-overlapping-precondition` (subsumption candidate). "Overlapping" = either string contains the other, case-insensitive (`src/solvers/free/pairwise-filter.ts:23-28`).
3. **Same `systemName` + lexical similarity ≥ threshold (default 0.7)** → `near-duplicate-sentence`. Jaccard over word sets of the rendered sentence (`src/solvers/free/pairwise-filter.ts:30-38`).

Pairs across different `systemName`s are skipped — different systems can't directly contradict at the system-behavior level (`src/solvers/free/pairwise-filter.ts:60-62`).

## Pairwise judgment classification

Four labels, mutually exclusive (`src/solvers/llm/judge-pair.ts:30-62`):

- `contradiction`: A and B cannot both be satisfied.
- `subsumption`: one is a strict special case of the other; `whichOf` ∈ `{a, b}` indicates the more general.
- `redundant`: same thing in different words; `whichOf` is null.
- `compatible`: no conflict; the free-tier flag was a false positive.

The arbiter prompt at `src/solvers/llm/arbiter.ts:122-127` reproduces these definitions verbatim. Conservative defaults: `compatible` when evidence is weak (`src/solvers/llm/arbiter.ts:120`).

## Ensemble reconciliation rules

Pair (`src/solvers/llm/ensemble.ts:82-134`):

- Both `contradiction` → high-confidence `Contradiction`.
- Both `subsumption`, same `whichOf` → high-confidence `Subsumption`.
- Both `subsumption`, different `whichOf` → low-confidence `Subsumption` with a "review needed" message.
- Both `redundant` → high-confidence `Subsumption` with `whichOf=null`.
- Both `compatible` → drop (no finding emitted).
- Disagree → arbiter (if configured) or `NeedsReview`.

Ambiguity (`src/solvers/llm/ensemble.ts:231-263`):

- Both `ambiguous: true` → high-confidence `Ambiguity` with merged phrases and rewrites.
- Both `ambiguous: false` → drop.
- Disagree → `NeedsReview`. The arbiter currently does not handle ambiguity — pair-only.

## Arbiter conservatism rules

The arbiter system prompt instructs (`src/solvers/llm/arbiter.ts:117-121`):

- Read both requirements slot by slot.
- Determine whether trigger/preCondition overlap is total, partial, or coincidental.
- Determine whether `systemResponse` fields are compatible, mutually exclusive, or one is a strict special case.
- Be conservative: prefer `compatible` when evidence is weak; set `confidence: 'low'` when external information could change the answer.
- Always emit the verdict via `report_arbitration`; never refuse; if uncertain, return `compatible` with `confidence: 'low'` and explain in `caveat`.

## SysML projection rules

Each requirement → one `RequirementUsage` element with `declaredName = "<patternType>_<id-first-8-chars>"` (`src/core/sysml-export.ts:55-70`). Each outbound edge → one relationship element with `@type` mapped per `RELATION_TO_SYSML`:

- `derives` → `DeriveRequirement`
- `satisfies` → `Satisfy`
- `verifies` → `Verify`
- `refines` → `Refine`

Relationship `@id` is `"<from>-><relation>-><to>"` (`src/core/sysml-export.ts:74-79`).

## ERPAVal integration rules

When triggered from CL-RIGOR (`integration/SKILL.md:117-126`):

1. Read the HMW brainstorm if present at `.erpaval/brainstorms/NNN-<slug>-requirements.md`.
2. Run the `author_new_spec` workflow against `.erpaval/specs/NNN-<slug>/requirements.automerge`.
3. Export to `.erpaval/specs/NNN-<slug>/spec.md` via `sysml_export`.
4. Attach findings JSON to the Gate 1 review artifact.

The SKILL.md also defines a finding-resolution priority order (`integration/SKILL.md:74-83`): DanglingReference → Contradiction → Missing slots → CycleDetected → Subsumption → Ambiguity → NeedsReview.

## See also

- [Module map](../architecture/module-map.md)
- [Processes](../behavior/processes.md)
- [Tech debt register](tech-debt.md)
- [System overview](../architecture/system-overview.md)
