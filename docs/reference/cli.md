# symspec · CLI reference

`symspec` is an EARS requirements linter built for coding agents to drive, not humans to read (`src/cli/index.ts:130-134`). It is the thin formatter over the library API: every command resolves the document path, loads and validates it, runs a pure command core, saves on mutation, and wraps the result in a typed envelope before rendering and exiting (`src/cli/index.ts:5-13`).

Three properties make the surface agent-legible:

- **A self-describing `manifest`.** Fetch it once to learn the entire command inventory, per-command argument schemas, the stable code catalogs, the envelope `type` set, and live backend availability — no prose scraping (`src/cli/index.ts:156-162`).
- **Typed envelopes are the zero-flag default.** Every result is `{apiVersion, type, data}` on success or `{apiVersion, type:'error', error, code, suggestions, partial?}` on failure. Both carry `apiVersion` (currently `1`) and a `type` discriminant an agent switches on. The default output is JSON; `--pretty`/`--human` opt into prose (`src/cli/index.ts:91-98`, `src/cli/index.ts:137-139`).
- **Stable codes and deterministic exit.** Errors carry a stable `ERR_*` code plus `suggestions`; `check` findings carry `GTWR_*`/`FND_*` codes. Bad arguments become an `ERR_USAGE` envelope rather than a commander stack trace (`src/cli/index.ts:142-152`, `src/cli/index.ts:862-882`).

The binary is `symspec`, a two-line ESM shim that imports the bundled `dist/cli.mjs` (`bin/symspec.mjs:1-2`). `--version` prints `package.json`'s version, single-sourced (`src/cli/index.ts:135`).

Document-path resolution precedence for every mutating/reading command: the positional `[file]` (or `--file <path>` on commands with a required positional), then the `SYMSPEC_DOC` environment variable, then the `./requirements.json` default (`src/cli/index.ts:106-122`). `init`, `manifest`, `parse`, and `download-model` do not resolve an existing document.

There are 16 commands. MCP is not one of them — the MCP surface was removed; the agent surface is the typed JSON envelope, the self-describing `manifest`, and generated AGENTS.md.

## manifest

```
symspec manifest
```

No arguments (`src/cli/index.ts:156-162`). Read-only; touches no document. Returns the whole command surface as one blob: the command inventory with per-command argument JSON Schemas, the `ERR_*`/`GTWR_*`/`FND_*` code catalogs, the closed envelope `type` set, top-level `globalOptions`, the formal-tier `scope` disclosure, and a live `backends` availability report (z3-wasm, external z3/cvc5 binaries, Lean toolchain) via `buildManifestWithBackends()` so an agent can query-then-decide before invoking `certify` or `--solver` (`src/cli/index.ts:159-161`).

Envelope `type`: `manifest`.

## init

```
symspec init [file]
```

- `[file]` — path to the requirements document to create (`src/cli/index.ts:168`).
- `--force` — overwrite an existing document instead of refusing (`src/cli/index.ts:169`).

Creates an empty document at the resolved path, written atomically via `writeDocFile` (`src/cli/index.ts:190`). Non-destructive by default: refuses to clobber an existing file with an `ERR_DOC_EXISTS` failure unless `--force` is passed (`src/cli/index.ts:176-188`).

Envelope `type`: `init` (`{path, created}`) (`src/cli/index.ts:194`).

## add

```
symspec add [file] [--from-parse <prose> | --pattern <p> --system <s> --response <r> ...]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:201`).
- `--id <uuid>` — explicit requirement UUID (default: auto-minted) (`src/cli/index.ts:202`).
- `--from-parse <prose>` — a single line of prose to parse into EARS slots; determines polarity itself, so `--negated` is ignored on this path (`src/cli/index.ts:203`, `src/cli/index.ts:706-714`).
- `--pattern <p>` — EARS pattern type: `ubiquitous|event-driven|state-driven|optional-feature|unwanted-behavior` (`src/cli/index.ts:204-207`).
- `--system <s>` — system name (the X in "the X shall ...") (`src/cli/index.ts:208`).
- `--response <r>` — system response (`src/cli/index.ts:209`).
- `--negated` — prohibition: render "shall not <response>" (keep `--response` positive) (`src/cli/index.ts:210`).
- `--trigger <t>` — trigger clause (event-driven / unwanted-behavior) (`src/cli/index.ts:211`).
- `--pre <p>` — pre-condition clause (state-driven / optional-feature) (`src/cli/index.ts:212`).
- `--priority <p>` — `low|medium|high|critical` (`src/cli/index.ts:213`).
- `--status <s>` — `draft|approved|implemented|verified` (`src/cli/index.ts:214`).
- `--verification <m>` — `test|inspection|analysis|demonstration` (`src/cli/index.ts:215`).
- `--pattern-type`, `--system-name`, `--system-response`, `--pre-condition`, `--verification-method` — aliases matching the manifest field names, so a flag derived from `symspec manifest` works; the short flag wins when both are given (`src/cli/index.ts:218-222`, `src/cli/index.ts:719-723`).

