/**
 * THE SPACER REACHABILITY TIER — the headline capability, and the hazard-densest
 * file in the codebase.
 *
 * Given a committed state model, this asks the one question the propositional tier
 * structurally cannot: **over ALL reachable states, with no bound, can any
 * requirement's constraint be violated?** An answer of "no" is a proof with an
 * inductive invariant; an answer of "yes" is a counterexample trace naming which
 * requirements fired in which order.
 *
 * Everything below is shaped by measurements from the donor's ~30-script probe
 * corpus (`.erpaval/sessions/session-511b2b/probes/`) and re-verified against the
 * installed z3-solver 5.0.0 before being written. Where a comment states a number,
 * that number was measured, not recalled.
 *
 * ---
 *
 * ## V13 — THE POLARITY IS INVERTED BETWEEN Z3'S TWO HORN INTERFACES
 *
 * The single most dangerous trap here, because getting it wrong does not produce an
 * error — it produces a FABRICATED PROOF. Measured (`probes/RESULTS-horn-polarity.md`),
 * same engine, same transition system, two interfaces:
 *
 * | interface | provably-SAFE system | provably-REACHABLE system |
 * |---|---|---|
 * | A. muZ `fixedpoint_query` (this file) | `unsat` | `sat` |
 * | B. plain solver + `(set-logic HORN)` | **`unknown`** | `unsat` |
 *
 * So `unsat` means SAFE under A and UNSAFE under B. A developer copying an idiom from
 * a Z3 tutorial (which mostly show B) would silently invert every verdict and report
 * reachable violations as proven safe.
 *
 * Two mitigations, both structural:
 *
 * 1. **Interface A only.** Never `solver_from_string` with `(set-logic HORN)` — and
 *    beyond polarity, B is simply unusable: it returned `unknown` on the SAFE system
 *    even at a 5000ms timeout, i.e. on exactly the cases this tier exists to prove.
 * 2. **ONE named chokepoint**, {@link verdictOfLbool}, is the only place an lbool
 *    becomes a verdict. Its tests assert the NAMED verdict on a known-unreachable and
 *    a known-reachable pair, never the raw integer — the only guard that survives a
 *    refactor.
 *
 * ## V14 / V21 — AN UNDECLARED PARAM VOIDS THE TIMEOUT AND HANGS THE WASM
 *
 * Measured on both 4.16.0 and 5.0.0: `{engine, timeout: 1500}` bounds correctly at
 * ~1621ms, and the SAME object plus `random_seed: 42` — one undeclared key — runs past
 * 45s with no JS-side recovery. No throw at `params_set_uint`, none at
 * `fixedpoint_set_params`. The failure appears only as a query that never returns.
 *
 * Re-verified here: `fixedpoint_get_param_descrs` declares **120** params on 5.0.0,
 * and `random_seed` is NOT among them. So {@link setDeclaredParams} enumerates the
 * descriptors at runtime and REFUSES to set anything absent from them — the research
 * document's own "Recommended configuration" block prescribes `random_seed` and is
 * therefore unsafe as written.
 *
 * Two further guards: `rlimit` and `global_param_set` are never used (both measured as
 * hard hangs on the timeout path), and every query goes through
 * {@link SolverShape.solve} / `interruptibleSolve`, so even a hang that slipped through
 * is cancellable via `Z3_interrupt` in ~5ms rather than wedging the process.
 *
 * ## V15 — A TIMED-OUT QUERY REPORTS `reason_unknown === "ok"`
 *
 * Not `"timeout"`, not `"canceled"` — the literal string `"ok"`, because Z3's
 * `context::cleanup()` resets `m_last_status = OK` before every fixedpoint query
 * returns. So the reason string cannot distinguish "I ran out of time" from "I cannot
 * decide this", and those need DIFFERENT remedies (raising the budget helps the first
 * and is useless for the second).
 *
 * {@link classifyUnknown} therefore derives the distinction OUT-OF-BAND from measured
 * elapsed vs the timeout actually set, and `"ok"` never reaches a user — surfacing it
 * would read as success on a failed query, which is the exact honesty defect the whole
 * v4 Wave 1 existed to remove.
 *
 * ## V16 / AC-2-5 — THE FRAME ASSUMPTION CAN CONVERT "reachable" INTO A FALSE "PROVED"
 *
 * The frame assumption ("state persists unless a requirement changes it") asserts
 * something the document never said. Measured on a 3-variable model whose `alarm` is
 * written by NO requirement: `frame=stable` → UNREACHABLE *with an inductive
 * invariant*; `frame=strict` → REACHABLE. `alarm` is genuinely reachable, so under the
 * frame Spacer proves a false answer and hands back a certificate for it.
 *
 * The polarity tension the donor spec did not name: strict (no-frame) is the sound
 * direction for proving UNREACHABLE, but the UNSOUND direction for reporting
 * REACHABLE — with nothing framed, a variable may change spontaneously between steps,
 * so a "violation" can be an artifact of the encoding rather than a real defect.
 * Neither single configuration is honest in both directions.
 *
 * So, per the BINDING decision doc: **prove twice, report the strongest honest
 * verdict.** {@link decideFrameVerdict} implements the lattice, and divergence between
 * the two runs IS the detector for "the frame was load-bearing here" — no separate
 * dependency analysis needed.
 *
 * ## V29 — `getAnswer()` IS NOT A TRACE, AND RULE NAMES NEED PROGRAMMATIC RULES
 *
 * `getAnswer()` on `sat` returns a hyper-resolution PROOF TERM (725 chars on a 4-step
 * system), and `get_ground_sat_answer` returned literal `false` — useless on this
 * shape, despite being the research's first recommendation.
 * `get_rules_along_trace` is the call that works.
 *
 * But rules loaded via `fixedpoint_from_string` carry NO names, so
 * `get_rule_names_along_trace` yields `<null>` per entry. Hence every rule here is
 * registered PROGRAMMATICALLY with its requirement's own key
 * (`fixedpoint_add_rule(..., mk_string_symbol(key))`), which is what lets a trace name
 * WHICH REQUIREMENTS fired in which order. Re-verified on 5.0.0: a 4-rule system
 * returned `"<null>;R-bad;R-set;R-tick;R-tick;R-tick;R-init"` — real names, rule
 * multiplicity preserved.
 *
 * Two ordering mitigations kept regardless: the trace is extracted LAST (after the
 * verdict and the invariant), because a `shared_occs` assertion would ABORT rather
 * than throw and `try/catch` cannot protect against it; and the trace comes back
 * REVERSE-ordered (violation first), so it is reversed before rendering.
 *
 * ## V28 — THE INVARIANT IS INDEPENDENTLY RE-CHECKED, WHICH MAKES ITS TEXT NON-LOAD-BEARING
 *
 * When Spacer says `unsat` it also hands back an inferred invariant, and this tier does
 * not simply trust it: {@link checkCertificate} discharges three plain-SMT obligations
 * (`Init ⇒ Inv`, `Inv ∧ T ⇒ Inv'`, `Inv ⇒ ¬Bad`) by asserting each NEGATION and
 * requiring `unsat`. Re-verified here on a real lock/pending model: all three hold, and
 * the negative control (substituting the vacuously-true `Inv = true`, which satisfies
 * the first two trivially) is correctly REJECTED at `Inv ⇒ ¬Bad`.
 *
 * This is the strongest implementable guarantee for a tool contracted never to report
 * proven unless it is proven, and it has a second benefit: it makes the invariant TEXT
 * non-load-bearing, which sidesteps the unresolved operand-order-stability risk
 * (`probes/RESULTS-invariant-determinism.md`) entirely. The VERDICT is what is checked.
 *
 * A failed obligation is an ERROR — "the solver's answer did not re-verify" — never a
 * proof and never merely a demotion.
 *
 * ## A FRESH CONTEXT PER RUN
 *
 * Cheap against 30-300ms queries, and it removes both the evidence-stability question
 * and any cumulative-budget hazard at once.
 *
 * ## NEVER PARALLELIZE
 *
 * Asyncify holds ONE global capability slot (`SOLVER_CONCURRENCY === 1`). Every query
 * here is awaited before the next begins. An `Effect.forEach({concurrency: n})` over
 * these queries would wedge the module for the rest of the process.
 */

import { Effect } from 'effect'
import type {
  Requirement,
  RequirementsDocument,
  StateModel,
  StateVariable,
} from '../core/document.ts'
import type { DeclaredVars, Expr, StateEffect } from '../core/state-expr.ts'
import {
  declaredVars,
  isExprError,
  validateEffect,
  validateExpression,
  writesOf,
} from '../core/state-expr.ts'
import { SolverService } from './solver-service.ts'

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

