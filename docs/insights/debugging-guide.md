# symspec · Debugging guide

When something breaks, symspec never lets it escape as a stack trace. Every failure the tool cannot recover from surfaces as a typed **error envelope** — `{apiVersion, type:'error', error, code, suggestions, partial?}` — carrying a stable `ERR_*` code and an actionable suggestion (`src/cli/errors.ts:1`). This guide maps each code to its trigger, the first source file to open, and the fix.

Two facts orient every investigation:

- The `ERR_*` code namespace is closed and append-only, single-sourced from `src/core/codes.ts:48` (the enum) and `src/core/codes.ts:95` (the per-code `.describe()` corpus the `manifest` command reads).
- The process exit code disambiguates *what kind* of failure you have: `0` clean, `1` a completed run with an `error`-severity finding, `2` an `ERR_*` operational failure (`src/cli/exit.ts:61`, `src/cli/exit.ts:68`, `src/cli/exit.ts:74`). An `ERR_*` envelope always maps to exit `2` (`src/cli/exit.ts:149`). If you got exit `1`, the tool worked and the *spec* failed — look at `FND_*` findings, not this guide's `ERR_*` table.

## Failure-mode index

| Code | Trigger | First file to open | Fix |
|---|---|---|---|
| `ERR_USAGE` | Invalid/missing CLI arguments; any Commander parse error (translated, never a bare usage dump) | `src/cli/errors.ts:83` (`usageError`); lifting fallback `src/cli/errors.ts:184` | Consult the command usage string echoed in `suggestions` (`src/core/codes.ts:96`). |
| `ERR_DOC_NOT_FOUND` | The resolved doc path (positional → `SYMSPEC_DOC` → default) names no existing file | `src/cli/resolve-doc.ts:164` (`resolveDoc`), error class `src/cli/resolve-doc.ts:122` | `symspec init <file>`, or point `SYMSPEC_DOC` at an existing file (`src/cli/resolve-doc.ts:138`). |
| `ERR_DOC_PARSE` | Bytes are not valid JSON, OR parse but fail `RequirementsDocSchema` | `src/core/load.ts:61` (`parseRequirementsDoc`) | Fix the offending JSON field, or re-create from source: `symspec init` then `symspec parse`/`add` (`src/core/load.ts:67`, `src/core/load.ts:75`). |
| `ERR_SCHEMA_VERSION` | Well-formed v2-shaped doc whose `schemaVersion` ≠ current `SCHEMA_VERSION` | `src/core/load.ts:88` | Re-create at the current schema; do not migrate in place (`src/core/load.ts:89`). |
| `ERR_IO` | Atomic write to the doc failed (permissions / disk); original left intact | `src/core/storage.ts:42` (`IoError`); emit sites `src/cli/index.ts:192`, `src/cli/index.ts:833` | Check filesystem permissions and free space (`src/core/storage.ts:48`). |
| `ERR_DOC_EXISTS` | `init` refused to clobber an existing doc without `--force` | `src/cli/index.ts:176` | Pass `--force` to overwrite, or choose a different path (`src/cli/index.ts:181`). |
| `ERR_DUPLICATE_ID` | `add` supplied a UUID that already exists | `src/core/codes.ts:119` (catalog); core mutation layer | Use `symspec update`, or omit `--id` to auto-mint. |
| `ERR_NOT_FOUND` | Referenced requirement id not present (show/update/delete/edge-source) | `src/cli/errors.ts:99` (`notFoundError`), guard `src/cli/errors.ts:158` | List ids with `symspec list` (`src/cli/errors.ts:103`). |
| `ERR_INVALID_RELATION` | Edge relation not in `RELATIONS` | `src/cli/errors.ts:108` (`invalidRelationError`), guard `src/cli/errors.ts:134` | Use one of `derives`/`satisfies`/`verifies`/`refines` (`src/cli/errors.ts:112`). |
| `ERR_INVALID_ATTR` | `update` attr not in `UPDATABLE_ATTRS` | `src/cli/errors.ts:117` (`invalidAttrError`), guard `src/cli/errors.ts:145` | Use an updatable attr (list in manifest) (`src/cli/errors.ts:121`). |
| `ERR_NULL_REQUIRED` | `--clear`/null applied to a required attribute | `src/core/codes.ts:139` (catalog); core mutation layer | Provide a value; only `preCondition`/`trigger`/`verificationMethod` are clearable. |
| `ERR_PARSE_NO_MODAL` | Tier-3 NL parse: no `shall`/modal main clause | `src/core/codes.ts:144` (catalog); Tier-3 parse ladder (AC-2-7) | Prepend `the <system> shall …`; apply the mechanical rewrite. |
| `ERR_PARSE_AMBIGUOUS_CLAUSES` | Clause boundaries unresolved after Tier 2 | `src/core/codes.ts:149` | Reorder to EARS clause order; see recovered partial slots in `partial`. |
| `ERR_PARSE_COMPOUND` | Compound requirement (top-level and/or) detected | `src/core/codes.ts:154` | Split at `and`/`or` into separate requirements. |
| `ERR_PARSE_NOT_A_REQUIREMENT` | Prose with no obligation | `src/core/codes.ts:159` | Rewrite as `<system> shall …`, or skip it. |
| `ERR_SOLVER_MISSING` | `--solver` cross-check requested but no z3/cvc5 binary resolved via `--solver-path` → `SYMSPEC_Z3` → PATH | `src/formal/binary-backend.ts:151` (`discoverSolverBinary`), error `src/formal/binary-backend.ts:67` | `mise use github:Z3Prover/z3@z3-4.16.0` (`src/formal/binary-backend.ts:83`). Not needed for default `check` — that tier is in-process WASM Z3. |
| `ERR_SOLVER_TIMEOUT` | **Whole-run** `--solver-budget-ms` wall-clock budget exhausted before all groups checked (never a single group) | `src/formal/needs-review.ts:218` (`findNeedsReview`), error `src/formal/needs-review.ts:78` | Raise `--solver-budget-ms` (`src/formal/needs-review.ts:93`). |
| `ERR_SOLVER_INCONCLUSIVE` | Whole-run solver-init failure / solver unusable (never a per-group `unknown` — that is `FND_NEEDS_REVIEW`) | `src/core/codes.ts:174` (catalog); solver-init path | Verify the solver backend and raise the timeout. |
| `ERR_LEAN_TOOLCHAIN_MISSING` | `certify` requested but no `lean` discoverable on PATH (or `lean --version` non-zero) | `src/certify/discover.ts:72` (`discoverLeanToolchain`), error `src/certify/discover.ts:35` | `elan default stable` (`src/certify/discover.ts:58`). Never blocks a prior SMT result. |
| `ERR_EMBED_MODEL_MISSING` | `check --semantic` and the embedding model is not cached AND remote loading disabled | `src/formal/embed.ts:205` (`loadEmbedder`), error `src/formal/embed.ts:46`; asset layer `src/formal/model-cache.ts:177` | `symspec download-model`, or set `SYMSPEC_EMBED_ALLOW_REMOTE=1` once (`src/formal/embed.ts:55`). Never blocks the SMT/lint tiers. |

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

