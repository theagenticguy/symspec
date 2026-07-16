# symspec · CLI reference

`symspec` is an EARS requirements linter built for coding agents to drive, not humans to read (`src/cli/index.ts:204-207`). It is the thin formatter over the library API: every command resolves the document path, loads and validates it, runs a pure command core, saves on mutation, and wraps the result in a typed envelope before rendering and exiting (`src/cli/index.ts:1-13`).

Three properties make the surface agent-legible:

- **A self-describing `manifest`.** Fetch it once to learn the entire command inventory, per-command argument schemas, the stable code catalogs, the envelope `type` set, the unit tables, and live backend availability — no prose scraping (`src/cli/index.ts:233-239`).
- **Typed envelopes are the zero-flag default.** Every result is `{apiVersion, type, data}` on success or `{apiVersion, type:'error', error, code, suggestions, partial?}` on failure. Both carry `apiVersion` (currently `1`) and a `type` discriminant an agent switches on. The default output is JSON; `--pretty`/`--human` opt into prose (`src/cli/index.ts:138-162`).
- **Stable codes and deterministic exit.** Errors carry a stable `ERR_*` code plus `suggestions`; `check` findings carry `GTWR_*`/`FND_*` codes. Bad arguments become an `ERR_USAGE` envelope rather than a commander stack trace (`src/cli/index.ts:219-230`, `src/cli/index.ts:1304-1333`).

The binary is `symspec`, a two-line ESM shim that imports the bundled `dist/cli.mjs` (`bin/symspec.mjs:1-2`). `--version` prints `package.json`'s version, single-sourced (`src/cli/index.ts:208`).

Document-path resolution precedence for every mutating/reading command: the positional `[file]` (or `--file <path>` on commands with a required positional, or `--doc <path>` on `apply`), then the `SYMSPEC_DOC` environment variable, then the `./requirements.json` default (`src/cli/resolve-doc.ts`, `src/cli/manifest.ts:137-148`). `init`, `manifest`, `parse`, `download-model`, and `install` do not resolve an existing document.

There are 20 commands (`src/cli/manifest.ts:310-449` `COMMAND_SPECS`). MCP is not one of them — the MCP surface was removed; the agent surface is the typed JSON envelope, the self-describing `manifest`, generated AGENTS.md, and the `install` command that drops a symspec skill into each detected agent host.

Bad arguments never surface as a commander stack trace: an unknown command, missing required arg, or unknown option becomes an `ERR_USAGE` envelope, and an arity error (too many / missing positional — usually a doc path passed positionally to a command that takes `--file`) names the offending argument and appends the doc-path remedy (`--file <path>` / `SYMSPEC_DOC` / the `./requirements.json` default) so the error is actionable (`src/cli/index.ts:89-90`, `src/cli/index.ts:1317-1332`).

## manifest

```
symspec manifest
```

No arguments (`src/cli/index.ts:233-239`). Read-only; touches no document. Returns the whole command surface as one blob: the command inventory with per-command argument JSON Schemas (20 commands), the `ERR_*`/`GTWR_*`/`FND_*` code catalogs (21 / 24 / 30 codes), the closed envelope `type` set, top-level `globalOptions`, the formal-tier `scope` disclosure, a `conventions.docPath` field stating the per-command doc-path rule, and a live `backends` availability report (z3-wasm, external z3/cvc5 binaries, Lean toolchain) via `buildManifestWithBackends()` so an agent can query-then-decide before invoking `certify` or `--solver` (`src/cli/manifest.ts:612-657`).

The manifest also exposes a `units` section: `units.numeric` is the numeric-conflict tier's normalization table, derived from the exported `DIMENSIONS` in `src/formal/numeric.ts` — each entry is `{ base, units }` mapping every recognized unit spelling to its multiplicative factor into the base. Two dimensions ship today: a `ms` base (`ms`/`s`/`min`/`h` families) and a `B` base (`b`/`kb`/`mb`/`gb`, plus binary `kib`/`mib`/`gib`). An agent authoring numeric bounds reads exactly which spellings the solver unifies before comparison, instead of guessing; an unrecognized unit stays unitless (a conservative miss) (`src/cli/manifest.ts:490-507`, `src/cli/manifest.ts:635-637`, `src/formal/numeric.ts:64`).