/**
 * The verdict for ONE constraint, as a NAMED value.
 *
 * Named rather than an lbool at every boundary above {@link verdictOfLbool}, because
 * V13's inversion is only survivable if the raw integer exists in exactly one place.
 * A function that returns `-1` invites a caller to interpret it; a function that
 * returns `'unreachable'` does not.
 *
 * - `'unreachable'` — no reachable state violates the constraint. A PROOF, with an
 *   inductive invariant, subject to the certificate re-check.
 * - `'reachable'` — a reachable state violates it. A genuine defect, with a trace.
 * - `'unknown'` — the solver did not decide. ALWAYS demotes; never a proof.
 */
export type ReachabilityVerdict = 'unreachable' | 'reachable' | 'unknown'

/**
 * THE ONE CHOKEPOINT where a Z3 lbool becomes a verdict (V13).
 *
 * The mapping, for interface A (`Z3_fixedpoint_query`) and interface A ONLY:
 *
 * - `Z3_L_FALSE` (`-1`) → `'unreachable'` — no derivation of the query relation
 *   exists, so the bad state is unreachable. This is a PROOF.
 * - `Z3_L_TRUE` (`+1`) → `'reachable'` — a derivation exists, i.e. a counterexample.
 * - `Z3_L_UNDEF` (`0`) → `'unknown'`.
 *
 * Under interface B the first two are SWAPPED, which is why that interface is never
 * used and why this function names the interface in its own contract. Anything other
 * than the three known values is `'unknown'` — the conservative direction, since the
 * alternative is treating an unrecognized code as a proof.
 */
export const verdictOfLbool = (lbool: number): ReachabilityVerdict => {
  if (lbool === -1) return 'unreachable'
  if (lbool === 1) return 'reachable'
  return 'unknown'
}

/**
 * Why a query came back `unknown` — derived OUT-OF-BAND, because the in-band reason
 * string is a lie (V15).
 *
 * - `'budget-exhausted'` — elapsed reached the timeout that was set. Raising the
 *   budget may help.
 * - `'undecidable'` — the solver gave up well inside its budget. Raising the budget
 *   will NOT help; the model needs bounding or simplifying.
 *
 * Two reasons rather than one because they need different remedies, and conflating
 * them would send an agent into a loop raising a budget that was never the problem.
 */
export type UnknownReason = 'budget-exhausted' | 'undecidable'

/**
 * Classify an `unknown` from the CLOCK, never from `reason_unknown` (V15).
 *
 * Measured: a timed-out Spacer query returns `reason_unknown === "ok"` — the same
 * string a healthy query returns — because `context::cleanup()` resets
 * `m_last_status` before returning. Also measured: the timeout is honored to within
 * ~5ms across 200/400/800/1600/3200ms, so elapsed-vs-timeout is a RELIABLE
 * discriminator where the reason string is not.
 *
 * The 10% tolerance is deliberate slack for the ~150ms one-time WASM/parse floor and
 * for scheduling jitter on a loaded machine: a query that came back at 1450ms of a
 * 1500ms budget hit the budget, and calling that "undecidable" would recommend the
 * wrong fix.
 */
export const classifyUnknown = (elapsedMs: number, timeoutMs: number): UnknownReason =>
  elapsedMs >= timeoutMs * 0.9 ? 'budget-exhausted' : 'undecidable'

/**
 * HOW MUCH the transition relation frames — three modes, not two.
 *
 * ## Why a boolean was WRONG, and how the solver said so
 *
 * The AC-2-5 decision doc describes prove-twice as "strict vs framed", which reads as a
 * boolean, and the first implementation made it one: the framed run pinned the variables
 * declared `frame: stable` and nothing else. That is unsound, and the worked fixture
 * caught it at error severity.
 *
 * With NO variable declared `stable`, "framed" and "strict" become the SAME encoding, so
 * `reachable` in both runs is trivially true and the lattice reports `VIOLATED`. The
 * fixture's trace made the problem plain: `init -> TX-A3 -> TX-C1` claimed a lock-count
 * constraint was violated by a requirement that only touches `idle`, because with nothing
 * framed `granted` may jump spontaneously between steps. A real error-severity finding
 * about a defect the document does not contain — the exact failure the doc warns about in
 * the other direction ("strict is the UNSOUND direction for reporting reachable").
 *
 * The two directions need two DIFFERENT encodings, and neither is the per-variable one:
 *
 * - `'none'` — nothing pinned. Sound for proving UNREACHABLE: if no violation exists even
 *   when every variable may change freely, none exists under any weaker assumption.
 * - `'full'` — every variable an effect does not write is pinned. Sound for reporting
 *   REACHABLE: a violation reachable here uses only requirement-sanctioned changes, so
 *   the counterexample is a real behavior of the described system.
 * - `'declared'` — only the variables declared `frame: stable` are pinned. This is the
 *   DOCUMENT's own stated assumption set, and it is what distinguishes a property that
 *   holds under hypotheses the author committed from one that needs assumptions nobody
 *   wrote down.
 *
 * So the per-variable declaration did not disappear; it moved from "which run to perform"
 * to "which run licenses a PROOF". See {@link decideConstraint} for the resulting order of
 * work.
 */
export type FrameMode = 'none' | 'declared' | 'full'

/**
 * The frame-aware verdict for one constraint — the AC-2-5 lattice, as a value.
 *
 * `PROVED` and `PROVED_UNDER_HYPOTHESES` are deliberately SCREAMING_CASE machine
 * tokens rather than prose, because they are what an agent switches on.
 * `PROVED_UNDER_HYPOTHESES` follows Frama-C's `Valid_under_hyp`, defined as emitting
 * `(⋀_{h∈H} h) ⇒ P`; it is NOT spelled `UNKNOWN`, which must stay reserved for
 * failed-to-decide, and not "provisional"/"inconclusive", which falsely imply that
 * more tool effort would resolve it.
 */
export type FrameVerdict =
  /** Unreachable with NOTHING framed. The strongest available answer: it holds under
   * the document's own transition relation, with no assumption added. */
  | 'PROVED'
  /** Unreachable only WITH the declared frames. True given a hypothesis the document
   * does not state, so it is disclosed and DEMOTES. */
  | 'PROVED_UNDER_HYPOTHESES'
  /** Reachable both ways: a genuine defect, reported at error severity with a trace. */
  | 'VIOLATED'
  /** Either run failed to decide. Demotes; never reported as proven. */
  | 'UNKNOWN'

/**
 * Decide the frame lattice (AC-2-5, binding) from the runs that were performed.
 *
 * | `none` run | framed run | verdict | reasoning |
 * |---|---|---|---|
 * | unreachable | (not needed) | `PROVED` | holds with NOTHING assumed |
 * | reachable | reachable | `VIOLATED` | reachable using only sanctioned changes |
 * | reachable | unreachable | `PROVED_UNDER_HYPOTHESES` | the frame is load-bearing |
 * | unknown (either) | | `UNKNOWN` | never reported as proven |
 *
 * This is the decision doc's table verbatim. What the doc leaves open — and what the first
 * implementation got wrong — is WHICH frame the second run applies.
 *
 * ## Why the framed run pins EVERY unwritten variable, not just the declared ones
 *
 * Pinning only the variables declared `frame: stable` makes the framed run identical to
 * the unpinned one whenever nothing is declared, so `reachable` in both is trivially true
 * and every such constraint reports `VIOLATED` at error severity. The worked lock/grant
 * fixture caught exactly that: a lock-count constraint reported violated by a requirement
 * that only touches `idle`, because with nothing pinned `granted` may jump spontaneously.
 * A confident error-severity finding about a defect the document does not contain.
 *
 * So the framed run pins every variable an effect does not write — the maximal frame — and
 * the DECLARED set is then used to make the disclosed hypothesis as TIGHT as possible (see
 * {@link decideConstraint}). That keeps both directions sound: nothing-pinned is the sound
 * direction for proving unreachable, fully-pinned is the sound direction for reporting a
 * counterexample, and the divergence between them is still the detector for "the frame was
 * load-bearing here".
 */
export const decideFrameVerdict = (
  none: ReachabilityVerdict,
  framed: ReachabilityVerdict | undefined,
): FrameVerdict => {
  if (none === 'unknown') return 'UNKNOWN'
  if (none === 'unreachable') return 'PROVED'
  // `none === 'reachable'`. On its own that is NOT evidence of a defect — with nothing
  // pinned a variable may change spontaneously, so the witness may use a transition the
  // document never licensed. The framed run is what distinguishes the two.
  if (framed === undefined || framed === 'unknown') return 'UNKNOWN'
  return framed === 'reachable' ? 'VIOLATED' : 'PROVED_UNDER_HYPOTHESES'
}

// ---------------------------------------------------------------------------
// What the tier reads out of a document
// ---------------------------------------------------------------------------

/** One requirement's parsed EFFECT — a transition contribution. */
export interface EffectRule {
  /** The requirement's stable key when it has one, else its UUID. Used as the Z3 rule
   * NAME, which is what makes a counterexample trace cite requirements (V29). */
  readonly label: string
  readonly requirementId: string
  /**
   * The guard and the updates. An ABSENT guard means the effect fires from every
   * state, which is the sound default: it admits more transitions, so strictly fewer
   * things are provable (see `StateEffect`).
   */
  readonly effect: StateEffect
}

