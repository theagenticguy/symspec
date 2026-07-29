# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**symspec writes software requirements you can *prove* consistent — and is honest
when it can't.** You describe what a system should do in plain, structured
sentences; symspec turns each into a clean requirement, and a mathematical prover
(Z3, optionally cross-checked against a second solver) either **proves** that two
of them can't both be true — naming the exact culprits — or tells you
`verified: false` and hands back the precise work list to make the spec provable.

That last part is the whole point. Most "spec review" is a language model writing
a confident paragraph that misses the real conflict. symspec makes the check
**mechanical**: a conflict is either proven or it isn't, and *"verified"* is a
claim the tool refuses to make unless a prover actually discharged it. A fuzzy
similarity score can never certify your spec. Only a sound proof can.

It works for the person authoring a spec and for the coding agent driving it:
every command answers with structured JSON and a stable exit code, so an agent
always knows whether it succeeded and what to do next — and a human reads the same
result with `--pretty`.

*(New here? Every abbreviation is spelled out on first use, and there's a
plain-language [glossary](#glossary) at the bottom. Start with
[What a requirement is, and what "proving" it means](#what-a-requirement-is-and-what-proving-it-means).)*

---

## Quick start

```bash
# Install the command-line tool globally
git clone https://github.com/theagenticguy/symspec.git && cd symspec
pnpm install && pnpm build && pnpm pack
npm install -g ./symspec-*.tgz     # puts the `symspec` command on your PATH

# One-time: fetch the local embedding model (~110 MB, sha256-pinned) that the
# always-on meaning-similarity tier runs. Fully offline afterward.
symspec download-model
```

symspec writes requirements in the **EARS** style (Easy Approach to Requirements
Syntax — a small set of sentence templates like *"When X happens, the system
shall do Y"*). You give it the pieces; it writes the sentence and keeps the whole
set consistent.

Start a document, add two requirements, and check them. Every command prints its
result as structured data (JSON) by default:

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
        "message": "Requirements 586d8933-…, d50c8fff-… cannot all hold: their responses resolve to the same atom with opposite polarity under a reachable context.",
        "evidence": { "...": "the atom table the checker compared, and the unsat core" }
      }
    ],
    "counts": { "error": 1, "warn": 0, "info": 0 }
    // trimmed here: the real envelope also carries excluded, pairsChecked,
    // waived, residualRisk, coverage, and verified
  }
}
# the command also exits with status 1 — a blocking problem was found
```

**The exit status is the pass/fail signal**, so a script or CI pipeline can gate
on it without reading anything: `0` = clean (or only warnings), `1` = a blocking
problem was found, `2` = the command itself couldn't run (bad arguments, missing
file, missing model), `3` = a `--strict` gate found the run *inconclusive* —
nothing was proven wrong, but the spec couldn't be verified either, and the
output says exactly why.

**Let your agent set it up for itself.** Run `symspec install` and it drops a
small "skill" file into whichever AI coding assistant you have — Claude Code,
Cursor, Codex, Kiro, Windsurf, or GitHub Copilot — so the assistant learns to use
symspec on its own. It writes only into each tool's dedicated skills folder and
never edits your existing instruction files.

---

## What a requirement is, and what "proving" it means

A **requirement** is one statement of what a system must do — *"When the user logs
in, the system shall issue a token."* A **spec** is a set of them. Requirements
are where software goes wrong *before* anyone writes code: two of them quietly
contradict, one sentence secretly bundles two demands, or a speed limit reads
"under 2 seconds" here and "over 3 seconds" there. People skim past these. So do
language models asked to "review the spec" in prose.

symspec doesn't review in prose. It **proves**. Under the hood it translates your
requirements into logic and hands them to an SMT solver — **Z3**, a mature
automated theorem prover — that answers one question exactly: *is there any way
for all of these to be true at once?* If the answer is no, that's not an opinion —
it's a mathematical fact, and symspec reports the **unsat core**: the smallest
subset of requirements that already conflict, so you fix the right ones instead of
guessing.

Two guarantees define how far that proof reaches, and symspec states both plainly
rather than letting you assume more:

- **When symspec proves a conflict, the conflict is real** as the requirements were
  atomized. Every finding carries the atom table the solver compared, so you can
  audit the one false-positive risk: normalization collapsing two distinct
  conditions onto a single atom.
- **Silence is not a certificate.** Because two differently-worded requirements
  can describe the same thing, symspec can *miss* a conflict hiding behind
  mismatched vocabulary. A clean result means *"nothing was proven wrong,"* not
  *"guaranteed perfect."* This is why `verified: true` is earned, not assumed —
  see [Honest verdicts](#honest-verdicts--verified-false-and-the-work-list).

That honest limit is exactly what the next section closes.

---

## Why a prover beats reading it yourself

The grant/revoke example above is easy — the two requirements sit side by side and
plainly disagree. Real conflicts don't. They emerge from a *chain* of
individually-reasonable requirements whose combination is impossible, and no human
reviewer holds the whole chain in their head. Here is one from symspec's own
red-team eval — a reactor controller, four requirements, each of which any engineer
would wave through:

```console
$ symspec add reactor.symspec.json --pattern event-driven --system "controller" \
    --response "mark the coolant pump engaged" --trigger "the temperature sensor reports overheating"