Envelope `type`: `manifest`.

## init

```
symspec init [file]
```

- `[file]` — path to the requirements document to create (`src/cli/index.ts:245`).
- `--force` — overwrite an existing document instead of refusing (`src/cli/index.ts:246`).

Creates an empty document at the resolved path, written atomically via `writeDocFile` (`src/cli/index.ts:267`). Non-destructive by default: refuses to clobber an existing file with an `ERR_DOC_EXISTS` failure unless `--force` is passed (`src/cli/index.ts:253-265`).

Envelope `type`: `init` (`{path, created}`) (`src/cli/index.ts:271`).

## add

```
symspec add [file] [--from-parse <prose> | --pattern <p> --system <s> --response <r> ...]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:278`).
- `--id <uuid>` — explicit requirement UUID (default: auto-minted) (`src/cli/index.ts:279`).
- `--key <slug>` — stable human key (e.g. `G1`, `AUTH-3`) usable in place of the UUID everywhere; a key already in use is an `ERR_DUPLICATE_KEY` (`src/cli/index.ts:280-283`).
- `--dry-run` — preview the rendered sentence + lint findings the create would trigger; write nothing (`src/cli/index.ts:284-287`).
- `--from-parse <prose>` — a single line of prose to parse into EARS slots; determines polarity itself, so `--negated` is ignored on this path (`src/cli/index.ts:288`, `src/cli/index.ts:1130-1139`).
- `--pattern <p>` — EARS pattern type: `ubiquitous|event-driven|state-driven|optional-feature|unwanted-behavior` (`src/cli/index.ts:290-292`).
- `--system <s>` — system name (the X in "the X shall ...") (`src/cli/index.ts:293`).
- `--response <r>` — system response (`src/cli/index.ts:294`).
- `--negated` — prohibition: render "shall not <response>" (keep `--response` positive) (`src/cli/index.ts:295`).
- `--trigger <t>` — trigger clause (event-driven / unwanted-behavior) (`src/cli/index.ts:296`).
- `--pre <p>` — pre-condition clause (state-driven / optional-feature) (`src/cli/index.ts:297`).
- `--priority <p>` — `low|medium|high|critical` (`src/cli/index.ts:298`).
- `--status <s>` — `draft|approved|implemented|verified` (`src/cli/index.ts:299`).
- `--verification <m>` — `test|inspection|analysis|demonstration` (`src/cli/index.ts:300`).
- `--verification-note <t>` — free-text verification-plan note (companion to `--verification`) (`src/cli/index.ts:301-304`).
- `--pattern-type`, `--system-name`, `--system-response`, `--pre-condition`, `--verification-method` — aliases matching the manifest field names, so a flag derived from `symspec manifest` works; the short flag wins when both are given (`src/cli/index.ts:307-311`, `src/cli/index.ts:1143-1148`).

Mints the UUID (unless `--id`), renders the canonical sentence, and applies defaults. Missing slots are surfaced by `check` rather than rejected. Not idempotent — each call creates a distinct requirement (`src/cli/descriptions.ts:70-78`).

Envelope `type`: `add`.

## update

```
symspec update <ref> <attr> [value] [--file <path>] [--clear]
symspec update <ref> attr=value [attr2=value2 ...] [--file <path>]
symspec update --all --where <attr>=<value> <setAttr> <setValue> [--file <path>]
```

- `<ref>` — the requirement to update — a stable key OR a UUID (omit only in `--all` bulk mode) (`src/cli/index.ts:333`).
- `[rest...]` — either `<attr> <value>`, one or more `attr=value` pairs, or in `--all` mode the `<setAttr> <setValue>` (`src/cli/index.ts:334-337`).
- `--file <path>` — document path override (`src/cli/index.ts:338`).
- `--clear` — clear (remove) an optional attribute instead of setting a value (`src/cli/index.ts:339`).
- `--all` — bulk mode: apply the set transition to every requirement matching `--where` (`src/cli/index.ts:340`).
- `--where <attr=value>` — bulk-mode filter: only requirements whose `<attr>` equals `<value>` (`src/cli/index.ts:341`).