These become envelopes through `toErrorEnvelope` (`src/cli/errors.ts:184`): a value carrying a valid `ERR_*` code (structural check at `src/cli/errors.ts:168`) keeps its own code, message, and suggestions; anything else falls back to a caller-supplied default code (e.g. `loadResolved` uses `ERR_DOC_NOT_FOUND` then `ERR_DOC_PARSE` — `src/cli/index.ts:114`, `src/cli/index.ts:120`). This is the "never an unhandled stack trace" guarantee (AC-6-10).

**Argument errors built directly at the CLI surface.** Malformed arguments do not throw; they return a discriminated `ArgResult` (`src/cli/errors.ts:64`) whose failure arm carries a ready-to-emit envelope. Builders `usageError` / `notFoundError` / `invalidRelationError` / `invalidAttrError` (`src/cli/errors.ts:83`–`src/cli/errors.ts:123`) and guards `parseRelation` / `parseAttr` / `requireRequirement` (`src/cli/errors.ts:134`–`src/cli/errors.ts:158`) bake in the Appendix-A suggestion so no command re-invents it. `init`'s `ERR_DOC_EXISTS` is built inline as a `failure(...)` (`src/cli/index.ts:177`).

**Rendering and exit.** Every envelope — success or error — is written to stdout, then `emit` computes the exit code from envelope semantics alone (`src/cli/index.ts:91`). Output flags never change the exit code (`src/cli/exit.ts:36`). Default output is pretty JSON (`src/cli/output.ts:91`); `--json` is a byte-identical no-op alias (`src/cli/output.ts:75`); `--pretty`/`--human` render prose (`src/cli/output.ts:119`), where an error shows as `Error [CODE]: message` plus suggestions and any recovered `partial` (`src/cli/output.ts:132`). `--dense` minifies the same envelope, omits default/null keys, and elides `evidence` unless `--evidence` is passed (`src/cli/dense.ts:364`, reductions documented at `src/cli/dense.ts:1`) — the typed schema is unchanged, so dense output parses like normal output.

## First checks

An ordered ladder — resolve failures top-down; each rung is a precondition for the next.

