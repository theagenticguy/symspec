<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: pnpm --filter symspec gen:agents   (drift fails `pnpm check`) -->

# symspec — agent guide

symspec is a deterministic spec validator and authoring tool built for coding agents: EARS
requirements go in; structural, INCOSE GtWR lint, and formally-proven conflict findings come
out. Every operation answers in a typed JSON envelope, every finding and error carries a
stable code you can branch on, and this file plus `symspec manifest` are the complete
surface.

**Version:** `1.0.0-alpha.0` · **Envelope apiVersion:** `1`

## Discover the surface

```bash
symspec manifest                          # every operation, flag, and code as JSON
symspec explain --code FND_CONTRADICTION   # ONE code, without fetching the manifest
symspec install                            # drop this guidance into your agent host
```

`manifest` is the machine-readable version of this document. `explain` answers for a
single code across all 81 of them (21 `ERR_*`, 36 `FND_*`, 24 `GTWR_*`) and returns
its family, severity, tier, meaning, remedy, and a worked example where the catalog carries
one — so a fix loop never pays for the whole contract to learn what one code means.

## Response envelope

Success (stdout, the zero-flag default):

```json
{ "apiVersion": 1, "type": "<operation>", "data": { } }
```

Failure:

```json
{ "apiVersion": 1, "type": "error", "error": "<message>", "code": "ERR_*", "suggestions": ["..."], "partial": { }, "repair": { "ops": [], "commands": [] } }
```

- `type` discriminates: the literal `"error"` is a failure, anything else is a success.
- Optional keys are **absent**, never `null` — `partial` and `repair` appear only when
  they carry information.
- `--dense` minifies and elides the heavy `evidence` payload (`--evidence` keeps it);
  `--pretty` renders prose for a human; `--field data.verified,data.findings.0.code`
  projects the envelope down to dotted paths. None of the three ever changes the exit code.
- Document path resolution: the positional path → `SYMSPEC_DOC` → `./requirements.json`.

### Exit codes

| Code | Meaning |
|---|---|
| **0** | Clean — the operation completed with no error-severity finding. |
| **1** | Findings failure — the operation completed but at least one error-severity finding is present. A valid success envelope is still emitted. |
| **2** | Operational failure — an ERR_* error. The error envelope is emitted. |
| **3** | Inconclusive — an opt-in strict coverage gate tripped on a run with no error-severity finding. |

### The agent loop is first-class

- Every `data.coverage.demotions[]` entry and most error envelopes carry
  `repair: {ops, commands}`. `ops` are records `symspec apply` decodes **by
  construction**; `commands` run verbatim. **No placeholders.**
- `data.progress` is the convergence gradient: `demotions`, `openFindings` (error
  severity only), and `atomsUncompared`. All three at zero is the fixed point. If none moved
  after a repair batch, the batch did nothing.
- `data.budgetHint` appears when a run has something measured to say about its own
  `--solver-budget-ms`: `{recommendedBudgetMs, reason, basis, rationale}`, extrapolated
  from the work THIS run completed and the time it took. Absent on an unbounded run and on a
  run with comfortable headroom — the absence is the all-clear.

## Operations

| Operation | What it does |
|---|---|
| `symspec init` | Create an empty requirements document at the resolved path |
| `symspec import` | Import a reproduce-op stream (JSONL on stdin or --file) into a new v3 document |
| `symspec parse` | Parse prose into structured EARS requirements and emit the ready-to-apply add ops |
| `symspec add` | Add one requirement from EARS slots, or from a parsed line of prose |
| `symspec update` | Set or clear one attribute on one requirement, or on every requirement matching a filter |
| `symspec link` | Add or remove one typed edge between two requirements |
| `symspec delete` | Delete one requirement, leaving any inbound edges as dangling references |
| `symspec waive` | Commit or remove a reviewed finding waiver, optionally scoped to one requirement |
| `symspec glossary` | Commit or remove a synonym alias — the DECIDE half of the semantic tier |
| `symspec antonym` | Commit or remove a polar-opposite verb pair — the opposition twin of the glossary |
| `symspec state` | Declare or undeclare one state variable — the document-scoped half of the state model |
| `symspec state-initial` | Set or clear the model-wide initial-state predicate over the declared variables |
| `symspec classify` | Classify one requirement's response as an effect or a constraint, with its state expression |
| `symspec apply` | Apply a JSONL stream of document ops in one process and one atomic write |
| `symspec list` | List every requirement in the document with its key, UUID, and canonical sentence |
| `symspec show` | Show one requirement in full, addressed by its stable key or its UUID |
| `symspec check` | Check a requirements document for contradictions, subsumption, vacuity, and coverage gaps |
| `symspec manifest` | Emit the machine-readable manifest of every operation, exit code, and error code |
| `symspec explain` | Explain one stable diagnostic code (ERR_*, FND_*, or GTWR_*): its severity, meaning, and remedy |
| `symspec version` | Report the package version and the envelope API version |
| `symspec install` | Install the symspec agent skill into every detected coding-agent host |

## Choosing an EARS pattern: a decision procedure

Answer two questions in order. Do not choose by feel — the pattern determines
which slots are MANDATORY, and a wrong choice is an error-severity finding that
excludes the requirement from formal analysis entirely.

**Q1 — Is the behavior conditioned on anything?**

- **No** → `ubiquitous`. An invariant that always holds.
  *The scheduler shall retain the audit log for 90 days.*
- **Yes** → go to Q2.

**Q2 — Is the condition an EVENT (fires once, instantaneous) or a STATE (holds over an
interval)?**

- **Event, and the behavior is wanted** → `event-driven`. Requires `trigger`.
  *When the operator confirms the plan, the scheduler shall start the nightly run.*
- **Event, and the behavior handles a FAILURE or an unwanted condition** →
  `unwanted-behavior`. Requires `trigger`.
  *If the nightly run exceeds its window, then the scheduler shall page the on-call
  engineer.*
- **State, always active while it holds** → `state-driven`. Requires `preCondition`.
  *While maintenance mode is enabled, the scheduler shall reject new submissions.*
- **State, gating an OPTIONAL feature** → `optional-feature`. Requires
  `preCondition`.
  *Where the tenant has SSO configured, the auth service shall delegate
  authentication to the identity provider.*

