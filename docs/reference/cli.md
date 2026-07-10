# symspec · CLI reference

`symspec` is an EARS requirements linter built for coding agents to drive, not humans to read (src/cli/index.ts:130-134). It is the thin formatter over the library API: every command resolves the document path, loads and validates it, runs a pure command core, saves on mutation, and wraps the result in a typed envelope before rendering and exiting (src/cli/index.ts:5-13).

Three properties make the surface agent-legible:

- **A self-describing `manifest`.** Fetch it once to learn the entire command inventory, per-command argument schemas, the stable code catalogs, the envelope `type` set, and live backend availability — no prose scraping (src/cli/manifest.ts:1-5, src/cli/index.ts:156-162).
- **Typed envelopes are the zero-flag default.** Every result is `{apiVersion, type, data}` on success or `{apiVersion, type:'error', error, code, suggestions, partial?}` on failure. Both carry `apiVersion` (currently `1`) and a `type` discriminant an agent switches on (src/cli/envelope.ts:100-146, src/cli/envelope.ts:69). The default output is JSON; `--pretty`/`--human` opt into prose (src/cli/index.ts:91-98).
- **Stable codes and deterministic exit.** Errors carry a stable `ERR_*` code plus `suggestions`; `check` findings carry `GTWR_*`/`FND_*` codes. Exit is `0` clean, `1` when a `check` produced an error-severity finding, `2` on any operational `ERR_*` failure (src/cli/exit.ts:60-74, src/cli/exit.ts:149-157).

The binary is `symspec`, a one-line ESM shim that imports the bundled `dist/cli.mjs` (bin/symspec.mjs). `--version` prints `package.json`'s version, single-sourced (src/cli/version.ts, src/cli/index.ts:135).

Document-path resolution precedence for every command: the positional `[file]` (or `--file <path>` on commands with a required positional), then the `SYMSPEC_DOC` environment variable, then the `./requirements.json` default (src/cli/manifest.ts:74-104).

## manifest

```
symspec manifest
```

No arguments (src/cli/manifest.ts:220). Read-only; touches no document (src/cli/descriptions.ts:56-62). Returns the whole command surface as one blob: the command inventory with per-command argument JSON Schemas, the `ERR_*`/`GTWR_*`/`FND_*` code catalogs, the closed envelope `type` set, top-level `globalOptions`, the formal-tier `scope` disclosure, and a live `backends` availability report (z3-wasm, external z3/cvc5 binaries, Lean toolchain) so an agent can query-then-decide before invoking `certify` or `--solver` (src/cli/manifest.ts:379-415, src/cli/index.ts:159-161).

Envelope `type`: `manifest`.

## init

```
symspec init [file]
```

- `[file]` — path to the requirements document to create (src/cli/index.ts:168).
- `--force` — overwrite an existing document instead of refusing (src/cli/index.ts:169).

Creates an empty document at the resolved path, written atomically as pretty-printed sorted-key JSON (src/cli/descriptions.ts:64-68). Non-destructive by default: refuses to clobber an existing file with an `ERR_DOC_EXISTS` failure unless `--force` is passed (src/cli/index.ts:176-188).

Envelope `type`: `init` (`{path, created}`) (src/cli/index.ts:194).

## add

```
symspec add [file] [--from-parse <prose> | --pattern <p> --system <s> --response <r> ...]
```

- `[file]` — path to the requirements document (src/cli/index.ts:201).
- `--id <uuid>` — explicit requirement UUID (default: auto-minted) (src/cli/index.ts:202).
- `--from-parse <prose>` — a single line of prose to parse into EARS slots; determines polarity itself, so `--negated` is ignored on this path (src/cli/index.ts:203, src/cli/index.ts:692-700).
- `--pattern <p>` — EARS pattern type: `ubiquitous|event-driven|state-driven|optional-feature|unwanted-behavior` (src/cli/index.ts:205).
- `--system <s>` — system name (the X in "the X shall ...") (src/cli/index.ts:207).
- `--response <r>` — system response (src/cli/index.ts:208).
- `--negated` — prohibition: render "shall not <response>" (keep `--response` positive) (src/cli/index.ts:210).
- `--trigger <t>` — trigger clause (event-driven / unwanted-behavior) (src/cli/index.ts:211).
- `--pre <p>` — pre-condition clause (state-driven / optional-feature) (src/cli/index.ts:212).
- `--priority <p>` — `low|medium|high|critical` (src/cli/index.ts:213).
- `--status <s>` — `draft|approved|implemented|verified` (src/cli/index.ts:214).
- `--verification <m>` — `test|inspection|analysis|demonstration` (src/cli/index.ts:215).
- `--pattern-type`, `--system-name`, `--system-response`, `--pre-condition`, `--verification-method` — aliases matching the manifest field names, so a flag derived from `symspec manifest` works; the short flag wins when both are given (src/cli/index.ts:218-222, src/cli/index.ts:705-709).

