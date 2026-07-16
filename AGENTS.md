<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: pnpm gen:agents   (drift fails the pre-push gate) -->

# symspec — agent guide

symspec is a deterministic spec validator built for coding agents: EARS
requirements go in; structural, lint, and formally proven conflict findings
come out. Every command answers in a typed JSON envelope, every error carries
a stable code you can branch on, and this file plus `symspec manifest` are
the complete surface — no other docs are needed to drive the tool.

## Install and discover

```bash
pnpm build && pnpm pack           # produce the tarball from a checkout
npm install -g ./symspec-*.tgz    # 'symspec' lands on PATH
symspec manifest                  # one JSON blob: every command, flag, code
```

The manifest is the machine-readable version of this document: commands with
JSON-Schema argument shapes, the envelope `type` set, all three code
catalogs, backend availability (`symspec manifest` reports whether the
z3/cvc5 binaries or a Lean toolchain are present — the built-in Z3 WASM
backend is always available), and the honest-scope disclosure quoted below.

## Response envelope

Success (stdout, default output — `--json` is a no-op alias):

```json
{ "apiVersion": 1, "type": "<command>", "data": { } }
```

Failure:

```json
{ "apiVersion": 1, "type": "error", "error": "<message>", "code": "ERR_*", "suggestions": ["..."], "partial": { } }
```

- `type` is a closed discriminant set (see the manifest `types` array):
  `manifest`, `init`, `add`, `update`, `parse`, `check`, `certify`, `list`, `show`, `derive`, `satisfy`, `remove-edge`, `delete`, `export`, `error`, `glossary`, `download-model`, `apply`, `waive`, `install`, `antonym`.
- Exit codes: **0** clean (warn/info findings do not fail), **1** at least one
  error-severity finding (success envelope still on stdout), **2** an
  `ERR_*` operational failure (error envelope on stdout).
- `--dense` minifies and strips defaults/evidence for token-lean piping
  (add `--evidence` to keep evidence); `--pretty` renders prose for humans.
- Doc path resolution: positional file → `SYMSPEC_DOC` env → `./requirements.json`.

## Commands

| Command | What it does |
|---|---|
| `symspec manifest` | Emit the self-describing manifest — the whole command surface as one JSON blob. |
| `symspec init` | Create an empty requirements document at the resolved path. |
| `symspec add` | Create a new EARS requirement and return its assigned UUID. |
| `symspec update` | Patch one or more typed attributes on an existing requirement (by UUID or stable key). |
| `symspec parse` | Parse natural-language requirement prose into structured EARS slots. |
| `symspec check` | Run the full linter loop over the document and return findings in one envelope. |
| `symspec certify` | Emit and kernel-check an optional Lean 4 proof artifact for the document. |
| `symspec list` | List all current requirements in the document. |
| `symspec show` | Print the full record of one requirement by UUID. |
| `symspec derive` | Add a derives edge — the source requirement decomposes into the target. |
| `symspec satisfy` | Add a satisfies edge — the source requirement satisfies the goal expressed by the target. |
| `symspec remove-edge` | Remove a typed directional edge between two requirements (derives | satisfies | verifies | refines). |
| `symspec delete` | Tombstone a requirement, removing it from the document. |
| `symspec export` | Export the requirements graph to SysML-v2-flavored JSON for interchange with other tools. |
| `symspec glossary` | Manage the document's committed synonym glossary: `glossary add <canonical> <alias>`, `glossary remove <canonical> <alias>`, `glossary list`. |
| `symspec download-model` | Pre-fetch and cache the semantic tier embedding model so `check --semantic` runs fully offline afterward. |
| `symspec apply` | Apply a batch of mutation ops from JSONL (a file, or --stdin) in one process and one save. |
| `symspec waive` | Record a reviewed, reasoned waiver that suppresses a finding code in `symspec check`. |
| `symspec install` | Install the symspec skill into your coding agent so it discovers and drives symspec automatically. |
| `symspec antonym` | Manage the document's committed antonym pairs: `antonym add <a> <b>`, `antonym remove <a> <b>`, `antonym list`. |

## Recommended workflow

1. `symspec init` a document (or point `SYMSPEC_DOC` at one).
2. Author requirements: `symspec add` with explicit EARS slots, or
   `symspec add --from-parse "When the user logs out, the auth service shall
   invalidate the session token."` to parse prose, or `symspec parse --file`
   to batch-triage a prose list first (each line returns ok / skipped / an
   `ERR_PARSE_*` envelope with partial slots and a mechanical rewrite
   suggestion — apply the suggestion and retry).
