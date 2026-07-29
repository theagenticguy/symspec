/**
 * EARS → Dwyer/SPS temporal-pattern mapping (AC-33-1), on the SHARED atomizer
 * and the SHARED formula AST (AC-2-7).
 *
 * symspec's temporal tier (v3.3) reasons about ORDER over time, not just a
 * propositional snapshot. This module is the pure, deterministic front half of
 * that tier: it turns an EARS requirement into a linear-temporal-logic (LTL)
 * formula shaped after the Dwyer Specification Pattern System (SPS) and the
 * NASA FRET tool's EARS-slot → metric-LTL semantics. It performs NO solver
 * contact — exactly like {@link ../encode.ts:encode} for the propositional
 * tier — so the mapping is synchronously unit-testable ("each EARS pattern →
 * expected temporal pattern shape", AC-33-1) with no WASM boot. The bounded
 * LTL→SMT lowering (AC-33-2) is a separate step the solver-driving tier calls.
 *
 * The mapping (grounded in FRET's response/absence/universality catalogue and
 * Dwyer SPS; spec AC-33-1):
 *
 *   | EARS pattern       | slot(s) used        | SPS pattern    | LTL shape              |
 *   |--------------------|---------------------|----------------|------------------------|
 *   | event-driven       | trigger, response   | Response       | G(trig → F resp)       |
 *   | unwanted-behavior  | trigger, response   | Absence        | G(cond → ¬resp)        |
 *   | state-driven       | preCondition, resp  | Universality   | G(state → resp)        |
 *   | optional-feature   | preCondition, resp  | Universality⟨feat⟩ | G(feature → resp)   |
 *   | ubiquitous         | response            | Universality    | G(resp)               |
 *
 * ## AC-2-7: ONE atomizer, injected — the blindness was STRUCTURAL
 *
 * This module used to carry its OWN private normalizer (`norm`) and its own
 * `scopedName` helper, with a header comment asserting they matched
 * `atomize.ts`'s pipeline. They did not. Nine measured divergences, all resolved
 * here in favour of the PROPOSITIONAL semantics (which `atomize.test.ts` pins):
 *
 *   1. **Punctuation class.** `[^\w\s]` (this file) vs `[^a-z0-9\s]+`
 *      (`atomize.ts`). `\w` INCLUDES `_` and was not applied to runs, so
 *      `read-only mode` → `readonly_mode` here but `read_only_mode` there, and
 *      `TLS 1.3` → `tls_13` vs `tls_1_3`. 11 of 18 probed inputs diverged.
 *   2. **Copula strip.** The propositional guard slots drop one copula token, so
 *      "maintenance mode is enabled" and "maintenance mode enabled" name ONE
 *      guard state. This file kept the copula, so the two tiers named the same
 *      real-world condition differently.
 *   3. **Antonym unification.** Propositional-only, so `grant x` / `revoke x`
 *      were two temporal atoms and the conflict was invisible.
 *   4. **Leading-verb de-inflection.** Propositional-only ("opens"/"open").
 *   5. **Glossary canonicalization.** Propositional-only.
 *   6. **A fourth `feat` kind** with no propositional counterpart.
 *   7. **Negation in the atom NAME.** `toEncodable`'s leading-negator scan ran
 *      only on the propositional path, so a hand-authored `"not store
 *      plaintext"` became `…__resp__not_store_plaintext` here while the
 *      propositional tier produced `…__resp__store_plaintext` + `negated: true`.
 *      That breaks `atomize.ts`'s own invariant 4 — the atom must be the POSITIVE
 *      one and negation must be polarity — and it is the divergence that made
 *      `G(t → F ¬grant_x)` unprovable against `G(t → F grant_x)`.
 *   8. **Different requirement populations.** See {@link earsToTemporal}'s
 *      "which requirements" note; resolved in `check.ts`, not here.
 *   9. **Empty slots.** An absent trigger yielded a well-formed-but-empty atom
 *      `sys__auth__trig__` here, where the propositional encoder OMITS the slot.
 *      Two unrelated malformed requirements therefore shared an atom — see
 *      `encode.ts:slotIsEmpty` for why that is worse than it looks.
 *
 * The fix is not "copy the pipeline correctly", which is how divergence happened
 * the first time. {@link earsToTemporal} now takes the {@link Atomize} closure as
 * a REQUIRED parameter — the same instance `encode` receives, built once in
 * `check.ts` over the document's committed glossary and antonym pairs. The
 * signature is the enforcement: there is no way to call this function without
 * saying which atomizer it uses, so the tier cannot go back to being blind
 * without a visible signature change.
 *
 * ## Design contract (mirrors encode.ts so the two tiers read the same way)
 *
 *   - **Pure and solver-free.** {@link earsToTemporal} returns a plain-data
 *     {@link TemporalFormula} AST and never touches `z3-solver`. Deterministic
 *     given its inputs — no clock, no randomness, no mutation.
 *   - **Response polarity is threaded, not baked into names.** The AC-2-4
 *     `negated` flag becomes the response literal's polarity (`¬resp` when
 *     negated), never a substring of the atom name — now enforced by the shared
 *     atomizer rather than by two files agreeing.
 *   - **Atom names are scoped per system**, `sys__<system>__<kind>__<slot>`, and
 *     that format is written down in exactly one place
 *     (`atomize.ts:renderAtom`), so a temporal atom and its propositional
 *     counterpart line up by CONSTRUCTION.
 *   - **The AST nodes are the shared ones.** `TemporalFormula` is `encode.ts`'s
 *     boolean core plus the four modalities; the boolean node interfaces are
 *     imported, not redeclared, so a cmp-free `Formula` is structurally a
 *     `TemporalFormula`.
 */

