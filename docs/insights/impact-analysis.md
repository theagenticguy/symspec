# symspec · Impact analysis

"If I change X, what breaks?" for the surfaces whose blast radius is largest. Surfaces are ranked by real inbound-reference count — files (excluding the file itself) whose import lines reference the module, counted separately for `src/**` product code (`non-test`) and `src/**/__tests__` (`test`). Two change-safety mechanisms recur and are called out explicitly where they apply: the **manifest single-source derivation** (drift = a failing test, never a silent skew) and the **append-only enum snapshots** (a prefix-equality guard that turns any removal/rename/reorder into a failing test).

Ranking by non-test inbound references:

| Rank | Surface | non-test refs | test refs |
|---|---|---|---|
| 1 | `src/core/schema.ts` | 22 | 17 |
| 2 | `src/cli/envelope.ts` | 11 | 10 |
| 3 | `src/formal/encode.ts` | 7 | 11 |
| 4 | `src/formal/atomize.ts` | 5 | 2 |
| 5 | `src/formal/embed.ts` | 4 | 3 |
| 6 | `src/core/codes.ts` (ERR_*) | 4 files reference `ErrCode*` | 3 |
| 7 | `src/formal/model-cache.ts` | 3 | 1 |
| 8 | `src/cli/manifest.ts` (`COMMAND_SPECS`) | 2 | 8 |
| 8 | `src/cli/descriptions.ts` | 2 | 0 |
| 8 | `src/cli/types-enum.ts` | 2 | 1 |
| 9 | `src/formal/codes.ts` (FND_*) | 16 files reference `FndCode*`/`FND_` | 1 |
| 9 | `src/lint/codes.ts` (GTWR_*) | 2 files reference `GtwrCode*` | 1 |

Ref counts are `grep -rlE "['\"][^'\"]*/<base>\.js['\"]"` over `src --include="*.ts"`, minus the file itself; the three `codes.ts` files share a basename so they are counted by imported symbol instead.

## src/core/schema.ts

