# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

symspec finds contradictions between software requirements. You write requirements in a
structured form. symspec translates them into logic, hands the whole set to the Z3 theorem
prover, and reports whether any of them conflict. When two requirements do conflict, it names
both and shows the terms it compared, so you can check the reasoning against the English.

The expensive bug is usually not inside one requirement. It is between two requirements that
disagree, which is easy to miss in review and slow to find later in the code.

A run produces one of two outcomes. Either symspec proves that two requirements contradict each
other and names them, or it reports that it could not prove anything and returns a list of what
it did not compare. A clean result means no conflict was proven, which is a weaker claim than
the spec being consistent. The [Honest scope](#honest-scope--read-this-before-trusting-a-verdict)
section explains where the difference comes from.

**Input.** Requirements in [EARS](#what-is-in-the-box) form, meaning *"When \<trigger>, the
\<system> shall \<response>"* and its four siblings. A sentence that does not match the shape
gets one repair attempt from a linguistic pass. If that also fails, symspec reports a parse
error together with whichever slots it recovered. Narrative prose is not in scope, so pointing
symspec at a design document produces a parse error rather than a guess.

**Output.** Every command prints a JSON envelope on stdout and returns one of four exit codes.
An agent can therefore run symspec in a loop and decide what to do next without reading prose.
Add `--pretty` to read the same result yourself. Four properties make that loop safe to
automate, and they are described in [The agent-CLI contract](#the-agent-cli-contract).

Requires Node 24 or later. Z3 is compiled to WebAssembly and runs in-process, so there is no
separate solver binary, no JVM, and no network access during a check.

If you are wiring symspec into a coding agent, skip to
[If you are an agent, do this](#if-you-are-an-agent-do-this). Otherwise the quick start below
proves a conflict in about a minute.

---

## Quick start

```bash
npm install -g symspec          # puts the `symspec` command on your PATH
symspec download-model          # one time: fetch the embedding model (~110 MB, sha256-pinned)
symspec install                 # drop the authoring skill into your agent host
symspec manifest                # every operation, flag, and code as JSON
```

`download-model` is required. The semantic tier runs on every check, and a missing model makes
the run fail with an error rather than skipping the tier. [The embedding
model](#the-embedding-model) explains why and describes the two supported alternatives.

<details>
<summary><strong>Build from source instead</strong></summary>

`--allow-build` is required. pnpm 10.26 and later will not run a git dependency's `prepare`
script unless you name the dependency, and `prepare` is what compiles `dist/`. Without it the
installed `symspec` points at nothing. The allowlist key is `<name>@<git-url>`, so a bare
`symspec` does not match. Add `#<branch>`, `#<tag>`, or `#<commit>` to pin a revision.

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

This is one session from start to finish. Every command runs as written, and every output block
is that command's real output on this build. Exit codes are included, because that is what an
agent branches on.

**1. Create a document and parse a sentence.** `parse` turns English into slots. It returns both
the structured requirement and the op that writes it.

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

`tier: 1` means the regex pass matched outright. A sentence that needs the linguistic repair
reports `tier: 2`. A sentence beyond recovery returns a parse error carrying the slots it did
find.

**2. Apply the op you were handed.** Pass `data.opsJsonl` to `apply` verbatim. That is why the
field exists.

```console
$ symspec apply <<'OP'
{"op":"add","patternType":"event-driven","systemName":"auth service","systemResponse":"grant access","trigger":"the user submits valid credentials"}
OP
{"apiVersion":1,"type":"apply","data":{"path":"./requirements.json","written":true,
 "requirements":1,"results":[{"index":0,"op":"add","ok":true,"id":"99c274ba…"}],
 "summary":{"total":1,"ok":1,"failed":0,"noop":0},"write":true,"problems":[]}}   # exit 0
```

**3. Check it, and read what a clean result means here.**

```console
$ symspec check --field data.verified,data.progress.atomsUncompared,data.coverage.pairsCheckedNote
{"data":{"verified":true,"progress":{"atomsUncompared":2},
 "coverage":{"pairsCheckedNote":"Fewer than two requirements: nothing to cross-compare."}}}
                                                                                # exit 0
```

The result is clean, and the same response says why that is worth little. One requirement cannot
contradict anything, so two atoms went uncompared and no pair was checked. `verified` reports
how much of the document was compared. It is not a judgment about whether the spec is right.

**4. Add a requirement that disagrees.** Use `--negated` to say *shall not*. Writing the word
"not" into the response text instead puts the negation inside the atom rather than on it, which
makes the contradiction invisible to the solver.

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

The exit code is 1. Both culprits are named, and the `atomTable` shows what was compared: one
response atom, asserted at both polarities. You can audit that against the English instead of
taking the tool's word for it. No language model is involved in this verdict. If you rewrite the
second requirement as *deny access*, the contradiction still holds. If you change its trigger,
the contradiction disappears, because the two requirements no longer apply at the same time.

---

## The agent-CLI contract

An agent driving a tool has a failure mode worse than getting a wrong answer, which is believing
it made progress when it did not. Four properties close that gap. None of them is specific to
requirements or to Z3, so they are stated here as a unit rather than left implicit in the runbook
below.

**1. `manifest` is the surface.** One call returns every operation, flag, and code as JSON. It is
generated from the same table the CLI is built from, so it cannot disagree with the binary you
are running. `--help`, `manifest`, and the generated `AGENTS.md` are three renderings of that one
table. Read flags from `manifest` rather than memorising them from prose, including this file's.
[Check these claims yourself](#check-these-claims-yourself) shows where that property is
enforced.

**2. Branch on exit codes, not prose.** There are four typed outcomes. The two that mean
something is wrong with your document are kept apart from the one that means symspec could not
tell.

| Exit | Meaning | What to do |
|---|---|---|
| **0** | Clean. No error-severity finding. | Done. |
| **1** | At least one error-severity finding. A valid success envelope is still on stdout. | Fix the named requirements. |
| **2** | An `ERR_*` operational failure. The error envelope is on stdout. | Read `code`, run `repair.commands`. |
| **3** | An opt-in `--strict` gate tripped on a run with no error-severity finding. | Work the demotion list. |

**3. Movement, not retries.** `data.progress` holds three numbers, and each falls for a different
reason. All three at zero is the fixed point. The stop condition is explicit. If none of the
three moved after you applied a repair, that repair did nothing, so change approach instead of
running it again. An agent with no movement signal will retry the same no-op until it runs out of
budget and then report the document as unfixable.

**4. The tool owns the load-bearing format.** Do not hand-write a requirement's JSON. Take the
`proposedOp` from `parse`, or the whole `data.opsJsonl` line, and apply it. That is what keeps
the polarity flag and the slot boundaries intact, and it is what step 2 of the session above
demonstrates. The same rule covers advice. Every command that `repair.commands` and
`symspec explain` return is a real invocation you can run verbatim, so an agent never has to
reconstruct one from a sentence.

---

## If you are an agent, do this

You are reading this because a human pointed you at symspec. The
[contract](#the-agent-cli-contract) above explains why these steps work. This section is the
procedure.

**1. Set up once.** Both commands are idempotent, so run them without checking first.

```bash
symspec download-model     # required; `check` fails with an error without it
symspec install            # writes the full authoring guide into this host's skill directory
symspec manifest           # every operation, every flag, every code, as JSON
```

**2. Author into a document.** Use `parse` when you have a sentence, `add` when you have the
individual pieces, and `apply` when you have more than one change to make.

```bash
symspec init ./requirements.json
symspec parse "<one requirement sentence>"     # returns the structured req AND the op
symspec apply --ops plan.jsonl                 # batch: one op per line, atomic
```

**3. Check, then converge.** Read the work list, apply the fixes it returns, and check again.

```bash
symspec check --strict                           # exit 3 means "I could not verify this"
symspec check --field data.coverage.demotions    # the work list
symspec apply --ops repairs.jsonl                # from repair.ops
symspec check --strict --field data.progress     # watch all three numbers fall
```

**4. Look up codes you do not recognise.** This answers for one code without fetching the whole
manifest.

```bash
symspec explain --code FND_CONTRADICTION
```

Three further rules will save you tokens and mistakes.

- JSON is the default output. You never need a flag to get parseable output.
- The highest-leverage habit is vocabulary alignment, meaning the same words for the same
  things. Two requirements that mean the same thing in different words are invisible to the
  prover, so aligning them turns a conflict you suspect into a conflict that is proven. Commit
  merges with `symspec glossary` and opposites with `symspec antonym`. Both take two positional
  arguments, and `check` returns the exact invocation.
  [Two requirements that quietly disagree](#two-requirements-that-quietly-disagree) works this
  through end to end.
- A clean check means no conflict was proven, not that the spec is consistent. Report it that
  way to a human.

---

## The embedding model

Run this once per machine. It fetches three files totalling about 110 MB, verifies each against a
pinned sha256, and prints where they landed. It is idempotent. A second run downloads nothing and
reports `"alreadyComplete": true`, so it is safe in a Dockerfile layer, a postinstall script, or
an agent's setup step.

```console
$ symspec download-model
{"apiVersion":1,"type":"modelDownload","data":{
  "model":"Xenova/bge-base-en-v1.5",
  "revision":"4d6cd88e18e51a5e020c2c305726d76ada9c03cf",
  "cacheDir":"/home/you/.cache/symspec/models/Xenova__bge-base-en-v1.5@4d6cd88e…",
  "assets":[{"name":"model_quantized.onnx","bytes":110083337,"cached":false}, …],
  "alreadyComplete":false,"totalBytes":110795099}}
```

**Where the files go.** symspec uses `$SYMSPEC_MODEL_DIR` if it is set, appending nothing, so an
air-gapped host can be provisioned at an exact path. Otherwise it uses `$XDG_CACHE_HOME`, and
otherwise `~/.cache`. The directory name carries the model revision, so bumping the pin creates a
fresh directory instead of partly overwriting the old assets.

**Why it is required.** The semantic tier is on by default. Without the model, `check` exits 2
with `ERR_EMBED_MODEL_MISSING` instead of running without the tier. A tier that can be skipped
silently would let "the tier did not run" look like "the tier found nothing", and those are
different results. There are two supported alternatives.

| You want | Do this | What you give up |
|---|---|---|
| The model, ahead of time | `symspec download-model` | Nothing. |
| The model, fetched on first use | `SYMSPEC_EMBED_ALLOW_REMOTE=1 symspec check …` | A ~110 MB download inside the latency of a check. |
| To run without it | `symspec check --semantic=false` | `verified` cannot be true. The skip is reported as a `semantic-tier-skipped` demotion. |

After the fetch, symspec works offline. Nothing else in it touches the network, because Z3 ships
as bundled WebAssembly.

---

## The agent loop

Three fields do the converging. All three are on every relevant response rather than behind a
flag.

**`repair: {ops, commands}`** appears on every coverage demotion and on most error envelopes.
The `ops` are records that `symspec apply` decodes by construction. The `commands` run verbatim.
There are no placeholders. When a repair would require inventing requirements content, the field
is omitted rather than emitted with a `<fill-this-in>`, and the absence means no mechanical fix
exists, so read `action` instead.

**`data.progress`** is the convergence gradient.

```json
{ "demotions": 3, "openFindings": 1, "atomsUncompared": 2 }
```

All three at zero is the fixed point. No demotions means `verified` is true, which is a claim
about coverage rather than about the spec being right. No error findings means exit 0. No
uncompared atoms means the formal tier saw the whole document. If none of the three moved after
a repair batch, the batch did nothing.

**`data.budgetHint`** appears only when a run has something measured to say about its own
`--solver-budget-ms`, extrapolated from the work that run completed and how long it took on this
machine. It is absent on an unbounded run and on a run with comfortable headroom, so the absence
is the all-clear.

`symspec explain --code FND_CONTRADICTION` answers for a single code without fetching the
manifest. It returns the family, severity, tier, meaning, remedy, the runnable discharge command,
and a worked example where the catalog carries one. Every code an envelope can contain is stable
and safe to branch on.

Two flags reduce token usage. `--dense` minifies the output and elides the heavy `evidence`
payload, which `--evidence` keeps. `--field data.verified,data.counts.error` projects the
envelope down to dotted paths. Neither flag changes the exit code.

---

## Two requirements that quietly disagree

The contradiction in the quick start was easy to catch, because both requirements used the same
words at opposite polarity. The harder case is when the words differ. Here are two requirements
about one infusion. Both are plausible, and both passed review.

> **R1** — When the clinician starts an infusion, the infusion pump shall complete the
> infusion within 30 minutes.
>
> **R2** — When the clinician starts an infusion, the infusion pump shall run the infusion for
> at least 60 minutes.

A human reader sees the problem, because 30 minutes cannot also be 60 minutes. A literal checker
does not, because *complete the infusion* and *run the infusion* are two different quantities.
The words do not match, so a naive tool compares nothing and reports all-clear. Every number
below is measured on this build.

```console
$ symspec check --strict --field data.verified,data.progress
{"data":{"verified":false,"progress":{"demotions":2,"openFindings":0,"atomsUncompared":2}}}
                                                                                # exit 3
```

The exit code is 3 rather than 0. There is no error finding, since `openFindings` is zero and
nothing was proven wrong, and symspec still reports the document as unverified. The work list
holds the reason along with the command that resolves it.

```console
$ symspec check --strict --field data.coverage.demotions.0.repair
{"data":{"coverage":{"demotions":{"0":{"repair":{
  "ops":[{"op":"waive","code":"FND_QUANTITY_ALIAS_CANDIDATE",
          "reason":"triaged: <why this candidate is not a conflict>"}],
  "commands":["symspec glossary \"complete the infusion\" \"run the infusion\"",
              "symspec check","symspec check ./requirements.json"]}}}}}}
```

`FND_QUANTITY_ALIAS_CANDIDATE` is info severity and propose-only. Two opposed bounds under one
system and trigger landed on different quantity keys that share the noun *infusion*, so they
were never compared. symspec does not decide that they are one quantity, because that is a
judgment about your domain. It reports that it did not check, and returns the command that would
let it check. This is the propose/decide split. Commit the decision:

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

The exit code is now 1, and the conflict is proven over linear arithmetic, since ≤30min and
≥60min cannot both hold. Both requirements are named.

Read the two runs together. Before the vocabulary commit, symspec knew it had not compared
something and said so. After the commit, the solver proved the conflict. The requirements
themselves never changed. What changed is one committed vocabulary decision, and `openFindings`
moved from 0 to 1 to show it. A cosine similarity never decided anything here. The table you
committed is what made the comparison possible. `verified` stayed false in both runs, because one
demotion remains: the aggregate reasoning that this document's shape could hide was never
attempted.

---

## The state model, and a worked example

You can declare state variables, classify which responses change state and which restrict it,
and `check` will run an unbounded reachability tier over the result using Z3 Spacer.

The example below is the real `TX-C1` from a production symspec document, and every number in it
is measured on this build.

> **TX-C1** — The run service shall assign runs that share a conversation the Procrastinate
> lock keyed on the conversation id so they execute sequentially.

That is a mutual-exclusion invariant, meaning at most one run holds the lock. Two variables and
three guarded effects express the lock's lifecycle.

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

TX-C1 holds. Now add a second invariant that sounds obviously true.

```bash
symspec classify TX-C2 --kind constraint --expression "not (queued and held = 0)"
symspec check --field data.reachability
```

```json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":1,"violated":1,"unknown":0,"elapsedMs":537,"timeoutMs":2000}
```

The exit code is 1, and the response includes the path that reaches the violation.

```
TX-C2: a reachable state VIOLATES this constraint. The solver reached it by firing:
init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2. Proven over all reachable states with no bound.
```

Read that trace as a sentence about the document. A run acquires the lock. A second run queues
behind it. The first run finishes and releases the lock. Now a run is waiting on a free lock, so
"nothing waits for a free lock" is false of the system as specified. No single requirement
contains that ordering error. The trace blames TX-A2, which releases the lock without clearing
the flag. Fixing that requirement discharges the violation, and both invariants then hold.

### Read `PROVED_UNDER_HYPOTHESES` correctly

TX-C1 proved as `PROVED_UNDER_HYPOTHESES` rather than `PROVED`. That is the common outcome, and
it is worth understanding before you read a verdict.

- **`FND_REACHABILITY_PROVED`** means proved with nothing assumed. In practice this happens for
  single-variable models.
- **`FND_REACHABILITY_UNDER_HYPOTHESES`** means proved once the variables that no requirement
  writes are held fixed. The finding names those variables and their writers, states that the
  document does not say they are fixed, and demotes `verified`.

The weaker default comes from a measurement rather than a preference. On a model whose variable
is written by no requirement, assuming persistence returns UNREACHABLE together with an inductive
invariant, while assuming nothing returns REACHABLE. The state is genuinely reachable, so a tool
that assumed persistence by default would prove a false answer and return a certificate for it.
Every proof is also re-verified independently, using three plain-SMT obligations that discharge
`Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, and `Inv ⇒ ¬Bad`, so a claim never rests on trusting the solver.

`symspec install` writes the full state-model authoring guide into your agent host. It covers
when to declare a variable, the effect-versus-constraint procedure, and this worked example. That
guide is generated from the same table the CLI and `symspec manifest` are built from, so it
cannot drift from the tool. The repository's `AGENTS.md` is the same content rendered for someone
reading the source.

---

## Designing the vocabulary in one pass

Aligning vocabulary is the highest-leverage habit here, and doing it one pair at a time is
tedious. `symspec propose-glossary` reads the whole document and proposes a partition of its
phrasings, meaning which phrasings name one thing. It covers both slot families: the responses,
and the triggers and preconditions that decide which requirements get compared at all. It
returns a plan and writes nothing.

Every number below is measured on this build, over five requirements across two systems, each
with its own trigger.

```console
$ symspec propose-glossary --field data.corpus
{"data":{"corpus":{"requirements":5,"systems":2,
                   "responseNodes":5,"guardNodes":5,"embedded":10,
                   "pairsCompared":8,"responsePairsCompared":4,"guardPairsCompared":4,
                   "alreadyUnified":0,"guardPhrasesFolded":0,
                   "crossSlotPhrases":0,"oppositionSignals":1}}}                # exit 0
```

`pairsCompared` shows that it looked. An empty plan with a positive `pairsCompared` means your
vocabulary is already coherent, which is a different result from the tier not running.

Here is what it proposes, as ops that `apply` consumes directly.

```console
$ symspec propose-glossary --field data.classes.0
{"canonical":"issue a login credential","aliases":["issue a session token"],
 "minCosine":0.75,"transitive":false}
```

Here is what it declines to propose.

```console
$ symspec propose-glossary --field data.unresolved.0
{"reason":"opposition-candidate","pairs":[{"signal":"same-object-different-verb",
 "verbs":["close","seal"],"cosine":0.811}]}
```

`close the vault` and `seal the vault` sit at cosine 0.811, which is above the 0.72 threshold, so
similarity alone would have merged them. The class is withheld anyway, because similarity cannot
distinguish a paraphrase from an opposite. Antonyms embed close together. Merging these two would
convert a provable contradiction into a claim of consistency, which is worse than missing the
conflict, because the tool would have caused it.

The decision to withhold therefore comes from a deterministic signal rather than from cosine.
The signals are the committed antonym table, `de-`/`un-`/`dis-` morphology, and the
same-object-different-verb shape. Cosine only ever proposes an edge.

One ambiguous pair withholds the whole class, because the clustering is transitive. If `a`
paraphrases `b` and `b` opposes `c`, then merging `a` with `c` is the same mistake one step
removed. The unresolved entry returns both readings along with the consequence of each, and does
not choose between them.

### The guards matter more, and are never applied for you

A response merge makes two phrasings comparable. A guard merge decides whether the two
requirements are ever compared at all, because a context group is keyed on trigger and
precondition atoms and the solver asserts one group at a time. Two requirements whose triggers
are paraphrases are never live together, so their responses are never checked against each other.

```console
$ symspec propose-glossary --field data.guardClasses.0
{"canonical":"the user authenticates","aliases":["the user signs in"],
 "minCosine":0.873,"unlocks":["22222222-...-0001","22222222-...-0002"],"withheldBy":[]}
```

`unlocks` is the payoff stated outright: committing this makes those two requirements comparable
for the first time. It is also exactly the set a wrong merge would compare wrongly, which is why
guard classes carry no `ops` and never appear in `opsJsonl`. A wrong response merge only hides a
conflict; a wrong guard merge asserts two different conditions are one and can prove a conflict
your document does not contain. No antonym op undoes that, because antonyms apply to responses
only. So the plan hands you a runnable `symspec glossary` command and the consequence of running
it, and stops there.

When the two guards look like different conditions, the plan says so and puts doing nothing
first:

```console
$ symspec propose-glossary --field data.guardClasses
{"withheldBy":[{"signal":"single-token-difference",
                "phrases":["the shift begins","the shift ends"]}],
 "remedies":[{"kind":"leave-distinct"},{"kind":"realign-guards"},{"kind":"as-synonyms"}]}
```

`the shift ends` and `the shift begins` differ by one token, and one token is usually the point.
Neither verb is in the antonym table, so nothing but that shape catches it.

### One entry for the noun, not one per phrase

A `glossary` entry aligns two whole phrasings. If four verbs each take the same object under
two names, that is eight entries — and every one of them is a snapshot that stops covering
requirements you write next month. `symspec term` aligns the noun itself, inside every body
that contains it.

When a proposed class differs only in its noun, the plan says so and shows what the entry
would touch:

```console
$ symspec propose-glossary --field data.termCandidates.0
{"canonical":"login credential","aliases":["session token"],"sharedPrefix":"issue a",
 "blastRadius":["sys__auth_service__resp__issue_a_session_token"],"withheldBy":[],
 "commands":["symspec term \"login credential\" \"session token\""]}
```

`blastRadius` is the point. One record reaching many atoms is why a term is worth committing
and also the only reason to be careful with one, so the plan lists every atom the entry would
rewrite rather than counting them. Term candidates never appear in `ops`, so piping
`data.opsJsonl` into `apply` will not commit one — you run the command after reading the
radius. Committing it moves the same gradient a phrase merge does:

```console
$ symspec check --field data.progress.atomsUncompared
{"data":{"progress":{"atomsUncompared":2}}}

$ symspec term "login credential" "session token"
$ symspec check --field data.progress.atomsUncompared
{"data":{"progress":{"atomsUncompared":0}}}
```

**Terms are for nouns, and that is enforced rather than advised.** A term containing a verb
the solver reads is refused at write time:

```console
$ symspec term "revoke access" "grant access"
{"apiVersion":1,"type":"error","code":"ERR_USAGE",
 "error":"The term \"revoke access\" / \"grant access\" is not committable: \"revoke\" is a
 verb the formal tier reads …"}                                                  # exit 2
```

The reason is specific. A response like "mark the session as verified" is recognised as
establishing a state by reading the sentence as written, while the polarity of that state comes
from the atomized form. A term that rewrote the verb would move the second without moving the
first, and the resulting bridge would assert the opposite of what your document says — proving
a conflict that is not there. Rewriting a noun cannot do that, so nouns are what the table
accepts. Use `symspec glossary` for a phrasing that contains a verb.

### The gradient

Apply the confident half and the gradient moves. Align a guard and it moves again, by as much.

```console
$ symspec check --field data.progress.atomsUncompared
{"data":{"progress":{"atomsUncompared":10}}}

$ symspec propose-glossary --field data.opsJsonl > plan.jsonl   # then edit the JSON out
$ symspec apply --ops plan.jsonl --field data.summary
{"data":{"summary":{"total":1,"ok":1,"failed":0,"noop":0}}}                      # exit 0

$ symspec check --field data.progress.atomsUncompared
{"data":{"progress":{"atomsUncompared":8}}}

$ symspec glossary "the user authenticates" "the user signs in"  # the guard, by hand
$ symspec check --field data.progress.atomsUncompared
{"data":{"progress":{"atomsUncompared":6}}}
```

Running it again proposes nothing further, because the committed table folds those phrasings onto
one atom and they are no longer candidates. The vault class persists, since it is still waiting
on a decision only you can make.

---

## Honest scope — read this before trusting a verdict

Every tier that reaches a verdict states its own boundary. The claims below are the tool's own
words. They are published verbatim in `symspec manifest` under `scope`, quoted in the guide
`symspec install` writes, and asserted byte-identical by the test suite, so they cannot drift
between surfaces. The second claim is the one to read if you read only one.

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

The practical consequence is that a clean check means "no conflict was proven" rather than "this
spec is consistent". Two fields tell you how much went uncompared:
`data.residualRisk.unmatchedAtoms` and `data.progress.atomsUncompared`. `FND_NO_PAIRS_CHECKED`
fires when nothing was cross-compared at all. To close that gap, align vocabulary so that the
conflicts you care about become provable. `symspec install` teaches vocabulary alignment as its
first section for that reason.

There are three things symspec does not do: it does not certify specs, it does not score them,
and it does not produce a machine-checkable proof artifact for an external checker. Findings
carry an atom table and an unsat core, and reachability proofs carry a re-verified inductive
invariant. That is auditable evidence rather than a certificate.

---

## What is in the box

There are 24 operations. All of them are projections of one operations table, which is why
`--help`, `symspec manifest`, and the generated `AGENTS.md` cannot disagree with the tool.

| Group | Operations |
|---|---|
| Documents | `init`, `import`, `list`, `show` |
| Authoring | `parse`, `add`, `update`, `link`, `delete`, `apply` |
| Vocabulary | `propose-glossary`, `glossary`, `term`, `antonym`, `waive` |
| State model | `state`, `state-initial`, `classify` |
| Analysis | `check` |
| Agent surface | `manifest`, `explain`, `version`, `install`, `download-model` |

There are **83 stable codes** across three catalogs. `ERR_*` codes are operational failures,
`FND_*` codes are check findings, and `GTWR_*` codes are lint rules from the INCOSE *Guide to
Writing Requirements*. `symspec explain` resolves any of them. The catalogs are append-only, so a
code's meaning never changes and a code is never removed. Agents branch on these codes, which is
why they are treated as API.

`check` runs six tiers, in the order they narrow the problem.

1. **Parse** extracts EARS structure, regex first, with a linguistic fallback and a structured
   error that returns the split ops for a compound requirement.
2. **Structural** analyses the refinement DAG for cycles, orphans, dangling references, and
   unverifiable leaves.
3. **Lint (GtWR)** applies 24 INCOSE rules with contextual severity and reviewed waivers.
4. **Formal (bounded)** checks contradiction, subsumption, vacuity, incompleteness, and numeric
   bounds over LIA/LRA, plus an opt-in bounded-LTL temporal tier. Findings carry unsat-core
   evidence.
5. **Semantic** proposes paraphrase and opposition candidates from a local pinned embedding
   model, and questions committed vocabulary in the other direction: `FND_TERM_INCONSISTENT`
   reports a `terms` or `glossary` entry applied in two requirements whose surrounding text is
   unrelated, because one entry covering two concepts fuses them onto a single atom and hides a
   conflict rather than proving one. `FND_ACRONYM_UNDEFINED` names an acronym in neither table.
   It never produces a verdict, and these two never demote one either — a wording opinion must
   not fail a build, so they leave `verified`, `--strict`, and the exit code untouched.
6. **Reachability (unbounded)** runs Z3 Spacer over a declared state model, returning re-verified
   inductive invariants and counterexample traces that name requirements.

**Determinism.** Given a document, its committed tables, and the pinned embedding model, `check`
is byte-reproducible. A semantic suggestion becomes durable only when you commit it as an op, so
the deterministic solver always reads a committed table rather than a cosine.

### Check these claims yourself

Claims about documentation not drifting from code are easy to make and hard to trust. Each one
above is enforced by a test, so you can read the gate instead of the sentence.

| Claim | Where it is enforced |
|---|---|
| `manifest` and `--help` cannot disagree | [`src/cli.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/cli.test.ts) — *drift — manifest summaries vs root `--help`* spawns the built binary and diffs both directions. *Every flag description reaches BOTH surfaces* covers the flags. Both tests carry negative controls that corrupt a summary and assert the guard fires. |
| This README cannot outrun the tool | [`src/publish.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/publish.test.ts) — *the README agrees with the tool about its own surface* checks the operation count, the code count, the presence of every operation in the table above, and that no command is named which the tool does not have. The last check was verified by sabotage, because its first version passed against a deliberately broken table. |
| `AGENTS.md` is generated, never hand-edited | [`src/app/runtime/agents-doc.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/app/runtime/agents-doc.test.ts) — *the committed AGENTS.md matches the generator*, byte for byte. The `check:agents` script re-renders and diffs it, so editing the committed file fails the build. |
| The honest-scope claims are the tool's own words | `src/publish.test.ts` asserts the sentences above verbatim against `src/app/runtime/scope.ts`, which is the same corpus `symspec manifest` publishes. Softening them here fails a corpus test. |
| Every command it tells you to run, runs | [`src/domain/advice/repair.test.ts`](https://github.com/theagenticguy/symspec/blob/main/src/domain/advice/repair.test.ts) sweeps every `symspec …` literal in the tree, and `src/app/operations/check.test.ts` sweeps a whole serialized `check` envelope. Both assert that no command names a subcommand the flat CLI surface cannot parse. |
| `--version`, this README, `AGENTS.md` and the source agree | `src/publish.test.ts` — *the release config bumps every place the version appears*, checked in both directions. |

All of it runs in `pnpm check`, which is the whole gate. The same command runs in
[CI](https://github.com/theagenticguy/symspec/blob/main/.github/workflows/check.yml) and in the
pre-push hook, in the same order.

---

## Status

`1.1.0` <!-- x-release-please-version -->

The document format is v3. `symspec import` reads a v2 op stream in one pass, so an older
document migrates without hand-editing. The CLI is built on `effect/unstable/cli` at an exact
version pin, which makes a beta bump a deliberate, reviewed change rather than a floating range.

Treat the codes and the envelope shape as the stable contract, since those are what an agent
branches on, and they are guarded by append-only snapshot tests. Flag names and payload fields
can still be added in a minor release. Nothing an agent branches on is removed without a major
release.

## License

Apache-2.0. See [LICENSE](LICENSE).