Three surfaces on one command (`src/cli/index.ts:330-419`): single-attr `<attr> [value]` (or `<attr> --clear`), multi-attr `attr=value` pairs, and `--all --where` bulk transitions. A `<ref>` accepts a stable key or a UUID. Editing a structural EARS slot re-renders the canonical sentence; metadata edits do not. Clearing a required attribute errors; the literal string `"null"` is stored as text. Idempotent (`src/cli/descriptions.ts:80-88`).

Envelope `type`: `update`.

## parse

```
symspec parse [text] [--file <path>] [--stdin]
```

- `[text]` — a single requirement sentence to parse (one-element batch) (`src/cli/index.ts:425`).
- `--file <path>` — read requirement lines (one per line) from a file (`src/cli/index.ts:426`).
- `--stdin` — read requirement lines (one per line) from stdin (`src/cli/index.ts:427`).

Exactly one input source is required; supplying none is an `ERR_USAGE` failure (`src/cli/index.ts:1206-1219`). Each line runs the Tier-1 regex cascade, escalating to the Tier-2 wink-nlp parser and, on hard failure, a Tier-3 structured error carrying a stable `ERR_PARSE_*` code, recovered partial slots, and rewrite suggestions. A no-modal line is reported as skipped. Returns per-line results plus an `{ok, skipped, error}` summary via `parseBatch` (`src/cli/index.ts:437`). Read-only.

Envelope `type`: `parse`.

## check

```
symspec check [file] [--solver <backend>] [--temporal] [--strict] [--emit-smt2 <path>] ...
```

