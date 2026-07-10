---
slug: symspec-v2
sequence: 001
hmw_source: n/a  # settled architecture decisions supplied by orchestrator; grounded in nine Explore/Research packets under .erpaval/sessions/session-9c8371/
---

**Status:** COMPLETE

<write_protocol>
Your output file is the single source of truth for your work. Edit it after every meaningful step, before starting the next one. Partial progress written to disk survives timeouts, SendMessage interrupts, and orchestrator context pressure; state held in working memory does not.

The rhythm is: one unit of thought → edit the file with the outcome → next unit. One decision at a time.

Work through your sections in numbered order. For each section:

1. Think through the decision, research finding, or draft. Read adjacent files, run a web search, or consult the framework reference when the answer is not in your head.
2. Edit the file under that section — the claim, the evidence, the user story or HMW or spec statement. Cite sources inline.
3. If the section needs more depth, do another unit of thought and edit again.
4. Move to the next section only after the current one has real content.

Name the tradeoff on every non-obvious call. "Chose JTBD job story over user story for the top-level framing because the goal is reframing around progress, not stakeholder persona" beats "used job story." The synthesizer reads these attributions when composing the final artifact.

Cite adjacent material inline when a decision depends on source evidence — framework file + heading, research synthesis line number, interview quote, or external URL. Reviewers read the citations to verify your reasoning.

When every section has real content, change the `Status:` line at the top of the file from `IN PROGRESS` to `COMPLETE`.
</write_protocol>

---

## Overview

symspec v2 is a CLI-native, formal-methods requirements linter whose primary consumer is a coding agent. It ingests EARS-shaped prose or structured slots, stores requirements in a plain JSON document, runs a forced pipeline of `parse → lint → symbolize → solve`, and returns typed `--json` envelopes with stable error and finding codes. It drops the v1 MCP server, the Bedrock/LLM solver tiers, and Automerge CRDT storage entirely (explore-solvers.md §4, explore-surface.md §2, explore-core.md §2).

The `<subject>` in every acceptance criterion below is `symspec` (the CLI plus its importable library), stated in classic EARS per the role prompt; GEARS subject generalization is used only where a distinct actor (the calling agent, the solver process) matters to the contract.

**Pipeline invariant (forced order, referenced throughout):** `parse → lint → symbolize → solve`. Statements that fail surface checks (parse or blocking lint) are excluded from the formal layer, because feeding unparsed or dangling-reference statements into the SMT encoding is unsound (research-ears-incose.md §4 "the pipeline order is forced"; research-smt.md §4.3; orchestrator decision 10).

**Traceability:** every AC cites the packet finding it encodes. Normative code tables are in Appendix A (ERR_*) and Appendix B (finding codes).

---

## User Story 1 — Storage, schema, and Change records (JSON document)

*As a coding agent, I need a plain, inspectable, schema-validated requirements document with an append-only Change API, so I can read, diff, and mutate the spec without a CRDT binary blob in the way.*

### Acceptance Criteria

AC-1-1 [P]
Ubiquitous: symspec shall persist the requirements document as a single pretty-printed JSON file with lexicographically sorted object keys, so that git diffs are line-level and the file is `cat`/`grep`/hand-editable.
Verification: unit test (serialize a doc, assert byte-stable sorted-key output; round-trip load == save)
Rationale/cite: drop Automerge binary for plain JSON — "Automerge binary is agent-hostile … a plain JSON file is inspectable, git-mergeable at the text level" (explore-core.md §2); orchestrator decision 1.

AC-1-2 [P]
Ubiquitous: symspec shall model the document as `{ schemaVersion: number, requirements: Record<uuid, Requirement> }`, keying requirements by stable UUID in a flat map rather than an array, so references never depend on positional indices.
Verification: unit test (schema shape; UUID key equals `requirement.id`)
Rationale/cite: flat-map-by-UUID shape carried forward unchanged (explore-core.md §3 `RequirementsDoc`; explore-docs.md §1.1 "Flat-map `Record<uuid, Requirement>`").

AC-1-3 [P]
Ubiquitous: symspec shall preserve the EARS domain model of 5 pattern types (`ubiquitous`, `event-driven`, `state-driven`, `optional-feature`, `unwanted-behavior`) with slots `patternType, preCondition, trigger, systemName, systemResponse` and shall render the canonical `sentence` from those slots via a pure renderer rather than accepting an authored sentence.
Verification: unit test (port existing `renderSentence` suite byte-for-byte, including the combined "While P, when T, …" case)
Rationale/cite: "Keep byte-for-byte … Sentence is rendered, never authored" (explore-core.md §1; explore-docs.md §1.1).

AC-1-4 [P]
Ubiquitous: symspec shall define a Zod `RequirementsDocSchema` and validate the document against it at load time, and shall reject a document that is not valid JSON or fails `RequirementsDocSchema` by returning `ERR_DOC_PARSE` (with generic, forward-looking suggestions: check the path, or re-create via `symspec init` + `symspec parse`/`add`), since the JSON file is now hand-editable and must be checked on read. **(SC-2: no legacy-binary detection; unparseable input is plain `ERR_DOC_PARSE`.)**
Verification: unit test (valid doc parses; malformed JSON → ERR_DOC_PARSE; schema-invalid doc → ERR_DOC_PARSE)
Rationale/cite: "v2 should add a Zod `RequirementsDocSchema` for load-time validation of the now-hand-editable JSON file" (explore-core.md §3); ERR_DOC_PARSE must trace to a "shall return" obligation (Appendix A; agent-ux critique).

AC-1-5 [P]
Ubiquitous: symspec shall expose the Change discriminated union (`CreateRequirement`, `UpdateAttribute`, `AddRelationship`, `RemoveRelationship`, `DeleteRequirement`) as the only mutation path, applied through a single `applyChange` function over a plain object.
Verification: unit test (each Change kind mutates a plain-object doc; no Automerge proxy involved)
Rationale/cite: Change-record union is "the only mutation path"; port `applyChange` logic minus Automerge wrapper (explore-core.md §1 "Reusable with rework"; explore-docs.md §1.1).

AC-1-6
Dependencies: AC-1-5
State-driven: While applying an `UpdateAttribute` whose attr is one of `NULLABLE_ATTRS` (`preCondition`, `trigger`, `verificationMethod`), symspec shall treat a null value as "clear the optional attr" (omit the key) and shall re-render the sentence when the updated attr is an EARS slot.
Verification: unit test (null clears optional; EARS-slot edit re-renders; metadata edit does not)
Rationale/cite: null-clears-optional whitelist and five-way re-render gate (explore-core.md §1; explore-docs.md §4 items 3–4).

AC-1-7
Dependencies: AC-1-5
State-driven: While applying `AddRelationship` for an edge that already exists, symspec shall no-op idempotently; and while applying `RemoveRelationship` or `DeleteRequirement` targeting a missing edge or requirement, symspec shall no-op rather than error, preserving the "safe to call defensively" guarantee.
Verification: unit test (port smoke-incremental idempotency scenarios into vitest)
Rationale/cite: idempotency contracts are load-bearing for consumers/tests (explore-docs.md §1.4, §4 item 7).

AC-1-8
Dependencies: AC-1-5
Unwanted behavior: If a `CreateRequirement` supplies a UUID that already exists in the document, then symspec shall reject the Change with `ERR_DUPLICATE_ID` and a suggestion to use `symspec update`.
Verification: unit test (duplicate id → ERR_DUPLICATE_ID envelope)
Rationale/cite: UUID-collision throw mapped to a stable code (explore-core.md §1; explore-docs.md §4 item 7; Appendix A).

