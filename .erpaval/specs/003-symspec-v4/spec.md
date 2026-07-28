# symspec v4 — EARS specification

**Session:** session-511b2b · **Date:** 2026-07-27 · **Status:** awaiting Gate 1 approval
**Baseline:** `b8ab474`, 1100 tests green, `pnpm check` exit 0, 38.4k LOC TS.

## Purpose

Close the gap between what symspec claims and what it proves, then extend the
proof surface to reachable state — using capabilities already installed. Every
AC below is traceable to a finding verified in this session (Explore + Research
+ orchestrator re-verification on the built CLI).

## Verified findings that drive this spec

Each was reproduced by the orchestrator against `dist/cli.mjs` or the installed
`z3-solver`, not accepted from an agent report. Two agent claims were **refuted**
by that re-verification and are recorded as such so they don't enter the plan.

| # | Finding | Status | Evidence |
|---|---|---|---|
| V1 | **Spacer/Fixedpoint is fully available in the shipped WASM** | ✅ verified | `ctx.Fixedpoint` + 31 `Z3_fixedpoint_*` entrypoints; `inv(1)`→`unsat` 284ms (proven unreachable, unbounded), `inv(2)`→`sat` 36ms (control); Spacer returned the inferred invariant. Unbounded reachability needs **zero new dependencies**. |
| V2 | **`certify` proves nothing** | ✅ verified | `docToTheorems` (`src/cli/index.ts:1244`) maps every requirement to `theorem req_<uuid> : True := by decide`. Live: `certify` returns `certified:true` on a spec `check` proves contradictory. |
| V3 | **stdout truncates to invalid JSON on pipes** | ✅ verified | 80-req doc: pipe = **65536 bytes exactly**, invalid JSON; file = 352036 bytes. `emit()` does `process.stdout.write` then `process.exit` (`src/cli/index.ts:153-161`). Breaks the primary agent integration path. |
| V4 | **Mixed-dimension numeric FALSE POSITIVE in a decide tier** | ✅ verified | `respond within 5` (unitless) vs `respond over 2000 ms` → `FND_NUMERIC_CONTRADICTION`, severity **error**, exit 1. 5s > 2s; no conflict exists. `quantityKey` omits `baseUnit`; grouping ignores unit compatibility. The propose-only tier *has* the guard the decide tier lacks. |
| V5 | **`--emit-smt2` / `--solver z3-bin` emit no context atoms** | ✅ verified | Artifact contains only guarded implications; external `z3` answers **`sat`** on the spec the in-process tier proves contradictory. `emitSmt2(encodeIncluded(doc))` never passes `contextAtoms`. |
| V6 | **F-under-G lowering is stronger than LTL** | ✅ verified (latent) | AST probe: `a@k ∧ ¬b@k` under `G(a→F b)` is **UNSAT** — `b` forced at the horizon. **Not currently exploitable**: CLI repro gave 0 findings at k=2..16 because `__trig__`/`__resp__` atom kinds never coincide. Becomes live the moment tiers share a namespace. |
| V7 | **R9 `etc.` and 5 dotted R38 abbreviations are dead lexicon entries** | ✅ verified | `"...warnings, etc."` → no findings; `approx. 50` → no R38 while bare-word `config` fires. Trailing `\b` after `.` never matches. |
| V8 | **R33 false-positives on exemplary prose; R7 misses canonical GtWR terms** | ✅ verified | "shall respond in 5 seconds" → `GTWR_R33_MISSING_TOLERANCE`; "approximately several records" → no findings. |
| V9 | **z3-solver is a major version behind** | ✅ verified | `package.json` pins `^4.16.0`; installed 4.16.0; npm latest **5.0.0**. A caret cannot cross the major. |
| V10 | **`verifies`/`refines` edges can be removed but never added** | ✅ verified | CLI exposes only `derive`/`satisfy` (`index.ts:750-767`); `apply` hardcodes the same two (`apply.ts:142-150`); `remove-edge` accepts all four. `analyze`'s `LeafUnverifiable` advice is uncarryable. |
| V11 | **Install: Kiro glob is JSON-only; `SKIPPED_HOSTS` is wrong** | ✅ verified | `fileMatchPattern: '**/{requirements,*.requirements}.json'` — real specs are markdown. opencode/gemini are skipped for "no dedicated rules dir" but both read `.agents/skills`, which symspec already writes. |
| R1 | ~~R1 `must` wrongly excludes from formal tier~~ | ❌ **refuted** | `"the system must issue a token"` produced **no R1 finding at all**. Coverage gap, not a wrongful exclusion. |
| R2 | ~~R15 punishes the defined `[A AND B]` convention~~ | ❌ **refuted** | `When [A AND B], ...` produced **no R15 finding**. The negative lookahead works. |

