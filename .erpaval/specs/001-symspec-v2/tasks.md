# Task graph — derived from spec.md (symspec v2)

**Do not hand-edit this file.** Regenerated from `spec.md` whenever the spec is revised.

Tasks are `T-AC-<story>-<ac>`. Each lists: ACs covered, files owned (exclusive within a wave — no two wave-mates touch the same file), model tier, and test expectations. Waves are dependency-ordered; every task in a wave is parallel-safe against its wave-mates.

**Model tier legend:** `haiku` = mechanical/port/config; `sonnet` = normal implementation; `opus` = subtle formal-methods / cross-cutting design.

**Global success-criteria baseline (every wave):** `pnpm biome ci` clean · `pnpm exec tsc --noEmit` clean · `pnpm vitest run` green · `knip` clean (`dependencies`/`unlisted` error). A non-zero exit on any gate is a blocker (global instructions).

---

## Wave 1 — v1 deletion + storage swap (foundation; heavy file churn, serialized against later package.json edits)

Wave 1 removes dead code and swaps storage. `package.json`/tsdown edits are partitioned so no two tasks in this wave write the same file. `T-AC-8-1` owns `package.json` deletions; `T-AC-8-2`/`T-AC-8-4` hand their dep-removal edits to `T-AC-8-1` via a shared checklist (they own only their own `src/` files here).

- **T-AC-8-1** `[P]` — Delete MCP surface — **ACs:** AC-8-1 · **Files:** `src/mcp/server.ts` (del), `bin/symspec-mcp.mjs` (del), `integration/` (del MCP artifacts), `package.json` (remove `symspec-mcp` bin, `mcp` script, `@modelcontextprotocol/sdk`), `tsdown.config.ts` (remove mcp bundle rule) · **Tier:** sonnet · **Tests:** knip reports no MCP references; build has no `mcp` entry.
- **T-AC-8-2** `[P]` — Delete Bedrock/LLM solver code — **ACs:** AC-8-2 · **Files:** `src/solvers/llm/` (del entire dir), `scripts/smoke-solvers.ts` (del) · **Tier:** haiku · **Tests:** grep finds no `BEDROCK_` usage; no `@aws-sdk/*` import remains in `src/`. (Dep removal from `package.json` deferred to Wave 1 merge — see note.)
- **T-AC-8-8** `[P]` — Delete stale build artifacts — **ACs:** AC-8-8 · **Files:** `symspec-0.1.0.tgz` (del), `dist/mcp.mjs` (del) · **Tier:** haiku · **Tests:** no stale tarball/mcp artifact after `clean:true` build.
- **T-AC-1-1** `[P]` — Pretty-printed sorted-key JSON persistence — **ACs:** AC-1-1 · **Files:** `src/core/storage.ts` (new; serialize/atomic-write) · **Tier:** sonnet · **Tests:** byte-stable sorted-key output; round-trip load==save.
- **T-AC-1-2** `[P]` — Document model `{schemaVersion, requirements: Record<uuid,Requirement>}` — **ACs:** AC-1-2 · **Files:** `src/core/schema.ts` (doc shape only; bump `SCHEMA_VERSION = 2`) · **Tier:** sonnet · **Tests:** schema shape; UUID key === `requirement.id`; `SCHEMA_VERSION === 2`.
- **T-AC-2-1** `[P]` — Tier-1 regex cascade classifier — **ACs:** AC-2-1 · **Files:** `src/parse/tier1.ts` (new), `src/parse/index.ts` (new) · **Tier:** opus · **Tests:** 16-case validation table from research-nlparse.md §1.7.
- **T-AC-3-1** `[P]` — Port free-tier heuristics (exact-dup hash, weasel lexicon) — **ACs:** AC-3-1 · **Files:** `src/solvers/free/duplicates.ts` (port), `src/solvers/free/ambiguity.ts` (port) · **Tier:** haiku · **Tests:** port `duplicates.test.ts`; exact-dup + weasel findings emitted.
- **T-AC-3-5** `[P]` — Tier-0 structural checks on plain-object snapshot — **ACs:** AC-3-5 · **Files:** `src/core/analyze.ts` (structural checks only, no Automerge) · **Tier:** sonnet · **Tests:** port `analyze.test.ts`; all five structural finding kinds.
- **T-AC-4-1** `[P]` — z3-solver WASM backend init in-process — **ACs:** AC-4-1 · **Files:** `src/formal/backend.ts` (new) · **Tier:** sonnet · **Tests:** smoke — fresh install → SMT tier runs with no PATH binary.
- **T-AC-5-1** `[P]` — Batched core-Lean file generator — **ACs:** AC-5-1 · **Files:** `src/certify/emit.ts` (new) · **Tier:** sonnet · **Tests:** smoke — generated file elaborates under bare `lean`, no lake.

