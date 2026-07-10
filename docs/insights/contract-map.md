# symspec · Contract map

What each module assumes about its neighbor across the load-bearing boundaries. Each section names the **producer** (what B guarantees), the **consumer** (what A relies on), the **shape** (the cited type or invariant), and what **enforces** it (a type or a test).

## CLI → pipeline

**Producer (`pipeline/check.ts`).** `runCheck(doc, options)` is the whole default linter loop: it wires Tier-0 structural, GtWR/free lint, and the SMT formal tier into one report and returns a `Promise<CheckReport>` (`src/pipeline/check.ts:293`). The result shape is fixed: `findings: CheckFinding[]`, `excluded: Exclusion[]`, `pairsChecked: number`, `counts: { error; warn; info }` (`src/pipeline/check.ts:133-142`). Each `CheckFinding` carries a stable `code`, `severity`, `tier`, `requirementIds`, `message`, and optional `span`/`suggestion`/`evidence` (`src/pipeline/check.ts:97-109`).

**Consumer (`cli/index.ts`).** The CLI is "the thin formatter over the library API" (`src/cli/index.ts:1`). The `check` action builds `CheckOptions` from raw string flags via `buildCheckOptions` (`src/cli/index.ts:727-747`), calls `runCheck`, and wraps the report verbatim in a `success('check', {...report})` envelope (`src/cli/index.ts:369`, `398-404`). It never reshapes findings; it only spreads in the two CLI-owned extras (`emittedSmt2`, `binaryCrossCheck`).

**Shape / invariant.** `CheckOptions` is the contract surface: `similarityThreshold?`, `timeoutMs?`, `solverBudgetMs?`, and the opt-in `semantic?: { embedder; threshold? }` (`src/pipeline/check.ts:112-130`). The CLI never sets `semantic` unless `--semantic` is passed and the embedder loads (`src/cli/index.ts:353-366`). `buildCheckOptions` types itself against `NonNullable<Parameters<typeof runCheck>[1]>` (`src/cli/index.ts:732`), so a drifted option shape is a compile error. Severity `counts` is the input to the exit-code contract — the CLI's `exitCodeForEnvelope` reads it (`src/cli/index.ts:97`).

**Enforced by.** The `Parameters<typeof runCheck>` type binding on `buildCheckOptions` (compile-time). Behavior of the wired pipeline is covered by `src/pipeline/__tests__/check.test.ts` and the CLI path by `src/cli/__tests__/integration.test.ts`.

## pipeline → gate

**Producer (`pipeline/gate.ts`).** `gateRequirements(requirements)` partitions a requirement set into `{ included: Requirement[], excluded: Exclusion[] }` (`src/pipeline/gate.ts:50-55`, `125-127`). A statement is excluded when it has an `error`-severity GtWR finding (reason `'blocking-surface-check'`) or a marked parse failure (reason `'parse-failure'`); only `error`-severity findings block — `warn`/`info` never exclude (`src/pipeline/gate.ts:77-80`, `97-117`). The gate is pure and deterministic: gating the same set twice yields the identical partition (`src/pipeline/gate.ts:30-32`).

**Consumer (`pipeline/check.ts`).** `runCheck` computes `excluded = excludedIds(gateRequirements(requirements))` (`src/pipeline/check.ts:303-304`) and, inside the formal callback, filters the solver's requirements and pairs down to the included set before any encoding: `reqs.filter((r) => !excluded.has(r.id))` and `pairs.filter((p) => includedIdSet.has(p.a) && includedIdSet.has(p.b))` (`src/pipeline/check.ts:318-337`). The excluded set is surfaced (never double-counted, since the blocking findings already appear in the lint tier) via `CheckReport.excluded` (`src/pipeline/check.ts:28-30`, `420`).

**Shape / invariant.** "The SMT layer never receives unsound input" (`src/pipeline/gate.ts:6-7`) — the formal tier only ever sees `included`. This is the forced pipeline order parse → lint → symbolize → solve (`src/pipeline/check.ts:23-30`). What is *encodable* is exactly the gate's `included` output; anything with a blocking surface check is withheld from symbolization.

**Enforced by.** `src/pipeline/__tests__/gate.test.ts` (partition correctness, severity gating). The pure-determinism assumption is stated at `src/pipeline/gate.ts:30-32`.

## formal encode → backend

**Producer (`formal/encode.ts`).** `encode(req, atomize)` returns an `EncodedRequirement` whose `formula` is the guarded implication `guard ⇒ body`, where `guard` is the requirement id verbatim (so an unsat core names the culprit ids) and `body` is `context ⇒ response` (or a bare `response` for ubiquitous) (`src/formal/encode.ts:147-165`, `183-223`). The `Formula` is a plain-data, Z3-free AST — `atom | not | and | or | implies` (`src/formal/encode.ts:97-102`). `encode` is pure and never touches `z3-solver` (`src/formal/encode.ts:31-46`). `materialize(ctx, f)` lowers a `Formula` into a `z3-solver` `Bool` by structural recursion (`src/formal/encode.ts:238-251`).

