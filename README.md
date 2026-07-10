# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A deterministic neurosymbolic spec validator, built agent-first.** Hand it EARS-shaped requirement prose or structured slots; get back provable conflict findings with the exact requirement IDs responsible. symspec parses requirements into EARS slots (regex-first, no model calls), lints them against the INCOSE Guide to Writing Requirements, and formally checks the set for contradictions, subsumption, redundancy, and vacuity using an in-process Z3 SMT solver — every conflict backed by a minimal unsat core you can audit. An optional semantic tier bridges paraphrased conflicts a lexical check would miss, using a **local ONNX-WASM embedding model** (no network calls at verdict time, no external API) that only ever *proposes* glossary merges — the deterministic SMT stage decides. It is a CLI and an importable TypeScript library whose primary consumer is a coding agent: every command emits a typed JSON envelope with stable error and finding codes, a self-describing `manifest`, and a POSIX exit-code contract. Given a document, its committed glossary, and the pinned model, every verdict is reproducible byte-for-byte — the fuzzy step runs once, is reviewed, and is versioned in git.

## Quick start

```bash
pnpm install       # install dependencies
pnpm build         # compile src/ to dist/ (tsdown)
pnpm test          # vitest unit tests (the AC verification suite)
pnpm check         # full quality gate: biome ci + tsc + vitest + knip
```

Install it globally as a CLI:

```bash
pnpm build && pnpm pack           # produces symspec-<version>.tgz
npm install -g ./symspec-*.tgz    # exposes the `symspec` bin
```

Then `init` a document, `add` requirements, and `check` the set. Every command
prints a typed JSON envelope to stdout by default — no flag needed.

```console
$ symspec init reqs.symspec.json
{
  "apiVersion": 1,
  "type": "init",
  "data": {
    "path": "/work/reqs.symspec.json",
    "created": true
  }
}

$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "grant access" --trigger "the user submits valid credentials"
{
  "apiVersion": 1,
  "type": "add",
  "data": {
    "id": "586d8933-44ed-4100-af27-f365b5804e7d",
    "requirement": {
      "id": "586d8933-44ed-4100-af27-f365b5804e7d",
      "patternType": "event-driven",
      "systemName": "auth service",
      "systemResponse": "grant access",
      "sentence": "When the user submits valid credentials, the auth service shall grant access.",
      "priority": "medium",
      "status": "draft",
      "derives": [],
      "satisfies": [],
      "verifies": [],
      "refines": [],
      "trigger": "the user submits valid credentials"
    }
  }
}
```

Add a second, conflicting requirement and `check` finds the contradiction —
`grant access` vs `revoke access` unify to the same atom with opposite polarity
via the seed antonym table, and the finding names exactly the two culprits with
the atom table and unsat core as evidence:

```console
$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "revoke access" --trigger "the user submits valid credentials"
# → { "type": "add", "data": { "id": "d50c8fff-…", … } }

$ symspec check reqs.symspec.json
{
  "apiVersion": 1,
  "type": "check",
  "data": {
    "findings": [
      {
        "code": "FND_CONTRADICTION",
        "severity": "error",
        "tier": "formal",
        "requirementIds": [
          "586d8933-44ed-4100-af27-f365b5804e7d",
          "d50c8fff-0917-4119-a7e8-5374c99a977c"
        ],
        "message": "Requirements 586d8933…, d50c8fff… cannot all hold: their responses resolve to the same atom with opposite polarity under a reachable context.",
        "evidence": {
          "atomTable": [
            { "atom": "sys__auth_service__trig__user_submits_valid_credentials", "kind": "trig", "slotText": "the user submits valid credentials", "negated": false },
            { "atom": "sys__auth_service__resp__grant_access", "kind": "resp", "slotText": "grant access", "negated": false },
            { "atom": "sys__auth_service__resp__grant_access", "kind": "resp", "slotText": "revoke access", "negated": true }
          ],
          "core": [
            "586d8933-44ed-4100-af27-f365b5804e7d",
            "d50c8fff-0917-4119-a7e8-5374c99a977c"
          ]
        }
      }
    ],
    "excluded": [],
    "pairsChecked": 1,
    "counts": { "error": 1, "warn": 0, "info": 0 }
  }
}
# exit code 1 — an error-severity finding is present
```

