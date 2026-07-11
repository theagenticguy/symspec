/**
 * EARS → Dwyer/SPS temporal-pattern mapping (AC-33-1).
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
 *   | ubiquitous         | response            | Universality   | G(resp)                |
 *
 * Design contract (mirrors encode.ts so the two tiers read the same way):
 *   - **Pure and solver-free.** {@link earsToTemporal} returns a plain-data
 *     {@link TemporalFormula} AST and never touches `z3-solver`. Deterministic
 *     given its {@link ReqView} input — no clock, no randomness, no mutation.
 *   - **Response polarity is threaded, not baked into names.** The AC-2-4
 *     `negated` flag becomes the response literal's polarity (`¬resp` when
 *     `negated`), never a substring of the atom name — the same discipline the
 *     propositional atomizer follows, so `shall X` and `shall not X` share one
 *     atom at opposite polarity across BOTH tiers.
 *   - **Atom names are scoped per system**, `sys__<system>__<kind>__<slot>`,
 *     matching the shape the propositional encoder's atomizer emits
 *     (`src/formal/atomize.ts`) so a temporal atom and its propositional
 *     counterpart line up by name. The scoping helper here is a self-contained
 *     pure normalizer — it does NOT import atomize.ts — keeping this module a
 *     pure function of its inputs alone.
 */

import type { EarsPattern } from '../core/schema.js'
import type { ReqView } from '../solvers/types.js'

// ---------------------------------------------------------------------------
// Temporal-formula AST (LTL over named atoms)
// ---------------------------------------------------------------------------

/**
 * A linear-temporal-logic formula over named Boolean atoms. Deliberately
 * solver-free so the mapping is synchronously testable; a separate lowering
 * step (AC-33-2) unrolls it to a bounded-trace `z3-solver` encoding.
 *
 * Operators: the boolean core (`atom`/`not`/`and`/`or`/`implies`) plus the four
 * LTL modalities — `G` (globally / always), `F` (finally / eventually),
 * `X` (next), and the binary `U` (until, `lhs U rhs`).
 */
export type TemporalFormula =
  | { readonly op: 'atom'; readonly name: string }
  | { readonly op: 'not'; readonly arg: TemporalFormula }
  | { readonly op: 'and'; readonly args: readonly TemporalFormula[] }
  | { readonly op: 'or'; readonly args: readonly TemporalFormula[] }
  | { readonly op: 'implies'; readonly lhs: TemporalFormula; readonly rhs: TemporalFormula }
  | { readonly op: 'G'; readonly arg: TemporalFormula }
  | { readonly op: 'F'; readonly arg: TemporalFormula }
  | { readonly op: 'X'; readonly arg: TemporalFormula }
  | { readonly op: 'U'; readonly lhs: TemporalFormula; readonly rhs: TemporalFormula }

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
// Pure per-system atom scoping (self-contained; NOT imported from atomize.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize a slot's text into an atom-name-safe token, matching the
 * conservative pipeline the propositional atomizer uses (AC-4-2a): lowercase →
 * strip a single leading article → strip punctuation → collapse whitespace →
 * underscore-join. Pure; no stemming or stopword removal, so temporal atoms
 * collide with propositional atoms exactly when the slot text is the same.
 */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')

/** Which EARS slot a temporal atom was derived from. */
type TemporalAtomKind = 'trig' | 'pre' | 'resp' | 'feat'

/** Build the scoped atom name `sys__<system>__<kind>__<slot>` (pure). */
const scopedName = (kind: TemporalAtomKind, systemName: string, slotText: string): string =>
  `sys__${norm(systemName)}__${kind}__${norm(slotText)}`

/**
 * The response literal for a requirement: `¬resp` when the parse-time AC-2-4
 * `negated` flag is set, else the bare `resp` atom. Polarity lands on the
 * SAME atom name in both cases (never a "not_" prefix), so the temporal and
 * propositional tiers agree on the response atom.
 */
const responseLiteral = (req: ReqView): TemporalFormula => {
  const resp = tAtom(scopedName('resp', req.systemName, req.systemResponse))
  return req.negated ? tNot(resp) : resp
}

// ---------------------------------------------------------------------------
// EARS → temporal mapping (AC-33-1)
// ---------------------------------------------------------------------------

/**
 * Map an EARS requirement to its Dwyer/SPS temporal-pattern shape per FRET
 * semantics (AC-33-1). Pure and deterministic over {@link ReqView}.
 *
 * Slot sourcing follows the EARS templates:
 *   - event-driven / unwanted-behavior read the `trigger` slot (the "When"/"If"
 *     clause) as the antecedent;
 *   - state-driven / optional-feature read the `preCondition` slot (the
 *     "While"/"Where" clause) as the guarding state / feature;
 *   - every pattern reads `systemResponse` as the consequent, threading
 *     `negated` onto its polarity.
 *
 * When an expected slot is absent the scoped name is still well-formed (an
 * empty normalized token), so the function is total and never throws — a
 * missing-slot requirement is a lint concern surfaced elsewhere, not a mapping
 * failure here.
 */
export function earsToTemporal(req: ReqView): TemporalFormula {
  const resp = responseLiteral(req)
  const trig = tAtom(scopedName('trig', req.systemName, req.trigger ?? ''))
  const state = tAtom(scopedName('pre', req.systemName, req.preCondition ?? ''))
  const feature = tAtom(scopedName('feat', req.systemName, req.preCondition ?? ''))

  const pattern: EarsPattern = req.patternType
  switch (pattern) {
    // Response (SPS): every trigger is eventually followed by the response.
    case 'event-driven':
      return G(tImplies(trig, F(resp)))
    // Absence (SPS): under the condition, the response must not occur. The
    // prohibition is the pattern's `¬`; `negated` (if the requirement itself
    // says "shall not") composes onto the response literal underneath it.
    case 'unwanted-behavior':
      return G(tImplies(trig, tNot(resp)))
    // Universality within scope (SPS): while the state holds, the response holds.
    case 'state-driven':
      return G(tImplies(state, resp))
    // Universality gated by a feature literal: where the feature is present,
    // the response holds. Same shape as state-driven with a feature antecedent.
    case 'optional-feature':
      return G(tImplies(feature, resp))
    // Universality (SPS): the response holds at every step, unconditionally.
    case 'ubiquitous':
      return G(resp)
  }
}
