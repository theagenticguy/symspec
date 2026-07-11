/**
 * Guarded-implication encoder (AC-4-2).
 *
 * Turns an EARS requirement into the propositional formula the SMT tier
 * asserts, following research-smt.md §1.1/§2.1:
 *
 *     REQ-i  ⇒  (context ⇒ response)
 *
 * where `REQ-i` is an assumption literal (a fresh Bool named after the
 * requirement id) so the solver's unsat core can name exactly the conflicting
 * requirements (AC-4-4), and `context`/`response` are Boolean atoms drawn from
 * the AC-4-2a atom table.
 *
 * Per-pattern body shape (research-smt.md §1.1):
 *
 *   | pattern           | body                |
 *   |-------------------|---------------------|
 *   | ubiquitous        | R                   |
 *   | event-driven      | T ⇒ R               |
 *   | state-driven      | P ⇒ R               |
 *   | optional-feature  | P ⇒ R               |
 *   | unwanted-behavior | T ⇒ R               |
 *   | (complex: P + T)  | (P ∧ T) ⇒ R         |
 *
 * The body is derived from the *slots actually present* (precondition and/or
 * trigger), which is strictly more robust than switching on `patternType`
 * alone — an event-driven requirement that also carries a `preCondition`
 * (Tier-1's "complex" → event-driven mapping, see parse/tier1.ts) correctly
 * encodes as `(P ∧ T) ⇒ R`.
 *
 * Design contract (why this file is structured the way it is):
 *   - **Pure and Z3-free.** {@link encode} returns a plain-data {@link Formula}
 *     AST and never touches `z3-solver`. That keeps it synchronously
 *     unit-testable ("per-pattern formula shape; encoder is pure over
 *     ReqView", AC-4-2) with no WASM boot. Materialization into Z3 ASTs is a
 *     separate step ({@link materialize}) the solver-driving tiers
 *     (contradiction/subsumption/vacuity, AC-4-3/4-5) call — "the encoder [is]
 *     a pure, unit-testable function separate from the solver call" (AC-4-2).
 *   - **Atomization is injected, not imported.** The atom table is owned by
 *     AC-4-2a (`src/formal/atomize.ts`, a parallel wave-mate). This module
 *     depends on the *shape* of an atomizer via the {@link Atomize} function
 *     type, never on that file, so the encoder stays a pure function of its
 *     inputs and the two tasks never collide. The integration tier passes the
 *     real AC-4-2a `atomize` (adapting its signature in its own file if
 *     needed).
 */

import type { EarsPattern } from '../core/schema.js'
import type { ReqView } from '../solvers/types.js'
import type { Z3Context } from './backend.js'

// ---------------------------------------------------------------------------
// Atomization contract (AC-4-2a, injected)
// ---------------------------------------------------------------------------

/** Which EARS slot an atom was derived from (research-smt.md §4.1). */
export type AtomKind = 'trig' | 'pre' | 'resp'

/**
 * A Boolean atom paired with its polarity. `negated: true` means the
 * requirement asserts `¬atom` (an explicit `shall not` per AC-2-4, or a
 * polar-opposite unified via the AC-4-2a antonym table). The atom name is the
 * *positive* atom in both cases, so `shall X` and `shall not X` share one atom
 * with opposite polarity (AC-4-2a).
 */
export interface AtomLit {
  atom: string
  negated: boolean
}

/**
 * The atom-table function (AC-4-2a), injected so the encoder never imports the
 * parallel `atomize.ts`. Given a slot kind, the raw slot text, the owning
 * `systemName` (for per-system scoping so identical response text under two
 * systems yields two distinct atoms — AC-4-2a), and the parse-time `negated`
 * flag (AC-2-4), it returns the scoped atom name and its polarity.
 *
 * Context slots (`trig`/`pre`) pass `negated = false`; only the response slot
 * threads the requirement's `negated` flag.
 */