/** One requirement's parsed CONSTRAINT — a safety property to try to violate. */
export interface ConstraintRule {
  readonly label: string
  readonly requirementId: string
  readonly predicate: Expr
}

/**
 * The state model plus the classified requirements, validated and ready to encode.
 *
 * Producing one of these is the ONLY way to reach the encoder, and
 * {@link prepareModel} is its only constructor — so an expression that did not
 * validate cannot be encoded. That is the type-level half of the V14/V21 mitigation
 * (the authoring-time half is `core/state-expr.ts`), and it is what lets every
 * function below assume every reference resolves.
 */
export interface PreparedModel {
  readonly variables: readonly StateVariable[]
  readonly vars: DeclaredVars
  readonly effects: readonly EffectRule[]
  readonly constraints: readonly ConstraintRule[]
  /** The conjunction of every per-variable `initial` and the model-wide one. */
  readonly initial: readonly Expr[]
  /** Variables declared `frame: stable` — the hypotheses a framed run assumes. */
  readonly stableVars: readonly string[]
  /**
   * Requirements classified but UNENCODABLE, with why. Never silently dropped:
   * each becomes a disclosure, because a requirement the tier could not read is a
   * coverage hole and silence over it would be the defect this codebase most guards
   * against.
   */
  readonly skipped: readonly { readonly label: string; readonly reason: string }[]
}

/** A requirement's label for evidence: its stable key if it has one, else its UUID.
 * Keys, not internal rule names — donor V29's groundwork, so a trace reads in the
 * author's own vocabulary. */
const labelOf = (requirement: Requirement): string => requirement.key ?? requirement.id

/**
 * Read a document's state model and classified requirements into a
 * {@link PreparedModel}.
 *
 * Re-validates every expression rather than trusting the document, and that is not
 * redundant with the write-path check: a document can be hand-edited, and a
 * hand-edited undeclared reference must become a DISCLOSURE here rather than an
 * unkillable hang. So an expression that fails is recorded in `skipped` and the run
 * continues over what remains — which is the same "detect and demote" posture the rest
 * of the pipeline takes, rather than failing the whole check on one bad line.
 */
export const prepareModel = (document: RequirementsDocument): PreparedModel => {
  const model: StateModel = document.stateModel
  const vars = declaredVars(model)
  const effects: EffectRule[] = []
  const constraints: ConstraintRule[] = []
  const skipped: { label: string; reason: string }[] = []
  const initial: Expr[] = []

  // Per-variable initials, then the model-wide one. CONJOINED rather than
  // overriding, so adding either can only ever NARROW the initial states.
  for (const variable of model.variables) {
    if (variable.initial === undefined) continue
    const parsed = validateExpression(variable.initial, model, 'initial')
    if (isExprError(parsed)) {
      skipped.push({
        label: `state ${variable.name}`,
        reason: `its initial predicate did not validate: ${parsed.error}`,
      })
      continue
    }
    initial.push(parsed)
  }
  if (model.initial !== undefined) {
    const parsed = validateExpression(model.initial, model, 'initial')
    if (isExprError(parsed)) {
      skipped.push({
        label: 'stateModel.initial',
        reason: `the model-wide initial predicate did not validate: ${parsed.error}`,
      })
    } else {
      initial.push(parsed)
    }
  }

  // Requirements, in stable id order so the encoding — and therefore every verdict and
  // every piece of evidence — is byte-reproducible.
  for (const id of Object.keys(document.requirements).sort()) {
    const requirement = document.requirements[id]
    if (requirement === undefined) continue
    const label = labelOf(requirement)

    if (requirement.responseKind === 'effect') {
      if (requirement.stateEffect === undefined) {
        // A label with no expression. The write path refuses this, so reaching it
        // means a hand edit — disclosed, never guessed at.
        skipped.push({
          label,
          reason:
            'it is classified `effect` but carries no `stateEffect` expression, so it contributes no transition',
        })
        continue
      }
      const parsed = validateEffect(requirement.stateEffect, model)
      if (isExprError(parsed)) {
        skipped.push({ label, reason: `its effect did not validate: ${parsed.error}` })
        continue
      }
      effects.push({ label, requirementId: id, effect: parsed })
      continue
    }

    if (requirement.responseKind === 'constraint') {
      if (requirement.stateConstraint === undefined) {
        skipped.push({
          label,
          reason:
            'it is classified `constraint` but carries no `stateConstraint` expression, so there is no property to check',
        })
        continue
      }
      const parsed = validateExpression(requirement.stateConstraint, model, 'constraint')
      if (isExprError(parsed)) {
        skipped.push({ label, reason: `its constraint did not validate: ${parsed.error}` })
        continue
      }
      constraints.push({ label, requirementId: id, predicate: parsed })
    }
    // An UNCLASSIFIED requirement is not skipped-with-a-reason here: it is simply not
    // part of the state model, which the check integration reports as its own
    // demotion over the whole document rather than as N per-requirement notes.
  }

  return {
    variables: model.variables,
    vars,
    effects,
    constraints,
    initial,
    stableVars: model.variables.filter((v) => v.frame === 'stable').map((v) => v.name),
    skipped,
  }
}

/**
 * The WRITE SET: which requirements write each variable.
 *
 * Two consumers, both about honesty rather than encoding. The frame disclosure needs
 * it to say "this proof depends on `lock_held` changing only via TX-C1, TX-C4" — a
 * finding naming the variables but not the writers is not actionable. And
 * {@link frameDriftOf} needs it for Quint's rule: a variable declared `stable` but
 * written by NO requirement is the exact V16 shape, so it is worth saying out loud.
 */
export const writeSetOf = (prepared: PreparedModel): ReadonlyMap<string, readonly string[]> => {
  const writers = new Map<string, string[]>()
  for (const variable of prepared.variables) writers.set(variable.name, [])
  for (const effect of prepared.effects) {
    for (const target of writesOf(effect.effect.assignments)) {
      writers.get(target)?.push(effect.label)
    }
  }
  return writers
}

/**
 * Variables declared `stable` that NO requirement writes — the V16 shape, named.
 *
 * This is the donor's measured unsoundness exactly: `alarm` declared stable and
 * written by nothing means the framed encoding pins it to its initial value forever,
 * so Spacer proves properties about it that the document never licensed. Prove-twice
 * already prevents the false PROVED (such a property comes back
 * `PROVED_UNDER_HYPOTHESES`, demoted), but reporting WHICH declaration caused it turns
 * a demotion into a fix.
 *
 * Deliberately a DISCLOSURE and not a hard error, unlike the strict Quint rule the
 * decision doc cites. A variable that no requirement writes is legitimately modelled
 * as a monitored INPUT, and `frame: stable` on one is a meaningful (if strong)
 * statement about the environment. Erroring would refuse a valid model; disclosing
 * plus demoting is the honest middle.
 */
export const frameDriftOf = (prepared: PreparedModel): readonly string[] => {
  const writers = writeSetOf(prepared)
  return prepared.stableVars.filter((name) => (writers.get(name) ?? []).length === 0)
}

// ---------------------------------------------------------------------------
// The low-level Z3 surface
// ---------------------------------------------------------------------------

/**
 * The low-level `Z3` namespace. Untyped by design — it is z3-solver's own escape hatch
 * (`Z3HighLevel & Z3LowLevel` exposes no Fixedpoint wrapper at all), and the donor's
 * probe corpus reaches Spacer the same way.
 *
 * Confined to this file. Nothing above the module boundary sees a `Z3_ast`.
 */
// biome-ignore lint/suspicious/noExplicitAny: the low-level Z3 namespace is untyped
type LowLevelZ3 = Record<string, any>

/** An opaque Z3 AST handle. */
// biome-ignore lint/suspicious/noExplicitAny: opaque z3 pointer
type Ast = any

/**
 * The `Z3_ast_kind` values this file dispatches on. Named constants because the enum is
 * not exported by z3-solver and `=== 3` at a call site is unreadable.
 *
 * `Z3.is_quantifier_ast` DOES NOT EXIST on 5.0.0 (verified — the namespace has
 * `is_quantifier_forall` / `is_quantifier_exists` and `get_ast_kind`, but no general
 * predicate), which is one of two API surprises beyond the donor's catalog found while
 * writing this file.
 */
/**
 * `Z3_APP_AST`. **1, not 0** — the enum is
 * `NUMERAL_AST = 0, APP_AST = 1, VAR_AST = 2, QUANTIFIER_AST = 3, …`, so 0 is a
 * NUMERAL. Guessing 0 here (the obvious wrong guess, since `app` feels like the base
 * case) makes {@link isApp} false for every application, so the invariant walk finds
 * nothing and the certificate check reports "the answer carried no readable Inv
 * definition" — a confident, fast, wrong answer on an answer that plainly contains one.
 * Verified against the live values by dumping a real Spacer answer.
 */