Mints the UUID (unless `--id`), renders the canonical sentence, and applies defaults (`priority=medium`, `status=draft`, empty edge arrays). Missing slots are surfaced by `check` rather than rejected. Not idempotent — each call creates a distinct requirement (src/cli/descriptions.ts:70-78).

Envelope `type`: `add`.

## update

```
symspec update <id> <attr> [value] [--file <path>] [--clear]
```

- `<id>` — UUID of the requirement to update (src/cli/index.ts:239).
- `<attr>` — attribute to set (src/cli/index.ts:240).
- `[value]` — new value; omit and pass `--clear` to remove an optional attr (src/cli/index.ts:241).
- `--file <path>` — document path override (src/cli/index.ts:242).
- `--clear` — clear (remove) an optional attribute instead of setting a value (src/cli/index.ts:243).

Patches exactly one typed attribute. Editing a structural EARS slot (`patternType`, `preCondition`, `trigger`, `systemName`, `systemResponse`) re-renders the canonical sentence; metadata edits do not. Clearing a required attribute errors; the literal string `"null"` is stored as text. Idempotent: re-applying the same set is a no-op (src/cli/descriptions.ts:80-88).

Envelope `type`: `update`.

## parse

```
symspec parse [text] [--file <path>] [--stdin]
```

- `[text]` — a single requirement sentence to parse (one-element batch) (src/cli/index.ts:272).
- `--file <path>` — read requirement lines (one per line) from a file (src/cli/index.ts:273).
- `--stdin` — read requirement lines (one per line) from stdin (src/cli/index.ts:274).

Exactly one input source is required; supplying none is an `ERR_USAGE` failure (src/cli/index.ts:750-763). Each line runs the Tier-1 regex cascade, escalating to the Tier-2 wink-nlp parser and, on hard failure, a Tier-3 structured error carrying a stable `ERR_PARSE_*` code, recovered partial slots, and rewrite suggestions. A no-modal line is reported as skipped. Returns per-line results plus an `{ok, skipped, error}` summary. Read-only (src/cli/descriptions.ts:90-96).

Envelope `type`: `parse`.

## check

```
symspec check [file] [--solver <backend>] [--semantic] [--emit-smt2 <path>] ...
```

- `[file]` — path to the requirements document (src/cli/index.ts:293).
- `--similarity-threshold <n>` — pairwise lexical-similarity threshold, 0..1 (src/cli/index.ts:294).
- `--timeout-ms <n>` — per-group solver timeout in ms (default 2000) (src/cli/index.ts:295).
- `--solver-budget-ms <n>` — whole-run solver budget in ms; the `ERR_SOLVER_TIMEOUT` boundary (src/cli/index.ts:296, src/cli/manifest.ts:146-151).
- `--emit-smt2 <path>` — also write the portable SMT-LIB2 artifact for the included requirements (src/cli/index.ts:297-300, src/cli/index.ts:373-378).
- `--solver <backend>` — formal backend: `z3-wasm` (default, in-process WASM) | `z3-bin` | `cvc5` (external binary cross-check). An unknown value is an `ERR_USAGE`; a missing binary is `ERR_SOLVER_MISSING` surfaced before any check runs, carrying the backend's mise-install suggestion (src/cli/index.ts:301-305, src/cli/index.ts:335-345, src/cli/index.ts:406-410).
- `--solver-path <path>` — explicit path to an external z3/cvc5 binary (implies the binary backend) (src/cli/index.ts:305, src/cli/index.ts:335-336).
- `--semantic` — opt-in: embed responses with the local BGE-ONNX model to PROPOSE glossary merges for paraphrased conflicts. The model is loaded lazily and only under this flag; an unloadable model surfaces `ERR_EMBED_MODEL_MISSING` before the run (src/cli/index.ts:306-309, src/cli/index.ts:353-366).
- `--semantic-threshold <n>` — cosine threshold for `--semantic` (default 0.82) (src/cli/index.ts:310).

Wires all tiers into one pass: Tier-0 structural checks (dangling refs, missing pattern-required slots, `derives`-DAG cycles, orphans), INCOSE GtWR + free-tier lint rules, and the in-process SMT formal tier. Sound modulo atomization: every reported conflict is real, but silence is not a consistency certificate. Read-only. Exit `0` = no error finding, `1` = pass/fail gate failed on findings, `2` = operational error (src/cli/descriptions.ts:98-108, src/cli/exit.ts:149-157). The success payload may also carry `emittedSmt2` and `binaryCrossCheck` (src/cli/index.ts:397-404).