$ symspec add reactor.symspec.json --pattern state-driven --system "controller" \
    --response "keep the reactor online" --pre "the coolant pump is engaged"
$ symspec add reactor.symspec.json --pattern state-driven --system "controller" \
    --response "grant power to the distribution grid" --pre "the reactor is online"
$ symspec add reactor.symspec.json --pattern event-driven --system "controller" \
    --response "deny power to the distribution grid" --trigger "the temperature sensor reports overheating"
```

Rendered, the four read:

> 1. *"When the temperature sensor reports overheating, the controller shall mark the coolant pump engaged."*
> 2. *"While the coolant pump is engaged, the controller shall keep the reactor online."*
> 3. *"While the reactor is online, the controller shall grant power to the distribution grid."*
> 4. *"When the temperature sensor reports overheating, the controller shall deny power to the distribution grid."*

Read them one at a time and nothing looks wrong — a safety interlock, a normal
state cascade, two power rules. But follow the chain: an overheat event (1) engages
the pump, which (2) keeps the reactor online, which (3) grants power to the grid —
*on the same overheat event* where requirement 4 demands power be **denied**. The
spec requires the grid to be powered and unpowered simultaneously. It's
unsatisfiable, and the impossibility only exists three hops away from where it's
introduced.

`symspec check` proves it and names the **entire** chain, not just the two endpoints:

```jsonc
{
  "code": "FND_CONTRADICTION",
  "severity": "error",
  "requirementIds": ["63bd5b73-…", "65e09308-…", "77982f25-…", "97c5394b-…"],
  "message": "Requirements 63bd5b73-…, 65e09308-…, 77982f25-…, 97c5394b-… cannot all hold: their responses resolve to the same atom with opposite polarity under a reachable context.",
  "evidence": { "core": ["63bd5b73-…", "65e09308-…", "77982f25-…", "97c5394b-…"] }
}
# exits 1
```

Delete requirement 2 or 3 — the bridge — and the same `check` exits `0`: the two
power rules alone are genuinely consistent. The conflict *is* the chain. That's the
class of defect a prover catches and a careful human reader does not. symspec takes
each distinct set of triggers and preconditions the document uses — here, the
overheat trigger — asserts that one context, conjoins every requirement in the
document under it, and asks Z3 whether a single assignment satisfies them all. Z3
weighs the whole set in one question, where a reader works through it a pair at a
time. This is symspec's core job; the next section is about the case where even the
chain is hidden behind mismatched *words*.

---

## Encoding meaning into a spec — the neurosymbolic core

Here's the problem a pure logic checker can't solve alone. Consider one infusion
pump, two requirements:

> *"When the pump starts, the controller shall **complete** the infusion within at
> most 30 minutes."*
> *"When the pump starts, the controller shall **run** the infusion for at least
> 60 minutes."*

To you, these obviously clash — 30 minutes can't also be 60. But to a literal
checker they're two different quantities: one is about *completing*, the other
about *running*. The words don't match, so a naive tool compares nothing and
reports all-clear. That's the gap where real conflicts hide.

symspec closes it in two moves that **never blur together** — this split is the
heart of the design:

1. **PROPOSE (the fuzzy part).** A small language model running **locally on your
   machine** measures how close two phrasings *mean*, and deterministic detectors
   spot structural tells — same object, opposite direction, opposed numeric
   bounds. In the infusion case symspec notices both requirements bound the same
   thing on the same trigger in opposite directions and emits an *info* finding,
   `FND_QUANTITY_ALIAS_CANDIDATE`, carrying the **exact command** that would tell
   it these two phrasings name one quantity:
   `symspec glossary add "complete the infusion" "run the infusion"`. Until you
   run it, symspec does **not** claim the spec is consistent — it marks
   `verified: false`, because it knows it hasn't actually compared the two.

2. **DECIDE (the sound part).** Once you commit that glossary link, the meaning is
   now **encoded in the spec itself** — both phrasings route to one quantity — and
   Z3 proves the real conflict: ≤30 ∧ ≥60 is unsatisfiable. It reports
   `FND_NUMERIC_CONTRADICTION` and names both requirements.

This is what "neurosymbolic" means here: the neural component (embeddings that
judge meaning) is only ever allowed to **suggest** what two phrasings mean; a
human or agent **commits** that meaning as a durable glossary or antonym entry;
and only then does the mathematically sound layer use it to decide. Meaning
becomes *data in your document*, not a guess the tool made silently — so the same
input gives the same answer, every time.

The same machinery bridges opposites (`antonym add seal expose` collapses "seal
the record" and "expose the record" onto one atom at opposite polarity) and plain
paraphrases ("issue a token" vs "grant a credential"). You decide the vocabulary
once; symspec keeps it decided.

---

## Honest verdicts — `verified: false` and the work list

symspec is built around one workflow: **an agent (or a person) iterates on a spec
until it genuinely certifies.** `check --strict` is the gate, `data.verified` is
the claim, and `data.coverage.demotions` is the work list.

`verified: true` is a deliberately *hard* claim. It does not mean "no conflict was
found." It means the prover actually verified the whole document:

1. **Every requirement participates** — it shares vocabulary with at least one
   peer, so the prover genuinely compared it. A requirement in its own private
   vocabulary is an island, and an island is where a contradiction hides.
2. **Every opposition candidate is triaged** — when two requirements act on one
   object with different verbs, symspec proposes the pair; until you decide
   (`antonym add`, `glossary add`, or `waive`), the run won't certify.
3. **A cross-requirement comparison actually happened**, and the meaning tier ran.

When any of these fail, `verified` is `false`, `--strict` exits `3`, and every
reason appears in `data.coverage.demotions` **with the exact command that
discharges it**:

```jsonc
"coverage": {
  "encoded": 12,
  "excluded": 0,
  "pairsCheckedNote": "…why a low pair count is expected here…",
  "demotions": [
    {
      "reason": "quantity-alias-candidate",
      "requirementIds": ["45defae7-…", "20aa64dc-…"],
      "action": "If both bounds constrain one quantity, run `symspec glossary add \"…\" \"…\"` so the numeric tier can prove any conflict; otherwise waive."
    }
  ]
}
```

So the loop converges mechanically, no human in the middle:

```
check --strict          # exit 3 — verified: false
  → read coverage.demotions
  → apply the listed ops (glossary add / antonym add / waive)
    or rewrite the named requirements to align vocabulary