### Competitive reality (grounded, changes positioning)

- **AWS Kiro already ships EARS → SMT-LIB → minimal conflict set** (2026-05-12), by the Automated Reasoning checks authors. **VERIMED** (arXiv 2605.13817) and **RAG4C** landed within two weeks. The mechanism dates to Filipovikj et al., ACM SAC **2017**.
- What survives as genuine differentiation: **determinism** (Kiro's own blog concedes its formalization is non-deterministic and abstains above an entropy threshold); **whole-set multi-hop unsat cores** (competitors are pairwise or similarity-gated); **a checkable certificate**; **portability** (Kiro is IDE-GUI-only).
- **No competitor publishes per-rule precision/recall on a public corpus.** A labelled corpus now exists: **QuRE**, 2,111 Mercedes-Benz requirements, CC-BY-4.0, naive-dictionary floor F1 0.459, published target F1 0.799.
- **GtWR v4 = 42 rules** (INCOSE-TP-2010-006-04, June 2023). symspec implements 24.
- **NASA FRET ships a whole-set SMV consistency generator with its driver commented out** — the closest prior art left the set-level check disabled.

## Scope decisions (stated, not asked)

1. **Reachability rides Spacer, not Veil/Lean.** V1 makes unbounded reachability free. Veil 2.0 is multi-GB, unreleased-branch, no CLI/library API; Quint's `verify` is not exported from its npm types. Both are rejected as v4 dependencies.
2. **Lean stays, reduced to an honest role.** It cannot be the reachability engine, but it can emit a genuinely kernel-checked certificate. Requires `-E hasSorry` **plus** an axiom guard **plus** a `leanchecker` pass — verified to catch disjoint attack classes (in-file `set_option` defeats the flags; environment injection defeats the axiom guard).
3. **`baseline` is Houdini, not an LLM.** Candidates from cheap extractors, refutation only by the solver, unique order-independent fixpoint — this *is* propose/decide, already proved. InvBench shows LLM invariant synthesizers solve 0 where classical solvers solve 113/113 out of distribution.
4. **No new schema version without a migration path.** `SCHEMA_VERSION=2` today has none by design ("re-create, never migrate"); v4 adds attributes, so AC-1-5 is a prerequisite, not a follow-up.
5. **Second solver (cvc5-WASM) deferred.** Ships undocumented (5 lifetime downloads), heap leaks 16 MB→1311 MB over 200 solves, blocks the event loop, `--tlimit` unreliable, and its CI wasm job has no regression testers. Unfit as a soundness oracle.

---

## Wave 1 — Honesty repairs (blocking; ship before anything new)

These are correctness defects in shipped behavior. Everything else waits.

**AC-1-1 [P]** — Ubiquitous. The numeric tier shall group predicates by quantity **and** base unit, and shall never report `FND_NUMERIC_CONTRADICTION` across predicates whose units are dimensionally incomparable.
*Fixes V4. Files: `src/formal/numeric.ts:160-178`, `src/formal/numeric-contradiction.ts:59-73`. Mirror the guard the propose tier already has at `quantity-alias.ts:187`. Regression: the V4 reproducer must exit 0.*

**AC-1-2 [P]** — Unwanted behavior. If a command's output is written to a pipe, then the CLI shall emit the complete envelope before exiting.
*Fixes V3. Files: `src/cli/index.ts:138-161,1331-1332`. Replace `process.exit(n)` with `process.exitCode = n` and let the loop drain. Regression: 80-req `check --dense` byte-identical through pipe and file, and valid JSON.*

**AC-1-3 [P]** — Event-driven. When `check` runs with `--emit-smt2` or `--solver`, the emitted artifact shall carry the same per-context-group reachability assertions as the in-process tier, or the command shall refuse rather than emit a weaker question.
*Fixes V5. Files: `src/cli/index.ts:611,624`; loop `planContextGroups` per `contradiction.ts:141-152`. Regression: external z3 on the emitted artifact must agree with the in-process verdict on the V5 reproducer.*

**AC-1-4 [P]** — Unwanted behavior. If `certify` runs while the emitted Lean encodes no requirement semantics, then it shall not report `certified: true` and shall not describe itself as a proof about the document in `manifest`, `AGENTS.md`, or the finding message.
*Fixes V2. Rename the finding to name what actually held (toolchain elaboration), demote severity, and correct `src/cli/descriptions.ts:130-136` + `AGENTS.md:59,99`. This unblocks AC-4-1 replacing it with a real encoding.*

**AC-1-5** — Ubiquitous. The document loader shall migrate a prior-schema document forward, or shall report the exact ops that reproduce it.
*Prerequisite for Waves 2-4. Files: `src/core/load.ts:88-97`, `src/core/schema.ts:721`. Note tests at `integration.test.ts:263-264` and `changes.test.ts:319-326` currently assert `migrate` is absent — they encode the old decision and must be revised deliberately.*

**AC-1-6 [P]** — Ubiquitous. Every lexicon entry shall be reachable, proven by a per-entry firing test.
*Fixes V7. Files: `src/lint/gtwr.ts:550,1005-1015`. The fix already exists at `:236-238` for R6 and was never propagated. Add a table-driven test asserting each of the ~180 lexicon entries fires on a fixture.*

**AC-1-7 [P]** — Ubiquitous. The solver budget and timeout shall bound every solver-driving tier.
*Today only `contradiction.ts:249` and `needs-review.ts:172` set a timeout; subsumption (the O(N²) hot path), vacuity, incomplete, numeric, and temporal run unbounded. Measured: `--solver-budget-ms 2000` on a 100-req doc still took 74s.*

**AC-1-8 [P]** — Ubiquitous. `derive`, `satisfy`, `verify`, and `refine` shall each be creatable from the CLI and from `apply`.
*Fixes V10. Files: `src/cli/index.ts:750-767`, `src/cli/apply.ts:54,142-150`.*

**AC-1-9 [P]** — Ubiquitous. The dependency on `z3-solver` shall be upgraded to 5.x with the differential suite green, or the pin shall record why 4.x is retained.
*Fixes V9. Re-run the adversarial rounds and the V1 Spacer probe against 5.0.0 before adopting.*

---

## Wave 2 — Reachability (the headline capability)

Depends on: AC-1-1, AC-1-3, AC-1-7.

**AC-2-1** — Ubiquitous. The document shall represent a **state model**: declared state variables, an initial-state predicate, and per-requirement classification of the response as `effect` (changes state) or `constraint` (must hold).
*This is the actual blocker for reachability, not the solver. EARS `patternType` gives the guard shape, never whether the response mutates state. Follow the settled propose/decide pattern: an extractor **proposes** the classification, a doc-committed table **decides** it — extending "sound modulo atomization" to "sound modulo the committed state model." Depends on AC-1-5.*

**AC-2-2** — Event-driven. When a document carries a committed state model, `check` shall encode it as Horn clauses and use Z3's Spacer engine to decide reachability of each `constraint` violation over **all** reachable states, without a bound.
*Enabled by V1 — zero new dependencies. Files: new `src/formal/reachability.ts`; `ctx.Fixedpoint`, `fp.set('engine','spacer')`, `registerRelation`/`addRule`/`query`.*

**AC-2-3** — Event-driven. When Spacer proves a violation unreachable, `check` shall record the **inferred invariant** as evidence; when it proves reachability, `check` shall record the **counterexample trace**.
*Spacer returns both (verified in V1). `Evidence.witness` is declared at `src/formal/finding.ts:74-79` and populated nowhere — this fills it. Requires a new trace evidence member and renderer.*

**AC-2-4** — Unwanted behavior. If a document has no committed state model, or Spacer returns `unknown`, then `check` shall demote `verified` with the exact command that supplies what is missing, and shall never report reachability as proven.
*Preserves demotion-only. New demotion reasons join the eight at `src/pipeline/check.ts:251-275`.*

**AC-2-5** — Ubiquitous. A frame assumption shall be an explicit, disclosed, demotable choice, never an implicit encoder default.
*The one place unsoundness would enter: "state persists unless a response changes it" asserts something the document never said. Needs its own finding code in the loud-coverage tradition.*

**AC-2-6** — Ubiquitous. The `F`-under-`G` lowering shall not force the eventuality at the horizon.
*Fixes V6 before AC-2-7 makes it exploitable. Files: `src/formal/temporal.ts:81-86`. Either add lasso/loopback constraints or weaken the horizon instantiation; a bounded run must remain sound-for-UNSAT only.*

**AC-2-7** — Ubiquitous. The temporal and propositional tiers shall share one atomizer and one indexed formula AST.
*Six verified divergences behind a docstring claiming they line up (punctuation class, copula strip, antonym unification, de-inflection, glossary, a fourth `feat` kind). Consequence: `--temporal` is blind to every glossary/antonym commitment. Prerequisite for all reachability work; also lets `guard-implication.ts` and its 24-verb lexicon be deleted.*

**AC-2-8** — Ubiquitous. Any capability claiming to explore reachable state shall ship a committed feasibility gate with a latency budget that fails CI when exceeded.
*Reuse the AC-33-0 precedent at `scripts/temporal-feasibility.ts`.*

---

## Wave 3 — Repair, scale, and the agent loop

Depends on: Wave 1.

**AC-3-1** — Event-driven. When `check` proves a set unsatisfiable, it shall report the **minimum-cost repair** — which requirements to drop or weaken to restore consistency.
*MaxSMT verified working in the installed 4.16.0: weighted soft constraints returned `sat` and kept the high-weight requirements. "The solver tells you the cheapest fix" is the headline feature none of Kiro/VERIMED/RAG4C offers.*

**AC-3-2** — Event-driven. When multiple independent conflicts exist, `check` shall enumerate all minimal unsat cores, not one.
*Today one core is reported. MUS enumeration via hitting-set duality.*

**AC-3-3** — Ubiquitous. Every `coverage.demotions` entry shall carry a ready-to-run `ops[]` array executable by `apply`.
*Verified gap: 3 of 7 demotion reasons carry prose only; 3 more carry commands with placeholders (`<blocking-code>`) resolvable only by joining `demotions[].requirementIds` against `findings[]`. The loop's work list and its mutation lever are unconnected.*

**AC-3-4** — Ubiquitous. `check` shall report a monotone convergence metric so an agent can tell whether iteration is making progress.
*`verified` is boolean today; a 40-demotion spec gives no gradient.*

**AC-3-5** — Ubiquitous. `check` shall complete a 200-requirement document within a committed budget.
*Measured: N=10 → 2.7s, N=50 → 23.9s, N=100 → 79.2s, N=200 → killed at >8min. Clean O(N²) on two axes. Largest fixture in the repo is 10. Needs atom-index pair pruning (only pairs sharing an atom can subsume), solver reuse via push/pop, and a real global deadline.*

**AC-3-6 [P]** — Ubiquitous. The agent instruction surface shall teach how to author a sound spec, not only which commands exist.
*Both surfaces are ~85% reference tables. Absent: EARS pattern-selection procedure, vocabulary-alignment discipline *before* writing (so demotions never accumulate), a worked multi-requirement example, decomposition guidance for `derive`/`satisfy`, anti-patterns.*

**AC-3-7 [P]** — Ubiquitous. `install` shall match the file types specs actually use and shall not skip hosts it already serves.
*Fixes V11. Kiro glob is JSON-only; opencode/gemini read `.agents/skills`. Also: `--target auto` installs nothing in a repo with no host marker.*

**AC-3-8 [P]** — Ubiquitous. `explain <code>` shall return one code's full description without fetching the ~48 KB manifest.

**AC-3-9 [P]** — Ubiquitous. The `parse`/`add` compound-split field shall carry one name across both surfaces.
*`parse` emits `proposedSplits`; `add --from-parse` emits `proposedOps`; `tier3.ts:162`'s suggestion tells the agent to look for `proposedOps` on the `parse` path, where it does not exist.*

---

## Wave 4 — Proof, INCOSE depth, and measurement

Depends on: Waves 1-2.

**AC-4-1** — Event-driven. When `certify` runs, it shall emit a self-contained Lean file whose theorem is the **same claim** Z3 discharged, and shall bind it to a spec content hash.
*Replaces V2's tautology. Use `omega` for linear-arithmetic conflicts, `decide`/`decide_cbv` for propositional. Mathlib is avoidable. `emitLeanFile` already accepts `headerComment` (`emit.ts:50-53`) and the CLI never passes it.*

**AC-4-2** — Ubiquitous. The certificate gate shall reject a file that reaches its conclusion by any means other than a kernel-checked proof.
*Verified necessary: `-DwarningAsError=true` is defeatable by in-file `set_option`; `-E hasSorry` survives that; `warn.sorry false` defeats both flags but not an axiom guard; environment injection (`addDeclCore (doCheck := false)`) defeats the axiom guard but not `leanchecker`. Ship `lean --json -E hasSorry` + axiom guard + `leanchecker`. Emit module names without hyphens, and strip comments before any lexical prescan (a grep-based gate rejected its own valid certificate for documenting `sorryAx` in a header).*

**AC-4-3** — Ubiquitous. Backend disagreement shall be a finding that demotes `verified`.
*`binaryCrossCheck` is attached to the envelope and read by nothing — not findings, counts, `verified`, or the exit code. It is a cross-*report*, not a cross-*check*.*

**AC-4-4** — Ubiquitous. The three parser-decidable GtWR rules absent today (R11, R27, R28) shall be implemented.
*Decidable only from a clause-level parse — which symspec has and every regex competitor lacks. Turns the parser from an internal detail into the visible reason to choose symspec.*

**AC-4-5** — Ubiquitous. Set-level consistency shall include Z3 **entailment** redundancy (A implies B ⇒ B redundant), reported as a proposal, never a silent deletion.
*GtWR R30 / INCOSE C11. No commercial tool ships this tier.*

**AC-4-6** — Ubiquitous. The document shall carry INCOSE requirement **attributes** (rationale first), with deterministic validation.
*`GTWR_R20_PURPOSE` currently tells authors to "move rationale to separate attribute" — a field that does not exist. GtWR specifies a requirement as statement **+** attributes; symspec validates half the artifact. Depends on AC-1-5.*

**AC-4-7** — Ubiquitous. Set-level unit-system homogeneity (C11.3) shall be checked.
*Zero implementation today; mechanical root is the un-actioned `TODO(coordination)` at `src/cli/manifest.ts:565-569` — the lint unit allowlist and the formal `DIMENSIONS` table were never reconciled.*

**AC-4-8** — Ubiquitous. A `characteristicsNotAssessed` disclosure shall report which INCOSE characteristics and GtWR rules were not checked.
*The repo's signature move is loud disclosure of what wasn't checked — applied to coverage, absent for lint. 18 of 42 rules unimplemented and 8 of 15 characteristics unassessed are currently silent.*

**AC-4-9** — Ubiquitous. `symspec eval` shall report per-rule precision and recall against a public labelled corpus.
*QuRE: 2,111 Mercedes-Benz requirements, CC-BY-4.0, naive floor F1 0.459, target F1 0.799. Nobody in this field publishes this. Directly addresses the verified R33 false-positive and R7 gap (V8), which today have no measured cost.*

**AC-4-10** — Ubiquitous. The adversarial harness shall measure false positives and shall not encode "cannot be proven" as a permanent assertion.
*Today the oracle is the fixture label written by the same author; a detector firing on everything passes the whole suite. Abstention rounds assert `FND_CONTRADICTION` has length 0, which forbids a future improvement from proving them.*

---

## Wave 5 — Spec baseline from code (the bonus goal)

Depends on: Waves 1-3. Independently shippable; lowest confidence, highest novelty.

**AC-5-1** — Ubiquitous. `symspec baseline <path>` shall extract candidate EARS requirements from TypeScript sources with per-candidate provenance (`file:line`, extractor, confidence).

**AC-5-2** — Ubiquitous. Every extracted candidate shall be marked `derived-from-code`, distinct from authored requirements, and shall never be admitted to the decide tier on extraction alone.

**AC-5-3** — Event-driven. When candidates are extracted, `baseline` shall run the **Houdini** loop: propose cheaply, and remove a candidate only when a sound checker refutes it.
*Unique, order-independent fixpoint — the determinism rule, already proved (Flanagan & Leino, FME 2001). Calibration: a fixed-grammar proposer over ordinary suites scored 96% precision / 91% recall when judged by a sound checker.*

**AC-5-4** — Event-driven. When an extracted requirement contradicts an authored one, `check` shall report it as a proven conflict naming both.
*This is the bug-finding story. Precedent: Perracotta found unknown Windows Vista kernel bugs exactly this way — mine unsoundly, verify soundly, and the *disagreement* is the bug. AGORA+ found 32 real bugs in both directions (code bugs **and** doc bugs).*

**AC-5-5** — Ubiquitous. Extraction shall not execute project code without explicit consent.
*XState extraction imports user modules; needs an `--allow-import` flag.*

**AC-5-6** — Ubiquitous. Candidate strength shall be scored by a mechanism the proposer does not control.
*Reward hacking is the documented central failure mode: AlphaVerus models "game the system by generating trivial or incomplete specifications"; DafnyBench had to ban `{:verify false}`. "Correct" ≠ "strong" — any universally true condition verifies. ~20% of hardware specs pass vacuously on first run.*

---

## Explicit non-goals

- **Veil v2 / Quint / Apalache / nuXmv as dependencies.** V1 removes the need; licensing (nuXmv forbids redistribution and binds *users*; Alloy 6 unbounded needs it), install weight, and unreleased branches make them net-negative.
- **cvc5 as a second solver in v4.** Deferred with measured reasons (see Scope 5).
- **LLM-generated requirements or invariants inside the tool.** InvBench: LLM invariant synthesizers solve 0 where classical solvers solve all. LLM-as-judge has TNR <25% — it cannot refute, the only direction that would help.
- **Quantifiers over unbounded entity sets.** Finite instantiation only; genuine `ForAll` over uninterpreted sorts makes `unknown` common, contradicting the determinism contract.
- **Superlative marketing claims.** The README carries none today and must not acquire any: Kiro, VERIMED, and RAG4C all ship EARS→SMT, and the mechanism is from 2017.

## Dependency graph

```
Wave 1 (AC-1-1 … AC-1-9)  ── all [P] except AC-1-5
   ├─► Wave 2  (needs AC-1-1, AC-1-3, AC-1-7; AC-2-1 needs AC-1-5)
   │      AC-2-7 ──► AC-2-6 ──► AC-2-1 ──► AC-2-2 ──► AC-2-3, AC-2-4, AC-2-5, AC-2-8
   ├─► Wave 3  (needs Wave 1; AC-3-5 pairs with AC-1-7)
   └─► Wave 4  (AC-4-1/4-2 need AC-1-4; AC-4-6 needs AC-1-5)
          └─► Wave 5 (needs Waves 1-3)
```

## Gates

`pnpm check` (biome + tsc + vitest + knip) exit 0, plus `pnpm gen:agents` after any
description/manifest change. Each verified finding V1-V11 becomes a named
regression test. The two refuted claims R1/R2 are recorded here so they are not
"fixed" into a false behavior.