Envelope `type`: `check`.

## certify

```
symspec certify [file] [--out-dir <path>]
```

- `[file]` — path to the requirements document (src/cli/index.ts:423).
- `--out-dir <path>` — directory for the retained `.lean` artifact on success (src/cli/index.ts:424).

Emits one batched core-Lean file (no Mathlib, no lake), runs it through `lean --json`, and maps the result to `FND_CERTIFIED` (with `#print axioms` provenance) or `FND_CERTIFY_FAILED`. Strictly opt-in; the default `check` never invokes Lean. A missing toolchain returns `ERR_LEAN_TOOLCHAIN_MISSING` and never affects any prior SMT result (src/cli/descriptions.ts:109-116, src/cli/index.ts:434-438). Scope note (v2): each requirement is emitted as a placeholder `True` theorem, so the certificate attests only that the toolchain ran and the file elaborates — it does not yet encode requirement semantics (src/cli/index.ts:449-456, src/cli/index.ts:780-793).

Envelope `type`: `certify` (`{certified, findings}`) (src/cli/index.ts:466).

## list

```
symspec list [file]
```

- `[file]` — path to the requirements document (src/cli/index.ts:478).

Lists every current requirement with its `id`, `patternType`, `priority`, `status`, and rendered `sentence` — enough to scan the spec without fetching every full node. Read-only and idempotent (src/cli/index.ts:485-492, src/cli/descriptions.ts:117-121).

Envelope `type`: `list`.

## show

```
symspec show <id> [--file <path>]
```

- `<id>` — UUID of the requirement to show (src/cli/index.ts:499).
- `--file <path>` — document path override (src/cli/index.ts:500).

Prints the full record of one requirement (all slots, metadata, outbound edges). Errors when the id does not resolve. Read-only and idempotent (src/cli/index.ts:507-509, src/cli/descriptions.ts:123-126).

Envelope `type`: `show`.

## derive

```
symspec derive <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (decomposes into the target) (src/cli/index.ts:516).
- `<toId>` — target requirement UUID (src/cli/index.ts:517).
- `--file <path>` — document path override (src/cli/index.ts:518).

Adds a `derives` edge. The `derives` DAG must stay acyclic (cycles are surfaced by `check`). Idempotent — the same edge twice yields one edge. Errors when the source does not exist; fails fast with `ERR_NOT_FOUND` rather than an untyped throw (src/cli/descriptions.ts:128-133, src/cli/index.ts:816-817).

Envelope `type`: `derive` (`{from, relation, to, added}`) (src/cli/index.ts:822).

## satisfy

```
symspec satisfy <fromId> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (satisfies the target goal) (src/cli/index.ts:527).
- `<toId>` — target requirement UUID (src/cli/index.ts:528).
- `--file <path>` — document path override (src/cli/index.ts:529).

Adds a `satisfies` edge linking an implementation-level requirement back to a higher-level goal. Idempotent. Errors when the source does not exist (src/cli/descriptions.ts:135-139).

Envelope `type`: `satisfy` (`{from, relation, to, added}`) (src/cli/index.ts:822).

## remove-edge

```
symspec remove-edge <fromId> <relation> <toId> [--file <path>]
```

- `<fromId>` — source requirement UUID (src/cli/index.ts:538).
- `<relation>` — edge relation: `derives|satisfies|verifies|refines` (src/cli/index.ts:539).
- `<toId>` — target requirement UUID (src/cli/index.ts:540).
- `--file <path>` — document path override (src/cli/index.ts:541).

Removes a typed directional edge. No-op if the edge is absent (including when the source was already deleted) — safe to call defensively. Does not delete either endpoint node (src/cli/descriptions.ts:141-146, src/cli/index.ts:558-568).

Envelope `type`: `remove-edge` (`{from, relation, to, removed}`) (src/cli/index.ts:567).

## delete

```
symspec delete <id> [--file <path>]
```

- `<id>` — UUID of the requirement to delete (src/cli/index.ts:580).
- `--file <path>` — document path override (src/cli/index.ts:581).

Tombstones a requirement. Inbound edges from survivors become dangling references (not auto-removed); run `check` afterward to find them. Deleting a missing id leaves the document unchanged rather than erroring (src/cli/descriptions.ts:147-153, src/cli/index.ts:588-591).

Envelope `type`: `delete` (`{id, deleted}`) (src/cli/index.ts:591).

## export

```
symspec export [file]
```

