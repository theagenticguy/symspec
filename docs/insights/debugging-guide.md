# symspec · Debugging guide

When something breaks, symspec never lets it escape as a stack trace. Every failure the tool cannot recover from surfaces as a typed **error envelope** — `{apiVersion, type:'error', error, code, suggestions, partial?}` — carrying a stable `ERR_*` code and an actionable suggestion (`src/cli/errors.ts:1`). This guide maps each code to its trigger, the first source file to open, and the fix.

Two facts orient every investigation:

- The `ERR_*` code namespace is closed and append-only, single-sourced from `src/core/codes.ts:48` (the enum) and `src/core/codes.ts:95` (the per-code `.describe()` corpus the `manifest` command reads).
- The process exit code disambiguates *what kind* of failure you have: `0` clean (`EXIT_CLEAN`, `src/cli/exit.ts:73`), `1` a completed run with an `error`-severity finding (`EXIT_FINDINGS_FAILURE`, `:80`), `2` an `ERR_*` operational failure (`EXIT_OPERATIONAL_ERROR`, `:86`), and — only under `--strict`/`--fail-on-unmatched` — `3` an INCONCLUSIVE run that could not be verified (`EXIT_INCONCLUSIVE`, `:97`). Precedence: an error-severity finding (exit 1) OUTRANKS a failed strict gate (exit 3), so a proven defect always wins (`src/cli/exit.ts:198-199`). If you got exit `1`, the tool worked and the *spec* failed — look at `FND_*` findings, not this guide's `ERR_*` table. Exit `3` means the tool refused to certify: read `data.verified` and `data.coverage.demotions` (below).

## Failure-mode index