- `[file]` — path to the requirements document (`src/cli/index.ts:446`).
- `--similarity-threshold <n>` — pairwise lexical-similarity threshold, 0..1 (`src/cli/index.ts:447`).
- `--timeout-ms <n>` — per-group solver timeout in ms (default 2000) (`src/cli/index.ts:448`).
- `--solver-budget-ms <n>` — whole-run solver budget in ms; the `ERR_SOLVER_TIMEOUT` boundary (`src/cli/index.ts:449`).
- `--emit-smt2 <path>` — also write the portable SMT-LIB2 artifact for the included requirements (`src/cli/index.ts:450-453`, `src/cli/index.ts:608-614`).
- `--solver <backend>` — formal backend: `z3-wasm` (default, in-process WASM) | `z3-bin` | `cvc5` (external binary cross-check). An unknown value is an `ERR_USAGE`; a missing binary is `ERR_SOLVER_MISSING` surfaced before any check runs, carrying the backend's mise-install suggestion (`src/cli/index.ts:454-457`, `src/cli/index.ts:518-528`, `src/cli/index.ts:619-631`, `src/cli/index.ts:644-645`).
- `--solver-path <path>` — explicit path to an external z3/cvc5 binary (implies the binary backend) (`src/cli/index.ts:458`, `src/cli/index.ts:518-519`).
- `--semantic` — DEPRECATED no-op, retained so existing agent scripts don't break. The semantic tier is now CORE: every `check` loads the local BGE-ONNX model and runs the paraphrase pass (`FND_SIMILAR_SEMANTIC`), the embedding similarity graph (`FND_MISSING_TRACE_LINK`, `FND_DUPLICATE_CLUSTER`), and the opposition-candidate detector (`FND_OPPOSITION_CANDIDATE`). Those findings stay propose-only, but an untriaged opposition candidate DEMOTES `data.verified`, so skipping the tier would make `--strict` gameable by omission — hence it can no longer be skipped. A missing/unloadable model FAILS THE RUN CLOSED with `ERR_EMBED_MODEL_MISSING` (exit `2`) BEFORE any tier runs; pre-warm the sha256-pinned cache with `symspec download-model` for offline/air-gapped hosts (`src/cli/index.ts:459-462`, `src/cli/index.ts:532-553`).
- `--semantic-threshold <n>` — cosine threshold for the semantic paraphrase tier (default 0.72; tuned to favor recall against the model's real paraphrase cosine band — see `DEFAULT_SEMANTIC_THRESHOLD` in `src/formal/semantic.ts:110`) (`src/cli/index.ts:463-466`).
- `--temporal` — opt-in: bounded LTL→SMT temporal-ordering conflict detection (`FND_TEMPORAL_CONTRADICTION`). Pure Z3-WASM, no model. Sound-for-UNSAT: a conflict is reported only when no trace of length ≤ k satisfies the requirements jointly; a `sat` result at the bound is not a consistency certificate (`src/cli/index.ts:467-470`, `src/cli/index.ts:557-560`).
- `--temporal-bound <k>` — trace bound k for `--temporal` (default 10) (`src/cli/index.ts:471`).
- `--min-severity <sev>` — output filter: drop findings below `<sev>` (`error|warn|info`); never changes the exit code. A typo is a clean `ERR_USAGE` (`src/cli/index.ts:472-475`, `src/cli/index.ts:564-572`).
- `--findings-only` — output filter: return only `findings[]`, dropping the `excluded` table (`src/cli/index.ts:476-479`).
- `--strict` — opt-in coverage gate: fail with exit `3` when `data.verified` is `false` — any uncovered (vocabulary-disjoint) requirement, untriaged `FND_OPPOSITION_CANDIDATE`, or absent decide-tier comparison demotes it. `data.coverage.demotions[]` lists each reason with the exact discharging op (`antonym add` / `glossary add` / `waive` / rewrite), so the loop is: `check --strict` → apply the listed ops → re-check → exit `0`. The machine-readable form of "silence is not a consistency certificate"; off by default (`src/cli/index.ts:480-483`, `src/cli/index.ts:578`).
- `--fail-on-unmatched <n>` — opt-in coverage gate: fail with exit `3` when `residualRisk.unmatchedAtoms` exceeds `<n>` (atoms owned by exactly one requirement, never cross-compared). `0` fails on any unmatched atom. Independent of `--strict` — either gate tripping fails the run (`src/cli/index.ts:484-487`, `src/cli/index.ts:579-591`).

Wires all tiers into one pass: Tier-0 structural checks, INCOSE GtWR + free-tier lint rules, the always-on deterministic ambiguity family, the always-on semantic tier (above), and the in-process SMT formal tier (contradiction / subsumption / vacuity / completeness / similarity / needs-review over the gate-included subset, plus the numeric/arithmetic conflict tier over ALL requirements). The contradiction tier also computes a guard-implication closure: a bridge requirement that establishes a state ("while authenticated, be verified") links a rule guarded on `authenticated` to one guarded on `verified`, so a transitive conflict becomes provable with the bridge named in the core. Sound modulo atomization: every reported conflict is real, but silence is not a consistency certificate.

The issue-#2 adversarial hardening added three propose-only, `info`-severity coverage disclosures that all DEMOTE `data.verified` without ever asserting a conflict: `FND_EXCLUDED_FROM_FORMAL` (a requirement dropped from the solver by a blocking lint/parse finding — fixing the finding re-admits it; waiving alone does not restore coverage), `FND_QUANTITY_ALIAS_CANDIDATE` (two same-system/same-trigger numeric bounds on different quantity keys sharing a noun token — emits the exact `symspec glossary add "<a>" "<b>"` to route both to one quantity so the LIA solver can prove the conflict), and `FND_RELATIONAL_UNCHECKED` (a shared trigger carries numeric bounds plus singleton atoms — the aggregate/cross-quantity shape the pairwise numeric tier does not attempt).

The success payload carries a first-class `data.verified` boolean — hardened by the issue-#2 eval to require full participation, no untriaged opposition candidates, a real decide-tier comparison, and (with ≥2 requirements) that the semantic tier ran — plus a `residualRisk` summary and a `coverage` report whose `demotions[]` is the actionable work list, `waived` count, and may also carry `emittedSmt2` and `binaryCrossCheck`. Read-only. Exit `0` = no error finding (and, if a strict gate was requested, it passed), `1` = pass/fail gate failed on an error-severity finding, `2` = operational error, `3` = a requested strict coverage gate tripped on an otherwise error-free run (`src/cli/exit.ts:73-200`).

Envelope `type`: `check`.

## certify

```
symspec certify [file] [--out-dir <path>]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:659`).
- `--out-dir <path>` — directory for the retained `.lean` artifact on success (`src/cli/index.ts:660`).

