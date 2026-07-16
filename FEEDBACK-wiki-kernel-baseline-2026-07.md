# symspec feedback — driving it to spec a real codebase (wiki-kernel, 2026-07)

Field report from an agent that used symspec end-to-end to author a **baseline
requirements spec of an existing Python codebase** (wiki-kernel: a FastMCP service
with three state machines) and to hunt for **state-transition logic errors**. 56
requirements, `check --semantic --temporal`, Z3 + Lean, one genuine contradiction
found. This is what was hard and what was missing — written to make the tool better,
not to complain. Concrete repro over vibes.

## TL;DR

symspec is genuinely good at the thing it claims: the SMT tier found a real
code-vs-intent contradiction with a machine-checkable atom table, and the manifest
is an excellent agent-facing contract. The friction was **not** the solver — it was
(1) a silent, high-impact interaction between the GtWR lint gate and formal
coverage, (2) the atomizer needing hand-holding (antonyms, phrasing) to see
oppositions that were obvious in prose, and (3) small CLI ergonomics that cost
round-trips. None are fundamental; all are fixable.

---

## What worked well (keep these)

1. **`symspec manifest` is the right primitive.** One JSON blob with every command,
   arg schema, and the closed code catalogs (`ERR_*`/`GTWR_*`/`FND_*`) meant I could
   branch on codes deterministically without scraping help text. This is the single
   best agent-ergonomics decision in the tool. More tools should ship this.
2. **The atom table / unsat core as evidence.** When `FND_CONTRADICTION` fired, the
   `evidence.atomTable` showed exactly which slots collapsed to which atom at which
   polarity. That turned "the tool says there's a conflict" into "here is the proof I
   can audit against the code." Load-bearing for trust.
3. **The honesty of "sound modulo atomization."** The SKILL.md and manifest are
   explicit that silence ≠ consistency. I relied on that framing when reporting
   results — it kept me from over-claiming a clean check as a correctness proof.
4. **`apply` with a JSONL batch + stable keys.** Authoring 50+ requirements in one
   file with `key`-referenced edges was far better than 50 `add` round-trips.

---

## What was hard / lacking (ranked by impact)

### 1. The GtWR lint gate silently excludes requirements from the formal tier

**This was the single biggest trap.** My first `check --semantic --temporal` reported
`pairsChecked: 3` and zero contradictions — which *looks* like "spec is consistent."
It wasn't; it was nearly vacuous. Buried in `residualRisk` was
`excludedRequirements: 9` with reason `blocking-surface-check`: nine requirements —
including the entire retention score-band state machine, the exact cluster I most
wanted analyzed — were **excluded from formal encoding** because they tripped
error-severity GtWR lint (`GTWR_R6_MISSING_UNITS` on dimensionless scores like `0.3`,
`0.7`, the RRF constant `60`; `GTWR_R26_ABSOLUTE` on "every page"; `GTWR_R7_VAGUE` on
"near-duplicate").

The problem: **a style-lint finding silently removes a requirement from the
soundness-relevant analysis, and the headline result doesn't shout about it.** An
agent (or human) skimming "0 contradictions, verified: true" would conclude the spec
is clean when a third of it was never checked. This is a false-confidence generator.

Asks, in priority order:
- **Surface excluded-from-formal as a first-class, loud signal**, not a field inside
  `residualRisk`. Consider a dedicated `FND_EXCLUDED_FROM_FORMAL` info/warn finding per
  excluded requirement, or a top-level `coverage: {encoded: N, excluded: M}` that
  `--strict` gates on. "verified: true" with 9 excluded should not be reportable as
  clean without a prominent caveat.
- **Reconsider whether R6 (missing units) should be `error` severity and thus
  formal-blocking.** Scores in [0,1], cosine thresholds, fusion constants, and version
  increments are legitimately dimensionless. Forcing "0.7" → "0.7 <unit>" to unblock
  formal encoding is either a distortion or a waiver dance (see below). At minimum,
  a dimensionless/ratio escape hatch (a recognized "ratio" or "score" unit, or a
  per-doc "these quantities are dimensionless" declaration) would help.

### 2. `waive` suppresses the finding but does NOT restore formal coverage

Natural first fix for #1: `waive add GTWR_R6_MISSING_UNITS --reason "…"`. It cleared
the finding from the report — but the requirement was **still excluded from formal
encoding** (`excludedRequirements` stayed at 9). So a waiver hides the symptom
(the lint finding) while leaving the disease (no formal analysis of that requirement)
untouched, and now *more* invisibly than before, because the finding that flagged the
exclusion is gone.

This is arguably a correctness bug in the waiver semantics, or at least a sharp
surprise. If a finding is what blocks formal encoding, waiving it should either
(a) also re-admit the requirement to the formal tier, or (b) explicitly refuse and
tell the user "waiving this suppresses the report line but the requirement stays
formally excluded; rephrase instead." Right now it does neither — it just quietly
does the less-useful half. I ended up abandoning waivers and **rephrasing** every
numeric requirement to named thresholds ("above the keep threshold" instead of
"above 0.7"), which got `excludedRequirements` to 0. That worked, but it was
trial-and-error and it moved real information (the actual numbers) out of the spec.

Ask: document the waiver-vs-exclusion interaction prominently, and ideally make
`waive` on a formal-blocking code re-admit the requirement or refuse with guidance.

### 3. The atomizer needs manual hand-holding to see oppositions