| Code | Trigger | First file to open | Fix |
|---|---|---|---|
| `ERR_USAGE` | Invalid/missing CLI arguments; any Commander parse error (translated, never a bare usage dump). Issue-#2: usage errors now name the offending arg plus `--file`/`SYMSPEC_DOC` | `src/cli/errors.ts:84` (`usageError`); lifting fallback `src/cli/errors.ts:188` | Consult the command usage string echoed in `suggestions` (`src/core/codes.ts:96`). |
| `ERR_DOC_NOT_FOUND` | The resolved doc path (positional → `SYMSPEC_DOC` → default) names no existing file | `src/cli/resolve-doc.ts:164` (`resolveDoc`), error class `src/cli/resolve-doc.ts:122` | `symspec init <file>`, or point `SYMSPEC_DOC` at an existing file (`src/cli/resolve-doc.ts:132`). |
| `ERR_DOC_PARSE` | Bytes are not valid JSON, OR parse but fail `RequirementsDocSchema` | `src/core/load.ts:61` (`parseRequirementsDoc`) | Fix the offending JSON field, or re-create from source: `symspec init` then `symspec parse`/`add` (`src/core/load.ts:67`, `src/core/load.ts:75`). |
| `ERR_SCHEMA_VERSION` | Well-formed v2-shaped doc whose `schemaVersion` ≠ current `SCHEMA_VERSION` | `src/core/load.ts:88` | Re-create at the current schema; do not migrate in place (`src/core/load.ts:89`). |
| `ERR_IO` | Atomic write to the doc failed (permissions / disk); original left intact | `src/core/storage.ts:42` (`IoError`); emit sites `src/cli/index.ts:269`, `:952`, `:1289` | Check filesystem permissions and free space (`src/core/storage.ts:48`). |
| `ERR_DOC_EXISTS` | `init` refused to clobber an existing doc without `--force` | `src/cli/index.ts:176` | Pass `--force` to overwrite, or choose a different path (`src/cli/index.ts:181`). |
| `ERR_DUPLICATE_ID` | `add` supplied a UUID that already exists | `src/core/codes.ts:119` (catalog); core mutation layer | Use `symspec update`, or omit `--id` to auto-mint. |
| `ERR_NOT_FOUND` | Referenced requirement id/key not present (show/update/delete/edge-source) | `src/cli/errors.ts:101` (`notFoundError`), guard `src/cli/errors.ts:162` | List ids/keys with `symspec list` (`src/cli/errors.ts:105`). |
| `ERR_INVALID_RELATION` | Edge relation not in `RELATIONS` | `src/cli/errors.ts:110` (`invalidRelationError`), guard `src/cli/errors.ts:136` | Use one of `derives`/`satisfies`/`verifies`/`refines` (`src/cli/errors.ts:114`). |
| `ERR_INVALID_ATTR` | `update` attr not in `UPDATABLE_ATTRS` | `src/cli/errors.ts:119` (`invalidAttrError`), guard `src/cli/errors.ts:147` | Use an updatable attr (list in manifest) (`src/cli/errors.ts:123`). |
| `ERR_NULL_REQUIRED` | `--clear`/null applied to a required attribute | `src/core/codes.ts:139` (catalog); core mutation layer | Provide a value; only `preCondition`/`trigger`/`verificationMethod` are clearable. |
| `ERR_PARSE_NO_MODAL` | Tier-3 NL parse: no `shall`/modal main clause | `src/core/codes.ts:144` (catalog); Tier-3 parse ladder (AC-2-7) | Prepend `the <system> shall …`; apply the mechanical rewrite. |
| `ERR_PARSE_AMBIGUOUS_CLAUSES` | Clause boundaries unresolved after Tier 2 | `src/core/codes.ts:149` | Reorder to EARS clause order; see recovered partial slots in `partial`. |
| `ERR_PARSE_COMPOUND` | Compound requirement (top-level and/or) detected | `src/core/codes.ts:154` | Split at `and`/`or` into separate requirements. |
| `ERR_PARSE_NOT_A_REQUIREMENT` | Prose with no obligation | `src/core/codes.ts:159` | Rewrite as `<system> shall …`, or skip it. |
| `ERR_SOLVER_MISSING` | `--solver` cross-check requested but no z3/cvc5 binary resolved via `--solver-path` → `SYMSPEC_Z3` → PATH | `src/formal/binary-backend.ts:151` (`discoverSolverBinary`), error `src/formal/binary-backend.ts:67` | `mise use github:Z3Prover/z3@z3-4.16.0` (`src/formal/binary-backend.ts:83`). Not needed for default `check` — that tier is in-process WASM Z3. |
| `ERR_SOLVER_TIMEOUT` | **Whole-run** `--solver-budget-ms` wall-clock budget exhausted before all groups checked (never a single group) | `src/formal/needs-review.ts:218` (`findNeedsReview`), error `src/formal/needs-review.ts:78` | Raise `--solver-budget-ms` (`src/formal/needs-review.ts:93`). |
| `ERR_SOLVER_INCONCLUSIVE` | Whole-run solver-init failure / solver unusable (never a per-group `unknown` — that is `FND_NEEDS_REVIEW`) | `src/core/codes.ts:174` (catalog); solver-init path | Verify the solver backend and raise the timeout. |
| `ERR_LEAN_TOOLCHAIN_MISSING` | `certify` requested but no `lean` discoverable on PATH (or `lean --version` non-zero) | `src/certify/discover.ts:72` (`discoverLeanToolchain`), error `src/certify/discover.ts:35` | `elan default stable` (`src/certify/discover.ts:58`). Never blocks a prior SMT result. |
| `ERR_EMBED_MODEL_MISSING` | `check --semantic` and the embedding model is not cached AND remote loading disabled | `src/formal/embed.ts:240` (`loadEmbedder`), error `src/formal/embed.ts:46`; asset layer `src/formal/model-cache.ts:177` | `symspec download-model`, or set `SYMSPEC_EMBED_ALLOW_REMOTE=1` once (`src/formal/embed.ts:56`). Never blocks the SMT/lint tiers. |

## v3-tier failure modes (numeric / ambiguity / temporal / graph)