**Why the event/state distinction is load-bearing.** `trigger` and `preCondition`
are not two names for the same slot — the formal tier groups requirements into context
groups by them, and only requirements in the SAME group are checked for contradiction.
Two requirements that conflict but land in different groups are never compared. Phrase a
trigger as a discrete event in the present tense ("the user submits valid credentials")
and a precondition as a state ("the tenant has SSO configured"), with no leading
"when"/"while"/"where"/"if" — the renderer adds those.

**The unwanted-behavior vs event-driven call.** Both require `trigger` and both are
structurally valid either way, so nothing will fail if you pick the wrong one. Choose
`unwanted-behavior` when the trigger is something you are trying to PREVENT or
RECOVER from; it renders "If …, then …", which is what a reviewer reads as error
handling.

## Align vocabulary BEFORE writing, not after checking

**The failure mode you are avoiding.** symspec is sound modulo atomization: every
conflict it reports is real, and a conflict it does NOT report may still exist. Two
requirements are only compared when they share an atom. So if one says "start the
nightly run" and another says "begin the batch job", they atomize to different things,
the solver never puts them in the same query, and `check` returns clean — even when
they contradict.

A clean `check` therefore means "no conflict was PROVEN", never "the spec is
consistent". `data.residualRisk.unmatchedAtoms` and `data.progress.atomsUncompared`
are the numbers that tell you how much went uncompared; `FND_NO_PAIRS_CHECKED` fires
when NOTHING was cross-compared at all.

**The workflow, in order:**

1. **Name the system once.** Every requirement about the same component uses the SAME
   `systemName` string. The candidate-pair filter skips pairs that span different
   systems outright, so "scheduler" vs "job scheduler" halves your coverage for free.
2. **Name each trigger once.** Copy the trigger string verbatim between requirements
   that react to the same event. Context groups are keyed on it.
3. **Fix one verb per action, and one noun per object.** Write a short list before you
   write requirements: start/stop, enqueue/dequeue, grant/revoke, open/close. Then use
   only those. Paraphrase is the enemy here, not repetition — a spec that reads
   repetitively is a spec whose conflicts are provable.
4. **Commit oppositions you rely on.** If the conflict you care about is
   "start" vs "halt", run `symspec antonym add start halt` so the atomizer collapses
   them to one atom at opposite polarity. Until you do, the solver sees two unrelated
   facts and proves nothing.
5. **Commit synonyms you could not avoid.** Where two teams genuinely use different
   words for one thing, `symspec glossary add "<canonical>" "<alias>"` unifies them.
6. **Only then `check`.** The propose-only tier will suggest what you missed
   (`FND_SIMILAR_SEMANTIC`, `FND_OPPOSITION_CANDIDATE`,
   `FND_QUANTITY_ALIAS_CANDIDATE`) — treat each as a gap in step 3, not as a chore.

**The one thing never to do mechanically.** An `FND_OPPOSITION_CANDIDATE` offers TWO
mutually exclusive remedies: `antonym add` if the verbs are opposites,
`glossary add` if they are synonyms. Committing the wrong one MANUFACTURES a false
contradiction, and embeddings cannot tell which is right because antonyms embed close
together. Read the pair and decide; the always-safe third option is a reviewed waiver
that records "I triaged this and it is not a conflict".

## Decomposition: when to split, and which edge to use

**Split when a requirement carries more than one obligation.** The test is
mechanical: if you cannot verify the requirement with a single pass/fail observation,
it is more than one requirement. "The checkout service shall reserve the inventory and
charge the payment method" needs two observations, so it is two requirements — and
`symspec parse` will hand you both as ready-to-apply ops rather than making you split
by hand.

**Do NOT split** to make a sentence shorter, or to separate a requirement from its
measurable bound. "respond within 500 ms" is one obligation.

**The four relations, each answering a different question:**

| Relation | Question it answers | Direction |
|---|---|---|
| `refines` | Is this the SAME obligation stated more precisely? | specific → general |
| `derives` | Does this obligation EXIST BECAUSE of that one? | child → parent |
| `satisfies` | Does this design decision DISCHARGE that need? | solution → need |
| `verifies` | Does this requirement establish that the other HOLDS? | test → claim |

**`refines` vs `derives` — the distinction that matters.** `refines` keeps ONE
obligation and adds precision, so the parent and child should share vocabulary and land
in the same context group (which means the solver can check them against each other —
a refinement that contradicts its parent is exactly the conflict you want proven).
`derives` introduces a NEW obligation that the parent motivated; parent and child are
different claims, and the solver treats them as such.

**`verifies` is the one with a structural consequence.** A leaf of the refinement DAG
— inbound `refines`/`derives`, no outbound — with no `verifies` edge produces
`FND_LEAF_UNVERIFIABLE` (warn): a leaf is where the work actually happens, so it must
be independently verifiable. Either link the requirement that verifies it, or set
`verificationMethod` (`test`/`inspection`/`analysis`/`demonstration`) and say
how in `verificationNote`.

**Two structural traps.** `derives`/`refines` must form a DAG —
`FND_CYCLE` (error) fires on a loop, and a cycle usually means two requirements each
claim to motivate the other, which is a modelling error rather than a typo. And a
requirement with no edges at all in a multi-requirement document is
`FND_ORPHAN` (warn): it may be legitimate, but it is worth asking why nothing relates
to it.

## Anti-patterns, and the code each one actually fires

Every row below was measured against the live detectors, not read off a rule
description. Three of them contradict the obvious guess, and those are the useful ones.

### Vague term the lexicon does NOT know

- **Avoid:** When the request arrives, the api gateway shall respond quickly.
- **Prefer:** When the request arrives, the api gateway shall respond within 500 ms.
- **Fires:** _nothing_

Fires NOTHING — and that is the most important row in this table. The vague-term check is a LEXICON, not a semantic judgment: `fast`, `robust`, `timely`, `minimal`, `adequate`, `flexible`, and `user-friendly` fire `GTWR_R7_VAGUE` at ERROR severity, while `quickly`, `rapidly`, `promptly`, `efficiently`, and `easily` fire nothing at all. Do not read a clean lint as "this requirement is measurable". Every performance claim needs a number and a unit, whether or not a rule catches its absence.