import type { EarsPattern } from '../core/schema.js'
import type { ReqView } from '../solvers/types.js'
import type { Atomize, AtomKind, AtomLit } from './atomize.js'
import {
  type AndNode,
  type AtomNode,
  type ImpliesNode,
  type NotNode,
  type OrNode,
  slotIsEmpty,
} from './encode.js'

// ---------------------------------------------------------------------------
// Temporal-formula AST — the SHARED boolean core plus the LTL modalities
// ---------------------------------------------------------------------------

/** AST node: `G arg` — globally / always. Temporal-only. */
export interface GNode<T> {
  readonly op: 'G'
  readonly arg: T
}
/** AST node: `F arg` — finally / eventually. Temporal-only. */
export interface FNode<T> {
  readonly op: 'F'
  readonly arg: T
}
/** AST node: `X arg` — next. Temporal-only. */
export interface XNode<T> {
  readonly op: 'X'
  readonly arg: T
}
/** AST node: `lhs U rhs` — until. Temporal-only. */
export interface UNode<T> {
  readonly op: 'U'
  readonly lhs: T
  readonly rhs: T
}

/**
 * A linear-temporal-logic formula over named Boolean atoms. Deliberately
 * solver-free so the mapping is synchronously testable; a separate lowering
 * step (AC-33-2) unrolls it to a bounded-trace `z3-solver` encoding.
 *
 * Operators: the boolean core — {@link AtomNode}/{@link NotNode}/{@link AndNode}/
 * {@link OrNode}/{@link ImpliesNode}, the SAME declarations `Formula` composes
 * (AC-2-7, `encode.ts`) — plus the four LTL modalities `G`, `F`, `X`, and the
 * binary `U`.
 *
 * `encode.ts`'s `CmpNode` is deliberately NOT admitted: nothing lowers a
 * time-indexed arithmetic comparison today, and letting one in silently would
 * pre-decide AC-2-7's open question (b). See `CmpNode`'s doc comment.
 */
export type TemporalFormula =
  | AtomNode
  | NotNode<TemporalFormula>
  | AndNode<TemporalFormula>
  | OrNode<TemporalFormula>
  | ImpliesNode<TemporalFormula>
  | GNode<TemporalFormula>
  | FNode<TemporalFormula>
  | UNode<TemporalFormula>
  | XNode<TemporalFormula>

// ---------------------------------------------------------------------------
// Constructors (arity-collapsing where it keeps the emitted shape minimal,
// matching the propositional encoder's `and`/`or` behaviour in encode.ts)
// ---------------------------------------------------------------------------

/** Constructor: a bare Boolean atom. */
export const tAtom = (name: string): TemporalFormula => ({ op: 'atom', name })
/** Constructor: logical negation `¬arg`. */
export const tNot = (arg: TemporalFormula): TemporalFormula => ({ op: 'not', arg })
/** Constructor: material implication `lhs → rhs`. */
export const tImplies = (lhs: TemporalFormula, rhs: TemporalFormula): TemporalFormula => ({
  op: 'implies',
  lhs,
  rhs,
})

