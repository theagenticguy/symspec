# symspec · Tech debt register

What's deferred, what's a known shortcut, and what would cost to fix. The repo is a POC and the README enumerates the explicit non-goals (`README.md:198-204`); this register is the operational view.

Ranked by blast radius, highest first.

## 1. `analysis_run` MCP tool runs only the structural pass, not the solver pipeline

**What:** `src/mcp/server.ts:230-253` calls `analyze(doc)` from `src/core/analyze.ts`, which surfaces dangling refs / missing slots / cycles / orphans only. The semantic findings (`Contradiction`, `Subsumption`, `Ambiguity`, `NeedsReview`) produced by `runSolvers` (`src/solvers/index.ts:49-110`) are not wired into the MCP surface.

**Why it matters:** `integration/SKILL.md:74-83` ("resolve_findings" workflow) references all of those finding kinds as if the MCP returned them. An agent following the SKILL today won't see Contradiction findings — they're only reachable via the smoke script. The whole "three-tier solver" headline assumes this wiring.

**Cost to remove:** ~50 lines.
1. Add `runSolvers(doc, { llm: { call: bedrockCallModel, arbiter: bedrockArbiter, … } })` to the tool handler.
2. Decide on env-var configuration for the `CallModel` (already exists for the arbiter via `BEDROCK_*`).
3. Merge `Finding[]` and `SolverFinding[]` into a single envelope or return them as two text blocks.
4. Update tool description so the agent knows the new finding kinds.

**Reference:** `insights/impact-analysis.md` § `runSolvers()` enumerates the wiring decisions.

## 2. CLI `update` command treats the literal string `"null"` as JS `null`

**What:** `src/cli/index.ts:87` converts `value === 'null'` to JS `null`. A user who legitimately wants the string `"null"` as a value can't write it.

**Why it matters:** Probably never. `"null"` as a literal `systemResponse` would itself be a bug. Documenting the shortcut is worth it.

**Cost to remove:** trivial — add a `--clear` flag and treat absence of value as the null-clear signal. ~10 lines.

## 3. No schema-version migrator

**What:** `SCHEMA_VERSION = 1` (`src/core/schema.ts:512`) is written into every saved doc (`src/core/doc.ts:28`), but `loadDoc` doesn't check it (`src/core/doc.ts:33-36`). Bumping to v2 (e.g., adding a sixth EARS pattern, renaming an attribute) would require a migrator that runs at load time.

**Why it matters:** Today, with `schemaVersion: 1` everywhere, this is fine. The first breaking schema change reveals the gap.

**Cost to remove:** ~30 lines + a `migrations/` directory. The standard pattern: `loadDoc` reads `schemaVersion`, runs each migrator from `n` to `current`, then validates with `RequirementSchema`. Tests would cover load-then-save round-trips at every prior version.

## 4. `reconcilePair` and `reconcileAmbiguity` are exposed but untested

**What:** `src/solvers/llm/ensemble.ts:202-219` and `src/solvers/llm/ensemble.ts:231-263` are exposed "for unit testing the reconciliation logic without I/O" per their docstrings. No `ensemble.test.ts` exists.

**Why it matters:** The ensemble logic is the most behaviorally complex pure function in the repo (six branches per call). Smoke-testing through the orchestrator is end-to-end coverage; a unit test would lock down the reconciliation rules independently.

**Cost to remove:** ~80 LOC of tests. One test per reconciliation branch (both-contradiction / both-subsumption-same / both-subsumption-different / both-redundant / both-compatible / disagree).

## 5. The arbiter handles pair disagreements only, not ambiguity disagreements

**What:** `src/solvers/llm/ensemble.ts:253-262` emits `NeedsReview` when the two ambiguity judges disagree. The arbiter is wired only into the pair path (`src/solvers/llm/ensemble.ts:57-67`).

**Why it matters:** The README says so explicitly (`README.md:148`: "Tier 3 — Claude Opus 4.7 arbiter" appears after the pair section). It's a documented limitation, not a bug, but agents reading the SKILL workflow may still expect arbiter coverage on ambiguity.

**Cost to remove:** ~40 LOC. Add an `arbitrateAmbiguity` call site, reuse `bedrockArbiter`'s tool-use mechanics with a different schema, decide a tie-break rule for one-judge-says-yes-other-says-no.

## 6. `MODELS.secondary` defaults to `zai.glm-5-v1:0`

**What:** Default secondary judge model (`src/solvers/llm/bedrock-client.ts:115`). GLM availability and cost are account-specific.