Mints the UUID (unless `--id`), renders the canonical sentence, and applies defaults. Missing slots are surfaced by `check` rather than rejected. Not idempotent — each call creates a distinct requirement (`src/cli/descriptions.ts:70-78`).

Envelope `type`: `add`.

## update

```
symspec update <id> <attr> [value] [--file <path>] [--clear]
```

- `<id>` — UUID of the requirement to update (`src/cli/index.ts:239`).
- `<attr>` — attribute to set (`src/cli/index.ts:240`).
- `[value]` — new value; omit and pass `--clear` to remove an optional attr (`src/cli/index.ts:241`).
- `--file <path>` — document path override (`src/cli/index.ts:242`).
- `--clear` — clear (remove) an optional attribute instead of setting a value (`src/cli/index.ts:243`).

Patches exactly one typed attribute. Editing a structural EARS slot re-renders the canonical sentence; metadata edits do not. Clearing a required attribute errors; the literal string `"null"` is stored as text. Idempotent (`src/cli/descriptions.ts:80-88`).

Envelope `type`: `update`.

## parse

```
symspec parse [text] [--file <path>] [--stdin]
```

- `[text]` — a single requirement sentence to parse (one-element batch) (`src/cli/index.ts:272`).
- `--file <path>` — read requirement lines (one per line) from a file (`src/cli/index.ts:273`).
- `--stdin` — read requirement lines (one per line) from stdin (`src/cli/index.ts:274`).

Exactly one input source is required; supplying none is an `ERR_USAGE` failure (`src/cli/index.ts:764-777`). Each line runs the Tier-1 regex cascade, escalating to the Tier-2 wink-nlp parser and, on hard failure, a Tier-3 structured error carrying a stable `ERR_PARSE_*` code, recovered partial slots, and rewrite suggestions. A no-modal line is reported as skipped. Returns per-line results plus an `{ok, skipped, error}` summary via `parseBatch` (`src/cli/index.ts:284-285`). Read-only.

Envelope `type`: `parse`.

## check

```
symspec check [file] [--solver <backend>] [--semantic] [--temporal] [--emit-smt2 <path>] ...
```