3. `symspec check` — one envelope contains structural, lint, and formal
   findings together, with severity counts.
4. Resolve findings in priority order:
   1. **structural errors** (dangling references, missing slots, cycles) —
      the graph is broken; formal results are incomplete until these clear;
   2. **`FND_CONTRADICTION`** — proven conflicts; the `evidence.core` array
      names exactly the culprit requirement ids, and `evidence.atomTable`
      shows what the solver compared;
   3. **error-severity lint** (`GTWR_*`) — these statements were EXCLUDED
      from formal analysis (the `excluded` array says why), so fixing them
      widens proof coverage;
   4. **warns/infos** (subsumption, redundancy, vacuity, orphans,
      `FND_SIMILAR_UNUNIFIED`, `FND_NEEDS_REVIEW`) — judgment calls;
      `FND_NEEDS_REVIEW` explicitly means "not proven either way".
5. Re-run `symspec check` after every edit batch; exit 0 = conflict-free
   modulo the scope statement below.
6. Optionally `symspec certify` for Lean-kernel-checked certificates
   (requires a Lean toolchain; never needed for `check`).

## Recipe — prove a code-vs-intent (or spec-vs-spec) conflict

The most common reason a real conflict hides: the two requirements never
atomize to the same thing, so the solver never compares them. To make a
divergence PROVABLE:

1. **State both sides on a shared system + trigger.** Write the intended
   invariant and the conflicting behavior as two requirements with the SAME
   `systemName` and the SAME trigger/precondition, so they land in one context
   group.
2. **Make the responses collide on one atom.** Reduce both responses to a shared
   object phrase differing only on the verb head (`run the cycle` vs
   `skip the cycle`), then commit the relationship the solver needs:
   - polar OPPOSITES → `symspec antonym add run skip` (collapses to one atom at
     opposite polarity → `FND_CONTRADICTION`);
   - same meaning, different words → `symspec glossary add "…" "…"` (collapses
     to one atom → any bound/polarity conflict surfaces).
3. **For numeric bounds on one quantity described two ways**
   (`complete … within at most 30 minutes` vs `run … for at least 60 minutes`):
   `check` emits `FND_QUANTITY_ALIAS_CANDIDATE` with the exact
   `symspec glossary add` command to unify the two quantity keys; commit it and
   the numeric tier proves the `FND_NUMERIC_CONTRADICTION`.
4. **Re-run `symspec check`.** The alignment is what lets the prover SEE the
   conflict — committing the link doesn't quiet a warning, it turns an
   unprovable divergence into a named, evidence-carrying contradiction.

symspec follows a DEMOTION-ONLY rule: fuzzy signals and coverage gaps
(`FND_QUANTITY_ALIAS_CANDIDATE`, `FND_RELATIONAL_UNCHECKED`,
`FND_EXCLUDED_FROM_FORMAL`) can only push `data.verified` toward `false` and
list a discharging command in `data.coverage.demotions`; only the deterministic
proof tier can produce `verified: true`. A requirement excluded from the formal
tier by an error-severity lint is re-admitted either by fixing the lint or by
waiving it (`symspec waive add <code> --ref <id>`) — waiving the
`FND_EXCLUDED_FROM_FORMAL` disclosure alone never restores coverage.

## Honest scope — read before trusting a verdict

> The formal (SMT) tier is sound modulo atomization, given the conservative near-exact normalization of the atom table: every reported conflict is a genuine logical conflict of the requirements as atomized, and the atom table attached to each finding shows exactly what the solver compared.

> Because paraphrases become distinct atoms, a real conflict can be missed (a false negative): silence is not a consistency certificate, so the formal tier reporting no conflict does not prove the spec consistent.

> The one false-positive risk is over-unification (too-aggressive normalization collapsing two distinct conditions into one atom); it is mitigated by conservative normalization (no stemming or stopword-stripping beyond leading articles) and the info-severity FND_SIMILAR_UNUNIFIED reporter.

> Deterministic ambiguity detectors (vague terms, quantifier/coordination scope, and referential ambiguity) run and report; but whether a phrase is vague in its domain context — pragmatic/contextual ambiguity — is surfaced for review (FND_AMBIGUITY_NEEDS_JUDGMENT), not decided by symspec, and any LLM ambiguity judgment is propose-only, never a verdict.

