# symspec · Impact analysis

"If I change X, what breaks?" for the surfaces whose blast radius is largest. Surfaces are ranked by real inbound-reference count — files (excluding the file itself) whose import lines reference the module, counted separately for `src/**` product code (`non-test`) and `src/**/__tests__` (`test`). Two change-safety mechanisms recur and are called out explicitly where they apply: the **manifest single-source derivation** (drift = a failing test, never a silent skew) and the **append-only enum snapshots** (a prefix-equality guard that turns any removal/rename/reorder into a failing test).

Ranking by non-test inbound references:

| Rank | Surface | non-test refs | test refs |
|---|---|---|---|
| 1 | `src/core/schema.ts` | 23 | 19 |
| 2 | `src/cli/envelope.ts` | 11 | 10 |
| 3 | `src/formal/encode.ts` | 10 | 11 |
| 4 | `src/formal/atomize.ts` | 5 | 2 |
| 4 | `src/formal/embed.ts` | 5 | 4 |
| 5 | `src/core/codes.ts` (ERR_*) | 4 files reference `ErrCode*` | 3 |
| 6 | `src/formal/model-cache.ts` | 3 | 1 |
| 6 | `src/formal/numeric.ts` | 3 | 2 |
| 6 | `src/formal/temporal-patterns.ts` | 3 | 2 |
| 6 | `src/formal/ambiguity.ts` | 3 | 2 |
| 7 | `src/pipeline/check.ts` | 2 | 1 |
| 7 | `src/formal/numeric-contradiction.ts` | 2 | 1 |
| 7 | `src/formal/temporal.ts` | 2 | 1 |
| 7 | `src/formal/graph.ts` | 2 | 1 |
| 7 | `src/cli/manifest.ts` (`COMMAND_SPECS`) | 2 | 8 |
| 8 | `src/formal/codes.ts` (FND_*) | 20 files reference `FndCode*`/`FND_` | 1 |
| 8 | `src/lint/codes.ts` (GTWR_*) | 2 files reference `GtwrCode*` | 1 |

Ref counts are `grep -rlE "['\"][^'\"]*/<base>\.js['\"]"` over `src --include="*.ts"`, minus the file itself; the three `codes.ts` files share a basename so they are counted by imported symbol instead.

## src/core/schema.ts