- `[file]` — path to the requirements document (`src/cli/index.ts:293`).
- `--similarity-threshold <n>` — pairwise lexical-similarity threshold, 0..1 (`src/cli/index.ts:294`).
- `--timeout-ms <n>` — per-group solver timeout in ms (default 2000) (`src/cli/index.ts:295`).
- `--solver-budget-ms <n>` — whole-run solver budget in ms; the `ERR_SOLVER_TIMEOUT` boundary (`src/cli/index.ts:296`).
- `--emit-smt2 <path>` — also write the portable SMT-LIB2 artifact for the included requirements (`src/cli/index.ts:297-300`, `src/cli/index.ts:386-392`).
- `--solver <backend>` — formal backend: `z3-wasm` (default, in-process WASM) | `z3-bin` | `cvc5` (external binary cross-check). An unknown value is an `ERR_USAGE`; a missing binary is `ERR_SOLVER_MISSING` surfaced before any check runs, carrying the backend's mise-install suggestion (`src/cli/index.ts:301-304`, `src/cli/index.ts:342-352`, `src/cli/index.ts:396-409`, `src/cli/index.ts:419-424`).
- `--solver-path <path>` — explicit path to an external z3/cvc5 binary (implies the binary backend) (`src/cli/index.ts:305`, `src/cli/index.ts:342-343`).
- `--semantic` — opt-in: embed responses with the local BGE-ONNX model to PROPOSE glossary merges for paraphrased conflicts (`FND_SIMILAR_SEMANTIC`) plus the embedding similarity graph proposals (`FND_MISSING_TRACE_LINK`, `FND_DUPLICATE_CLUSTER`). The model loads lazily and only under this flag; an unloadable model surfaces `ERR_EMBED_MODEL_MISSING` before the run (`src/cli/index.ts:306-309`, `src/cli/index.ts:360-373`).
- `--semantic-threshold <n>` — cosine threshold for `--semantic` (default 0.72; propose-only tier tuned to favor recall against the model's real paraphrase cosine band — see `DEFAULT_SEMANTIC_THRESHOLD` in `src/formal/semantic.ts` for the rationale) (`src/cli/index.ts:310`).
- `--temporal` — opt-in: bounded LTL→SMT temporal-ordering conflict detection (`FND_TEMPORAL_CONTRADICTION`). Pure Z3-WASM, no model. Sound-for-UNSAT: a conflict is reported only when no trace of length ≤ k satisfies the requirements jointly; a `sat` result at the bound is not a consistency certificate (`src/cli/index.ts:311-314`, `src/cli/index.ts:377-380`).
- `--temporal-bound <k>` — trace bound k for `--temporal` (default 10) (`src/cli/index.ts:315`).
- `--strict` — opt-in coverage gate: fail with exit `3` when the run is INCONCLUSIVE — ≥2 requirements but nothing was verified across them (`data.verified` is `false`). The machine-readable form of "silence is not a consistency certificate"; off by default so the base contract is unchanged.
- `--fail-on-unmatched <n>` — opt-in coverage gate: fail with exit `3` when `residualRisk.unmatchedAtoms` exceeds `<n>` (atoms owned by exactly one requirement, never cross-compared). `0` fails on any unmatched atom. Independent of `--strict` — either gate tripping fails the run.

When `--semantic` is set, the pass also PROPOSES opposition candidates (`FND_OPPOSITION_CANDIDATE`, info-tier): same-system responses that share an object but differ on the leading verb (e.g. "open the valve" vs "shut the valve") and are not already unified as antonyms, suggesting a concrete `symspec antonym add`. Propose-only — cosine is only a topical-relatedness floor, the shared-object/different-verb structure is the signal.

Wires all tiers into one pass: Tier-0 structural checks, INCOSE GtWR + free-tier lint rules, the always-on deterministic ambiguity family, and the in-process SMT formal tier (contradiction / subsumption / vacuity / completeness / similarity / needs-review over the gate-included subset, plus the numeric/arithmetic conflict tier over ALL requirements). The contradiction tier also computes a guard-implication closure: a bridge requirement that establishes a state ("while authenticated, be verified") links a rule guarded on `authenticated` to one guarded on `verified`, so a transitive conflict becomes provable with the bridge named in the core. Sound modulo atomization: every reported conflict is real, but silence is not a consistency certificate.

The success payload carries a first-class `data.verified` boolean — `false` when ≥2 requirements produced no cross-requirement comparison (inconclusive), distinguishing "verified clean" from "nothing could be checked" — plus a `residualRisk` summary, and may also carry `emittedSmt2` and `binaryCrossCheck`. Read-only. Exit `0` = no error finding (and, if a strict gate was requested, it passed), `1` = pass/fail gate failed on an error-severity finding, `2` = operational error, `3` = a requested strict coverage gate tripped on an otherwise error-free run.

Envelope `type`: `check`.

## certify

```
symspec certify [file] [--out-dir <path>]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:437`).
- `--out-dir <path>` — directory for the retained `.lean` artifact on success (`src/cli/index.ts:438`).

Emits one batched core-Lean file (no Mathlib, no lake), runs it through `lean --json`, and maps the result to `FND_CERTIFIED` (with `#print axioms` provenance) or `FND_CERTIFY_FAILED`. Strictly opt-in; the default `check` never invokes Lean. A missing toolchain returns `ERR_LEAN_TOOLCHAIN_MISSING` and never affects any prior SMT result (`src/cli/index.ts:448-452`). Scope note (v2): each requirement is emitted as a placeholder `True` theorem, so the certificate attests only that the toolchain ran and the file elaborates — it does not yet encode requirement semantics (`src/cli/index.ts:464-470`, `src/cli/index.ts:794-807`).

Envelope `type`: `certify` (`{certified, findings}`) (`src/cli/index.ts:480`).

## list

```
symspec list [file]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:492`).