**Wave 1 merge step (serialized, single owner):** apply the `package.json` `dependencies` removals surfaced by T-AC-8-2 (`@aws-sdk/client-bedrock-runtime`) and Wave 2's T-AC-8-4 (Automerge storage-path removal) together; keep `@automerge/automerge` LISTED for the migrate-only lazy import (AC-8-4/AC-1-10).

---

## Wave 2 — storage internals, parse ladder, lint rules, encoder + atom table

- **T-AC-1-3** — EARS domain model + pure `renderSentence` — **ACs:** AC-1-3 · **Files:** `src/core/schema.ts` (slots/renderer), `src/core/render.ts` (new) · **Blocks on:** T-AC-1-2 · **Tier:** sonnet · **Tests:** port `renderSentence` suite byte-for-byte incl. combined "While P, when T…".
- **T-AC-1-4** — Zod `RequirementsDocSchema` + load-time validate → ERR_DOC_PARSE — **ACs:** AC-1-4 · **Files:** `src/core/schema.ts` (schema), `src/core/load.ts` (new) · **Blocks on:** T-AC-1-2 · **Tier:** sonnet · **Tests:** valid parses; malformed JSON/schema-invalid/legacy-binary → ERR_DOC_PARSE (binary variant carries migrate suggestion).
- **T-AC-1-5** — Change discriminated union + `applyChange` over plain objects — **ACs:** AC-1-5 · **Files:** `src/core/doc.ts` (rewrite, no Automerge), `src/core/changes.ts` (new) · **Blocks on:** T-AC-1-2, T-AC-8-4-prep · **Tier:** opus · **Tests:** each Change kind mutates a plain-object doc; no Automerge proxy.
- **T-AC-8-4** — Remove Automerge from storage path (migrate-only lazy import survives) — **ACs:** AC-8-4 · **Files:** `src/core/doc.ts` (Automerge removal), `tsdown.config.ts` (drop `neverBundle`) · **Blocks on:** T-AC-1-1 · **Coupled with:** T-AC-1-10 (schedule together) · **Tier:** opus · **Tests:** default path imports no Automerge; only migrate command imports it lazily; dep stays listed.
- **T-AC-2-2** — Mandatory main-clause gate — **ACs:** AC-2-2 · **Files:** `src/parse/tier1.ts` · **Blocks on:** T-AC-2-1 · **Tier:** sonnet · **Tests:** "While in Rome…" does not misclassify as state-driven.
- **T-AC-2-3** — Event synonyms + modal normalization + provenance — **ACs:** AC-2-3 · **Files:** `src/parse/normalize.ts` (new) · **Blocks on:** T-AC-2-1 · **Tier:** sonnet · **Tests:** "Upon receipt of…" → event-driven; "must" flagged medium confidence.
- **T-AC-2-4** — Negation extraction (`negated:true`, positive atom) — **ACs:** AC-2-4 · **Files:** `src/parse/negation.ts` (new) · **Blocks on:** T-AC-2-2 · **Tier:** opus · **Tests:** "shall not store plaintext" → negated=true, positive atom. **(Load-bearing for AC-4-2a.)**
- **T-AC-2-5** — REQ-ID stripping + unicode/whitespace/punct preprocessing — **ACs:** AC-2-5 · **Files:** `src/parse/preprocess.ts` (new) · **Blocks on:** T-AC-2-1 · **Tier:** haiku · **Tests:** ID-prefixed + smart-quote inputs parse to correct slots.
- **T-AC-3-2** — ~24 INCOSE GtWR v4 rules (stable codes, severity, span, suggestion) — **ACs:** AC-3-2 · **Files:** `src/lint/gtwr.ts` (new), `src/lint/codes.ts` (new; GTWR_* Zod enum) · **Blocks on:** T-AC-3-1 · **Tier:** opus · **Tests:** one fixture per rule triggers its code with correct severity/span.
- **T-AC-3-6** — findCycles canonical-rotation dedupe fix — **ACs:** AC-3-6 · **Files:** `src/core/analyze.ts` (cycle dedupe) · **Blocks on:** T-AC-3-5 · **Tier:** sonnet · **Tests:** self-loop + same cycle from two entries each reported once.
- **T-AC-4-2** — Guarded-implication encoder (pure over ReqView) — **ACs:** AC-4-2 · **Files:** `src/formal/encode.ts` (new) · **Blocks on:** T-AC-4-1, T-AC-2-4 · **Tier:** opus · **Tests:** per-pattern formula shape; encoder pure.
- **T-AC-4-2a** — `atomize` pure fn: normalization + per-systemName scoping + negation-on-same-atom + seed antonym table — **ACs:** AC-4-2a · **Files:** `src/formal/atomize.ts` (new), `src/formal/antonyms.ts` (new; 15 seed pairs) · **Blocks on:** T-AC-4-1, T-AC-2-4 · **Tier:** opus · **Tests:** purity/determinism; article/punct/whitespace/underscore; per-system distinct atoms; not-X vs X same atom opposite polarity; grant/revoke unify; NO stemming. **(Load-bearing contract.)**
- **T-AC-5-2** — `lean --json` NDJSON parse + exit-code mapping — **ACs:** AC-5-2 · **Files:** `src/certify/run.ts` (new) · **Blocks on:** T-AC-5-1 · **Tier:** sonnet · **Tests:** fixture NDJSON parsed; exit-code mapping correct.