Emits one batched core-Lean file (no Mathlib, no lake), runs it through `lean --json`, and maps the result to `FND_CERTIFIED` (with `#print axioms` provenance) or `FND_CERTIFY_FAILED`. Strictly opt-in; the default `check` never invokes Lean. A missing toolchain returns `ERR_LEAN_TOOLCHAIN_MISSING` and never affects any prior SMT result (`src/cli/index.ts:670-674`). Scope note (v2): each requirement is emitted as a placeholder `True` theorem, so the certificate attests only that the toolchain ran and the file elaborates — it does not yet encode requirement semantics (`src/cli/index.ts:686-692`, `src/cli/index.ts:1236-1249`).

Envelope `type`: `certify` (`{certified, findings}`) (`src/cli/index.ts:702`).

## list

```
symspec list [file]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:714`).

Lists every current requirement with its `id`, `patternType`, `priority`, `status`, and rendered `sentence` — enough to scan the spec without fetching every full node. Read-only and idempotent (`src/cli/index.ts:721-728`).

Envelope `type`: `list`.

## show

```
symspec show <id> [--file <path>]
```

- `<id>` — UUID (or stable key) of the requirement to show (`src/cli/index.ts:735`).
- `--file <path>` — document path override (`src/cli/index.ts:736`).

Prints the full record of one requirement (all slots, metadata, outbound edges). Errors when the id does not resolve. Read-only and idempotent (`src/cli/index.ts:737-745`).

Envelope `type`: `show`.

## derive

```
symspec derive <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (decomposes into the target) (`src/cli/index.ts:752`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:753`).
- `--file <path>` — document path override (`src/cli/index.ts:754`).

Adds a `derives` edge. The `derives` DAG must stay acyclic (cycles are surfaced by `check`). Idempotent. Errors when the source does not exist; fails fast with `ERR_NOT_FOUND` rather than an untyped throw (`src/cli/index.ts:1257-1282`).

Envelope `type`: `derive` (`{from, relation, to, added}`) (`src/cli/index.ts:1278`).

## satisfy

```
symspec satisfy <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (satisfies the target goal) (`src/cli/index.ts:763`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:764`).
- `--file <path>` — document path override (`src/cli/index.ts:765`).

Adds a `satisfies` edge linking an implementation-level requirement back to a higher-level goal. Idempotent. Errors when the source does not exist (`src/cli/index.ts:766-768`, `src/cli/index.ts:1257-1282`).

Envelope `type`: `satisfy` (`{from, relation, to, added}`) (`src/cli/index.ts:1278`).

## remove-edge

```
symspec remove-edge <fromId> <relation> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (`src/cli/index.ts:774`).
- `<relation>` — edge relation: `derives|satisfies|verifies|refines` (`src/cli/index.ts:775`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:776`).
- `--file <path>` — document path override (`src/cli/index.ts:777`).

Removes a typed directional edge via a `RemoveRelationship` change. No-op if the edge is absent — safe to call defensively. Does not delete either endpoint node (`src/cli/index.ts:794-808`).

Envelope `type`: `remove-edge` (`{from, relation, to, removed}`) (`src/cli/index.ts:802-805`).

## delete

```
symspec delete <id> [--file <path>]
```

- `<id>` — UUID (or stable key) of the requirement to delete (`src/cli/index.ts:816`).
- `--file <path>` — document path override (`src/cli/index.ts:817`).

Tombstones a requirement via a `DeleteRequirement` change. Inbound edges from survivors become dangling references (not auto-removed); run `check` afterward to find them (`src/cli/index.ts:824-830`).

Envelope `type`: `delete` (`{id, deleted}`) (`src/cli/index.ts:827`).

## export

