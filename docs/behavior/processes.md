# symspec · Processes

Five end-to-end processes the system runs. Each is identified by the orchestrating function and stepped from input to side effect.

## 1. Apply a single Change record

Entry: `applyChange(doc, raw)` in `src/core/doc.ts:58-160`. Called by every CLI subcommand that mutates state (`src/cli/index.ts:60`, `:84`, `:98`, `:113`, `:133`, `:148`), every mutating MCP tool (`src/mcp/server.ts:74`, `:106`, `:132`, `:162`, `:195`), and every smoke-test mutation.

1. **Schema-validate.** `ChangeSchema.parse(raw)` rejects malformed input; the discriminated-union check on `kind` is what determines the branch (`src/core/doc.ts:59`).
2. **Snapshot timestamp.** `now = new Date().toISOString()` is computed once per call so all writes within the same Change share a `updatedAt` (`src/core/doc.ts:60`).
3. **Open Automerge transaction.** `Automerge.change(doc, draft => { ... })` (`src/core/doc.ts:62`). All mutations inside operate on a proxy.
4. **Branch on `kind`.**
   - `CreateRequirement`: collision check, then build the `Requirement` object with rendered sentence and conditional optional-slot assignment (`src/core/doc.ts:64-100`).
   - `UpdateAttribute`: id check, null-vs-required check, write or `delete`, conditionally re-render sentence (`src/core/doc.ts:102-130`).
   - `AddRelationship`: id check, push if absent (idempotent) (`src/core/doc.ts:132-139`).
   - `RemoveRelationship`: id check no-throw, splice if present (`src/core/doc.ts:141-149`).
   - `DeleteRequirement`: `delete d.requirements[id]` — tombstone, no inbound-edge cleanup (`src/core/doc.ts:151-157`).
5. **Return new Doc.** Automerge returns a structurally-shared new `Doc` instance.

## 2. Save and reload

Entry: `saveDoc(doc, path)` and `loadDoc(path)` in `src/core/doc.ts:33-41`.

1. `Automerge.save(doc)` → `Uint8Array` of binary CRDT format.
2. `fs/promises.writeFile(path, bytes)`.
3. On reload: `fs/promises.readFile(path)` → `Automerge.load<RequirementsDoc>(bytes)` (`src/core/doc.ts:33-36`).

The smoke script asserts roundtrip preservation at `scripts/smoke-incremental.ts:80-90`.

## 3. Concurrent merge with dangling-reference convergence

Entry: `merge(a, b)` in `src/core/doc.ts:172-174`. Demonstrated in `scripts/smoke.ts:79-198`.

1. **Fork.** Both replicas start from the same `base` doc via `Automerge.clone(base)` (`scripts/smoke.ts:83-85`).
2. **Diverge.** Alice creates a node and adds two outbound edges, including one pointing at a node Bob will delete (`scripts/smoke.ts:93-117`). Bob deletes a node and updates an attribute (`scripts/smoke.ts:127-134`).
3. **Merge.** `merge(alice, bob)` returns a converged doc (`scripts/smoke.ts:143`). Internally Automerge applies the two op streams in a deterministic order; concurrent same-attribute writes resolve via Automerge's last-writer-wins on Lamport-timestamped operations (`scripts/smoke-incremental.ts:300-324` exercises this).
4. **Inspect.** `listRequirements(merged)` returns the union: Alice's new node survives, Bob's delete survives, Alice's edge to the deleted target survives as a dangling reference (`scripts/smoke.ts:145-154`).
5. **Verify convergence.** `merge(bob, alice)` produces the same set of requirement IDs as `merge(alice, bob)` (`scripts/smoke.ts:184-198`).

## 4. Analyze a converged doc

Entry: `analyze(doc)` in `src/core/analyze.ts:23-100`. Called by CLI `req analyze` (`src/cli/index.ts:181`), MCP `analysis_run` (`src/mcp/server.ts:245`), and smoke tests.