## Error codes (`ERR_*`)

| Code | Meaning |
|---|---|
| `ERR_USAGE` | Invalid or missing CLI arguments. Suggestion: consult the command usage string. |
| `ERR_DOC_NOT_FOUND` | The requirements-document path did not resolve. Suggestion: run `symspec init <file>`, or set SYMSPEC_DOC to an existing document. |
| `ERR_DOC_PARSE` | The document is not valid JSON or fails RequirementsDocSchema. Suggestion: fix the offending JSON path, or re-create the document from source with `symspec init` then `symspec parse`/`add`. |
| `ERR_SCHEMA_VERSION` | The document's schemaVersion does not equal the current SCHEMA_VERSION. Suggestion: re-create the document at the current schema with `symspec init` then re-add its requirements. |
| `ERR_IO` | An atomic write to the document failed (permissions or disk). The original file is left intact. Suggestion: check filesystem permissions and free space. |
| `ERR_DUPLICATE_ID` | A CreateRequirement supplied a UUID that already exists. Suggestion: use `symspec update`, or omit --id to auto-mint a fresh UUID. |
| `ERR_NOT_FOUND` | The referenced requirement id is not present. Suggestion: list existing ids with `symspec list`. |
| `ERR_INVALID_RELATION` | The edge relation is not one of the defined RELATIONS. Suggestion: use one of derives/satisfies/verifies/refines. |
| `ERR_INVALID_ATTR` | The update attribute is not an updatable attribute. Suggestion: list updatable attrs in the manifest. |
| `ERR_NULL_REQUIRED` | Null/--clear was applied to a required (non-nullable) attribute. Suggestion: provide a value; only preCondition/trigger/verificationMethod are clearable. |
| `ERR_PARSE_NO_MODAL` | No `shall`/modal main clause was found. Suggestion: prepend "the <system> shall …"; apply the provided mechanical rewrite. |
| `ERR_PARSE_AMBIGUOUS_CLAUSES` | Clause boundaries could not be resolved after Tier 2. Suggestion: reorder to EARS clause order; see the recovered partial slots. |
| `ERR_PARSE_COMPOUND` | A compound requirement (top-level and/or) was detected. Suggestion: split at "and"/"or" into separate requirements. |
| `ERR_PARSE_NOT_A_REQUIREMENT` | The input is prose with no obligation. Suggestion: rewrite as `<system> shall …`, or skip it — it is not a requirement. |
| `ERR_SOLVER_MISSING` | A binary solver backend was requested but none was found by the discovery order. Suggestion: install one with `mise use github:Z3Prover/z3@z3-4.16.0`. |
| `ERR_SOLVER_TIMEOUT` | The overall run budget (--solver-budget-ms) was exceeded — a whole-run failure, never a single group. Suggestion: raise --solver-budget-ms. |
| `ERR_SOLVER_INCONCLUSIVE` | A whole-run solver-init failure / the solver is unusable — never a per-group `unknown` (that is FND_NEEDS_REVIEW). Suggestion: verify the solver backend and raise the timeout. |
| `ERR_LEAN_TOOLCHAIN_MISSING` | `certify` was requested but no Lean toolchain is discoverable. Suggestion: run `elan default stable`. This never blocks a prior SMT-tier result. |
| `ERR_DOC_EXISTS` | `init` refused to overwrite an existing document at the resolved path. Suggestion: pass --force to recreate it, or choose a different path — the existing file is left intact. |
| `ERR_EMBED_MODEL_MISSING` | The embedding model (core to every `check`) is not cached and remote loading is disabled — the run fails closed rather than silently skipping the semantic/opposition tier. Suggestion: run `symspec download-model` once, or set SYMSPEC_EMBED_ALLOW_REMOTE=1 for this run. |
| `ERR_DUPLICATE_KEY` | A create supplied a --key that another requirement already uses; keys must be unique. Suggestion: choose a different key, or omit --key to create the requirement without one. |

## Lint rule codes (`GTWR_*`)