Lists every current requirement with its `id`, `patternType`, `priority`, `status`, and rendered `sentence` — enough to scan the spec without fetching every full node. Read-only and idempotent (`src/cli/index.ts:499-506`).

Envelope `type`: `list`.

## show

```
symspec show <id> [--file <path>]
```

- `<id>` — UUID of the requirement to show (`src/cli/index.ts:513`).
- `--file <path>` — document path override (`src/cli/index.ts:514`).

Prints the full record of one requirement (all slots, metadata, outbound edges). Errors when the id does not resolve. Read-only and idempotent (`src/cli/index.ts:521-523`).

Envelope `type`: `show`.

## derive

```
symspec derive <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (decomposes into the target) (`src/cli/index.ts:530`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:531`).
- `--file <path>` — document path override (`src/cli/index.ts:532`).

Adds a `derives` edge. The `derives` DAG must stay acyclic (cycles are surfaced by `check`). Idempotent. Errors when the source does not exist; fails fast with `ERR_NOT_FOUND` rather than an untyped throw (`src/cli/index.ts:828-836`).

Envelope `type`: `derive` (`{from, relation, to, added}`) (`src/cli/index.ts:836`).

## satisfy

```
symspec satisfy <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (satisfies the target goal) (`src/cli/index.ts:541`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:542`).
- `--file <path>` — document path override (`src/cli/index.ts:543`).

Adds a `satisfies` edge linking an implementation-level requirement back to a higher-level goal. Idempotent. Errors when the source does not exist (`src/cli/index.ts:544-546`).

Envelope `type`: `satisfy` (`{from, relation, to, added}`) (`src/cli/index.ts:836`).

## remove-edge

