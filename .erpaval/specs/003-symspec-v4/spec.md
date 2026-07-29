# symspec v4 — EARS specification

**Session:** session-511b2b · **Date:** 2026-07-27, revised 2026-07-29
**Status:** Wave 1 shipped (`169af27`, less AC-1-5/AC-1-9) · Wave 2 in progress
**Baseline at plan time:** `b8ab474`, 1100 tests green, `pnpm check` exit 0, 38.4k LOC TS.
**Baseline at Wave 2 start (re-verified on the built CLI):** `4c8d005`, **1186 tests
green**, adversarial **15/15**, `biome`/`tsc`/`knip`/`check:agents` all clean.

> **Revision note (2026-07-29).** Wave 2's Explore + Research pass re-verified every
> load-bearing claim on the built CLI and the installed solver before planning. That
> added findings **V12-V20** and refuted **three** items — R3 (deleting
> `guard-implication.ts`), R4 (AC-1-5 as an AC-2-1 prerequisite), and R5 (invariant-text
> instability, recorded as unverified rather than either way). Two dependency-graph
> edges were corrected as a result, and AC-2-5 was decided by the user. Per the Wave 1
> discipline, refuted claims are recorded here so a future session does not "fix" them
> into false behavior.

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

### Wave 2 additions to the findings table (session 2026-07-29)

Same discipline: each reproduced by the orchestrator, not accepted from an agent
report. Evidence lives in `.erpaval/sessions/session-511b2b/probes/`.

