# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A deterministic spec validator built for coding agents.** Write software
requirements in [EARS](https://alistairmavin.com/ears/) form; symspec parses
them, lints them against the INCOSE *Guide to Writing Requirements*, and
**formally proves** conflicts — contradictions, subsumption, redundancy,
numeric and temporal clashes — with a Z3 SMT solver, handing back the exact
requirement IDs at fault and a machine-checkable unsat core. Every command
answers in a typed JSON envelope with stable, branchable codes. No prose to
scrape, no guessing whether you succeeded.

> "I authored a 25-requirement architecture spec in a single atomic `symspec
> apply` batch — every requirement, every `derives` edge, stable human keys
> resolving forward before the UUIDs existed — and it either all landed or none
> of it did. Then `check` handed me stable error codes with character spans and
> rewrite suggestions I could act on without guessing, `waive` let me suppress
> 122 intentional style findings with a recorded reason so the baseline reads as
> triage instead of neglect, the semantic tier flagged one genuinely-similar
> pair and I kept it distinct on purpose, and `certify` kernel-checked the whole
> thing in Lean. It's the first spec tool I've used that's built for an agent to
> drive: JSON envelopes everywhere, honest about what each tier does and doesn't
> guarantee, and it never made me parse prose to find out whether I'd succeeded.
> It turned spec authoring from a hundred fragile subprocess calls into a
> handful of clean, verifiable moves."
>
> — *An Opus 4.8 Claude Code agent*

## Quick start

```bash
# Install the CLI globally
git clone https://github.com/theagenticguy/symspec.git && cd symspec
pnpm install && pnpm build && pnpm pack
npm install -g ./symspec-*.tgz     # exposes the `symspec` bin on PATH
```

Author and check a spec. Every command prints a JSON envelope to stdout by
default — no flag needed.

```console
$ symspec init reqs.symspec.json
$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "grant access" --trigger "the user submits valid credentials"
$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "revoke access" --trigger "the user submits valid credentials"

$ symspec check reqs.symspec.json
```

Those two requirements contradict — `grant access` vs `revoke access` resolve to
the same atom at opposite polarity — and `check` proves it, naming exactly the
two culprits with the atom table and unsat core as evidence:

```jsonc
{
  "apiVersion": 1,
  "type": "check",
  "data": {
    "findings": [
      {
        "code": "FND_CONTRADICTION",
        "severity": "error",
        "tier": "formal",
        "requirementIds": ["586d8933-…", "d50c8fff-…"],
        "message": "Requirements 586d8933…, d50c8fff… cannot all hold: their responses resolve to the same atom with opposite polarity under a reachable context.",
        "evidence": {
          "atomTable": [ /* every atom the solver compared */ ],
          "core":      [ "586d8933-…", "d50c8fff-…" ]
        }
      }
    ],
    "pairsChecked": 1,
    "counts": { "error": 1, "warn": 0, "info": 0 }
  }
}
# exit code 1 — an error-severity finding is present
```

The exit code *is* the gate: `0` clean (or only `warn`/`info`), `1` an
`error`-severity finding is present (the envelope is still on stdout — the
findings are the data), `2` an operational error (`ERR_*`). That's the whole
pass/fail contract an editing loop or CI needs.

**Let your agent discover it.** `symspec install` drops a skill file into
whatever coding-agent host is present — Claude Code (`.claude/skills/`), Cursor
and Codex (`.agents/skills/`), Kiro, Windsurf, Copilot — so the agent learns to
drive symspec on its own. It never edits your `CLAUDE.md` / `AGENTS.md`. And
`symspec manifest` emits the entire command surface as one JSON blob an agent
fetches once and never has to guess at again.

---

## Who is this for?

**Coding agents that write specs — and the humans who supervise them.**

Requirements are where software goes wrong before a line of code is written: two
requirements quietly contradict, a "shall" hides a compound clause, a latency
bound says `≤ 2000ms` in one place and `> 3s` in another. Humans miss these; so
do LLMs asked to "review the spec" in prose. symspec makes the check
*mechanical* — a solver either proves a conflict or it doesn't, and when it
does, it hands you the culprits and the evidence instead of a paragraph of
hedging.

It is built so an agent can drive it with zero trial-and-error:

- **One call to learn everything.** `symspec manifest` returns every command,
  every argument schema, every stable error/finding code, and a live report of
  which backends are installed. The agent queries, then decides — it never
  fails-then-learns.
- **Nothing to parse.** Success is `{ apiVersion, type, data }`; failure is
  `{ ..., code, suggestions }`. The agent branches on a code, never on an
  English sentence.
- **Author in one atomic move.** `symspec apply` folds a whole JSONL batch of
  operations — adds, edges, updates — into a single transaction with stable
  human keys (`G1`, `AUTH-3`) that resolve forward within the batch. It all
  lands or none of it does. No hundred-subprocess ceremony, no UUID sidecar file.
- **Honest about its own limits.** Every tier states what it does and does not
  guarantee, in the manifest, in machine-readable form. A clean `check` means
  "no conflict was *proven*", never "the spec is proven consistent" — and
  symspec says so.

Humans get the same thing through `--pretty`, and the whole surface is an
importable TypeScript library, not just a CLI.

---

## The power under the hood

symspec is **neurosymbolic**: a fast deterministic core, with an optional
learned tier that only ever *proposes* — never decides. Given a document, its
committed glossary, and the pinned model, every verdict reproduces byte-for-byte.

| Engine | What it proves | Backend |
|---|---|---|
| **Parse ladder** | prose → EARS slots, or a structured error with a rewrite | regex-first; `wink-nlp` only on escalation — clean sentences never load a model |
| **Structural + GtWR lint** | dangling refs, cycles, missing slots, 24 INCOSE writing rules | pure regex/lexicon; character spans + rewrite suggestions |
| **SMT formal tier** | contradiction, subsumption, redundancy, vacuity | **Z3, in-process (WASM)** — no external binary required; minimal unsat core on every finding |
| **Numeric tier** | jointly-unsatisfiable quantity bounds (`latency ≤ 2s ∧ latency > 3s`) | Z3 over linear integer/real arithmetic (LIA/LRA) |
| **Temporal tier** | ordering/liveness conflicts ("eventually open" vs "never open") | EARS → LTL → bounded finite-trace SMT on Z3; sound-for-UNSAT |
| **Ambiguity family** | vague terms, quantifier/coordination scope, dangling pronouns | deterministic detectors; pragmatic ambiguity is *flagged for review*, never guessed |
| **Semantic tier** *(opt-in)* | paraphrased conflicts a lexical check misses | **local `bge-base-en-v1.5` on `onnxruntime-web` (WASM)** — no network at verdict time, no external API; *proposes* glossary merges, SMT decides |
| **Lean 4 certify** *(opt-in)* | a kernel-checked proof artifact with `#print axioms` provenance | `lean --json`; retains a re-checkable `.lean` + pinned toolchain |

The load-bearing design rule ties it together: **a verdict-eligible finding must
recompute bit-identically from `(document + committed glossary + pinned model)`.
Everything fuzzier is `info` and proposes; it never decides.** The one learned
step — embeddings — runs once, is reviewed by a human or agent, and its outcome
is committed to git as a glossary. Determinism is never traded for recall.

Across the surface: **19 commands**, **21 `ERR_*` + 24 `GTWR_*` + 26 `FND_*`**
stable codes (append-only, snapshot-guarded), a self-describing manifest, typed
JSON envelopes, a `--dense` token-lean output mode, a POSIX exit-code contract,
and a generative-adversarial test harness that keeps the detectors honest.

Everything below is how it works.

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

**Honest scope.** The propositional SMT tier is **sound modulo atomization**:
every reported conflict is a genuine logical conflict of the requirements *as
atomized*. The dual is the honest limit — because paraphrases become distinct
atoms, a real conflict can hide behind unmatched atoms, so **silence is not a
consistency certificate**. The one false-positive risk is over-unification,
held back by the conservative normalization and the `FND_SIMILAR_UNUNIFIED`
reporter. The propositional stage itself evaluates one snapshot with no
arithmetic or ordering — but that boundary is now covered by dedicated tiers:
**numeric/arithmetic conflicts are checked** over LIA/LRA
(`FND_NUMERIC_CONTRADICTION`), **temporal/ordering conflicts** under `--temporal`
(`FND_TEMPORAL_CONTRADICTION`, sound-for-UNSAT), and **deterministic ambiguity
detectors** (vague terms, quantifier/coordination scope, referential ambiguity)
run and report — only *pragmatic/contextual* ambiguity is punted to the calling
agent as `FND_AMBIGUITY_NEEDS_JUDGMENT`, and any LLM ambiguity judgment is
propose-only. The v3 tiers are detailed below. This same scope text is surfaced,
claim-by-claim, in the `manifest` command's `scope` field (the exact strings
live in `src/cli/scope-text.ts` and are pinned by a schema so the disclosure
cannot drift). A per-group solver `unknown`/timeout emits `FND_NEEDS_REVIEW` and
the run continues — an inconclusive result is never read as "no conflict".