```
symspec remove-edge <fromId> <relation> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (`src/cli/index.ts:552`).
- `<relation>` — edge relation: `derives|satisfies|verifies|refines` (`src/cli/index.ts:553`).
- `<toId>` — target requirement UUID (`src/cli/index.ts:554`).
- `--file <path>` — document path override (`src/cli/index.ts:555`).

Removes a typed directional edge via a `RemoveRelationship` change. No-op if the edge is absent — safe to call defensively. Does not delete either endpoint node (`src/cli/index.ts:572-583`).

Envelope `type`: `remove-edge` (`{from, relation, to, removed}`) (`src/cli/index.ts:580-583`).

## delete

```
symspec delete <id> [--file <path>]
```

- `<id>` — UUID of the requirement to delete (`src/cli/index.ts:594`).
- `--file <path>` — document path override (`src/cli/index.ts:595`).

Tombstones a requirement via a `DeleteRequirement` change. Inbound edges from survivors become dangling references (not auto-removed); run `check` afterward to find them (`src/cli/index.ts:602-605`).

Envelope `type`: `delete` (`{id, deleted}`) (`src/cli/index.ts:605`).

## export

```
symspec export [file]
```

- `[file]` — path to the requirements document (`src/cli/index.ts:615`).

Exports the requirements graph to SysML-v2-flavored JSON: each requirement becomes a `RequirementUsage`, each edge a typed relationship (`DeriveRequirement`, `Satisfy`, `Verify`, `Refine`). Read-only (`src/cli/index.ts:621`).

Envelope `type`: `export`.

## glossary (add / remove / list)

```
symspec glossary add <canonical> <alias> [--file <path>]
symspec glossary remove <canonical> <alias> [--file <path>]
symspec glossary list [--file <path>]
```

- `add <canonical> <alias>` — add an alias phrasing under a canonical phrase (idempotent) (`src/cli/index.ts:629-643`).
- `remove <canonical> <alias>` — remove an alias from a canonical group (no-op if absent) (`src/cli/index.ts:645-659`).
- `list` — list the committed synonym groups (read-only) (`src/cli/index.ts:661-670`).
- `--file <path>` — document path override on each subcommand (`src/cli/index.ts:634`, `src/cli/index.ts:650`, `src/cli/index.ts:664`).

The formal tier canonicalizes response atoms through this glossary, so agent-confirmed synonyms collide on one atom and a paraphrased contradiction becomes provable by `check`. This is the DECIDE half of the semantic tier: `check --semantic` only PROPOSES entries (`FND_SIMILAR_SEMANTIC`); confirming them here changes a verdict. The glossary doubles as a quantity-alias map for the numeric tier — canonicalizing a quantity label ("keep valid for" ≡ "expire after") makes two phrasings of one physical quantity share a Real variable so a same-quantity numeric contradiction becomes provable. Mutating ops re-save the document (`src/cli/descriptions.ts:160-166`).

## antonym (add / remove / list)

```
symspec antonym add <a> <b> [--file <path>]
symspec antonym remove <a> <b> [--file <path>]
symspec antonym list [--file <path>]
```

- `add <a> <b>` — assert two response verb-heads are polar opposites (idempotent; matches either order). Rejects a self-pair or a pair that would make the antonym classes inconsistent (`ERR_USAGE`).
- `remove <a> <b>` — retract an antonym pair (no-op if absent).
- `list` — list the committed antonym pairs (read-only).
- `--file <path>` — document path override on each subcommand.

The opposition analogue of `glossary`. An `antonym add open shut` asserts the two verb-heads are polar opposites, so "open the valve" and "shut the valve" atomize to the SAME atom with OPPOSITE polarity and `check` proves the contradiction the built-in seed antonym table (grant/revoke, allow/deny, …) missed. The DECIDE half for opposition; `check --semantic` PROPOSES candidates (`FND_OPPOSITION_CANDIDATE`). Mutating ops re-save the document.

Envelope `type`: `antonym`.

## download-model

```
symspec download-model
```

No arguments (`src/cli/index.ts:675-686`). Pre-fetches and caches the semantic tier's embedding model so `check --semantic` runs fully offline afterward. Downloads the pinned `Xenova/bge-base-en-v1.5` model (~110 MB) plus its two tokenizer files from a frozen HuggingFace revision, verifying every asset against a pinned sha256 so a corrupt or tampered download fails instead of poisoning embeddings (`src/cli/descriptions.ts:167-172`, `src/formal/model-cache.ts:218`). Idempotent: already-cached-and-valid assets are reported and skipped; the report carries `model`, `revision`, `cacheDir`, per-asset `{name, bytes, cached}`, and `alreadyComplete`. A fetch/verify failure surfaces `ERR_EMBED_MODEL_MISSING` (`src/cli/index.ts:681-684`).

Envelope `type`: `download-model`.

## Global flags

Every command inherits these output-shaping flags; they change rendering only, never the data or the exit code (`src/cli/index.ts:137-141`).

- `--json` — no-op alias for the default JSON envelope output (`src/cli/index.ts:137`).
- `--pretty` — render human-readable prose instead of the default JSON envelope (`src/cli/index.ts:138`).
- `--human` — alias of `--pretty` (`src/cli/index.ts:139`).
- `--dense` — minified, default/null-omitting, evidence-elided JSON (`src/cli/index.ts:140`, `src/cli/index.ts:91-95`).
- `--evidence` — keep the heavy evidence/atom-table fields under `--dense` (`src/cli/index.ts:141`).
- `--version` / `-V` — print `package.json`'s version and exit 0 (`src/cli/index.ts:135`, `src/cli/index.ts:868-873`).
- `--help` — commander help, exit 0 (`src/cli/index.ts:868-873`).

Bad arguments (unknown command, missing required arg, unknown option) are translated into an `ERR_USAGE` envelope on stdout rather than a commander stack trace (`src/cli/index.ts:144-152`, `src/cli/index.ts:875-881`).

## Environment variables

- `SYMSPEC_DOC` — default document path, second in the resolution precedence after the positional/`--file` argument and before `./requirements.json` (`src/cli/index.ts:106-122`).
- `SYMSPEC_MODEL_DIR` — override for the embedding-model cache directory; takes precedence over `XDG_CACHE_HOME` and `~/.cache` (`src/formal/model-cache.ts:101`).
- `SYMSPEC_EMBED_ALLOW_REMOTE=1` — allows the semantic tier to fetch missing model assets over the network at check time; default OFF, so an absent cache surfaces `ERR_EMBED_MODEL_MISSING` and never blocks the SMT/lint tiers. `download-model` always allows remote regardless (`src/formal/model-cache.ts:218`).

## See also

- [symspec · Impact analysis](../insights/impact-analysis.md) — 4 shared source citations
- [symspec · Contract map](../insights/contract-map.md) — 4 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 3 shared source citations
- [symspec · Processes](../behavior/processes.md) — 3 shared source citations
- [symspec · System overview](../architecture/system-overview.md) — 3 shared source citations