The doc shape everything reads (573 LOC). **23 non-test files, 19 test files** reference `schema`. It is the single source of truth for every schema in the system (`src/core/schema.ts:1-2`): the atomic field corpus `f` (`src/core/schema.ts:212-271`), the composed `RequirementSchema` / `RequirementsDocSchema` / `ChangeSchema` (`src/core/schema.ts:277`, `:337`, `:445`), the enum constants `EARS_PATTERNS` / `PRIORITIES` / `STATUSES` (`src/core/schema.ts:27`, `:36`, `:39`), the six-kind structural `Finding` union incl. `LeafUnverifiable` (`src/core/schema.ts:519-546`), and the per-command input shapes reused by the CLI and manifest (`src/core/schema.ts:388-437`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Add an EARS enum value to `EARS_PATTERNS` (`src/core/schema.ts:27`) | `patternType` fields widen everywhere; `encode.ts`'s per-pattern body build and `temporal-patterns.ts`'s `earsToTemporal` switch (`src/formal/temporal-patterns.ts:174-194`, exhaustive over `EarsPattern`) must handle it; the parse ladder must classify it | `tsc --noEmit` (exhaustiveness; part of `pnpm check`, `package.json:46`); `src/formal/__tests__/temporal-patterns.test.ts` |
| Rename/remove a field in `f` (e.g. `systemResponse`) (`src/core/schema.ts:218`) | Every composed schema and all product importers fail to compile; `earsToTemporal` and `extractNumericPredicates` both read `systemResponse`/`trigger`/`preCondition` off the view | `tsc --noEmit`; manifest byte-stability + description-propagation tests (`src/cli/__tests__/manifest.test.ts:62-97`) |
| Edit a field's `.describe()` text (`src/core/schema.ts:214-218`) | The manifest argument description and the generated `AGENTS.md` change byte-for-byte — intended single-source propagation, not a bug | `AGENTS.md` drift gate (`pnpm check:agents`, `package.json:49`) |
| Bump `SCHEMA_VERSION` (`src/core/schema.ts:573`) | Every existing on-disk document loads as `ERR_SCHEMA_VERSION`; there is no migrator — the contract is re-create via `init`+`parse`/`add` | `load.ts` version check; `src/core/__tests__/load.test.ts` |
| Add a `Finding` kind to the union (`src/core/schema.ts:519-546`) | `analyze.ts` must emit it and `pipeline/check.ts`'s `STRUCTURAL_SEVERITY` map (`src/pipeline/check.ts:604`) — a `Record<FndCode & 'FND_${string}', …>` — must map its FND code, or it fails to type-check | `tsc --noEmit`; `src/core/__tests__/schema.test.ts` |

The `RequirementsDoc` TypeScript type (`src/core/schema.ts:567`) and the Zod `RequirementsDocSchema` are two hand-maintained views of one shape, kept identical by `load.test.ts`/`schema.test.ts`.

## src/cli/envelope.ts

The agent-facing outer contract (203 LOC): every command result travels in `{ apiVersion, type, data }` or `{ apiVersion, type:'error', error, code, suggestions, partial? }`. **11 non-test files, 10 test files** reference `envelope`; every command emitter routes through `success()` / `failure()` (`src/cli/envelope.ts:159`, `:176`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Bump `API_VERSION` (`src/cli/envelope.ts:69`) | Every success and error envelope stamps the new integer; the manifest `apiVersion` literal must match (`src/cli/manifest.ts:318`, `:393`); agents negotiating the old version break | `src/cli/__tests__/api-version.test.ts` asserts envelope and manifest never drift |
| Add/rename a field in `SuccessEnvelope`/`ErrorEnvelope` (`src/cli/envelope.ts:100-140`) | Every agent parsing results, plus `output.ts`, `dense.ts`, `exit.ts`, `errors.ts`, `parse/result.ts` | `src/cli/__tests__/envelope.test.ts`, `output.test.ts`, `dense.test.ts` |
| Change the error envelope's `code` type (`src/cli/envelope.ts:127`) | Bound to `ErrCodeSchema` (`src/core/codes.ts:48`) — any error code an emitter uses must be a member, or it fails to type-check | `tsc --noEmit`; ERR_* append-only snapshot (below) |

`type` stays `z.string().min(1)` on the wire (`src/cli/envelope.ts:102`); the closed enum is enforced at the manifest/types-enum layer, not here.

## src/formal/encode.ts

The guarded-implication encoder (293 LOC): turns an EARS requirement into `REQ-i ⇒ (context ⇒ response)` (`src/formal/encode.ts:198-243`). **10 non-test, 11 test** references. It is the shared formula/AST layer all SMT-driving tiers consume — propositional (contradiction, subsumption, vacuity, completeness) AND the numeric and temporal tiers, which build `cmp` and lowered-LTL formulas out of these primitives and lower them with the same `materialize()` (`src/formal/encode.ts:260`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change the per-pattern body shape (`src/formal/encode.ts:205-243`) | Every propositional SMT finding's soundness — the formula is what the solver checks; `contradiction.ts`/`subsumption.ts`/`vacuity.ts` assert `encode()` output | `src/formal/__tests__/encode.test.ts` |
| Change the `guard` from the verbatim requirement id (`src/formal/encode.ts:239`) | The unsat core no longer maps back to culprit ids — this contract is shared by the numeric and temporal tiers, which reuse the identical assumption-literal-guard technique (`src/formal/numeric-contradiction.ts:84-89`, `src/formal/temporal.ts:126-131`) | `src/formal/__tests__/encode.test.ts`; contradiction/numeric/temporal tier tests |
| Add or change a `Formula` op (`src/formal/encode.ts:97-113`) | `materialize()`'s switch is exhaustive; the `cmp` arithmetic node lowers to a `z3-solver` `Real` comparison (`src/formal/encode.ts:272-290`) — a new op without a case fails to compile | `tsc --noEmit` (exhaustiveness) |
| Change `NumericComparator` (`src/formal/encode.ts:116`) | `numeric.ts`'s comparator lexicon, `cmp()`, and `materialize`'s comparator switch (`src/formal/encode.ts:277-289`) all key on it | `tsc --noEmit`; `src/formal/__tests__/numeric.test.ts` |
| Change the injected `Atomize` signature (`src/formal/encode.ts:81`) | `atomize.ts`'s adapter and `pipeline/check.ts`'s `makeAtomize` wiring (`src/pipeline/check.ts:518`, `:596`, `:746`) | `tsc --noEmit` |

The encoder is deliberately Z3-free and pure (`src/formal/encode.ts:31-46`); atomization is injected as a function type, never imported.

## src/formal/atomize.ts

The load-bearing atomization contract (165 LOC): the single pure function turning slot text into a Boolean atom (`src/formal/atomize.ts:135-165`). **5 non-test, 2 test** references. Every propositional formal finding is only as sound as this function — two requirements conflict exactly when their responses resolve to the same atom at opposite polarity. Note the numeric and temporal tiers do NOT route through `atomize.ts`: `numeric.ts` builds its own per-system quantity keys (`src/formal/numeric.ts:142-151`) and `temporal-patterns.ts` carries a self-contained scoping normalizer (`src/formal/temporal-patterns.ts:121-134`) that deliberately mirrors this file's normalization rules so temporal/propositional atoms collide by name — three parallel normalizers that must stay behaviorally identical.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Make `normalize()` more aggressive — stem/lemmatize/stopword (`src/formal/atomize.ts:120-125`) | Distinct requirements collapse to one atom → false-positive contradictions; also silently diverges from the temporal normalizer, so temporal and propositional atoms stop lining up | `src/formal/__tests__/atomize.test.ts`; `temporal-patterns.test.ts` |
| Change the `sys__<system>__<kind>__` scoping (`src/formal/atomize.ts:164`) | Cross-system unification; and `numeric.ts`/`temporal-patterns.ts` scoping would no longer parallel it | `src/formal/__tests__/atomize.test.ts` (per-systemName scoping) |
| Break negation-as-polarity / antonym XOR (`src/formal/atomize.ts:153-162`) | `shall X` and `shall not X` stop sharing one atom across BOTH the propositional and temporal tiers | `src/formal/__tests__/atomize.test.ts` |
| Introduce nondeterminism (clock/randomness) | Unsat-core minimization and the deterministic verdict path break | `src/formal/__tests__/atomize.test.ts` (determinism) |
| Reorder glossary-vs-antonym application (`src/formal/atomize.ts:140-147`) | A glossary alias that is also an antonym head resolves differently | `src/formal/__tests__/atomize.test.ts` |

## src/formal/embed.ts + src/formal/model-cache.ts

The Embedder contract and the pinned model. `embed.ts` (240 LOC, **5 non-test / 4 test** refs) defines `Embedder` (`src/formal/embed.ts:64`), `loadEmbedder()` (`src/formal/embed.ts:205`), the pinned id `EMBED_MODEL = 'Xenova/bge-base-en-v1.5'` (`src/formal/embed.ts:40`), and the propose-only invariant — the embedder produces similarity scores and never decides a conflict (`src/formal/embed.ts:26-33`). Both `semantic.ts` and `graph.ts` consume it (`src/formal/graph.ts:29`, `:112`). `model-cache.ts` (237 LOC, **3 non-test / 1 test** refs) owns the sha256-pinned assets.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change `EMBED_MODEL` (`src/formal/embed.ts:40`) without repinning assets | The cache dir key and the pinned sha256 digests no longer match → every fetch fails digest verification | `src/formal/__tests__/model-cache.test.ts`; `embed.test.ts` |
| Change `MODEL_REVISION` or an asset `sha256` (`src/formal/model-cache.ts:41`) | A silent upstream/pinned-digest mismatch is intentionally a hard failure (`ERR_EMBED_MODEL_MISSING`) rather than poisoned embeddings | `src/formal/__tests__/model-cache.test.ts` |
| Change CLS pooling / L2-normalization (`src/formal/embed.ts:163-193`, `:221`) | `cosine()` no longer equals a dot product (`src/formal/embed.ts:231-236`); the `graph.ts` `dot()` shortcut (`src/formal/graph.ts:89-95`) silently mis-scores every edge | `src/formal/__tests__/embed.test.ts`, `similar.test.ts`, `graph.test.ts` |
| Make the embedder decide a verdict instead of propose | Violates the propose-only invariant shared by `semantic.ts` and `graph.ts` (`src/formal/graph.ts:8-13`) — the SMT path consults only the committed glossary | `src/formal/__tests__/embed.test.ts`; graph/semantic tests |

## src/pipeline/check.ts

The tier orchestrator (1350 LOC): `runCheck(doc, options)` wires Tier-0 structural → GtWR lint → always-on ambiguity → the waiver-aware AC-3-7 gate → free tier + the injected formal closure → the propose-only quantity-alias/relational detectors → coverage + demotion computation → `verified`, into one `CheckReport` (`src/pipeline/check.ts:311`). **2 non-test (`src/index.ts`, `src/cli/index.ts`), 1 test** references. This file is where every v3 tier is turned on or off, where the gate-scope decision per tier lives, and — since the issue-#2 hardening — where `verified` is computed as `demotions.length === 0` and every propose-only coverage finding is classified into a demotion. It is the single highest-leverage change surface for the doctrine: the demotion-only invariant lives entirely in this file.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Reorder the tier sequence (`src/pipeline/check.ts:311`) | The forced parse → lint → gate → symbolize → solve order is a soundness invariant — the SMT layer must never see gate-excluded input | `src/pipeline/__tests__/check.test.ts`, `gate.test.ts` |
| Change which set a tier runs over | The numeric and temporal tiers deliberately run over ALL requirements, not the gate-included subset (`src/pipeline/check.ts:822`, `:871`); moving them behind the gate would let a lint-blocking finding hide a real numeric/temporal contradiction | `src/pipeline/__tests__/check-numeric.test.ts` |
| Add a propose-only code without adding it to `PROPOSE_ONLY_FND_CODES` (`src/pipeline/check.ts:413`) | The fuzzy finding would count toward `verified` — a false promotion, the demotion-only violation. `COVERAGE_GAP_FND_CODES` (`:441`) additionally governs whether it suppresses the `FND_NO_PAIRS_CHECKED` disclaimer | `adversarial/__tests__/eval-rounds.test.ts`; `src/pipeline/__tests__/check.test.ts` |
| Change the `verified = demotions.length === 0` computation or the `CoverageDemotion.reason` union (`src/pipeline/check.ts:252`, `:1289`) | The agent iteration loop (each demotion is a work-list entry with a discharging action); the `--strict` exit-3 gate reads `verified` | `adversarial/__tests__/eval-rounds.test.ts` (abstention cases assert demote + actionable) |
| Key the `excluded-from-formal` demotion off the post-waiver set instead of `gateResult.excluded` (`src/pipeline/check.ts:1191`, `:1219`) | Waiving the disclosure would promote `verified` over a requirement the solver never saw — a demotion-only violation the adversarial critic caught | `src/pipeline/__tests__/check.test.ts` |
| Change the formal-closure contract (`FormalTierInput`/`FormalTierResult`) | `runSolvers`'s injected `formal` closure (`src/solvers/index.ts:32-52`); the closure reports `findings: []` back and pushes rich findings into `check.ts`'s own array to avoid double-counting (`src/pipeline/check.ts:344`, `:1004`) | `tsc --noEmit`; `src/pipeline/__tests__/check.test.ts` |
| Alter `CheckReport` shape (`src/pipeline/check.ts:324`) | The CLI wraps it verbatim; `counts` feeds the exit-code contract, `coverage`/`verified`/`strictGate` feed exit-3 and `--field` projections (`src/cli/index.ts:97`) | `src/cli/__tests__/integration.test.ts` |
| Gate a new tier's opt-in flag wrong (`--semantic`/`--temporal`, `src/pipeline/check.ts:871`, `:884`) | Semantic + graph load the embedding model; temporal boots a bounded LTL→SMT check — a default-on mistake makes base `check` load the model or pay solver cost | `src/pipeline/__tests__/check-semantic.test.ts` |

## src/formal/numeric.ts + src/formal/numeric-contradiction.ts

The always-on numeric/arithmetic conflict tier (v3.0, LIA/LRA). `numeric.ts` (257 LOC, **3 non-test / 2 test** refs) lifts `(quantity, comparator, value, unit)` tuples out of slot text with `extractNumericPredicates(text, systemName)` (`src/formal/numeric.ts:196`), unit-normalizing to a canonical base (ms, B) and building a per-system quantity key (`src/formal/numeric.ts:142-151`). `numeric-contradiction.ts` (160 LOC, **2 non-test / 1 test** refs) groups predicates by quantity and proves joint-UNSAT over Z3, naming culprits from a deletion-minimized unsat core (`src/formal/numeric-contradiction.ts:55-133`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change `quantityKey` normalization (`src/formal/numeric.ts:142-151`) | Two phrasings of one quantity land on different Real variables and never meet — the single named false-negative risk (`src/formal/numeric.ts:11-16`) | `src/formal/__tests__/numeric.test.ts` |
| Add/change a unit in `DIMENSIONS` (`src/formal/numeric.ts:58-96`) | Two predicates in different units of one dimension stop normalizing to a shared base → a real conflict (2000 ms vs 200 ms) is missed | `src/formal/__tests__/numeric.test.ts` |
| Change the comparator lexicon or its longest-match ordering (`src/formal/numeric.ts:114-134`) | A shorter phrase re-matches inside a longer one already claimed (`src/formal/numeric.ts:199-213`); comparators mis-extract | `src/formal/__tests__/numeric.test.ts` |
| Change the guard/core-minimization contract (`src/formal/numeric-contradiction.ts:82-104`) | An innocent requirement sharing a quantity rides along in the culprit list | `src/formal/__tests__/numeric-contradiction.test.ts` |
| Make extraction non-deterministic or use a model | Verdict-eligible (`error`) findings enter the byte-reproducibility contract; extraction must stay pure regex/lexicon (`src/formal/numeric.ts:21-27`) | `src/formal/__tests__/numeric.test.ts` |

## src/formal/temporal-patterns.ts + src/formal/temporal.ts

The opt-in bounded temporal tier (v3.3, `--temporal`). `temporal-patterns.ts` (195 LOC, **3 non-test / 2 test** refs) is the pure EARS→LTL front half: `earsToTemporal(req)` maps each EARS pattern to a Dwyer/SPS/FRET LTL shape (`src/formal/temporal-patterns.ts:168-195`) over the `TemporalFormula` AST + `tAtom`/`tNot`/`G`/`F`/`X`/`U` constructors (`src/formal/temporal-patterns.ts:58-108`). `temporal.ts` (224 LOC, **2 non-test / 1 test** refs) lowers a formula to per-timestep Bools with `lowerAt` (`src/formal/temporal.ts:62`) and proves temporal contradictions with `findTemporalContradictions(ctx, reqs, k)` (`src/formal/temporal.ts:118`). SOUND-FOR-UNSAT, not complete-for-SAT (`src/formal/temporal.ts:13-32`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change an EARS→LTL mapping (`src/formal/temporal-patterns.ts:174-194`) | The temporal semantics of every requirement of that pattern; a wrong shape yields false or missed contradictions | `src/formal/__tests__/temporal-patterns.test.ts` (per-pattern shape) |
| Break the self-contained atom scoping (`src/formal/temporal-patterns.ts:121-134`) | Temporal atoms stop colliding with propositional atoms of the same slot text — the two tiers disagree on what "the response" is | `src/formal/__tests__/temporal-patterns.test.ts` |
| Change the loop-free unrolling of `G`/`F`/`X`/`U` (`src/formal/temporal.ts:62-102`) | The sound-for-UNSAT guarantee (`src/formal/temporal.ts:13-25`) — an `unsat` at bound `k` must remain a genuine contradiction; a `sat` must remain non-committal | `src/formal/__tests__/temporal.test.ts` |
| Remove the antecedent-reachability assertion (`src/formal/temporal.ts:186-206`) | A `G(ante → cons)` obligation becomes vacuously satisfiable by keeping `ante` false forever, hiding real response-vs-absence conflicts | `src/formal/__tests__/temporal.test.ts` |
| Emit a finding on `sat`/`unknown` instead of only `unsat` (`src/formal/temporal.ts:129`) | Over-reporting — a bounded `sat` is not a consistency certificate | `src/formal/__tests__/temporal.test.ts` |

The bounded-response feasibility of the Z3-WASM encoding is gated in CI by `scripts/temporal-feasibility.ts` (`runBoundedResponse` :45, prints FEASIBLE/INFEASIBLE :108).

## src/formal/graph.ts + src/formal/ambiguity.ts

Two v3.1/v3.2 tiers. `graph.ts` (238 LOC, **2 non-test / 1 test** refs) builds a deterministic kNN similarity graph with `buildSimilarityGraph(reqs, embedder, opts)` (`src/formal/graph.ts:102`), emitting propose-only `FND_MISSING_TRACE_LINK` and `FND_DUPLICATE_CLUSTER` (`src/formal/graph.ts:151`, `:229`); it runs only under `--semantic`. `ambiguity.ts` (460 LOC, **3 non-test / 2 test** refs) is the always-on deterministic ambiguity family: `detectAmbiguity(reqs)` (`src/formal/ambiguity.ts:442`) emits the four `AmbiguityCode` findings (`src/formal/ambiguity.ts:40-44`), only the mechanical un-parenthesized `and…or` coordination case being verdict-eligible `warn` (`src/formal/ambiguity.ts:270`), the rest `info`.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Break graph determinism — drop cosine quantization, id tiebreak, or union-find (`src/formal/graph.ts:81-95`, `:176-238`) | ULP-flip jitter or iteration order flips an edge/cluster in or out; the always-on-when-semantic tier stops being byte-reproducible (`src/formal/graph.ts:6-27`) | `src/formal/__tests__/graph.test.ts` |
| Change the graph threshold/k defaults (`src/formal/graph.ts:77-79`) | Different `FND_MISSING_TRACE_LINK`/`FND_DUPLICATE_CLUSTER` proposals; these feed an agent's `symspec derive` suggestions | `src/formal/__tests__/graph.test.ts` |
| Promote any ambiguity code above `warn` or make more than the `and…or` case verdict-eligible (`src/formal/ambiguity.ts:270`, `:284`) | The verdict-eligible surface changes; over-firing trains authors to ignore the linter (`src/formal/ambiguity.ts:20-27`) | `src/formal/__tests__/ambiguity.test.ts` |
| Grow the vague lexicon or reference detector (`src/formal/ambiguity.ts`) | Recall-first precision drops; these are `info` proposals surfaced for human/LLM review, never resolutions | `src/formal/__tests__/ambiguity.test.ts` |

## Error / GTWR / FND code catalogs — closed, append-only, snapshot-guarded

Three sibling enums, each the closed set its envelope field validates against, each with a per-code `.describe()` corpus the manifest derives from, each with a prefix-equality snapshot test.

- **`src/core/codes.ts` — ERR_\*** (227 LOC). `ErrCodeSchema` (20 codes, `src/core/codes.ts:48`); `ErrCodeMeta satisfies Record<ErrCode, …>` so enum and corpus cover exactly the same codes at compile time (`src/core/codes.ts:203`). 4 non-test files reference `ErrCode*`; it is the type of the error envelope's `code` (`src/cli/envelope.ts:127`).
- **`src/lint/codes.ts` — GTWR_\*** (147 LOC). `GtwrCodeSchema` (24 INCOSE GtWR rules, `src/lint/codes.ts:33`); `GtwrCodeMeta satisfies Record<GtwrCode, …>` (`src/lint/codes.ts:147`). 2 non-test refs.
- **`src/formal/codes.ts` — FND_\*** . `FndCodeSchema` (**30 codes**, `src/formal/codes.ts:54-122`); `FndCodeMeta` (`src/formal/codes.ts:134`) `satisfies Record<FndCode, …>` (`src/formal/codes.ts:267`). 20 non-test files reference `FndCode*`/`FND_` — the findings vocabulary the whole structural/lint/formal/numeric/temporal/graph/ambiguity pipeline emits. The 30 members include the v3 tier codes (`FND_NUMERIC_CONTRADICTION`, `FND_LEAF_UNVERIFIABLE`, `FND_MISSING_TRACE_LINK`, `FND_DUPLICATE_CLUSTER`, the four `FND_AMBIGUOUS_*`/`FND_AMBIGUITY_NEEDS_JUDGMENT`, `FND_TEMPORAL_CONTRADICTION`) and the issue-#2 hardening's three append-only additions: `FND_EXCLUDED_FROM_FORMAL`, `FND_QUANTITY_ALIAS_CANDIDATE`, `FND_RELATIONAL_UNCHECKED`, all info-severity (`src/formal/codes.ts:106`, `:114`, `:121`). Adding or reordering an FND code trips the append-only snapshot AND the reachability scan in `src/formal/__tests__/codes.test.ts` (`:104` prefix-equality, `:232` every code must be produced by an emitter).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Remove or rename a shipped code | An agent already switching on it breaks | Append-only snapshot — the frozen prefix must equal `<Codes>.slice(0, N)`: `src/core/__tests__/codes.test.ts:49`, `src/lint/__tests__/codes.test.ts:46`, `src/formal/__tests__/codes.test.ts:104` |
| Reorder codes | Same as removal — prefix equality fails | Same snapshot tests |
| Add a code to the enum but not the `*CodeMeta` corpus | The `satisfies Record<Code, …>` bound fails to type-check (`src/core/codes.ts:203`, `src/lint/codes.ts:147`, `src/formal/codes.ts:267`) | `tsc --noEmit` |
| Edit a code's `.describe()` text | The manifest code table and `AGENTS.md` change byte-for-byte — intended single-source propagation (`src/cli/manifest.ts:18-27`) | Manifest code-table tests (`src/cli/__tests__/manifest.test.ts:103`); `AGENTS.md` drift gate (`package.json:49`) |
| Add an FND code with no emitter | Dead vocabulary | Reachability test — unreachable FND codes must be empty (`src/formal/__tests__/codes.test.ts:232`) |

Add-a-code is safe by design: append to the END of the enum, add its `.describe()`, and both the manifest and `AGENTS.md` pick it up automatically with zero hand-transcription.

## src/cli/manifest.ts + the command single-source

`src/cli/manifest.ts` (425 LOC) — the manifest single-source. `buildManifest()` is pure and byte-deterministic (`src/cli/manifest.ts:389`): every command argument schema is `z.toJSONSchema` over the *same* atomic fields the runtime validates with, and every code table is derived from the exported Zod enums plus their `.describe()` corpus. `COMMAND_SPECS` (`src/cli/manifest.ts:229`) is the command inventory; only `src/index.ts` imports the manifest module (2 non-test refs), but its output fans out to `AGENTS.md` (via `scripts/gen-agents.ts`, which calls `buildManifest()` and renders the code/command tables — `scripts/gen-agents.ts:23-33`, `:133-141`), the `manifest` command, and every drift test (`buildManifest`/`COMMAND_SPECS` appear across 12 `src`+`scripts` files).

Adding a command requires four in-lockstep edits: a `COMMAND_SPECS` entry (`src/cli/manifest.ts:229`), a `COMMAND_DESCRIPTIONS` entry (`src/cli/descriptions.ts:55`), an `EnvelopeTypeSchema` member (`src/cli/types-enum.ts:54`), and the `.command()` wiring in `src/cli/index.ts`. `src/cli/__tests__/types-enum.test.ts:94` asserts every `COMMAND_SPECS` name is a `type` member and vice versa; miss any one and it fails a test.

## See also

- [Module map](../architecture/module-map.md) — 18 shared source citations
- [Public API](../reference/public-api.md) — 16 shared source citations
- [Contract map](contract-map.md) — 15 shared source citations
- [Processes](../behavior/processes.md) — 11 shared source citations
- [Business logic](business-logic.md) — 10 shared source citations