**Consumer (`formal/backend.ts` + solver tiers).** `backend.ts` owns the one-time WASM init and hands back a fresh named `Z3Context` via `getContext(name)` (`src/formal/backend.ts:58-61`); the `init()` promise is memoized so concurrent callers share one WASM instantiation (`src/formal/backend.ts:36-50`). `materialize` depends only on the *shape* `Z3Context` (`ctx.Bool.const`, `ctx.Not`, `ctx.And`, `ctx.Or`, `ctx.Implies`) — the type alias `Z3Context = ReturnType<Z3Module['Context']>` (`src/formal/backend.ts:34`). `runCheck` obtains one context per check (`getContext('symspec-check')`, `src/pipeline/check.ts:331`) and passes it to the solver-driving tiers, which call `materialize` then `check()`.

**Shape / invariant.** The Formula AST + the guard-implication shape (`REQ-i ⇒ (context ⇒ response)`, `src/formal/encode.ts:4`) is the contract. Two boundaries hold across it: (1) encoding is pure/synchronously testable with no WASM boot, and materialization is a *separate* step the solver tiers call (`src/formal/encode.ts:36-40`, `232-237`); (2) atomization is injected, not imported (see next section) — `encode` depends on the `Atomize` function type, never on `atomize.ts` (`src/formal/encode.ts:41-46`, `81-86`).

**Enforced by.** `src/formal/__tests__/encode.test.ts` (per-pattern formula shape, purity over `ReqView`) and `src/formal/__tests__/backend.test.ts` (WASM init, availability probe).

## atomize → glossary → semantic (the propose/decide determinism contract)

This is the spec's designated load-bearing boundary. **Two halves that must never cross: embeddings PROPOSE, the committed glossary DECIDES.**

**Producer — DECIDE (`formal/atomize.ts`).** `atomize(args)` is the single pure function turning an EARS slot into a scoped Boolean `Atom` (`src/formal/atomize.ts:135-165`). It guarantees four tested invariants (`src/formal/atomize.ts:11-44`): purity/determinism (same input → byte-identical output, no clock, no mutable state), conservative near-exact normalization (lowercase → strip one leading article → strip punctuation → underscore-join; no stemming — `src/formal/atomize.ts:120-125`), per-`systemName` scoping (`sys__<system>__<kind>__<body>`, so identical text under two systems is two distinct atoms — `src/formal/atomize.ts:164`), and negation-on-the-same-atom (the AC-2-4 `negated` flag is polarity, composed by XOR with the antonym-table flip — `src/formal/atomize.ts:153-162`). Glossary canonicalization runs **first**, before antonym unification (`src/formal/atomize.ts:144-147`). `glossaryIndex(entries)` builds the normalized alias→canonical map `atomize` consumes (`src/formal/atomize.ts:96-105`).

**Consumer / Producer — PROPOSE (`formal/semantic.ts`).** `findSimilarSemantic` embeds response phrasings and, for same-system pairs whose atoms did **not** already unify, emits an info-tier `FND_SIMILAR_SEMANTIC` finding *suggesting* a `symspec glossary add` merge (`src/formal/semantic.ts:76-132`). It "NEVER emits a conflict verdict — its only durable effect is a suggestion the calling agent may confirm into the glossary" (`src/formal/semantic.ts:10-12`). It consults `atomize` to skip already-unified pairs (`atomA.name === atomB.name`, `src/formal/semantic.ts:100-103`) and respects the same per-system scoping (`src/formal/semantic.ts:97-98`).

**Shape / invariant — the propose/decide split.** The deterministic SMT verdict path consults *only* the committed glossary, never the embedding model (`src/formal/embed.ts:30-33`). The fuzzy embedding step only PROPOSES entries; the deterministic `glossaryIndex` lookup inside `atomize` is what actually merges them (`src/formal/atomize.ts:80-87`). The DECIDE half is the CLI `glossary add|remove|list` command (`src/cli/index.ts:610-656`); confirming an entry there is "what changes a verdict" (`src/cli/descriptions.ts:164`). Given `(doc + committed glossary + pinned model)` the run is reproducible — determinism lives entirely on the DECIDE side.

**Enforced by.** `src/formal/__tests__/atomize.test.ts` (the four invariants, each directly tested per `src/formal/atomize.ts:11`), `src/formal/__tests__/semantic.test.ts` (propose-only, skip-already-unified, same-system-only), and `src/pipeline/__tests__/check-semantic.test.ts` (the opt-in path).

## embed → model-cache (the embedder pooling contract)