Portability: `--emit-smt2` writes a standard-conformant SMT-LIB2 artifact (with
`(set-logic ALL)`, no solver-specific prelude) you can hand to any compliant
reader; `--solver-path`/`SYMSPEC_Z3`/a PATH `z3`/`cvc5` runs that binary as an
optional cross-check.

#### v3 tiers — numeric, ambiguity, temporal, and the requirement graph

Four v3 capabilities close the honest-scope limits the propositional SMT tier
disclaims, all under the same discipline: **a verdict-eligible finding must
recompute bit-identically from `(doc + committed glossary + pinned model)`;
everything fuzzier is `info` and proposes, never decides.**

- **Numeric/arithmetic conflicts (`src/formal/numeric.ts`, deterministic, default
  on).** A regex/lexicon extractor lifts `(quantity, comparator, value, unit)`
  from slot text with unit normalization (s→ms, kb→B) and per-system
  quantity-identity; jointly-unsatisfiable bounds on one quantity (e.g. `latency
  ≤ 2000ms ∧ latency > 3000ms`) prove UNSAT over Z3's LIA/LRA and surface as
  `FND_NUMERIC_CONTRADICTION` with the minimal unsat core. Runs over ALL
  requirements — a lint warning never hides a real numeric conflict.
- **Ambiguity family (`src/formal/ambiguity.ts`, deterministic, default on).**
  `FND_AMBIGUOUS_VAGUE` (short high-precision weasel lexicon),
  `FND_AMBIGUOUS_QUANTIFIER` (un-parenthesized `and/or`, leading `all/each`),
  `FND_AMBIGUOUS_REFERENCE` (a pronoun with ≥2 antecedents — detected, not
  resolved), and `FND_AMBIGUITY_NEEDS_JUDGMENT` (a structured hand-off for
  pragmatic ambiguity an LLM/agent reviews — the punt is surfaced, not silent).