const AST_KIND_APP = 1
const AST_KIND_QUANTIFIER = 3

/**
 * ## THE SECOND SURPRISE: `to_app` ON A NON-APP RETURNS GARBAGE INSTEAD OF THROWING
 *
 * `Z3_to_app` is only defined for a node of kind `Z3_APP_AST`. Given a de Bruijn VAR
 * (kind 2, which is exactly what appears inside a quantifier body) it **does not
 * throw**: it returns a bogus pointer whose `get_app_num_args` reads as **30,208,840**
 * (measured). A walker that then loops over that arity performs 30 million FFI calls per
 * bound variable.
 *
 * That is what made {@link findInvariantBody} take **29.7 seconds** on an answer whose
 * printed form is 185 characters — and the symptom was indistinguishable from the
 * V14/V21 solver hang it was not: the Spacer query had already returned `unsat` in
 * 709ms. It was found by timing each stage, not by reading the code.
 *
 * So every walk MUST gate on `get_ast_kind(...) === AST_KIND_APP` before calling
 * `to_app`. A `try/catch` cannot substitute, because nothing throws.
 */
const isApp = (Z3: LowLevelZ3, ctx: Ast, ast: Ast): boolean =>
  Z3.get_ast_kind(ctx, ast) === AST_KIND_APP

/**
 * Set ONLY DECLARED params on a Fixedpoint, refusing anything the build does not
 * declare (V21).
 *
 * The enumeration is the whole point. Measured: 5.0.0's Fixedpoint declares 120
 * params and `random_seed` is not one of them, yet setting it throws nothing and
 * silently voids the `timeout` in the same object — producing an unkillable hang. A
 * hardcoded allow-list would rot against the next z3 bump; reading
 * `fixedpoint_get_param_descrs` cannot.
 *
 * Returns the names it REFUSED, so a caller can fail closed rather than proceed into
 * an unbounded query. Nothing in this file currently passes an undeclared param — the
 * refusal exists so that a future edit that does is caught by
 * `reachability.test.ts`'s guard rather than by a hung CI job.
 */
export const setDeclaredParams = (
  Z3: LowLevelZ3,
  ctx: Ast,
  fp: Ast,
  params: Readonly<Record<string, string | number | boolean>>,
): readonly string[] => {
  const descrs = Z3.fixedpoint_get_param_descrs(ctx, fp)
  Z3.param_descrs_inc_ref(ctx, descrs)
  const declared = new Set<string>()
  const size = Z3.param_descrs_size(ctx, descrs)
  for (let i = 0; i < size; i += 1) {
    declared.add(Z3.get_symbol_string(ctx, Z3.param_descrs_get_name(ctx, descrs, i)))
  }

  const p = Z3.mk_params(ctx)
  Z3.params_inc_ref(ctx, p)
  const refused: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (!declared.has(key)) {
      refused.push(key)
      continue
    }
    const symbol = Z3.mk_string_symbol(ctx, key)
    if (typeof value === 'boolean') Z3.params_set_bool(ctx, p, symbol, value)
    else if (typeof value === 'number') Z3.params_set_uint(ctx, p, symbol, value)
    else Z3.params_set_symbol(ctx, p, symbol, Z3.mk_string_symbol(ctx, value))
  }
  Z3.fixedpoint_set_params(ctx, fp, p)
  Z3.params_dec_ref(ctx, p)
  Z3.param_descrs_dec_ref(ctx, descrs)
  return refused
}

/**
 * The Z3 sort for a declared variable.
 *
 * An `enum` becomes an INT with range constraints rather than a Z3 finite-domain or
 * datatype sort, and that choice is worth stating. A finite-domain sort would be the
 * natural spelling, but Spacer's support for it is far less exercised than its
 * arithmetic support, and the donor's measured scaling numbers (122ms at 400 state
 * variables) are all on bool/int models. Ints with `0 <= x < |domain|` keep the tier
 * on the path that was measured, and the member↔index mapping is total and injective,
 * so nothing is lost semantically — a member name is recovered for evidence by
 * indexing back into the declared domain.
 */
const sortFor = (Z3: LowLevelZ3, ctx: Ast, variable: StateVariable): Ast =>
  variable.type === 'bool' ? Z3.mk_bool_sort(ctx) : Z3.mk_int_sort(ctx)

/**
 * The compiler from a validated {@link Expr} to a Z3 term.
 *
 * Takes the variable→term binding as a MAP, which is what makes one compiler serve
 * both the pre-state and the post-state: the transition relation needs `x` and `x'`
 * compiled from the same AST with different bindings, and a compiler that resolved
 * names itself would need two copies.
 *
 * Every `ref` is either in the binding or an enum MEMBER, because the expression was
 * validated — see {@link PreparedModel}. An unresolvable name here would be a defect
 * in the validator, not in a document, so it throws rather than returning an error
 * value: it is unreachable, and a silent fallback would hide the validator bug.
 */
const compile = (
  Z3: LowLevelZ3,
  ctx: Ast,
  expr: Expr,
  binding: ReadonlyMap<string, Ast>,
  vars: DeclaredVars,
): Ast => {
  const go = (node: Expr): Ast => compile(Z3, ctx, node, binding, vars)
  switch (expr.kind) {
    case 'bool':
      return expr.value ? Z3.mk_true(ctx) : Z3.mk_false(ctx)
    case 'int':
      return Z3.mk_numeral(ctx, String(expr.value), Z3.mk_int_sort(ctx))
    case 'ref': {
      const bound = binding.get(expr.name)
      if (bound !== undefined) return bound
      // An enum member: compiled to its INDEX in the declared domain, which is the
      // same encoding `sortFor` gives the variable.
      const index = enumMemberIndex(expr.name, vars)
      if (index !== undefined) {
        return Z3.mk_numeral(ctx, String(index), Z3.mk_int_sort(ctx))
      }
      throw new Error(
        `reachability: "${expr.name}" resolved to neither a declared variable nor an enum member. ` +
          'The expression should have been refused by core/state-expr.ts before reaching the encoder.',
      )
    }
    case 'not':
      return Z3.mk_not(ctx, go(expr.operand))
    case 'and':
      return Z3.mk_and(ctx, expr.operands.map(go))
    case 'or':
      return Z3.mk_or(ctx, expr.operands.map(go))
    case 'arith':
      return expr.op === '+'
        ? Z3.mk_add(ctx, [go(expr.left), go(expr.right)])
        : Z3.mk_sub(ctx, [go(expr.left), go(expr.right)])
    case 'compare': {
      const left = go(expr.left)
      const right = go(expr.right)
      switch (expr.op) {
        case '=':
          return Z3.mk_eq(ctx, left, right)
        case '!=':
          return Z3.mk_not(ctx, Z3.mk_eq(ctx, left, right))
        case '<':
          return Z3.mk_lt(ctx, left, right)
        case '<=':
          return Z3.mk_le(ctx, left, right)
        case '>':
          return Z3.mk_gt(ctx, left, right)
        case '>=':
          return Z3.mk_ge(ctx, left, right)
      }
    }
  }
}

/** The index of an enum member in its owning variable's declared domain, or
 * `undefined` when the name is not a member of any declared enum. */
const enumMemberIndex = (name: string, vars: DeclaredVars): number | undefined => {
  for (const variable of vars.values()) {
    if (variable.type !== 'enum') continue
    const index = variable.domain.indexOf(name)
    if (index >= 0) return index
  }
  return undefined
}

/** The range constraint a variable's declared domain imposes, if any. Applied to both
 * the pre- and post-state so a bounded int stays bounded across a transition. */