### Compound requirement

- **Avoid:** When the user submits the order, the checkout service shall reserve the inventory and charge the payment method.
- **Prefer:** When the user submits the order, the checkout service shall reserve the inventory.
- **Fires:** `GTWR_R15_LOGICAL_EXPR`, `GTWR_R19_COMBINATOR`

The lint signal is `GTWR_R19_COMBINATOR` at WARN — not `GTWR_R18_MULTIPLE_SHALL`, which needs two `shall`s and does not fire here. So a compound authored directly through `add` is only a warning, and warnings do not gate. Author through `symspec parse` instead: the parse path returns `ERR_PARSE_COMPOUND` AND hands back `proposedOps` with the split already computed, so `symspec apply` fixes it mechanically.

### Passive voice hiding the actor

- **Avoid:** When the batch completes, the report shall be generated.
- **Prefer:** When the batch completes, the reporting service shall generate the report.
- **Fires:** `GTWR_R2_PASSIVE`

Passive voice does not say WHO is obligated, so nothing can be held responsible and no test can be written. It also costs coverage: the actor becomes the grammatical object, so `systemName` ends up as the artifact ("report") rather than the component, and requirements about the same component stop sharing a system — which makes them ineligible to be paired.

### Bare number with no unit

- **Avoid:** When the request arrives, the api gateway shall respond within 500.
- **Prefer:** When the request arrives, the api gateway shall respond within 500 ms.
- **Fires:** `GTWR_R6_MISSING_UNITS`

`GTWR_R6_MISSING_UNITS` is ERROR severity, which makes this the anti-pattern with the largest hidden cost: an error-severity lint finding EXCLUDES the requirement from the formal tier, so the requirement is never cross-compared and `data.verified` is demoted with an `excluded-from-formal` reason. A missing unit does not just fail a style check — it removes the requirement from the analysis.

### Unit mixing across a set

- **Avoid:** When the request arrives, the api gateway shall respond within 1.5 seconds.
- **Prefer:** When the request arrives, the api gateway shall respond within 1500 ms.
- **Fires:** `GTWR_R33_MISSING_TOLERANCE`

This sentence alone fires only the tolerance prompt. Unit and precision consistency is a SET-level property: `GTWR_R40_DECIMAL_FORMAT` (info) fires only once a second requirement uses a different number of fractional digits, so it cannot be seen by checking one requirement at a time. Pick one unit per quantity across the whole document, because the numeric tier compares bounds only after unit normalization — and two bounds on what you think is one quantity may land on different quantity keys, which surfaces as `FND_QUANTITY_ALIAS_CANDIDATE` rather than as the conflict you were looking for.

### Tolerance-free quantity

- **Avoid:** The pump shall deliver 30 ml per hour.
- **Prefer:** The pump shall deliver 30 ml per hour plus or minus 2 ml per hour.
- **Fires:** `GTWR_R33_MISSING_TOLERANCE`

A WARN prompt, and one you cannot silence by adding a range: `GTWR_R33_MISSING_TOLERANCE` also fires on "within 400 ms to 600 ms" and on "500 ms plus or minus 50 ms" (measured). It is a prompt to state a tolerance, not a check that one is missing, so treat it as a question to answer in review rather than a finding to drive to zero.

### Unachievable absolute

- **Avoid:** The scheduler shall always enqueue the job.
- **Prefer:** When the operator confirms the plan, the scheduler shall enqueue the job.
- **Fires:** `GTWR_R26_ABSOLUTE`

ERROR severity on a BARE absolute, and WARN when a conditional clause qualifies it — the severity is decided per finding, not per code. That is also the fix: an absolute is usually a missing trigger or precondition. Replacing "always" with the condition under which the behavior is actually required makes the requirement both achievable and eligible for a context group.

### Universal quantifier where "each" is meant

- **Avoid:** The scheduler shall validate all inputs.
- **Prefer:** The scheduler shall validate each input.
- **Fires:** `GTWR_R26_ABSOLUTE`, `GTWR_R32_UNIVERSAL`

"all inputs" reads as a single aggregate obligation ("validate the set"), where "each input" reads as one obligation per element — a different claim, and the one usually intended. Note it fires BOTH `GTWR_R32_UNIVERSAL` and `GTWR_R26_ABSOLUTE`, because "all" is in the absolutes lexicon too.

### Escape clause

- **Avoid:** The scheduler shall retry the job where possible.
- **Prefer:** When a transient error occurs, the scheduler shall retry the job up to 3 times.
- **Fires:** `GTWR_R8_ESCAPE`

ERROR severity, and correctly so: "where possible" makes the requirement unfalsifiable — no observation can violate it, so no test can verify it. The fix is to state the condition that makes the behavior required, which is usually what "where possible" was standing in for.

### Open-ended list

- **Avoid:** The scheduler shall log the errors, etc.
- **Prefer:** The scheduler shall log the error code, the job id, and the retry count.
- **Fires:** `GTWR_R9_OPEN_ENDED`

ERROR severity. "etc." and "including but not limited to" leave the obligation unbounded, so it can never be shown complete. Enumerate, or split into one requirement per item.

### Pronoun with an unclear referent

- **Avoid:** When the job fails, the scheduler shall retry it.
- **Prefer:** When the job fails, the scheduler shall retry the job.
- **Fires:** `GTWR_R24_PRONOUN`

A WARN, and the coverage cost is the real reason to care: "it" is not an atom the way "the job" is, so a pronoun weakens the vocabulary the solver matches on. Repetition reads worse and proves more.

### Purpose phrase inside the requirement

- **Avoid:** The scheduler shall enqueue the job in order to balance the load.
- **Prefer:** The scheduler shall enqueue the job.
- **Fires:** `GTWR_R20_PURPOSE`

The rationale is not part of the obligation, and mixing it in makes the requirement look like it has two clauses. Keep the statement to the obligation and record the reasoning in `verificationNote` or in the parent requirement the `derives` edge points at.

### Superfluous infinitive

- **Avoid:** The scheduler shall be able to enqueue the job.
- **Prefer:** The scheduler shall enqueue the job.
- **Fires:** `GTWR_R10_SUPERFLUOUS_INFINITIVE`