**Why it matters:** Surprises for new account owners. Should be documented in the README arbiter section (it's not — only the arbiter env vars are listed at `README.md:170-178`).

**Cost to remove:** zero — it's a config decision, not a bug. Add a one-line doc note about region + entitlement.

## 7. `_listRequirements` re-export trick

**What:** `src/core/analyze.ts:152` re-exports `listRequirements` purely to suppress an unused-import warning when consumers only type-import `Finding`. The `_` prefix marks the convention but a reader has to scroll the comment (`src/core/analyze.ts:151`) to know.

**Why it matters:** A future refactor that removes the import-side will look at the export site, see "unused", and delete it. The comment isn't load-bearing.

**Cost to remove:** trivial — refactor the consumer to side-effect-import `doc.js` directly, then drop the re-export.

## 8. Smoke tests are scripts, not vitest cases

**What:** `scripts/smoke*.ts` use `console.log` + `process.exit(1)` (`scripts/smoke.ts:166-170`, `scripts/smoke-incremental.ts:31-36`) rather than vitest assertions. They run via `pnpm smoke:all`, separate from `pnpm test`.

**Why it matters:** The smoke files contain the densest behavior catalog (12 scenarios in `smoke-incremental.ts`); folding them into vitest would unify reporting, parallelize them, and put their assertions under coverage. The reason they're scripts is that the concurrent-merge demo prints a narrative — that's a UX concern, not a testing one.

**Cost to remove:** medium. Convert `expect(cond, msg)` to `expect(cond).toBeTruthy()`; the headers become `describe` blocks; the live-Bedrock branch in `smoke-solvers.ts:180` becomes a `describe.runIf(process.env.BEDROCK_LIVE === '1')`.

## 9. SysML export is "flavored", not spec-compliant

**What:** `src/core/sysml-export.ts:1-15` calls out the gap explicitly. The shape mirrors KerML/SysML v2 Requirement and Relationship elements but skips the full JSON-LD payload.

**Why it matters:** Acknowledged in the README's "what this POC deliberately doesn't do" (`README.md:200`). Real downstream consumption would require swapping the projection for the OMG Systems Modeling API (Part 3) OpenAPI payloads.

**Cost to remove:** ~200 LOC per the README. New file `sysml-v2-export.ts` or replace the projection in place; existing callers (CLI `req export`, MCP `sysml_export`) are unchanged.

## 10. No grammar-constrained extraction from natural prose

**What:** Change records arrive structured. There's no path that takes free-form prose ("when the user logs in we should issue a token") and emits a `CreateRequirement` Change.

**Why it matters:** The README is explicit (`README.md:201`): "EARS-from-prose extraction would sit *in front* of this layer (e.g., Claude tool-use over the same MCP server)". Today an agent reads the SKILL and decomposes prose itself — fine but unstructured.

**Cost to remove:** N/A — this is a deliberate scope cut for the POC.

## 11. No property-based test generation

**What:** README "what this POC deliberately doesn't do" (`README.md:202`): "Property-based test generation — next step. Each EARS slot tuple has enough structure to derive `forAll` properties (the Kiro 'Correctness' pillar)."

**Why it matters:** Acknowledged future work, not debt. Adding `fast-check` for property tests over the renderer + applyChange would catch the kinds of edge cases the smoke scripts hand-author today.

**Cost to remove:** medium. ~1 day to wire `fast-check`, build arbitraries for each Change kind, and write the half-dozen properties (commutativity of independent applyChange, idempotency, sentence determinism, etc.).

## 12. No referential integrity at the CRDT layer

**What:** `applyChange(AddRelationship)` doesn't verify the target exists (`src/core/doc.ts:132-139` — only the source is checked). Dangling refs are caught by `analyze` after the fact.

**Why it matters:** README acknowledges (`README.md:203`): "Referential integrity at the CRDT layer — dangling refs are caught by `analyze()`, not prevented at write time. Rich-CRDT approaches (ElectricSQL, Synql 2024) would push this earlier; for a POC it's overkill."

**Cost to remove:** out of scope for this codebase; would be a different storage substrate.

## Lessons captured under `.erpaval/solutions/conventions/`

These aren't debt — they're the canonical-stack edge cases the project hit and resolved. Documenting them prevents re-hitting:

- pnpm 11 `verify-deps-before-run` + lefthook `prepare` + non-git directory (`pnpm11-prepare-script-and-git-init-order.md`)
- `exactOptionalPropertyTypes: true` and the omit-the-key idiom (`exact-optional-property-types-omit-key-idiom.md`)
- Biome `style/noNonNullAssertion` collides with `noUncheckedIndexedAccess` (`biome-noNonNullAssertion-off-when-noUncheckedIndexedAccess.md`)

The README's `/erpaval` section explains the convention and the three lessons (`README.md:236-303`).

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [Contract map](contract-map.md)
- [Processes](../behavior/processes.md)