---

## Wave 3 — mutation semantics, error paths, formal checks, certify errors

- **T-AC-1-6** — null-clears-optional + five-way re-render gate — **ACs:** AC-1-6 · **Files:** `src/core/changes.ts` · **Blocks on:** T-AC-1-5 · **Tier:** sonnet · **Tests:** null clears optional; EARS-slot edit re-renders; metadata edit does not.
- **T-AC-1-7** — idempotent AddRelationship/Remove/Delete — **ACs:** AC-1-7 · **Files:** `src/core/changes.ts` (edge ops — **owns edge-op section; T-AC-1-6 owns attr section**, no overlap) · **Blocks on:** T-AC-1-5 · **Tier:** sonnet · **Tests:** port smoke-incremental idempotency scenarios.
- **T-AC-1-8** — ERR_DUPLICATE_ID on CreateRequirement collision — **ACs:** AC-1-8 · **Files:** `src/core/changes.ts` (create path) · **Blocks on:** T-AC-1-5 · **Tier:** haiku · **Tests:** duplicate id → ERR_DUPLICATE_ID envelope. *(Sequenced after T-AC-1-6/1-7 within same file — see Wave-3 note.)*
- **T-AC-1-11** — atomic write + ERR_IO — **ACs:** AC-1-11 · **Files:** `src/core/storage.ts` · **Blocks on:** T-AC-1-1, T-AC-1-5 · **Tier:** sonnet · **Tests:** simulated write failure leaves original intact.
- **T-AC-2-6** — Tier-2 wink-nlp lazy import on escalation — **ACs:** AC-2-6 · **Files:** `src/parse/tier2.ts` (new) · **Blocks on:** T-AC-2-1 · **Tier:** opus · **Tests:** escalation-class sentence invokes Tier 2; clean sentences never load wink-nlp.
- **T-AC-2-7** — Tier-3 error envelope (ERR_PARSE_* + partial + suggestions) — **ACs:** AC-2-7 · **Files:** `src/parse/tier3.ts` (new), `src/core/codes.ts` (ERR_* enum, shared — **see codes note**) · **Blocks on:** T-AC-2-6 · **Tier:** sonnet · **Tests:** compound/ambiguous → correct ERR_PARSE_* + partial + suggestions.
- **T-AC-3-3** — legitimate-exception rules at warn severity — **ACs:** AC-3-3 · **Files:** `src/lint/gtwr.ts` (severity table) · **Blocks on:** T-AC-3-2 · **Tier:** haiku · **Tests:** "disregard all signals when override ON" → warn not error.
- **T-AC-3-4** — pairwise candidate filter (subsumption/redundancy candidates ONLY) — **ACs:** AC-3-4 · **Files:** `src/solvers/free/pairwise-filter.ts` (repurpose) · **Blocks on:** T-AC-3-1 · **Tier:** sonnet · **Tests:** candidate pairs w/ correct `reason`; exact-dup excluded; contradiction fires on non-candidate pair.
- **T-AC-3-7** — pipeline-exclusion gate (error-severity → excluded from symbolize) — **ACs:** AC-3-7 · **Files:** `src/pipeline/gate.ts` (new) · **Blocks on:** T-AC-3-2 · **Tier:** sonnet · **Tests:** error-severity statement absent from atom table/solver input.
- **T-AC-4-3** — per-context-group whole-spec reachability check — **ACs:** AC-4-3 · **Files:** `src/formal/contradiction.ts` (new) · **Blocks on:** T-AC-4-2, T-AC-4-2a · **Tier:** opus · **Tests:** mutually-exclusive triggers no spurious conflict; ubiquitous ¬R + event T⇒R → conflict (whole-spec proof).
- **T-AC-4-5** — subsumption (pinned direction), redundancy, relational vacuity — **ACs:** AC-4-5 · **Files:** `src/formal/subsumption.ts` (new), `src/formal/vacuity.ts` (new) · **Blocks on:** T-AC-4-2, T-AC-4-2a, T-AC-3-4 · **Tier:** opus · **Tests:** moreGeneral/moreSpecific field assignment pinned; bi-implication→redundancy; relational vacuity; lone-unsat-guard NOT flagged.
- **T-AC-4-5a** — completeness heuristic → FND_INCOMPLETE (info) — **ACs:** AC-4-5a · **Files:** `src/formal/incomplete.ts` (new) · **Blocks on:** T-AC-4-2, T-AC-4-2a · **Tier:** sonnet · **Tests:** genuine else-branch gap → FND_INCOMPLETE; covered group → nothing.
- **T-AC-4-8** — `--emit-smt2` portable SMT-LIB2 artifact — **ACs:** AC-4-8 · **Files:** `src/formal/emit-smt2.ts` (new) · **Blocks on:** T-AC-4-2 · **Tier:** sonnet · **Tests:** emitted `.smt2` parses under standard reader; no z3-only prelude.
- **T-AC-5-3** — certify success: #print axioms provenance + retained artifact — **ACs:** AC-5-3 · **Files:** `src/certify/run.ts` (provenance) · **Blocks on:** T-AC-5-2 · **Tier:** sonnet · **Tests:** certify emits .lean + lean-toolchain; axioms captured.
- **T-AC-5-4** — ERR_LEAN_TOOLCHAIN_MISSING + elan suggestion, never blocks SMT — **ACs:** AC-5-4 · **Files:** `src/certify/discover.ts` (new) · **Blocks on:** T-AC-5-2 · **Tier:** haiku · **Tests:** no toolchain → ERR_LEAN_TOOLCHAIN_MISSING + elan suggestion.