`check` exits `0` when clean (or only `warn`/`info` findings), `1` when an
`error`-severity finding is present (the envelope is still on stdout — the
findings are the data), and `2` on an operational error (`ERR_*`). That is the
whole pass/fail gate an editing or CI loop needs.

You do not have to hand-author slots. Feed prose — one line, a `--file`, or
`--stdin` — and symspec returns structured slots, a `skipped` marker for
no-obligation prose, or a Tier-3 error with a stable `ERR_PARSE_*` code and a
mechanical rewrite suggestion:

```console
$ printf 'The auth service shall reject expired tokens.\nFast response times are important.\nThe API shall log requests and the API shall reject bad input.\n' \
    | symspec parse --stdin
{
  "apiVersion": 1,
  "type": "parse",
  "data": {
    "results": [
      { "outcome": "ok", "pattern": "ubiquitous", "slots": { "patternType": "ubiquitous", "systemName": "auth service", "systemResponse": "reject expired tokens" }, "negated": false, "confidence": "high", "tier": 1, "notes": [] },
      { "outcome": "skipped", "reason": "no-modal", "text": "Fast response times are important." },
      { "outcome": "error", "code": "ERR_PARSE_COMPOUND", "error": "Compound requirement with top-level \"and\"/\"or\" conjunction: …", "partial": { "patternType": "ubiquitous", "systemName": "API", "systemResponse": "log requests and the API shall reject bad input" }, "suggestions": [ "Split into separate requirements at each \"and\" or \"or\" conjunction.", "Each requirement must contain exactly one \"shall\" clause (one system, one response).", … ] }
    ],
    "summary": { "ok": 1, "skipped": 1, "error": 1 }
  }
}
```

That is the whole user-facing surface. Everything below is how it works.

---

## The pipeline

symspec runs a **forced pipeline** — `parse → lint → check → certify` — and the
order is load-bearing. A statement that fails an earlier surface stage is
*excluded* from the formal stage, because feeding unparsed or dangling-reference
text into an SMT encoding is unsound. The exclusion is reported in the `check`
envelope's `excluded[]` so nothing disappears silently. An opt-in **semantic
tier** (`--semantic`) runs alongside the formal stage to surface paraphrased
conflicts, and an opt-in **Lean 4 certification** tier runs only on demand.

### 1. Parse — prose → EARS slots (regex-first ladder)

`src/parse/`. A three-stage ladder that escalates only as far as it must:

- **Tier 1** (`tier1.ts`) — a zero-dependency regex cascade classifies input by
  leading EARS keyword in the ordered rungs `complex → unwanted (if…then) →
  event (when) → state (while) → optional (where) → ubiquitous`. Each rung
  matches only if the mandatory main clause `(?:the )?<system> shall <response>`
  parses; otherwise it falls through. Preprocessing strips REQ-ID prefixes
  (`REQ-042:`), normalizes unicode quotes, and collapses whitespace
  (`preprocess.ts`); event synonyms (`upon`, `once`, `as soon as`) and
  non-`shall` modals (`must`, `will`, `should`) normalize to canonical form with
  a downgraded-confidence provenance note (`normalize.ts`); explicit negators
  (`shall not store …`) set `negated: true` and retain the *positive* response
  atom (`negation.ts`), so the formal stage receives `¬R`, not a string
  containing "not".
- **Tier 2** (`tier2.ts`) — on escalation only (no rung matched, comma/second
  keyword in the system group, passive main clause, >60 tokens, top-level
  `and`/`or`), symspec lazily imports the `wink-nlp` POS parser and attempts
  clause repair. Clean sentences never load the model.
- **Tier 3** (`tier3.ts`) — if neither tier yields a full-slot parse, symspec
  returns a structured error envelope with a stable `ERR_PARSE_*` code, the
  partial slots it recovered, and mechanical rewrite suggestions — never a
  low-confidence guess. Every parse produces a `ParseResult` discriminated on
  `outcome`: `ok` | `skipped` (no-modal prose) | `error`.

### 2. Lint — GtWR rules + free-tier heuristics

`src/lint/` and `src/solvers/free/`. Two deterministic surface passes:

- **Structural (Tier 0)** — `src/core/analyze.ts` runs over a plain-object
  snapshot: `FND_DANGLING_REFERENCE`, `FND_MISSING_TRIGGER`,
  `FND_MISSING_PRECONDITION`, `FND_CYCLE` (cycles deduped by canonical
  rotation), `FND_ORPHAN`.