1. **Read the code, not the prose.** Parse stdout as an envelope and switch on `type`. If `type:'error'`, the `code` field names the failure exactly — look it up in the Failure-mode index above. Exit `2` confirms an operational `ERR_*`; exit `1` means the tool succeeded and you have `error`-severity **findings** (`FND_*`, `src/formal/codes.ts:54`), not an `ERR_*` — a different investigation (`src/cli/exit.ts:149`).

2. **Does the document resolve and load?** `ERR_DOC_NOT_FOUND` → the path (positional → `SYMSPEC_DOC` → default) points at nothing; the envelope names the resolved path and which source chose it (`src/cli/resolve-doc.ts:130`). `ERR_DOC_PARSE` → the file exists but is malformed JSON or violates the schema (`src/core/load.ts:61`). `ERR_SCHEMA_VERSION` → it is a valid v2 doc at the wrong version; re-create rather than migrate (`src/core/load.ts:88`). These are disjoint by construction — the schema-version gate is only reachable once the parse gate passes (`src/core/load.ts:86`).

3. **Is the backend you need actually available? Query, don't guess.** Run `symspec manifest` and read the `backends` block *before* invoking a tier, so you decide up front instead of failing then learning (`src/cli/backends.ts:1`). It reports three backends via non-throwing probes (`src/cli/backends.ts:108`): `z3-wasm` (always available, powers default `check`), `binary` (optional external z3/cvc5 with resolved path/version/source), and `lean` (optional certify toolchain). A `false` here predicts the exact `ERR_SOLVER_MISSING` / `ERR_LEAN_TOOLCHAIN_MISSING` you would otherwise trip. The probes delegate to the same discovery code the real tiers use — `probeSolverBinary` (`src/formal/binary-backend.ts:188`) and `probeLeanToolchain` (`src/certify/discover.ts:114`).

4. **If you passed `--solver`: does a binary resolve?** Discovery order is `--solver-path` → `SYMSPEC_Z3` → PATH (`z3` then `cvc5`), first *supplied* source wins — a bad explicit `--solver-path` fails rather than silently falling through (`src/formal/binary-backend.ts:151`). Missing entirely → `ERR_SOLVER_MISSING` (`src/formal/binary-backend.ts:179`). Note the default `check` tier needs none of this; it runs in-process WASM Z3.

5. **If you passed `--certify`: is Lean installed?** `certify` probes `lean --version` and fails fast with `ERR_LEAN_TOOLCHAIN_MISSING` on ENOENT or a non-zero exit (`src/certify/discover.ts:72`). It fires only under `--certify` and never blocks a prior SMT result (`src/certify/discover.ts:16`).

6. **If you passed `--semantic`: is the model cached (or is remote allowed)?** The ~110 MB `bge-base-en-v1.5` model must be in the cache dir (`SYMSPEC_MODEL_DIR` → `XDG_CACHE_HOME` → `~/.cache`, `src/formal/model-cache.ts:101`) unless `SYMSPEC_EMBED_ALLOW_REMOTE=1`. Absent + offline → `ERR_EMBED_MODEL_MISSING` (`src/formal/embed.ts:205`). Pre-warm with `symspec download-model` (`src/formal/model-cache.ts:218`), which always allows remote and reports cached-vs-fetched per asset. Every asset is sha256-verified (`src/formal/model-cache.ts:155`); a digest mismatch surfaces the same code. The semantic tier is opt-in and never blocks the structural, lint, or SMT tiers.

7. **Solver came back inconclusive — is it fatal?** A *per-group* `unknown`/timeout is NOT an error; it is an info-severity `FND_NEEDS_REVIEW` finding and the run continues (`src/formal/needs-review.ts:241`). Only the *whole-run* `--solver-budget-ms` budget exhausting raises `ERR_SOLVER_TIMEOUT` and aborts (`src/formal/needs-review.ts:242`). A whole-run solver-init failure is `ERR_SOLVER_INCONCLUSIVE` (`src/core/codes.ts:174`). Do not read a `FND_NEEDS_REVIEW` as "no conflict."

8. **If none of the above:** the envelope's `code` fell back to a default (usually `ERR_USAGE` or `ERR_IO`) because the thrown value carried no recognized `ERR_*` code (`src/cli/errors.ts:184`). Read `error`, and if it is an `ERR_IO` write failure, check permissions and disk — the original document is left intact by the atomic-write discipline (`src/core/storage.ts:42`).


## See also

- [symspec · Module map](../architecture/module-map.md) — 16 shared source citations
- [symspec · Public API](../reference/public-api.md) — 5 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 4 shared source citations
- [symspec · Tech debt](tech-debt.md) — 4 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 3 shared source citations