| Code | Meaning |
|---|---|
| `GTWR_R1_PATTERN` | Statement does not match any EARS pattern (INCOSE R1). |
| `GTWR_R2_PASSIVE` | `shall be <participle>` passive voice hides the responsible agent (R2). |
| `GTWR_R5_INDEFINITE_ARTICLE` | Indefinite article "a/an" where a definite "the" is expected (R5). |
| `GTWR_R6_MISSING_UNITS` | A bare number with no unit of measure (R6). |
| `GTWR_R7_VAGUE` | A vague term from the weasel lexicon (R7). |
| `GTWR_R8_ESCAPE` | An escape clause such as "where possible" / "if necessary" (R8). |
| `GTWR_R9_OPEN_ENDED` | An open-ended clause such as "including but not limited to" / "etc." (R9). |
| `GTWR_R10_SUPERFLUOUS_INFINITIVE` | A superfluous infinitive such as "be able to" / "be capable of" (R10). |
| `GTWR_R15_LOGICAL_EXPR` | Use of an undefined logical-expression convention (R15). |
| `GTWR_R16_NEGATION` | Use of "not"/"never" outside a defined logical expression (R16). |
| `GTWR_R17_OBLIQUE` | An oblique "/" outside units or fractions (e.g. "and/or") (R17). |
| `GTWR_R18_MULTIPLE_SHALL` | More than one `shall` — multiple thoughts in one statement (R18). |
| `GTWR_R19_COMBINATOR` | A clause combinator in the response slot (R19). |
| `GTWR_R20_PURPOSE` | A purpose phrase such as "in order to" / "so that" (R20). |
| `GTWR_R21_PARENTHESES` | Parenthetical subordinate text (R21). |
| `GTWR_R24_PRONOUN` | A personal or indefinite pronoun with an unclear referent (R24). |
| `GTWR_R26_ABSOLUTE` | An unachievable absolute such as "100%" / "always" / "never" (R26). |
| `GTWR_R32_UNIVERSAL` | "all/any/both" where "each" is intended (R32). |
| `GTWR_R33_MISSING_TOLERANCE` | A quantity with no range or tolerance (R33). |
| `GTWR_R34_IMMEASURABLE` | An immeasurable performance term such as "fast" / "robust" (R34). |
| `GTWR_R35_TEMPORAL` | An indefinite temporal keyword such as "eventually" / "until" (R35). |
| `GTWR_R37_ACRONYM` | An undefined or inconsistently used acronym (R37). |
| `GTWR_R38_ABBREVIATION` | A non-unit abbreviation (R38). |
| `GTWR_R40_DECIMAL_FORMAT` | Inconsistent decimal precision across the requirement set (R40). |

## Finding codes (`FND_*`)