- **Temporal/ordering (`src/formal/temporal.ts`, opt-in `--temporal`).** EARS
  patterns map to LTL (Dwyer/SPS via FRET semantics) and lower to a bounded
  finite-trace SMT encoding on the in-process Z3-WASM; temporally-unsatisfiable
  sets (e.g. "eventually open the valve" vs "never open the valve") surface as
  `FND_TEMPORAL_CONTRADICTION`. **Sound-for-UNSAT**: a reported conflict is real;
  a `sat`-at-bound-`k` result is not a consistency certificate (`{bound, complete:
  false}` in the evidence).
- **Requirement similarity graph + DAG (`src/formal/graph.ts`, opt-in with
  `--semantic`).** A deterministic kNN graph (batch-invariant embedder, cosine
  quantized before threshold, id tie-breaks, union-find clustering) proposes
  `FND_MISSING_TRACE_LINK` (a high-cosine pair with no committed edge) and
  `FND_DUPLICATE_CLUSTER` — info only, because trace-link precision is too low to
  auto-commit. The structural analyzer adds the KAOS/SysML
  `FND_LEAF_UNVERIFIABLE` invariant (a refinement leaf with no verify edge).

A generative-adversarial harness (`adversarial/`) generates increasingly subtle
BAD specs across all five defect classes and scores symspec on detection +
localization, escalating difficulty with a gap report — a standing regression
gate that the deterministic tiers catch 100% of, and 20/20 across four tiers with
the real embedding model.

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
                       # numeric tier (v3.0) — numeric (predicate extraction),
                       #   numeric-contradiction (LIA/LRA joint-SAT, default on)
                       # ambiguity tier (v3.1) — ambiguity (vague/quantifier/reference, default on)
                       # temporal tier (v3.3) — temporal-patterns (EARS→LTL),
                       #   temporal (bounded LTL→SMT, opt-in --temporal)
                       # semantic + graph (v3.1–v3.2) — embed (onnxruntime-web WASM + tokenizer),
                       #   model-cache (fetch + sha256-verify + cache), semantic (paraphrase finder),
                       #   graph (deterministic kNN trace-link/duplicate proposals, opt-in --semantic)
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
adversarial/           # generative-adversarial detection harness (v3.4):
  generate.ts          #   bad-spec generator across five defect classes, escalating difficulty
  harness.ts           #   scores symspec on detection + localization, gap report
scripts/
  gen-agents.ts        # regenerates AGENTS.md from buildManifest() (pnpm check:agents guards drift)
  temporal-feasibility.ts # v3.3 gate: Z3-WASM bounded-LTL feasibility benchmark
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
