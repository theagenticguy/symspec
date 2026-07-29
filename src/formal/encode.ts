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
 *   - **Atomization is injected, not imported as a concrete function.** The atom
 *     table is owned by AC-4-2a (`src/formal/atomize.ts`). This module depends on
 *     the *shape* of an atomizer via the {@link Atomize} function type, so the
 *     encoder stays a pure function of its inputs and a test can pin atomization.
 *     As of AC-2-7 the {@link Atomize} / {@link AtomLit} / {@link AtomKind}
 *     vocabulary is DECLARED in `atomize.ts` and re-exported here rather than
 *     redeclared: the duplicate `AtomKind` declaration this file used to carry is
 *     precisely the kind of structural duplication that let the temporal tier
 *     grow a third, divergent atom vocabulary.
 *
 * ## The formula AST is INDEXED, not forked (AC-2-7)
 *
 * `Formula` and `TemporalFormula` are one AST family: {@link Formula} is the
 * propositional core, and `temporal-patterns.ts`'s `TemporalFormula` is that same
 * core plus the four LTL modalities. The two tiers' needs are met by
 * PARAMETERS on the shared nodes, not by two node sets:
 *
 *   - the propositional path needs context groups (`contradiction.ts`) and a
 *     guard literal per requirement id for unsat cores — both of which are
 *     ordinary `atom` nodes, so no node kind is required for them;
 *   - the temporal path needs per-timestep naming `<atom>@<t>`, which
 *     `temporal.ts:lowerAt` supplies as a lowering PARAMETER `t` rather than as
 *     an `at` field on the node. That keeps the propositional `.smt2` bytes
 *     byte-identical (no node gains a field) while the temporal tier still gets
 *     one Bool per (atom, timestep).
 *
 * See {@link Formula}'s `cmp` arm for the one node whose indexing is a live
 * semantic question.
 */

import type { EarsPattern } from '../core/schema.js'
import type { ReqView } from '../solvers/types.js'
import type { Atomize, AtomKind, AtomLit } from './atomize.js'
import type { Z3Context } from './backend.js'

// ---------------------------------------------------------------------------
// Atomization contract (AC-4-2a) — DECLARED in atomize.ts, re-exported here
// ---------------------------------------------------------------------------

// AC-2-7 deduplication: `AtomKind`, `AtomLit` and `Atomize` used to be declared
// in BOTH this file and `atomize.ts`. Two structurally-identical declarations of
// the same contract is how the vocabulary drifts, and it forced `src/index.ts` to
// carve both modules out of its blanket re-export to dodge a TS2308 ambiguity.
// There is now exactly one declaration; this file re-exports it so every existing
// `from './encode.js'` import site keeps working unchanged.
export type { Atomize, AtomKind, AtomLit, AtomRef } from './atomize.js'

// ---------------------------------------------------------------------------
// Abstract propositional formula AST
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The shared BOOLEAN CORE nodes (AC-2-7) — one declaration, both tiers
// ---------------------------------------------------------------------------
//
// Before AC-2-7 the propositional `Formula` and the temporal `TemporalFormula`
// declared five structurally identical boolean nodes each, in two files. That is
// a forked AST wearing the costume of a shared one: nothing made the two `and`
// nodes the same shape except two authors writing the same line, and the
// arity-collapsing constructors had to be duplicated to match.
//
// Each node is now declared exactly ONCE, generic in its child type, and each
// tier's formula type is the union of the nodes it admits:
//
//   Formula          = boolean core + `cmp`            (propositional / numeric)
//   TemporalFormula  = boolean core + `G`/`F`/`X`/`U`  (bounded LTL)
//
// The parameterization is what makes the propositional tier's cmp-free formulas
// STRUCTURALLY assignable to `TemporalFormula` — the same node objects, no
// conversion, no copy — which is the property that lets one atomizer feed both.
// A tier's extra nodes stay out of the other tier's type, so `emit-smt2` still
// cannot be handed a `G` and `lowerAt` still cannot be handed a `cmp`; the
// exhaustive switches in both files remain exhaustive.
//
// The generic parameter is spelled out per union member rather than via a
// `BooleanCore<T>` alias because TypeScript reports `TS2456 circularly
// references itself` when a recursive type alias passes ITSELF to a generic
// alias — verified, not assumed. Naming each node interface individually keeps
// the recursion legal while still giving exactly one declaration per node.

/** Shared AST node: a bare named Boolean atom. Leaf, so it takes no child type. */
export interface AtomNode {
  readonly op: 'atom'
  readonly name: string
}
/** Shared AST node: logical negation `¬arg`. */
export interface NotNode<T> {
  readonly op: 'not'
  readonly arg: T
}
/** Shared AST node: conjunction. */
export interface AndNode<T> {
  readonly op: 'and'
  readonly args: readonly T[]
}
/** Shared AST node: disjunction. */
export interface OrNode<T> {
  readonly op: 'or'
  readonly args: readonly T[]
}
/** Shared AST node: material implication `lhs ⇒ rhs`. */
export interface ImpliesNode<T> {
  readonly op: 'implies'
  readonly lhs: T
  readonly rhs: T
}