The doc shape everything reads (572 LOC). **22 non-test files, 17 test files** reference `schema`. Sixteen product modules import it directly across `cli/`, `parse/`, `pipeline/`, `formal/`, and `solvers/`. It is the single source of truth for every schema in the system (`src/core/schema.ts:1-2`): the atomic field corpus `f` (`src/core/schema.ts:212-271`), the composed `RequirementSchema` / `RequirementsDocSchema` / `ChangeSchema` (`src/core/schema.ts:277`, `:337`, `:445`), the enum constants `EARS_PATTERNS` / `PRIORITIES` / `STATUSES` (`src/core/schema.ts:27`, `:36`, `:39`), and the per-command input shapes reused by the CLI and manifest (`src/core/schema.ts:388-437`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Add an EARS enum value to `EARS_PATTERNS` (`src/core/schema.ts:27`) | `patternType` fields widen everywhere; `encode.ts` per-pattern body table (`src/formal/encode.ts:16-24`) and the parse ladder must handle it; `PartialSlotsSchema` (`src/cli/envelope.ts:83`) widens | `tsc --noEmit` (part of `pnpm check`, `package.json:46`); `src/core/__tests__/schema.test.ts` |
| Rename/remove a field in `f` (e.g. `systemResponse`) (`src/core/schema.ts:218`) | Every composed schema and all 16 product importers fail to compile; the manifest argument schema for `add` changes shape | `tsc --noEmit`; manifest byte-stability + description-propagation tests (`src/cli/__tests__/manifest.test.ts:62-81`) |
| Edit a field's `.describe()` text (`src/core/schema.ts:74-206`) | The manifest argument description and the generated `AGENTS.md` change byte-for-byte — this is intended single-source propagation, not a bug | `AGENTS.md` drift gate (`pnpm check:agents`, `package.json:49`); `src/__tests__/agents-md.test.ts:24-31` |
| Bump `SCHEMA_VERSION` (`src/core/schema.ts:572`) | Every existing on-disk document loads as `ERR_SCHEMA_VERSION`; there is no migrator — the contract is re-create via `init`+`parse`/`add` (`src/core/codes.ts:31-35`, `:109-113`) | `load.ts` version check; `src/core/__tests__/load.test.ts` |
| Change `RequirementsDocSchema` shape (`src/core/schema.ts:337`) | Load-time validation of every document changes; a doc that no longer validates is rejected `ERR_DOC_PARSE` before any command runs | `src/core/__tests__/schema.test.ts`; the hand-written `RequirementsDoc` type is kept structurally identical (`src/core/schema.ts:556-570`) |

Note the load-bearing coupling: the `RequirementsDoc` TypeScript type (`src/core/schema.ts:566`) and the Zod `RequirementsDocSchema` are two hand-maintained views of one shape, kept identical by `load.test.ts`/`schema.test.ts` (`src/core/schema.ts:557-559`).

## src/cli/envelope.ts

The agent-facing outer contract (203 LOC): every command result travels in `{ apiVersion, type, data }` or `{ apiVersion, type:'error', error, code, suggestions, partial? }` (`src/cli/envelope.ts:1-14`). **11 non-test files, 10 test files** reference `envelope`; every command emitter routes through `success()` / `failure()` (`src/cli/envelope.ts:159`, `:176`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Bump `API_VERSION` (`src/cli/envelope.ts:69`) | Every success and error envelope stamps the new integer; the manifest `apiVersion` literal must match (`src/cli/manifest.ts:308`, `:383`); agents negotiating the old version break — this is the only legitimate reason to bump it (`src/cli/envelope.ts:61-68`) | `src/cli/__tests__/api-version.test.ts` asserts envelope and manifest never drift |
| Add/rename a field in `SuccessEnvelope`/`ErrorEnvelope` (`src/cli/envelope.ts:100-140`) | Every agent parsing results, plus `output.ts`, `dense.ts`, `exit.ts`, `errors.ts`, `parse/result.ts` | `src/cli/__tests__/envelope.test.ts`, `output.test.ts`, `dense.test.ts` |
| Change `partial` presence semantics (`src/cli/envelope.ts:176-186`) | Tier-3 parse errors that recovered a skeleton; `fromTier3Envelope` (`src/cli/envelope.ts:196`) round-trips must hold under `exactOptionalPropertyTypes` | `src/cli/__tests__/envelope.test.ts`; `tsc --noEmit` |
| Change the error envelope's `code` type (`src/cli/envelope.ts:127`) | Bound to `ErrCodeSchema` (`src/core/codes.ts:48`) — any error code an emitter uses must be a member, or it fails to type-check | `tsc --noEmit`; ERR_* append-only snapshot (below) |

`type` is now closed by `EnvelopeTypeSchema`, but the envelope module deliberately keeps `type: z.string().min(1)` on the wire (`src/cli/envelope.ts:104`) — the closed enum is enforced at the manifest/types-enum layer, not here.

## src/cli/types-enum.ts + src/cli/manifest.ts + src/cli/descriptions.ts — the command single-source

These three files plus `src/cli/index.ts` are the four places an added command must touch in lockstep. The design makes three of the four un-driftable by construction; the fourth (`index.ts` wiring) is what actually executes the command.

**`src/cli/manifest.ts` (415 LOC) — the manifest single-source.** `buildManifest()` is pure and byte-deterministic (`src/cli/manifest.ts:379`): every command argument schema is `z.toJSONSchema` over the *same* atomic fields the runtime validates with (`src/cli/manifest.ts:8-16`, `:359-361`), and every code table is derived from the exported Zod enums plus their `.describe()` corpus (`src/cli/manifest.ts:18-27`, `:370-372`). Nothing is hand-transcribed — "the transcription IS the schema" (`src/cli/manifest.ts:16`). `COMMAND_SPECS` (`src/cli/manifest.ts:219-266`) is the command inventory; only `src/index.ts` imports the manifest module (2 non-test refs), but its output fans out to `AGENTS.md`, the `manifest` command, and every drift test (`buildManifest`/`COMMAND_SPECS`/`COMMAND_SUMMARIES` appear across 13 `src`+`scripts` files).

**`src/cli/descriptions.ts` (185 LOC).** `COMMAND_DESCRIPTIONS` is the one prose corpus (`src/cli/descriptions.ts:55`); `COMMAND_SUMMARIES` derives the manifest one-liner as the first line of each (`src/cli/descriptions.ts:180-185`). `cli/index.ts` wires the full text into `.description()` (`src/cli/index.ts:56`, `:158`), `cli/manifest.ts` reads the summaries (`src/cli/manifest.ts:61`, `:387`) — so the CLI help and the manifest summary cannot disagree (2 non-test refs: `index.ts`, `manifest.ts`).

**`src/cli/types-enum.ts` (96 LOC).** `EnvelopeTypeSchema` (`src/cli/types-enum.ts:54-76`) is the closed, append-only set of envelope `type` discriminants; the manifest `types` table is derived from it (`src/cli/manifest.ts:392`), never a parallel list.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Add a command | Must add: a `COMMAND_SPECS` entry (`src/cli/manifest.ts:219`), a `CommandName` + `COMMAND_DESCRIPTIONS` entry (`src/cli/descriptions.ts:32`, `:55`), an `EnvelopeTypeSchema` member (`src/cli/types-enum.ts:54`), and the `.command()` wiring in `src/cli/index.ts:157+`. Miss any one and it fails a test | `src/cli/__tests__/types-enum.test.ts:72` asserts every `COMMAND_SPECS` name is a `type` member and vice versa; `Record<CommandName,…>` on `COMMAND_DESCRIPTIONS` (`src/cli/descriptions.ts:55`) fails `tsc` if a name is missing |
| Reorder/remove an `EnvelopeTypeSchema` member (`src/cli/types-enum.ts:54`) | An agent already switching on the discriminant breaks | Append-only snapshot: `EnvelopeTypes.slice(0, N)` must equal the frozen prefix (`src/cli/__tests__/types-enum.test.ts:25-58`) |
| Edit a command summary/description (`src/cli/descriptions.ts:55`) | The manifest summary and generated `AGENTS.md` change (intended propagation) | `AGENTS.md` drift gate (`package.json:49`); `src/__tests__/agents-md.test.ts:24` |
| Hand-write a manifest field instead of deriving it | Two `buildManifest()` calls would no longer serialize identically | Byte-stability test (`src/cli/__tests__/manifest.test.ts:21`) |

## src/formal/encode.ts

The guarded-implication encoder (251 LOC): turns an EARS requirement into `REQ-i ⇒ (context ⇒ response)` (`src/formal/encode.ts:1-13`). **7 non-test, 11 test** references. It is the shared formula/AST layer the SMT-driving tiers (contradiction, subsumption, vacuity, redundancy) consume, plus `materialize()` lowers the AST into Z3 (`src/formal/encode.ts:238`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change the per-pattern body shape (`src/formal/encode.ts:16-24`, `:211-213`) | Every SMT finding's soundness — the formula is what the solver checks; `contradiction.ts`, `subsumption.ts`, `vacuity.ts` all assert `encode()` output | `src/formal/__tests__/encode.test.ts` (per-pattern formula-shape tests) |
| Change the `guard` from the verbatim requirement id (`src/formal/encode.ts:216-221`) | The unsat core no longer maps back to culprit ids — the "exactly two ids" contradiction contract (AC-4-4) breaks | `src/formal/__tests__/encode.test.ts`; contradiction tier tests |
| Change the injected `Atomize` signature (`src/formal/encode.ts:81-86`) | `atomize.ts`'s adapter and `pipeline/check.ts` wiring | `tsc --noEmit`; `src/formal/__tests__/encode.test.ts` |
| Add a `Formula` op (`src/formal/encode.ts:97-102`) | `materialize()`'s switch is exhaustive — a new op without a case fails to compile | `tsc --noEmit` (exhaustiveness) |

The encoder is deliberately Z3-free and pure (`src/formal/encode.ts:31-46`); atomization is injected as a function type, never imported, so `encode.ts` and `atomize.ts` stay decoupled.

## src/formal/atomize.ts

The load-bearing atomization contract (165 LOC): the single pure function turning slot text into a Boolean atom (`src/formal/atomize.ts:1-9`). **5 non-test, 2 test** references. Every formal finding is only as sound as this function — two requirements conflict exactly when their responses resolve to the same atom at opposite polarity (`src/formal/atomize.ts:4-9`).

| Change | What breaks | Guard that catches it |
|---|---|---|
| Make `normalize()` more aggressive — stem/lemmatize/stopword (`src/formal/atomize.ts:120-125`) | Distinct requirements collapse to one atom → false-positive contradictions; the spec's single named false-positive risk class (`src/formal/atomize.ts:24-27`) | `src/formal/__tests__/atomize.test.ts` (purity + "issue"/"issues" stay distinct) |
| Change the `sys__<system>__<kind>__` scoping (`src/formal/atomize.ts:164`) | Cross-system unification — identical response text under two systems would spuriously conflict (`src/formal/atomize.ts:28-33`) | `src/formal/__tests__/atomize.test.ts` (per-systemName scoping) |
| Break negation-as-polarity / antonym XOR (`src/formal/atomize.ts:153-162`) | `shall X` and `shall not X` stop sharing one atom; grant/revoke conflicts become false negatives | `src/formal/__tests__/atomize.test.ts` |
| Introduce nondeterminism (clock/randomness) | Unsat-core minimization and the deterministic verdict path break (`src/formal/atomize.ts:14-19`) | `src/formal/__tests__/atomize.test.ts` (determinism) |
| Reorder glossary-vs-antonym application (`src/formal/atomize.ts:140-147`) | A glossary alias that is also an antonym head resolves differently | `src/formal/__tests__/atomize.test.ts` |

## src/formal/embed.ts + src/formal/model-cache.ts

The Embedder contract and the pinned model. `embed.ts` (240 LOC, **4 non-test / 3 test** refs) defines `Embedder` (`src/formal/embed.ts:64`), `loadEmbedder()` (`src/formal/embed.ts:205`), the pinned id `EMBED_MODEL = 'Xenova/bge-base-en-v1.5'` (`src/formal/embed.ts:40`), and the propose-only invariant — the embedder produces similarity scores and never decides a conflict (`src/formal/embed.ts:26-33`). `model-cache.ts` (237 LOC, **2 non-test / 1 test** refs) owns the sha256-pinned assets.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Change `EMBED_MODEL` (`src/formal/embed.ts:40`) without repinning assets | The cache dir key and the three sha256 digests (`src/formal/model-cache.ts:56-75`) no longer match → every fetch fails digest verification | `src/formal/__tests__/model-cache.test.ts`; `src/formal/__tests__/embed.test.ts` |
| Change `MODEL_REVISION` or an asset `sha256` (`src/formal/model-cache.ts:41`, `:60`) | A silent upstream/pinned-digest mismatch is intentionally a hard failure (`ERR_EMBED_MODEL_MISSING`) rather than poisoned embeddings (`src/formal/model-cache.ts:13-18`, `:155-161`); the byte-reproducibility invariant | `src/formal/__tests__/model-cache.test.ts` |
| Change CLS pooling / L2-normalization (`src/formal/embed.ts:163-193`, `:221`) | `cosine()` no longer equals a dot product (`src/formal/embed.ts:231-236`); similarity scores shift → different `FND_SIMILAR_SEMANTIC` proposals | `src/formal/__tests__/embed.test.ts`, `similar.test.ts` |
| Make the embedder decide a verdict instead of propose | Violates the load-bearing propose-only invariant (`src/formal/embed.ts:26-33`); the SMT path consults only the committed glossary, never the model | `src/formal/__tests__/embed.test.ts`; glossary/atomize tests |
| Remove offline-by-default (`allowRemote` defaults off, `src/formal/embed.ts:206`) | The default `check` would hit the network; the semantic tier is opt-in and must never block SMT/lint (`src/formal/embed.ts:19-25`) | `src/formal/__tests__/embed.test.ts` |

## Error / GTWR / FND code catalogs — closed, append-only, snapshot-guarded

Three sibling enums, each the closed set its envelope field validates against, each with a per-code `.describe()` corpus the manifest derives from, each with a prefix-equality snapshot test.

- **`src/core/codes.ts` — ERR_\*** (227 LOC). `ErrCodeSchema` (40 codes, `src/core/codes.ts:48-81`); `ErrCodeMeta` describe corpus (`src/core/codes.ts:95-194`), bound `satisfies Record<ErrCode, …>` so enum and corpus cover exactly the same codes at compile time (`src/core/codes.ts:194`). 4 non-test files reference `ErrCode*`; it is the type of the error envelope's `code` (`src/cli/envelope.ts:127`).
- **`src/lint/codes.ts` — GTWR_\*** (147 LOC). `GtwrCodeSchema` (`src/lint/codes.ts:33`); `GtwrCodeMeta satisfies Record<GtwrCode,…>` (`src/lint/codes.ts:147`). 2 non-test refs.
- **`src/formal/codes.ts` — FND_\*** (184 LOC). `FndCodeSchema` (17 codes, `src/formal/codes.ts:54-78`); `FndCodeMeta satisfies Record<FndCode,…>` (`src/formal/codes.ts:152`). 16 non-test files reference `FndCode*`/`FND_` — the findings vocabulary the whole lint/formal/structural pipeline emits.

| Change | What breaks | Guard that catches it |
|---|---|---|
| Remove or rename a shipped code | An agent already switching on it breaks | Append-only snapshot — the frozen prefix must equal `<Codes>.slice(0, N)`: `src/core/__tests__/codes.test.ts:42-49`, `src/lint/__tests__/codes.test.ts:45-47`, `src/formal/__tests__/codes.test.ts:101-103` |
| Reorder codes | Same as removal — prefix equality fails | Same snapshot tests (reorders are explicitly disallowed) |
| Add a code to the enum but not the `*CodeMeta` corpus | The `satisfies Record<Code,…>` bound fails to type-check (`src/core/codes.ts:194`, `src/lint/codes.ts:147`, `src/formal/codes.ts:152`) | `tsc --noEmit`; plus tests asserting `Object.keys(meta).sort() === [...Codes].sort()` (`src/core/__tests__/codes.test.ts:63`) |
| Edit a code's `.describe()` text (`src/core/codes.ts:96-193`) | The manifest code table and `AGENTS.md` change byte-for-byte — intended single-source propagation (`src/cli/manifest.ts:18-27`) | Manifest code-table tests (`src/cli/__tests__/manifest.test.ts:103-111`); `AGENTS.md` drift gate (`package.json:49`) |
| Add an FND code with no emitter | Dead vocabulary | Reachability test — unreachable FND codes must be empty (`src/formal/__tests__/codes.test.ts:212`) |

Add-a-code is safe by design: append to the END of the enum (`src/core/codes.ts:28-29`, `:74-80`), add its `.describe()`, and both the manifest and `AGENTS.md` pick it up automatically with zero hand-transcription.