/** Constructor: conjunction. A single conjunct collapses to itself. */
export const tAnd = (args: readonly TemporalFormula[]): TemporalFormula => {
  if (args.length === 1) return args[0]!
  return { op: 'and', args }
}

/** Constructor: disjunction. A single disjunct collapses to itself. */
export const tOr = (args: readonly TemporalFormula[]): TemporalFormula => {
  if (args.length === 1) return args[0]!
  return { op: 'or', args }
}

/** Constructor: `G arg` — globally / always. */
export const G = (arg: TemporalFormula): TemporalFormula => ({ op: 'G', arg })
/** Constructor: `F arg` — finally / eventually. */
export const F = (arg: TemporalFormula): TemporalFormula => ({ op: 'F', arg })
/** Constructor: `X arg` — next. */
export const X = (arg: TemporalFormula): TemporalFormula => ({ op: 'X', arg })
/** Constructor: `lhs U rhs` — until. */
export const U = (lhs: TemporalFormula, rhs: TemporalFormula): TemporalFormula => ({
  op: 'U',
  lhs,
  rhs,
})

// ---------------------------------------------------------------------------
// Slot → literal, via the INJECTED shared atomizer (AC-2-7)
// ---------------------------------------------------------------------------

/**
 * Turn one EARS slot into a temporal literal through the injected atomizer.
 *
 * **Polarity, never a name** (AC-2-7 divergence 7). The atomizer returns the
 * POSITIVE atom plus a polarity flag (its invariant 4), and the flag becomes a
 * `¬` node here. An antonym-unified response (`revoke x` → `grant x` + negated)
 * therefore lands on the same atom the propositional tier uses, at the polarity
 * that makes `G(t → F grant_x)` vs `G(t → F ¬grant_x)` provable. Composing the
 * AC-2-4 `negated` flag with an antonym flip is the atomizer's XOR, not ours.
 */
function slotLiteral(
  atomize: Atomize,
  kind: AtomKind,
  slotText: string,
  systemName: string,
  negated: boolean,
): TemporalFormula {
  const lit: AtomLit = atomize(kind, slotText, systemName, negated)
  const base = tAtom(lit.atom)
  return lit.negated ? tNot(base) : base
}

/**
 * The ANTECEDENT literal for a guarded pattern, or `null` when the guard slot
 * carries no atomizable content (AC-2-7 divergence 9).
 *
 * Applies to the OPTIONAL guard slots only — `trigger` and `preCondition`. The
 * response slot is deliberately NOT subject to this rule: a response is what a
 * requirement asserts, is `z.string().min(1)` in the schema, and is the whole
 * point of the formula, so there is nothing to degrade to if it were dropped. The
 * propositional encoder treats the two kinds of slot exactly the same way
 * (guarded `if` around each context slot, unconditional response), and matching
 * that is the point of this AC — so the asymmetry here is deliberate parity, not
 * an oversight.
 *
 * Shares `encode.ts`'s exact {@link slotIsEmpty} predicate rather than a second
 * copy of it; a second copy is how divergence 9 happened in the first place.
 */
function guardLiteral(
  atomize: Atomize,
  kind: AtomKind,
  slotText: string | undefined,
  systemName: string,
): TemporalFormula | null {
  if (slotText === undefined || slotText === '') return null
  const lit: AtomLit = atomize(kind, slotText, systemName, false)
  if (slotIsEmpty(lit, slotText)) return null
  const base = tAtom(lit.atom)
  return lit.negated ? tNot(base) : base
}

// ---------------------------------------------------------------------------
// EARS → temporal mapping (AC-33-1)
// ---------------------------------------------------------------------------