The v3 tiers add capability but almost no new `ERR_*` surface — the deterministic ones (numeric, ambiguity, temporal) fail closed into `FND_*` findings or silence, and only the embedding-backed tiers reuse `ERR_EMBED_MODEL_MISSING`. The traps are semantic, not operational:

- **Embedding model missing / sha mismatch → `ERR_EMBED_MODEL_MISSING`.** Both the `--semantic` paraphrase pass and the always-on-when-`--semantic` similarity graph load the pinned `Xenova/bge-base-en-v1.5` (~110 MB, ONNX-WASM). A cache miss with remote disabled, a network failure, OR a **sha256 digest mismatch** on any of the three assets all surface the same code (`ModelAssetsUnavailableError` wrapped by `EmbedModelMissingError`) — `src/formal/model-cache.ts:139`, `src/formal/embed.ts:46`. Pre-warm with `symspec download-model`, which always allows remote and reports cached-vs-fetched per asset (`src/formal/model-cache.ts:218`). A digest mismatch is the tell that a partial/corrupt download landed in the cache dir — re-run `download-model` to atomically re-fetch (`src/formal/model-cache.ts:164`). Never blocks the structural/lint/SMT/numeric tiers.
- **Solver budget exceeded → `ERR_SOLVER_TIMEOUT`.** The whole-run `--solver-budget-ms` is a wall-clock budget over ALL solver groups; exhausting it aborts (`src/formal/needs-review.ts:78`). A single group's `unknown`/timeout is NOT this — it is an info `FND_NEEDS_REVIEW` and the run continues. Raise `--solver-budget-ms`, or raise the per-group `--timeout-ms` (default 2000) if individual groups are the bottleneck (`src/cli/index.ts:294`).
- **Temporal bound too small — sat-at-k is not a certificate.** The `--temporal` tier is **sound-for-UNSAT, not complete-for-SAT**: it emits `FND_TEMPORAL_CONTRADICTION` only on `unsat`, and a `sat`/`unknown` at bound `k` yields NO finding and is NOT read as "temporally consistent" (`src/formal/temporal.ts:118`, `src/formal/temporal.ts:13`). If a temporal conflict you expect is not reported, the likely cause is that it first manifests past the horizon — raise `--temporal-bound` (default 10) and re-run. There is no error here; the risk is a false sense of safety from exit 0. The emitted evidence always carries `{ bound: k, complete: false }` as the explicit disclaimer (`src/formal/temporal.ts:143`).
- **Numeric conflict silently escaped.** The numeric tier fails closed — an unrecognized comparator/unit yields `[]` predicates, never a fabricated constraint (`src/formal/numeric.ts:240`). A conflict you expected but did not get usually means the two bounds landed on different quantity keys (a phrasing/unit variant the label extractor split) or an unknown unit stayed unitless. Check that both requirements name the quantity the same way under the same system; per-system scoping means two systems' "latency" never conflict (`src/formal/numeric.ts:160`). If the two bounds are the SAME quantity under two verbs, `check` now surfaces the split as `FND_QUANTITY_ALIAS_CANDIDATE` and demotes `verified` rather than passing silently — commit the suggested `glossary add` to make it provable (see the demotion path above). The key deliberately does NOT strip comparator words to force a match — that once fabricated a false verdict (`src/formal/numeric.ts:211`).
- **External solver discovery failing → `ERR_SOLVER_MISSING`.** Only when `--solver z3-bin|cvc5` (or `--solver-path`) is passed. Discovery order is `--solver-path` → `SYMSPEC_Z3` → PATH; the first *supplied* source wins, so a bad explicit `--solver-path` fails rather than falling through (`src/formal/binary-backend.ts:151`). The default `check` needs none of this — it is in-process WASM Z3. Query `symspec manifest`'s `backends` block before invoking (`src/cli/backends.ts:108`).

## "verified:false" with no error finding — the demotion path (issue #2)