AC-1-9
Dependencies: AC-1-4
Unwanted behavior: If a well-formed, JSON-shaped document is loaded whose `schemaVersion` does not equal the current `SCHEMA_VERSION` (which v2 sets to `2`), then symspec shall refuse to operate and return `ERR_SCHEMA_VERSION` with forward-looking suggestions to re-create the document (`symspec init` + `symspec parse`/`add`). This path is disjoint from AC-1-4: any unparseable input routes to `ERR_DOC_PARSE` before the `schemaVersion` field is ever read; `ERR_SCHEMA_VERSION` fires only for valid-JSON, v2-shaped docs carrying an unrecognized version number. **(SC-2: forward-looking only — suggestions never mention v1 or migration.)**
Verification: unit test (v2-shaped JSON with `schemaVersion: 1` → ERR_SCHEMA_VERSION; unparseable input → ERR_DOC_PARSE, NOT ERR_SCHEMA_VERSION; assert `SCHEMA_VERSION === 2`)
Rationale/cite: clean-break format with explicit, forward-looking version error (explore-docs.md §1.3 tech-debt #3; orchestrator decision 1); v2 bumps `SCHEMA_VERSION` to 2 (explore-core.md §2 "bump SCHEMA_VERSION to 2"); buildability critique — the two error paths must be disjoint and reachable.

AC-1-10 — **CANCELLED (SC-1/SC-2, 2026-07-10)**
~~Dependencies: AC-1-9, AC-8-4~~
**CANCELLED.** v2 ships no `symspec migrate` command and behaves as if v1 never existed (see `scope-changes.md` SC-1/SC-2). There is no legacy-binary detection, no migrate-only lazy import, and no `@automerge/automerge` dependency — it is fully removed from `package.json`, the lockfile, `tsdown.config.ts`, and `knip.json`. A document that cannot be loaded is a plain `ERR_DOC_PARSE`; a v2-shaped doc with an unrecognized `schemaVersion` is `ERR_SCHEMA_VERSION`. Both suggest re-creating the document via `symspec init` + `symspec parse`/`add` — never migration. The former AC-1-10↔AC-8-4 coupling is dissolved: AC-8-4 now strips Automerge unconditionally.
~~Original: Event-driven `symspec migrate` reading a v1 Automerge binary via a migrate-only lazy `await import('@automerge/automerge')`.~~

AC-1-11
Dependencies: AC-1-2, AC-1-5
Unwanted behavior: If a write to the document file fails (permissions, disk), then symspec shall return `ERR_IO` without leaving a partially written document, writing atomically (temp file + rename).
Verification: unit test (simulated write failure leaves original intact)
Rationale/cite: JSON storage owns durability that Automerge previously abstracted (explore-core.md §2 decoupling).

---

## User Story 2 — Parse: prose → EARS slots (regex-first ladder)

*As a coding agent, I need to hand symspec natural-language requirement text and get back structured EARS slots — or a mechanical rewrite suggestion when it cannot parse — so I do not have to hand-author slots.*

### Acceptance Criteria

AC-2-1 [P]
Ubiquitous: symspec shall provide a zero-dependency Tier-1 regex parser that classifies input by leading EARS keyword through the ordered cascade `complex → unwanted (if…then) → event (when) → state (while) → optional (where) → ubiquitous`.
Verification: unit test (seed the 16-case validation table from research-nlparse.md §1.7)
Rationale/cite: ordered cascade and "order matters" (research-nlparse.md §1.4; orchestrator decision 5).

AC-2-2
Dependencies: AC-2-1
State-driven: While evaluating any cascade rung, symspec shall treat the rung as matched only if the mandatory main clause `(?:the )?<system> shall <response>` parses; otherwise it shall fall through to the next rung.
Verification: unit test ("While in Rome…" prose does not misclassify as state-driven)
Rationale/cite: mandatory main-clause gate is "the single biggest accuracy lever" (research-nlparse.md §1.1, §1.4).

AC-2-3
Dependencies: AC-2-1
Event-driven: When the parser encounters an event synonym (`upon`, `once`, `after`, `as soon as`, `on receipt of`, `whenever`, `in the event that`) or a non-`shall` modal (`must`, `will`, `should`), symspec shall normalize it to the canonical keyword/`shall` form and record a provenance note (e.g. `nonstandard-modal`) with downgraded confidence.
Verification: unit test ("Upon receipt of…" → event-driven; "must" flagged, medium confidence)
Rationale/cite: event synonyms + modal normalization (research-nlparse.md §1.2; orchestrator decision 5).

AC-2-4
Dependencies: AC-2-2
Event-driven: When the main clause carries an explicit negator (`not`, `never`, `not be able to`) immediately after the modal, symspec shall set `negated: true` and retain the positive response atom, so the formal tier receives `¬R` rather than a string containing "not".
Verification: unit test ("shall not store plaintext" → negated=true, positive atom)
Rationale/cite: negation extraction as a named group (research-nlparse.md §1.3; orchestrator decision 5).

AC-2-5
Dependencies: AC-2-1
Event-driven: When input contains a leading requirement identifier (`REQ-042:`, `SYS-12.`, `3.1.4)`), symspec shall strip it during preprocessing before classification, and shall normalize unicode quotes, collapse whitespace, and drop trailing punctuation.
Verification: unit test (ID-prefixed and smart-quote inputs parse to correct slots)
Rationale/cite: REQ-ID stripping + preprocessing (research-nlparse.md §1.5; orchestrator decision 5).

AC-2-6
Dependencies: AC-2-1
State-driven: While Tier-1 escalation triggers fire (no rung matched; `system` group contains a comma/second keyword/>6 tokens; nested clause keyword; passive main clause; person-word subject; >60 tokens or top-level `and/or`), symspec shall lazily import the wink-nlp Tier-2 parser and attempt POS-driven clause repair, loading the model only on escalation.
Verification: unit test (an escalation-class sentence invokes Tier 2; clean sentences never load wink-nlp)
Rationale/cite: Tier-2 wink-nlp lazy-imported on escalation only (research-nlparse.md §1.8, §2; orchestrator decision 5).

AC-2-7
Dependencies: AC-2-6
Unwanted behavior: If neither Tier 1 nor Tier 2 yields a full-slot parse, then symspec shall return a Tier-3 structured error envelope — an instance of the AC-6-2 error envelope `{apiVersion, type:'error', error, code, suggestions, partial}` — with a stable `ERR_PARSE_*` code (`ERR_PARSE_NO_MODAL`, `ERR_PARSE_AMBIGUOUS_CLAUSES`, `ERR_PARSE_COMPOUND`, `ERR_PARSE_NOT_A_REQUIREMENT`), the partial slots recovered in `partial`, and mechanical rewrite suggestions, rather than emitting a low-confidence guess.
Verification: unit test (compound/ambiguous inputs return correct ERR_PARSE_* + partial + suggestions)
Rationale/cite: Tier-3 = agent punt with structured envelope + mechanical rewrites (research-nlparse.md §5, §6; orchestrator decision 5; Appendix A).

AC-2-8
Dependencies: AC-2-4
Ubiquitous: symspec shall emit, for every parse of a single input line, a `ParseResult` discriminated on `outcome`: `{ outcome: 'ok', pattern, slots, negated, confidence: 'high'|'medium'|'low', tier: 1|2, notes }` on success; `{ outcome: 'skipped', reason: 'no-modal', text }` for no-modal prose (a bullet or sentence carrying no obligation, distinct from a Tier-3 error); or `{ outcome: 'error', code: ERR_PARSE_*, partial, suggestions }` (AC-2-7). A successful result's `slots` feed `CreateRequirementAttrsSchema` directly.
Verification: unit test (each `outcome` variant validates against the `ParseResult` Zod schema; ok-slots accepted by create schema; a no-modal bullet yields `skipped`, not an error)
Rationale/cite: ParseResult shape and slot-target alignment (research-nlparse.md executive summary, §1.1); `skipped` = no-modal prose reported in the envelope (research-nlparse.md §1.5, §6); orchestrator decision 5.

AC-2-9
Dependencies: AC-2-8
Ubiquitous: symspec shall accept batch parse input — `symspec parse --file <path>` or `--stdin` reading one requirement per line (bullets/list markers stripped) — and shall return `{ data: { results: ParseResult[], summary: { ok, skipped, error } } }`, so an agent can hand symspec a whole `requirements.md`. Single-string parse (a positional argument) is the one-element case of this contract.
Verification: unit test (a multi-line file with one ok, one no-modal bullet, one compound line → results[] of length 3 with outcomes ok/skipped/error and a matching summary count)
Rationale/cite: agents "overwhelmingly feed bullet lists" and multi-sentence input; no-modal sentences "reported as skipped in the envelope" (research-nlparse.md §1.5, §6); agent-ux critique — batch is the dominant input shape and was unspecified.

AC-2-10
Dependencies: AC-2-8, AC-1-8
Complex: While minting requirement identity on the CLI create path, when `symspec add` is invoked, symspec shall auto-generate a UUID (returned in the success envelope `data.id`) unless an explicit `--id <uuid>` is supplied, and shall accept EITHER structured slots OR, via `--from-parse`/prose input, a single line that it parses through the Tier-1..3 ladder before creating. `ERR_DUPLICATE_ID` (AC-1-8) therefore fires only when a caller supplies an `--id` that already exists; the auto-generated path cannot collide. The library `CreateRequirement` Change remains caller-owned-UUID (contract-map §6); the CLI `add` is the auto-minting convenience over it.
Verification: unit test (`add` with slots and no `--id` returns a fresh UUID in `data.id`; `add --id <dup>` → ERR_DUPLICATE_ID; `add --from-parse "the API shall reject expired tokens"` parses then creates)
Rationale/cite: parse→create wiring and UUID ownership were undefined (agent-ux critique); "UUID generation is caller-owned" at the library layer (contract-map §6), auto-minted at the CLI for agent ergonomics (orchestrator decision 7); AC-2-8 slots feed `CreateRequirementAttrsSchema`.

---

## User Story 3 — Lint: GtWR rules + free-tier heuristics

*As a coding agent, I need deterministic surface-level lint findings with stable codes, severities, character spans, and rewrite suggestions, so I can fix requirement quality before formalization and know which statements are safe to symbolize.*

### Acceptance Criteria

AC-3-1 [P]
Ubiquitous: symspec shall keep the v1 free-tier deterministic checks — exact-duplicate detection by slot-tuple hash and the weasel-word lexicon scan — carrying them forward unchanged.
Verification: unit test (port `duplicates.test.ts`; exact dup and weasel findings emitted)
Rationale/cite: both free-tier heuristics "SURVIVE UNCHANGED" (explore-solvers.md §1.1, §1.2; orchestrator decision 6).

AC-3-2
Dependencies: AC-3-1
Ubiquitous: symspec shall extend lint coverage to the ~24 regex/lexicon-checkable INCOSE GtWR v4 rules, emitting each finding with a stable code (`GTWR_R<n>_<slug>`), a severity (`error`|`warn`|`info`), the offending character span, and a rewrite suggestion where one is defined.
Verification: unit test (one fixture per rule triggers its code with correct severity/span)
Rationale/cite: ~24 T1 rules with stable codes, severity, span, suggestion (research-ears-incose.md §2 checkability rollup, §4 Layer A; orchestrator decision 6; Appendix B).

AC-3-3
Dependencies: AC-3-2
State-driven: While a rule has legitimate exceptions (absolutes R26, universal quantifiers R32, indefinite temporal words R35, negation R16 inside a defined logical expression), symspec shall emit those findings at `warn` severity excluded from any pass/fail gate rather than `error`.
Verification: unit test (a legitimate "disregard all signals when override ON" → warn, not error)
Rationale/cite: QVscribe severity practice — warnings excluded from scoring (research-ears-incose.md §2 R26/R32/R35, §5).

AC-3-4
Dependencies: AC-3-1
Ubiquitous: symspec shall retain the pairwise candidate filter (Rule 1 same-trigger-different-response, Rule 2 overlapping-precondition, Rule 3 Jaccard≥0.7 near-duplicate) as the candidate generator for the PAIRWISE formal checks ONLY — subsumption and redundancy (AC-4-5) — deduping pairs already caught as exact duplicates. It does NOT gate contradiction or vacuity: those run per-context-group over the whole spec (AC-4-3/4-4), independent of the pairwise filter, because context groups are not pairs and a contradiction can involve a requirement no pair-rule flagged. Rule 3 (Jaccard) additionally feeds the info-severity similar-but-not-unified reporter (AC-4-12).
Verification: unit test (candidate pairs emitted with correct `reason`; exact-dup pairs excluded; assert contradiction detection fires on a conflict whose two requirements are NOT emitted as a candidate pair)
Rationale/cite: pairwise filter "SURVIVES, repurposed" but §1.4/§1.5 scope it to pairs sharing response atoms — "the existing pairwise filter's rule 2 is the right candidate generator" for subsumption/redundancy; context-group (option 1) and pairwise (option 2) are ALTERNATIVES, not composed (research-smt.md §1.2, §1.4, §1.5; explore-solvers.md §1.3, §1.4; buildability critique — resolves the two-strategy composition ambiguity; orchestrator decision 6).

AC-3-5 [P]
Ubiquitous: symspec shall retain the v1 structural checks as a fast Tier-0 pass — `FND_DANGLING_REFERENCE`, `FND_MISSING_TRIGGER`, `FND_MISSING_PRECONDITION`, `FND_CYCLE`, `FND_ORPHAN` — running on a plain-object snapshot with no solver.
Verification: unit test (port `analyze.test.ts`; all five structural finding kinds)
Rationale/cite: Tier-0 structural checks kept, prerequisite for the formal tier (explore-core.md §4 "Tier 0"; orchestrator decision 6).

AC-3-6
Dependencies: AC-3-5
Unwanted behavior: If cycle detection finds the same cycle from different entry nodes, then symspec shall dedupe it by canonical rotation to the lexicographically-smallest node id, fixing the v1 `findCycles` dedupe no-op bug.
Verification: unit test (self-loop `a derives a` and same cycle from two entry points each reported once)
Rationale/cite: v1 `Math.min` over indices "is always 0 … effectively a no-op bug"; fix by lexicographic rotation (explore-core.md §4 gaps; orchestrator decision 6).

AC-3-7
Dependencies: AC-3-2
State-driven: While lint runs before the formal layer in the forced pipeline, symspec shall mark statements that fail a parse or a blocking (`error`-severity) surface check as excluded from symbolization, so the SMT layer never receives unsound input.
Verification: unit test (an error-severity statement is absent from the atom table / solver input)
Rationale/cite: "Rules that fail at Layer A make Layer C unsound … pipeline order is forced" (research-ears-incose.md §4; orchestrator decision 10).

---

## User Story 4 — Formal check: SMT encoding, findings, unsat cores

*As a coding agent, I need symspec to detect logical contradictions, subsumption, redundancy, and vacuity across requirements using an in-process SMT solver, and to name the exact requirement IDs responsible, so I can fix real conflicts with a machine-checkable basis.*

### Acceptance Criteria

AC-4-1 [P]
Ubiquitous: symspec shall use the `z3-solver` npm WASM package as the default formal backend, initialized in-process, requiring no external binary for a working `symspec check`.
Verification: smoke (fresh install → `symspec check` runs the SMT tier with no PATH binary)
Rationale/cite: verified default — 33 MB dep, ~110 ms init, zero-install determinism (research-smt.md §0, §3.1; orchestrator decision 2).

AC-4-2
Dependencies: AC-4-1, AC-2-4
Ubiquitous: symspec shall encode each requirement as a guarded implication with an assumption literal — `REQ-i ⇒ (context ⇒ response)` — deriving Boolean atoms via the atom table (AC-4-2a), and shall keep the encoder a pure, unit-testable function separate from the solver call.
Verification: unit test (per-pattern formula shape; encoder is pure over ReqView)
Rationale/cite: guarded implications with assumption literals; encoding table per pattern (research-smt.md §1.1, §2.1; orchestrator decision 2).

AC-4-2a
Dependencies: AC-4-1, AC-2-4
Ubiquitous: symspec shall construct Boolean atoms through a single pure `atomize` function — the load-bearing contract every formal finding depends on — with this exact, conservative, near-exact normalization pipeline: lowercase → strip leading articles (`a`/`an`/`the`) → strip punctuation → collapse whitespace → underscore-join. Normalization MUST NOT stem, lemmatize, or strip stopwords beyond leading articles. Every atom MUST be scoped per `systemName` (e.g. `sys__auth_service__resp__issue_a_session_token`), so identical response text under two different systems yields two distinct atoms and never unifies into a spurious cross-system contradiction. The response-negation extraction MUST consume AC-2-4's `negated` flag to emit `¬R` on the SAME atom (not an atom whose text contains "not"). symspec shall additionally apply a curated seed antonym table that unifies polar-opposite responses onto one atom with opposite polarity — at minimum the pairs: accept↔reject, enable↔disable, grant↔revoke, allow↔deny, permit↔forbid, approve↔reject, lock↔unlock, open↔close, activate↔deactivate, connect↔disconnect, include↔exclude, add↔remove, start↔stop, show↔hide, accept↔decline. The antonym table is a named, extensible resource (`symspec atoms merge` escalation, AC-4-12) but ships with these seeds.
Verification: unit test (`atomize` is pure and deterministic; article stripping, punctuation, whitespace-collapse, and underscore-join each covered; two systems with identical response text produce distinct scoped atoms; "shall not X" and "shall X" produce the same atom with opposite polarity; "shall grant access" and "shall revoke access" unify to one atom via the antonym table with opposite polarity; NO stemming — "issues" and "issue" remain distinct)
Rationale/cite: atomization is the single load-bearing component and was unspecified (soundness critique, blocker); normalization + per-systemName scoping + negation-in-response + curated antonym table (research-smt.md §4.1, §4.2); AC-2-4 supplies `negated`. Without per-system scoping cross-system contradictions are spurious; without the antonym table the common "grant vs revoke" contradiction is a false negative and AC-4-4 is nearly vacuous.

AC-4-3
Dependencies: AC-4-2
State-driven: While checking for contradictions, symspec shall run per-context-group reachability checks — grouping requirements by unifiable context atoms and, for each group, asserting THAT group's context atoms true while including ALL requirement formulas in the conjunction (every requirement's guarded implication as an assumption literal, whole-spec, not just the group) — and shall never assert all triggers true in one global conjunction. Including the whole spec is mandatory because other requirements — including ubiquitous ones (bare `R`, belonging to no context group) — participate via shared response atoms; a ubiquitous `¬R` that conflicts with an event-driven `T⇒R` is only reachable when the ubiquitous formula is present in the T-group's check.
Verification: unit test (mutually exclusive triggers do not produce a spurious conflict; guarded conflict is found; a ubiquitous `¬R` plus an event-driven `T⇒R` produces FND_CONTRADICTION when T's group is checked — proving whole-spec inclusion)
Rationale/cite: reachability subtlety — `(X⇒Y)∧(X⇒¬Y)` is SAT unless context asserted; conjunction is over "all requirement formulas (whole spec, not just the group)"; `solver.check(...allGuards, ctxAtoms asserted)` (research-smt.md §1.2 item 1, §5; orchestrator decision 2; soundness critique — group-only scope misses ubiquitous-vs-guarded conflicts).

AC-4-4
Dependencies: AC-4-3
Event-driven: When a context-group check returns `unsat`, symspec shall extract the MINIMAL unsat core, filter out `CTX-*` context assertions, and emit an `FND_CONTRADICTION` finding whose requirement IDs are exactly the remaining `REQ-*` minimal-core members. Because unsat cores are NOT guaranteed minimal by default and the conjunction spans the whole spec (AC-4-3), the WASM in-process path MUST enable core minimization (`:smt.core.minimize true` for in-process Z3, or minimize via assumption-literal re-checks); the emitted-artifact path (AC-4-8) documents the per-solver minimization option (`--minimal-unsat-cores` for cvc5) WITHOUT baking any z3-only option into the portable `.smt2`. A contradiction is detectable only when the two responses resolve to the SAME atom with opposite polarity (explicit negation via AC-2-4, or the AC-4-2a antonym table); conflicts across unrelated response atoms are a documented false-negative (sound-modulo-atomization, AC-4-11), because `T⇒R1 ∧ T⇒R2` with `T` asserted is SAT.
Verification: unit test (planted 2-way conflict, constructed via a negated/antonym-shared response atom → FND_CONTRADICTION with EXACTLY the two IDs and no innocent third; a distinct-response-atom "conflict" correctly emits nothing; core minimization asserted by planting an innocent requirement that shares no atom and confirming it is absent from the core)
Rationale/cite: unsat core → requirement IDs, filter CTX-* names (research-smt.md §1.3); cores not minimal without `:smt.core.minimize`/`--minimal-unsat-cores` (research-smt.md §2.2); "minimal conflicting subset" (research-kiro.md §4); same-atom-opposite-polarity precondition (research-smt.md §1.3); soundness critique — minimization prevents over-broad culprit lists and flaky "exactly two IDs" tests; orchestrator decisions 2–3; Appendix B.

AC-4-5
Dependencies: AC-4-2, AC-3-4
Ubiquitous: symspec shall decide subsumption and redundancy over the candidate pairs from the pairwise filter (AC-3-4), and vacuity relationally over the whole spec, emitting `FND_SUBSUMPTION` (directional), `FND_REDUNDANCY`, and `FND_VACUITY`:
- **Subsumption (direction pinned):** for a candidate pair, check both implication directions. `moreGeneral` is the requirement whose FORMULA logically implies the other's — i.e. `formula_general ∧ ¬formula_specific` is unsat — equivalently the requirement that fires in the SUPERSET of cases (`guard_specific ⇒ guard_general`). The narrower requirement is `moreSpecific`. If exactly one direction holds, the antecedent side of that valid implication is `moreGeneral`. The finding MUST populate `moreGeneral`/`moreSpecific` by this rule, never positionally.
- **Redundancy:** if BOTH implication directions hold (bi-implication valid), emit `FND_REDUNDANCY` instead of `FND_SUBSUMPTION`.
- **Vacuity (relational, not a lone unsat guard):** a guard atom or conjunction of distinct atoms is ALWAYS satisfiable in isolation, so vacuity is NOT "unsatisfiable guard." Instead, assert the conjunction of (domain invariants + ALL OTHER requirement formulas + this requirement's context/guard atom(s)) and check unsat; unsat means the guard is unreachable given the rest of the spec. With regex-only parsing this only bites when one requirement's response atom is another's negated precondition atom, so `FND_VACUITY` MUST be emitted at a labeled/lower confidence reflecting that.
Verification: unit test (an asymmetric pair asserts the exact `moreGeneral`/`moreSpecific` field assignment — a fixture pins the direction; a bi-implication pair emits FND_REDUNDANCY not FND_SUBSUMPTION; a vacuous guard is detected via the relational whole-spec check, and a guard that is merely unsat-in-isolation is NOT flagged)
Rationale/cite: subsumption formula-level direction `(X⇒Y)⇒((P∧X)⇒Y)` (research-smt.md §1.4) reconciled with guard-level `guard_specific ⇒ guard_general` (explore-solvers.md §2.1) — both pinned to one surface rule; vacuity is relational across requirements (research-smt.md §1.5), NOT a lone unsat guard; subsumption/redundancy scoped to pairwise candidates (research-smt.md §1.4/§1.5, AC-3-4); soundness critique — fixes the coin-flip direction trap and the formally-wrong vacuity clause; orchestrator decision 3; Appendix B.

AC-4-5a
Dependencies: AC-4-2
State-driven: While checking completeness as a heuristic (warn/info tier, NOT a formal guarantee), for each same-trigger-family group symspec shall check SAT of `¬(C1 ∨ … ∨ Cn)` over the group's precondition atoms; a satisfying model is an uncovered case and symspec shall emit `FND_INCOMPLETE` (info severity) naming the group. symspec shall document that this heuristic only bites when the group's preconditions normalize to complementary atoms, and is explicitly not a completeness proof.
Verification: unit test (a group with a genuine else-branch gap → FND_INCOMPLETE info; a group whose preconditions cover the space → no finding)
Rationale/cite: FND_INCOMPLETE was an orphan code with no producer (soundness + agent-ux critiques); completeness is a heuristic "no else-branch" lint that "only bites when preconditions normalize to complementary atoms … rather than a formal guarantee" (research-smt.md §1.5); Kiro incompleteness→FND_INCOMPLETE mapping (research-kiro.md §4); Appendix B.

AC-4-12
Dependencies: AC-3-4, AC-4-2a
Ubiquitous: symspec shall reuse the Rule 3 Jaccard pass (AC-3-4) to emit an info-severity `FND_SIMILAR_UNUNIFIED` finding for atom/response pairs that are suspiciously similar (Jaccard ≥ 0.7) but did NOT unify to one atom under the conservative normalization/antonym table — surfacing the one over-unification-adjacent risk class as a review prompt rather than manufacturing a conflict — and shall point the agent at the `symspec atoms merge` escalation for genuine synonyms the seed antonym table missed.
Verification: unit test (two near-synonym responses that do not auto-unify → FND_SIMILAR_UNUNIFIED info with both requirement IDs; identical/auto-unified responses do not trigger it)
Rationale/cite: mitigation for the near-miss false-positive/negative class (research-smt.md §4.3); the Jaccard-reuse + `symspec atoms merge` escalation was absent from every AC and Appendix B (soundness critique); Appendix B.

AC-4-6
Dependencies: AC-4-4, AC-4-5
Ubiquitous: symspec shall attach to every formal finding an `evidence` field carrying the atom-table entries and the unsat core (or witness model), so the calling agent can audit exactly what the solver compared.
Verification: unit test (finding includes atom table + core; serializable JSON)
Rationale/cite: "every finding must cite [the atom table]"; machine-checkable evidence field (research-smt.md §4.1; explore-solvers.md §3 Contradiction evidence).

AC-4-7
Dependencies: AC-4-3
Unwanted behavior: If a PER-GROUP solver check returns `unknown` or exceeds the per-group timeout (default 2000 ms), then symspec shall ALWAYS emit `FND_NEEDS_REVIEW` with the group's requirement IDs, continue the run, and never interpret an inconclusive result as "no conflict". The `ERR_SOLVER_TIMEOUT`/`ERR_SOLVER_INCONCLUSIVE` error codes are reserved strictly for WHOLE-RUN failures (overall `--solver-budget-ms` exhausted, WASM solver-init failure) that abort the run — never for a single group. Boundary rule: per-group inconclusive → finding, run continues; whole-run/solver-init failure → error envelope, run aborts.
Verification: unit test (forced per-group timeout/unknown → FND_NEEDS_REVIEW, run still completes with other groups' findings; forced whole-run budget exhaustion → ERR_SOLVER_TIMEOUT error envelope)
Rationale/cite: treat per-group unknown/timeout as NeedsReview, "never as no conflict" (research-smt.md §2.3; explore-solvers.md §2.3); soundness critique — Appendix A's ERR_SOLVER_TIMEOUT "per-group" wording contradicted AC-4-7; boundary made crisp (Appendix A note reconciled below).

AC-4-8
Dependencies: AC-4-2
Optional feature: Where the operator passes `--emit-smt2`, symspec shall write standard-conformant SMT-LIB2 text (using `(set-logic ALL)`, keeping Z3-only options out of the portable file) as an exportable artifact.
Verification: unit test (emitted `.smt2` parses under a standard reader; no z3-only prelude)
Rationale/cite: portable SMT-LIB2 artifact; `(set-logic ALL)` for cvc5 compatibility (research-smt.md §0, §1.3, §3.3; orchestrator decision 2).

AC-4-9
Dependencies: AC-4-8
Optional feature: Where the operator supplies `--solver-path`, the `SYMSPEC_Z3` env var, or a discoverable `z3`/`cvc5` on PATH, symspec shall run the emitted SMT-LIB2 through that binary backend as an optional cross-check, resolving in order `--solver-path → SYMSPEC_Z3 → PATH`.
Verification: smoke (with a binary present, `--solver z3-bin` reproduces the WASM verdict)
Rationale/cite: discovery order + optional binary backends consuming the emitted artifact (explore-surface.md §4; research-smt.md §2.2; orchestrator decision 2).

AC-4-10
Dependencies: AC-4-9
Unwanted behavior: If a binary backend is requested but no solver is found by the discovery order, then symspec shall return `ERR_SOLVER_MISSING` with a suggestion containing the exact `mise use github:Z3Prover/z3@z3-4.16.0` install command.
Verification: unit test (binary mode with no solver → ERR_SOLVER_MISSING + mise suggestion)
Rationale/cite: actionable ERR_SOLVER_MISSING with mise install suggestion (explore-surface.md §4; orchestrator decision 2; Appendix A).

AC-4-11
Dependencies: AC-4-6
Ubiquitous: symspec shall document, in its manifest and finding output, that the formal tier is *sound modulo atomization, GIVEN the conservative near-exact normalization of AC-4-2a* — every reported conflict is real when atomization is conservative, but silence is not a consistency certificate — that over-unification is the one false-positive risk, mitigated by (a) conservative normalization (no stemming/stopword-stripping beyond articles) and (b) the info-severity `FND_SIMILAR_UNUNIFIED` reporter (AC-4-12); and that contextual ambiguity is not checked (punted to the calling agent).
Verification: unit test (assert the manifest text contains the exact substrings "sound modulo atomization", "silence is not", and the not-checked boundary for contextual ambiguity — snapshot/grep, not manual)
Rationale/cite: "sound-modulo-atomization; silence is not a certificate"; false-positive class is over-aggressive normalization, mitigated by conservative atomization + similar-but-not-unified reporter (research-smt.md §4.3; explore-solvers.md §2.2); soundness + buildability critiques — claim qualified GIVEN AC-4-2a, verification converted from manual to unit test; orchestrator decisions 2–3.

---

## User Story 5 — Certify: optional Lean 4 tier

*As a coding agent that needs a durable, kernel-checked artifact, I want an optional `symspec certify` tier that emits and checks a batched Lean file, without it ever blocking the default SMT tier.*

### Acceptance Criteria

AC-5-1 [P]
Optional feature: Where `symspec certify` is invoked, symspec shall generate exactly one batched core-Lean file for the whole spec, importing only core Lean plus Std (no Mathlib, no lakefile) and using `decide`/`omega`/`bv_decide`/`grind` tactics.
Verification: smoke (generated file elaborates under bare `lean` with no lake project)
Rationale/cite: one batched core-Lean file, verified-sufficient tactic subset, no Mathlib/lake (research-lean4.md §1.1, §4 Tier L; orchestrator decision 4).

AC-5-2
Dependencies: AC-5-1
Event-driven: When the certify tier runs the Lean file, symspec shall invoke `lean --json`, parse the newline-delimited JSON diagnostics, and map exit code 0 to certified and any `severity:"error"` diagnostic to a certification failure.
Verification: unit test (fixture NDJSON diagnostics parsed; exit-code mapping correct)
Rationale/cite: `lean --json` NDJSON pipeline and exit-code semantics (research-lean4.md §1.1; orchestrator decision 4).

AC-5-3
Dependencies: AC-5-1
Optional feature: Where certification succeeds, symspec shall surface `#print axioms` provenance and retain the generated `.lean` file (with an emitted `lean-toolchain` pin) as a re-checkable, committable artifact.
Verification: smoke (certify emits .lean + lean-toolchain; #print axioms provenance captured)
Rationale/cite: proof-term certificates, axiom provenance, pinned toolchain artifact (research-lean4.md §2.1, §4; orchestrator decision 4).

AC-5-4
Dependencies: AC-5-2
Unwanted behavior: If `symspec certify` is requested but no Lean toolchain is discoverable, then symspec shall return `ERR_LEAN_TOOLCHAIN_MISSING` with an `elan default stable` suggestion and shall not affect any prior SMT-tier result.
Verification: unit test (no toolchain → ERR_LEAN_TOOLCHAIN_MISSING + elan suggestion)
Rationale/cite: ERR_LEAN_TOOLCHAIN_MISSING + elan suggestion; "never block Tier S" (research-lean4.md §1.3, §4; orchestrator decision 4; Appendix A).

AC-5-5
Dependencies: AC-5-4
State-driven: While the default `symspec check` runs, symspec shall not invoke the Lean tier and shall not require any Lean toolchain, keeping certification strictly opt-in.
Verification: smoke (`symspec check` with no Lean installed succeeds)
Rationale/cite: Lean is an optional certificate tier, not the default engine (research-lean4.md TL;DR, §4; orchestrator decision 4).

---

## User Story 6 — Agent-friendly CLI surface

*As a coding agent, I need a self-describing command surface with typed JSON envelopes, stable error codes, and dense output, so I can drive symspec programmatically without scraping human prose.*

### Acceptance Criteria

AC-6-1 [P]
Ubiquitous: symspec shall expose a `manifest` command that emits, as JSON, the full command inventory, argument schemas, error codes, and finding codes derived from the Zod schemas and their `.describe()` corpus rather than hand-written prose.
Verification: unit test (manifest JSON validates; command/arg entries derive from Zod `.describe()`)
Rationale/cite: pattern 1 self-describing manifest from Zod + `.describe()` corpus (explore-surface.md §1; explore-core.md §3; orchestrator decision 7).

AC-6-2
Dependencies: AC-6-1
Ubiquitous: symspec shall wrap every successful command result in the typed envelope `{ apiVersion, type, data }` and every failure in the superset error envelope `{ apiVersion, type: 'error', error, code, suggestions, partial? }`. BOTH envelopes carry `apiVersion` and a discriminant `type`, so an agent can version-negotiate and switch on `type` uniformly across success and error. `partial` is optional and carries recovered partial slots for Tier-3 parse errors (AC-2-7). The Tier-3 parse result (AC-2-7) is an instance of this error envelope with its `partial` populated.
Verification: unit test (success and error envelopes validate against their Zod schemas; both carry `apiVersion` and `type`; a Tier-3 parse error round-trips with `partial`; the Zod schema snapshot includes both envelope shapes)
Rationale/cite: pattern 2 typed envelopes (explore-surface.md §1; explore-docs.md §4 item 10); agent-ux critique — error envelope needed `apiVersion`/`type`/`partial` to match AC-2-7 and share a discriminant; `{error,code,partial,suggestions}` shape (research-nlparse.md §5); orchestrator decision 7.

AC-6-2a
Dependencies: AC-6-2
Ubiquitous: symspec shall emit the typed JSON envelope as the DEFAULT output for every command with no flags; a human-readable rendering is opt-in ONLY via an explicit `--pretty` (alias `--human`) flag. There is no human-eyes-only escape hatch and an agent never needs to remember a flag to get parseable output. Any `--json` token appearing in other ACs or help text is a no-op compatibility alias that selects the already-default JSON envelope, never a gate that must be passed to obtain JSON.
Verification: unit test (`symspec check` with zero flags emits a valid `{apiVersion,type,data}` envelope on stdout; `--json` produces byte-identical output to no flag; `--pretty` produces human prose)
Rationale/cite: agent-ux critique (blocker) — default output mode was undefined and the spec was internally contradictory (`--json` referenced as opt-in while AC-6-2 rationale claimed parse-by-default); JSON is the zero-flag default, prose is opt-in (explore-surface.md §1; explore-docs.md §4 item 10; orchestrator decision 7).

AC-6-2b
Dependencies: AC-6-2, AC-3-2
Ubiquitous: symspec shall define a process exit-code contract for the `check` linter loop: exit `0` when the pipeline completed and no `error`-severity finding is present; exit `1` (findings-failure) when the pipeline completed but one or more `error`-severity findings are present — still emitting a valid `{apiVersion,type,data}` envelope on stdout; and a distinct exit `2` for `ERR_*` operational failures (crash/usage/IO/solver-init), emitting the error envelope. The envelope is ALWAYS written to stdout regardless of exit code, and `--json`/`--dense`/`--pretty` never change the exit code. This is the pass/fail gate AC-3-3 and AC-3-7 reference.
Verification: unit test (clean spec → exit 0; spec with an error-severity finding → exit 1 with findings envelope on stdout; a missing document → exit 2 with ERR_DOC_NOT_FOUND envelope; warn/info-only findings → exit 0)
Rationale/cite: agent-ux critique (blocker) — no exit-code contract existed though `check` is driven in an edit/CI loop; distinguishes findings-failure from ERR_* crash (AC-3-3 "pass/fail gate", AC-3-7 "blocking surface check"); orchestrator decision 9.

AC-6-3
Dependencies: AC-6-2
Ubiquitous: symspec shall define `ERR_*`, `FND_*`, and `GTWR_*` codes as three single exported Zod enums, each with a per-code `.describe()`; the manifest (AC-6-1) and generated docs shall derive their code tables from those enums (not hand-written), and both the emitters and the manifest shall read the SAME enum. symspec shall emit these codes stably and append-only — never renumbering or removing an existing code across ALL THREE catalogs — pairing each error with actionable `suggestions`. A snapshot/reachability test shall guard append-only for ERR_*, FND_*, AND GTWR_* alike, and assert each documented code is reachable.
Verification: unit test (each documented ERR_*/FND_*/GTWR_* is reachable; snapshot test guards against removal for all three enums; manifest code tables derive from the exported Zod enums, verified by mutating a `.describe()` and observing the manifest change)
Rationale/cite: pattern 3 stable append-only codes (explore-surface.md §1; explore-docs.md §1.4); agent-ux critique — finding codes were not single-sourced and had no append-only guard, risking manifest/emitter drift; single-source `.describe()` design (explore-docs.md §4 item 1); orchestrator decision 7; Appendices A/B.

AC-6-4
Dependencies: AC-6-2
Optional feature: Where `--dense` is passed, symspec shall emit token-economical output by: (1) minified JSON (no pretty-print/whitespace), (2) omitting keys whose value equals the schema default or is null, and (3) eliding heavy `evidence`/atom-table fields (AC-4-6) unless `--evidence` is ALSO passed — while keeping field NAMES and the typed schema identical (no field-name abbreviation, since that would break "same typed structure"). Dense output MUST validate against the same Zod schema as non-dense and round-trip.
Verification: unit test (`--dense` output is minified, omits default/null keys, elides evidence unless `--evidence`; validates against the SAME Zod schema as non-dense and round-trips to an equal object)
Rationale/cite: pattern 4 `--dense` mode (explore-surface.md §1; orchestrator decision 7); agent-ux critique — "compact" was an untestable weasel definition; pinned to minify + omit-defaults + elide-evidence with identical field names.

AC-6-5 [P]
Ubiquitous: symspec shall ship an importable library with an `exports` map and generated `.d.ts` types, with the CLI implemented as a thin formatter over that library API.
Verification: unit test (import the library API in a consumer module; CLI calls the same functions)
Rationale/cite: pattern 5 programmatic API parity; add `exports` map + `dts:true` (explore-surface.md §1, §3; orchestrator decision 7).

AC-6-6
Dependencies: AC-6-2
Complex: While no `--doc`/`SYMSPEC_DOC`/positional `<file>` is supplied, when a document-bound command runs, symspec shall resolve the document path in the order positional `<file>` → `SYMSPEC_DOC` env → a default path, unifying the path convention across all commands; and if no document resolves at the chosen path, symspec shall return `ERR_DOC_NOT_FOUND` with a suggestion to run `symspec init <file>` / check `SYMSPEC_DOC`.
Verification: unit test (each resolution source wins in the documented precedence; a resolved-but-nonexistent path → ERR_DOC_NOT_FOUND envelope)
Rationale/cite: unify doc path convention — positional + SYMSPEC_DOC + default (explore-surface.md §1; orchestrator decision 7); agent-ux critique — ERR_DOC_NOT_FOUND lacked a "shall return" emit obligation, failing AC-6-3 reachability (Appendix A).

AC-6-7
Dependencies: AC-6-5
Ubiquitous: symspec shall derive its version string from a single source (`package.json`) for both the CLI and the manifest, eliminating the v1 hardcoded-`0.1.0` duplication.
Verification: unit test (CLI `--version` == manifest version == package.json version)
Rationale/cite: version duplicated in v1; manifest should derive from one source (explore-surface.md §1).

AC-6-8
Dependencies: AC-6-2, AC-3-2, AC-3-5, AC-3-7, AC-4-6
Ubiquitous: symspec shall wire ALL tiers — Tier-0 structural (AC-3-5), lint free+GtWR (AC-3-2), and the formal SMT tier (AC-4-6) — into the single `check` command producing one typed envelope, honoring the pipeline-exclusion gate (AC-3-7) so error-severity statements never reach the formal layer, so the v1 failure of shipping an unwired `runSolvers()` does not recur. This AC depends on the tier outputs it wires (not merely the envelope AC-6-2) — a wave planner MUST NOT schedule it before those tiers exist, or it could be "satisfied" wiring empty stubs and reproduce the exact v1 unwired-solver failure it targets.
Verification: smoke (`symspec check` returns structural + lint + formal findings together in one `data.findings[]`; AND an error-severity statement is confirmed ABSENT from the formal tier's atom table/input — tying AC-3-7 into the wiring proof)
Rationale/cite: "the check/analyze command MUST wire ALL tiers … v1 shipped runSolvers() unwired; that failure must not recur" (orchestrator decision 9; explore-solvers.md §0; explore-docs.md §1.2 tech-debt #1); buildability critique — the wiring criterion must depend on the tiers, not on the inventory AC-6-9.

AC-6-9
Dependencies: AC-6-2, AC-2-8, AC-3-2, AC-4-6, AC-5-2
Ubiquitous: symspec shall provide the v2 command inventory — `manifest`, `init`, `add`, `update`, `parse`, `check`, `certify`, `list`, `show`, `derive`/`satisfy`/edge ops, `delete`, `export`, `migrate` — porting the superior v1 MCP tool descriptions (what/when/returns/idempotency prose) into each command's help and manifest entry.
Verification: manual (inventory present; MCP description prose ported into help/manifest)
Rationale/cite: command inventory + "port the good MCP tool descriptions … into the manifest" (explore-surface.md §1, §5; orchestrator decision 8).

AC-6-10
Dependencies: AC-6-2
Unwanted behavior: If a command is invoked with invalid or missing arguments, then symspec shall return `ERR_USAGE` (or the specific `ERR_NOT_FOUND`/`ERR_INVALID_RELATION`/`ERR_INVALID_ATTR` as applicable) as a typed error envelope rather than an unhandled stack trace.
Verification: unit test (bad relation → ERR_INVALID_RELATION; unknown id → ERR_NOT_FOUND; each is an envelope)
Rationale/cite: v1 errors were ad-hoc `console.error`+`exit(1)` or unhandled throws; replace with typed codes (explore-surface.md §1; explore-docs.md §1.4; Appendix A).

AC-6-11
Dependencies: AC-6-10
Ubiquitous: symspec shall replace the v1 magic string-`"null"` sentinel in `update` with an explicit `--clear` flag, so the typed CLI has no stringly-typed nulls.
Verification: unit test (`update --clear` clears an optional attr; literal "null" is stored as text, not null)
Rationale/cite: tech-debt #2 fix — `--clear` flag, "a typed `--json` CLI must not have magic string sentinels" (explore-docs.md §1.3).

AC-6-12
Dependencies: AC-6-2
Ubiquitous: symspec shall define `apiVersion` as a distinct envelope-contract integer, bumped only on a breaking envelope-shape change, independent of both the package version (AC-6-7) and the document `schemaVersion` (AC-1-2). symspec shall expose the current `apiVersion` in the manifest and stamp it on every success and error envelope.
Verification: unit test (`apiVersion` is an integer, equals the manifest's `apiVersion`, and is NOT tied to package.json version or document schemaVersion)
Rationale/cite: agent-ux critique (minor) — `apiVersion` semantics were undefined though agents switch on it; distinct envelope-contract integer disambiguates it from the two other version fields.

AC-6-13
Dependencies: AC-6-2, AC-6-9
Ubiquitous: symspec shall define the closed, append-only set of envelope `type` discriminants (one per result-bearing command — e.g. `manifest`, `parseResult`, `findings`, `requirement`, `list`, `error`, …) as a single exported Zod enum, and the manifest (AC-6-1) shall derive its `type` table from that same enum, with the same append-only snapshot guard as AC-6-3.
Verification: unit test (every result-bearing command's envelope `type` is a member of the enum; manifest lists the enum; snapshot guards append-only)
Rationale/cite: agent-ux critique (minor) — `type` is a discriminant an agent switches on but had no closed, append-only table unlike ERR_*/FND_*; brings it to parity (AC-6-2, AC-6-9, Appendix parity).

AC-6-14
Dependencies: AC-6-1, AC-4-1, AC-4-9, AC-5-4
Ubiquitous: symspec shall have the `manifest` command report, as structured `backends` data, the availability and resolved path/version of each optional backend — z3-wasm (always available, in-process), external `z3`/`cvc5` binaries (via the AC-4-9 discovery order), and the Lean toolchain (AC-5-4) — so an agent can query-then-decide before invoking `certify` or `--solver`, rather than fail-then-learn.
Verification: unit test (manifest `backends` reports z3-wasm available; reports binary/Lean availability with resolved path when present and `available:false` when absent)
Rationale/cite: agent-ux critique (minor) — capability was only surfaced post-failure via ERR_SOLVER_MISSING/ERR_LEAN_TOOLCHAIN_MISSING; "doctor/manifest command should report Lean as optional, not installed" (research-lean4.md §1.3); manifest gains runtime backend availability.

---

## User Story 7 — Packaging, docs, and generated agent guidance

*As a maintainer, I need the package metadata, dependency graph, and docs to reflect the v2 architecture, with agent-facing docs generated from the same doc-comment corpus that drives the manifest.*

### Acceptance Criteria

AC-7-1 [P]
Ubiquitous: symspec shall generate `AGENTS.md` in CI from the manifest/doc-comment corpus, so the agent-integration docs stay in lockstep with the actual command surface.
Verification: smoke (CI regenerates AGENTS.md; drift from manifest fails the build)
Rationale/cite: pattern 6/8 — doc-comments drive manifest + generated AGENTS.md in CI (explore-surface.md §1; orchestrator decision 7).

AC-7-2 [P]
Ubiquitous: symspec shall add an `exports` map (and, if published, resolve the `"private": true` decision intentionally) to `package.json` and enable `dts:true` with a `src/index.ts` library entry in the tsdown config.
Verification: unit test (package resolves the library entry; `.d.ts` emitted)
Rationale/cite: importable API packaging (explore-surface.md §3, §5).
Dependencies note: overlaps AC-8-* which also edit package.json — see AC-8-1.

AC-7-3
Dependencies: AC-8-1
Ubiquitous: symspec shall rewrite `README.md` to describe the v2 CLI-native, formal-methods architecture, removing all "three-tier solver", "Opus 4.7 arbiter", MCP quick-start, Bedrock env-var, and `bin/symspec-mcp.mjs` content.
Verification: manual (README contains no MCP/Bedrock/LLM-tier references; describes parse/lint/check/certify)
Rationale/cite: README is "the single biggest stale surface … ~60% of its deep dive describes deleted machinery" (explore-docs.md §3; explore-surface.md §2).

AC-7-4
Dependencies: AC-8-1
Ubiquitous: symspec shall replace the MCP-shaped `integration/` directory with generated agent guidance, preserving the surviving content assets — the finding-resolution priority order and the "both pre+trigger → event-driven" guidance — in the new docs.
Verification: manual (integration/ removed or repurposed; priority order preserved in AGENTS.md)
Rationale/cite: delete integration/, preserve SKILL.md content assets (explore-docs.md §3; explore-surface.md §2).

AC-7-5
Dependencies: AC-7-1
Ubiquitous: symspec shall keep the manifest, generated AGENTS.md, and `--json` schema output flowing from the single atomic-field `.describe()` corpus, so a description edited once propagates to all agent-facing surfaces.
Verification: unit test (editing a field `.describe()` changes manifest and generated docs)
Rationale/cite: ".describe() text is a live API surface, not comments" single-source coupling (explore-docs.md §4 item 1; explore-core.md §3; orchestrator decision 7).

AC-7-6 [P]
Ubiquitous: symspec shall add the Z3 solver dependency to the toolchain config without breaking the pnpm-11 install flow — keeping `lefthook install` out of `prepare`, listing native/wasm builders in `pnpm.onlyBuiltDependencies`, and adding the optional Z3/cvc5/elan tool pins to `mise.toml`. NOTE: the optional Z3/cvc5/elan `mise.toml` pins are the OPTIONAL SYSTEM binaries (AC-4-9), a different thing from the npm runtime `dependencies` added in AC-7-7.
Verification: smoke (`pnpm install` then `pnpm exec` succeeds; mise pins resolve)
Rationale/cite: pnpm-11/prepare lesson; mise tool pins for solvers (explore-docs.md §2 rule 1; explore-surface.md §4; act-phase conventions).

AC-7-7 [P]
Ubiquitous: symspec shall add the product's NEW runtime npm dependencies to `package.json` `"dependencies"` via `pnpm add z3-solver wink-nlp wink-eng-lite-web-model`, and shall list z3-solver's wasm/native build script in `pnpm.onlyBuiltDependencies`, so the SMT tier (AC-4-1) and the Tier-2 parser (AC-2-6) resolve on a fresh install and knip reports no `unlisted` import.
Verification: smoke (knip reports no `unlisted` import for z3-solver/wink-nlp/wink-eng-lite-web-model; a fresh `pnpm install` resolves them; `symspec check` runs the SMT tier)
Rationale/cite: buildability critique (blocker) — no AC added the new runtime deps though AC-4-1 mandates `z3-solver` and AC-2-6 lazily imports `wink-nlp`; the deletion story (AC-8-*) was enumerated but the symmetric addition story was missing, guaranteeing a knip `unlisted` blocker under AC-8-7 (research-smt.md §3.1; research-nlparse.md §2; orchestrator decision 2).

---

## User Story 8 — Migration and deletion of v1 (MCP, LLM, Automerge)

*As a maintainer, I need every MCP, Bedrock/LLM, and Automerge artifact removed cleanly so the v2 surface has no dead code, no unused dependencies, and no stale integration story.*

### Acceptance Criteria

AC-8-1 [P]
Ubiquitous: symspec shall delete the entire MCP surface — `src/mcp/server.ts`, `bin/symspec-mcp.mjs`, the `symspec-mcp` bin entry, the `mcp` script, the `@modelcontextprotocol/sdk` dependency and its tsdown bundle rule, and the `integration/` MCP artifacts.
Verification: smoke (knip reports no MCP references; build has no `mcp` entry)
Rationale/cite: delete MCP entirely (explore-surface.md §2; explore-solvers.md §4; orchestrator decision 8).

AC-8-2 [P]
Ubiquitous: symspec shall delete all Bedrock/LLM solver code — the ~894-line `src/solvers/llm/` directory, the `@aws-sdk/client-bedrock-runtime` dependency and its tsdown externals, `scripts/smoke-solvers.ts`, and all `BEDROCK_*` env-var plumbing.
Verification: smoke (knip flags no `@aws-sdk/*`; grep finds no `BEDROCK_` usage)
Rationale/cite: delete all LLM/Bedrock code (explore-solvers.md §4; orchestrator decision 8).

AC-8-3
Dependencies: AC-8-2
Ubiquitous: symspec shall reshape `src/solvers/index.ts` and `src/solvers/types.ts` to keep the free tier and route candidate pairs to the formal backend, removing `CallModel`/`CallArbiter`/`EnsembleConfig` types, the `llm.*` `SolverSource` members, and the `llmPairsRun` field (renamed to a formal-pair counter).
Verification: unit test (orchestrator runs free tier + formal tier; no LLM types remain)
Rationale/cite: reshape orchestrator/types, drop LLM shapes, keep free tier (explore-solvers.md §1.4, §3; orchestrator decision 8).

AC-8-4 [P]
Dependencies note: coupled with AC-1-10 (migrate) — schedule together.
Ubiquitous: symspec shall remove Automerge from the DEFAULT/storage path — deleting `merge()`, removing Automerge from `doc.ts` (rewritten against plain objects), and preserving UUID identity, Change records, and the permissive-write/strict-analyze split. The `@automerge/automerge` dependency SURVIVES in `package.json` `"dependencies"` SOLELY for the migrate-only lazy `await import('@automerge/automerge')` (AC-1-10); it must be reachable from no module other than the migrate command. A wave planner MUST schedule this AC together with AC-1-10, never stripping the dependency migrate still needs.
Verification: smoke (default path — `doc.ts` and the SMT/lint tiers — imports no Automerge; ONLY the migrate command imports it lazily; `@automerge/automerge` remains a listed dependency; knip does not flag it as unused given the migrate carve-out AC-8-7)
Rationale/cite: drop Automerge CRDT from the storage path, keep the good ideas (explore-core.md §2; orchestrator decisions 1, 8); buildability critique (blocker) — resolves the AC-1-10↔AC-8-4 contradiction by keeping Automerge as an isolated migrate-only lazy import rather than a blanket deletion that would make AC-1-10 unsatisfiable.

AC-8-5
Dependencies: AC-8-4
Ubiquitous: symspec shall edit the `.describe()` corpus to remove every CRDT/Automerge/replica reference and rename `analysis_run` mentions to the v2 `symspec check` command.
Verification: unit test (grep the schema describes for "CRDT"/"Automerge"/"analysis_run" → none)
Rationale/cite: enumerated describe edits (explore-core.md §3 "Describes needing text edits").

AC-8-6
Dependencies: AC-8-1, AC-8-2, AC-8-3, AC-8-4
Ubiquitous: symspec shall rewrite the package `description` to state the v2 CLI-native formal-methods purpose, removing "CLI + MCP" and "three-tier solver … Bedrock ensemble + Opus 4.7 arbiter" language.
Verification: unit test (assert package.json `description` matches a v2 pattern — mentions "formal"/"EARS"/"CLI" — and contains NONE of the tokens: MCP, Bedrock, Opus, Automerge, "three-tier", "arbiter", "ensemble")
Rationale/cite: description mentions dead machinery (explore-surface.md §2; explore-solvers.md §4); buildability critique (minor) — converted from manual to unit test so scope-claim regressions are caught by CI (mirrors AC-8-5).

AC-8-7
Dependencies: AC-8-6, AC-7-7
Unwanted behavior: If the full quality gate (`biome ci && tsc --noEmit && vitest run && knip`) is run after deletions AND additions, then it shall pass with zero unused-dependency or unlisted-import findings, treating any failure as a blocker. The knip config MUST carve out `@automerge/automerge` so its migrate-only lazy import (AC-1-10, AC-8-4) is NOT flagged unused, and MUST recognize `z3-solver`, `wink-nlp`, and `wink-eng-lite-web-model` as listed (AC-7-7) so they are not flagged unlisted.
Verification: smoke (CI gate green post-deletion and post-addition; knip flags neither the surviving Automerge dep nor the new z3-solver/wink deps)
Rationale/cite: knip "will immediately flag `@modelcontextprotocol/sdk` and `@aws-sdk/*` after deletion, a nice validation signal" (explore-surface.md §3); buildability critique — knip carve-out for the surviving Automerge migrate dep and recognition of the new runtime deps; every gate failure is a blocker (global instructions).

AC-8-8 [P]
Ubiquitous: symspec shall delete stale build artifacts — the root `symspec-0.1.0.tgz` and any `dist/mcp.mjs` — relying on `clean:true` for regeneration.
Verification: smoke (no stale tarball or mcp artifact after build)
Rationale/cite: stale artifacts to delete (explore-surface.md §2).

---

## Non-goals (v2)

Explicitly out of scope for v2, to bound the build (orchestrator scope directive; packet rationale cited):

- **No MCP server or MCP tools.** Deleted entirely; agent integration is via the CLI + generated AGENTS.md (explore-surface.md §2; orchestrator decision 8).
- **No LLM calls in the product.** No Bedrock, no ensemble, no arbiter; the calling agent *is* the neural tier (explore-solvers.md §2.3, §4; research-nlparse.md §3; orchestrator decision 8).
- **No Python sidecar.** The NL ladder is TS-only (Tier-1 regex, Tier-2 wink-nlp, Tier-3 agent punt); spaCy is rejected (research-nlparse.md §3; orchestrator decision 5).
- **No temporal logic (LTL) / ordering conflicts.** The SMT tier evaluates one implicit snapshot; "shall X then Y within 5s" ordering is not checked and the finding taxonomy contains no temporal kinds (research-smt.md §4.3; research-lean4.md §2.2 cost 5).
- **No contextual-ambiguity checking.** Punted to the calling agent, documented as not-checked in the manifest (explore-solvers.md §2.2; research-smt.md §4.3).
- **No spec-compliant SysML wire format.** SysML export stays "flavored, not spec-compliant" as accepted debt (explore-docs.md §1.3 tech-debt #9).
- **No numeric/arithmetic (QF_LIA) atoms in v1 of v2.** Propositional (QF_UF-ish Bool) encoding only; typed numeric atoms are a designed-for extension, not shipped (research-smt.md §1.6, §4.3) — flagged as the first post-v2 upgrade.
- **No persistent solver process / `watch` mode, no lean-smt proof replay.** Batched one-shot invocations only (research-lean4.md §1.2, §3; research-smt.md §2.1).

---

## Appendix A — ERR_* code table (normative)

Stable, append-only. Every code pairs with a `suggestions` array in the `{ error, code, suggestions }` envelope (AC-6-2, AC-6-3). Codes must never be renumbered or removed.

| Code | Trigger | Suggestion content | Cite |
|---|---|---|---|
| `ERR_USAGE` | Invalid/missing CLI arguments | Correct usage string for the command | explore-surface.md §1 |
| `ERR_DOC_NOT_FOUND` | Document path does not resolve | Run `symspec init <file>`; check `SYMSPEC_DOC` | explore-surface.md §1 |
| `ERR_DOC_PARSE` | JSON invalid or fails `RequirementsDocSchema` | Point at offending path; re-create with `symspec init` then `symspec parse`/`add` | AC-1-4 |
| `ERR_SCHEMA_VERSION` | `schemaVersion` != current `SCHEMA_VERSION` | Re-create with `symspec init` then re-add requirements | explore-docs.md §1.3; AC-1-9 |
| `ERR_IO` | Atomic write to document failed | Check permissions/disk; original left intact | AC-1-11 |
| `ERR_DUPLICATE_ID` | `CreateRequirement` with existing UUID | Use `symspec update` | explore-docs.md §4.7; AC-1-8 |
| `ERR_NOT_FOUND` | Requirement id not present (show/update/delete-target where an id is required) | List ids with `symspec list` | explore-surface.md §1; AC-6-10 |
| `ERR_INVALID_RELATION` | Edge relation not in `RELATIONS` | Valid relations: derives/satisfies/verifies/refines | explore-surface.md §1; AC-6-10 |
| `ERR_INVALID_ATTR` | Update attr not in `UPDATABLE_ATTRS` | List updatable attrs | explore-core.md §3; AC-6-10 |
| `ERR_NULL_REQUIRED` | Null/`--clear` applied to a required (non-nullable) attr | Provide a value; only preCondition/trigger/verificationMethod are clearable | explore-core.md §3; AC-1-6 |
| `ERR_PARSE_NO_MODAL` | No `shall`/modal main clause found | Prepend "the &lt;system&gt; shall …"; provide mechanical rewrite | research-nlparse.md §5; AC-2-7 |
| `ERR_PARSE_AMBIGUOUS_CLAUSES` | Clause boundaries unresolved after Tier 2 | Show recovered partial slots; suggest reordering to EARS clause order | research-nlparse.md §5; AC-2-7 |
| `ERR_PARSE_COMPOUND` | Compound requirement (top-level and/or) | Split at "and"/"or" into separate requirements | research-nlparse.md §5, §6; AC-2-7 |
| `ERR_PARSE_NOT_A_REQUIREMENT` | Prose with no obligation (e.g. "Fast response times are important") | Not a requirement; rewrite as `&lt;system&gt; shall …` or skip | research-nlparse.md §1.7, §5; AC-2-7 |
| `ERR_SOLVER_MISSING` | Binary backend requested, none found by `--solver-path → SYMSPEC_Z3 → PATH` | Exact `mise use github:Z3Prover/z3@z3-4.16.0` | explore-surface.md §4; AC-4-10 |
| `ERR_SOLVER_TIMEOUT` | Overall run budget (`--solver-budget-ms`) exceeded — whole-run failure only, NOT a single group | Raise `--solver-budget-ms` | research-smt.md §2.3; AC-4-7 |
| `ERR_SOLVER_INCONCLUSIVE` | Whole-run solver-init failure / solver unusable — NOT a per-group `unknown` | Raise timeout; per-group `unknown` is FND_NEEDS_REVIEW, never "no conflict" | research-smt.md §2.3; AC-4-7 |
| `ERR_LEAN_TOOLCHAIN_MISSING` | `certify` requested, no Lean toolchain discoverable | `elan default stable` | research-lean4.md §1.3, §4; AC-5-4 |

Note (boundary, per AC-4-7): `ERR_SOLVER_TIMEOUT`/`ERR_SOLVER_INCONCLUSIVE` are reserved STRICTLY for whole-run/solver-init failures that abort the run (overall `--solver-budget-ms` exhausted, WASM init failure). A PER-GROUP timeout or `unknown` ALWAYS emits `FND_NEEDS_REVIEW` (Appendix B) and the run CONTINUES — it never produces an ERR_SOLVER_* envelope. This resolves the prior conflict where the ERR_SOLVER_TIMEOUT row's "per-group" wording contradicted AC-4-7. Binary-backend absence unifies under `ERR_SOLVER_MISSING` (the research-smt.md `ERR_SOLVER_BACKEND_MISSING` name is folded into it to avoid two codes for one condition).

---

## Appendix B — Finding-code enum (normative)

The closed enum the calling agent switches on. Each finding carries `{ code, severity, requirementIds | span, message, suggestion?, evidence? }`. Severity ∈ `error | warn | info`. Grouped by tier; codes are append-only.

### Tier 0 — structural (AC-3-5, AC-3-6)
| Code | Severity | Meaning |
|---|---|---|
| `FND_DANGLING_REFERENCE` | error | Edge targets a nonexistent UUID |
| `FND_MISSING_TRIGGER` | error | event-driven/unwanted-behavior with no trigger |
| `FND_MISSING_PRECONDITION` | error | state-driven/optional-feature with no preCondition |
| `FND_CYCLE` | error | Cycle in `derives`/`refines` (canonical-rotation deduped) |
| `FND_ORPHAN` | warn | Requirement with zero inbound/outbound edges (doc size > 1) |

### Lint — free tier + GtWR (AC-3-1, AC-3-2, AC-3-3)
| Code | Severity | Meaning / cite |
|---|---|---|
| `FND_EXACT_DUPLICATE` | error | Identical slot-tuple hash (explore-solvers.md §1.1) |
| `GTWR_R1_PATTERN` | error | Statement does not match any EARS pattern (research-ears-incose.md R1) |
| `GTWR_R2_PASSIVE` | warn | `shall be <participle>` passive voice |
| `GTWR_R5_INDEFINITE_ARTICLE` | warn | Indefinite "a/an" where "the" expected |
| `GTWR_R6_MISSING_UNITS` | error | Bare number with no unit |
| `GTWR_R7_VAGUE` | error | Vague term (weasel lexicon; subsumes v1 `Ambiguity`) |
| `GTWR_R8_ESCAPE` | error | Escape clause ("where possible", "if necessary") |
| `GTWR_R9_OPEN_ENDED` | error | Open-ended ("including but not limited to", "etc.") |
| `GTWR_R10_SUPERFLUOUS_INFINITIVE` | warn | "be able to"/"be capable of" |
| `GTWR_R15_LOGICAL_EXPR` | warn | Undefined logical-expression convention |
| `GTWR_R16_NEGATION` | warn | Use of "not"/"never" outside a defined logical expression |
| `GTWR_R17_OBLIQUE` | warn | "/" outside units/fractions (e.g. "and/or") |
| `GTWR_R18_MULTIPLE_SHALL` | error | More than one `shall` (multiple thoughts) |
| `GTWR_R19_COMBINATOR` | warn | Clause combinator in the response slot |
| `GTWR_R20_PURPOSE` | warn | Purpose phrase ("in order to", "so that") |
| `GTWR_R21_PARENTHESES` | warn | Parenthetical subordinate text |
| `GTWR_R24_PRONOUN` | warn | Personal/indefinite pronoun |
| `GTWR_R26_ABSOLUTE` | warn | Unachievable absolute ("100%", "always", "never") |
| `GTWR_R32_UNIVERSAL` | warn | "all/any/both" where "each" is intended |
| `GTWR_R33_MISSING_TOLERANCE` | warn | Quantity with no range/tolerance |
| `GTWR_R34_IMMEASURABLE` | warn | Immeasurable performance term ("fast", "robust") |
| `GTWR_R35_TEMPORAL` | warn | Indefinite temporal keyword ("eventually", "until") |
| `GTWR_R37_ACRONYM` | warn | Undefined/inconsistent acronym |
| `GTWR_R38_ABBREVIATION` | warn | Non-unit abbreviation |
| `GTWR_R40_DECIMAL_FORMAT` | info | Inconsistent decimal precision across the set |

(The ~24 GtWR codes above match the T1 checkability rollup; codes not listed here — e.g. R3, R22, R23, R28, R30-semantic, R31 — are the T3 "human/formal" rules documented as not surface-checkable in research-ears-incose.md §2 rollup and §4 "Never automatable".)

### Formal tier — SMT (AC-4-4, AC-4-5, AC-4-7, AC-4-12)
| Code | Severity | Meaning / cite |
|---|---|---|
| `FND_CONTRADICTION` | error | Context group unsat; ids from filtered MINIMAL unsat core; requires same-atom opposite-polarity responses (research-smt.md §1.3; AC-4-4) |
| `FND_SUBSUMPTION` | warn | Directional implication valid; `moreGeneral` = superset-of-cases side per AC-4-5 (research-smt.md §1.4) |
| `FND_REDUNDANCY` | warn | Bi-implication valid (logical duplicate) (research-smt.md §1.4) |
| `FND_VACUITY` | warn | Guard unreachable given all OTHER requirement formulas (relational, not lone-unsat-guard); labeled lower confidence (research-smt.md §1.5; AC-4-5) |
| `FND_SIMILAR_UNUNIFIED` | info | Responses Jaccard≥0.7 but did not unify — over-unification-adjacent review prompt; suggests `symspec atoms merge` (research-smt.md §4.3; AC-4-12) |
| `FND_NEEDS_REVIEW` | info | Per-group solver `unknown`/timeout/unencodable — not a "no conflict" (explore-solvers.md §3; research-smt.md §2.3; AC-4-7) |

### Completeness heuristic — lint-tier (AC-4-5a)
| Code | Severity | Meaning / cite |
|---|---|---|
| `FND_INCOMPLETE` | info | Heuristic guard-coverage gap: `¬(C1∨…∨Cn)` SAT over a same-trigger-family group yields an uncovered case. NOT a formal completeness guarantee; only bites when preconditions normalize to complementary atoms (research-smt.md §1.5; AC-4-5a) |

### Certify tier — Lean (AC-5-2, AC-5-3)
| Code | Severity | Meaning / cite |
|---|---|---|
| `FND_CERTIFIED` | info | Kernel-checked; carries `#print axioms` provenance (research-lean4.md §2.1) |
| `FND_CERTIFY_FAILED` | error | Lean produced a `severity:"error"` diagnostic (research-lean4.md §1.1) |

Kiro-taxonomy alignment (research-kiro.md §2, §4): symspec's four defect classes map as detail→lint (GTWR_R*), ambiguity→punted (documented not-checked), inconsistency→`FND_CONTRADICTION`, incompleteness→`FND_INCOMPLETE` (produced by AC-4-5a's heuristic, framed as a lint-tier heuristic, not a formal completeness proof). Adopting a closed enum the agent can switch on is the Kiro "five finding types" pattern (research-kiro.md §4 steal-item 1).

---

## Author's note — dependency graph and parallelism summary

- **US1 (storage/schema)** is the foundation. AC-1-1..1-5 are `[P]` roots; the rest chain off `applyChange` (AC-1-5) or the schema (AC-1-4).
- **US2 (parse)** roots at AC-2-1 (`[P]`), a self-contained module (`src/parse/`), so it parallelizes with US1.
- **US3 (lint)** free/structural roots (AC-3-1, AC-3-5) are `[P]`; GtWR and the pipeline-exclusion gate chain off them.
- **US4 (formal)** roots at AC-4-1 (`[P]`, backend init); the atom table (AC-4-2a) is the load-bearing contract every finding depends on and consumes AC-2-4's `negated`; findings depend on the encoder (AC-4-2). Contradiction/vacuity run per-context-group whole-spec (AC-4-3/4-4); subsumption/redundancy run over pairwise candidates (AC-3-4→AC-4-5); completeness heuristic is AC-4-5a; over-unification review is AC-4-12. Wiring into `check` is AC-6-8.
- **US5 (certify)** roots at AC-5-1 (`[P]`), gated behind detection and never blocking (AC-5-5).
- **US6 (CLI)** is the integration layer — AC-6-8 is the load-bearing "wire ALL tiers" criterion and now depends on the tier outputs it wires (AC-3-2/3-5/3-7/4-6), not merely AC-6-2. Default output is JSON with `--pretty` opt-in (AC-6-2a); exit-code contract is AC-6-2b; `apiVersion`/`type`/`backends` are AC-6-12/6-13/6-14.
- **US7/US8 (packaging/deletion)** share `package.json`/tsdown/config files; AC-8-1 is treated as the serialization point for package.json edits, so AC-7-3/7-4 and AC-8-6 depend on it rather than racing. AC-7-2 carries an explicit overlap note to AC-8-1. AC-7-7 ADDS the new runtime deps (z3-solver, wink-nlp, wink-eng-lite-web-model), the symmetric partner to the AC-8-* deletions. AC-8-4 (Automerge removal) is coupled to AC-1-10 (migrate keeps a migrate-only lazy Automerge import) and MUST be scheduled with it.

Cross-story dependency (AC-6-9 → AC-2-8, AC-3-2, AC-4-6, AC-5-2) is the one place the CLI inventory must wait on all tier outputs; it is annotated with an explicit multi-story `Dependencies:` line rather than `[P]`.

---

## Critique dispositions

Adversarial panel findings and their disposition in this revision. "Applied" = suggested fix (or a stronger variant) encoded; "Deferred" = logged, not fixed this pass; "Rejected" = not applied, with rationale.

| # | Lens / severity | AC(s) | Disposition | Note |
|---|---|---|---|---|
| 1 | soundness / blocker | AC-4-2 | **Applied** | New **AC-4-2a** specifies `atomize` as a pure function: normalization pipeline, per-`systemName` scoping, negation-on-same-atom via AC-2-4, and a 15-pair seed antonym table. Made the tested contract AC-4-4/4-5 build on. |
| 2 | soundness / blocker | AC-4-5 | **Applied** | AC-4-5 vacuity rewritten to the relational whole-spec unsat check (assert all-other-formulas + this guard); lone-unsat-guard clause removed; confidence labeled. |
| 3 | soundness / blocker | AC-4-5 | **Applied** | AC-4-5 pins `moreGeneral` = formula-implies side = superset-of-cases (`guard_specific⇒guard_general`); both directions checked (both→redundancy); fixture pins field assignment. |
| 4 | soundness / major | AC-4-3, AC-4-4 | **Applied** | AC-4-3 now mandates ALL requirement formulas in each group's conjunction; ubiquitous-vs-guarded fixture added. |
| 5 | soundness / major | AC-4-4 | **Applied** | AC-4-4 requires MINIMAL unsat core (`:smt.core.minimize`/`--minimal-unsat-cores`), z3-only option kept out of portable `.smt2` (AC-4-8); "exactly two IDs" test made robust via innocent-req fixture. |
| 6 | soundness / major | AC-4-11, AC-4-2 | **Applied** | AC-4-11 qualified "sound modulo atomization GIVEN conservative normalization"; new **FND_SIMILAR_UNUNIFIED** (AC-4-12) + Appendix B row. |
| 7 | soundness / major | AC-4-7 | **Applied** | AC-4-7 + Appendix A: per-group timeout ALWAYS → FND_NEEDS_REVIEW (run continues); ERR_SOLVER_TIMEOUT/INCONCLUSIVE reserved for whole-run; ERR_SOLVER_TIMEOUT trigger text fixed to "overall run budget". |
| 8 | soundness / major | AC-4-4, AC-4-5 | **Applied** | New **AC-4-5a** generates FND_INCOMPLETE via `¬(C1∨…∨Cn)` SAT heuristic; Appendix B moves it to a lint-tier "heuristic" section with honest framing. |
| 9 | soundness / minor | AC-4-4, AC-4-2 | **Applied** | AC-4-4 documents same-atom-opposite-polarity precondition; distinct-atom "conflict"→nothing fixture added; folded into the AC-4-2a antonym-table contract. |
| 10 | agent-ux / blocker | AC-6-2, AC-2-8, AC-6-4, AC-6-8 | **Applied** | New **AC-6-2a**: JSON envelope is the zero-flag default; `--pretty`/`--human` opt-in; `--json` redefined as a no-op compat alias. |
| 11 | agent-ux / blocker | AC-6-8, AC-3-3, AC-3-7 | **Applied** | New **AC-6-2b** exit-code contract: 0 clean / 1 findings-failure (envelope still on stdout) / 2 ERR_* operational; flags never change exit code. |
| 12 | agent-ux / major | AC-6-2, AC-2-7 | **Applied** | AC-6-2 error envelope is now `{apiVersion,type:'error',error,code,suggestions,partial?}`; AC-2-7 Tier-3 is an instance; both in Zod snapshot. |
| 13 | agent-ux / major | AC-6-4 | **Applied** | AC-6-4 `--dense` pinned: minified JSON + omit default/null keys + elide evidence unless `--evidence`; field names/schema unchanged; round-trip test. |
| 14 | agent-ux / major | AC-6-1, AC-6-3, AC-3-2, AC-7-5 | **Applied** | AC-6-3 defines ERR_*/FND_*/GTWR_* as three exported Zod enums with `.describe()`; manifest derives from them; append-only snapshot guard extended to all three. |
| 15 | agent-ux / major | AC-4-5, AC-4-4, AC-4-7 | **Applied** | Same as #8 — FND_INCOMPLETE now has producer AC-4-5a; no longer orphaned in the closed enum. |
| 16 | agent-ux / major | AC-1-4, AC-6-6, AC-6-10 | **Applied** | AC-1-4 now "shall reject … with ERR_DOC_PARSE"; AC-6-6 now "if no document resolves, shall return ERR_DOC_NOT_FOUND"; both trace to Appendix A. |
| 17 | agent-ux / major | AC-2-1, AC-2-8 | **Applied** | New **AC-2-9** batch parse (`--file`/`--stdin` → `results[]` + summary); `skipped` outcome enumerated in AC-2-8 ParseResult. |
| 18 | agent-ux / major | AC-2-8, AC-6-9, AC-1-8 | **Applied** | New **AC-2-10**: `add` auto-mints UUID (returned in `data.id`) unless `--id`; `--from-parse` prose path; library stays caller-owned-UUID; ERR_DUPLICATE_ID trigger well-defined. |
| 19 | agent-ux / minor | AC-6-1, AC-6-2, AC-6-7 | **Applied** | New **AC-6-12**: `apiVersion` is a distinct envelope-contract integer, independent of package version and doc schemaVersion. |
| 20 | agent-ux / minor | AC-6-2, AC-6-9, AC-2-8 | **Applied** | New **AC-6-13**: closed append-only envelope `type` enum, manifest-derived, snapshot-guarded. |
| 21 | agent-ux / minor | AC-4-1, AC-4-9, AC-5-4, AC-6-1 | **Applied** | New **AC-6-14**: manifest reports `backends` availability/paths/versions (z3-wasm, z3/cvc5 binaries, Lean) for query-then-decide. |
| 22 | buildability / blocker | AC-1-10, AC-8-4, AC-8-7 | **Applied** (fix option b) | Kept Automerge as a migrate-only lazy import (AC-1-10, AC-8-4), added explicit AC-1-10↔AC-8-4 coupling + knip carve-out (AC-8-7). Rejected option (a) drop-migrate: migrate is the documented upgrade path for existing v1 docs and the cost is ~20 LOC. |
| 23 | buildability / blocker | AC-4-1, AC-2-6, AC-7-6, AC-8-7 | **Applied** | New **AC-7-7**: `pnpm add z3-solver wink-nlp wink-eng-lite-web-model`; z3-solver build script in `onlyBuiltDependencies`; AC-8-7 knip recognizes them. |
| 24 | buildability / major | AC-1-9, AC-1-4, AC-1-10 | **Applied** | AC-1-9 mandates `SCHEMA_VERSION = 2`, restates trigger as valid-JSON-v2-shaped-stale-version; legacy binary routes to ERR_DOC_PARSE (AC-1-4); paths disjoint. |
| 25 | buildability / major | AC-3-4, AC-4-3, AC-4-4, AC-4-5 | **Applied** | AC-3-4 reworded: pairwise filter generates candidates for subsumption/redundancy ONLY; contradiction/vacuity use whole-spec context-groups independent of it. |
| 26 | buildability / major | AC-6-8, AC-3-2, AC-3-7, AC-4-6, AC-3-5 | **Applied** | AC-6-8 Dependencies now include AC-3-2, AC-3-5, AC-3-7, AC-4-6; smoke asserts all-tier findings AND formal-tier exclusion of an error-severity statement. |
| 27 | buildability / minor | AC-4-11, AC-6-9, AC-7-3, AC-7-4, AC-8-6 | **Applied** (partial) | AC-4-11 and AC-8-6 converted to unit-test verification. AC-6-9/7-3/7-4 kept manual — **Deferred**: they port MCP-description prose and rewrite README/integration content, which genuinely need human judgment (the panel itself scoped these to "prose-porting portions"). |