- `[file]` — path to the requirements document (src/cli/index.ts:601).

Exports the requirements graph to SysML-v2-flavored JSON: each requirement becomes a `RequirementUsage`, each edge a typed relationship (`DeriveRequirement`, `Satisfy`, `Verify`, `Refine`). Read-only (src/cli/descriptions.ts:154-158, src/cli/index.ts:607).

Envelope `type`: `export`.

## glossary (add / remove / list)

```
symspec glossary add <canonical> <alias> [--file <path>]
symspec glossary remove <canonical> <alias> [--file <path>]
symspec glossary list [--file <path>]
```

- `add <canonical> <alias>` — add an alias phrasing under a canonical phrase (idempotent) (src/cli/index.ts:615-629).
- `remove <canonical> <alias>` — remove an alias from a canonical group (no-op if absent) (src/cli/index.ts:631-645).
- `list` — list the committed synonym groups (read-only) (src/cli/index.ts:647-656).
- `--file <path>` — document path override on each subcommand (src/cli/index.ts:620, src/cli/index.ts:636, src/cli/index.ts:650).

The formal tier canonicalizes response atoms through this glossary, so agent-confirmed synonyms collide on one atom and a paraphrased contradiction becomes provable by `check`. This is the DECIDE half of the semantic tier: `check --semantic` only PROPOSES entries (`FND_SIMILAR_SEMANTIC`); confirming them here changes a verdict. Mutating ops re-save the document (src/cli/descriptions.ts:160-166).

## download-model

```
symspec download-model
```

No arguments (src/cli/index.ts:661-672). Pre-fetches and caches the semantic tier's embedding model so `check --semantic` runs fully offline afterward. Downloads the pinned `Xenova/bge-base-en-v1.5` model (~110 MB) plus its two tokenizer files from a frozen HuggingFace revision, verifying every asset against a pinned sha256 so a corrupt or tampered download fails instead of poisoning embeddings (src/cli/descriptions.ts:167-172, src/formal/model-cache.ts:40-75, src/formal/model-cache.ts:218-237). Idempotent: already-cached-and-valid assets are reported and skipped; the report carries `model`, `revision`, `cacheDir`, per-asset `{name, bytes, cached}`, and `alreadyComplete` (src/formal/model-cache.ts:197-236). A fetch/verify failure surfaces `ERR_EMBED_MODEL_MISSING` (src/cli/index.ts:669-670).

Envelope `type`: `download-model`.

## Global flags

Every command inherits these output-shaping flags; they change rendering only, never the data or the exit code (src/cli/index.ts:137-141, src/cli/exit.ts:35-38). The manifest surfaces them once under `globalOptions` (src/cli/manifest.ts:176-196).

- `--json` — no-op alias for the default JSON envelope output (src/cli/index.ts:137).
- `--pretty` — render human-readable prose instead of the default JSON envelope (src/cli/index.ts:138).
- `--human` — alias of `--pretty` (src/cli/index.ts:139).
- `--dense` — minified, default/null-omitting, evidence-elided JSON (src/cli/index.ts:140, src/cli/index.ts:91-95).
- `--evidence` — keep the heavy evidence/atom-table fields under `--dense` (src/cli/index.ts:141).
- `--version` / `-V` — print `package.json`'s version and exit 0 (src/cli/index.ts:135, src/cli/index.ts:854-859).
- `--help` — commander help, exit 0 (src/cli/index.ts:854-859).

Bad arguments (unknown command, missing required arg, unknown option) are translated into an `ERR_USAGE` envelope on stdout rather than a commander stack trace (src/cli/index.ts:142-152, src/cli/index.ts:848-868).

## Environment variables

- `SYMSPEC_DOC` — default document path, second in the resolution precedence after the positional/`--file` argument and before `./requirements.json` (src/cli/manifest.ts:79-103).
- `SYMSPEC_MODEL_DIR` — override for the embedding-model cache directory; takes precedence over `XDG_CACHE_HOME` and `~/.cache` (src/formal/model-cache.ts:101-109).
- `XDG_CACHE_HOME` — model cache base when `SYMSPEC_MODEL_DIR` is unset, before falling back to `~/.cache` then the OS temp dir (src/formal/model-cache.ts:104-108).
- `SYMSPEC_EMBED_ALLOW_REMOTE=1` — allows the semantic tier to fetch missing model assets over the network at check time; default OFF, so an absent cache surfaces `ERR_EMBED_MODEL_MISSING` and never blocks the SMT/lint tiers. `download-model` always allows remote regardless (src/formal/model-cache.ts:22-27, src/formal/model-cache.ts:218-226).
</content>