**Wave-3 note (shared files):** `src/core/changes.ts` is touched by T-AC-1-6/1-7/1-8 — split by section (attr-update / edge-ops / create) with no line overlap; if a planner cannot guarantee section isolation, run T-AC-1-8 in a Wave-3b micro-wave after T-AC-1-6/1-7. `src/core/codes.ts` (ERR_* enum) is created in Wave 3 by whichever of T-AC-2-7 runs first; other code-emitting tasks import it (see Wave 4 T-AC-6-3 which finalizes the three enums).

---

## Wave 4 — findings assembly, unsat cores, over-unification, certify gating

- **T-AC-4-4** — minimal unsat core → FND_CONTRADICTION (exactly the REQ-* members) — **ACs:** AC-4-4 · **Files:** `src/formal/contradiction.ts` (core extraction) · **Blocks on:** T-AC-4-3 · **Tier:** opus · **Tests:** planted 2-way conflict (negation/antonym-shared) → exactly two IDs, no innocent third; distinct-atom conflict → nothing; minimization proven by innocent-req fixture.
- **T-AC-4-6** — `evidence` field (atom table + core/witness) on every formal finding — **ACs:** AC-4-6 · **Files:** `src/formal/finding.ts` (new) · **Blocks on:** T-AC-4-4, T-AC-4-5 · **Tier:** sonnet · **Tests:** finding includes atom table + core; serializable JSON.
- **T-AC-4-7** — per-group timeout/unknown → FND_NEEDS_REVIEW (run continues) — **ACs:** AC-4-7 · **Files:** `src/formal/needs-review.ts` (new) · **Blocks on:** T-AC-4-3 · **Tier:** sonnet · **Tests:** per-group timeout → FND_NEEDS_REVIEW, run completes; whole-run budget → ERR_SOLVER_TIMEOUT.
- **T-AC-4-12** — FND_SIMILAR_UNUNIFIED (info) from Jaccard pass — **ACs:** AC-4-12 · **Files:** `src/formal/similar.ts` (new) · **Blocks on:** T-AC-3-4, T-AC-4-2a · **Tier:** sonnet · **Tests:** near-synonym unmatched pair → FND_SIMILAR_UNUNIFIED; auto-unified → nothing.
- **T-AC-4-9** — optional binary backend cross-check (discovery order) — **ACs:** AC-4-9 · **Files:** `src/formal/binary-backend.ts` (new) · **Blocks on:** T-AC-4-8 · **Tier:** sonnet · **Tests:** smoke — with binary present, `--solver z3-bin` reproduces WASM verdict.
- **T-AC-4-10** — ERR_SOLVER_MISSING + mise suggestion — **ACs:** AC-4-10 · **Files:** `src/formal/binary-backend.ts` (discovery-miss path) · **Blocks on:** T-AC-4-9 · **Tier:** haiku · **Tests:** binary mode, no solver → ERR_SOLVER_MISSING + exact mise command. *(Sequenced after T-AC-4-9, same file.)*
- **T-AC-5-5** — check never invokes Lean / requires toolchain — **ACs:** AC-5-5 · **Files:** `src/pipeline/check.ts` (new; guard) · **Blocks on:** T-AC-5-4 · **Tier:** haiku · **Tests:** smoke — `check` with no Lean installed succeeds.