```
symspec export [file]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:837`).

Exports the requirements graph to SysML-v2-flavored JSON: each requirement becomes a `RequirementUsage`, each edge a typed relationship (`DeriveRequirement`, `Satisfy`, `Verify`, `Refine`). Read-only (`src/cli/index.ts:843`).

Envelope `type`: `export`.

## glossary (add / remove / list)

```
symspec glossary add <canonical> <alias> [--file <path>]
symspec glossary remove <canonical> <alias> [--file <path>]
symspec glossary list [--file <path>]
```

- `add <canonical> <alias>` — add an alias phrasing under a canonical phrase (idempotent) (`src/cli/index.ts:851-865`).
- `remove <canonical> <alias>` — remove an alias from a canonical group (no-op if absent) (`src/cli/index.ts:867-881`).
- `list` — list the committed synonym groups (read-only); a stray positional is rejected with a specific `ERR_USAGE` naming `--file`/`SYMSPEC_DOC`, not commander's generic "too many arguments" (`src/cli/index.ts:883-897`).
- `--file <path>` — document path override on each subcommand (`src/cli/index.ts:856`, `src/cli/index.ts:872`, `src/cli/index.ts:890`).

The formal tier canonicalizes response atoms through this glossary, so agent-confirmed synonyms collide on one atom and a paraphrased contradiction becomes provable by `check`. This is the DECIDE half of the semantic tier: `check` only PROPOSES entries (`FND_SIMILAR_SEMANTIC`); confirming them here changes a verdict. The glossary doubles as a quantity-alias map for the numeric tier — canonicalizing a quantity label ("keep valid for" ≡ "expire after") makes two phrasings of one physical quantity share a Real variable so a same-quantity numeric contradiction becomes provable. This is exactly the DECIDE-tier command a `FND_QUANTITY_ALIAS_CANDIDATE` finding names: `check` emits the precise `symspec glossary add "<canonical>" "<alias>"` to run, and committing it routes both numeric bounds to one quantity key so the LIA solver can prove (or clear) the conflict — promoting `data.verified` on the next run. Mutating ops re-save the document (`src/cli/descriptions.ts:160-166`).

## antonym (add / remove / list)

```
symspec antonym add <a> <b> [--file <path>]
symspec antonym remove <a> <b> [--file <path>]
symspec antonym list [--file <path>]
```

- `add <a> <b>` — assert two response verb-heads are polar opposites (idempotent; matches either order). Rejects a self-pair or a pair that would make the antonym classes inconsistent (`ERR_USAGE`) (`src/cli/index.ts:1028-1042`).
- `remove <a> <b>` — retract an antonym pair (no-op if absent) (`src/cli/index.ts:1044-1058`).
- `list` — list the committed antonym pairs (read-only); a stray positional is rejected with a specific `ERR_USAGE` (`src/cli/index.ts:1060-1072`).
- `--file <path>` — document path override on each subcommand.

The opposition analogue of `glossary`. An `antonym add open shut` asserts the two verb-heads are polar opposites, so "open the valve" and "shut the valve" atomize to the SAME atom with OPPOSITE polarity and `check` proves the contradiction the built-in seed antonym table (grant/revoke, allow/deny, …) missed. The DECIDE half for opposition; `check` PROPOSES candidates (`FND_OPPOSITION_CANDIDATE`), and an untriaged candidate DEMOTES `data.verified` until committed here or waived. Mutating ops re-save the document.

Envelope `type`: `antonym`.

## download-model

```
symspec download-model
```

No arguments (`src/cli/index.ts:902-913`). Pre-fetches and caches the semantic tier's embedding model so `check` runs fully offline afterward — load-bearing now that the semantic tier is core and a missing model fails `check` closed. Downloads the pinned `Xenova/bge-base-en-v1.5` model (~110 MB) plus its two tokenizer files from a frozen HuggingFace revision, verifying every asset against a pinned sha256 so a corrupt or tampered download fails instead of poisoning embeddings (`src/cli/descriptions.ts:189-193`, `src/formal/model-cache.ts:218`). Idempotent: already-cached-and-valid assets are reported and skipped; the report carries `model`, `revision`, `cacheDir`, per-asset `{name, bytes, cached}`, and `alreadyComplete`. A fetch/verify failure surfaces `ERR_EMBED_MODEL_MISSING` (`src/cli/index.ts:907-912`).