export type Atomize = (
  kind: AtomKind,
  slotText: string,
  systemName: string,
  negated: boolean,
) => AtomLit

// ---------------------------------------------------------------------------
// Abstract propositional formula AST
// ---------------------------------------------------------------------------

/**
 * A propositional formula over named Boolean atoms. Deliberately Z3-free so
 * the encoder is synchronously testable; {@link materialize} lowers it to a
 * `z3-solver` `Bool`.
 */
export type Formula =
  | { readonly op: 'atom'; readonly name: string }
  | { readonly op: 'not'; readonly arg: Formula }
  | { readonly op: 'and'; readonly args: readonly Formula[] }
  | { readonly op: 'or'; readonly args: readonly Formula[] }
  | { readonly op: 'implies'; readonly lhs: Formula; readonly rhs: Formula }
  | {
      // Arithmetic comparison over a named real-valued quantity (AC-30-1).
      // `quantity` is the canonical per-system quantity variable (owned by
      // numeric.ts); `value` is already unit-normalized to that quantity's base
      // unit. Materializes to a `z3-solver` Real comparison — LIA/LRA only, so
      // the theory stays decidable + deterministic.
      readonly op: 'cmp'
      readonly quantity: string
      readonly comparator: NumericComparator
      readonly value: number
    }

/** The six arithmetic comparators a numeric predicate can use (AC-30-1). */
export type NumericComparator = '<' | '<=' | '=' | '>=' | '>' | '!='

/** Formula constructor: a bare Boolean atom. */
export const atom = (name: string): Formula => ({ op: 'atom', name })

/** Formula constructor: an arithmetic comparison `quantity <cmp> value` (AC-30-1). */
export const cmp = (quantity: string, comparator: NumericComparator, value: number): Formula => ({
  op: 'cmp',
  quantity,
  comparator,
  value,
})
/** Formula constructor: logical negation. */
export const not = (arg: Formula): Formula => ({ op: 'not', arg })
/** Formula constructor: material implication `lhs ⇒ rhs`. */
export const implies = (lhs: Formula, rhs: Formula): Formula => ({ op: 'implies', lhs, rhs })

/**
 * Formula constructor: conjunction. Collapses the trivial arities so callers
 * never build a degenerate `and` — a single conjunct returns that conjunct
 * unchanged, keeping the emitted shape minimal and the per-pattern tests
 * exact.
 */
export const and = (args: readonly Formula[]): Formula => {
  if (args.length === 1) return args[0]!
  return { op: 'and', args }
}

/** Formula constructor: disjunction (arity ≥ 1; single disjunct collapses). */
export const or = (args: readonly Formula[]): Formula => {
  if (args.length === 1) return args[0]!
  return { op: 'or', args }
}

/** Build the response/context literal: `¬atom` when negated, else `atom`. */
const literal = (a: AtomLit): Formula => (a.negated ? not(atom(a.atom)) : atom(a.atom))

// ---------------------------------------------------------------------------
// Encoded requirement
// ---------------------------------------------------------------------------

/** One row of the atom table for a requirement, carried into `evidence` (AC-4-6). */
export interface AtomTableEntry {
  /** Scoped atom name produced by {@link Atomize}. */
  atom: string
  /** Which slot it came from. */
  kind: AtomKind
  /** The original slot text, so a finding can show what the solver compared. */
  slotText: string
  /** Polarity as used in the formula. */
  negated: boolean
}

/** The pure encoding of a single requirement. */
export interface EncodedRequirement {
  /** The requirement's stable id. */
  id: string
  /**
   * The assumption-literal name asserted via `solver.check(...guards)`; it is
   * the requirement `id` verbatim, so an unsat core maps straight back to the
   * culprit ids (AC-4-4).
   */
  guard: string
  /** The EARS pattern (for reporting/evidence). */
  pattern: EarsPattern
  /** Atom-table rows referenced by this requirement's formula. */
  atoms: AtomTableEntry[]
  /** The inner `context ⇒ response` (or bare `response` for ubiquitous). */
  body: Formula
  /** The full guarded formula `guard ⇒ body` — this is what gets asserted. */
  formula: Formula
}