check --strict          # repeat…
  → exit 0, verified: true — or exit 1 with a PROVEN contradiction
    the vocabulary alignment just exposed
```

One principle governs all of it — **demotion-only**: fuzzy signals (embedding
similarity, coverage gaps, untriaged proposals) can push `verified` toward `false`
(raise the alarm), but only the deterministic proof tier can produce the
all-clear.

**Coverage is loud, never silent.** A requirement dropped from the prover by an
error-severity lint raises a first-class `FND_EXCLUDED_FROM_FORMAL` and demotes
`verified` — silence over an unchecked requirement is never a clean bill of
health. Re-admit it by fixing the lint, or by waiving the *blocking* finding
(`symspec waive add <code> --ref <id>`), which returns the requirement to the
solver; waiving the disclosure alone does not restore coverage. And what no sound
extractor can recover from prose — aggregate/conservation sums, cross-quantity
arithmetic, emergent structural impossibility — is not silently passed either:
`check` flags the *shape* with `FND_RELATIONAL_UNCHECKED` and demotes, so
"verified" never outruns what was actually compared.

---

## Put through its paces — the adversarial loop

symspec has been through a real red-team eval, not a marketing demo.

A frontier-model proposer (Opus 4.8) authored requirement specs containing
genuine, machine-provable contradictions — with a blind judge panel and Z3 as the
oracle — and tried to get symspec to certify them clean. Early symspec fell for
**25 of 30**. After a first round of hardening it was **28 of 30**; the last
escapes lived in the numeric tier's structural blind spots — a bound keyed off the
verb phrase, an aggregate never summed, an emergent impossibility no lexicon
reaches. [GitHub issue #2](https://github.com/theagenticguy/symspec/issues/2)
closed them the only sound way: **every escape becomes either a *proven*
contradiction** (when a sound extractor can reach it — like the infusion example
above) **or an *honest demotion*** — `verified: false` with the exact command to
make it provable — when no sound extractor can.

Every winning round is now a pinned regression fixture: **12 rounds, 13 green
tests** in `adversarial/eval-rounds.ts`. Proof rounds assert the contradiction
fires and names the planted culprits; abstention rounds assert the hardened
`verified` *demotes* with actionable reasons instead of certifying a lie. The
eval's original win condition — a clean certificate over a hidden contradiction —
is now unreachable on every pinned round.

Alongside it, a **generative-adversarial harness** (`adversarial/generate.ts`)
keeps authoring increasingly subtle specs across five defect classes and checks
symspec's verdict against Z3 ground truth, so the checkers stay honest as the code
evolves.

> The claim is not "symspec is unbreakable." It's the honest one: **every known
> way to break it is now a test** — and every break was closed by either proving
> the conflict or admitting the tool couldn't, never by widening what counts as
> "verified."

---

## The engines

symspec pairs a fast, **fully repeatable** core with one optional "smart" layer
that can only *suggest* — never decide. Run it twice on the same document and you
get the exact same answer. Each row is one checking engine; "proves" means a
mathematical guarantee, not a heuristic.

| Engine | What it catches | How |
|---|---|---|
| **Sentence parser** | turns prose into a clean requirement, or explains the rewrite it needs | pattern-matching first; only reaches for a language parser on hard sentences |
| **Writing-quality lint** | broken cross-references, circular links, missing pieces, and 24 industry-standard writing rules | the *Guide to Writing Requirements* by INCOSE; each flag carries the offending span and a fix |
| **Logic checker** *(the core)* | two requirements that can't both be true; one that makes another redundant; a rule that can never fire | the **Z3** theorem prover in-process — nothing to install — showing the minimal reason for each verdict |
| **Numbers checker** | conflicting limits, like "under 2 seconds" vs "over 3 seconds" on the same measurement | the same prover, reasoning about arithmetic (LIA/LRA) |
| **Timing checker** *(opt-in)* | ordering and timing clashes, like "on overheat, open the valve" vs "the controller shall not open the valve" | translates timing rules into logic tested over a bounded timeline |
| **Ambiguity checker** | vague words, "and/or" read two ways, pronouns with no clear referent | fixed detectors; genuinely judgment-call ambiguity is flagged for a human/agent, never silently guessed |
| **Meaning-similarity layer** *(core, always-on)* | conflicts hidden behind different wording, and possible opposites the prover can't yet see | a small language model running **locally** that *suggests*; you confirm with `glossary add`/`antonym add`, then the logic checker proves the conflict. A missing model fails the run rather than skipping the layer |
| **Coverage accountant** | requirements the prover never compared, and suggestions left untriaged | a deterministic participation tally; anything uncovered demotes `verified` with a fix in `coverage.demotions` |
| **Lean toolchain probe** *(opt-in)* | nothing about your spec yet: it emits placeholder `True` theorems, so it reports the same result for a spec `check` proves contradictory | the **Lean 4** proof assistant elaborates the generated file and reports its axiom provenance; `data.certified` stays `false` until a semantic EARS→Lean encoding lands |

The rule that holds it together: **anything that can block your build is perfectly
reproducible from the document plus a couple of pinned, version-controlled
inputs.** The one "smart" layer runs on every check but can only *suggest*; its
decisions get reviewed by a person or agent and saved into the project
(`glossary`, `antonyms`, `waivers`) so they never vary again.

In numbers: **22 commands**, **75 stable result codes** (21 error, 24 lint, 30
finding) that only ever get added — never renamed or removed — so automation built
on them keeps working; a self-describing `manifest`, structured output
everywhere, a compact `--dense` mode for token-limited agents, and the adversarial
suite above.

---

## Built for an agent to drive

symspec is designed to be driven by a coding agent, not scraped from human prose.
The full command reference, argument schemas, and code catalogs live in
[`docs/`](docs/README.md) and in `symspec manifest` — here's what makes the
surface agent-friendly:

- **`manifest`** — one call returns the entire tool as JSON: every command,
  per-command argument schema (from the same Zod fields the runtime validates
  against), the stable code catalogs, the honest-scope disclosure, the recognized
  numeric units, and a live `backends` report (z3-wasm, external `z3`/`cvc5`,
  Lean) with resolved versions. Fetch it once, then drive without trial and error.
- **Typed envelopes** — every success is `{ apiVersion, type, data }`; every
  failure is `{ apiVersion, type: "error", error, code, suggestions, partial? }`.
  An agent version-negotiates on `apiVersion` and switches on `type` uniformly.
- **Stable codes** — `ERR_*`, `FND_*`, and `GTWR_*` are exported Zod enums, each
  with a per-code description, append-only (a snapshot test guards against
  renumbering or removal). The manifest derives its code tables from the same
  enums, so emitter and docs cannot drift.
- **`--field`** — jq-style projection of the JSON envelope, so an agent can pull
  exactly `data.verified` or `data.coverage.demotions` without a JSON parser.
- **`--dense`** — token-economical output: minified, default/null keys dropped,
  heavy evidence elided (pass `--evidence` to keep it); same schema, round-trips.
- **Exit codes** — `0` clean, `1` a blocking finding, `2` an operational failure,
  `3` a strict coverage gate tripped. Output flags never change the exit code.
- **Importable library** — the CLI is a thin formatter over `src/index.ts`:
  `import { applyChange, analyze, runCheck, checkGtWRules, atomize } from 'symspec'`.
- **`AGENTS.md`** — the agent-integration guide, generated from the same
  description corpus that drives `manifest`, so it stays in lockstep with the real
  command surface.

Build a whole spec in one safe move with `symspec apply`: a batch of edits applied
as a single all-or-nothing transaction, with forward-referenceable human keys
(`G1`, `AUTH-3`) that resolve before permanent IDs exist. If any step is invalid,
nothing is saved and you're told which line failed.

> "I authored a 25-requirement architecture spec in a single atomic `symspec
> apply` batch — every requirement, every `derives` edge, stable human keys
> resolving forward before the UUIDs existed — and it either all landed or none of
> it did. Then `check` handed me stable codes with character spans and rewrite
> suggestions I could act on without guessing, `waive` let me suppress intentional
> style findings with a recorded reason, and the meaning tier flagged one
> genuinely-similar pair I kept distinct on purpose. It never made me parse prose
> to find out whether I'd succeeded."
>
> — *An Opus 4.8 Claude Code agent*

---

## How it works, in depth

For the full pipeline — the regex-first parse ladder, atomization and the antonym
table, the Z3 encoding and unsat-core extraction, the numeric/temporal/ambiguity
tiers, the local-ONNX meaning tier, and the optional Lean 4 tier — see the
generated documentation tree under [`docs/`](docs/README.md): a module map,
data-flow and sequence diagrams, the public API and CLI reference, a contract map,
and a debugging guide, all cited to source.

The shape of it: symspec runs a **forced pipeline** — `parse → lint → check →
certify` — and the order is load-bearing. A statement that fails an earlier
surface stage is *excluded* from the formal stage (feeding unparsed or
dangling-reference text into an SMT encoding would be unsound) and the exclusion is
reported, never silent. The formal stage is **sound modulo atomization**: every
reported conflict is genuine; a missed one hides behind unmatched vocabulary —
which is what the meaning tier and the propose/decide loop exist to surface.

---

## Development

```bash
pnpm install           # from lockfile
pnpm build             # tsdown → dist/ (library + CLI entry, with .d.ts)
pnpm cli <command>     # run the CLI from source without building (tsx)
pnpm test              # vitest run
pnpm check             # full gate: biome ci + tsc --noEmit + vitest run + knip
pnpm gen:agents        # regenerate AGENTS.md from the manifest (check:agents guards drift)
```

**Quality gate.** `pnpm check` is the merge gate; a non-zero exit on any of the
four sub-checks is a blocker. `pnpm gen:agents` after touching command
descriptions or the manifest — AGENTS.md drift is a test failure.

**Solvers.** The default `check` needs nothing but the bundled `z3-solver` WASM
package. Optional external binaries are pinned in `mise.toml` (commented out by
default): `z3`/`cvc5` for the `--solver` cross-check, `elan` for the Lean
`certify` tier.

This project also carries its hard-won lessons in-repo under `.erpaval/` (design
invariants, tooling edge cases, agent-workflow gotchas), surfaced to Claude Code
at session start so they travel with the code.

---

## Glossary

Plain-language definitions for the terms used above.

| Term | Meaning |
|---|---|
| **Agent (coding agent)** | An AI assistant that writes and edits code and specs — e.g. Claude Code, Cursor, Codex — usually by running commands like symspec on your behalf. |
| **Spec / requirement** | A single statement of what a system must do (*"When the user logs in, the system shall issue a token"*). A spec is a collection of these. |
| **EARS** | *Easy Approach to Requirements Syntax.* A small set of sentence templates (ubiquitous, event-driven, state-driven, optional-feature, unwanted-behavior) that keep requirements clear and uniform. |
| **INCOSE GtWR** | The International Council on Systems Engineering's *Guide to Writing Requirements* — an industry standard of writing rules. symspec checks 24 of them automatically. |
| **Formal / "proves"** | A result backed by mathematics, not a guess. If symspec says two requirements contradict, a solver proved it; a clean result means no conflict was *proven*, not that the spec is guaranteed perfect. |
| **SMT** | *Satisfiability Modulo Theories* — the category of solver symspec uses. It answers "is there any way to make all these statements true at once?" and, if not, why. |
| **Z3** | The specific SMT solver symspec runs, compiled to WebAssembly, so there's nothing extra to install. |
| **Unsat core** | The smallest subset of requirements that already conflict — why symspec can name the exact culprits, not just "something's wrong." |
| **Neurosymbolic** | Combining a neural/fuzzy component (embeddings that judge meaning) with a symbolic/logical one (the SMT prover). Here, neural *proposes* and symbolic *decides*. |
| **Atom / atomization** | The normalized canonical form of a requirement's action (e.g. "grant access") that the logic checker compares. Two requirements clash when their atoms match but their polarity (do vs. don't) is opposite. |
| **Propose / decide** | The load-bearing split: fuzzy signals may only *propose* vocabulary links; only a committed artifact plus the sound prover may *decide* a verdict. |
| **Demotion** | A coverage gap or untriaged proposal pushing `verified` toward `false`. Fuzzy signals can demote (lower confidence) but never promote (certify). |
| **Antonym table** | symspec's curated list of opposite-verb pairs (grant↔deny, seal↔expose, …) that lets the prover see "grant access" and "deny access" as one claim at opposite polarity. Grows only by explicit edit or your confirmed `antonym add`. |
| **Glossary (in symspec)** | A saved list of confirmed synonyms committed to your document — how you tell the tool "these two phrasings mean the same thing," permanently. |
| **Coverage** | `data.coverage` reports which requirements the prover actually compared and what's still untriaged. Any gap demotes `verified`. |
| **Sound modulo atomization** | The precise honesty guarantee: every reported conflict is real *as the requirements were atomized*; a conflict can still hide behind unmatched vocabulary, so silence is not a certificate. |
| **LIA / LRA** | *Linear Integer / Real Arithmetic* — the number reasoning the solver uses to catch conflicting limits like "under 2 seconds" vs "over 3 seconds". |
| **LTL / sound-for-UNSAT** | *Linear Temporal Logic* expresses timing/ordering rules; the timing checker is sound-for-UNSAT — a reported conflict is real, but a clean run over a bounded window isn't a full guarantee. symspec labels this in its output. |
| **Lean 4** | A *proof assistant* — software that verifies proofs. `symspec certify` optionally runs it. The file it emits carries placeholder `True` theorems in place of your requirements, so a clean elaboration attests that the toolchain ran, and says nothing about whether your spec is consistent. Never required for `check`, and never a consistency gate. |
| **Manifest** | One command (`symspec manifest`) that describes the entire tool as structured data, so an agent learns every command and option in one call. |
| **JSON envelope** | The consistent shape every command returns: `{ apiVersion, type, data }` on success or `{ …, code, suggestions }` on error. |
| **Result code** | A short, stable identifier for a finding or error (`FND_CONTRADICTION`, `ERR_DOC_NOT_FOUND`). Only ever added, never renamed. |
| **Waive** | To deliberately set aside a specific finding with a recorded reason, so intentional choices don't clutter every future review. |
| **Deterministic / reproducible** | Same input always produces the same output. symspec keeps every build-blocking result deterministic so results never drift between runs or machines. |
| **CI** | *Continuous Integration* — the automated pipeline that runs checks on every change. symspec's exit status plugs straight in. |
| **WebAssembly (WASM)** | A portable format that lets software like Z3 run in any environment with no separate install. |