Envelope `type`: `download-model`.

## apply

```
symspec apply [file] [--doc <path>] [--stdin] [--continue-on-error]
```

- `[file]` — path to a JSONL op file, one `{"op":"add|update|derive|satisfy|remove-edge|delete", ...}` record per line; blank lines and `#`-comment lines are skipped (`src/cli/index.ts:920`).
- `--doc <path>` — the requirements-document path. `apply` is the one command that takes the doc path as `--doc`, not `--file`, because its positional `[file]` is already the JSONL op stream (`src/cli/index.ts:921`, `src/cli/manifest.ts:116-128`).
- `--stdin` — read the JSONL op stream from stdin instead of a file (`src/cli/index.ts:922`).
- `--continue-on-error` — best-effort mode: apply the ops that succeed and save once, instead of the atomic default (`src/cli/index.ts:923-926`).

Applies a batch of mutation ops in ONE process and ONE atomic save — the field report's biggest lever, replacing ~one subprocess per op plus a label→UUID sidecar file. Requirement references (`ref`/`from`/`to`) accept a stable key OR a UUID, and an `add` op may carry its own `key` so LATER ops in the SAME batch reference the new requirement before its minted UUID is known. The `delete` op accepts EITHER `ref` OR `id` (both key-or-UUID, `ref` wins when both are present), so `{"op":"delete","ref":"S3"}` and `{"op":"delete","id":"S3"}` are identical and the batch op agrees with the single-command `delete <id>` (`src/cli/apply.ts:168-176`). Atomic by default: any op error aborts with `ok:false` and the failing op's index and writes NOTHING, so a crashed batch never leaves the document half-mutated — the resume story is "fix the line and re-run" (`src/cli/apply.ts:204-296`). Empty/comment-only input is an `ERR_USAGE`.

Envelope `type`: `apply` (`{results, summary:{total, ok, failed}}`).

## waive (add / remove / list)

```
symspec waive add <code> --reason <why> [--ref <keyOrId>] [--file <path>]
symspec waive remove <code> [--ref <keyOrId>] [--file <path>]
symspec waive list [--file <path>]
```

- `add <code> --reason <why>` — record a reviewed, reasoned waiver suppressing a finding code (e.g. `GTWR_R6_MISSING_UNITS`) in `check`; `--reason` is required (the audit trail); idempotent (`src/cli/index.ts:969-986`).
- `remove <code>` — retract a waiver (no-op if absent) (`src/cli/index.ts:988-1005`).
- `list` — list the committed waivers (read-only); a stray positional is rejected (`src/cli/index.ts:1007-1019`).
- `--ref <keyOrId>` — scope the waiver to one requirement (stable key or UUID); omit for document-wide (`src/cli/index.ts:974`, `src/cli/index.ts:992-995`).
- `--file <path>` — document path override on each subcommand.

`check` drops waived findings from `findings[]` and the exit gate and tallies them under `data.waived`, so a suppressed-with-reason baseline stays visible and a reader can tell triage from neglect. Waiving is NOT a universal escape hatch: waiving the blocking finding that excluded a requirement from the formal tier does NOT restore formal coverage — `FND_EXCLUDED_FROM_FORMAL` still demotes `data.verified`, and the requirement is re-admitted only by fixing (rephrasing) the blocking finding (`src/formal/codes.ts:252-256`).

Envelope `type`: `waive`.

## install

```
symspec install [--global] [--target <sel>] [--check] [--print <id>] [--uninstall]
```

- `--global` — install into your home config (`~/.agents/skills`, `~/.kiro/steering`, …) instead of the current project (`src/cli/index.ts:1080`).
- `--target <sel>` — which hosts to target: `auto` (default, detected hosts) | `all` | a CSV of ids (`agents-standard`, `kiro`, `windsurf`, `copilot`) (`src/cli/index.ts:1081`).
- `--uninstall` — remove symspec's skill file from each target host (`src/cli/index.ts:1082`).
- `--check` — report what would be written (present/missing) without writing (`src/cli/index.ts:1083`).
- `--print <id>` — print one host's exact skill-file content and exit; write nothing (`src/cli/index.ts:1084`).