| Code | Meaning |
|---|---|
| `FND_DANGLING_REFERENCE` | error — an edge targets a nonexistent requirement UUID. |
| `FND_MISSING_TRIGGER` | error — an event-driven / unwanted-behavior requirement has no trigger. |
| `FND_MISSING_PRECONDITION` | error — a state-driven / optional-feature requirement has no precondition. |
| `FND_CYCLE` | error — a cycle in `derives`/`refines` (canonical-rotation deduplicated). |
| `FND_ORPHAN` | warn — a requirement with zero inbound/outbound edges (document size > 1). |
| `FND_EXACT_DUPLICATE` | error — an identical slot-tuple hash: two requirements are exact duplicates. |
| `FND_CONTRADICTION` | error — a context group is unsat; ids are the filtered MINIMAL unsat core; requires same-atom opposite-polarity responses. |
| `FND_SUBSUMPTION` | warn — a directional implication is valid; `moreGeneral` is the superset-of-cases side. |
| `FND_REDUNDANCY` | warn — a bi-implication is valid: the two requirements are logical duplicates. |
| `FND_VACUITY` | warn — a guard is unreachable given all OTHER requirement formulas (relational, labeled lower confidence). |
| `FND_SIMILAR_UNUNIFIED` | info — responses with Jaccard ≥ 0.7 that did not unify to one atom; an over-unification-adjacent review prompt (suggests rewording one response via `symspec update`). |
| `FND_NEEDS_REVIEW` | info — a per-group solver `unknown`/timeout/unencodable result; explicitly NOT a "no conflict". |
| `FND_INCOMPLETE` | info — a heuristic guard-coverage gap over a same-trigger-family group; NOT a formal completeness guarantee. |
| `FND_CERTIFIED` | info — kernel-checked by Lean; carries `#print axioms` provenance. |
| `FND_CERTIFY_FAILED` | error — Lean produced a `severity:"error"` diagnostic; certification failed. |
| `FND_SIMILAR_SEMANTIC` | info — two responses embed with cosine ≥ threshold but did not unify to one atom; a PROPOSE-only prompt to add a `symspec glossary` entry. Never a verdict. |
| `FND_NUMERIC_CONTRADICTION` | error — two+ requirements place jointly unsatisfiable linear numeric constraints (LIA/LRA) on the same per-system quantity; ids are the minimal unsat core, evidence lists the conflicting predicates (unit-normalized). |
| `FND_LEAF_UNVERIFIABLE` | warn — a refinement-DAG leaf (inbound refines/derives, no outbound) with no `verifies` edge; a leaf must be independently verifiable (KAOS/SysML leaf-verifiability). |
| `FND_MISSING_TRACE_LINK` | info — two requirements embed with cosine ≥ threshold but share no committed refines/derives/satisfies edge; a PROPOSE-only candidate trace link. Never a verdict. |
| `FND_DUPLICATE_CLUSTER` | info — three+ requirements form a tight semantic cluster; a PROPOSE-only prompt to review for near-duplication or an unstated shared parent. Never a verdict. |
| `FND_AMBIGUOUS_VAGUE` | info — a vague/weasel term (e.g. "fast", "user-friendly", "as appropriate") with no measurable meaning; deterministic lexical scan, carries the offending span. |
| `FND_AMBIGUOUS_QUANTIFIER` | warn/info — scope/quantifier ambiguity: un-parenthesized "and…or" coordination (warn), leading "all/each/every", or a bare-plural subject; deterministic pattern scan with a span. |
| `FND_AMBIGUOUS_REFERENCE` | info — a pronoun or bare definite NP ("it", "the system") with ≥2 candidate antecedents in scope; deterministic detection (recall-first), resolution is punted to the agent. |
| `FND_AMBIGUITY_NEEDS_JUDGMENT` | info — pragmatic/contextual ambiguity was not assessed deterministically; a structured prompt to hand the requirement to an LLM/agent review. Never a verdict, never in the reproducibility hash. |
| `FND_TEMPORAL_CONTRADICTION` | error — a set of requirements is temporally inconsistent under bounded LTL→SMT (no trace of length ≤ k satisfies them jointly); sound-for-UNSAT, evidence carries {bound,complete:false}. Opt-in via `check --temporal`. |
| `FND_NO_PAIRS_CHECKED` | info — the formal tier evaluated 0 candidate pairs (no two requirements shared an atom), so no cross-requirement conflict/subsumption analysis actually ran. Silence here is not a consistency certificate; consider glossary entries to align vocabulary so related requirements share atoms. |
| `FND_OPPOSITION_CANDIDATE` | info — two same-system responses share an object phrase but differ on the leading verb (e.g. "open the valve" vs "shut the valve"), a LIKELY antonym pair the seed/committed antonym tables have not unified. Propose-only: if the verbs are truly opposite, run `symspec antonym add <verbA> <verbB>` so the formal tier collapses them to one atom at opposite polarity and can prove any conflict. Never a verdict. |
| `FND_EXCLUDED_FROM_FORMAL` | info — a requirement was excluded from the formal (SMT) tier because an error-severity lint or parse finding blocked its surface, so no cross-requirement analysis covered it. A LOUD coverage signal that DEMOTES `verified` (silence over an unchecked requirement is not a consistency certificate); discharge by fixing the blocking finding (rephrase) — waiving the finding alone does NOT restore formal coverage. |
| `FND_QUANTITY_ALIAS_CANDIDATE` | info — two same-system, same-trigger numeric bounds landed on different quantity keys that share a noun token (e.g. "complete the infusion within ≤30 min" vs "run the infusion for ≥60 min"), so a possible single-quantity conflict was never compared. Propose-only: if the bounds constrain ONE quantity, run the suggested `symspec glossary add` to unify them so the LIA tier can prove any conflict. DEMOTES `verified`; never a verdict. |
| `FND_RELATIONAL_UNCHECKED` | info — requirements under one shared trigger carry numeric bounds alongside unmatched (singleton) atoms — the shape where aggregate/conservation or cross-quantity relational conflicts hide. symspec's numeric tier is pairwise same-quantity only and does NOT attempt aggregate sums or cross-quantity arithmetic, so this reasoning was not attempted. DEMOTES `verified` so it never outruns what was compared; never a verdict. |