/**
 * Arithmetic comparison over a named real-valued quantity (AC-30-1).
 * `quantity` is the canonical per-system quantity variable (owned by
 * `numeric.ts`); `value` is already unit-normalized to that quantity's base unit.
 * Materializes to a `z3-solver` Real comparison — LIA/LRA only, so the theory
 * stays decidable and deterministic.
 *
 * **OPEN SEMANTIC QUESTION, deliberately NOT resolved by AC-2-7 (note (b)):
 * whether this node should be timestep-indexed.** Today it is not, and nothing
 * needs it to be: `earsToTemporal` emits no `cmp`, so the temporal tier never
 * lowers one, and the numeric tier is a single-snapshot LIA/LRA check.
 * AC-2-1's state model will plausibly want a time-varying quantity
 * (`queue_depth@t`), and at that point the choice matters: indexing it renames
 * the Real const in every numeric finding's `evidence.numeric.quantity` and in
 * every emitted `.smt2`, so it is an observable contract change, not a refactor —
 * the same reason AC-1-1 chose to PARTITION by `(quantity, baseUnit)` rather than
 * fold the unit into the quantity key. The conservative choice — leave it
 * unindexed until a requirement needs it — is what is implemented here, so no
 * already-correct numeric finding changes shape. Deliberately NOT admitted into
 * `TemporalFormula`, so this decision cannot be made accidentally: adding a
 * time-varying quantity requires editing that union and confronting the question.
 */
export interface CmpNode {
  readonly op: 'cmp'
  readonly quantity: string
  readonly comparator: NumericComparator
  readonly value: number
}

/**
 * A propositional formula over named Boolean atoms. Deliberately Z3-free so
 * the encoder is synchronously testable; {@link materialize} lowers it to a
 * `z3-solver` `Bool`.
 *
 * The boolean nodes are the SAME declarations `TemporalFormula` composes
 * (AC-2-7), so a cmp-free `Formula` is structurally a `TemporalFormula`.
 * Timestep indexing for the temporal tier is a lowering PARAMETER
 * (`lowerAt(ctx, f, t, k)`), never a field on a node, so this type gains nothing
 * from AC-2-7 and the emitted `.smt2` bytes are unchanged.
 */
export type Formula =
  | AtomNode
  | NotNode<Formula>
  | AndNode<Formula>
  | OrNode<Formula>
  | ImpliesNode<Formula>
  | CmpNode

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
 * True when a slot carries no atomizable content, so it must be OMITTED rather
 * than atomized (AC-2-7, divergence 9).
 *
 * The failure this prevents: a slot that is absent, blank, or normalizes away to
 * nothing (`"---"`) still produces a *well-formed* atom name with an empty body,
 * `sys__auth__trig__`. Two unrelated malformed requirements under the same
 * system then SHARE that atom, and sharing an atom is exactly the predicate the
 * contradiction tier's context grouping and the coverage/participation counters
 * are built on. So an empty slot could silently make two requirements
 * "co-triggered" — a fabricated relationship between two things whose only
 * commonality is being malformed.
 *
 * The propositional encoder has always guarded `undefined`/`''` here; what
 * AC-2-7 adds is (a) the same guard on the temporal side, which had none, and
 * (b) extending it from "the raw text is blank" to "the NORMALIZED body is
 * empty", which catches `"   "` and `"---"` that the raw check lets through.
 *
 * Exported because `temporal-patterns.ts` must apply the identical rule — a
 * second copy of this predicate is how divergence 9 happened in the first place.
 */
export function slotIsEmpty(lit: AtomLit, rawText: string | undefined): boolean {
  if (rawText === undefined || rawText === '') return true
  // Prefer the structured body when the atomizer supplied one (the real
  // atomizer always does); a test-injected atomizer without `ref` falls back to
  // the raw-text check above, which is the pre-AC-2-7 behavior.
  return lit.ref !== undefined && lit.ref.body === ''
}

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
    if (!slotIsEmpty(p, pre)) {
      atoms.push({ atom: p.atom, kind: 'pre', slotText: pre, negated: p.negated })
      contextLits.push(literal(p))
    }
  }

  const trig = req.trigger
  if (trig !== undefined && trig !== '') {
    const t = atomize('trig', trig, req.systemName, false)
    if (!slotIsEmpty(t, trig)) {
      atoms.push({ atom: t.atom, kind: 'trig', slotText: trig, negated: t.negated })
      contextLits.push(literal(t))
    }
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