const rangeConstraints = (
  Z3: LowLevelZ3,
  ctx: Ast,
  variables: readonly StateVariable[],
  binding: ReadonlyMap<string, Ast>,
): readonly Ast[] => {
  const int = (n: number) => Z3.mk_numeral(ctx, String(n), Z3.mk_int_sort(ctx))
  const found: Ast[] = []
  for (const variable of variables) {
    const term = binding.get(variable.name)
    if (term === undefined) continue
    if (variable.type === 'enum') {
      // The member-index encoding: `0 <= x <= |domain| - 1`. Without this the solver
      // could reach an index no member maps to, producing a "counterexample" whose
      // state has no readable rendering — a false positive from the encoding.
      found.push(Z3.mk_ge(ctx, term, int(0)))
      found.push(Z3.mk_le(ctx, term, int(variable.domain.length - 1)))
      continue
    }
    if (variable.type === 'int' && variable.domain !== undefined) {
      if (variable.domain.min !== undefined)
        found.push(Z3.mk_ge(ctx, term, int(variable.domain.min)))
      if (variable.domain.max !== undefined)
        found.push(Z3.mk_le(ctx, term, int(variable.domain.max)))
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The encoding
// ---------------------------------------------------------------------------

/** One built Horn system, ready to query, plus what is needed to re-check its answer. */
interface HornSystem {
  readonly fp: Ast
  readonly badRelation: Ast
  readonly invRelation: Ast
  /** Pre-state variable terms, in declaration order. */
  readonly pre: readonly Ast[]
  /** Post-state variable terms, in declaration order. */
  readonly post: readonly Ast[]
  readonly preBinding: ReadonlyMap<string, Ast>
  readonly postBinding: ReadonlyMap<string, Ast>
  /** The initial-state predicate, as ONE term over `pre`. */
  readonly initTerm: Ast
  /** The transition relation, as ONE term over `pre` and `post` — the disjunction of
   * every requirement's effect. Kept so the certificate check can re-use THE SAME
   * encoding rather than re-deriving one from the document. */
  readonly transitionTerm: Ast
  /** The negated constraint — the "bad" state — as one term over `pre`. */
  readonly badTerm: Ast
}

/**
 * Build the Horn system for ONE constraint.
 *
 * ## The shape
 *
 * Two relations: `Inv(x…)` over the state, and `Bad()` nullary. Three rule families:
 *
 * ```
 *   Init(x)              ⇒ Inv(x)          named `init`
 *   Inv(x) ∧ Tᵢ(x, x')   ⇒ Inv(x')         named after requirement i
 *   Inv(x) ∧ ¬C(x)       ⇒ Bad()           named after the constraint's requirement
 * ```
 *
 * and the query is `Bad()`. So `unsat` (no derivation of `Bad`) means the constraint
 * holds over ALL reachable states — the unbounded proof — and `sat` means a reachable
 * violation exists. That is interface A's polarity; see {@link verdictOfLbool}.
 *
 * ## `framed` is the ONE bit that changes the transition relation
 *
 * With `framed: false` (the STRICT run), a variable an effect does not write is
 * UNCONSTRAINED in the post-state: it may change spontaneously. With `framed: true`,
 * a variable declared `frame: stable` and not written by this effect is pinned
 * (`x' = x`). Nothing else differs between the two runs, which is what makes their
 * DIVERGENCE a clean detector for "the frame was load-bearing here" (AC-2-5) rather
 * than a comparison of two unrelated encodings.
 *
 * Note what `framed: true` does NOT do: it never pins a `volatile` variable. The frame
 * is per-variable and opt-in, so the framed run is exactly the document's declared
 * hypotheses and no more.
 *
 * ## Rules are added with per-requirement NAMES
 *
 * `fixedpoint_add_rule(ctx, fp, rule, mk_string_symbol(label))` — required for V29's
 * trace to cite requirements instead of `<null>`. The label is the requirement's own
 * stable key where it has one, so the trace reads in the author's vocabulary.
 */
const buildSystem = (
  Z3: LowLevelZ3,
  ctx: Ast,
  prepared: PreparedModel,
  constraint: ConstraintRule,
  frame: FrameMode,
  timeoutMs: number,
): { readonly system: HornSystem; readonly refusedParams: readonly string[] } => {
  const sym = (s: string) => Z3.mk_string_symbol(ctx, s)
  const fp = Z3.mk_fixedpoint(ctx)
  Z3.fixedpoint_inc_ref(ctx, fp)

  // ONLY DECLARED PARAMS (V21). `engine` and `timeout` are both declared on 5.0.0;
  // `rlimit` is declared too but is NOT used — measured as a hard hang on this path.
  // `global_param_set` is never used, for the same reason.
  const refusedParams = setDeclaredParams(Z3, ctx, fp, { engine: 'spacer', timeout: timeoutMs })

  const sorts = prepared.variables.map((v) => sortFor(Z3, ctx, v))
  const invRelation = Z3.mk_func_decl(ctx, sym('Inv'), sorts, Z3.mk_bool_sort(ctx))
  const badRelation = Z3.mk_func_decl(ctx, sym('Bad'), [], Z3.mk_bool_sort(ctx))
  Z3.fixedpoint_register_relation(ctx, fp, invRelation)
  Z3.fixedpoint_register_relation(ctx, fp, badRelation)

  // Pre- and post-state constants. Distinct names, so one quantifier can bind both.
  const pre = prepared.variables.map((v, i) => Z3.mk_const(ctx, sym(`s_${v.name}`), sorts[i]))
  const post = prepared.variables.map((v, i) => Z3.mk_const(ctx, sym(`t_${v.name}`), sorts[i]))
  const preBinding = new Map(prepared.variables.map((v, i) => [v.name, pre[i]]))
  const postBinding = new Map(prepared.variables.map((v, i) => [v.name, post[i]]))

  const and = (terms: readonly Ast[]): Ast =>
    terms.length === 0 ? Z3.mk_true(ctx) : terms.length === 1 ? terms[0] : Z3.mk_and(ctx, terms)
  const app = (decl: Ast, args: readonly Ast[]) => Z3.mk_app(ctx, decl, args)
  const forall = (bound: readonly Ast[], body: Ast) =>
    bound.length === 0 ? body : Z3.mk_forall_const(ctx, 0, bound, [], body)
  const rule = (body: Ast, head: Ast, name: string) => {
    // The bound variables are every pre- AND post-state constant, because a rule body
    // may mention either. Z3 is content with a quantifier binding a variable the body
    // does not use, and enumerating both sets keeps rule construction uniform.
    const quantified = forall([...pre, ...post], Z3.mk_implies(ctx, body, head))
    return Z3.fixedpoint_add_rule(ctx, fp, quantified, sym(name))
  }

  // --- INIT ------------------------------------------------------------------
  const initTerm = and([
    ...prepared.initial.map((e) => compile(Z3, ctx, e, preBinding, prepared.vars)),
    ...rangeConstraints(Z3, ctx, prepared.variables, preBinding),
  ])
  const initRule = forall(pre, Z3.mk_implies(ctx, initTerm, app(invRelation, pre)))
  Z3.fixedpoint_add_rule(ctx, fp, initRule, sym('init'))

  // --- TRANSITIONS -----------------------------------------------------------
  // One rule per effect, and the disjunction of their bodies is the transition
  // relation the certificate check re-uses.
  const transitions: Ast[] = []
  for (const { label, effect } of prepared.effects) {
    const written = writesOf(effect.assignments)
    const updates: Ast[] = []
    // THE GUARD, over the PRE-state: the effect fires only from a state satisfying it.
    // An absent guard contributes nothing, so the effect is available everywhere —
    // which is the sound default, since it admits more transitions and therefore makes
    // strictly fewer things provable.
    if (effect.guard !== undefined) {
      updates.push(compile(Z3, ctx, effect.guard, preBinding, prepared.vars))
    }
    for (const assignment of effect.assignments) {
      const target = postBinding.get(assignment.target)
      if (target === undefined) continue
      updates.push(
        Z3.mk_eq(ctx, target, compile(Z3, ctx, assignment.value, preBinding, prepared.vars)),
      )
    }
    // THE FRAME — the ONLY thing that differs between the runs. Which variables get
    // pinned is the whole content of `FrameMode`; see its header for why this is three
    // modes and not a boolean.
    const pinned =
      frame === 'none'
        ? []
        : frame === 'full'
          ? prepared.variables.map((v) => v.name)
          : prepared.stableVars
    for (const name of pinned) {
      // A variable this effect WRITES is never pinned — the write is the point.
      if (written.has(name)) continue
      const before = preBinding.get(name)
      const after = postBinding.get(name)
      if (before !== undefined && after !== undefined) updates.push(Z3.mk_eq(ctx, after, before))
    }
    const body = and([...updates, ...rangeConstraints(Z3, ctx, prepared.variables, postBinding)])
    transitions.push(body)
    rule(and([app(invRelation, pre), body]), app(invRelation, post), label)
  }
  const transitionTerm =
    transitions.length === 0
      ? // NO EFFECTS AT ALL. The transition relation is EMPTY, so the only reachable
        // states are the initial ones. `false` is the honest encoding of that, and the
        // check integration reports the empty relation as its own disclosure — a model
        // with no transitions is a single frozen state, over which an invariant holding
        // says almost nothing.
        Z3.mk_false(ctx)
      : transitions.length === 1
        ? transitions[0]
        : Z3.mk_or(ctx, transitions)

  // --- THE BAD STATE ---------------------------------------------------------
  // `Inv(x) ∧ ¬C(x) ⇒ Bad()`. Named after the constraint's OWN requirement, so a trace
  // ends with the requirement whose property was violated.
  const badTerm = Z3.mk_not(ctx, compile(Z3, ctx, constraint.predicate, preBinding, prepared.vars))
  Z3.fixedpoint_add_rule(
    ctx,
    fp,
    forall(pre, Z3.mk_implies(ctx, and([app(invRelation, pre), badTerm]), app(badRelation, []))),
    sym(constraint.label),
  )

  return {
    system: {
      fp,
      badRelation,
      invRelation,
      pre,
      post,
      preBinding,
      postBinding,
      initTerm,
      transitionTerm,
      badTerm,
    },
    refusedParams,
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** The inferred invariant, as evidence. */
export interface InvariantEvidence {
  /** The invariant's printed form, CANONICALIZED for display. Never asserted on by a
   * test and never load-bearing — the certificate check is what makes the claim, and
   * operand order is not stable across configurations. */
  readonly invariant: string
  /** Whether all three certificate obligations discharged (V28). */
  readonly certificateVerified: boolean
  /** Which obligation failed, when one did. */
  readonly failedObligation?: string
}

/** One step of a counterexample trace. */
export interface TraceStep {
  /** The requirement key (or `init`) whose rule fired. */
  readonly rule: string
}

/** A counterexample, as evidence. */
export interface TraceEvidence {
  /** The rules that fired, in FORWARD order (init first, violation last). */
  readonly steps: readonly TraceStep[]
}

/**
 * Strip Spacer's `:weight 0` annotations and collapse whitespace, for display.
 *
 * Cosmetic, and deliberately nothing more. An earlier design canonicalized operand
 * ORDER too, to make the text stable enough to assert on; that was abandoned in favour
 * of the certificate check, which makes the text non-load-bearing so its stability
 * stops mattering. Reformatting it further would only invite someone to write a golden
 * test against it.
 */
const forDisplay = (text: string): string =>
  text
    .replace(/\s*:weight\s+\d+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Find the `(= (Inv …) BODY)` equation inside Spacer's answer, returning the bound
 * variables and the body.
 *
 * This is what makes the certificate check possible: the answer is
 * `(and (= Bad …) (forall ((A …)) (! (= (Inv A) BODY) :weight 0)))`, and the three
 * obligations need BODY with the quantifier's de-Bruijn variables substituted by the
 * caller's own state constants.
 *
 * ## A Z3 AST IS A DAG, AND AN UN-MEMOIZED WALK OF IT DOES NOT TERMINATE
 *
 * This is a NEW surprise, measured here rather than inherited from the donor's catalog,
 * and it is worth stating precisely because the symptom is indistinguishable from the
 * V14/V21 solver hang it is not.
 *
 * Z3 hash-conses every term, so identical subterms are ONE shared node with many
 * parents. Printed, the answer for the 1-variable lock model is **185 characters**. Walked
 * as if it were a tree, it exceeds **2,000,000 node visits at depth 7** and never
 * finishes — measured. So the first version of this function hung the reachability tier
 * for 190s on a model whose query had already returned `unsat` in 860ms, and the hang
 * looked exactly like a solver hang: same symptom, completely different cause. It was
 * found by instrumenting stages, not by reading the code.
 *
 * `Z3_get_ast_id` is the fix: a stable per-node identifier, so a `Set` of visited ids
 * turns exponential re-traversal into linear. The DEPTH CAP is kept as well, because the
 * two bound different things — the memo bounds total WORK, the cap bounds STACK — and
 * a deep-but-narrow term would still overflow without it.
 *
 * Walks with `get_ast_kind` rather than `is_quantifier_ast`, which DOES NOT EXIST on
 * 5.0.0 — a second API surprise beyond the donor's catalog.
 */
const findInvariantBody = (
  Z3: LowLevelZ3,
  ctx: Ast,
  root: Ast,
): { readonly boundArgs: readonly Ast[]; readonly body: Ast } | undefined => {
  // The MEMO, keyed on Z3's own stable node id.
  //
  // It records nodes ALREADY SEARCHED AND FOUND NOTHING, which is a different statement
  // from "already visited" and the distinction cost a debugging cycle. A memo that
  // short-circuits before the sibling scan makes the FIRST unproductive branch abort the
  // whole search: the answer is `(and (= Bad …) (forall … (= (Inv A) BODY)))`, so marking
  // the top-level `and` visited and returning `undefined` from branch 0 skipped branch 1
  // — the only branch that holds the invariant. Symptom: a fast, confident "the answer
  // carried no readable Inv definition" on an answer that plainly contains one.
  //
  // Recording only on the way OUT of a fruitless subtree keeps both properties: shared
  // subterms are searched once (the DAG stays linear), and a sibling is never skipped.
  const exhausted = new Set<number>()

  const walk = (
    ast: Ast,
    depth: number,
  ): { readonly boundArgs: readonly Ast[]; readonly body: Ast } | undefined => {
    if (depth > 32) return undefined
    const id = Z3.get_ast_id(ctx, ast) as number
    // Already searched, nothing in it. Note this is checked but NOT set here — see the
    // note on `exhausted`; it is recorded only when a subtree has been fully searched.
    if (exhausted.has(id)) return undefined

    if (Z3.get_ast_kind(ctx, ast) === AST_KIND_QUANTIFIER) {
      const inner = walk(Z3.get_quantifier_body(ctx, ast), depth + 1)
      if (inner === undefined) exhausted.add(id)
      return inner
    }
    // GATE ON THE KIND. `to_app` on a de Bruijn VAR returns garbage with a 30-million
    // arity rather than throwing — see {@link isApp}. This one test is what keeps the
    // walk linear instead of taking 29.7 seconds.
    if (!isApp(Z3, ctx, ast)) {
      exhausted.add(id)
      return undefined
    }

    const a = Z3.to_app(ctx, ast)
    const name = Z3.get_symbol_string(ctx, Z3.get_decl_name(ctx, Z3.get_app_decl(ctx, a)))
    const arity = Z3.get_app_num_args(ctx, a)
    if (name === '=' && arity === 2) {
      const lhs = Z3.get_app_arg(ctx, a, 0)
      if (isApp(Z3, ctx, lhs)) {
        const lhsApp = Z3.to_app(ctx, lhs)
        const lhsName = Z3.get_symbol_string(
          ctx,
          Z3.get_decl_name(ctx, Z3.get_app_decl(ctx, lhsApp)),
        )
        if (lhsName === 'Inv') {
          const boundArgs: Ast[] = []
          for (let i = 0; i < Z3.get_app_num_args(ctx, lhsApp); i += 1) {
            boundArgs.push(Z3.get_app_arg(ctx, lhsApp, i))
          }
          return { boundArgs, body: Z3.get_app_arg(ctx, a, 1) }
        }
      }
    }
    for (let i = 0; i < arity; i += 1) {
      const found = walk(Z3.get_app_arg(ctx, a, i), depth + 1)
      if (found !== undefined) return found
    }
    // Every child searched, nothing found. NOW it is exhausted.
    exhausted.add(id)
    return undefined
  }

  return walk(root, 0)
}

/**
 * INDEPENDENTLY re-check Spacer's `unsat` (V28) — three plain-SMT obligations, each
 * discharged by asserting its NEGATION and requiring `unsat`.
 *
 * ```
 *   Init  ⇒ Inv            the invariant covers every initial state
 *   Inv ∧ T ⇒ Inv'         it is inductive under the transition relation
 *   Inv   ⇒ ¬Bad           and it excludes the bad state
 * ```
 *
 * Measured working on a real lock/pending model, with the negative control confirming
 * teeth: substituting the vacuously-true `Inv = true` satisfies the first two trivially
 * and is CORRECTLY REJECTED at the third.
 *
 * ## The obligations use THE SAME ENCODING the rules came from
 *
 * `system.initTerm`, `system.transitionTerm` and `system.badTerm` are the very terms
 * the Horn rules were built from, not re-derived from the document. That is the AC-1-3
 * lesson stated as code: the donor's exported `.smt2` answered a WEAKER question than
 * its in-process tier and returned `sat` where the tier proved `unsat`. A certificate
 * check built from a second derivation would validate a different question and be
 * theater.
 *
 * Every solver call goes through `interruptibleSolve`, awaited one at a time.
 */
const checkCertificate = (
  Z3: LowLevelZ3,
  ctx: Ast,
  system: HornSystem,
  answer: Ast,
  timeoutMs: number,
): Effect.Effect<{ readonly verified: boolean; readonly failed?: string }, never, SolverService> =>
  Effect.gen(function* () {
    const solver = yield* SolverService
    const found = findInvariantBody(Z3, ctx, answer)
    if (found === undefined) {
      // No readable invariant in the answer. Reported as UNVERIFIED rather than as a
      // pass: the contract is "never report proven unless it is proven", and an answer
      // this code cannot re-check has not been re-checked.
      return { verified: false, failed: 'the answer carried no readable Inv definition' }
    }

    const invAt = (values: readonly Ast[]): Ast =>
      Z3.substitute(ctx, found.body, found.boundArgs, values)
    const not = (t: Ast) => Z3.mk_not(ctx, t)
    const implies = (a: Ast, b: Ast) => Z3.mk_implies(ctx, a, b)
    const forall = (bound: readonly Ast[], body: Ast) =>
      bound.length === 0 ? body : Z3.mk_forall_const(ctx, 0, bound, [], body)

    /**
     * Discharge one obligation: assert its negation, require `unsat`.
     *
     * BOUNDED by the same per-query timeout the Spacer query used. An unbounded
     * obligation would be a second way for this tier to hang — the certificate check
     * runs plain SMT over a quantified formula, which is decidable here but not
     * guaranteed fast on a larger model — and an unbounded solver call inside the
     * mitigation for a hang would be an unfortunate place to leave one. A timed-out
     * obligation returns `unknown`, which is not `-1` and therefore FAILS the check:
     * an obligation that could not be discharged has not been discharged.
     */
    const discharge = (label: string, formula: Ast) =>
      Effect.gen(function* () {
        const s = Z3.mk_solver(ctx)
        Z3.solver_inc_ref(ctx, s)
        const params = Z3.mk_params(ctx)
        Z3.params_inc_ref(ctx, params)
        Z3.params_set_uint(ctx, params, Z3.mk_string_symbol(ctx, 'timeout'), timeoutMs)
        Z3.solver_set_params(ctx, s, params)
        Z3.params_dec_ref(ctx, params)
        Z3.solver_assert(ctx, s, not(formula))
        const lbool = yield* solver.solve(
          {
            start: () => Z3.solver_check(ctx, s) as Promise<number>,
            // The OWNING context's interrupt. Interrupting a different context does
            // nothing, which is why the primitive takes it rather than deriving it.
            interrupt: () => {
              Z3.interrupt(ctx)
            },
          },
          // An interrupted obligation resumes as `0` (unknown), which is NOT `-1` and
          // therefore fails the check — the conservative direction. An interrupted
          // re-check has not verified anything.
          0,
        )
        Z3.solver_dec_ref(ctx, s)
        return { label, holds: lbool === -1 }
      })

    const obligations = [
      {
        label: 'Init => Inv',
        formula: forall(system.pre, implies(system.initTerm, invAt(system.pre))),
      },
      {
        label: "Inv & T => Inv'",
        formula: forall(
          [...system.pre, ...system.post],
          implies(Z3.mk_and(ctx, [invAt(system.pre), system.transitionTerm]), invAt(system.post)),
        ),
      },
      {
        label: 'Inv => !Bad',
        formula: forall(system.pre, implies(invAt(system.pre), not(system.badTerm))),
      },
    ]

    // SEQUENTIAL, never `Effect.forEach({concurrency})`. Asyncify holds one slot.
    for (const obligation of obligations) {
      const result = yield* discharge(obligation.label, obligation.formula)
      if (!result.holds) return { verified: false, failed: result.label }
    }
    return { verified: true }
  })

/**
 * Extract the counterexample trace, LAST and defensively (V29).
 *
 * Three measured facts shape this:
 *
 * - `get_rules_along_trace` is the call that works; `get_ground_sat_answer` returns
 *   literal `false` on this shape and `getAnswer` returns a proof term.
 * - `get_rule_names_along_trace` returns ONE symbol containing every name joined by
 *   `;`, leading with a `<null>` for the query itself. Verified on 5.0.0:
 *   `"<null>;R-bad;R-set;R-tick;R-tick;R-tick;R-init"`.
 * - The order is REVERSED (violation first, initial state last), so it is reversed
 *   here to read forward.
 *
 * Wrapped in try/catch AND called last, because those defend against different things:
 * the catch handles a throw, and the ORDERING is the only defense against a
 * `shared_occs` assertion, which would abort the process rather than throw.
 */
const extractTrace = (Z3: LowLevelZ3, ctx: Ast, fp: Ast): TraceEvidence => {
  try {
    const symbol = Z3.fixedpoint_get_rule_names_along_trace(ctx, fp)
    const joined = Z3.get_symbol_string(ctx, symbol) as string
    const steps = joined
      .split(';')
      .map((name) => name.trim())
      // The leading `<null>` is the query relation itself, which is not a rule an
      // author wrote — dropping it keeps the trace to requirements and `init`.
      .filter((name) => name.length > 0 && name !== '<null>')
      .reverse()
      .map((rule) => ({ rule }))
    return { steps }
  } catch {
    // A trace is EVIDENCE, not a verdict. Failing to extract one must not turn a
    // sound `reachable` into an error, so the finding is reported with no steps and
    // the check integration says so rather than pretending to a trace it does not have.
    return { steps: [] }
  }
}

// ---------------------------------------------------------------------------
// One constraint, end to end
// ---------------------------------------------------------------------------

/** The result of asking about ONE constraint. */
export interface ConstraintResult {
  readonly label: string
  readonly requirementId: string
  /** The frame-aware verdict (AC-2-5). */
  readonly verdict: FrameVerdict
  /** The strict (no-frame) run's raw verdict — retained because the two runs' verdicts
   * ARE the frame-was-load-bearing detector, so both belong in the record. */
  readonly strict: ReachabilityVerdict
  /** The framed run's verdict, when a framed run was performed. */
  readonly framed?: ReachabilityVerdict
  /** Present on a PROVED / PROVED_UNDER_HYPOTHESES verdict. */
  readonly invariant?: InvariantEvidence
  /** Present on a VIOLATED verdict. */
  readonly trace?: TraceEvidence
  /** Present on UNKNOWN — derived out-of-band from the clock, never from
   * `reason_unknown` (V15). */
  readonly unknownReason?: UnknownReason
  /**
   * Params the encoder tried to set that this z3 build does not DECLARE (V21).
   *
   * Empty on every healthy run, and that is the point: it is the observable that a
   * future edge adding an undeclared param (the research doc's own `random_seed`
   * recommendation, say) was CAUGHT rather than silently voiding the timeout. Carried
   * per-constraint because that is where the systems are built, and rolled up onto
   * {@link ReachabilityReport}.
   */
  readonly refusedParams: readonly string[]
  /** The stable variables the proof relied on, on PROVED_UNDER_HYPOTHESES. Named with
   * their writers, so the disclosure is actionable. */
  readonly hypotheses?: readonly {
    readonly variable: string
    readonly writers: readonly string[]
  }[]
  /** Wall-clock ms for every query this constraint needed. Reported, never gated on. */
  readonly elapsedMs: number
}

/** Run ONE query on a freshly built system, returning its verdict and evidence. */
const runQuery = (
  Z3: LowLevelZ3,
  ctx: Ast,
  prepared: PreparedModel,
  constraint: ConstraintRule,
  frame: FrameMode,
  timeoutMs: number,
): Effect.Effect<
  {
    readonly verdict: ReachabilityVerdict
    readonly elapsedMs: number
    readonly system: HornSystem
    readonly answer?: Ast
    readonly refusedParams: readonly string[]
  },
  never,
  SolverService
> =>
  Effect.gen(function* () {
    const solver = yield* SolverService
    const { system, refusedParams } = buildSystem(Z3, ctx, prepared, constraint, frame, timeoutMs)
    const query = Z3.mk_app(ctx, system.badRelation, [])

    const startedAt = Date.now()
    const lbool = yield* solver.solve(
      {
        start: () => Z3.fixedpoint_query(ctx, system.fp, query) as Promise<number>,
        interrupt: () => {
          Z3.interrupt(ctx)
        },
      },
      // An interrupted reachability query resumes as `0` — UNKNOWN, which always
      // demotes. Never `-1`: resuming as "unreachable" would turn a cancellation into
      // a fabricated proof, which is the worst available failure for this tier.
      0,
    )
    const elapsedMs = Date.now() - startedAt
    const verdict = verdictOfLbool(lbool)

    // The INVARIANT is read before the trace, per the V29 ordering mitigation.
    let answer: Ast | undefined
    if (verdict === 'unreachable') {
      try {
        answer = Z3.fixedpoint_get_answer(ctx, system.fp)
      } catch {
        answer = undefined
      }
    }

    return {
      verdict,
      elapsedMs,
      system,
      ...(answer !== undefined ? { answer } : {}),
      refusedParams,
    }
  })

/**
 * Decide ONE constraint, running the prove-twice protocol (AC-2-5).
 *
 * ## The order of work, and why each step is where it is
 *
 * 1. **The `none` run** (nothing pinned). `unreachable` here is `PROVED` — the strongest
 *    answer available, holding with nothing assumed beyond the document — and no second
 *    query is paid for. This is the cheap path AND the honest one.
 * 2. A `none`-run `reachable` is NOT yet a defect: with nothing pinned a variable may
 *    change spontaneously, so the witness may use a transition the document never
 *    licensed. Which second run to make depends on what the document declared:
 *    - variables declared `frame: stable` ⇒ the **`declared`** run, which asks whether
 *      the property holds under the document's OWN stated assumptions. Unreachable there
 *      is `PROVED_UNDER_HYPOTHESES` (demoted, hypotheses named); reachable is `VIOLATED`.
 *    - nothing declared ⇒ the **`full`** run, which pins every variable an effect does
 *      not write. Reachable there means every step is requirement-sanctioned, so the
 *      counterexample is real and the verdict is `VIOLATED`. Unreachable means the only
 *      route used an unsanctioned change: `UNKNOWN`, because that is neither a defect nor
 *      a proof.
 * 3. Any `unknown` at any point demotes and is never reported as proven.
 *
 * The `full` run in step 2 is what the first implementation lacked, and its absence was a
 * real soundness bug rather than a gap: with nothing declared `stable` the "framed" run
 * was byte-identical to the strict one, so every `none`-reachable became an
 * error-severity `VIOLATED`. The worked lock/grant fixture caught it — a lock-count
 * constraint reported violated by a requirement that only touches `idle`. See
 * {@link FrameMode}.
 *
 * Cost is ~2× on the paths needing both runs, which the donor's measurements make
 * immaterial: 122ms at 400 state variables.
 */
export const decideConstraint = (
  Z3: LowLevelZ3,
  ctx: Ast,
  prepared: PreparedModel,
  constraint: ConstraintRule,
  timeoutMs: number,
): Effect.Effect<ConstraintResult, never, SolverService> =>
  Effect.gen(function* () {
    const openRun = yield* runQuery(Z3, ctx, prepared, constraint, 'none', timeoutMs)
    let elapsedMs = openRun.elapsedMs

    /** Assemble the invariant evidence for a run that proved unreachable. */
    const invariantOf = (run: typeof openRun) =>
      Effect.gen(function* () {
        if (run.answer === undefined) {
          return {
            invariant: '(the solver returned no readable invariant)',
            certificateVerified: false,
            failedObligation: 'no invariant was available to re-check',
          } satisfies InvariantEvidence
        }
        const certificate = yield* checkCertificate(Z3, ctx, run.system, run.answer, timeoutMs)
        return {
          invariant: forDisplay(Z3.ast_to_string(ctx, run.answer) as string),
          certificateVerified: certificate.verified,
          ...(certificate.failed !== undefined ? { failedObligation: certificate.failed } : {}),
        } satisfies InvariantEvidence
      })

    const base = { label: constraint.label, requirementId: constraint.requirementId }

    // (1) Unreachable with NOTHING assumed ⇒ PROVED, frame-closed. No second query.
    if (openRun.verdict === 'unreachable') {
      return {
        ...base,
        verdict: 'PROVED' as const,
        strict: openRun.verdict,
        invariant: yield* invariantOf(openRun),
        elapsedMs,
        refusedParams: openRun.refusedParams,
      }
    }

    if (openRun.verdict === 'unknown') {
      return {
        ...base,
        verdict: 'UNKNOWN' as const,
        strict: openRun.verdict,
        // OUT-OF-BAND (V15): `reason_unknown` says "ok" on a timeout, so the clock
        // decides. `"ok"` never reaches a caller.
        unknownReason: classifyUnknown(openRun.elapsedMs, timeoutMs),
        elapsedMs,
        refusedParams: openRun.refusedParams,
      }
    }

    // (2) Reachable with nothing pinned. The FRAMED run — every unwritten variable pinned
    // — decides whether that is a real defect or an artifact of assuming nothing.
    const framedRun = yield* runQuery(Z3, ctx, prepared, constraint, 'full', timeoutMs)
    elapsedMs += framedRun.elapsedMs
    let refusedParams = [...new Set([...openRun.refusedParams, ...framedRun.refusedParams])]
    const verdict = decideFrameVerdict(openRun.verdict, framedRun.verdict)

    if (verdict === 'PROVED_UNDER_HYPOTHESES') {
      const writers = writeSetOf(prepared)
      // MINIMIZE THE FRAME SET (decision-doc design rule 3), so the disclosure names what
      // the proof actually needs rather than everything that happened to be pinned.
      //
      // One extra query, and only when the document declared something: if the DECLARED
      // stable set alone carries the proof, the hypothesis is exactly what the author
      // wrote down — a far more actionable disclosure than "all 6 variables". When it does
      // not (or nothing was declared), the honest hypothesis is every variable the maximal
      // frame pinned, and saying so is the point.
      let hypothesisVars = prepared.variables.map((v) => v.name)
      if (prepared.stableVars.length > 0) {
        const declaredRun = yield* runQuery(Z3, ctx, prepared, constraint, 'declared', timeoutMs)
        elapsedMs += declaredRun.elapsedMs
        refusedParams = [...new Set([...refusedParams, ...declaredRun.refusedParams])]
        if (declaredRun.verdict === 'unreachable') hypothesisVars = [...prepared.stableVars]
      }
      return {
        ...base,
        verdict,
        strict: openRun.verdict,
        framed: framedRun.verdict,
        invariant: yield* invariantOf(framedRun),
        // The variables the proof LEANED ON, each with its writers — which is what turns
        // "this is conditional" into "this depends on granted changing only via TX-A1,
        // TX-A2". A variable written by NO requirement is the V16 shape, and showing an
        // empty writer list is how that becomes visible.
        hypotheses: hypothesisVars.map((variable) => ({
          variable,
          writers: writers.get(variable) ?? [],
        })),
        elapsedMs,
        refusedParams,
      }
    }

    if (verdict === 'UNKNOWN') {
      return {
        ...base,
        verdict,
        strict: openRun.verdict,
        framed: framedRun.verdict,
        unknownReason: classifyUnknown(framedRun.elapsedMs, timeoutMs),
        elapsedMs,
        refusedParams,
      }
    }

    // VIOLATED. The trace comes from the FRAMED run, never the unpinned one: under full
    // framing every step is a requirement-sanctioned change, so the witness is a real
    // behavior of the described system. The unpinned run's witness may include a
    // spontaneous change, which is exactly what would make the trace fiction.
    return {
      ...base,
      verdict: 'VIOLATED' as const,
      strict: openRun.verdict,
      framed: framedRun.verdict,
      trace: extractTrace(Z3, ctx, framedRun.system.fp),
      elapsedMs,
      refusedParams,
    }
  })

// ---------------------------------------------------------------------------
// The tier
// ---------------------------------------------------------------------------

/** Everything one reachability run produced. */
export interface ReachabilityReport {
  /** One entry per encodable constraint, in stable requirement order. */
  readonly results: readonly ConstraintResult[]
  /** Requirements the tier could not read, each with why. Never silently dropped. */
  readonly skipped: readonly { readonly label: string; readonly reason: string }[]
  /** How many requirements contributed a transition. */
  readonly effects: number
  /** Declared variables. */
  readonly variables: number
  /** Variables declared `stable` but written by NO requirement — the V16 shape. */
  readonly frameDrift: readonly string[]
  /** True when NO requirement contributes a transition, so the only reachable states
   * are the initial ones. An invariant holding over a frozen state says almost
   * nothing, so this is disclosed. */
  readonly emptyTransitionRelation: boolean
  /** Params the run REFUSED to set because the build does not declare them (V21).
   * Empty on every healthy run; non-empty means a code change tried to set one and
   * the guard caught it before it could void the timeout. */
  readonly refusedParams: readonly string[]
  /** Total wall-clock ms across every query. Reported, never gated on. */
  readonly elapsedMs: number
  /** The per-query timeout that was set, so a caller can interpret an
   * `unknownReason` without re-deriving it. */
  readonly timeoutMs: number
}

/** The default per-query timeout. 2000ms matches `check --timeout-ms`'s default, and
 * sits well above the measured ~150ms one-time WASM/parse floor below which a timeout
 * is not honored. */
export const DEFAULT_REACHABILITY_TIMEOUT_MS = 2000

/**
 * Run the reachability tier over a document.
 *
 * A FRESH Z3 context per run (cheap against 30-300ms queries) removes the
 * evidence-stability question and any cumulative-budget hazard at once. Constraints
 * are decided SEQUENTIALLY — never `Effect.forEach({concurrency})`, because Asyncify
 * holds one capability slot and parallel queries would wedge the module.
 */
export const runReachability = (
  document: RequirementsDocument,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<ReachabilityReport, never, SolverService> =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS
    const prepared = prepareModel(document)
    const service = yield* SolverService
    const { module } = yield* service.boot
    const Z3 = (module as unknown as { Z3: LowLevelZ3 }).Z3
    // A FRESH context, named for the tier so a leak is attributable.
    const ctx = Z3.mk_context(Z3.mk_config())

    const results: ConstraintResult[] = []
    const refused = new Set<string>()
    let elapsedMs = 0

    // SEQUENTIAL. See the module header's "NEVER PARALLELIZE".
    for (const constraint of prepared.constraints) {
      const result = yield* decideConstraint(Z3, ctx, prepared, constraint, timeoutMs)
      results.push(result)
      elapsedMs += result.elapsedMs
      for (const name of result.refusedParams) refused.add(name)
    }

    return {
      results,
      skipped: prepared.skipped,
      effects: prepared.effects.length,
      variables: prepared.variables.length,
      frameDrift: frameDriftOf(prepared),
      emptyTransitionRelation: prepared.effects.length === 0 && prepared.constraints.length > 0,
      refusedParams: [...refused].sort(),
      elapsedMs,
      timeoutMs,
    }
  })