The most common issue-#2 confusion: `check` exits `0` (or `3` under `--strict`) with zero `error`-severity findings, yet `data.verified` is `false`. This is not a bug — it is the tool refusing to certify. `verified = demotions.length === 0` (`src/pipeline/check.ts:1289`), so the answer is always in `data.coverage.demotions[]`: each entry names a `reason`, the `requirementIds` it covers, and an `action` — the exact command (or rewrite) that discharges it. Applying the actions and re-running converges toward `verified: true` (the agent loop). The three new info-severity findings that drive demotions:

- **`FND_EXCLUDED_FROM_FORMAL`** (reason `excluded-from-formal`). A requirement was dropped from the solver by an error-severity lint/parse finding, so the solver never saw it — `src/pipeline/check.ts:1024`. Discharge by fixing the blocking lint (rephrase), OR by waiving the *blocking* finding — the waiver-aware gate re-admits the requirement (`src/pipeline/gate.ts:120`). Waiving `FND_EXCLUDED_FROM_FORMAL` itself does NOT restore coverage; the demotion is keyed off the gate's structural `excluded` set, not the finding (`src/pipeline/check.ts:1219`).
- **`FND_QUANTITY_ALIAS_CANDIDATE`** (reason `quantity-alias-candidate`). Two same-system+same-trigger opposed numeric bounds landed on different quantity keys because two verbs split one quantity ("complete the infusion within ≤30 min" vs "run the infusion for ≥60 min") — `src/formal/quantity-alias.ts:4`. The finding message carries the exact `symspec glossary add "<a>" "<b>"`; commit it and the numeric tier proves the real `FND_NUMERIC_CONTRADICTION`. If the quantities are genuinely different, waive it.
- **`FND_RELATIONAL_UNCHECKED`** (reason `relational-reasoning-not-attempted`). A shared trigger carries the aggregate/conservation or cross-entity relational SHAPE the pairwise numeric tier does not attempt (reproducer b: odd-cycle 2-coloring) — `src/formal/relational.ts:4`. There is no proof path; discharge by hand-verifying and waiving, or restating as a same-quantity bound. This is a documented limit, not a solver bug.

Other demotion reasons predate issue #2: `uncovered-requirement` (a requirement whose atoms are all singletons — nothing cross-compared it), `open-opposition-candidate` (an untriaged `FND_OPPOSITION_CANDIDATE`), `no-decide-tier-comparison` (nothing compared at all), `semantic-tier-skipped` (`--semantic` off over a ≥2-requirement doc, so the opposition detector did not run) — `src/pipeline/check.ts:252`. Each carries its own `action`.

## Reading just the field you need — `--field`

To pull one value out of the envelope without a JSON tool, use `--field <dotted,paths>`: `symspec check --field data.verified,data.coverage.demotions` projects the envelope down to a nested object mirroring the requested paths (`src/cli/field.ts:1`, wired at `src/cli/index.ts:145`). It is an OUTPUT projection only — never changes data, exit code, or the typed contract; numeric segments index arrays (`data.findings.0.code`); an unresolved path is OMITTED rather than emitted as `null`; no match yields `{}`, never an error. Composes with `--dense`, ignores `--pretty`.

## Error surfaces

symspec errors originate in one of two shapes and converge on a single envelope builder.

**Thrown coded errors from the core/formal/certify layers.** Each producing module defines a small `Error` subclass carrying the `{code, suggestions}` shape the envelope reads directly, so the CLI never re-derives the trigger logic:

- `DocLoadError` (`ERR_DOC_PARSE` / `ERR_SCHEMA_VERSION`) — `src/core/load.ts:42`.
- `DocResolveError` (`ERR_DOC_NOT_FOUND`) — `src/cli/resolve-doc.ts:122`.
- `IoError` (`ERR_IO`) — `src/core/storage.ts:42`.
- `BinaryBackendError` (`ERR_SOLVER_MISSING`) — `src/formal/binary-backend.ts:67`.
- `SolverBudgetExceededError` (`ERR_SOLVER_TIMEOUT`) — `src/formal/needs-review.ts:78`.
- `LeanDiscoveryError` (`ERR_LEAN_TOOLCHAIN_MISSING`) — `src/certify/discover.ts:35`.
- `EmbedModelMissingError` (`ERR_EMBED_MODEL_MISSING`) — `src/formal/embed.ts:46`, wrapping `ModelAssetsUnavailableError` (`src/formal/model-cache.ts:88`).

These become envelopes through `toErrorEnvelope` (`src/cli/errors.ts:188`): a value carrying a valid `ERR_*` code (structural check `isCodedError` at `src/cli/errors.ts:172`) keeps its own code, message, and suggestions; anything else falls back to a caller-supplied default code (e.g. `loadResolved` uses `ERR_DOC_NOT_FOUND` then `ERR_DOC_PARSE` — `src/cli/index.ts:114`, `src/cli/index.ts:120`). This is the "never an unhandled stack trace" guarantee (AC-6-10).

**Argument errors built directly at the CLI surface.** Malformed arguments do not throw; they return a discriminated `ArgResult` (`src/cli/errors.ts:65`) whose failure arm carries a ready-to-emit envelope. Builders `usageError` / `notFoundError` / `invalidRelationError` / `invalidAttrError` (`src/cli/errors.ts:84`–`src/cli/errors.ts:125`) and guards `parseRelation` / `parseAttr` / `requireRequirement` (`src/cli/errors.ts:136`–`src/cli/errors.ts:162`) bake in the Appendix-A suggestion so no command re-invents it. `init`'s `ERR_DOC_EXISTS` is built inline as a `failure(...)` (`src/cli/index.ts:177`).

**Rendering and exit.** Every envelope — success or error — is written to stdout, then `emit` computes the exit code from envelope semantics alone (`src/cli/index.ts:91`). Output flags never change the exit code (`src/cli/exit.ts:36`). Default output is pretty JSON (`src/cli/output.ts:91`); `--json` is a byte-identical no-op alias (`src/cli/output.ts:75`); `--pretty`/`--human` render prose (`src/cli/output.ts:119`), where an error shows as `Error [CODE]: message` plus suggestions and any recovered `partial` (`src/cli/output.ts:132`). `--dense` minifies the same envelope, omits default/null keys, and elides `evidence` unless `--evidence` is passed (`src/cli/dense.ts:364`, reductions documented at `src/cli/dense.ts:1`) — the typed schema is unchanged, so dense output parses like normal output.

## First checks

An ordered ladder — resolve failures top-down; each rung is a precondition for the next.

1. **Read the code, not the prose.** Parse stdout as an envelope and switch on `type`. If `type:'error'`, the `code` field names the failure exactly — look it up in the Failure-mode index above. Exit `2` confirms an operational `ERR_*`; exit `1` means the tool succeeded and you have `error`-severity **findings** (`FND_*`, `src/formal/codes.ts:54`), not an `ERR_*` — a different investigation (`src/cli/exit.ts:149`).

2. **Does the document resolve and load?** `ERR_DOC_NOT_FOUND` → the path (positional → `SYMSPEC_DOC` → default) points at nothing; the envelope names the resolved path and which source chose it (`src/cli/resolve-doc.ts:128`). `ERR_DOC_PARSE` → the file exists but is malformed JSON or violates the schema (`src/core/load.ts:61`). `ERR_SCHEMA_VERSION` → it is a valid v2 doc at the wrong version; re-create rather than migrate (`src/core/load.ts:88`). These are disjoint by construction — the schema-version gate is only reachable once the parse gate passes (`src/core/load.ts:86`).

