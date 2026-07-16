# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A tool that helps coding agents *write* good software requirements — not just
grade them afterward.** You describe what a system should do in plain,
structured sentences; symspec turns each sentence into a clean requirement,
warns you the moment two of them disagree, and mathematically *proves* that a
set of requirements can't all be true at once, pointing at the exact ones to
blame.

It is built for an AI coding agent to operate directly: every command answers
with structured data (not paragraphs the agent has to re-read), so the agent
always knows whether it succeeded and what to do next. And when symspec *can't*
prove a spec consistent, it says so honestly — `data.verified: false` — and
hands the agent a work list of exactly which requirements to rewrite and which
vocabulary decisions to commit, so the agent iterates until the spec genuinely
certifies. Humans can read the same output in plain text.

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

*(New to the terms below? Every abbreviation is spelled out on first use, and
there's a plain-language [glossary](#glossary) at the very bottom.)*

## Quick start

```bash
# Install the command-line tool globally
git clone https://github.com/theagenticguy/symspec.git && cd symspec
pnpm install && pnpm build && pnpm pack
npm install -g ./symspec-*.tgz     # puts the `symspec` command on your PATH

# One-time: fetch the local embedding model (~110 MB, sha256-pinned) that the
# always-on semantic tier runs. Fully offline afterward.
symspec download-model
```

symspec writes requirements in the **EARS** style (Easy Approach to Requirements
Syntax — a simple, well-established template like *"When X happens, the system
shall do Y"*). You give it the pieces; it writes the sentence for you and keeps
the whole set consistent.

Start a document, add two requirements, and check them. Every command prints its
result as structured data (JSON) to the screen by default:

```console
$ symspec init reqs.symspec.json
$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "grant access" --trigger "the user submits valid credentials"
$ symspec add reqs.symspec.json --pattern event-driven --system "auth service" \
    --response "revoke access" --trigger "the user submits valid credentials"

$ symspec check reqs.symspec.json
```

Those two requirements contradict each other — one grants access on exactly the
event where the other revokes it — and `check` catches it, naming the two
requirements at fault and showing its work:

```jsonc
{
  "apiVersion": 1,
  "type": "check",
  "data": {
    "findings": [
      {
        "code": "FND_CONTRADICTION",
        "severity": "error",
        "requirementIds": ["586d8933-…", "d50c8fff-…"],
        "message": "Requirements 586d8933…, d50c8fff… cannot all hold: on the same trigger, one grants access and the other revokes it.",
        "evidence": { "...": "the exact reasoning the checker used" }
      }
    ],
    "counts": { "error": 1, "warn": 0, "info": 0 }
  }
}
# the command also exits with status 1 — a blocking problem was found
```

**The exit status is the pass/fail signal**, so a script or continuous-
integration (CI) pipeline can gate on it without reading anything: `0` = clean
(or only warnings), `1` = a blocking problem was found, `2` = the command itself
couldn't run (bad arguments, missing file, missing embedding model), `3` = a
requested `--strict` gate found the run *inconclusive* — nothing was proven
wrong, but the spec couldn't be verified either, and the output says exactly
why. The full detail is always printed too — the problems *are* the output.

**Let your agent set it up for itself.** Run `symspec install` and it drops a
small "skill" file into whichever AI coding assistant you have — Claude Code,
Cursor, Codex, Kiro, Windsurf, or GitHub Copilot — so the assistant learns to
use symspec on its own. It writes only into each tool's dedicated skills folder
and never edits your existing instruction files.

---

## Who is this for?

**AI coding agents that write software specs — and the people who supervise
them.**

Requirements are where software goes wrong *before* anyone writes code: two
requirements quietly contradict, one sentence secretly bundles two demands
together, or a speed limit says "under 2 seconds" in one place and "over 3
seconds" in another. People skim past these. So do language models asked to
"review the spec" in prose — they'll happily write a confident paragraph that
misses the actual conflict.

symspec makes the check **mechanical** instead of impressionistic. A conflict is
either provable or it isn't, and when it is, symspec hands you the specific
requirements to fix and the reasoning behind the verdict — never a vague
"looks mostly fine."

Crucially, it helps agents **author**, not just audit:

- **Build the whole spec in one safe move.** `symspec apply` takes a batch of
  edits — add these requirements, link this one to that one, update those — and
  applies them as a single all-or-nothing transaction. If any step is invalid,
  nothing is saved and you're told exactly which line failed. You can even give
  each requirement a friendly name like `G1` or `AUTH-3` and refer to it later
  in the same batch before its permanent ID exists. No hundred separate
  commands, no bookkeeping file mapping names to IDs.
- **Write from plain prose.** Hand symspec ordinary sentences and it turns each
  into a structured requirement — or, if a sentence is too vague or secretly
  two requirements in one, it tells you precisely how to rewrite it. Authoring
  and correcting are the same loop.
- **Fix with guidance, not guesswork.** Each problem comes with a stable code,
  the exact character positions in the sentence, and a concrete rewrite
  suggestion.
- **Decide once, keep it decided.** Flagged a warning you meant on purpose? Set
  it aside with a recorded reason (`symspec waive`), so the next review shows a
  clean, deliberate baseline instead of the same noise every run.

For the agent, the payoff is no trial-and-error: one command (`symspec
manifest`) describes the entire tool — every command, every option, every
result code — so the agent reads the rules once and drives correctly from there.
People get the same results in plain text with `--pretty`, and everything is
also available as an importable code library, not only a command-line tool.

---

## The certification loop

The core workflow symspec is built around: **an agent iterates on a spec until
it genuinely certifies.** `check --strict` is the gate, `data.verified` is the
claim, and `data.coverage.demotions` is the work list.

`verified: true` is a deliberately *hard* claim. It does not mean "no conflict
was found" — it means the decide tier actually verified the whole document:

1. **Every requirement participates.** Each requirement shares vocabulary
   (atoms) with at least one other, so the prover genuinely compared it against
   its peers. A requirement written in its own private vocabulary is an island
   the prover can't reason about — and an island is where a contradiction hides.
2. **Every opposition candidate is triaged.** When two requirements act on the
   same object with different verbs ("admit the request" / "block the request"),
   symspec proposes the pair. Until the agent decides — opposites
   (`antonym add`), synonyms (`glossary add`), or neither (`waive`) — the run
   won't certify, because an untriaged pair is a possible conflict the prover
   can't see.
3. **A cross-requirement comparison actually happened**, and the semantic tier
   ran.

When any of these fail, `verified` is `false`, `--strict` exits `3`, and every
reason appears in `data.coverage.demotions` **with the exact command that
discharges it**:

```jsonc
"coverage": {
  "demotions": [
    {
      "reason": "uncovered-requirement",
      "requirementIds": ["45defae7-…"],
      "action": "Rewrite 45defae7-… to share guard/response vocabulary with the requirements it relates to, or link its terms via `symspec glossary add`/`symspec antonym add` …"
    },
    {
      "reason": "open-opposition-candidate",
      "requirementIds": ["20aa64dc-…", "45defae7-…"],
      "action": "Triage this opposition candidate: commit `symspec antonym add <a> <b>` if the verbs are opposites, `symspec glossary add …` if synonyms, or waive it …"
    }
  ]
}
```

So the loop converges mechanically, no human in the middle:

```
check --strict          # exit 3 — verified: false
  → read coverage.demotions
  → apply the listed ops (antonym add / glossary add / waive)
    or rewrite the named requirements to align vocabulary
check --strict          # repeat…
  → exit 0, verified: true — or exit 1 with a PROVEN contradiction
    the vocabulary alignment just exposed
```

That last line is the point: aligning vocabulary is what *lets the prover see*.
Committing `antonym add seal expose` doesn't just quiet a warning — it collapses
"seal the record" and "expose the record" onto one logical atom at opposite
polarity, and if both are required under the same reachable condition, the next
`check` **proves the contradiction** and names the culprits.

One principle governs all of it — **demotion-only**: fuzzy signals (embedding
similarity, coverage statistics, untriaged proposals) can push `verified` toward
`false` (raise the alarm), but only the deterministic proof tier can produce the
all-clear. A cosine score can never certify your spec; it can only tell you what
to look at.

> **Why so strict?** Because the permissive version was beaten. A red-team eval
> (frontier-model proposer, blind judge panel, z3 as the oracle) authored specs
> with genuine, machine-provable contradictions that earlier symspec certified
> as clean — first 25/30, then 28/30 after the first hardening, as attackers
> abandoned the closed seams and converged on the numeric tier's structural
> blind spot (a bound keyed off the verb phrase, an aggregate never summed, an
> emergent impossibility no lexicon reaches). Each escape is now closed the same
> way: the tractable ones become *proven* contradictions, and the ones no sound
> extractor can reach **demote `verified` with an actionable caveat** rather than
> certify. Every winning round is a regression fixture (`adversarial/eval-rounds.ts`).

### Recipe — make a code-vs-intent conflict provable

A real divergence hides when the two requirements never atomize to the same
thing, so the prover never compares them. To force it into the open:

1. **State both sides on a shared system + trigger** — the intended invariant
   and the as-built (or conflicting) behavior, same `systemName`, same trigger,
   so they land in one context group.
2. **Collapse the responses onto one atom.** Reduce both to a shared object
   phrase differing only on the verb head (`run the cycle` vs `skip the cycle`),
   then commit the link the prover needs:
   - polar opposites → `symspec antonym add run skip` → `FND_CONTRADICTION`;
   - same meaning → `symspec glossary add "…" "…"`.
3. **Numeric bounds on one quantity worded two ways?** `check` emits
   `FND_QUANTITY_ALIAS_CANDIDATE` carrying the *exact* `glossary add` command;
   commit it and the numeric tier proves the `FND_NUMERIC_CONTRADICTION`.
4. **Re-run `check`.** Aligning vocabulary is what lets the prover see — the
   commit turns an unprovable divergence into a named, evidence-carrying proof.

What the prover genuinely cannot recover from prose — aggregate/conservation
sums, cross-quantity arithmetic, emergent structural impossibility (odd-cycle
colorings, pigeonhole) — is not silently passed: `check` flags the shape with
`FND_RELATIONAL_UNCHECKED` and demotes `verified`, so "verified" never outruns
what was actually compared.

### Coverage is loud, never silent

`data.coverage` reports `{ encoded, excluded }` and a one-line `pairsCheckedNote`
so a low pair count is read correctly (disjoint transitions have no same-context
peer to conflict with — not a coverage gap). A requirement dropped from the
formal tier by an error-severity lint raises a first-class
`FND_EXCLUDED_FROM_FORMAL` and demotes `verified` — silence over an unchecked
requirement is never a clean bill of health. Re-admit it by fixing the lint, or
by waiving the *blocking* finding (`symspec waive add <code> --ref <id>`), which
the gate honors by returning the requirement to the solver; waiving the
`FND_EXCLUDED_FROM_FORMAL` disclosure alone does not restore coverage.

---

## What's under the hood

symspec pairs a fast, **fully repeatable** core with an optional "smart" layer
that can only *suggest* — never decide. Run it twice on the same document and
you get the exact same answer, every time.

Each row below is one checking engine. "Proves" means a mathematical guarantee,
not a heuristic guess:

| Engine | What it catches | How |
|---|---|---|
| **Sentence parser** | turns prose into a clean requirement, or explains the rewrite it needs | pattern-matching first; only reaches for a language parser on hard sentences |
| **Writing-quality lint** | broken cross-references, circular links, missing pieces, and 24 industry-standard writing rules | plain text rules from the *Guide to Writing Requirements* by INCOSE (the International Council on Systems Engineering); each flag includes the offending text span and a fix |
| **Logic checker** *(the core)* | two requirements that can't both be true; one that makes another redundant; a rule that can never actually fire | an automated theorem prover (**Z3**) running in-process — nothing to install — that shows the minimal reason for each verdict |
| **Numbers checker** | conflicting limits, like "under 2 seconds" vs "over 3 seconds" on the same measurement | the same prover, reasoning about arithmetic |
| **Timing checker** *(opt-in)* | ordering and timing clashes, like "on overheat, open the relief valve" vs "the controller shall not open the relief valve" (phrased without absolute words like *never*, so the lint gate lets both reach the prover) | translates timing rules into logic the prover can test over a bounded timeline |
| **Ambiguity checker** | vague words, "and/or" that could be read two ways, pronouns with no clear referent | fixed detectors; genuinely judgment-call ambiguity is *flagged for a human/agent*, never silently guessed |
| **Meaning-similarity layer** *(core, always-on)* | conflicts hidden behind different wording ("issue a token" vs "grant a credential") and possible opposites the prover can't yet see ("admit" vs "block") | a small language model running **locally on your machine** (no internet after a one-time download) that *suggests* — you confirm with `glossary add`/`antonym add`, then the logic checker proves the conflict. A missing model fails the run rather than silently skipping this layer |
| **Coverage accountant** | requirements the prover never actually compared, and suggestions left untriaged — the places a conflict could hide | a deterministic per-requirement participation tally; anything uncovered demotes `data.verified` with an actionable fix in `data.coverage.demotions` |
| **Formal certificate** *(opt-in)* | a re-checkable proof artifact for the whole spec | the **Lean 4** proof assistant; keeps a file anyone can independently verify later |

The rule that holds it all together: **any result that can block your build must
be perfectly reproducible from the document itself plus a couple of pinned,
version-controlled inputs.** The one "smart" layer — meaning similarity — runs
every check but can only *suggest*; its decisions get reviewed by a person or
agent and saved into the project (`glossary`, `antonyms`, `waivers`) so they
never vary again. And its dual: fuzzy signals can *demote* a verification
verdict, never produce one. Convenience never costs you repeatability.

In numbers: **19 commands**, **71 stable result codes** (they only ever get
added, never renamed or removed, so automation built on them keeps working), a
self-describing `manifest`, structured output everywhere, a compact `--dense`
mode for token-limited agents, and a built-in adversarial test suite — including
regression fixtures from a real red-team eval — that keeps the checkers honest.

Everything below is how it works in detail.

---

## The pipeline

symspec runs a **forced pipeline** — `parse → lint → check → certify` — and the
order is load-bearing. A statement that fails an earlier surface stage is
*excluded* from the formal stage, because feeding unparsed or dangling-reference
text into an SMT encoding is unsound. The exclusion is reported in the `check`
envelope's `excluded[]` so nothing disappears silently. A core **semantic
tier** runs alongside the formal stage on every `check` to surface paraphrased
conflicts and opposition candidates (a missing embedding model fails the run
closed — pre-warm with `symspec download-model`), and an opt-in **Lean 4
certification** tier runs only on demand.

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

- **Atomization** (`atomize.ts`, `antonyms.ts`, `lemma.ts`) — the load-bearing
  contract. A single pure `atomize` function derives Boolean atoms with a
  conservative, near-exact normalization: lowercase → strip leading articles →
  strip punctuation → collapse whitespace → underscore-join. It does **not**
  stem or strip stopwords from the *remainder* of a slot; three closed,
  deterministic head/token rules are the whole exception surface, each added to
  close a real red-team escape:
  - the **leading response verb de-inflects** via a vendored irregular-verb
    table plus a closed third-person rule ("opens"→"open", "kept"→"keep",
    "rolls back"→`roll_back`), so inflected phrasing can't hide a conflict;
  - **guard slots drop one copula token**, so "while the session *is*
    authenticated" and the state a bridge establishes ("mark the session
    authenticated") name the same condition;
  - on an **antonym hit only**, one preposition drops from the remainder, so
    "include X *in* the view" / "exclude X *from* the view" collide ("move X
    to/from" is untouched — direction lives in the verb class, never the
    preposition).

  Every atom is scoped per `systemName`, so identical response text under two
  systems yields two distinct atoms and never manufactures a cross-system
  conflict. Negation lands on the *same* atom with opposite polarity, and a
  **32-pair seed antonym table** resolved into signed equivalence classes
  (`grant/allow/permit/authorize ↔ revoke/deny/forbid`, `commit ↔ roll back`,
  `seal ↔ expose`, `quarantine ↔ release`, `publish ↔ retract`, …) unifies
  polar opposites; the resolved class map is snapshot-pinned so a seed edit
  that silently merges classes fails a test. A bulk dictionary import was
  evaluated and rejected — WordNet's verb antonyms cover a fraction of the
  operational opposites requirements English actually uses — so the table grows
  only by explicit edit or the doc-committed `antonym add` path.
- **Encoding** (`encode.ts`) — each requirement becomes a guarded implication
  with an assumption literal, `REQ-i ⇒ (context ⇒ response)`. The encoder is a
  pure, unit-tested function separate from the solver call.
- **Findings** — contradiction (`contradiction.ts`) runs per-context-group
  reachability over the *whole* spec and, on `unsat`, extracts the **minimal**
  unsat core, filters context assertions, and emits `FND_CONTRADICTION` with
  exactly the responsible `REQ-*` ids. It also computes a **guard-implication
  closure** (`guard-implication.ts`): a bridge requirement that establishes a
  state ("while authenticated, be verified") is re-encoded as
  `bridge ⇒ (authenticated ⇒ verified)` and added to the conjunction, so the
  solver links a rule guarded on `authenticated` to one guarded on `verified` and
  a *transitive* conflict becomes provable — with the bridge named in the core.
  The establishment lexicon covers the bare copular forms (`be/become/remain`),
  the object forms (`mark/set/flag/classify/label/record/register/designate
  <thing> as <state>`, `escalate/promote/transition/place <thing> to|into|in
  <state>`), and the held-state forms (`keep/hold <thing> <state>` — "keeps the
  reactor online" bridges into a guard reading "while the reactor is online"),
  with heads de-inflected so tense never breaks a bridge. Sound: it only
  re-expresses an implication the spec already asserts, and an established
  state that matches no other rule's guard is dropped as inert — a multi-hop
  chain (authenticated → verified → trusted → privileged) composes inside the
  solver, so a grant-at-the-end vs deny-at-the-start conflict is proven with
  every bridge named.
  Subsumption/redundancy
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
  sets — e.g. an event-driven *"When the sensor reports overheat, the controller
  shall open the relief valve"* against a ubiquitous *"The controller shall not
  open the relief valve"* — surface as `FND_TEMPORAL_CONTRADICTION`. Note the
  phrasing avoids absolute words (*never/always*): a bare *"never"* would trip the
  `GTWR_R26_ABSOLUTE` error-severity lint and get the requirement *excluded* by
  the forced-pipeline gate before it ever reached this tier, so the marquee
  example uses *"shall not"* (only a `warn`) to stay verifiable. **Sound-for-UNSAT**:
  a reported conflict is real; a `sat`-at-bound-`k` result is not a consistency
  certificate (`{bound, complete: false}` in the evidence). See the runnable demo
  below.
- **Requirement similarity graph + DAG (`src/formal/graph.ts`, core —
  always-on).** A deterministic kNN graph (batch-invariant embedder, cosine
  quantized before threshold, id tie-breaks, union-find clustering) proposes
  `FND_MISSING_TRACE_LINK` (a high-cosine pair with no committed edge) and
  `FND_DUPLICATE_CLUSTER` — info only, because trace-link precision is too low to
  auto-commit. The structural analyzer adds the KAOS/SysML
  `FND_LEAF_UNVERIFIABLE` invariant (a refinement leaf with no verify edge).

A generative-adversarial harness (`adversarial/`) generates increasingly subtle
BAD specs across all five defect classes and scores symspec on detection +
localization, escalating difficulty with a gap report — a standing regression
gate that the deterministic tiers catch 100% of, and 20/20 across four tiers with
the real embedding model. Alongside it, `adversarial/eval-rounds.ts` pins the
winning rounds of a real external red-team eval (a frontier-model proposer that
beat an earlier symspec 25/30 under `--strict`): each round now either *proves*
its planted contradiction with the culprits named, or — where no committed
lexicon can reach the conflict — demotes `verified` so the run abstains instead
of certifying. A meta-test asserts the eval's exact win condition (clean exit
with a hidden contradiction) is unreachable on every round.

#### The temporal tier in action

Add an event-driven obligation and an unconditional prohibition on the *same*
response, then check with `--temporal`:

```console
$ symspec init reqs.symspec.json
$ symspec add reqs.symspec.json --pattern event-driven --system "controller" \
    --response "open the relief valve" --trigger "the sensor reports overheat"
$ symspec add reqs.symspec.json --pattern ubiquitous --system "controller" \
    --response "open the relief valve" --negated

$ symspec check reqs.symspec.json --temporal
```

Rendered, the two requirements read *"When the sensor reports overheat, the
controller shall open the relief valve."* and *"The controller shall not open
the relief valve."* — the second is a global obligation to keep the valve shut,
so on the step where the trigger fires there is no consistent trace. Because both
sentences avoid absolute words (`shall not` is only a `warn`, not the
`GTWR_R26_ABSOLUTE` error that `never` would raise), neither is excluded by the
gate, and the temporal tier proves the clash:

```jsonc
{
  "apiVersion": 1,
  "type": "check",
  "data": {
    "findings": [
      {
        "code": "FND_TEMPORAL_CONTRADICTION",
        "severity": "error",
        "tier": "formal",
        "requirementIds": ["056e554e-…", "8301fa27-…"],
        "message": "Requirements 056e554e-…, 8301fa27-… are temporally inconsistent: no trace of length ≤ 10 satisfies them jointly (bounded LTL→SMT). A sound contradiction; not bound-dependent to refute.",
        "evidence": { "atomTable": [], "temporal": { "bound": 10, "complete": false } }
      }
      // …here the propositional tier ALSO fires an FND_CONTRADICTION (same
      // response atom, opposite polarity — hence "error": 2), plus a WARN-level
      // GTWR_R16_NEGATION on "shall not" (not gated), never a GTWR_R26_ABSOLUTE.
    ],
    "excluded": [],
    "counts": { "error": 2, "warn": 3, "info": 0 }
  }
}
# exits 1 — an error-severity finding is present
```

The `{ bound: 10, complete: false }` evidence is the sound-for-UNSAT honesty
marker: the conflict was proven within a 10-step trace, and a clean run at some
bound is never read as a full consistency certificate.

### 4. Semantic — core paraphrase + opposition bridging (local ONNX embeddings)

`src/formal/embed.ts`, `model-cache.ts`, `semantic.ts`. **Core on every
`check`** — a red-team eval proved that a certification gate whose opposition
detector can be silently skipped is gameable by omission, so a missing model
now fails the run closed (`ERR_EMBED_MODEL_MISSING`, exit 2) instead of
degrading. Pre-warm once with `symspec download-model`; air-gapped hosts work
offline from the sha256-pinned cache. (`--semantic` remains as a deprecated
no-op flag.) The formal tier is *sound modulo atomization*, so a real conflict
can hide when two responses are worded differently ("issue a session token" vs
"issue a login credential" are distinct atoms). The semantic tier closes that
gap **without breaking determinism**, by splitting PROPOSE from DECIDE:

- **PROPOSE (fuzzy).** For each unmerged same-system response pair, symspec
  embeds both phrasings and, when their cosine similarity clears a threshold
  (default `0.72`, `--semantic-threshold`), emits an info-tier
  `FND_SIMILAR_SEMANTIC` finding suggesting a concrete `symspec glossary add`.
  Never a verdict. The `0.72` default is tuned to this model's *real* cosine band
  (CLS-pooled, L2-normalized, no instruction prefix): divergent-wording
  paraphrases land at ~0.75–0.79 and unrelated same-domain pairs at ~0.44–0.58,
  so the old `0.82` sat above the paraphrase band and silently missed real
  matches. Because this tier only *proposes* — a miss hides a provable conflict
  while a false suggestion costs one ignored glossary line — it favors recall;
  override per-run with `--semantic-threshold`. The embeddings run on the pinned `bge-base-en-v1.5` model via
  **`onnxruntime-web` (WASM execution provider, single-threaded) with a pure-JS
  tokenizer** — no native `onnxruntime-node` binary, no `@huggingface/transformers`.
  Vectors are CLS-pooled and L2-normalized (how BGE was trained), so cosine is a
  dot product.
- **DECIDE (deterministic).** A committed `glossary` in the document maps aliases
  → a canonical phrasing (`symspec glossary add/remove/list`). `atomize`
  canonicalizes through it *before* the antonym step, so agent-confirmed
  synonyms collide on one atom and the existing SMT contradiction check proves
  the conflict. The verdict path reads the committed glossary, never the model.

The **opposition** counterpart works the same way. Cosine cannot tell antonymy
from synonymy — opposite words embed *close*, not far — so the opposition
proposal is a *deterministic* structural signal (same object, different leading
verb after de-inflection, not already unified — plus a morphological
`de-`/`un-`/`dis-` prefix check that fires even below the topical cosine
floor), surfaced as an info-tier `FND_OPPOSITION_CANDIDATE` that suggests
`symspec antonym add <a> <b>`. Committing that pair is the DECIDE half:
`atomize` folds it into the seed antonym table's signed union-find, so
`open the valve` / `shut the valve` collapse to one atom at opposite polarity
and `check` proves the contradiction the seed table missed. An **untriaged**
opposition candidate demotes `data.verified` — the demotion-only principle:
propose-only findings can push `verified` toward abstention, never toward
certification — and `data.coverage.demotions` names the discharging command
(`antonym add`, `glossary add`, or `waive`). `symspec antonym add/remove/list`
manages the committed pairs; a pair that would make the antonym classes
inconsistent is rejected at write time so `check` stays throw-free.

The model (~110 MB) is fetched into an OS cache dir and verified against a
pinned sha256, so runs are reproducible after the first fetch and fully offline
thereafter. Pre-warm it with `symspec download-model` (for air-gapped or CI
machines, run once wherever the cache dir is provisioned; or set
`SYMSPEC_EMBED_ALLOW_REMOTE=1` to let a run fetch it). When the model is absent
and remote fetching is disabled, `check` returns `ERR_EMBED_MODEL_MISSING` and
exits `2` **before any tier runs** — fail closed, because a certification whose
opposition detector silently skipped is not a certification.

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
  operational failure (error envelope on stdout), `3` a requested strict coverage
  gate tripped on an otherwise error-free run. Output flags never change the exit
  code.
- **Verified vs inconclusive** — `check`'s payload carries a first-class
  `data.verified` boolean, and it is a *whole-document* claim: `true` only when
  every requirement participated in a cross-requirement comparison, every
  opposition candidate was triaged, and the decide tier actually ran (see
  [The certification loop](#the-certification-loop)). `data.coverage` breaks
  down per-requirement participation, singleton atoms, and the `demotions[]`
  work list with discharging commands. Gate on it with `check --strict` (a
  demoted run → exit `3`) or `--fail-on-unmatched <n>` — the machine-readable
  form of "silence is not a consistency certificate".
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

### Which argument is the requirements document?

How a command receives the requirements file depends on whether it already needs
a required positional argument of its own (a UUID, key, or relation):

- **Positional `[file]`** — commands with no other required positional take the
  document as their first positional: `init`, `add`, `check`, `certify`, `list`,
  `export`.
- **`--file <path>` option** — commands whose positional is a requirement
  reference (UUID/key/relation) take the document via the option instead, so the
  positional stays unambiguous: `update`, `show`, `derive`, `satisfy`,
  `remove-edge`, `delete`, `glossary`, `waive`.
- **`--doc <path>` option** — `apply` is the exception: its positional is the
  JSONL op stream, so the target document is the separate `--doc` flag.

For every command the resolution precedence is the same (`src/cli/resolve-doc.ts`):
explicit path/flag → the `SYMSPEC_DOC` environment variable → the default
`./requirements.json`. An empty or whitespace-only value at any source is treated
as absent and falls through to the next.

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
  formal/              # SMT tier — atomize, antonyms, lemma (vendored verb
                       #   de-inflection), encode, backend (z3 WASM),
                       #   contradiction, subsumption, guard-implication, vacuity,
                       #   incomplete, similar, needs-review, finding (evidence),
                       #   emit-smt2, binary-backend, codes
                       # numeric tier (v3.0) — numeric (predicate extraction),
                       #   numeric-contradiction (LIA/LRA joint-SAT, default on)
                       # ambiguity tier (v3.1) — ambiguity (vague/quantifier/reference, default on)
                       # temporal tier (v3.3) — temporal-patterns (EARS→LTL),
                       #   temporal (bounded LTL→SMT, opt-in --temporal)
                       # semantic + graph (v3.1–v3.2) — embed (onnxruntime-web WASM + tokenizer),
                       #   model-cache (fetch + sha256-verify + cache), semantic (paraphrase finder),
                       #   graph (deterministic kNN trace-link/duplicate proposals, core/always-on)
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
  eval-rounds.ts       #   pinned red-team eval rounds — proof or abstention, never a clean lie
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

---

## Glossary

Plain-language definitions for the terms and abbreviations used above.

| Term | Meaning |
|---|---|
| **Agent (coding agent)** | An AI assistant that writes and edits code and specs — e.g. Claude Code, Cursor, Codex — usually by running commands like symspec on your behalf. |
| **Spec / requirement** | A single statement of what a system must do (e.g. *"When the user logs in, the system shall issue a token"*). A spec is a collection of these. |
| **EARS** | *Easy Approach to Requirements Syntax.* A simple, widely used set of sentence templates (ubiquitous, event-driven, state-driven, optional-feature, unwanted-behavior) that keep requirements clear and consistent. |
| **INCOSE GtWR** | The International Council on Systems Engineering's *Guide to Writing Requirements* — an industry standard of writing rules (avoid vague words, one requirement per sentence, and so on). symspec checks 24 of them automatically. |
| **Lint** | An automatic check for style and clarity problems in text, borrowed from the term for code linters. |
| **Formal / "proves"** | A result backed by mathematics, not a guess. If symspec says two requirements contradict, a solver has proven it; a clean result means no conflict was *proven*, not that the spec is guaranteed perfect. |
| **Theorem prover / solver** | Software that can mathematically determine whether a set of logical statements can all be true at once. |
| **SMT** | *Satisfiability Modulo Theories* — the category of solver symspec uses. It answers "is there any way to make all these statements true simultaneously?" and, if not, explains why. |
| **Z3** | The specific SMT solver symspec runs. It ships built in (compiled to WebAssembly), so there's nothing extra to install. |
| **Unsat core** | Short for *unsatisfiable core*: the smallest subset of requirements that already conflict. symspec reports this so you know exactly which ones to fix, not just that "something" is wrong. |
| **Atom** | The normalized, canonical form of a requirement's action (e.g. "grant access") that the logic checker compares. Two requirements clash when their atoms match but their polarity (do vs. don't) is opposite. |
| **Antonym table** | symspec's curated list of opposite-verb pairs (grant↔deny, commit↔roll back, seal↔expose, …). It's what lets the prover see that "grant access" and "deny access" are one claim with opposite polarity. Grows only by explicit edit or your confirmed `antonym add`. |
| **Coverage / demotion** | `data.coverage` reports which requirements the prover actually compared and what's still untriaged. Any gap *demotes* `data.verified` to `false` with a listed fix — fuzzy signals can lower confidence but never raise it. |
| **Opposition candidate** | A suggestion that two requirements may be opposites ("admit" vs "block" the same request). You decide: opposites (`antonym add`), synonyms (`glossary add`), or neither (`waive`). Untriaged candidates block certification. |
| **LIA / LRA** | *Linear Integer Arithmetic* / *Linear Real Arithmetic* — the kinds of number reasoning the solver uses to catch conflicting limits like "under 2 seconds" vs "over 3 seconds". |
| **LTL** | *Linear Temporal Logic* — a standard way to express timing and ordering rules ("eventually", "never", "until") so the timing checker can test them. |
| **Sound-for-UNSAT** | A precise honesty guarantee: when the timing checker reports a conflict, it's real; but because it checks a bounded window, *not* finding one isn't a full guarantee of safety. symspec labels this in its output. |
| **Semantic / embeddings** | Techniques that measure how similar two phrasings *mean*, even when the words differ. symspec uses a small local model to *suggest* that two requirements might be talking about the same thing; a human or agent confirms before it affects any verdict. |
| **Deterministic / reproducible** | Same input always produces the same output. symspec keeps every build-blocking result deterministic so results never drift between runs or machines. |
| **Glossary (in symspec)** | A saved list of confirmed synonyms in your document. Distinct from *this* glossary — in symspec, it's how you tell the tool "these two phrasings mean the same thing," committed to your project so the decision is permanent. |
| **Lean 4** | A *proof assistant* — software mathematicians use to write proofs a computer verifies. symspec can optionally emit a Lean proof artifact anyone can independently re-check. |
| **Manifest** | A single command (`symspec manifest`) that describes the entire tool as structured data, so an agent can learn every command and option in one call instead of trial and error. |
| **JSON envelope** | The consistent structured shape every command returns: a success wrapper `{ apiVersion, type, data }` or an error wrapper `{ ..., code, suggestions }`. Lets an agent reliably tell success from failure without reading prose. |
| **Result code** | A short, stable identifier for a specific finding or error (e.g. `FND_CONTRADICTION`, `ERR_DOC_NOT_FOUND`). Codes are only ever added, never renamed, so automation built on them keeps working. |
| **Waive** | To deliberately set aside a specific warning with a recorded reason, so intentional style choices don't clutter every future review. |
| **Atomic (transaction)** | All-or-nothing: `symspec apply` either applies an entire batch of edits or, if any step is invalid, saves nothing at all. |
| **CI** | *Continuous Integration* — the automated pipeline that runs checks on every code change. symspec's exit status plugs straight into one. |
| **PATH** | The list of folders your shell searches for commands. Installing symspec "on your PATH" means you can type `symspec` from anywhere. |
| **WebAssembly (WASM)** | A portable format that lets software like the Z3 solver run inside any environment with no separate install. |