"shall be able to" states a CAPABILITY, not an obligation — a system can be able to do something and never do it, so the requirement is satisfied by inaction. Drop the infinitive and the obligation becomes testable.

### Oblique "and/or"

- **Avoid:** The scheduler shall enqueue and/or defer the job.
- **Prefer:** When the queue has capacity, the scheduler shall enqueue the job.
- **Fires:** `GTWR_R17_OBLIQUE`, `GTWR_R19_COMBINATOR`

"and/or" is three requirements in one ambiguous phrase, and it also fires `FND_AMBIGUOUS_QUANTIFIER` at the ambiguity tier when the coordination is un-parenthesized. Say which condition selects which behavior; that is the information "and/or" is hiding.

### Negated obligation

- **Avoid:** The scheduler shall not enqueue the job.
- **Prefer:** While the queue is full, the scheduler shall reject the job.
- **Fires:** `GTWR_R16_NEGATION`

A WARN with a legitimate-exception downgrade, so this is a judgment call rather than a rule. But a negative obligation is hard to verify (you must observe the absence of a behavior forever) and it is usually a positive obligation about a different condition. When you do need the negation, `negated: true` on the requirement records it as a FLAG the atomizer understands, which is strictly better than burying "not" in the response text where it becomes part of the atom.

**The severity rule that governs all of these.** Only ERROR-severity findings gate the
exit code — and an error-severity lint finding also EXCLUDES its requirement from the
formal tier, so it costs you analysis coverage on top of the failed check. GtWR severity
is decided PER FINDING, not per code: the same rule can be `error` on a bare phrase and
`warn` when a conditional clause qualifies it. Read each finding's own `severity`
field rather than assuming a code's severity from its name.

## A worked example: the silent contradiction, and the loop that finds it

Measured on this build. The point of the example is that **step 1 looks
perfect and is wrong.**

**Step 1 — author two requirements that contradict each other.**

```bash
symspec init ./requirements.json
cat > plan.jsonl <<'OPS'
{"op":"add","patternType":"event-driven","trigger":"the operator confirms the plan","systemName":"scheduler","systemResponse":"start the nightly run"}
{"op":"add","patternType":"event-driven","trigger":"the operator confirms the plan","systemName":"scheduler","systemResponse":"halt the nightly run"}
OPS
symspec apply --ops plan.jsonl
symspec check
```

Result:

```
verified: true    findings: 0    counts.error: 0    exit 0
pairsChecked: 1   progress.atomsUncompared: 2
```

The document says the scheduler shall both start and halt the same run on the same
trigger, and `check` is **clean**. Nothing is broken — this is the soundness boundary
working as designed. "start" and "halt" are two unrelated atoms, so the solver had
nothing to contradict. The only signal is `atomsUncompared: 2`: two atoms had no
cross-requirement partner.

**Step 2 — commit the opposition, so the solver can SEE it.**

```bash
echo '{"op":"antonym","a":"start","b":"halt"}' | symspec apply --ops /dev/stdin
symspec check
```

Result:

```
verified: true    findings: 1    counts.error: 1    exit 1
FND_CONTRADICTION (error) — names BOTH requirement ids, with the unsat core as evidence
progress.atomsUncompared: 0    progress.openFindings: 1
```

**What changed, and what did not.** The document is byte-identical apart from one
antonym entry. No requirement was edited. The conflict was always there; committing the
vocabulary is what made it PROVABLE. `atomsUncompared` fell from 2 to 0 because the
two responses now collapse to one atom at opposite polarity.

**Read `verified` correctly.** It is `true` in BOTH runs, and that is not a bug —
`verified` answers "was consistency actually CHECKED", not "is the document clean". A
proven contradiction is the strongest evidence the decide tier ran. What says the
document is bad is `counts.error` and the exit code, which went 0 → 1.

**The loop, generalized.**

1. `symspec check --strict` — exit 3 means "I could not verify this".
2. Read `data.coverage.demotions`; each carries `repair.ops` (apply-ready) and
   `repair.commands` (runnable). No placeholders.
3. Apply: `symspec check --field data.coverage.demotions` → extract the ops →
   `symspec apply`.
4. Re-check. `data.progress` is the gradient — `demotions`, `openFindings`, and
   `atomsUncompared` all reaching zero is the fixed point. If none of the three moved,
   the last batch did nothing and you need a different repair.
5. Fix the error-severity findings the run reports. Each one you fix also widens formal
   coverage, because an error-severity lint finding excludes its requirement from the
   solver.

## Authoring a state model, so `check` can prove your invariants

The tiers in the sections above compare requirements against EACH OTHER. A state
model buys something different: `check` proves your invariants over **every reachable
state of the system your requirements describe**, with no bound on how many steps it takes
to get there — and when an invariant is violable, it hands back the exact sequence of your
own requirements that violates it.

That is the capability. It is off until you author it, and it discloses its own absence:
a document with no state model gets `FND_REACHABILITY_NOT_CHECKED` rather than silence,
because a question never asked reads exactly like a question answered cleanly.

### When to declare a state variable

Not for every noun. Declare a variable when **two or more requirements disagree about the
same piece of mutable system state, and no single requirement contains the disagreement.**
That is the defect class this tier finds and the other tiers structurally cannot: the
contradiction is not between two sentences, it is in the ORDER the sentences allow.

The mechanical test, in order:

1. **Is there something the system REMEMBERS between events?** A lock that is held or free,
   a run that is pending or running, a retry counter. If every requirement is a pure
   input→output rule with no memory, there is no state model to write and the propositional
   tiers already cover you.
2. **Do at least two requirements CHANGE it?** One writer is not an ordering problem. The
   interesting models have an acquire and a release, an enqueue and a dequeue, a start and a
   timeout.
3. **Is there something you believe is always true of it?** "At most one holder." "The
   counter never exceeds the limit." "Nothing waits on a free lock." If you cannot state
   such a sentence, you have a state model with nothing to prove.

If all three hold, declare it. If only 1 and 2 hold, the model will run and prove nothing —
you will get `FND_REACHABILITY_NOT_CHECKED` telling you no requirement carries a
constraint, which is the honest report.