---

## Wave 5 — CLI surface: envelopes, manifest, codes, exit contract

- **T-AC-6-1** — `manifest` command derived from Zod + `.describe()` — **ACs:** AC-6-1 · **Files:** `src/cli/manifest.ts` (new) · **Blocks on:** T-AC-3-2, T-AC-4-6 · **Tier:** sonnet · **Tests:** manifest JSON validates; entries derive from `.describe()`.
- **T-AC-6-2** — success/error typed envelopes (`apiVersion,type,data` / `+error,code,suggestions,partial?`) — **ACs:** AC-6-2 · **Files:** `src/cli/envelope.ts` (new) · **Blocks on:** T-AC-6-1 · **Tier:** sonnet · **Tests:** both validate; both carry apiVersion+type; Tier-3 partial round-trips.
- **T-AC-6-5** — importable library + exports map + `dts:true`; CLI thin formatter — **ACs:** AC-6-5 · **Files:** `src/index.ts` (new), `tsdown.config.ts` (dts) · **Blocks on:** — (roots, but scheduled here to avoid package.json race w/ Wave 6) · **Tier:** sonnet · **Tests:** import library API in consumer; CLI calls same fns.
- **T-AC-6-9** — v2 command inventory + ported MCP descriptions — **ACs:** AC-6-9 · **Files:** `src/cli/index.ts` (command registration), `src/cli/descriptions.ts` (new) · **Blocks on:** T-AC-2-8, T-AC-3-2, T-AC-4-6, T-AC-5-2 · **Tier:** sonnet · **Tests:** manual — inventory present; MCP prose ported.

**Note:** `T-AC-2-8` (ParseResult incl. `skipped`) and `T-AC-2-9`/`T-AC-2-10` (batch parse, add/UUID) are placed in Wave 5 because they depend on the full parse ladder (Wave 2/3) and the envelope (T-AC-6-2). To avoid `src/parse/` vs `src/cli/` file races they own distinct files — listed below.