- **GtWR lint** — `src/lint/gtwr.ts` implements the ~24 regex/lexicon-checkable
  INCOSE *Guide to Writing Requirements* v4 rules. Each finding carries a stable
  `GTWR_R<n>_<slug>` code, a severity (`error` | `warn` | `info`), the offending
  character span, and a rewrite suggestion where one is defined. Rules with
  legitimate exceptions (absolutes, universal quantifiers, negation inside a
  defined logical expression) emit at `warn` — excluded from the pass/fail gate.
  Exact-duplicate detection (slot-tuple hash) and the weasel-word lexicon scan
  run alongside (`src/solvers/free/`).

The gate (`src/pipeline/gate.ts`) partitions requirements: any statement with an
`error`-severity surface finding is marked excluded and never reaches the SMT
stage.

### 3. Check — SMT formal conflict detection with unsat cores

`src/formal/`. The heart of the tool. Runs in-process on the `z3-solver` WASM
package — **no external binary is required for a working `symspec check`**.

- **Atomization** (`atomize.ts`, `antonyms.ts`) — the load-bearing contract.
  A single pure `atomize` function derives Boolean atoms with a conservative,
  near-exact normalization: lowercase → strip leading articles → strip
  punctuation → collapse whitespace → underscore-join. It does **not** stem,
  lemmatize, or strip stopwords beyond leading articles. Every atom is scoped
  per `systemName`, so identical response text under two systems yields two
  distinct atoms and never manufactures a cross-system conflict. Negation lands
  on the *same* atom with opposite polarity, and a 15-pair seed antonym table
  (`accept↔reject`, `grant↔revoke`, `enable↔disable`, …) unifies polar opposites.
- **Encoding** (`encode.ts`) — each requirement becomes a guarded implication
  with an assumption literal, `REQ-i ⇒ (context ⇒ response)`. The encoder is a
  pure, unit-tested function separate from the solver call.
- **Findings** — contradiction (`contradiction.ts`) runs per-context-group
  reachability over the *whole* spec and, on `unsat`, extracts the **minimal**
  unsat core, filters context assertions, and emits `FND_CONTRADICTION` with
  exactly the responsible `REQ-*` ids. Subsumption/redundancy
  (`subsumption.ts`) decide directional implication over pairwise candidates;
  vacuity (`vacuity.ts`) is relational across the whole spec; a completeness
  heuristic (`incomplete.ts`) emits `FND_INCOMPLETE` (info); a Jaccard pass
  (`similar.ts`) emits `FND_SIMILAR_UNUNIFIED` (info) to flag near-synonyms the
  antonym table missed. Every formal finding carries an `evidence` field
  (`finding.ts`) with the atom table and the core/witness, so the agent can
  audit exactly what the solver compared.

**Honest scope.** The formal tier is **sound modulo atomization**: every
reported conflict is a genuine logical conflict of the requirements *as
atomized*. The dual is the honest limit — because paraphrases become distinct
atoms, a real conflict can hide behind unmatched atoms, so **silence is not a
consistency certificate**. The one false-positive risk is over-unification,
held back by the conservative normalization and the `FND_SIMILAR_UNUNIFIED`
reporter. **Contextual ambiguity is not checked** — that judgment is punted to
the calling agent. There is no temporal/ordering logic and no numeric/arithmetic
reasoning; the SMT stage evaluates one propositional snapshot. This same scope
text is surfaced in the `manifest` command's `scope` field. A per-group solver
`unknown`/timeout emits `FND_NEEDS_REVIEW` and the run continues — an
inconclusive result is never read as "no conflict".

Portability: `--emit-smt2` writes a standard-conformant SMT-LIB2 artifact (with
`(set-logic ALL)`, no solver-specific prelude) you can hand to any compliant
reader; `--solver-path`/`SYMSPEC_Z3`/a PATH `z3`/`cvc5` runs that binary as an
optional cross-check.

### 4. Semantic — optional paraphrase bridging (local ONNX embeddings)