**Keep it small, and keep the integers bounded.** `--type int --min 0 --max 3` is a
finite-domain variable, which is what lets a query be DECIDED rather than merely attempted.
An unbounded integer is where `FND_REACHABILITY_UNKNOWN` with reason `undecidable`
comes from, and its remedy is to bound the domain — more time will not help.

### Effect or constraint: the classification procedure

Every classified response is exactly one of two things, and the prose will not tell you
which — the same sentence can read as either. Ask **does this response CHANGE the state, or
RESTRICT it?**

| | `effect` | `constraint` |
|---|---|---|
| What it is | a TRANSITION the system may take | a PREDICATE that must hold in every reachable state |
| Expression | `when <guard>: <var> := <value>` | a boolean predicate over the variables |
| What the tier does with it | builds the transition relation | tries to VIOLATE it |
| Assignment vs comparison | `:=` assigns | `=` compares |

The reliable discriminator: **an effect names a moment, a constraint names a forever.** If
you can point at the event during which the response happens, it is an effect. If the
response is a property you would check at any instant, it is a constraint.

Two consequences worth knowing before you classify:

- **A requirement classified `effect` with no guard fires from EVERY state.** That is the
  sound default — it admits more transitions, so it proves strictly less — but it is almost
  never what a triggered requirement means. **The guard is what an EARS trigger means
  formally**, and you write it explicitly because the tool will not guess it from your
  prose `trigger` slot: guessing would make the solver prove the wrong thing confidently.
  So an `event-driven` requirement whose trigger is "an agent worker claims a run" gets a
  guard like `when held = 0`, expressing the same condition over declared variables.
- **Every name in every expression must already be declared.** `classify` refuses an
  undeclared reference at authoring time — measured: `"held" is not a declared state
  variable` at `ERR_USAGE` — rather than accepting it. That refusal is load-bearing:
  reaching the Horn encoder, an undeclared name produces an UNKILLABLE solver hang, not an
  error message. The same rule blocks `state --remove` on a variable expressions still
  reference, and names the requirements that reference it.

### The declared-vars-only rule

**The state model is a CLOSED vocabulary.** The only names an expression may use are the
ones `symspec state` declared, plus integer literals, `true`/`false`, and the enum
members you listed in `--domain`. There is no implicit variable, no inferred type, and no
name that springs into existence by being written.

That is stricter than it needs to be for the encoder and exactly as strict as it needs to be
for you: a typo'd variable in a constraint would otherwise become a fresh unconstrained
variable, the predicate would be trivially satisfiable, and the tool would report a proof of
something you did not write. Declared-vars-only converts that into a usage error you fix in
one command.

The grammar the expressions live in is small on purpose: comparisons
(`= != < <= > >=`), `+` and `-` on ints, `and`/`or`/`not`, parentheses. **No
multiplication** (it makes the transition relation nonlinear, where an unbounded solver hang
was measured), no quantifiers, no chained comparisons — write `a < b and b < c`. And
`< <= > >=` are INTEGER-ONLY, because an enum has a declared domain, not an order.

### Choosing a frame, per variable

`--frame` answers one question about ONE variable: **does it persist across a step that
does not write it?**

- **`volatile` (the default)** — it may change freely in any step. Nothing is assumed.
- **`stable`** — it changes ONLY when some requirement's effect changes it.

`stable` is the stronger assumption and it is a claim about your system that the document
does not otherwise make. Here is why the default runs the other way, measured: on a model
whose `alarm` variable is written by NO requirement, the framed run returns UNREACHABLE
**with an inductive invariant** while the nothing-assumed run returns REACHABLE — and
`alarm` is genuinely reachable. Under the frame the solver proves a false answer and hands
back a certificate for it. A frame-by-default tool would therefore certify fictions, so
`volatile` is the default and the safe direction is the one that proves less.

What that means in practice is the verdict you will actually see most often:

- **`FND_REACHABILITY_PROVED`** — proved with nothing assumed. Frame-closed, and the
  strongest thing the tier says. Realistically a property of single-variable models.
- **`FND_REACHABILITY_UNDER_HYPOTHESES`** — proved only once the unwritten variables are
  held fixed. The message NAMES the variables relied upon together with the requirements
  that write them, says **THE DOCUMENT DOES NOT STATE THAT**, and DEMOTES `verified`. With
  more than one state variable this is the honest common outcome, not a failure.

So do not chase `PROVED`. Declaring everything `stable` does not upgrade the verdict —
it TIGHTENS the disclosed hypothesis, because the tier re-runs with your declared set and
names exactly what you wrote down instead of all N variables. The discharge is to author the
requirements that justify the assumption, which is spec work rather than a flag.

### The worked example: the real TX-C1, proved and then broken

Measured on the built CLI, on the hex-bonk `agent-run-triggers` production requirement:

> **TX-C1** — The run service shall assign runs that share a conversation the Procrastinate
> lock keyed on the conversation id so they execute sequentially.

That is a mutual-exclusion invariant. Two variables and three effects express the lock's
lifecycle.

**Step 1 — declare, classify, and PROVE.**

```bash
symspec init ./requirements.json
cat > plan.jsonl <<'OPS'
{"op":"state","name":"held","type":"int","min":0,"max":3,"initial":"held = 0"}
{"op":"state","name":"queued","type":"bool","initial":"queued = false"}
{"op":"add","key":"TX-A1","patternType":"event-driven","trigger":"an agent worker claims a run","systemName":"run service","systemResponse":"acquire the conversation lock"}
{"op":"add","key":"TX-A2","patternType":"event-driven","trigger":"a run reaches a terminal state","systemName":"run service","systemResponse":"release the conversation lock"}
{"op":"add","key":"TX-A3","patternType":"event-driven","trigger":"a run for a locked conversation is queued","systemName":"run service","systemResponse":"mark the run waiting"}
{"op":"add","key":"TX-C1","patternType":"ubiquitous","systemName":"run service","systemResponse":"hold at most one conversation lock at a time"}
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

TX-C1 holds — and the verdict is `PROVED_UNDER_HYPOTHESES`, not `PROVED`, exactly as
the frame section predicts. The finding says so and names the hypothesis:

```
TX-C1: PROVED_UNDER_HYPOTHESES — no reachable state violates this constraint, ASSUMING
these variables change only when a requirement changes them: held (written by TX-A1,
TX-A2); queued (written by TX-A1, TX-A3). THE DOCUMENT DOES NOT STATE THAT.
```

**Step 2 — add a second invariant that sounds obviously true, and watch it FAIL.**

```bash
symspec add --key TX-C2 --pattern-type ubiquitous --system-name "run service" \
  --system-response "hold the waiting flag only while the conversation lock is held"