- **T-AC-2-8** — ParseResult discriminated union (ok/skipped/error) — **ACs:** AC-2-8 · **Files:** `src/parse/result.ts` (new) · **Blocks on:** T-AC-2-4, T-AC-6-2 · **Tier:** sonnet · **Tests:** each outcome validates; ok-slots accepted by create schema; no-modal bullet → skipped.
- **T-AC-2-9** — batch parse `--file`/`--stdin` → results[]+summary — **ACs:** AC-2-9 · **Files:** `src/parse/batch.ts` (new) · **Blocks on:** T-AC-2-8 · **Tier:** sonnet · **Tests:** 3-line file → results[3] ok/skipped/error + matching summary.
- **T-AC-2-10** — `add` auto-UUID / `--id` / `--from-parse` — **ACs:** AC-2-10 · **Files:** `src/cli/add.ts` (new) · **Blocks on:** T-AC-2-8, T-AC-1-8 · **Tier:** sonnet · **Tests:** add w/o `--id`→fresh UUID in data.id; `--id <dup>`→ERR_DUPLICATE_ID; `--from-parse` parses then creates.

---

## Wave 6 — envelope semantics, exit codes, wiring, path/attr commands

- **T-AC-6-2a** — JSON default output; `--pretty`/`--human` opt-in; `--json` no-op alias — **ACs:** AC-6-2a · **Files:** `src/cli/output.ts` (new) · **Blocks on:** T-AC-6-2 · **Tier:** sonnet · **Tests:** zero-flag `check`→valid envelope; `--json`==no-flag; `--pretty`→prose.
- **T-AC-6-2b** — exit-code contract (0/1 findings-failure/2 ERR_*) — **ACs:** AC-6-2b · **Files:** `src/cli/exit.ts` (new) · **Blocks on:** T-AC-6-2, T-AC-3-2 · **Tier:** sonnet · **Tests:** clean→0; error-finding→1 (envelope on stdout); missing doc→2; warn/info-only→0.
- **T-AC-6-3** — three exported Zod enums (ERR_*/FND_*/GTWR_*) + append-only snapshot guard; manifest derives tables — **ACs:** AC-6-3 · **Files:** `src/core/codes.ts` (consolidate ERR_*), `src/lint/codes.ts` (GTWR_*), `src/formal/codes.ts` (new; FND_*) · **Blocks on:** T-AC-6-2, T-AC-3-2, T-AC-4-6 · **Tier:** opus · **Tests:** each code reachable; snapshot guards all three; manifest table changes when `.describe()` mutated.
- **T-AC-6-4** — `--dense` (minify + omit defaults/null + elide evidence unless `--evidence`) — **ACs:** AC-6-4 · **Files:** `src/cli/dense.ts` (new) · **Blocks on:** T-AC-6-2 · **Tier:** sonnet · **Tests:** minified, omits default/null, elides evidence; validates same Zod schema; round-trips.
- **T-AC-6-6** — doc path resolution + ERR_DOC_NOT_FOUND — **ACs:** AC-6-6 · **Files:** `src/cli/resolve-doc.ts` (new) · **Blocks on:** T-AC-6-2 · **Tier:** sonnet · **Tests:** precedence positional→env→default; nonexistent→ERR_DOC_NOT_FOUND.
- **T-AC-6-7** — version from single source (package.json) — **ACs:** AC-6-7 · **Files:** `src/cli/version.ts` (new) · **Blocks on:** T-AC-6-5 · **Tier:** haiku · **Tests:** `--version`==manifest version==package.json version.
- **T-AC-6-10** — typed error envelopes for bad/missing args (ERR_USAGE/NOT_FOUND/INVALID_*) — **ACs:** AC-6-10 · **Files:** `src/cli/errors.ts` (new) · **Blocks on:** T-AC-6-2 · **Tier:** sonnet · **Tests:** bad relation→ERR_INVALID_RELATION; unknown id→ERR_NOT_FOUND; each an envelope.
- **T-AC-6-11** — `--clear` flag replaces `"null"` sentinel — **ACs:** AC-6-11 · **Files:** `src/cli/update.ts` (new) · **Blocks on:** T-AC-6-10 · **Tier:** haiku · **Tests:** `update --clear` clears optional; literal "null" stored as text.
- **T-AC-6-12** — `apiVersion` distinct envelope-contract integer — **ACs:** AC-6-12 · **Files:** `src/cli/envelope.ts` (apiVersion const) · **Blocks on:** T-AC-6-2 · **Tier:** haiku · **Tests:** integer; ==manifest apiVersion; not tied to pkg/schema versions. *(Sequenced after T-AC-6-2 finalization to avoid envelope.ts race with T-AC-6-2a — assign to same owner or Wave-6b.)*
- **T-AC-6-13** — closed append-only envelope `type` enum; manifest-derived — **ACs:** AC-6-13 · **Files:** `src/cli/types-enum.ts` (new) · **Blocks on:** T-AC-6-2, T-AC-6-9 · **Tier:** sonnet · **Tests:** every command type in enum; snapshot guards append-only.
- **T-AC-6-14** — manifest `backends` availability report — **ACs:** AC-6-14 · **Files:** `src/cli/backends.ts` (new) · **Blocks on:** T-AC-6-1, T-AC-4-1, T-AC-4-9, T-AC-5-4 · **Tier:** sonnet · **Tests:** z3-wasm available; binary/Lean available+path when present, available:false when absent.
- **T-AC-1-9** — ERR_SCHEMA_VERSION (v2-shaped stale version) — **ACs:** AC-1-9 · **Files:** `src/core/load.ts` (version check) · **Blocks on:** T-AC-1-4 · **Tier:** haiku · **Tests:** v2-shaped `schemaVersion:1`→ERR_SCHEMA_VERSION; legacy binary→ERR_DOC_PARSE (disjoint).
- **T-AC-1-10** — `migrate` via migrate-only lazy Automerge import — **ACs:** AC-1-10 · **Files:** `src/cli/migrate.ts` (new) · **Blocks on:** T-AC-1-9, T-AC-8-4 · **Coupled with:** T-AC-8-4 · **Tier:** sonnet · **Tests:** smoke — migrate v1 binary→v2 JSON loads clean at schemaVersion 2; default path imports no Automerge.