3. **Is the backend you need actually available? Query, don't guess.** Run `symspec manifest` and read the `backends` block *before* invoking a tier, so you decide up front instead of failing then learning (`src/cli/backends.ts:1`). It reports three backends via non-throwing probes (`src/cli/backends.ts:108`): `z3-wasm` (always available, powers default `check`), `binary` (optional external z3/cvc5 with resolved path/version/source), and `lean` (optional certify toolchain). A `false` here predicts the exact `ERR_SOLVER_MISSING` / `ERR_LEAN_TOOLCHAIN_MISSING` you would otherwise trip. The probes delegate to the same discovery code the real tiers use — `probeSolverBinary` (`src/formal/binary-backend.ts:188`) and `probeLeanToolchain` (`src/certify/discover.ts:114`).

4. **If you passed `--solver`: does a binary resolve?** Discovery order is `--solver-path` → `SYMSPEC_Z3` → PATH (`z3` then `cvc5`), first *supplied* source wins — a bad explicit `--solver-path` fails rather than silently falling through (`src/formal/binary-backend.ts:151`). Missing entirely → `ERR_SOLVER_MISSING` (`src/formal/binary-backend.ts:179`). Note the default `check` tier needs none of this; it runs in-process WASM Z3.

5. **If you passed `--certify`: is Lean installed?** `certify` probes `lean --version` and fails fast with `ERR_LEAN_TOOLCHAIN_MISSING` on ENOENT or a non-zero exit (`src/certify/discover.ts:72`). It fires only under `--certify` and never blocks a prior SMT result (`src/certify/discover.ts:16`).

6. **If you passed `--semantic`: is the model cached (or is remote allowed)?** The ~110 MB `bge-base-en-v1.5` model must be in the cache dir (`SYMSPEC_MODEL_DIR` → `XDG_CACHE_HOME` → `~/.cache`, `src/formal/model-cache.ts:102`) unless `SYMSPEC_EMBED_ALLOW_REMOTE=1`. Absent + offline → `ERR_EMBED_MODEL_MISSING` (`src/formal/embed.ts:240`). Pre-warm with `symspec download-model` (`src/formal/model-cache.ts:218`), which always allows remote and reports cached-vs-fetched per asset. Every asset is sha256-verified (`src/formal/model-cache.ts:156`); a digest mismatch surfaces the same code. The semantic tier is opt-in and never blocks the structural, lint, or SMT tiers.

7. **Solver came back inconclusive — is it fatal?** A *per-group* `unknown`/timeout is NOT an error; it is an info-severity `FND_NEEDS_REVIEW` finding and the run continues (`src/formal/needs-review.ts:250`). Only the *whole-run* `--solver-budget-ms` budget exhausting raises `ERR_SOLVER_TIMEOUT` and aborts (`src/formal/needs-review.ts:243`). A whole-run solver-init failure is `ERR_SOLVER_INCONCLUSIVE` (`src/core/codes.ts:174`). Do not read a `FND_NEEDS_REVIEW` as "no conflict."

8. **If you passed `--temporal` and expected a conflict you did not get:** the bound is the first suspect, not a bug. The tier reports only proven `unsat` contradictions; a conflict past bound `k` is invisible, and there is no error — exit is clean. Raise `--temporal-bound` (default 10) and re-run; treat a clean `--temporal` result as "no contradiction within k steps," per the `{bound, complete:false}` disclaimer, never as a consistency certificate (`src/formal/temporal.ts:13`).

9. **If none of the above:** the envelope's `code` fell back to a default (usually `ERR_USAGE` or `ERR_IO`) because the thrown value carried no recognized `ERR_*` code (`src/cli/errors.ts:188`). Read `error`, and if it is an `ERR_IO` write failure, check permissions and disk — the original document is left intact by the atomic-write discipline (`src/core/storage.ts:42`).

## See also

- [Module map](../architecture/module-map.md) — 20 shared source citations
- [Processes](../behavior/processes.md) — 11 shared source citations
- [Public API](../reference/public-api.md) — 11 shared source citations
- [Contract map](contract-map.md) — 9 shared source citations
- [System overview](../architecture/system-overview.md) — 8 shared source citations