| # | Finding | Status | Evidence |
|---|---|---|---|
| V12 | **Only the `Fixedpoint` API can carry reachability; the `(set-logic HORN)` idiom cannot** | ✅ verified | Plain solver + `(set-logic HORN)` returns **`unknown`** (`reason="timeout"`) on the SAFE system even at 5000ms — it cannot infer `x >= 0`, the whole point of the tier. It answers only on the UNSAFE case. `probes/horn-polarity-probe.mjs`. |
| V13 | **Verdict polarity is INVERTED between Z3's two Horn interfaces** | ✅ verified | Same engine, same system: muZ `fixedpoint_query` → SAFE=`unsat`, UNSAFE=`sat`. Plain solver HORN → UNSAFE=`unsat`. Reading `unsat` as "safe" under the wrong interface **reports a reachable violation as proven safe**. Needs a polarity canary test + one lbool→verdict chokepoint. |
| V14 | **`rlimit` and `global_param_set('timeout')` HANG the WASM; only `params timeout` bounds a Spacer query** | ✅ verified | `rlimit` and the global route both ran >60s unkillable from JS (no `Promise.race`/abort escape). `params_set_uint(…,'timeout',ms)` is monotone and clock-accurate: 200/400/800/1600/3200ms → 203/404/803/1603/3203ms elapsed. Floor ~150ms from one-time WASM/parse cost. `probes/spacer-timeout-monotone.mjs`. |
| V15 | **A timed-out Spacer query is indistinguishable in-band from a genuine `unknown`** | ✅ verified | `reason_unknown` returns the string **`"ok"`** for a timed-out query, not `"timeout"`. Root cause found in Z3 source: `context::cleanup()` resets `m_last_status = OK` before every fixedpoint query returns. AC-2-4 must derive the distinction out-of-band from measured elapsed vs the timeout set, and must never surface `"ok"` to a user. |
| V16 | **The frame assumption converts a true "reachable" into a false "proven", certified by an inductive invariant** | ✅ verified | 3-variable model, `alarm` written by no requirement: `frame=stable` → **UNREACHABLE (proven, with invariant)**; `frame=strict` → **REACHABLE**. `alarm` is genuinely reachable. `probes/sanity-spacer-probe.mjs`. This is AC-2-5's unsoundness, executable. |
| V17 | **V6 extends to `X` and `U`, not only `F`** | ✅ verified | `G(a→X b) ∧ a@k` → `unsat` at k=2,5. `G(a→(p U q)) ∧ a@k ∧ ¬q@k` → `unsat` at k=2,5. Both LTL-satisfiable. `X` at the horizon lowers to literal `false`; `U` collapses to `ψ@k`. `lowerAt` is a public export (`src/index.ts:143`). |
| V18 | **A 3-requirement all-EARS false positive exists today at error severity** | ✅ verified | `G(a→F b)`, `G(a→¬b)`, `G(b→F a)` → `unsat` at k=2,4,8,12; LTL-satisfiable via the period-2 lasso `{a,¬b}→{¬a,b}↺`. Exhaustive sweep: 4 FP / 220 3-subsets (2-atom), 2 FP / 455 (3-atom). ~98% precise, but the 2% are error severity, exit 1. |
| V19 | **`scripts/temporal-feasibility.ts` gates nothing** | ✅ verified | Referenced nowhere in `package.json`, `lefthook.yml`, or `.github/`; only `knip.json:4` type-checks it. Also `check:agents` is a pre-push hook only (`lefthook.yml:24`), so it is **not in GitHub CI** either. |
| V20 | **`README.md:182` claims the propositional tier "composes every reachable state transition"** | ✅ verified | It composes guarded implications over context groups within a single state; no transition relation exists. Same class as V2. |
| V23 | **Four residual V2-class `certify` overclaims survived Wave 1 — in the README only** | ✅ verified | AC-1-4 fixed the *code*: `certify` on a spec `check` proves contradictory returns `certified:false`, `encodesRequirementSemantics:false`, and an honest message. But the README still promised "a re-checkable proof artifact for the whole spec", "re-checked in Lean 4", "`certify` kernel-checked the whole thing in Lean", and a glossary entry offering independent re-verification. Wave 1 corrected `descriptions.ts` + `AGENTS.md` and missed the README. Fixed in Wave 2. |
| V24 | **The README's quick-start `check` output showed a FABRICATED finding message** | ✅ verified | Claimed `"…on the same trigger, one grants access and the other revokes it."` — that string exists **nowhere in `src/`** (grep clean). Real output: `"…their responses resolve to the same atom with opposite polarity under a reachable context."` The `evidence` placeholder was also vague where the real keys are exactly `atomTable` and `core`. A worked example that cannot be reproduced is the same defect class as a false capability claim. |
| V25 | **"No false alarms" was stronger than the tool's own disclosure** | ✅ verified | The README asserted "a fabricated contradiction is the one error the tool is built never to make", while the shipped manifest's `scope.overUnification` names over-unification as "the one false-positive risk". Demonstrated live: `a session is active` and `the session is active` both normalize to `sys__router__pre__session_active` and yield an error-severity `FND_CONTRADICTION`; genuinely distinct guards (`the primary session` vs `the backup session`) correctly do not collapse. |
| V26 | **"20 commands" was stale** | ✅ verified | Built manifest reports **22** — Wave 1's AC-1-8 added `verify` and `refine`. Code counts re-verified correct and unchanged: 21 error + 24 lint + 30 finding = 75. |
| V30 | **Test files are never type-checked — 137 type errors hide behind the gate** | ✅ verified (pre-existing) | `tsconfig.json` excludes `**/__tests__/**` and `**/*.test.ts`, and `pnpm check` runs `tsc --noEmit` against that config, so no gate has ever type-checked a test. vitest transpiles without checking. Audited with an identical-options config widened only in `include`: **137 at committed HEAD `22e0a04`**, 147 in the working tree (in-flight AC-2-7 adds ~7). Concentrated in `add.test.ts` (36), `add-wishlist.test.ts` (17), `update.test.ts` (16), `apply.test.ts` (11). Dominant pattern: `exactOptionalPropertyTypes` vs `Partial<T>` fixture spreads. Same class as V19 — a gate that does not gate — but **not urgent**: no runtime failure, and fixing it touches ~15 files three agents are concurrently editing. Deferred to its own change with a recorded baseline that can only go down. Detail: `.erpaval/sessions/session-511b2b/V30-tests-are-not-typechecked.md`. |
| V27 | **An unrecognized top-level document field is SILENTLY DROPPED by any mutation** | ✅ verified | `RequirementsDocSchema` (`schema.ts:446-447`) is a plain `z.object` — Zod's default **strip** mode — and every mutation round-trips through `safeParse` and writes back the stripped result. Measured: a doc carrying `stateModel` loads and checks fine, but after one `symspec add` the key is **gone**, with no error, warning, or finding. No test covers unknown-field fidelity. Consequence for AC-2-1: forward compatibility is **read-only** — an older binary mutating a doc destroys a committed state model, and because AC-2-2's proof is *conditional on* that model, the next `check` silently falls back to "no state model" and demotes with the cause invisible. Recommendation: detect unrecognized top-level keys on load and **disclose** them (info finding), not `.passthrough()` (would round-trip unvalidated data) and not `.strict()` (would break the forward-read compatibility that works today). Detail: `.erpaval/sessions/session-511b2b/AC-2-1-groundwork.md`. |
| R3 | ~~AC-2-7 lets `guard-implication.ts` be deleted~~ | ❌ **refuted** | `guard-implication.ts:268` emits `implies(atom(r.id), implies(and(contextLits), stateLiteral))` — a **new formula over the requirement set** — plus an inert-implication guard needing other requirements' guard atoms (`:259-261`). A pure `slot → atom` atomizer (`atomize.ts:14-18`) structurally cannot subsume this. 24 verbs confirmed. **AC-2-1/2-2's state model is what subsumes it; keep the file in Wave 2.** |
| R4 | ~~AC-1-5 requires a document migration path~~ | ❌ **refuted** | v1 on disk was a **binary Automerge blob**, not JSON (`git show cbdf631:src/core/doc.ts:39-40`); `df0efdc` flipped 1→2 and moved to JSON in one commit. A v1 file dies at `ERR_DOC_PARSE` before the version check, which runs only after `safeParse` succeeds. Nothing to migrate; the AC's second disjunct is the real one. **AC-2-1 is therefore NOT blocked by AC-1-5** — new doc fields ride `.default()` with no version bump, as `glossary`/`waivers`/`antonyms` all did at v2. |
| R6 | ~~Unifying the atomizer makes V6 exploitable (a `resp` atom can equal a `pre`/`trig` atom)~~ | ❌ **refuted** | A **structural kind barrier** exists: `renderAtom` emits `sys__<scope>__<kind>__<body>` and the propositional punctuation class collapses punctuation **runs**, so an atom body can never contain `__`. Orchestrator-verified by adversarial construction on the shipped atomizer — 11 attempts (leading `__`, embedded `x__pre__y`, `--`, `..`, `/`, single `_`, triple `___`, and a fully forged `sys__auth__pre__x`) all collapsed to a single `_`: **0 bodies containing `__`, 0 cross-kind collisions** on identical text across `trig`/`pre`/`resp`/`feat`. Agent's independent evidence: 1169 EARS-path triples with **0 legacy-only-unsat** — the 56 such cases `v6-strict-relaxation` finds by building formulas *directly* are unreachable through the EARS path precisely because of this barrier. **AC-2-6-before-AC-2-7 was still the correct call** (V18 was real via `lowerAt`, a public export, and the sequencing was right under the information available), but the two ACs are less coupled than the plan recorded. Recorded so a future session does not re-derive the stronger claim as fact. |
| R5 | ~~Spacer invariant text is unstable under context reuse~~ | ⚠️ **unverified** | Could not reproduce across 8 iterations on a shared context, with decoy queries interleaved, on the reported `(or A (not B))` shape. Recorded as an open risk, not a fact. Mitigation adopted regardless: canonicalize evidence, prefer a fresh context per reachability run, and independently re-check the invariant (`Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, `Inv ⇒ ¬Bad`) so invariant *text* is never load-bearing. |
| V21 | **An UNDECLARED param silently voids the timeout, producing an unkillable hang** | ✅ verified | Identical params object plus `random_seed=42` (undeclared on Fixedpoint): `timeout=1500` alone → 1621ms `unknown`; with the extra key → **hangs past 45s**, no JS-side recovery. No throw at `params_set_uint` or `fixedpoint_set_params`. Reproduced on **both** 4.16.0 and 5.0.0. **`research-spacer-api.md`'s own "Recommended configuration" block prescribes `random_seed` and is therefore unsafe as written.** Set only declared params (enumerate via `fixedpoint_get_param_descrs`), and ship a bounded canary query that fails closed if the params object is dead. Seeds buy nothing: `0/1/42/12345` give an identical answer hash. `probes/RESULTS-param-poisoning.md`. |
| V22 | **z3-solver 5.0.0 adopted; `rlimit` is enforced per query, monotone, and deterministic** | ✅ verified | Pin `^4.16.0` → `^5.0.0`, **zero source changes**. At HEAD in an isolated worktree: 1186 tests, adversarial 15/15, all gates exit 0 — identical to the 4.16.0 baseline. Polarity probe **byte-identical** (orchestrator re-ran it on 5.0.0). Timeout band still monotone. `rlimit` now declared (119→120 params) and enforced **per query** — the cumulative counter is not the budget: per-query delta was exactly 1023 at every position in a shared context, 8/8 positions decided, so the feared position-dependent starvation **does not occur**. Deterministic where wall-clock is not: `timeout=200ms` gave 5 distinct consumed counts per process (60-75% variance); `rlimit` gave 1, with md5-identical canaries across 3 processes. WASM +921,757 B (+2.73%, 32.1→33.0 MiB), no new transitive deps. |

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

> **DONE in Wave 2 (V22). Upgraded to `^5.0.0`, zero source changes.** Validated at
> HEAD in an isolated worktree to keep parallel in-flight edits out of the
> comparison: 1186 tests, adversarial 15/15, all gates exit 0 — identical to the
> 4.16.0 baseline. Every Spacer probe re-run and diffed; the polarity probe is
> byte-identical (orchestrator re-verified independently), and the timeout band is
> still monotone. The reason to upgrade is **determinism**: `rlimit` is now a
> declared, enforced, per-query budget, and this repo's contract requires the same
> input to give the same verdict on any machine — wall-clock `timeout` cannot.
> The nominal major is a renamed 4.17.0 (`z3_fixedpoint.h` byte-identical between
> tags). The 12-day age does not change the recommendation, partly because open
> Spacer regression #10237 bisects to a commit *after* the 5.0.0 tag, so waiting
> for 5.0.1 could import it. Every future bump must re-run the polarity probe and
> the rlimit enforcement driver.

---

## Wave 2 — Reachability (the headline capability)

Depends on: AC-1-1, AC-1-3, AC-1-7. **Not** AC-1-5 (see R4).

> **Sequencing correction (verified 2026-07-29).** The dependency graph below
> originally read `AC-2-7 ──► AC-2-6`. That ordering is **backwards and would ship
> a false-positive generator**: V6/V17/V18 are live only because atom namespaces
> never coincide, and AC-2-7 unifies exactly those namespaces. **AC-2-6 lands
> first.** The adversarial suite cannot catch a V6-induced false positive
> (`eval-rounds.test.ts:88-93` asserts abstention rounds have zero
> `FND_CONTRADICTION`; a *temporal* false positive passes that assertion while
> being wrong), so AC-2-6 ships with its own targeted regression test.

**AC-2-1** — Ubiquitous. The document shall represent a **state model**: declared state variables, an initial-state predicate, and per-requirement classification of the response as `effect` (changes state) or `constraint` (must hold).
*This is the actual blocker for reachability, not the solver. EARS `patternType` gives the guard shape, never whether the response mutates state. Follow the settled propose/decide pattern: an extractor **proposes** the classification, a doc-committed table **decides** it — extending "sound modulo atomization" to "sound modulo the committed state model." ~~Depends on AC-1-5.~~ **Does not depend on AC-1-5 — see R4.***

> **Extension points, verified 2026-07-29.** New doc fields ride `.default([])` and
> need **no `SCHEMA_VERSION` bump** — `glossary`, `waivers`, and `antonyms` all
> landed at v2 exactly this way. Confirmed on the built CLI: a fresh `init` doc is
> `{antonyms: [], glossary: [], requirements: {}, schemaVersion: 2, waivers: []}`.
>
> **Two tables, not one.** Document-scoped (declared state variables, initial-state
> predicate, per-variable `frame` from AC-2-5) → a new `stateModel` field plus its own
> top-level command and its own envelope `type`; the types-enum test asserts exact
> set equality, so it cannot ride under an existing `type` — the same constraint that
> made `antonym` a peer of `glossary` rather than a subcommand. Requirement-scoped
> (the `effect`/`constraint` label) → copy the **`verificationMethod`** closed-enum
> chain, which needs no manifest or types-enum edit because it flows through
> `RequirementCreateInputShape` and `argumentsSchemaOf` automatically.
>
> **A state model is an antonym-class hazard, not a glossary-class one**, so it needs
> **write-time validation** (mirror `src/cli/glossary.ts:191-202`, which validates in
> a try/catch and returns `ERR_USAGE`, keeping the `check` path throw-free). Rationale:
> a wrong glossary entry only *masks* a conflict, whereas a wrong `effect`/`constraint`
> label makes Spacer prove or refute the wrong thing — the antonym asymmetry exactly.
>
> **Propose/decide**: the per-requirement field is the *decided* value. The proposal
> is an info-severity `FND_` code naming the exact discharging command, listed in
> `PROPOSE_ONLY_FND_CODES`, plus a demotion reason so an untriaged classification
> **demotes** `verified` and never promotes it.
>
> Thread the new table at **both** `check.ts:620` (`encodeIncluded`, which feeds
> `--emit-smt2`) and `:807` (the main closure) — missing one is a recorded prior bug.

**AC-2-2** — Event-driven. When a document carries a committed state model, `check` shall encode it as Horn clauses and use Z3's Spacer engine to decide reachability of each `constraint` violation over **all** reachable states, without a bound.
*Enabled by V1 — zero new dependencies. Files: new `src/formal/reachability.ts`; `ctx.Fixedpoint`, `fp.set('engine','spacer')`, `registerRelation`/`addRule`/`query`.*

> **Implementation constraints, all orchestrator-measured 2026-07-29.**
>
> 1. **Interface A only.** Use the typed `ctx.Fixedpoint` (a real constructible
>    class: `registerRelation`/`addRule`/`query`/`getAnswer`/`getReasonUnknown`/
>    `getNumLevels`/`getCoverDelta`, with refcounting and an internal mutex that
>    serializes concurrent `query()`). **Never** `solver_from_string` with
>    `(set-logic HORN)` — per V12 it returns `unknown` on exactly the systems this
>    tier must prove.
> 2. **Polarity canary is mandatory** (V13). `sat` = reachable/violated,
>    `unsat` = proven unreachable, `0` = unknown. Map lbool→verdict at **one named
>    chokepoint**, and ship two fixtures (one provably safe, one provably reachable)
>    asserting the *named* verdict, not the raw lbool. This is the only guard that
>    survives a refactor.
> 3. **Bound the query, and set ONLY DECLARED params** (V14, V21, V22). On the
>    adopted 5.0.0, prefer **`rlimit`** as the primary budget — declared, enforced
>    per query, monotone, and *deterministic* where wall-clock `timeout` varies
>    60-75% run to run — with `timeout` as the secondary bound. Never
>    `global_param_set` (hangs). **Never set an undeclared param**: one extra key
>    silently voids the timeout and hangs the WASM unkillably, and there is no
>    JS-side recovery. Enumerate declared params via `fixedpoint_get_param_descrs`
>    rather than trusting any document — including this session's research files,
>    whose "Recommended configuration" block prescribes the poisoning `random_seed`.
>    Ship a fast bounded **canary query** that fails closed if the params object is
>    dead. Effective `timeout` floor is ~150ms (one-time WASM/parse cost).
> 4. **Prefer a fresh context per reachability run** — it removes both the
>    evidence-stability question (R5) and any cumulative-budget hazard, at
>    negligible cost against 30-300ms queries.
> 5. **`unknown` must always demote** (V15): `reason_unknown` says `"ok"` on a
>    timed-out query, so the tier must measure elapsed vs the timeout it set and
>    report budget-exhaustion separately from genuine undecidability. The two need
>    different remedies, and `"ok"` must never reach a user.
> 6. Take `bounds: SolverBounds = {}` last and honor the Wave 1 check-before-work
>    discipline so a truncated run stays a strict prefix.
>
> **Measured feasibility** (`probes/spacer-scaling-probe.mjs`), EARS-shaped latch
> systems at 2 booleans per requirement, all with an inferred invariant:
> N=10→32ms, N=25→47ms, N=50→63ms, N=100→72ms, **N=200 (400 state vars)→122ms**
> unsat; SAT direction N=200→299ms. Near-linear, and 2-3 orders of magnitude cheaper
> than the propositional O(N²) tier. The binding cost on a real document will be
> encoding, not solving.

**AC-2-3** — Event-driven. When Spacer proves a violation unreachable, `check` shall record the **inferred invariant** as evidence; when it proves reachability, `check` shall record the **counterexample trace**.
*Spacer returns both (verified in V1). `Evidence.witness` is declared at `src/formal/finding.ts:74-79` and populated nowhere — this fills it. Requires a new trace evidence member and renderer.*

> **Correction: `getAnswer()` does NOT return a readable trace on `sat`.** It
> returns a hyper-resolution **proof term** (725 chars on a 4-step system).
>
> **V29 — measured which call actually works (`probes/RESULTS-trace-extraction.md`).**
> All six raw entrypoints are present. But:
> - **`get_rules_along_trace` is the one to use** — 6 entries forming a genuine
>   step-by-step witness, with rule multiplicity preserved (the increment rule
>   appears 3 times for 3 increments). Returned **reverse-ordered**, violation
>   first and initial state last: reverse before rendering.
> - **`get_ground_sat_answer` returned literal `false`** — useless on this shape,
>   despite being the research's first recommendation.
> - `get_rule_names_along_trace` **does not abort** (the research warned it
>   hard-aborts via `shared_occs.cpp`; it returned cleanly) but yields
>   `<null>` per entry, because rules loaded through `fixedpoint_from_string`
>   carry no names.
>
> **Therefore register rules programmatically with per-requirement names**
> (`addRule(rule, requirementId)`) instead of `fromString`. Then the trace names
> *which requirements fired in which order* to reach the violation — the direct
> analogue of the unsat core the propositional tier already reports, and the
> evidence a user can act on. Parsing from a string throws that away.
>
> Keep the ordering mitigation anyway: extract the trace **last**, after the
> verdict and invariant are in hand. A `shared_occs` assertion would abort rather
> than throw, so `try/catch` cannot protect against it and ordering is the only
> defense; it costs nothing.
>
> **Evidence text must be canonicalized, not asserted raw** (R5 + a latent
> address-dependent tie-break in Spacer's `pob_lt_proc`). Better still, make
> invariant text non-load-bearing by **independently re-checking** the invariant
> with three plain-SMT queries (`Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, `Inv ⇒ ¬Bad`). The
> *verdict* was deterministic in every measurement; the *text* is what carries risk.
> Strip the `:weight 0` annotations before showing a human.
>
> **V28 — the certificate check WORKS and has teeth (measured, `probes/RESULTS-certificate-check.md`).**
> On a real Spacer `unsat` + inferred invariant, all three obligations discharge
> (`negation=unsat` each). The negative control — substituting the vacuously-true
> `Inv = true`, which satisfies the first two obligations trivially — is **correctly
> rejected** at `Inv ⇒ ¬Bad`. Three cheap queries against an already-warm context.
>
> Required verdict shape:
> `unsat` → run the 3 obligations; all pass → `PROVED` (or
> `PROVED_UNDER_HYPOTHESES` per AC-2-5); **any fail → ERROR "the solver's answer
> did not re-verify", never a proof and never merely a demotion**.
> `sat` → reachable, extract the trace. `unknown` → demote, split per V15.
>
> The obligations must be built from the **same encoding the Horn rules came
> from**, never re-derived from the document — re-deriving would validate a
> different question, which is exactly the AC-1-3 defect (the exported `.smt2`
> answered a weaker question than the in-process tier and said `sat` where it
> proved `unsat`).
>
> Incidental R5 evidence: the same invariant printed `(or B (not A))` in this run
> and `(or (not A) B)` in an earlier one — same verdict both times. Operand order
> is not stable **across configurations**, which is not the within-configuration
> instability R5 claimed, but is further reason never to assert on printed text.