---

## Wave 7 — integration wiring, packaging, docs, gate

- **T-AC-6-8** — wire ALL tiers into `check` (one envelope; honors exclusion gate) — **ACs:** AC-6-8 · **Files:** `src/pipeline/check.ts` (orchestration) · **Blocks on:** T-AC-3-2, T-AC-3-5, T-AC-3-7, T-AC-4-6, T-AC-6-2 · **Tier:** opus · **Tests:** smoke — structural+lint+formal in one `data.findings[]`; error-severity statement absent from formal tier.
- **T-AC-8-3** — reshape `src/solvers/index.ts`/`types.ts` (drop LLM shapes, keep free+formal) — **ACs:** AC-8-3 · **Files:** `src/solvers/index.ts`, `src/solvers/types.ts` · **Blocks on:** T-AC-8-2, T-AC-4-6 · **Tier:** sonnet · **Tests:** orchestrator runs free+formal; no LLM types; `llmPairsRun`→formal-pair counter.
- **T-AC-8-5** — scrub `.describe()` corpus (CRDT/Automerge/analysis_run) — **ACs:** AC-8-5 · **Files:** `src/core/schema.ts` (describe text) · **Blocks on:** T-AC-8-4 · **Tier:** haiku · **Tests:** grep describes for CRDT/Automerge/analysis_run → none.
- **T-AC-7-2** — `exports` map + `dts:true` + `src/index.ts` entry — **ACs:** AC-7-2 · **Files:** `package.json` (exports), `tsdown.config.ts` (dts+entry) · **Blocks on:** T-AC-6-5, T-AC-8-1 · **Tier:** sonnet · **Tests:** package resolves library entry; `.d.ts` emitted.
- **T-AC-7-6** — toolchain config (no lefthook-in-prepare; onlyBuiltDependencies; mise pins) — **ACs:** AC-7-6 · **Files:** `mise.toml`, `package.json` (pnpm block — **coordinated with T-AC-7-7 via single owner**) · **Blocks on:** — · **Tier:** sonnet · **Tests:** smoke — `pnpm install` then `pnpm exec` succeeds; mise pins resolve.
- **T-AC-7-7** — add runtime deps (z3-solver, wink-nlp, wink-eng-lite-web-model) + onlyBuiltDependencies — **ACs:** AC-7-7 · **Files:** `package.json` (dependencies + pnpm block) · **Blocks on:** — · **Tier:** haiku · **Tests:** smoke — knip no `unlisted` for the three; fresh install resolves; SMT tier runs. *(Same-owner as T-AC-7-6 for the pnpm block; run sequentially or merge.)*