/**
 * Map an EARS requirement to its Dwyer/SPS temporal-pattern shape per FRET
 * semantics (AC-33-1). Pure and deterministic over `(req, atomize)`.
 *
 * Slot sourcing follows the EARS templates:
 *   - event-driven / unwanted-behavior read the `trigger` slot (the "When"/"If"
 *     clause) as the antecedent;
 *   - state-driven / optional-feature read the `preCondition` slot (the
 *     "While"/"Where" clause) as the guarding state / feature;
 *   - every pattern reads `systemResponse` as the consequent, threading
 *     `negated` onto its polarity.
 *
 * **`atomize` is required, not optional** (AC-2-7). Callers pass the same closure
 * the propositional encoder gets — built once per run in `src/pipeline/check.ts`
 * over the document's committed glossary and antonym pairs — so the temporal tier
 * sees every glossary/antonym commitment the propositional tier sees. A default
 * would silently re-create the blindness this AC removes for any caller that
 * forgot the argument, which is why there isn't one.
 *
 * **A missing or contentless antecedent slot DEGRADES to the unguarded
 * obligation** rather than to a shared empty atom (divergence 9). An
 * `event-driven` requirement with no trigger becomes `G(F resp)` instead of
 * `G(sys__x__trig__ → F resp)`.
 *
 * Both readings are wrong about a malformed requirement — it has no defensible
 * meaning — so the question is which wrong reading is SAFE for a tier that
 * reports only on `unsat`, at error severity. The unguarded obligation is
 * strictly STRONGER, and it is confined to this requirement's OWN atoms: it can
 * make this one requirement self-contradictory (`G(F r)` against its own
 * `G(¬r)`), which names the right requirement and is a real problem worth
 * reporting. The empty-atom reading instead invents a `sys__<system>__trig__`
 * atom that every malformed requirement in the same system SHARES, so two
 * unrelated authoring bugs get co-triggered and can combine into a temporal
 * contradiction naming both — a fabricated relationship between requirements
 * whose only commonality is being malformed. That is the failure class this
 * codebase treats as cardinal, so the stronger-but-local reading wins.
 *
 * Note the malformed slot never silently rides along: the structural tier reports
 * it as `FND_MISSING_TRIGGER` / `FND_MISSING_PRECONDITION` at ERROR severity from
 * `core/analyze.ts`, so the run fails on the authoring defect regardless of what
 * this mapping does with it. This function stays total and never throws.
 */
export function earsToTemporal(req: ReqView, atomize: Atomize): TemporalFormula {
  const negated = req.negated === true
  const resp = slotLiteral(atomize, 'resp', req.systemResponse, req.systemName, negated)

  const pattern: EarsPattern = req.patternType
  switch (pattern) {
    // Response (SPS): every trigger is eventually followed by the response.
    case 'event-driven': {
      const trig = guardLiteral(atomize, 'trig', req.trigger, req.systemName)
      return trig === null ? G(F(resp)) : G(tImplies(trig, F(resp)))
    }
    // Absence (SPS): under the condition, the response must not occur. The
    // prohibition is the pattern's `¬`; `negated` (if the requirement itself
    // says "shall not") composes onto the response literal underneath it.
    case 'unwanted-behavior': {
      const trig = guardLiteral(atomize, 'trig', req.trigger, req.systemName)
      return trig === null ? G(tNot(resp)) : G(tImplies(trig, tNot(resp)))
    }
    // Universality within scope (SPS): while the state holds, the response holds.
    case 'state-driven': {
      const state = guardLiteral(atomize, 'pre', req.preCondition, req.systemName)
      return state === null ? G(resp) : G(tImplies(state, resp))
    }
    // Universality gated by a feature literal: where the feature is present,
    // the response holds. Same shape as state-driven with a feature antecedent.
    //
    // The `feat` kind is preserved verbatim (AC-2-7 note (a)): it is derived from
    // the SAME `preCondition` slot as `pre`, so one slot yields two atom
    // namespaces depending on `patternType`. Collapsing `feat` → `pre` is
    // arguably more correct, and is deliberately NOT done here — it would make an
    // `optional-feature` precondition share an atom with a `state-driven` one of
    // the same text, i.e. move in the MORE-unification / more-error-findings
    // direction, which needs a human decision rather than a refactor. What AC-2-7
    // does fix is that `feat` now normalizes IDENTICALLY to `pre` (same
    // punctuation class, same copula strip, same glossary) — see
    // `atomize.ts:GUARD_KINDS`.
    case 'optional-feature': {
      const feature = guardLiteral(atomize, 'feat', req.preCondition, req.systemName)
      return feature === null ? G(resp) : G(tImplies(feature, resp))
    }
    // Universality (SPS): the response holds at every step, unconditionally.
    case 'ubiquitous':
      return G(resp)
  }
}