Installs the symspec skill into each detected agent host's DEDICATED directory (Claude Code `.claude/skills`, the `.agents/skills` open standard used by Cursor/Codex, Kiro steering, Windsurf rules, Copilot path-instructions) so the agent discovers and drives symspec automatically. Never touches a host's root instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`); the skill body is generated from the manifest corpus, so it cannot drift. Idempotent — an unchanged file is left untouched. Hosts whose only always-on surface is a root doc (opencode, Gemini CLI) are reported as skipped rather than edited (`src/cli/descriptions.ts:215-224`).

Envelope `type`: `install`.

## Global flags

Every command inherits these output-shaping flags; they change rendering only, never the data or the exit code (`src/cli/index.ts:112-124`, `src/cli/index.ts:210-218`).

- `--json` — no-op alias for the default JSON envelope output (`src/cli/index.ts:210`).
- `--pretty` — render human-readable prose instead of the default JSON envelope (`src/cli/index.ts:211`).
- `--human` — alias of `--pretty` (`src/cli/index.ts:212`).
- `--dense` — minified, default/null-omitting, evidence-elided JSON (`src/cli/index.ts:213`).
- `--evidence` — keep the heavy evidence/atom-table fields under `--dense` (`src/cli/index.ts:214`).
- `--field <paths>` — jq-style envelope projection: comma-separated dotted paths (e.g. `data.verified,data.coverage.demotions`) that reduce the envelope to just those values, emitted as JSON, so a fix loop can pull one field without piping through a JSON tool. Walks the envelope object segment-by-segment, honoring a numeric segment as an array index (`data.findings.0.code`); the result is a NESTED object mirroring the requested paths, so it stays self-describing and overlapping paths merge. An OUTPUT projection only — never changes data or the exit code. Unresolved paths (missing key / out-of-range index) are OMITTED rather than emitted as `null`; when no path resolves the result is `{}`. Composes with `--dense` (projects the densified envelope) and ignores `--pretty` (a field selection is inherently machine output) (`src/cli/index.ts:215-218`, `src/cli/index.ts:145-155`, `src/cli/field.ts:104-113`).
- `--version` / `-V` — print `package.json`'s version and exit 0 (`src/cli/index.ts:208`, `src/cli/index.ts:1310-1315`).
- `--help` — commander help, exit 0 (`src/cli/index.ts:1310-1315`).

Bad arguments (unknown command, missing required arg, unknown option) are translated into an `ERR_USAGE` envelope on stdout rather than a commander stack trace; an arity error additionally appends the doc-path remedy (`src/cli/index.ts:219-230`, `src/cli/index.ts:1317-1332`).

## Environment variables

- `SYMSPEC_DOC` — default document path, second in the resolution precedence after the positional/`--file` argument and before `./requirements.json` (`src/cli/resolve-doc.ts`).
- `SYMSPEC_MODEL_DIR` — override for the embedding-model cache directory; takes precedence over `XDG_CACHE_HOME` and `~/.cache` (`src/formal/model-cache.ts:101`).
- `SYMSPEC_EMBED_ALLOW_REMOTE=1` — allows the semantic tier to fetch missing model assets over the network at check time; default OFF, so an absent cache surfaces `ERR_EMBED_MODEL_MISSING` and never blocks the SMT/lint tiers. `download-model` always allows remote regardless (`src/formal/model-cache.ts:218`).

## See also

- [Module map](../architecture/module-map.md) — 7 shared source citations
- [Contract map](../insights/contract-map.md) — 6 shared source citations
- [Debugging guide](../insights/debugging-guide.md) — 6 shared source citations
- [Impact analysis](../insights/impact-analysis.md) — 6 shared source citations
- [System overview](../architecture/system-overview.md) — 4 shared source citations
