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

One command, straight from the git URL. `--allow-build` is required and not a nicety: pnpm
10.26+ refuses to run a git dependency's `prepare` script unless you name it, and `prepare` is
what compiles `dist/` — without it you get an installed package whose `symspec` points at
nothing. The allowlist key is `<name>@<git-url>`; a bare `symspec` does not match a git
dependency.

```bash
pnpm add -g --allow-build='symspec@git+https://github.com/theagenticguy/symspec.git' \
  git+https://github.com/theagenticguy/symspec.git

symspec version   # if this is "command not found", run `pnpm setup` — pnpm 11 puts
                  # global bins in $PNPM_HOME/bin, and `pnpm setup` is what adds it to PATH
```

Add `#<branch>`, `#<tag>`, or `#<commit>` to the URL to pin a revision.

Prefer a clone you can edit? Nothing is allowlisted on this path, because the build is yours
rather than a dependency's:

```bash
git clone https://github.com/theagenticguy/symspec.git
cd symspec && pnpm install && pnpm build && npm install -g .
```

</details>

### See it prove a conflict

Two requirements that disagree. Every command below runs as written:

```bash
symspec init ./requirements.json

# One requirement: on valid credentials, grant access.
symspec add --pattern-type event-driven \
  --trigger "the user submits valid credentials" \
  --system-name "auth service" --system-response "grant access"

# The same trigger, the opposite obligation. `--negated` is how you say "shall NOT",
# instead of writing "not" into the response text.
symspec add --pattern-type event-driven \
  --trigger "the user submits valid credentials" \
  --system-name "auth service" --system-response "grant access" --negated

symspec check --pretty
```

```
code: FND_CONTRADICTION
severity: error
message: Requirements 7d095571…, e4601bb3… cannot all hold: their responses resolve to
         the same atom with opposite polarity under a reachable context.
```

Exit code **1**. It named both culprits, and the `evidence` block shows exactly which pieces
of text it compared to get there — so you can check its work rather than take its word.

Nothing here is a language model guessing. Rewrite the second requirement as *deny access*
and the contradiction stays proven; change the trigger and it disappears, because the two
requirements do not apply at the same time.

Prose in, requirements out — if you'd rather not fill in slots by hand:

```bash
symspec parse "When the user submits valid credentials, the auth service shall grant access."
```

That returns the structured requirement **and** the ready-to-apply op, so nothing gets
retyped between reading and writing.

### Exit codes are the contract

A clean run exits 0. A proven conflict exits 1 with the culprits named. An opt-in strict
coverage gate (`--strict`) exits 3 when the tool could not verify the document — which is a
different answer from "the document is bad", and the exit codes keep the two apart.

| Exit | Meaning |
|---|---|
| **0** | Clean — no error-severity finding. |
| **1** | At least one error-severity finding. A valid success envelope is still on stdout. |
| **2** | An `ERR_*` operational failure. The error envelope is on stdout. |
| **3** | An opt-in strict gate tripped on a run with no error-severity finding. |

Node 24 or later. The solver is Z3 compiled to WebAssembly and runs in-process — no external
binary, no JVM, no network.

---

## If you are an agent, do this

You are reading this because a human pointed you at symspec. Follow these steps literally.

**1. Set up once.** Both are idempotent — run them without checking first.

```bash
symspec download-model     # required; `check` fails closed without it
symspec install            # writes the full authoring guide into this host's skill directory
```

**2. Learn the surface from the tool, not from this file.**

```bash
symspec manifest           # every operation, every flag, every code, as JSON
```

Do not memorise flags from prose. `manifest` is generated from the same table the CLI is
built from, so it cannot disagree with the binary you are running.

**3. Author into a document.** Prefer `parse` when you have a sentence, `add` when you have
the pieces, and `apply` when you have more than one change:

```bash
symspec init ./requirements.json
symspec parse "<one requirement sentence>"     # returns the structured req AND the op
symspec apply --ops plan.jsonl                 # batch: one op per line, atomic
```

Never hand-write a requirement's JSON. Take the `proposedOp` from `parse` and apply it — that
is what keeps the polarity flag and the slot boundaries intact.

**4. Check, and branch on the exit code — not on the text.**

```bash
symspec check --strict
```

| Exit | What it means | What to do |
|---|---|---|
| 0 | Nothing was proven wrong, and coverage was complete | Done |
| 1 | An error-severity finding. A valid envelope is still on stdout | Fix the named requirements |
| 2 | An `ERR_*` operational failure (bad flag, missing file, missing model) | Read `code`, run `repair.commands` |
| 3 | `--strict` only: nothing was proven wrong, but coverage was incomplete | Work the demotion list |

**5. Converge.** Read the work list, apply the fixes it hands you, and re-check:

```bash
symspec check --field data.coverage.demotions    # the work list
symspec apply --ops repairs.jsonl                # from repair.ops
symspec check --strict --field data.progress     # watch all three numbers fall
```

`data.progress` is `{demotions, openFindings, atomsUncompared}`. **If none of the three moved
after you applied a repair, that repair did nothing — change approach instead of retrying it.**

**6. When you don't recognise a code**, ask. One code, no manifest fetch:

```bash
symspec explain --code FND_CONTRADICTION
```

**Rules that will save you tokens and mistakes:**

- JSON is the default. You never need a flag to get parseable output.
- `--dense` minifies and drops the heavy `evidence` payload; `--field a.b,c.d` projects to
  dotted paths. Neither ever changes the exit code.
- The single highest-leverage habit is **vocabulary alignment**: the same words for the same
  things. Two requirements that mean the same thing in different words are invisible to the
  prover, so aligning them is what turns a conflict you suspect into a conflict that is
  *proven*. Commit merges with `glossary add` and opposites with `antonym add`.
- A clean `check` means "no conflict was proven". It does not mean the spec is consistent. If
  you report to a human, report it that way.

---

## The embedding model

One command, once per machine:

```bash
symspec download-model
```

It fetches three files (~110 MB total), verifies each against a pinned sha256, and prints where
they landed. It is **idempotent** — a second run downloads nothing and reports
`"alreadyComplete": true` — so it is safe in a Dockerfile layer, a postinstall script, or an
agent's setup step.

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

symspec is designed so an agent can converge without a human in the middle. Three fields do
that work, and they are on every relevant response rather than behind a flag.

**`repair: {ops, commands}`** — every coverage demotion and most error envelopes carry one.
`ops` are records `symspec apply` decodes **by construction**; `commands` run verbatim.
There are no placeholders: a repair that would have required inventing requirements content
is **omitted** rather than emitted with a `<fill-this-in>`, and the absence means "no
mechanical fix exists, read `action`".

**`data.progress`** — the convergence gradient, three numbers that each fall for a different
reason:

```json
{ "demotions": 3, "openFindings": 1, "atomsUncompared": 2 }
```

All three at zero is exactly the fixed point: no demotions means `verified` is true, no error
findings means exit 0, no uncompared atoms means the formal tier saw the whole document. **If
none of the three moved after a repair batch, the batch did nothing** — which is the signal
to try a different repair rather than the same one again.

**`data.budgetHint`** — appears only when a run has something *measured* to say about its own
`--solver-budget-ms`, extrapolated from the work this run completed and the time it took on
this machine. Absent on an unbounded run and on a run with comfortable headroom, and **the
absence is the all-clear**.

The loop, end to end:

```bash
symspec check --strict                              # exit 3 means "I could not verify this"
symspec check --field data.coverage.demotions       # read the work list
# ... extract repair.ops, or run repair.commands verbatim ...
symspec apply --ops repairs.jsonl
symspec check --strict                              # re-check; watch data.progress fall
```

`symspec explain --code FND_CONTRADICTION` answers for one code without fetching the
manifest — family, severity, tier, meaning, remedy, and a worked example where the catalog
carries one. Every code an envelope can contain is stable and branchable.

For token economy, `--dense` minifies and elides the heavy `evidence` payload (`--evidence`
keeps it), and `--field data.verified,data.counts.error` projects the envelope down to dotted
paths. Neither ever changes the exit code.

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

> `data.verified` is a **whole-document** claim: true only when every requirement shares
> vocabulary with a peer, every opposition candidate has been triaged, and a decide-tier
> comparison actually ran. Propose-only findings and coverage statistics can only **demote**
> `verified`, never promote it.

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

22 operations, all projections of one operations table, so `--help`, `symspec manifest`, and
the generated `AGENTS.md` cannot disagree with the tool:

| Group | Operations |
|---|---|
| Documents | `init`, `import`, `list`, `show` |
| Authoring | `parse`, `add`, `update`, `link`, `delete`, `apply` |
| Vocabulary | `glossary`, `antonym`, `waive` |
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

---

## Status

`1.0.1` <!-- x-release-please-version -->

The document format is **v3**. `symspec import` reads a v2 op stream in one shot, so an older
document migrates without hand-editing. The CLI surface is built on `effect/unstable/cli` at an
exact pin, so a beta bump is a deliberate, reviewed change rather than a floating range.

Treat the **codes and the envelope shape** as the stable contract — those are what an agent
branches on, and they are guarded by append-only snapshot tests. Flag names and payload
additions can still gain fields in a minor release; nothing an agent branches on is removed
without a major.

## License

Apache-2.0. See [LICENSE](LICENSE).