/**
 * A requirement projection the encoder accepts: {@link ReqView} plus the
 * optional parse-time `negated` flag (AC-2-4). A plain `ReqView` is accepted
 * (negation defaults to `false`); the flag is additive and requires no schema
 * change.
 */
export type EncodableRequirement = ReqView & { negated?: boolean }

/**
 * Encode a single requirement into its guarded-implication {@link Formula}.
 *
 * Pure: no mutation of `req`, no solver contact, deterministic given a
 * deterministic `atomize`. The response atom threads `req.negated` (AC-2-4);
 * context atoms are always positive at this layer (any precondition negation
 * is the atomizer's concern).
 */
export function encode(req: EncodableRequirement, atomize: Atomize): EncodedRequirement {
  const negated = req.negated ?? false
  const response = atomize('resp', req.systemResponse, req.systemName, negated)

  const atoms: AtomTableEntry[] = []
  const contextLits: Formula[] = []

  const pre = req.preCondition
  if (pre !== undefined && pre !== '') {
    const p = atomize('pre', pre, req.systemName, false)
    atoms.push({ atom: p.atom, kind: 'pre', slotText: pre, negated: p.negated })
    contextLits.push(literal(p))
  }

  const trig = req.trigger
  if (trig !== undefined && trig !== '') {
    const t = atomize('trig', trig, req.systemName, false)
    atoms.push({ atom: t.atom, kind: 'trig', slotText: trig, negated: t.negated })
    contextLits.push(literal(t))
  }

  atoms.push({
    atom: response.atom,
    kind: 'resp',
    slotText: req.systemResponse,
    negated: response.negated,
  })

  const responseFormula = literal(response)
  const body: Formula =
    contextLits.length === 0 ? responseFormula : implies(and(contextLits), responseFormula)

  return {
    id: req.id,
    guard: req.id,
    pattern: req.patternType,
    atoms,
    body,
    formula: implies(atom(req.id), body),
  }
}

// ---------------------------------------------------------------------------
// Z3 materialization (called by the solver-driving tiers, not the encoder)
// ---------------------------------------------------------------------------

/** A `z3-solver` Bool expression, as produced by a {@link Z3Context}. */
export type Z3Bool = ReturnType<Z3Context['Bool']['const']>

/**
 * Lower a {@link Formula} into a `z3-solver` `Bool` in the given context.
 * Pure construction — it builds the AST but never calls `check()`, so the
 * "encoder separate from solver call" boundary (AC-4-2) holds even here. The
 * solver-driving tiers call this, then assert the result and `check`.
 */
export function materialize(ctx: Z3Context, f: Formula): Z3Bool {
  switch (f.op) {
    case 'atom':
      return ctx.Bool.const(f.name)
    case 'not':
      return ctx.Not(materialize(ctx, f.arg))
    case 'and':
      return ctx.And(...f.args.map((a) => materialize(ctx, a)))
    case 'or':
      return ctx.Or(...f.args.map((a) => materialize(ctx, a)))
    case 'implies':
      return ctx.Implies(materialize(ctx, f.lhs), materialize(ctx, f.rhs))
    case 'cmp': {
      // AC-30-1: a per-quantity Real variable compared against a normalized
      // value. Real (not Int) keeps LRA available for fractional units; the
      // comparators are total, so this stays in decidable linear arithmetic.
      const q = ctx.Real.const(f.quantity)
      switch (f.comparator) {
        case '<':
          return q.lt(f.value)
        case '<=':
          return q.le(f.value)
        case '=':
          return q.eq(f.value)
        case '>=':
          return q.ge(f.value)
        case '>':
          return q.gt(f.value)
        case '!=':
          return q.neq(f.value)
      }
    }
  }
}