**Producer (`formal/model-cache.ts`).** `ensureModelAssets(allowRemote)` returns digest-verified absolute local paths — `{ modelPath, tokenizerPath, tokenizerConfigPath }` (`src/formal/model-cache.ts:77-85`, `177-185`). Every asset is fetched from one frozen HuggingFace revision (`MODEL_REVISION`, `src/formal/model-cache.ts:41`) and checked against a hardcoded sha256; a silent upstream change or corrupt download fails the digest check rather than poisoning embeddings (`src/formal/model-cache.ts:12-18`, `155-161`). `allowRemote` defaults OFF: a cache miss with remote disabled throws `ModelAssetsUnavailableError` (`src/formal/model-cache.ts:138-142`).

**Consumer (`formal/embed.ts`).** `loadEmbedder` depends on `ensureModelAssets` returning those verified paths — the default pipeline factory calls it first, then reads the three files (`src/formal/embed.ts:102-122`). Any factory failure (cache miss, offline, corrupt) is normalized to the one contract `EmbedModelMissingError` → `ERR_EMBED_MODEL_MISSING` (`src/formal/embed.ts:210-216`, `45-61`). The model load never blocks the SMT/lint tiers — it is opt-in via `check --semantic` (`src/formal/embed.ts:22-26`; CLI lazy-load at `src/cli/index.ts:353-366`).

**Shape / invariant — the pooling contract.** `Embedder = (texts) => Promise<Float32Array[]>` (`src/formal/embed.ts:64`). The returned vectors are **CLS-pooled** (the `[CLS]` token at sequence position 0) and **L2-normalized**, matching how BGE was trained, "so a plain dot product IS cosine similarity" (`src/formal/embed.ts:9-12`). The pipeline pools + normalizes internally with `{ pooling: 'cls', normalize: true }` (`src/formal/embed.ts:218-223`); the CLS branch copies seq-index-0 hidden state then divides by the L2 norm (`src/formal/embed.ts:163-193`). Because of that, `cosine(a, b)` is implemented as a bare dot product with no re-normalization (`src/formal/embed.ts:231-236`) — and `semantic.ts` relies on this equivalence when it calls `cosine` (`src/formal/semantic.ts:111`). If the embedder ever returned un-normalized vectors, `cosine` would silently be wrong.

**Enforced by.** `src/formal/__tests__/model-cache.test.ts` (digest verification, offline throw, atomic publish) and `src/formal/__tests__/embed.test.ts` (CLS pooling, L2 normalization, dot==cosine, missing-model error mapping).

## CLI → manifest (single-source, no-drift)

**Producer.** Three single-source corpora feed the two agent-facing surfaces: `COMMAND_DESCRIPTIONS`/`COMMAND_SUMMARIES` (the what/when/returns/idempotency prose, `src/cli/descriptions.ts:55-185`), `COMMAND_SPECS` (the command inventory + per-command Zod argument object, `src/cli/manifest.ts:219-266`), and `EnvelopeTypeSchema` (the closed, append-only set of envelope `type` discriminants, `src/cli/types-enum.ts:54-76`). Argument descriptions in the manifest are the byte-for-byte `.describe()` corpus of the runtime-validating Zod fields — "the transcription IS the schema" (`src/cli/manifest.ts:11-16`, `359-361`).

**Consumer.** `cli/index.ts` wires the full `COMMAND_DESCRIPTIONS[name]` text into each Commander `.description()` (e.g. `src/cli/index.ts:158`, `167`, `200`, `292`); `manifest.ts` reads `COMMAND_SUMMARIES[c.name]` for each entry's summary and derives the `types` table from `EnvelopeTypes` (`src/cli/manifest.ts:387`, `392`). The success `type` of a command IS its command name — `success('check', …)`, `success('parse', …)` (`src/cli/types-enum.ts:19-25`).

**Shape / invariant.** The three corpora must stay synced: adding a command without its `EnvelopeType` (or vice versa), or letting a manifest description diverge from the Zod field, is drift. The envelope `type` enum is append-only — never remove/rename/reorder a shipped member (`src/cli/types-enum.ts:27-32`, `54-56`).

**Enforced by.** `src/cli/__tests__/types-enum.test.ts` asserts every `COMMAND_SPECS` name is an `EnvelopeType` member and every non-`'error'` member is a real command (`:72-94`), that `manifest().types` equals `EnvelopeTypes` (`:99`), and the append-only snapshot (`:56-58`). `src/cli/__tests__/manifest.test.ts` asserts manifest argument descriptions are byte-for-byte the `.describe()` metadata (`:62-97`) and the code-catalog descriptions match `ErrCodeMeta`/`GtwrCodeMeta`/`FndCodeMeta` (`:124-161`).


## See also

- [symspec · Module map](../architecture/module-map.md) — 12 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 10 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 9 shared source citations
- [symspec · Public API](../reference/public-api.md) — 7 shared source citations
- [symspec · Dependency graph](../diagrams/structural/dependency-graph.md) — 6 shared source citations