**AC-2-4** — Unwanted behavior. If a document has no committed state model, or Spacer returns `unknown`, then `check` shall demote `verified` with the exact command that supplies what is missing, and shall never report reachability as proven.
*Preserves demotion-only. New demotion reasons join the eight at ~~`src/pipeline/check.ts:251-275`~~ **`:268-299`** (the cited range is pre-Wave-1; `solver-budget-exhausted` was Wave 1's eighth).*

> **Wiring, verified 2026-07-29.** `verified = demotions.length === 0` at
> `check.ts:1434`, single writer. `CoverageDemotion` is
> `{ reason, requirementIds, action }` — no `ops[]`. Tail-append new reasons.
>
> New codes go in **`COVERAGE_GAP_FND_CODES`** (`check.ts:465-469`) **and**
> `PROPOSE_ONLY_FND_CODES` (`:437-452`), and **never** in
> `CROSS_REQUIREMENT_FND_CODES` — they span ≥2 ids but mean "a comparison did NOT
> happen", so they must not suppress the `FND_NO_PAIRS_CHECKED` disclaimer. Build
> them as new `src/formal/coverage.ts` builders beside `noPairsCheckedFinding`,
> `excludedFromFormalFinding`, `relationalUncheckedFinding`.
>
> Model the `action` text on **`semantic-tier-skipped`** (`:1394-1400`) — the only
> one of the eight that is runnable as written. Three of the eight carry prose only
> and four carry unresolved placeholders; do not copy those.
>
> Push the "no state model at all" demotion **outside** the
> `requirements.length >= 2` guard, following the truncation precedent at
> `:1404-1433`: a 1-requirement document with a state-mutating response is not
> vacuously reachability-safe.
>
> Per V15, `unknown` must split into two demotions with different remedies —
> budget-exhausted (raise `--solver-budget-ms`) vs genuinely undecidable (raising it
> will not help). And per AC-2-5, no-state-model and frame-relied-upon are further
> distinct demotions. New `CoverageReport` counters belong beside `encoded`/`excluded`
> (`:328`/`:337`), with a `reachabilityNote` mirroring `pairsCheckedNote` (`:344`).
>
> **One scope-text amendment covers both surfaces**: "sound modulo atomization"
> becomes "sound modulo atomization **and the committed state model**" in
> `src/cli/scope-text.ts`, which feeds the manifest (`manifest.ts:647`) and
> AGENTS.md (`gen-agents.ts:161-169`). `manifest.test.ts` greps exact substrings, so
> **extend rather than rewrite**. Registering a new `FND_` code touches 7 files and
> is guarded by 4 drift tests, including a no-orphan-codes check that fails CI if a
> code has no emitter path.

**AC-2-5** — Ubiquitous. A frame assumption shall be an explicit, disclosed, demotable choice, never an implicit encoder default.
*The one place unsoundness would enter: "state persists unless a response changes it" asserts something the document never said. Needs its own finding code in the loud-coverage tradition.*

> **DECIDED by the user, 2026-07-29 — full rationale in
> `.erpaval/sessions/session-511b2b/AC-2-5-frame-decision.md`. Binding on
> AC-2-2/2-3/2-4.**
>
> **Prove twice, report the strongest verdict.** Per-variable
> `frame: stable | volatile` in the doc-committed state table, **defaulting to
> `volatile`** (a missing declaration may only ever weaken a claim).
>
> | strict run | framed run | verdict | demoted? |
> |---|---|---|---|
> | unreachable | — | `PROVED`, "frame-closed" | **no** — state it positively |
> | reachable | reachable | error finding + real counterexample trace | n/a, genuine defect |
> | reachable | unreachable | `PROVED_UNDER_HYPOTHESES`, naming the variables relied upon | **yes** |
> | unknown, or no committed state model | | demote, naming the discharging command | **yes** |
>
> Divergence between the two runs **is** the detector for "the frame was
> load-bearing here" — no separate dependency analysis needed. Then minimize the
> frame set by releasing each variable in turn, so the finding is actionable.
>
> **Why prove-twice is not gold-plating** (the polarity tension this AC did not
> name): strict is the sound direction for proving *unreachable* but the UNSOUND
> direction for reporting *reachable* — with no frame, a variable may change
> spontaneously, so a "violation" can be an encoding artifact. Reporting that at
> error severity would break the README's promise that a proven conflict is real.
> Neither single-run configuration is honest in both directions. Prove-twice is
> what earns the right to report anything at error severity. Cost ~2×, immaterial
> against measured Spacer latency (122ms at 400 state variables).
>
> Machine token `PROVED_UNDER_HYPOTHESES` (precedent: Frama-C `Valid_under_hyp`,
> `(⋀_{h∈H} h) ⇒ P`). Never `UNKNOWN`, which must stay reserved for
> failed-to-decide. **Never print "P is unreachable" under a frame** — the claim is
> about the requirement-sanctioned transition relation and the sentence must carry
> that. Error, do not guess, when the declared frame and the extracted write set
> disagree (Quint's rule).
>
> Ship the vacuity sanity gates alongside, or a reachability proof can be vacuously
> true without the tool knowing: Init satisfiable (**error**), transition relation
> non-empty (**error**), deadlock witness (**warn**), per-requirement guard
> reachability (render `proven-vacuously`, never `proven`), per-variable
> two-valuedness, Beer witness check, and an **independent certificate check** of
> `Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, `Inv ⇒ ¬Bad`. That last one is three cheap
> queries and the strongest implementable guarantee for a "never report proven
> unless proven" contract; it also makes invariant *text* non-load-bearing, which
> sidesteps R5.
>
> **Prior art**: declaring state variables is well-precedented (FRET mandatory;
> EARS-CTRL mandatory + sensor/actuator partition) — claim conformance, not
> novelty. Per-requirement `effect`/`constraint` classification was found in **no**
> EARS/NL tool. And EARS-CTRL, co-authored by EARS's inventor, already hit this and
> papered over it: it silently inserts a weak-until frame condition, sound only
> under causal completeness, disclosed nowhere. AC-2-5 is documented practice in
> the nearest prior tool, not a hypothetical.

**AC-2-6** — Ubiquitous. The `F`-under-`G` lowering shall not force the eventuality at the horizon.
*Fixes V6 before AC-2-7 makes it exploitable. Files: `src/formal/temporal.ts:81-86`. Either add lasso/loopback constraints or weaken the horizon instantiation; a bounded run must remain sound-for-UNSAT only.*

> **Chosen fix, measured 2026-07-29: pending-eventuality + per-eventuality abstract
> tail state.** Not among the AC's two suggested options, and it beats both.
> Per *distinct* eventuality subformula, one fresh `pend` Bool and one tail index:
> `F φ @ t` ⟶ `⋁_{i=t..k} φ@i ∨ pend_φ`; `X φ` at `t=k` ⟶ a fresh free Bool instead
> of `false`; `U` gets the same `∨ pend`; per pending, assert every top-level `G`
> body at that pending's tail index plus `pend_φ → φ@tail`.
> **One tail per eventuality, never shared** — a shared tail is unsound (measured:
> `unsat` on `G(t→F r)+G(c→F d)+G(¬(r∧d))` where per-pending correctly gives `sat`).
>
> Results (orchestrator-verified, `probes/v6-verify-fixspace.mjs`): V18's
> 3-requirement false positive flips `unsat`→`sat` at k=2,4,8,12, while the headline
> fixture and the adversarial fixture both **stay `unsat`** at k=5,8. Exhaustive
> sweeps: 0 FP / 220 and 0 FP / 455, recall 154/154 and 260/260 — parity with lasso.
> It is a **provable strict relaxation** of today's encoding (only added disjuncts
> and freshly-guarded implications), so review reduces to checking that property.
> ~3-5× encode, no `unknown`, no crash; **zero test edits** required.
>
> Rejected with measurements: **lasso/loopback** is sound *and* complete but 20×
> AST growth, 10× latency, returned `unknown` at N=60/k=20, and triggered a **hard
> Z3 4.16.0 WASM internal error** (`ast.cpp:383`) — unacceptable behind an
> error-severity finding; revisit after AC-1-9. **Weaken-`G`** drops recall to
> ~90% and flips the shipped adversarial fixture `unsat`→`sat`; its full-recall
> variant is **still unsound** (the defect shifts inward by `d`:
> `G(a→F b) ∧ a@(k-1) ∧ ¬b@(k-1) ∧ ¬b@k` is `unsat` at k=3,5,8). **Skip-if-F-under-G**
> collapses recall to 32.5%.
>
> **Do not touch the `F(antecedent)` reachability assertion at `temporal.ts:216-225`**
> — it must keep ranging over the full `[0,k]`. It is what *activates* the horizon
> bug (without it, `G(ante→…)` is vacuously satisfiable), and weakening it
> reintroduces vacuous SAT per the existing lesson. The chosen fix leaves it
> untouched.
>
> Also in scope: correct the **user-facing false claim** at `temporal.ts:155-156`
> ("A sound contradiction; not bound-dependent to refute") — the claim is shipped in
> 7 places (`codes.ts:239-243`, `AGENTS.md:235`, `manifest.ts:225-229`,
> `README.md:488`, `finding.ts:96-105`, `temporal.ts:59-62`); and fix the
> **mislabeled fixture** at `budget.test.ts:242-266`, whose comment claims a
> contradiction it has never produced (`F R` vs `F ¬R` are jointly satisfiable).

**AC-2-7** — Ubiquitous. The temporal and propositional tiers shall share one atomizer and one indexed formula AST.
*Six verified divergences behind a docstring claiming they line up (punctuation class, copula strip, antonym unification, de-inflection, glossary, a fourth `feat` kind). Consequence: `--temporal` is blind to every glossary/antonym commitment. Prerequisite for all reachability work; ~~also lets `guard-implication.ts` and its 24-verb lexicon be deleted~~ — see R3, that deletion is refuted.*

> **Corrections (verified 2026-07-29).** **Nine** divergences, not six. The three
> additional: (7) the `toEncodable` leading-negator scan (`check.ts:594-603`) runs
> only on the propositional path, so `--temporal` puts `not` inside the atom *name*
> (`…__resp__not_store_plaintext` vs `…__resp__store_plaintext` + `negated:true`),
> breaking the docstring's own invariant #4; (8) temporal reads raw `reqs` while
> propositional reads post-gate `included` (`check.ts:988` vs `:786-788`), so the
> tiers score different populations; (9) empty slots yield well-formed-but-empty
> atoms `sys__auth__trig__` (`temporal-patterns.ts:170`) where `encode.ts:213/220`
> omits the slot entirely.
>
> The glossary/antonym blindness is **structural, not incidental**:
> `earsToTemporal(req: ReqView)` takes no glossary or antonym parameter at all, and
> `check.ts:988` passes none. Unification's biggest win is the 21 antonym classes —
> `G(t→F grant_x)` vs `G(t→F ¬grant_x)` is exactly what the temporal tier exists to
> prove and today cannot reach.
>
> Two open semantic decisions, not refactors — do not resolve them by guessing:
> whether the `feat` kind should survive at all (derived from the same slot as
> `pre`; collapsing it is arguably more correct), and whether the `cmp` node
> (`encode.ts:109-113`) should be timestep-indexed (nothing needs it today, but
> AC-2-1's state model probably will).

> **AC-2-7 DONE.** All nine divergences resolved with the **propositional**
> semantics winning every contested one (punctuation class, copula strip — extended
> to `trig`/`feat` —, antonym unification, de-inflection, glossary, negation as
> polarity rather than text, and empty-slot handling *strengthened* from "raw text
> blank" to "normalized body empty", which also catches `"---"`).
>
> Enforcement is **structural, not conventional**: `earsToTemporal(req, atomize)`
> takes the atomizer as a **required** parameter, so the tier cannot silently go
> blind again without a visible signature change. `slotIsEmpty` is now *shared*
> from `encode.ts` rather than copied — a second copy is how divergence #9 arose.
> The atom is now a structured `{ name, negated, ref }` with `renderAtom(ref)`, so
> kind comparison is no longer substring matching on a joined string.
>
> **#8 resolved: temporal now scores the gate-included set.** A requirement whose
> guard the lint tier just called untrustworthy has no trustworthy *trigger*, and
> the temporal tier's whole shape is `G(trigger → …)`; scoring it anyway would make
> the decide tier looser about its input than the tier gating it. Nothing is lost —
> `FND_EXCLUDED_FROM_FORMAL` already demotes, and it was previously **literally
> false** about the temporal tier. Waivers re-admit to both tiers at once (tested).
> The numeric tier deliberately still reads raw `reqs`; its soundness does not
> depend on the atomization the gate protects.
>
> **Both open decisions took the conservative branch, deliberately.** `feat`
> survives — collapsing it to `pre` *increases* unification (an optional-feature
> guard would share an atom with a state-driven guard of the same text) and so
> produces *more* error-severity findings; that direction needs a human. AC-2-7 does
> make `feat` normalize identically to `pre`, with only the kind marker differing.
> `cmp` stays unindexed and is deliberately **not** admitted into `TemporalFormula`
> so the choice cannot be made by accident: indexing renames the Real const in every
> numeric finding's evidence and every emitted `.smt2` — an observable contract
> change.
>
> **The payoff, orchestrator-verified on the built CLI.** `G(fail → ¬grant)` +
> `G(authorize)` under a glossary alias: **before** the alias, 0 errors and 0
> temporal findings; **after** `glossary add "grant access" "authorize the
> request"`, the temporal tier proves the conflict. Propositionally satisfiable;
> temporally unsat via the `F(antecedent)` premise. The propose/decide loop now
> reaches a tier that was structurally blind to it.
>
> No regressions: 1243 → **1270 tests**, adversarial **15/15 with no round changing
> behavior**, AC-2-6 verification 8/8, `v6-strict-relaxation` 910 sets / 0
> violations, N=100 latency 2497ms → **2382ms** with finding sets **byte-identical**
> (1126 each, 0 added, 0 removed). `pnpm check` exit 0.
>
> Methodology trap worth keeping: the agent's first latency corpus used bare digits,
> tripping `GTWR_R6` and excluding all 100 requirements — measuring an empty solver
> at 16ms, which would have read as a 150× speedup. Always confirm the corpus
> actually reaches the tier being measured.

**AC-2-8** — Ubiquitous. Any capability claiming to explore reachable state shall ship a committed feasibility gate with a latency budget that fails CI when exceeded.
*Reuse the AC-33-0 precedent at `scripts/temporal-feasibility.ts`.*

> **The cited precedent gates nothing (V19).** `scripts/temporal-feasibility.ts` is
> well-built — committed `LATENCY_BUDGET_MS = 1000`, warm-up run to exclude WASM
> init, two-factor verdict, exit 1 infeasible / 2 crash — but it is referenced in no
> `package.json` script, no `lefthook.yml` job, and no workflow. Only `knip.json:4`
> type-checks it. Copying it verbatim would inherit the exact defect the AC forbids.
> Note also that `check:agents` is pre-push only, so it is not in GitHub CI either.
>
> Ship **both shapes**: (1) `scripts/reachability-feasibility.ts` mirroring the
> precedent, whose two-factor verdict is proves-unreachable on the safe variant
> **and** finds-counterexample on the buggy variant **and** within budget — i.e. it
> doubles as the V13 polarity canary; and (2)
> `src/pipeline/__tests__/check-reachability-scale.test.ts` modeled on
> `check-scale.test.ts`, which is the shape CI actually runs (committed ceiling,
> measured latency logged on success, a relative budgeted-vs-unbounded assertion, and
> an honesty assertion that a truncated run reports `verified:false`).
> **Then actually chain the script into `pnpm check` or the workflow**, and retrofit
> `temporal-feasibility.ts` the same way — AC-2-8's wording covers the bounded
> temporal tier too.
>
> Two further gaps worth closing here: the AC-1-7 scale gate does **not** enable
> `--temporal` (`check-scale.test.ts:160-162`), so no CI gate would catch a temporal
> blowup; and `--temporal-bound` is accepted **uncapped** at `cli/index.ts:605-606`
> while the encoding is `O(k²)`-to-`O(k³)` in `k`.
>
> Budget headroom is ample: 122ms at 400 state variables (see AC-2-2).

> **AC-2-8a DONE (the half that does not need the reachability tier).** All four
> verified gaps closed, and **every gate was observed failing before being trusted**:
>
> | Gate | Injected defect | Observed |
> |---|---|---|
> | `gate:temporal` latency | `LATENCY_BUDGET_MS = 0.0001` | **exit 1**, "INFEASIBLE — sound but over latency budget" |
> | `gate:temporal` polarity | consistent fixture made conflicting | **exit 1**, "manufactured one on a satisfiable set — do NOT ship" |
> | `gate:temporal` crash | throw in a leg | **exit 2** |
> | `check:agents` | appended a marker to AGENTS.md | **exit 1**, and it **aborts `pnpm check` after tsc, before vitest** |
> | temporal latency ceiling | workload constant → 1 | vitest fail |
> | temporal honesty | removed the `truncate` call so the tier skips silently | vitest fail |
> | temporal monotonicity | hard-error at the exact band the lesson forbids | vitest fail |
> | `--temporal-bound` | ceiling → `Infinity` | 34.3s / 3.4 GB RSS at k=2000 |
>
> `pnpm check` is now `biome ci . && tsc --noEmit && check:agents && gate:temporal
> && vitest run && knip` — both tsx gates run **before** vitest (no build needed,
> <1.5s, fail fast). This also closes **G2**: `check:agents` was pre-push-only, so
> no CI path ever ran the AGENTS.md drift check.
>
> **`--temporal-bound` capped at 200**, justified by measurement rather than taste:
> at N=100, k=150→8.1s/1.0GB, k=200→13.5s/2.0GB, k=250→24s/3.0GB, **k=300→55s/4.0GB
> = Node's default old-space limit** (process aborts, exit 134, no envelope). Neither
> `--timeout-ms` (a per-solver timeout) nor `--solver-budget-ms` (checked only
> *before* the tier starts) can rescue it, because the cost is paid **encoding**,
> before any solver sees the terms. Verified on the built CLI: 201 → `ERR_USAGE`
> naming the max, 200 accepted, `2.5` and `0` rejected.
>
> **G3 correction — the brief's N=100 assumption was wrong.** At N=100 the O(N²)
> tiers exhaust the budget and the temporal tier is **skipped** by check-before-work,
> so a temporal blowup stays invisible even with `--temporal` on. The scale gate
> therefore runs at **N=25**, where temporal is the dominant cost (0.39s off vs 1.3s
> at k=100).
>
> **G5 signal worth keeping.** Re-pointing the script at the real `lowerAt` revealed
> the hand-rolled encoding was **not equivalent** to the shipped one: a `lowerAt`-only
> probe of `G(trig→F resp) ∧ G(¬resp)` returns **`sat`**, because `lowerAt` alone
> gives the AC-2-6 relaxed reading with the pending literal free. The old script got
> `unsat` only because it had frozen the **pre-AC-2-6 defective semantics**. The gate
> now goes through `findTemporalContradictions`, which supplies the tail assertions
> that force `pend` false and recover the real refutation — same verdict, but now it
> means something.

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
   ├─► Wave 2  (needs AC-1-1, AC-1-3, AC-1-7)
   │      AC-2-6 ──► AC-2-7 ──► AC-2-1 ──► AC-2-2 ──► AC-2-3, AC-2-4, AC-2-5, AC-2-8
   ├─► Wave 3  (needs Wave 1; AC-3-5 pairs with AC-1-7)
   └─► Wave 4  (AC-4-1/4-2 need AC-1-4; AC-4-6 needs AC-1-5)
          └─► Wave 5 (needs Waves 1-3)
```

**Two edges corrected 2026-07-29** (both verified, see R3/R4 and the Wave 2 note):

- `AC-2-7 ──► AC-2-6` is now **`AC-2-6 ──► AC-2-7`**. AC-2-7 unifies the atom
  namespaces whose current disjointness is the *only* thing keeping V6/V17/V18
  latent; shipping it first would turn a latent soundness bug into reported
  error-severity false positives on satisfiable specs.
- `AC-2-1 needs AC-1-5` is **removed**. There is no prior document format to
  migrate from, and new fields need no version bump.

**Wave 1 status:** AC-1-1/1-2/1-3/1-4/1-6/1-7/1-8 shipped in `169af27`. AC-1-5 and
AC-1-9 did **not** ship and are being carried into Wave 2 by user decision —
AC-1-9 because 5.0.0 makes `rlimit` a declared Fixedpoint param (a deterministic
budget, where `timeout` is wall-clock and machine-dependent), which now matters
directly for the reachability tier.

## Gates

`pnpm check` (biome + tsc + vitest + knip) exit 0, plus `pnpm gen:agents` after any
description/manifest change. Each verified finding V1-V11 becomes a named
regression test. The two refuted claims R1/R2 are recorded here so they are not
"fixed" into a false behavior.