symspec classify TX-C2 --kind constraint --expression "not (queued and held = 0)"
symspec check --field data.reachability
```

```json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":1,"violated":1,"unknown":0,"elapsedMs":537,"timeoutMs":2000}
```

Exit **1**, through the existing contract — the error-severity finding lands in
`counts.error`, so nothing about the exit mapping had to learn about reachability. And the
finding hands back the path:

```
TX-C2: a reachable state VIOLATES this constraint. The solver reached it by firing:
init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2. Proven over all reachable states with no bound.
```

Read that trace as a sentence about your own document: acquire the lock (TX-A1), a second
run queues behind it (TX-A3), the first run finishes and releases (TX-A2) — and now a run is
waiting on a free lock. **"Nothing waits for a free lock" is FALSE of the system as
specified**, and it is false for an ordering reason no single requirement contains. This is
the defect class a spec review misses.

**Step 3 — fix the REQUIREMENT, not the constraint.**

The temptation is to weaken TX-C2 until it passes. The trace says otherwise: the fault is
that TX-A2 releases the lock without clearing the waiting flag.

```bash
symspec classify TX-A2 --kind effect \
  --expression "when held = 1: held := held - 1, queued := false"
symspec check --field data.reachability
```

```json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":2,"violated":0,"unknown":0,"elapsedMs":350,"timeoutMs":2000}
```

Exit **0**. Both invariants now hold, and the change was to the requirement the trace
blamed. That is what makes the report a work list rather than a verdict: `violated` fell
1 → 0 and `provedUnderHypotheses` rose 1 → 2, so the gradient moved in the direction the
repair intended.

### Reading the other two verdicts

- **`FND_REACHABILITY_UNKNOWN`** — the solver did not decide, so NOTHING is claimed and
  `verified` demotes. The message states which of two causes applies, because they need
  opposite remedies and the solver cannot be asked: a timed-out Spacer query reports its
  reason as the literal string `"ok"`, so the distinction is derived from measured elapsed
  time against the budget. Budget exhaustion → raise `--reachability-timeout-ms` (this
  tier's own per-query bound, which inherits `--timeout-ms` when absent). Genuine
  undecidability → bound the integer domains; more time will not help.
- **`FND_REACHABILITY_NOT_CHECKED`** — a coverage DISCLOSURE, not a defect. It fires when
  no state model is committed, when variables are declared but nothing is classified, and —
  the one worth watching for — when **the model admits no transitions at all**, i.e. no
  requirement is classified `effect`. Measured on a document with one variable and one
  constraint and zero effects: the constraint reports `PROVED` **and** the disclosure
  fires, because with no transitions the only reachable state is the initial one and an
  invariant that holds there holds almost vacuously. A `PROVED` on an effect-free model is
  not evidence about a running system, and the disclosure is what stops you reading it as
  one.

## Honest scope — read before trusting a verdict

All 7 claims, verbatim:

> The formal (SMT) tier is sound modulo atomization, given the conservative near-exact normalization of the atom table: every reported conflict is a genuine logical conflict of the requirements as atomized, and the atom table attached to each finding shows exactly what the solver compared.
>
> Because paraphrases become distinct atoms, a real conflict can be missed (a false negative): silence is not a consistency certificate, so the formal tier reporting no conflict does not prove the spec consistent.
>
> The one false-positive risk is over-unification (too-aggressive normalization collapsing two distinct conditions into one atom); it is mitigated by conservative normalization (no stemming or stopword-stripping beyond leading articles) and the info-severity FND_SIMILAR_UNUNIFIED reporter.
>
> Deterministic ambiguity detectors (vague terms, quantifier/coordination scope, and referential ambiguity) run and report; but whether a phrase is vague in its domain context — pragmatic/contextual ambiguity — is surfaced for review (FND_AMBIGUITY_NEEDS_JUDGMENT), not decided by symspec, and any LLM ambiguity judgment is propose-only, never a verdict.
>
> Semantic similarity is a propose-only assist: the always-on embedding tier suggests glossary merges and opposition candidates for paraphrased or polar-opposite responses but never emits a conflict verdict, so `check` remains reproducible given the document, its glossary, and the pinned embedding model. A missing model fails the run closed (ERR_EMBED_MODEL_MISSING) rather than silently skipping the tier; pre-warm with `symspec download-model`.
>
> Numeric conflicts are checked over linear integer/real arithmetic (LIA/LRA): requirements placing jointly unsatisfiable bounds on the same per-system quantity (unit-normalized) are reported as FND_NUMERIC_CONTRADICTION. Nonlinear-integer arithmetic remains out of scope (undecidable).
>
> `data.verified` is a whole-document claim: it is true only when every requirement shares vocabulary with a peer (participates in a cross-requirement comparison), every opposition candidate has been triaged (committed via `antonym add`/`glossary add` or waived), and a decide-tier comparison actually ran. Propose-only findings and coverage statistics can only demote verified, never promote it. Each demotion is listed in `data.coverage.demotions` with the concrete command that discharges it, so an agent can iterate: `check --strict` (exit 3 on demotion) -> apply the listed ops or rewrite the named requirements -> re-check -> exit 0.

## Error codes (`ERR_*`)

An operational failure. The envelope's `type` is `"error"` and the process exits 2.
No finding severity applies — an `ERR_*` replaces the result rather than appearing inside
one.

| Code | Meaning |
|---|---|
| `ERR_USAGE` | Invalid or missing CLI arguments. |
| `ERR_DOC_NOT_FOUND` | The requirements-document path did not resolve. |
| `ERR_DOC_PARSE` | The document is not valid JSON or fails RequirementsDocSchema. |
| `ERR_SCHEMA_VERSION` | The document's schemaVersion does not equal the current SCHEMA_VERSION, though it does satisfy the current document schema. The suggestions therefore carry the exact ops that reproduce it: a `symspec init` step, one `symspec apply` JSONL op record per requirement and per edge in dependency order, the `symspec glossary`/`antonym`/`waive` commands for the tables `apply` has no op for, and an explicit statement of anything the ops do not reproduce. |
| `ERR_IO` | An atomic write to the document failed (permissions or disk). The original file is left intact. |
| `ERR_DUPLICATE_ID` | A CreateRequirement supplied a UUID that already exists. |
| `ERR_NOT_FOUND` | The referenced requirement id is not present. |
| `ERR_INVALID_RELATION` | The edge relation is not one of the defined RELATIONS. |
| `ERR_INVALID_ATTR` | The update attribute is not an updatable attribute. |
| `ERR_NULL_REQUIRED` | Null/--clear was applied to a required (non-nullable) attribute. |
| `ERR_PARSE_NO_MODAL` | No `shall`/modal main clause was found. |
| `ERR_PARSE_AMBIGUOUS_CLAUSES` | Clause boundaries could not be resolved after Tier 2. |
| `ERR_PARSE_COMPOUND` | A compound requirement (top-level and/or) was detected. |
| `ERR_PARSE_NOT_A_REQUIREMENT` | The input is prose with no obligation. |
| `ERR_SOLVER_MISSING` | A binary solver backend was requested but none was found by the discovery order. |
| `ERR_SOLVER_TIMEOUT` | The overall run budget (--solver-budget-ms) was exceeded — a whole-run failure, never a single group. |
| `ERR_SOLVER_INCONCLUSIVE` | A whole-run solver-init failure / the solver is unusable — never a per-group `unknown` (that is FND_NEEDS_REVIEW). |
| `ERR_LEAN_TOOLCHAIN_MISSING` | `certify` was requested but no Lean toolchain is discoverable. |
| `ERR_DOC_EXISTS` | `init` refused to overwrite an existing document at the resolved path. |
| `ERR_EMBED_MODEL_MISSING` | The embedding model (core to every `check`) is not cached and remote loading is disabled — the run fails closed rather than silently skipping the semantic/opposition tier. |
| `ERR_DUPLICATE_KEY` | A create supplied a --key that another requirement already uses; keys must be unique. |

## Finding codes (`FND_*`)

A finding inside a **successful** `check`. Only `error` severity gates the exit code, and
an error-severity finding also excludes its requirement from the formal tier.

| Code | Severity | Tier | Meaning |
|---|---|---|---|
| `FND_DANGLING_REFERENCE` | error | structural | an edge targets a nonexistent requirement UUID. |
| `FND_MISSING_TRIGGER` | error | structural | an event-driven / unwanted-behavior requirement has no trigger. |
| `FND_MISSING_PRECONDITION` | error | structural | a state-driven / optional-feature requirement has no precondition. |
| `FND_CYCLE` | error | structural | a cycle in `derives`/`refines` (canonical-rotation deduplicated). |
| `FND_ORPHAN` | warn | structural | a requirement with zero inbound/outbound edges (document size > 1). |
| `FND_EXACT_DUPLICATE` | error | lint | an identical slot-tuple hash: two requirements are exact duplicates. |
| `FND_CONTRADICTION` | error | formal | a context group is unsat; ids are the filtered MINIMAL unsat core; requires same-atom opposite-polarity responses. |
| `FND_SUBSUMPTION` | warn | formal | a directional implication is valid; `moreGeneral` is the superset-of-cases side. |
| `FND_REDUNDANCY` | warn | formal | a bi-implication is valid: the two requirements are logical duplicates. |
| `FND_VACUITY` | warn | formal | a guard is unreachable given all OTHER requirement formulas (relational, labeled lower confidence). |
| `FND_SIMILAR_UNUNIFIED` | info | formal | responses with Jaccard ≥ 0.7 that did not unify to one atom; an over-unification-adjacent review prompt (suggests rewording one response via `symspec update`). |
| `FND_NEEDS_REVIEW` | info | formal | a per-group solver `unknown`/timeout/unencodable result; explicitly NOT a "no conflict". |
| `FND_INCOMPLETE` | info | formal | a heuristic guard-coverage gap over a same-trigger-family group; NOT a formal completeness guarantee. |
| `FND_CERTIFIED` | info | formal | the Lean toolchain elaborated the generated file; carries `#print axioms` provenance. NOT a proof about the spec: every requirement is emitted as a placeholder `True` theorem, so this fires identically for a document `check` proves contradictory. Never gate a consistency claim on it. |
| `FND_CERTIFY_FAILED` | error | formal | Lean produced a `severity:"error"` diagnostic; certification failed. |
| `FND_SIMILAR_SEMANTIC` | info | formal | two responses embed with cosine ≥ threshold but did not unify to one atom; a PROPOSE-only prompt to add a `symspec glossary` entry. Never a verdict. |
| `FND_NUMERIC_CONTRADICTION` | error | formal | two+ requirements place jointly unsatisfiable linear numeric constraints (LIA/LRA) on the same per-system quantity; ids are the minimal unsat core, evidence lists the conflicting predicates (unit-normalized). |
| `FND_LEAF_UNVERIFIABLE` | warn | structural | a refinement-DAG leaf (inbound refines/derives, no outbound) with no `verifies` edge; a leaf must be independently verifiable (KAOS/SysML leaf-verifiability). |
| `FND_MISSING_TRACE_LINK` | info | formal | two requirements embed with cosine ≥ threshold but share no committed refines/derives/satisfies edge; a PROPOSE-only candidate trace link. Never a verdict. |
| `FND_DUPLICATE_CLUSTER` | info | formal | three+ requirements form a tight semantic cluster; a PROPOSE-only prompt to review for near-duplication or an unstated shared parent. Never a verdict. |
| `FND_AMBIGUOUS_VAGUE` | info | lint | a vague/weasel term (e.g. "fast", "user-friendly", "as appropriate") with no measurable meaning; deterministic lexical scan, carries the offending span. |
| `FND_AMBIGUOUS_QUANTIFIER` | warn/info | lint | scope/quantifier ambiguity: un-parenthesized "and…or" coordination (warn), leading "all/each/every", or a bare-plural subject; deterministic pattern scan with a span. |
| `FND_AMBIGUOUS_REFERENCE` | info | lint | a pronoun or bare definite NP ("it", "the system") with ≥2 candidate antecedents in scope; deterministic detection (recall-first), resolution is punted to the agent. |
| `FND_AMBIGUITY_NEEDS_JUDGMENT` | info | lint | pragmatic/contextual ambiguity was not assessed deterministically; a structured prompt to hand the requirement to an LLM/agent review. Never a verdict, never in the reproducibility hash. |
| `FND_TEMPORAL_CONTRADICTION` | error | formal | a set of requirements is temporally inconsistent under bounded LTL→SMT (no trace of length ≤ k satisfies them jointly); sound-for-UNSAT, evidence carries {bound,complete:false}. Opt-in via `check --temporal`. |
| `FND_NO_PAIRS_CHECKED` | info | formal | the formal tier evaluated 0 candidate pairs (no two requirements shared an atom), so no cross-requirement conflict/subsumption analysis actually ran. Silence here is not a consistency certificate; consider glossary entries to align vocabulary so related requirements share atoms. |
| `FND_OPPOSITION_CANDIDATE` | info | formal | two same-system responses share an object phrase but differ on the leading verb (e.g. "open the valve" vs "shut the valve"), a LIKELY antonym pair the seed/committed antonym tables have not unified. Propose-only: if the verbs are truly opposite, run `symspec antonym add <verbA> <verbB>` so the formal tier collapses them to one atom at opposite polarity and can prove any conflict. Never a verdict. |
| `FND_EXCLUDED_FROM_FORMAL` | info | structural | a requirement was excluded from the formal (SMT) tier because an error-severity lint or parse finding blocked its surface, so no cross-requirement analysis covered it. A LOUD coverage signal that DEMOTES `verified` (silence over an unchecked requirement is not a consistency certificate); discharge by fixing the blocking finding (rephrase) — waiving the finding alone does NOT restore formal coverage. |
| `FND_QUANTITY_ALIAS_CANDIDATE` | info | formal | two same-system, same-trigger numeric bounds landed on different quantity keys that share a noun token (e.g. "complete the infusion within ≤30 min" vs "run the infusion for ≥60 min"), so a possible single-quantity conflict was never compared. Propose-only: if the bounds constrain ONE quantity, run the suggested `symspec glossary add` to unify them so the LIA tier can prove any conflict. DEMOTES `verified`; never a verdict. |
| `FND_RELATIONAL_UNCHECKED` | info | formal | requirements under one shared trigger carry numeric bounds alongside unmatched (singleton) atoms — the shape where aggregate/conservation or cross-quantity relational conflicts hide. symspec's numeric tier is pairwise same-quantity only and does NOT attempt aggregate sums or cross-quantity arithmetic, so this reasoning was not attempted. DEMOTES `verified` so it never outruns what was compared; never a verdict. |
| `FND_REACHABILITY_VIOLATED` | error | formal | a REACHABLE state violates a declared constraint, and the evidence carries the counterexample trace naming which requirements fired, in order, to get there. Proven over ALL reachable states with no bound (Z3 Spacer), and proven in BOTH the strict and the framed configuration, so it is a genuine defect rather than an artifact of assuming nothing about unwritten variables. |
| `FND_REACHABILITY_PROVED` | info | formal | a declared constraint holds in EVERY reachable state, proven with no bound and with nothing assumed beyond the document (frame-closed). The evidence carries the inductive invariant the solver inferred, which was then INDEPENDENTLY re-checked by three plain-SMT obligations (Init implies Inv, Inv and the transition relation imply Inv-prime, Inv implies not-Bad) — so the claim does not rest on trusting the solver. Reported rather than left silent because a proof the tool performed and did not mention is a proof the reader cannot rely on. |
| `FND_REACHABILITY_UNDER_HYPOTHESES` | info | formal | a declared constraint holds only WHEN the declared frame assumptions are granted: it is reachable-violating with nothing assumed, and unreachable once the variables declared `frame: stable` are held fixed except where a requirement writes them. That is a proof given a hypothesis THE DOCUMENT DOES NOT STATE, so it DEMOTES `verified` and names the exact variables relied upon together with the requirements that write them. Never rendered as proven-unconditionally. |
| `FND_REACHABILITY_UNKNOWN` | info | formal | the solver did not decide whether a declared constraint can be violated, so nothing is claimed either way and `verified` is DEMOTED. The message states which of the two causes applies, because they need different remedies and the solver cannot be asked: a timed-out Spacer query reports its reason as the literal string "ok", so the distinction is derived out-of-band from measured elapsed time against the budget that was set. |
| `FND_REACHABILITY_NOT_CHECKED` | info | formal | the unbounded reachability tier did NOT cover part or all of this document, and `verified` is DEMOTED accordingly. Emitted when no state model is committed, when no requirement carries a constraint to check, when a classified requirement could not be read, or when the model admits no transitions at all (in which case only the initial state exists and any invariant over it holds almost vacuously). This is a coverage DISCLOSURE, not a defect: silence over a question that was never asked reads exactly like a pass, which is the one thing this tool must never do. |
| `FND_REACHABILITY_VACUOUS_INITIAL` | error | formal | the INITIAL STATE is UNSATISFIABLE: the model-wide `initial` predicate, the per-variable `initial` predicates, and the declared integer/enum ranges cannot all hold at once, so the model has NO initial state, the reachable-state set is EMPTY, and every constraint holds VACUOUSLY. Nothing is proven about anything and every constraint is DEMOTED. Error severity rather than a disclosure because a vacuous model does not merely fail to prove — it MASKS proven violations: measured, adding a contradictory initial predicate to a document with a genuine reachable violation turned an error-severity FND_REACHABILITY_VIOLATED into a confident "PROVED with nothing assumed" and flipped the exit code from 1 to 0. The independent certificate check cannot catch this, because an unsatisfiable Init makes `Inv := false` discharge all three obligations validly. |

## Lint rule codes (`GTWR_*`)

INCOSE Guide to Writing Requirements rules, all on the `lint` tier.

**Severity is decided PER FINDING, not per code.** The legitimate-exception rules
(R16/R26/R32/R35) downgrade contextually — an absolute qualified by a conditional clause is
`warn` where a bare one is `error`. Read each finding's own `severity` field.

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