To make a genuine code-vs-intent contradiction provable, I had to state both the
intended invariant and the as-built behavior on a **shared system + trigger**, and
then **register an antonym** (`serialize`/`overlap`, `run`/`skip`) before the SMT tier
would treat the two responses as polar. My first attempt phrased the responses
naturally ("run the next cycle without skipping it" vs "skip the next cycle") and got
only `FND_SIMILAR_SEMANTIC` — the tool saw them as *similar*, not *opposed*. I had to
strip the responses down to a shared object phrase differing only on the verb head
(`run the next workspace curation cycle` vs `skip the next workspace curation cycle`)
for `FND_OPPOSITION_CANDIDATE` → `FND_CONTRADICTION` to fire.

This is inherent to near-exact atomization, and the SKILL.md is honest that
paraphrases become distinct atoms. But the ergonomic cost is real:
- **The semantic tier already computed a high cosine between the two responses.** When
  two same-system/same-trigger responses embed as highly similar but resolve to
  distinct atoms, that is exactly the case where the tool could *suggest* "these may
  be an unmodeled opposition — is `run`/`skip` an antonym pair? add one with
  `antonym add run skip`." The `FND_SIMILAR_SEMANTIC`/`FND_OPPOSITION_CANDIDATE`
  findings are close, but they didn't hand me the antonym-registration next step.
- **Discovering that antonyms were the mechanism at all took reading the full FND_
  catalog and inferring it.** A worked example in the docs — "how to make a
  code-vs-intent conflict provable: state both sides, share the trigger, register the
  antonym" — would have saved a dozen round-trips. This is a *primary* use case
  (specs exist to catch where the build diverges from intent) and it's currently
  folklore.

### 4. CLI ergonomics that cost round-trips

Small, but they add up for an agent:
- **`waive`/`derive`/`delete` positional-vs-option arg confusion.** `waive add <CODE>
  <REASON>` takes code/reason positionally but the doc path is `--file`; I passed the
  path positionally (habit from `check <file>`) and got `ERR_USAGE: too many
  arguments`. The resolution precedence (positional > `SYMSPEC_DOC` > default) differs
  across commands in ways that aren't obvious. Either make it uniform, or have the
  usage error name the offending arg ("got 3 positional, expected 2; did you mean
  --file?").
- **`apply` delete op uses `ref`, add/update use `id`/`ref` inconsistently.** My
  delete ops used `{"op":"delete","id":...}` (mirroring the `delete` command's `id`
  arg) and `apply` rejected them: delete-in-batch wants `ref`. The single-command
  `delete` takes `id`; the batch op takes `ref`. Same operation, two arg names,
  depending on whether it's standalone or batched. Pick one.
- **`waive list` / `antonym list` positional collision.** `symspec waive list <path>`
  errored with "too many arguments for 'list'" because `list` takes 0 positionals and
  the path had to be `--file` or `SYMSPEC_DOC`. Fine once you know it, but the error
  didn't say "list takes no positional; the document goes in --file/SYMSPEC_DOC."
- **`--dense` still emitted enough that I piped everything through `python -c json`.**
  For an agent, a `--field pairsChecked,counts,excluded` projection (jq-style) on the
  envelope would beat parsing the whole blob every call. Minor.

### 5. Formal coverage is low for a spec of disjoint transitions — and that's not surfaced as *expected*

Even after getting `excludedRequirements: 0`, `pairsChecked` stayed at 5 out of ~1500
possible pairs, with 96 "unmatched atoms." This is *correct* — requirements describing
disjoint transitions across different systems share no atom group, so there's nothing
to compare — but it reads alarmingly like "the tool barely looked." A one-line
interpretation in the report ("N requirements formed K comparable groups; singletons
are not a coverage gap, they have no same-context peer to conflict with") would stop
users from misreading low `pairsChecked` as a failure. Right now I had to reason my
way to that conclusion to trust the result.

---

## Concrete "if I could change three things"

1. **Make formal exclusion loud.** A `coverage` block in every `check` envelope +
   a per-requirement `FND_EXCLUDED_FROM_FORMAL`, and make `verified: true` require
   zero silent exclusions (or downgrade it to `verified: partial`). This is the
   false-confidence fix and it matters most.
2. **Fix waiver-vs-exclusion.** Waiving a formal-blocking finding should re-admit the
   requirement to the solver or refuse with guidance — never silently suppress only
   the report line.
3. **Ship the code-vs-intent recipe as a first-class doc + a suggestion.** When two
   same-context responses embed similar but don't unify, suggest the antonym
   registration inline. Document "state both sides + register the antonym" as *the*
   way to make a build-vs-spec divergence provable.

## What I'd tell the next agent driving symspec

- Run `manifest` first (the docs say so; they're right).
- After `check`, **read `residualRisk.excludedRequirements` before believing a clean
  result.** Zero contradictions with N>0 exclusions is not a clean spec.
- Bare numbers trip formal-blocking lint. Use named thresholds ("the keep threshold")
  in requirement prose and pin the numeric value in a `verificationNote`, not the
  `systemResponse`.
- To prove a code-vs-intent bug: one system, one trigger, two responses that differ
  only on a verb head, plus `antonym add <a> <b>`. Then the SMT tier gives you a real
  contradiction with an atom-table proof.
- Low `pairsChecked` on a spec of unrelated transitions is expected, not a failure.

_— filed against symspec 0.1.0 (z3-wasm 4.16, z3 binary 4.16, Lean 4.31), from a
wiki-kernel baseline-spec session._
