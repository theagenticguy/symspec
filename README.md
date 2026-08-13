# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Your coding agent writes requirements. symspec finds the two that can't both be true — and
proves it.**

Ask an agent to spec a feature and you get a plausible list. The expensive bug is rarely
inside one requirement; it is between two that quietly disagree, and you find it three weeks
later in the code. Reviewing for that by hand is slow and easy to get wrong. Asking another
LLM to review it gets you a confident paragraph that misses the conflict.

symspec does it mechanically. It turns each requirement into a structured sentence, hands the
whole set to a mathematical prover (Z3), and one of two things happens:

- it **proves** two requirements contradict, and names which ones, or
- it tells you it could not prove anything, and hands back the exact work list.

It never says "looks fine". `verified: true` is a claim it refuses to make unless a prover
actually discharged it — so a clean result means *no conflict was proven*, not *there is no
conflict*. That distinction is the whole point, and the tool is built to keep saying it out
loud rather than let a green checkmark imply more than it earned.

**Everything answers with JSON and a stable exit code**, so an agent can run it in a loop and
know what to do next without parsing prose. Add `--pretty` to read the same result yourself.
Four properties make that loop safe to automate, and none of them is specific to requirements
or to Z3 — see [The agent-CLI contract](#the-agent-cli-contract).

**What it reads.** Requirements in [EARS](#what-is-in-the-box) form — *"When \<trigger>, the
\<system> shall \<response>"* and its four siblings. A sentence that misses the shape gets one
repair attempt from a linguistic pass, and is otherwise reported as a parse failure with the
slots it could recover. **Narrative prose is not in scope**: point this at a design doc and it
will tell you it could not parse it, which is the honest answer rather than a guess. It is a
strong verifier over a disciplined spec, not a reader of arbitrary documents.

New here? Skip to [If you are an agent, do this](#if-you-are-an-agent-do-this) if you are
wiring this into a coding agent, or run the quick start below to see a conflict get proven in
about a minute.

---

## Quick start

```bash
npm install -g symspec          # puts the `symspec` command on your PATH
symspec download-model          # one time: fetch the embedding model (~110 MB, sha256-pinned)
symspec install                 # drop the authoring skill into your agent host
symspec manifest                # every operation, flag, and code as JSON
```

`download-model` is not optional. The semantic tier runs on every `check` and a missing model
**fails the run closed** rather than skipping the tier — see [The embedding
model](#the-embedding-model) for why, and for the two ways around it.

<details>
<summary><strong>Build from source instead</strong></summary>

`--allow-build` is required and not a nicety: pnpm 10.26+ refuses to run a git dependency's
`prepare` script unless you name it, and `prepare` is what compiles `dist/` — without it the
installed `symspec` points at nothing. The allowlist key is `<name>@<git-url>`; a bare
`symspec` does not match a git dependency. Add `#<branch>`, `#<tag>`, or `#<commit>` to pin a
revision.

```bash
pnpm add -g --allow-build='symspec@git+https://github.com/theagenticguy/symspec.git' \
  git+https://github.com/theagenticguy/symspec.git

symspec version   # "command not found"? run `pnpm setup` — pnpm 11 puts global bins in
                  # $PNPM_HOME/bin, and `pnpm setup` is what adds it to PATH
```

A clone you can edit needs no allowlist, because the build is yours rather than a dependency's:

```bash
git clone https://github.com/theagenticguy/symspec.git
cd symspec && pnpm install && pnpm build && npm install -g .
```

</details>

### See it prove a conflict

One session, start to finish. Every command runs as written, and every block is that command's
real output on this build — exit codes included, because that is what an agent branches on.

**1. A document, and a sentence.** `parse` turns English into slots, and hands back both the
structured requirement and the op that writes it:

```console
$ symspec init ./requirements.json
{"apiVersion":1,"type":"init","data":{"path":"./requirements.json","docVersion":3,
 "created":true,"overwritten":false,"requirements":0}}                          # exit 0

$ symspec parse "When the user submits valid credentials, the auth service shall grant access." \
    --field data.results.0.slots,data.results.0.tier,data.opsJsonl
{"data":{"results":{"0":{
  "slots":{"patternType":"event-driven","systemName":"auth service",
           "systemResponse":"grant access","trigger":"the user submits valid credentials"},
  "tier":1}},
 "opsJsonl":"{\"op\":\"add\",\"patternType\":\"event-driven\",\"systemName\":\"auth service\",\"systemResponse\":\"grant access\",\"trigger\":\"the user submits valid credentials\"}\n"}}
```

`tier: 1` means the regex pass matched outright; a sentence needing the linguistic repair
reports `tier: 2`, and one beyond recovery is a parse error carrying the slots it did find.

**2. Apply the op you were handed, not one you wrote.** `data.opsJsonl` goes to `apply`
verbatim — that is the whole point of it existing:

```console
$ symspec apply <<'OP'
{"op":"add","patternType":"event-driven","systemName":"auth service","systemResponse":"grant access","trigger":"the user submits valid credentials"}
OP
{"apiVersion":1,"type":"apply","data":{"path":"./requirements.json","written":true,
 "requirements":1,"results":[{"index":0,"op":"add","ok":true,"id":"99c274ba…"}],
 "summary":{"total":1,"ok":1,"failed":0,"noop":0},"write":true,"problems":[]}}   # exit 0
```

**3. Check it — and read what "clean" actually means.**

```console
$ symspec check --field data.verified,data.progress.atomsUncompared,data.coverage.pairsCheckedNote
{"data":{"verified":true,"progress":{"atomsUncompared":2},
 "coverage":{"pairsCheckedNote":"Fewer than two requirements: nothing to cross-compare."}}}
                                                                                # exit 0
```

Clean — and in the same breath it says why that is worth nothing: one requirement cannot
contradict anything, so two atoms went uncompared and no pair was checked. `verified` is a
claim about **how much got compared**, never about whether the spec is right.

**4. Now the requirement that disagrees.** `--negated` is how you say *shall NOT*; writing
"not" into the response text is the mistake that makes a contradiction invisible, because the
negation lands inside the atom rather than on it:

```console
$ symspec add --pattern-type event-driven \
    --trigger "the user submits valid credentials" \
    --system-name "auth service" --system-response "grant access" --negated
$ symspec check --pretty
```

```
code: FND_CONTRADICTION
severity: error
tier: formal
message: Requirements 778c1db4…, 99c274ba… cannot all hold: their responses resolve to
         the same atom with opposite polarity under a reachable context.
evidence:
  atomTable:
    - atom: sys__auth_service__trig__user_submits_valid_credentials   negated: false
    - atom: sys__auth_service__resp__allow_access                     negated: true
    - atom: sys__auth_service__resp__allow_access                     negated: false
  core: [778c1db4…, 99c274ba…]
```

Exit code **1**. It named both culprits, and the `atomTable` shows exactly what it compared —
one response atom, asserted at both polarities — so you can audit the logic against the
English instead of taking its word. Nothing here is a language model guessing: rewrite the
second requirement as *deny access* and the contradiction stays proven; change its trigger and
it disappears, because the two no longer apply at the same time.

Node 24 or later. The solver is Z3 compiled to WebAssembly and runs in-process — no external
binary, no JVM, no network.

---

## The agent-CLI contract

An agent driving a tool has one failure mode worse than getting a wrong answer: believing it
made progress when it did not. Four properties close that gap. None is specific to
requirements or to Z3 — strip both out and the contract still stands, which is why it is
stated here as its own thing rather than left implicit in the runbook below.

**1. `manifest` is the surface.** One call returns every operation, flag, and code as JSON. It
is generated from the same table the CLI is built from, so it cannot disagree with the binary
you are running — and `--help`, `manifest`, and the generated `AGENTS.md` are three renderings
of that one table rather than three documents to keep in sync. Do not memorise flags from
prose, including this file's. That claim is enforced, not asserted: see
[Check these claims yourself](#check-these-claims-yourself).

**2. Branch on exit codes, not prose.** Four typed outcomes, and the two that mean "something
is wrong with your document" are kept apart from the one that means "I could not tell".

| Exit | Meaning | What to do |
|---|---|---|
| **0** | Clean — no error-severity finding. | Done. |
| **1** | At least one error-severity finding. A valid success envelope is still on stdout. | Fix the named requirements. |
| **2** | An `ERR_*` operational failure. The error envelope is on stdout. | Read `code`, run `repair.commands`. |
| **3** | An opt-in `--strict` gate tripped on a run with no error-severity finding. | Work the demotion list. |

**3. Movement, not retries.** `data.progress` is `{demotions, openFindings, atomsUncompared}`
— three numbers that each fall for a different reason, and all three at zero is the fixed
point. The stop condition is explicit: **if none of them moved after you applied a repair,
that repair did nothing.** Change approach rather than running it again. An agent without a
movement signal retries the same no-op until it runs out of budget and calls that a failure of
the document.

**4. The tool owns the load-bearing format.** Never hand-write a requirement's JSON. Take the
`proposedOp` from `parse` — or the whole `data.opsJsonl` line — and apply it, which is what
keeps the polarity flag and the slot boundaries intact; step 2 of the session above is that
move. The same rule covers advice: every command in `repair.commands` and in `symspec explain`
is a real invocation you can run verbatim, so an agent never has to reconstruct one from a
sentence.

---

## If you are an agent, do this

You are reading this because a human pointed you at symspec. The
[contract](#the-agent-cli-contract) above is why these steps work; this is the procedure.

**1. Set up once.** Both are idempotent — run them without checking first.

```bash
symspec download-model     # required; `check` fails closed without it
symspec install            # writes the full authoring guide into this host's skill directory
symspec manifest           # every operation, every flag, every code, as JSON
```

**2. Author into a document.** Prefer `parse` when you have a sentence, `add` when you have
the pieces, and `apply` when you have more than one change:

```bash
symspec init ./requirements.json
symspec parse "<one requirement sentence>"     # returns the structured req AND the op
symspec apply --ops plan.jsonl                 # batch: one op per line, atomic
```

**3. Check, and converge.** Read the work list, apply the fixes it hands you, and re-check:

```bash
symspec check --strict                           # exit 3 means "I could not verify this"
symspec check --field data.coverage.demotions    # the work list
symspec apply --ops repairs.jsonl                # from repair.ops
symspec check --strict --field data.progress     # watch all three numbers fall
```

**4. When you don't recognise a code**, ask. One code, no manifest fetch:

```bash
symspec explain --code FND_CONTRADICTION
```

**Rules that will save you tokens and mistakes:**

- JSON is the default. You never need a flag to get parseable output.
- The single highest-leverage habit is **vocabulary alignment**: the same words for the same
  things. Two requirements that mean the same thing in different words are invisible to the
  prover, so aligning them is what turns a conflict you suspect into a conflict that is
  *proven*. Commit merges with `symspec glossary` and opposites with `symspec antonym` — both
  take two positionals, and `check` hands you the exact invocation. Worked end to end in
  [Two requirements that quietly disagree](#two-requirements-that-quietly-disagree).
- A clean `check` means "no conflict was proven". It does not mean the spec is consistent. If
  you report to a human, report it that way.

---

## The embedding model

One command, once per machine. It fetches three files (~110 MB total), verifies each against a
pinned sha256, and prints where they landed. It is **idempotent** — a second run downloads
nothing and reports `"alreadyComplete": true` — so it is safe in a Dockerfile layer, a
postinstall script, or an agent's setup step.

```console
$ symspec download-model
{"apiVersion":1,"type":"modelDownload","data":{
  "model":"Xenova/bge-base-en-v1.5",
  "revision":"4d6cd88e18e51a5e020c2c305726d76ada9c03cf",
  "cacheDir":"/home/you/.cache/symspec/models/Xenova__bge-base-en-v1.5@4d6cd88e…",
  "assets":[{"name":"model_quantized.onnx","bytes":110083337,"cached":false}, …],
  "alreadyComplete":false,"totalBytes":110795099}}
```

**Where it goes.** `$SYMSPEC_MODEL_DIR` if set (used verbatim, nothing appended — so an
air-gapped host can be provisioned at an exact path), else `$XDG_CACHE_HOME`, else
`~/.cache`. The directory name carries the model revision, so bumping the pin lands in a fresh
directory instead of half-overwriting the old assets.

**Why it is required.** The semantic tier is on by default, and without the model `check` exits
2 with `ERR_EMBED_MODEL_MISSING` rather than running without it. That is deliberate: a detector
that can be skipped silently is a gate that can be gamed by omission, and "the tier did not run"
must never look like "the tier found nothing". The two honest alternatives:

| You want | Do this | What you give up |
|---|---|---|
| The model, ahead of time | `symspec download-model` | Nothing. |
| The model, fetched on first use | `SYMSPEC_EMBED_ALLOW_REMOTE=1 symspec check …` | A ~110 MB download inside the latency of a `check`. |
| To run without it | `symspec check --semantic=false` | `verified` cannot be true — the skip is **disclosed** as a `semantic-tier-skipped` demotion rather than passing quietly. |

Fully offline after the fetch. Nothing else in `symspec` touches the network — Z3 is bundled
WebAssembly.

---

## The agent loop

Three fields do the converging, and they are on every relevant response rather than behind a
flag.

**`repair: {ops, commands}`** — every coverage demotion and most error envelopes carry one.
`ops` are records `symspec apply` decodes **by construction**; `commands` run verbatim.
There are no placeholders: a repair that would have required inventing requirements content
is **omitted** rather than emitted with a `<fill-this-in>`, and the absence means "no
mechanical fix exists, read `action`".

**`data.progress`** — the convergence gradient:

```json
{ "demotions": 3, "openFindings": 1, "atomsUncompared": 2 }
```

All three at zero is exactly the fixed point: no demotions means `verified` is true — coverage
was complete, which is a different claim from the spec being right — no error findings means
exit 0, and no uncompared atoms means the formal tier saw the whole document. **If none of the
three moved after a repair batch, the batch did nothing.**

**`data.budgetHint`** — appears only when a run has something *measured* to say about its own
`--solver-budget-ms`, extrapolated from the work this run completed and the time it took on
this machine. Absent on an unbounded run and on a run with comfortable headroom, and **the
absence is the all-clear**.

`symspec explain --code FND_CONTRADICTION` answers for one code without fetching the
manifest — family, severity, tier, meaning, remedy, the runnable discharge command, and a
worked example where the catalog carries one. Every code an envelope can contain is stable and
branchable.

For token economy, `--dense` minifies and elides the heavy `evidence` payload (`--evidence`
keeps it), and `--field data.verified,data.counts.error` projects the envelope down to dotted
paths. Neither ever changes the exit code.

---

## Two requirements that quietly disagree

The contradiction in the quick start was easy: the same words at opposite polarity. The
expensive bug is the one where the words differ. Two requirements about one infusion, both
plausible, both reviewed and approved:

> **R1** — When the clinician starts an infusion, the infusion pump shall complete the
> infusion within 30 minutes.
>
> **R2** — When the clinician starts an infusion, the infusion pump shall run the infusion for
> at least 60 minutes.

A human sees it: 30 minutes cannot also be 60. A literal checker does not, because *complete
the infusion* and *run the infusion* are two different quantities. The words do not match, so a
naive tool compares nothing and reports all-clear. Every number below is measured on this
build.

```console
$ symspec check --strict --field data.verified,data.progress
{"data":{"verified":false,"progress":{"demotions":2,"openFindings":0,"atomsUncompared":2}}}
                                                                                # exit 3
```

**Exit 3, not 0.** No error finding — `openFindings` is zero, nothing was proven wrong — and it
still refuses to say the document is verified. The reason is in the work list, with the
command that fixes it:

```console
$ symspec check --strict --field data.coverage.demotions.0.repair
{"data":{"coverage":{"demotions":{"0":{"repair":{
  "ops":[{"op":"waive","code":"FND_QUANTITY_ALIAS_CANDIDATE",
          "reason":"triaged: <why this candidate is not a conflict>"}],
  "commands":["symspec glossary \"complete the infusion\" \"run the infusion\"",
              "symspec check","symspec check ./requirements.json"]}}}}}}
```

`FND_QUANTITY_ALIAS_CANDIDATE`, info severity, propose-only: two opposed bounds under one
system and trigger landed on **different quantity keys** that share the noun *infusion*, so
they were never compared. The tool does not decide they are one quantity — that is a judgment
about your domain. It reports that it did not check, and hands you the command that would let
it. That is the propose/decide split. Commit the decision:

```console
$ symspec glossary "complete the infusion" "run the infusion"
{"apiVersion":1,"type":"glossary","data":{"path":"./requirements.json","written":true,
 "requirements":2,"summary":{"total":1,"ok":1,"failed":0,"noop":0},"write":true}}  # exit 0

$ symspec check --field data.verified,data.progress,data.counts
{"data":{"verified":false,"progress":{"demotions":1,"openFindings":1,"atomsUncompared":2},
 "counts":{"error":1,"warn":4,"info":2}}}                                         # exit 1
```

```
code: FND_NUMERIC_CONTRADICTION
severity: error
message: Requirements 1329e420…, aff4d931… place jointly unsatisfiable numeric constraints
         on "complete the infusion".
```

**Exit 1.** Now it is a proven conflict over linear arithmetic — ≤30min ∧ ≥60min is
unsatisfiable — with both requirements named. The document did not change; one committed
vocabulary decision did, and `openFindings` moved 0 → 1 to show it.

Read the two runs together, because the pair is the point. Before the commit, the tool knew it
had not compared something and said so. After it, the same solver proved the conflict. A
cosine never certified anything; a table you committed did. And that is why `verified` stayed
false in both runs — one demotion remains, disclosing that the aggregate reasoning this
document's shape could hide was never attempted.

---

## The state model, and a worked example

Declare state variables, classify which responses **change** state and which **restrict** it,
and `check` runs an unbounded reachability tier (Z3 Spacer) over the result.

The example below is the real `TX-C1` from a production symspec document, and every number in
it is measured on this build.

> **TX-C1** — The run service shall assign runs that share a conversation the Procrastinate
> lock keyed on the conversation id so they execute sequentially.

That is a mutual-exclusion invariant: at most one run holds the lock. Two variables and three
guarded effects express the lock's lifecycle.

```bash
cat > plan.jsonl <<'OPS'
{"op":"state","name":"held","type":"int","min":0,"max":3,"initial":"held = 0"}
{"op":"state","name":"queued","type":"bool","initial":"queued = false"}
{"op":"classify","ref":"TX-A1","kind":"effect","expression":"when held = 0: held := held + 1, queued := false"}
{"op":"classify","ref":"TX-A2","kind":"effect","expression":"when held = 1: held := held - 1"}
{"op":"classify","ref":"TX-A3","kind":"effect","expression":"when held = 1: queued := true"}
{"op":"classify","ref":"TX-C1","kind":"constraint","expression":"held <= 1"}
OPS
symspec apply --ops plan.jsonl
symspec check --field data.reachability
```

```json
{"variables":2,"effects":3,"constraints":1,"proved":0,
 "provedUnderHypotheses":1,"violated":0,"unknown":0,"elapsedMs":337,"timeoutMs":2000}
```

TX-C1 holds. Now add a second invariant that sounds obviously true:

```bash
symspec classify TX-C2 --kind constraint --expression "not (queued and held = 0)"
symspec check --field data.reachability
```

```json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":1,"violated":1,"unknown":0,"elapsedMs":537,"timeoutMs":2000}
```

Exit **1**, with the path:

```
TX-C2: a reachable state VIOLATES this constraint. The solver reached it by firing:
init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2. Proven over all reachable states with no bound.
```

Read that as a sentence about the document: acquire the lock, a second run queues behind it,
the first run finishes and releases — and now a run is waiting on a free lock. **"Nothing
waits for a free lock" is false of the system as specified**, for an ordering reason no single
requirement contains. Fixing the *requirement the trace blames* (TX-A2 releases without
clearing the flag) discharges it and both invariants then hold.

### Read `PROVED_UNDER_HYPOTHESES` correctly

Note that TX-C1 proved as `PROVED_UNDER_HYPOTHESES`, not `PROVED`. That is the honest common
outcome and worth understanding before you read a verdict:

- **`FND_REACHABILITY_PROVED`** — proved with nothing assumed. Realistically a property of
  single-variable models.
- **`FND_REACHABILITY_UNDER_HYPOTHESES`** — proved only once the variables no requirement
  writes are held fixed. The finding **names those variables and their writers**, says *the
  document does not state that*, and **demotes `verified`**.

The reason the weaker default exists is a measurement rather than a preference: on a model
whose variable is written by no requirement, assuming persistence returns UNREACHABLE *with an
inductive invariant* while assuming nothing returns REACHABLE — and it is genuinely reachable.
So a persistence-by-default tool would prove a false answer and hand back a certificate for
it. Every proof is also **independently re-verified** (three plain-SMT obligations discharge
`Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, `Inv ⇒ ¬Bad`), so a claim never rests on trusting the solver.

`symspec install` drops the full state-model authoring guide — when to declare a variable, the
effect-vs-constraint procedure, and this worked example — into your agent host. That guide is
**generated from the same table the CLI and `symspec manifest` are built from**, so it cannot
drift from the tool; the repository's `AGENTS.md` is the same content rendered for a human
reading the source.

---

## Honest scope — read this before trusting a verdict

Every tier that reaches a verdict states its own boundary. These are the tool's own words —
published verbatim in `symspec manifest` under `scope`, quoted in the guide `symspec install`
writes, and asserted byte-identical by the test suite, so they cannot drift between surfaces.

If you read one thing here, read the second claim.

> The formal (SMT) tier is **sound modulo atomization**, given the conservative near-exact
> normalization of the atom table: every reported conflict is a genuine logical conflict of the
> requirements as atomized, and the atom table attached to each finding shows exactly what the
> solver compared.

> Because paraphrases become distinct atoms, a real conflict can be **missed** (a false
> negative): **silence is not a consistency certificate**, so the formal tier reporting no
> conflict does not prove the spec consistent.

> The one false-positive risk is **over-unification** (too-aggressive normalization collapsing
> two distinct conditions into one atom); it is mitigated by conservative normalization and the
> info-severity `FND_SIMILAR_UNUNIFIED` reporter.

> Deterministic ambiguity detectors run and report; but whether a phrase is vague **in its
> domain context** is surfaced for review (`FND_AMBIGUITY_NEEDS_JUDGMENT`), **not decided** by
> symspec, and any LLM ambiguity judgment is propose-only, never a verdict.

> Semantic similarity is a **propose-only** assist: the embedding tier suggests glossary merges
> and opposition candidates but **never emits a conflict verdict**, so `check` remains
> reproducible given the document, its glossary, and the pinned model.

> Numeric conflicts are checked over **linear** integer/real arithmetic (LIA/LRA).
> **Nonlinear-integer arithmetic remains out of scope** (undecidable).

> The unbounded reachability tier proves a declared constraint over **every reachable state**
> with no bound on path length, and every proof is **independently re-verified** so a claim
> never rests on trusting the solver. But the claim is about **the state model you declared**,
> not about the requirement text: the `classify` expressions *are* the model, so a mis-declared
> effect yields a sound proof of the wrong thing. Its common success is
> `FND_REACHABILITY_UNDER_HYPOTHESES`, which **demotes `verified`**, and an unsatisfiable
> initial state makes every constraint hold vacuously — reported at error severity because it
> **masks** violations rather than merely failing to prove one.

> `data.verified` is a **coverage** claim about the whole document, not a verdict on it: true
> only when every requirement that *could* be cross-compared was, every opposition candidate
> has been triaged, and a decide-tier comparison actually ran. It therefore does **not**
> account for proven findings — a document with a proven contradiction reports
> `verified: true` and exits 1, because "I compared enough to certify" and "the spec is
> correct" are different claims and the exit codes keep them apart. A document with fewer than
> two requirements is **vacuously verified**, disclosed through `coverage.pairsCheckedNote`
> rather than as a demotion nothing could discharge. Propose-only findings and coverage
> statistics can only **demote** `verified`, never promote it.

**The practical consequence, stated once more because it is the thing most easily misread:** a
clean `check` means *"no conflict was proven"*, never *"this spec is consistent"*.
`data.residualRisk.unmatchedAtoms` and `data.progress.atomsUncompared` tell you how much went
uncompared, and `FND_NO_PAIRS_CHECKED` fires when nothing was cross-compared at all. The way
to close that gap is to align vocabulary — the same words for the same things — so the
conflicts you care about become *provable*. `symspec install` teaches that as its first
section, because it is the highest-leverage authoring habit there is.

**What symspec does not claim:** it does not certify specs, it does not score them, and it
does not produce a machine-checkable proof artifact for an external checker. Findings carry an
atom table and an unsat core, and reachability proofs carry a re-verified inductive
invariant — auditable evidence, not a certificate.

---

## What is in the box

23 operations, all projections of one operations table, so `--help`, `symspec manifest`, and
the generated `AGENTS.md` cannot disagree with the tool:

| Group | Operations |
|---|---|
| Documents | `init`, `import`, `list`, `show` |
| Authoring | `parse`, `add`, `update`, `link`, `delete`, `apply` |
| Vocabulary | `propose-glossary`, `glossary`, `antonym`, `waive` |
| State model | `state`, `state-initial`, `classify` |
| Analysis | `check` |
| Agent surface | `manifest`, `explain`, `version`, `install`, `download-model` |

**81 stable codes** across three catalogs — `ERR_*` operational failures, `FND_*` check
findings, `GTWR_*` INCOSE *Guide to Writing Requirements* lint rules — every one resolvable
with `symspec explain`. The catalogs are append-only: a code's meaning never changes and a
code is never removed, because the codes are the API an agent branches on.

**The tiers `check` runs**, in the order they narrow:

1. **Parse** — regex-first EARS extraction, with a linguistic fallback and a structured error
   that returns the split ops for a compound requirement.
2. **Structural** — the refinement DAG: cycles, orphans, dangling references, unverifiable
   leaves.
3. **Lint (GtWR)** — 24 INCOSE rules with contextual severity and reviewed waivers.
4. **Formal (bounded)** — contradiction, subsumption, vacuity, incompleteness, numeric bounds
   over LIA/LRA, and an opt-in bounded-LTL temporal tier, all with unsat-core evidence.
5. **Semantic** — propose-only paraphrase and opposition candidates from a local pinned
   embedding model. Never a verdict.
6. **Reachability (unbounded)** — Z3 Spacer over a declared state model, with re-verified
   inductive invariants and requirement-named counterexample traces.

**Determinism:** given a document, its committed tables, and the pinned embedding model,
`check` is byte-reproducible. Every semantic suggestion becomes durable only when you commit
it as an op, so the deterministic solver always reads a committed table rather than a cosine.

### Check these claims yourself

"The docs cannot disagree with the tool" is the kind of promise every README makes. Here is
where each one is enforced, so you can read the gate instead of trusting the sentence:

| Claim | Where it is enforced |
|---|---|
| `manifest` and `--help` cannot disagree | [`src/cli.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/cli.test.ts) — *drift — manifest summaries vs root `--help`* spawns the built binary and diffs both directions, plus *every flag description reaches BOTH surfaces*. Both carry negative controls that corrupt a summary and assert the guard fires, because a drift test that cannot fail is decoration. |
| This README cannot outrun the tool | [`src/publish.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/publish.test.ts) — *the README agrees with the tool about its own surface*: the operation count, the code count, every operation present in the table above, and no command named that the tool does not have. Verified by sabotage — the first version of that last check passed on a deliberately broken table. |
| `AGENTS.md` is generated, never hand-edited | [`src/kernel/agents-doc.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/kernel/agents-doc.test.ts) — *the committed AGENTS.md matches the generator*, byte for byte. The `check:agents` script re-renders and diffs it, so an edit to the committed file fails the build. |
| The honest-scope claims are the tool's own words | `src/publish.test.ts` asserts the sentences below verbatim against `src/kernel/scope.ts`, the same corpus `symspec manifest` publishes. Softening them here fails a corpus test. |
| Every command it tells you to run, runs | [`src/formal/repair.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/formal/repair.test.ts) sweeps every `symspec …` literal in the tree, and `src/operations/check.test.ts` sweeps a whole serialized `check` envelope, asserting none names a subcommand the flat CLI surface has no parser for. |
| `--version`, this README, `AGENTS.md` and the source agree | `src/publish.test.ts` — *the release config bumps every place the version appears*, in both directions. |

All of it runs in `pnpm check`, which is the whole gate: the same one
[CI](https://github.com/theagenticguy/symspec/blob/main/.github/workflows/check.yml) and the
pre-push hook run, in the same order.

---

## Status

`1.0.0` <!-- x-release-please-version -->

The document format is **v3**. `symspec import` reads a v2 op stream in one shot, so an older
document migrates without hand-editing. The CLI surface is built on `effect/unstable/cli` at an
exact pin, so a beta bump is a deliberate, reviewed change rather than a floating range.

Treat the **codes and the envelope shape** as the stable contract — those are what an agent
branches on, and they are guarded by append-only snapshot tests. Flag names and payload
additions can still gain fields in a minor release; nothing an agent branches on is removed
without a major.

## License

Apache-2.0. See [LICENSE](LICENSE).