---

## Wave 8 — docs regeneration, description, final gate (all package.json/README settled)

- **T-AC-6-8-verify** folded into T-AC-6-8; no separate task.
- **T-AC-7-1** — generate `AGENTS.md` in CI from manifest/doc-comment corpus — **ACs:** AC-7-1 · **Files:** `scripts/gen-agents.ts` (new), CI config · **Blocks on:** T-AC-6-1 · **Tier:** sonnet · **Tests:** smoke — CI regenerates AGENTS.md; drift fails build.
- **T-AC-7-5** — single `.describe()` corpus drives manifest+AGENTS+`--json` — **ACs:** AC-7-5 · **Files:** `scripts/gen-agents.ts`, `src/cli/manifest.ts` · **Blocks on:** T-AC-7-1 · **Tier:** sonnet · **Tests:** editing a field `.describe()` changes manifest and generated docs.
- **T-AC-4-11** — manifest honest-scope text ("sound modulo atomization", "silence is not…", not-checked ambiguity) — **ACs:** AC-4-11 · **Files:** `src/cli/scope-text.ts` (new; imported by manifest + finding output) · **Blocks on:** T-AC-4-6, T-AC-6-1 · **Tier:** haiku · **Tests:** unit — manifest text contains the exact substrings and the contextual-ambiguity not-checked boundary (grep/snapshot, not manual).
- **T-AC-8-6** — rewrite package `description` (v2, no dead-machinery tokens) — **ACs:** AC-8-6 · **Files:** `package.json` (description) · **Blocks on:** T-AC-8-1, T-AC-8-2, T-AC-8-3, T-AC-8-4 · **Tier:** haiku · **Tests:** unit — description matches v2 pattern; none of MCP/Bedrock/Opus/Automerge/three-tier/arbiter/ensemble.
- **T-AC-7-3** — rewrite `README.md` (v2 architecture; strip MCP/Bedrock/LLM) — **ACs:** AC-7-3 · **Files:** `README.md` · **Blocks on:** T-AC-8-1 · **Tier:** sonnet · **Tests:** manual — no MCP/Bedrock/LLM-tier refs; describes parse/lint/check/certify.
- **T-AC-7-4** — replace `integration/` with generated guidance (preserve content assets) — **ACs:** AC-7-4 · **Files:** `integration/` (remove/repurpose), `AGENTS.md` (priority order) · **Blocks on:** T-AC-8-1, T-AC-7-1 · **Tier:** sonnet · **Tests:** manual — integration/ removed; priority order preserved in AGENTS.md.
- **T-AC-8-7** — full quality gate green (post-deletion + addition; knip carve-outs) — **ACs:** AC-8-7 · **Files:** `knip.json` (Automerge carve-out; recognize new deps) · **Blocks on:** T-AC-8-6, T-AC-7-7, and ALL prior tasks · **Tier:** sonnet · **Tests:** smoke — `biome ci && tsc --noEmit && vitest run && knip` green; neither surviving Automerge nor new deps flagged.

---

## Success criteria baseline

- `pnpm biome ci` clean
- `pnpm exec tsc --noEmit` clean on all files
- `pnpm vitest run` passes (every AC's stated verification implemented as a test)
- `knip` clean: zero `dependencies`/`unlisted` findings (with Automerge migrate carve-out and z3-solver/wink recognition)
- `symspec check` on a fixture spec returns structural + lint + formal findings in one envelope with the correct exit code

## Anti-goals

- No refactoring outside the files a task owns.
- No two tasks in the same wave write the same file (ownership stated per-task; where a file is shared across waves, the later wave's task waits).
- No temporal logic, no contextual-ambiguity checking, no LLM calls, no Python sidecar, no MCP (spec Non-goals).
- Do not strip `@automerge/automerge` — it survives as a migrate-only lazy import (AC-8-4/AC-1-10).
