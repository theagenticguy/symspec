# symspec

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**symspec writes software requirements you can *prove* consistent — and is honest when it
can't.** You describe what a system should do in structured sentences; symspec turns each
into a clean requirement, and a mathematical prover (Z3) either **proves** that two of them
cannot both be true — naming the exact culprits with the smallest conflicting subset as
evidence — or tells you `verified: false` and hands back the precise work list that would
make the spec provable.

Declare a **state model** and it goes further: it proves your invariants over *every
reachable state of the system your requirements describe*, with no bound on how many steps
it takes to get there — and when an invariant is violable, it hands back the exact sequence
of your own requirements that violates it.

That honesty is the whole design. `verified: true` is a claim the tool refuses to make
unless a prover discharged it; every abstention is a named demotion with a runnable command
attached. A similarity score can never certify a spec. Only a sound proof can.

**Built for a coding agent to drive.** Every command answers with a typed JSON envelope and a
stable exit code, so an agent always knows whether it succeeded and what to do next. A human
reads the same result with `--pretty`.

---

## Quick start

```bash
npm install -g symspec          # puts the `symspec` command on your PATH
symspec install                 # drop the authoring skill into your agent host
symspec manifest                # every operation, flag, and code as JSON
```

Then author and check a document:

```bash
symspec init ./requirements.json

# Prose in, structured requirements out — with the ops already computed.
symspec parse "When the user submits valid credentials, the auth service shall grant access."

# Or state the EARS slots directly.
symspec add --pattern-type event-driven \
  --trigger "the user submits valid credentials" \
  --system-name "auth service" --system-response "grant access"

symspec check
```

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
**generated from the same corpus as this README and the manifest**, so it cannot drift from the
tool; the repository's `AGENTS.md` is the same content rendered for a human reading the source.

---

## Honest scope — read this before trusting a verdict

These are the tool's own words, published verbatim in `symspec manifest` and asserted
byte-identical by its test suite. They are the load-bearing honesty of the whole thing.

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

21 operations, all projections of one operations table, so `--help`, `symspec manifest`, and
the generated `AGENTS.md` cannot disagree with the tool:

| Group | Operations |
|---|---|
| Documents | `init`, `import`, `list`, `show` |
| Authoring | `parse`, `add`, `update`, `link`, `delete`, `apply` |
| Vocabulary | `glossary`, `antonym`, `waive` |
| State model | `state`, `state-initial`, `classify` |
| Analysis | `check` |
| Agent surface | `manifest`, `explain`, `version`, `install` |

**80 stable codes** across three catalogs — `ERR_*` operational failures, `FND_*` check
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

`1.0.0-alpha.0`. The document format is **v3** and there is no read-compatibility with the v2
format; migration is a one-shot `reproduce | symspec import`. The CLI surface is built on
`effect/unstable/cli` at an exact pin, so a beta bump is a deliberate, reviewed change rather
than a floating range.

Treat the **codes and the envelope shape** as the stable contract — those are what an agent
branches on, and they are guarded by append-only snapshot tests. Treat flag names and payload
additions as evolving until 1.0.0.

## License

Apache-2.0. See [LICENSE](LICENSE).