`src/formal/embed.ts`, `model-cache.ts`, `semantic.ts`. Opt-in with
`check --semantic`; the default `check` never touches it and pays zero cost. The
formal tier is *sound modulo atomization*, so a real conflict can hide when two
responses are worded differently ("issue a session token" vs "issue a login
credential" are distinct atoms). The semantic tier closes that gap **without
breaking determinism**, by splitting PROPOSE from DECIDE:

- **PROPOSE (fuzzy).** For each unmerged same-system response pair, symspec
  embeds both phrasings and, when their cosine similarity clears a threshold
  (default `0.82`, `--semantic-threshold`), emits an info-tier
  `FND_SIMILAR_SEMANTIC` finding suggesting a concrete `symspec glossary add`.
  Never a verdict. The embeddings run on the pinned `bge-base-en-v1.5` model via
  **`onnxruntime-web` (WASM execution provider, single-threaded) with a pure-JS
  tokenizer** — no native `onnxruntime-node` binary, no `@huggingface/transformers`.
  Vectors are CLS-pooled and L2-normalized (how BGE was trained), so cosine is a
  dot product.
- **DECIDE (deterministic).** A committed `glossary` in the document maps aliases
  → a canonical phrasing (`symspec glossary add/remove/list`). `atomize`
  canonicalizes through it *before* the antonym step, so agent-confirmed
  synonyms collide on one atom and the existing SMT contradiction check proves
  the conflict. The verdict path reads the committed glossary, never the model.

The model (~110 MB) is fetched on first use into an OS cache dir and verified
against a pinned sha256, so runs are reproducible after the first fetch and
fully offline thereafter. Pre-warm it with `symspec download-model` (for
air-gapped or CI machines); when the model is absent and remote fetching is
disabled, symspec returns `ERR_EMBED_MODEL_MISSING` and **never blocks the
SMT/lint tiers**, which run independently.

### 5. Certify — optional Lean 4 tier

`src/certify/`. Strictly opt-in and never on the `check` path. `symspec certify`
generates one batched core-Lean file (no Mathlib, no lake), runs it through
`lean --json`, and maps the result to `FND_CERTIFIED` (with `#print axioms`
provenance and a retained, re-checkable `.lean` + pinned `lean-toolchain`
artifact) or `FND_CERTIFY_FAILED`. If no Lean toolchain is discoverable it
returns `ERR_LEAN_TOOLCHAIN_MISSING` with an `elan default stable` suggestion
and never affects any prior SMT result. The default `check` never invokes Lean
and never requires a toolchain.

---

## Agent-friendly surface

symspec is designed to be driven by a coding agent, not scraped from human
prose.

- **`manifest`** — the self-describing command. `symspec manifest` emits, as
  JSON, the full command inventory, per-command argument schemas (derived from
  the same Zod fields the runtime validates against), the stable code catalogs,
  the closed envelope `type` set, the honest-scope disclosure, and a live
  `backends` availability report (z3-wasm, external `z3`/`cvc5`, Lean) with
  resolved paths and versions — so an agent can query-then-decide before
  invoking `certify` or `--solver` rather than fail-then-learn. Fetch it once
  before driving symspec.
- **Typed envelopes** — every success is `{ apiVersion, type, data }`; every
  failure is `{ apiVersion, type: "error", error, code, suggestions, partial? }`.
  Both carry `apiVersion` and a discriminant `type`, so an agent version-
  negotiates and switches on `type` uniformly. `apiVersion` is a distinct
  envelope-contract integer, independent of the package version and the document
  `schemaVersion`.
- **Stable codes** — `ERR_*`, `FND_*`, and `GTWR_*` are three exported Zod
  enums, each with a per-code `.describe()`. They are append-only (a snapshot
  test guards against renumbering or removal) and every error pairs with an
  actionable `suggestions` array. Examples: `ERR_DOC_NOT_FOUND`,
  `ERR_DUPLICATE_ID`, `ERR_PARSE_COMPOUND`, `ERR_SOLVER_MISSING`,
  `ERR_LEAN_TOOLCHAIN_MISSING`, `ERR_EMBED_MODEL_MISSING`. The manifest derives
  its code tables from these same enums, so emitter and docs cannot drift.
- **`--dense`** — token-economical output: minified JSON, keys equal to their
  schema default or `null` omitted, heavy `evidence`/atom-table fields elided
  (pass `--evidence` to keep them). Field names and the typed schema are
  identical to non-dense output, so it validates against the same Zod schema and
  round-trips.
- **Exit codes** — `0` clean (or warn/info only), `1` an `error`-severity
  finding is present (success envelope still on stdout), `2` an `ERR_*`
  operational failure (error envelope on stdout). Output flags never change the
  exit code.
- **Output modes** — the JSON envelope is the zero-flag default. `--json` is a
  no-op compatibility alias; `--pretty` (alias `--human`) opts into prose. An
  agent never needs a flag to get parseable output.
- **Importable library** — the CLI is a thin formatter over `src/index.ts`.
  Anything the CLI does is reachable programmatically:
  `import { applyChange, analyze, runCheck, checkGtWRules, atomize } from 'symspec'`.
  The `exports` map and generated `.d.ts` types ship with the package.
- **`AGENTS.md`** — the agent-integration guide is generated from the same
  `.describe()` corpus that drives the `manifest`, so it stays in lockstep with
  the real command surface. Point your agent at `AGENTS.md` (and `symspec
  manifest`) as the source of truth for the command contract.

---

## Architecture — file map

```
src/
  index.ts             # public library entry (AC-6-5): CLI is a thin formatter over these
  core/
    schema.ts          # Zod schemas (single source of truth) + EARS domain model
    render.ts          # pure renderSentence — sentence is rendered, never authored
    storage.ts         # pretty-printed, sorted-key JSON; atomic temp-file+rename
    load.ts            # load-time Zod validation → ERR_DOC_PARSE / ERR_SCHEMA_VERSION
    doc.ts             # plain-object document model + list/empty helpers
    changes.ts         # Change discriminated union + applyChange (the only mutation path)
    codes.ts           # ERR_* enum + per-code .describe() corpus
    analyze.ts         # Tier-0 structural checks (dangling/missing/cycle/orphan)
    sysml-export.ts    # SysML-v2-flavored JSON projection
  parse/               # NL parse ladder — tier1 regex, tier2 wink-nlp, tier3 error,
                       #   preprocess, normalize, negation, result, batch
  lint/
    gtwr.ts            # ~24 INCOSE GtWR v4 rules (code, severity, span, suggestion)
    codes.ts           # GTWR_* enum + describe corpus
  formal/              # SMT tier — atomize, antonyms, encode, backend (z3 WASM),
                       #   contradiction, subsumption, vacuity, incomplete, similar,
                       #   needs-review, finding (evidence), emit-smt2, binary-backend, codes
                       # semantic tier — embed (onnxruntime-web WASM + tokenizer),
                       #   model-cache (fetch + sha256-verify + cache), semantic (paraphrase finder)
  solvers/
    free/              # exact duplicates, ambiguity (lexical), pairwise candidate filter
    index.ts, types.ts # free+formal orchestrator + shared ReqView/finding types
  pipeline/
    gate.ts            # AC-3-7 exclusion gate (error-severity → excluded from symbolize)
    check.ts           # wires ALL tiers into one `check` envelope; never touches Lean
  certify/             # Lean 4: discover toolchain, emit batched file, run `lean --json`
  cli/
    index.ts           # commander CLI — one spine: resolve → load → run → wrap → render → exit
    manifest.ts        # self-describing manifest from Zod + .describe()
    envelope.ts        # typed success/error envelopes + apiVersion
    descriptions.ts    # single-source command help/summary prose
    output.ts, dense.ts, exit.ts, resolve-doc.ts, errors.ts, version.ts, backends.ts,
    scope-text.ts, types-enum.ts, add.ts, update.ts, glossary.ts
bin/
  symspec.mjs          # CLI entry (imports dist/cli.mjs)
docs/                  # generated codebase docs (architecture, reference, insights) — see docs/README.md
.erpaval/              # see /erpaval below
```

For a deeper tour — module map, data-flow and sequence diagrams, the public API
reference, contract map, and a debugging guide — see the generated documentation
tree under [`docs/`](docs/README.md).

---

## Development

```bash
pnpm install           # from lockfile
pnpm build             # tsdown → dist/ (library entry + CLI entry, with .d.ts)
pnpm cli <command>     # run the CLI from source without building (tsx)
pnpm test              # vitest run — the AC verification suite
pnpm test:watch        # vitest in watch mode
pnpm typecheck         # tsc --noEmit
pnpm lint / lint:fix   # biome check (.) [--write]
pnpm knip              # unused files / deps / exports
pnpm check             # full gate: biome ci + tsc --noEmit + vitest run + knip
```

**Quality gate.** `pnpm check` is the merge gate: `biome ci` clean, `tsc
--noEmit` clean, `vitest run` green, `knip` clean. A non-zero exit on any of the
four is a blocker. Every acceptance criterion's stated verification is
implemented as a test.

**Solvers.** The default `check` needs nothing but the bundled `z3-solver` WASM
package. The optional external binaries are pinned in `mise.toml` (commented out
by default) and installed via mise's `github:` backend — `z3`/`cvc5` for the
`--solver` cross-check, `elan` for the `certify` tier:

```toml
# mise.toml (uncomment to pin locally)
# "z3"   = "github:Z3Prover/z3@z3-4.16.0"
# "cvc5" = "github:cvc5/cvc5@cvc5-1.2.0"
# "elan" = "github:leanprover/elan"
```

`mise run check` mirrors `pnpm check`; `mise run build`/`test`/`lint` map to the
matching pnpm scripts.

---

## /erpaval — captured lessons

This project uses ERPAVal's **lesson capture convention** to record non-obvious tooling and convention decisions that bit us once and would bite us again.

```
.erpaval/
  INDEX.md                          # category-grouped pointers; loaded into Claude's session
  solutions/
    conventions/                    # one .md per lesson
      <slug>.md
```

Claude Code's session-start hook surfaces this index so prior lessons are in context before any work begins. Each lesson file uses front-matter for grep-ability:

```yaml
---
title: <human title>
track: knowledge
category: conventions | architecture | infra | testing
module: <file or area>
component: <tool>
severity: info | medium | high
tags: [<tags>]
applies_when:
  - <triggering condition>
pattern: |
  <prose explanation, with code snippets>
example_files:
  - <path>
---

# Why this matters
# Example
# What NOT to do
```

The current lessons span three categories — `conventions` (tooling edge cases),
`architecture` (design invariants), and `orchestration` (agent-workflow gotchas).
`.erpaval/INDEX.md` is the authoritative, category-grouped list; a representative
sample:

| Lesson | Category | What it captures |
|---|---|---|
| `pnpm11-prepare-script-and-git-init-order.md` | conventions | pnpm 11's `verify-deps-before-run` re-fires `prepare` on every `pnpm exec`; if `prepare` runs `lefthook install` in a non-git directory, every subsequent `pnpm exec` fails opaquely. **Fix**: move hook install to `hooks:install`, set `verify-deps-before-run=false` in `.npmrc`, and add `pnpm.onlyBuiltDependencies` for native builders. |
| `exact-optional-property-types-omit-key-idiom.md` | conventions | With `exactOptionalPropertyTypes: true`, `{ foo?: T }` ≠ `{ foo?: T \| undefined }`. The clean fix is to **omit the key** (build the object, then conditionally assign) or use a conditional spread — never widen the type just to silence the compiler. |
| `transformersjs-cannot-force-wasm-in-node.md` | conventions | `@huggingface/transformers` hard-binds native `onnxruntime-node` at import in Node — `device: 'wasm'` throws. For a genuinely no-native-binary WASM path, drive `onnxruntime-web` directly with a pure-JS tokenizer (what the semantic tier does). |
| `embeddings-propose-smt-decide.md` | architecture | Bridge paraphrased conflicts with embeddings that *propose* a glossary merge while the committed glossary + SMT *decide* — never let a fuzzy cosine touch the verdict, or determinism dies. |
| `manifest-single-source-derivation.md` | architecture | The `manifest`, `AGENTS.md`, and code tables all derive from one Zod `.describe()` + enum corpus; adding a command touches four synced places, and drift is a test failure. |

### When to add a lesson

Add one when **a future you (or a teammate) would lose 15+ minutes** rediscovering the same edge case. Specifically:

- A tool's default behavior interacts badly with another tool's default behavior, and the failure is opaque or silent.
- A strict-mode TypeScript flag has a non-obvious idiom that the official docs underemphasize.
- A package manager / hook tool / linter has version-specific behavior we depend on.
- A workaround that looks weird in the diff and would be reverted by an unsuspecting refactor.

### When NOT to add a lesson

- The fix is obvious from the code or commit message.
- The decision is documented in CLAUDE.md or in the project README's deep dive.
- It's a one-off bug whose fix is in the diff.

### Adding a lesson

1. Drop a new `<slug>.md` under `.erpaval/solutions/<category>/` using the front-matter shape above.
2. Add a one-line pointer to the relevant category in `.erpaval/INDEX.md`.
3. Bump the recent-additions line at the bottom of `INDEX.md` so the next session sees what's new.

The lessons are part of the repo on purpose — they travel with the code and with anyone who clones it.