1. **Snapshot.** `snapshot(doc)` strips Automerge proxies; builds `Set<id>` of every requirement (`src/core/analyze.ts:24-26`).
2. **Edge scan.** For every requirement and every relation, push `DanglingReference` for any target id not in the set (`src/core/analyze.ts:30-43`).
3. **Slot rules.** Push `MissingTrigger` if `event-driven|unwanted-behavior` and no trigger; push `MissingPreCondition` if `state-driven|optional-feature` and no preCondition (`src/core/analyze.ts:46-64`).
4. **Cycle detection.** `findCycles(reqs, 'derives')` — DFS with `onStack` set, dedup by canonical rotation (`src/core/analyze.ts:102-140`). Push one `CycleDetected` per unique cycle.
5. **Orphan detection.** Build `inboundCount` map, count outbound edges per node; push `OrphanRequirement` for any node with both 0 inbound and 0 outbound when `reqs.length > 1` (the single-node case is not an orphan) (`src/core/analyze.ts:79-97`).

## 5. Run the three-tier solver

Entry: `runSolvers(doc, opts?)` in `src/solvers/index.ts:49-110`.

1. **Project.** Map every `Requirement` to a `ReqView` via `asView` (`src/solvers/index.ts:50`, `src/solvers/types.ts:99-111`).
2. **Free tier — exact duplicates.** `detectExactDuplicates(reqs)` — full-tuple hash, one finding per pair within a duplicate group (`src/solvers/free/duplicates.ts:12-46`).
3. **Free tier — ambiguity.** `detectAmbiguity(reqs)` — word-boundary scan against 35 weasel phrases over `preCondition + trigger + systemResponse` (`src/solvers/free/ambiguity.ts:100-122`).
4. **Free tier — candidate pairs.** `emitCandidatePairs(reqs)` — three structural rules (`src/solvers/free/pairwise-filter.ts:55-99`):
   - same `systemName` + same `trigger` + different `systemResponse` → `same-system-same-trigger-different-response`.
   - same `systemName` + overlapping `preCondition` → `same-system-overlapping-precondition`.
   - same `systemName` + lexical similarity ≥ threshold → `near-duplicate-sentence`.
5. **Drop pairs already caught by exact-duplicate.** Filter via `dupedSet` (`src/solvers/index.ts:65-71`).
6. **LLM tier (optional).** If `opts.llm` provided:
   - **Pair judges parallel.** For each candidate (capped at `maxLlmPairs`), spawn `Promise.all([primary, secondary])` (`src/solvers/llm/ensemble.ts:45-49`).
   - **Reconcile.** Both same → high-confidence finding (`src/solvers/llm/ensemble.ts:51-53`, `src/solvers/llm/ensemble.ts:82-134`). Disagree → arbiter or `NeedsReview` (`src/solvers/llm/ensemble.ts:55-79`).
   - **Arbiter (optional).** If `opts.llm.arbiter` provided, call `bedrockArbiter` with the full pair, the free-tier reason, and both prior judgments verbatim (`src/solvers/llm/ensemble.ts:57-67`).
   - **Apply verdict.** Translate `ArbitrationVerdict` into one `SolverFinding`, replacing what would have been `NeedsReview` (`src/solvers/llm/ensemble.ts:136-196`).
   - **Ambiguity ensemble.** Skip requirements already flagged by free tier; spawn parallel judges over the rest (`src/solvers/index.ts:96-106`, `src/solvers/llm/ensemble.ts:223-262`).
7. **Return.** `{ findings, candidatePairs, llmPairsRun }` (`src/solvers/index.ts:43-47`, `src/solvers/index.ts:108-110`).

The arbiter sub-process inside step 6 is itself a full request/response cycle: build XML-tagged user message, force-call `report_arbitration`, parse the tool input from the response (`src/solvers/llm/arbiter.ts:189-209`, `src/solvers/llm/arbiter.ts:276-328`).

## See also

- [Module map](../architecture/module-map.md)
- [Data flow](../architecture/data-flow.md)
- [Business logic](../insights/business-logic.md)
- [Impact analysis](../insights/impact-analysis.md)
