/**
 * THE ENCODER — the header table, the guard literal, and the empty-slot rule, as exit codes.
 *
 * `encode` is where a requirement stops being text and becomes the thing the solver proves
 * about. Four of its properties are load-bearing, and each of the first three fails silently.
 *
 *   1. THE BODY IS AN IMPLICATION, never a conjunction. `(P ∧ T) ⇒ R` asserts the response only
 *      in the cases the author wrote. `P ∧ T ∧ R` asserts the GUARD AS A FACT, and a spec whose
 *      requirements all assert their own guards co-asserts guards no requirement declared
 *      together — mutually exclusive ones included — so two opposed responses prove a conflict
 *      the document does not contain. That is a fabricated `FND_CONTRADICTION` built out of one
 *      constructor call, which is why the shape cases below are paired with a solver case
 *      proving the encoding leaves every guard FALSIFIABLE.
 *   2. THE BODY IS DERIVED FROM THE SLOTS PRESENT, not from `patternType`. The header's sixth
 *      table row is a slot COMBINATION rather than a pattern name: an event-driven requirement
 *      carrying a precondition encodes `(P ∧ T) ⇒ R`.
 *   3. THE GUARD LITERAL. `formula` is `guard ⇒ body` with `guard` the requirement id verbatim,
 *      which is what lets `solver.check(...guards)` name culprits from an unsat core. Drop it
 *      and every requirement's body becomes a permanent assertion the solver cannot retract, so
 *      no core can be attributed.
 *   4. EMPTY SLOTS ARE OMITTED, not atomized. A slot that normalizes away to nothing produces
 *      a well-formed atom with an EMPTY body, `sys__lift_controller__trig__`, which every other
 *      malformed requirement under that system also produces — so two requirements whose only
 *      commonality is being malformed become co-triggered, and co-liveness is the predicate the
 *      contradiction tier's grouping rests on. These cases run through the REAL atomizer on
 *      purpose: `slotIsEmpty` reads the NORMALIZED body off `AtomLit.ref`, and a hand-written
 *      atomizer's `ref` does not normalize, so a stub cannot witness the rule at all.
 *
 * The Bool-interning case at the bottom is different in kind: it pins a `z3-solver` property
 * this repo does not own. No mutation of symspec can break it, and the case exists to fail
 * loudly if a z3 upgrade does.
 */

import { describe, expect, it } from 'vitest'
import { EARS_PATTERNS } from '../core/schema.ts'
import { type Atomize, makeAtomize } from './atomize.ts'
import { getContext } from './backend.ts'
import {
  and,
  atom,
  type EncodableRequirement,
  encode,
  implies,
  materialize,
  not,
} from './encode.ts'

/**
 * An atomizer that names a slot after its KIND, so a body assertion reads as the shape it
 * pins rather than as a table of atom names (`atomize.test.ts` and the atom-corpus snapshot own
 * the names). It supplies a `ref`, because the omission rule consults it.
 */
const byKind: Atomize = (kind, slotText, systemName, negated) => ({
  atom: kind.toUpperCase(),
  negated,
  ref: { scope: systemName, kind, body: slotText },
})

/** The real atomizer with no committed tables — the default `check` path. */
const real = makeAtomize()

const req = (o: {
  id: string
  patternType: (typeof EARS_PATTERNS)[number]
  preCondition?: string | undefined
  trigger?: string | undefined
  systemResponse?: string
  negated?: boolean
}): EncodableRequirement => ({
  id: o.id,
  patternType: o.patternType,
  preCondition: o.preCondition,
  trigger: o.trigger,
  systemName: 'lift controller',
  systemResponse: o.systemResponse ?? 'halt the car',
  negated: o.negated ?? false,
  sentence: '',
  priority: 'medium',
  status: 'draft',
})

/** The `<body>` field of `sys__<scope>__<kind>__<body>`; empty when the slot normalized away. */
const bodyOf = (name: string): string => name.slice('sys__'.length).split('__')[2] ?? ''

const P = atom('PRE')
const T = atom('TRIG')
const R = atom('RESP')

/**
 * The six rows of `encode.ts`'s per-pattern body table, as data. Row six is the slot
 * combination Tier-1 maps `complex` onto, not a sixth `EarsPattern`.
 */
const BODY_TABLE = [
  { row: 'ubiquitous', pattern: 'ubiquitous', pre: undefined, trig: undefined, body: R },
  {
    row: 'event-driven',
    pattern: 'event-driven',
    pre: undefined,
    trig: 'the call button is pressed',
    body: implies(T, R),
  },
  {
    row: 'state-driven',
    pattern: 'state-driven',
    pre: 'the door is open',
    trig: undefined,
    body: implies(P, R),
  },
  {
    row: 'optional-feature',
    pattern: 'optional-feature',
    pre: 'the express mode is enabled',
    trig: undefined,
    body: implies(P, R),
  },
  {
    row: 'unwanted-behavior',
    pattern: 'unwanted-behavior',
    pre: undefined,
    trig: 'the load exceeds the limit',
    body: implies(T, R),
  },
  {
    row: 'complex: P + T',
    pattern: 'event-driven',
    pre: 'the door is open',
    trig: 'the call button is pressed',
    body: implies(and([P, T]), R),
  },
] as const satisfies ReadonlyArray<{
  row: string
  pattern: (typeof EARS_PATTERNS)[number]
  pre: string | undefined
  trig: string | undefined
  body: unknown
}>

describe('the per-pattern body shape', () => {
  for (const { row, pattern, pre, trig, body } of BODY_TABLE) {
    it(`encodes ${row}`, () => {
      const e = encode(
        req({ id: 'REQ-1', patternType: pattern, preCondition: pre, trigger: trig }),
        byKind,
      )
      expect(e.body).toEqual(body)
    })
  }

  it('is a function of the SLOTS present, not of patternType', () => {
    // The header claims deriving from the slots is "strictly more robust than switching on
    // `patternType` alone". Every pattern carrying the same two slots therefore encodes the
    // same body, and the pattern list is read from the schema so a sixth pattern joins this
    // case by existing rather than by someone remembering to add a row.
    const bodies = new Set(
      EARS_PATTERNS.map((patternType) =>
        JSON.stringify(
          encode(
            req({
              id: 'REQ-1',
              patternType,
              preCondition: 'the door is open',
              trigger: 'the call button is pressed',
            }),
            byKind,
          ).body,
        ),
      ),
    )
    expect(bodies.size, `patternType changed the body: ${[...bodies].join(' vs ')}`).toBe(1)
    expect(JSON.parse([...bodies][0] as string)).toEqual(implies(and([P, T]), R))
  })

  it('leaves every guard FALSIFIABLE — a body never asserts its own context', async () => {
    // The shape assertions above compare ASTs; this one compares meaning, and it is the case
    // that names the fabrication. `and([...context, response])` satisfies the header table's
    // atom set exactly and is unsatisfiable the moment a guard is false, which is what makes a
    // mutually-exclusive pair of guards jointly assertable.
    const ctx = await getContext('symspec-encode-falsifiable-guard')
    for (const { row, pattern, pre, trig } of BODY_TABLE) {
      const e = encode(
        req({ id: 'REQ-1', patternType: pattern, preCondition: pre, trigger: trig }),
        byKind,
      )
      const context = e.atoms.filter((a) => a.kind !== 'resp')
      if (context.length === 0) continue
      const solver = new ctx.Solver()
      solver.add(materialize(ctx, e.body))
      for (const c of context) solver.add(materialize(ctx, not(atom(c.atom))))
      expect(await solver.check(), `${row} asserts its own guard`).toBe('sat')
    }
  })

  it('threads response negation as POLARITY, on the same atom', () => {
    // AC-2-4: `shall not X` and `shall X` are one atom at two polarities, which is the whole
    // reason a contradiction is detectable. The atom NAME must not move.
    const positive = encode(req({ id: 'REQ-1', patternType: 'ubiquitous' }), real)
    const negative = encode(req({ id: 'REQ-2', patternType: 'ubiquitous', negated: true }), real)
    expect(negative.atoms.map((a) => a.atom)).toEqual(positive.atoms.map((a) => a.atom))
    expect(positive.atoms.map((a) => a.negated)).toEqual([false])
    expect(negative.atoms.map((a) => a.negated)).toEqual([true])
    expect(negative.body).toEqual(not(atom(negative.atoms[0]?.atom ?? '')))
  })
})

describe('the guarded formula', () => {
  for (const { row, pattern, pre, trig } of BODY_TABLE) {
    it(`wraps ${row} in its assumption literal`, () => {
      const e = encode(
        req({ id: 'REQ-1', patternType: pattern, preCondition: pre, trigger: trig }),
        byKind,
      )
      expect(e.guard).toBe('REQ-1')
      expect(e.formula).toEqual(implies(atom('REQ-1'), e.body))
    })
  }

  it('is retractable — an unassumed guard leaves the body unconstrained', async () => {
    // The AST assertions above are structural; this is the property they buy. With the guard
    // false, a spec can hold even where the body is violated, which is what makes
    // `solver.check(...guards)` attribute a core to requirements instead of proving the
    // document inconsistent no matter which guards were assumed.
    const ctx = await getContext('symspec-encode-retractable-guard')
    for (const { row, pattern, pre, trig } of BODY_TABLE) {
      const e = encode(
        req({ id: 'REQ-1', patternType: pattern, preCondition: pre, trigger: trig }),
        byKind,
      )
      const solver = new ctx.Solver()
      solver.add(materialize(ctx, e.formula))
      solver.add(materialize(ctx, not(atom(e.guard))))
      // Every guard true and the response false — the body's one falsifying model.
      for (const a of e.atoms) {
        solver.add(materialize(ctx, a.kind === 'resp' ? not(atom(a.atom)) : atom(a.atom)))
      }
      expect(await solver.check(), `${row}'s body survives its guard being false`).toBe('sat')
    }
  })
})

describe('a slot that carries no atomizable content', () => {
  // Through `makeAtomize()`, not a stub: `'   '` and `'---'` are non-empty RAW text, so only
  // the normalized body can tell they are empty.
  const omitted = ['   ', '---', '  ...  ', '???']

  for (const text of omitted) {
    it(`omits a trigger of ${JSON.stringify(text)} rather than atomizing it`, () => {
      const e = encode(req({ id: 'REQ-1', patternType: 'event-driven', trigger: text }), real)
      expect(e.atoms.map((a) => a.kind)).toEqual(['resp'])
      expect(e.body).toEqual(atom(e.atoms[0]?.atom ?? ''))
    })

    it(`omits a precondition of ${JSON.stringify(text)} rather than atomizing it`, () => {
      const e = encode(req({ id: 'REQ-1', patternType: 'state-driven', preCondition: text }), real)
      expect(e.atoms.map((a) => a.kind)).toEqual(['resp'])
    })
  }

  it('omits an absent or blank slot', () => {
    for (const text of [undefined, '']) {
      const e = encode(req({ id: 'REQ-1', patternType: 'event-driven', trigger: text }), real)
      expect(e.atoms.map((a) => a.kind)).toEqual(['resp'])
    }
  })

  it('never emits an atom with an empty body, so two malformed requirements never meet', () => {
    // The failure the rule prevents, stated as the failure: `sys__lift_controller__trig__` is
    // the SAME atom for every requirement under this system whose trigger normalized away, and
    // sharing a context atom is what puts two requirements in one context group.
    const first = encode(
      req({
        id: 'REQ-1',
        patternType: 'event-driven',
        trigger: '---',
        systemResponse: 'halt the car',
      }),
      real,
    )
    const second = encode(
      req({
        id: 'REQ-2',
        patternType: 'event-driven',
        trigger: '***',
        systemResponse: 'sound the chime',
      }),
      real,
    )
    for (const e of [first, second]) {
      for (const a of e.atoms) expect(bodyOf(a.atom), `empty body in ${a.atom}`).not.toBe('')
    }
    const shared = first.atoms
      .map((a) => a.atom)
      .filter((name) => second.atoms.some((a) => a.atom === name))
    expect(shared, 'two malformed requirements share an atom').toEqual([])
  })

  it('keeps a slot whose normalization is non-empty', () => {
    // Without this the omission cases pass against an encoder that drops every context slot.
    const e = encode(
      req({ id: 'REQ-1', patternType: 'event-driven', trigger: 'the call button is pressed' }),
      real,
    )
    expect(e.atoms.map((a) => a.kind)).toEqual(['trig', 'resp'])
  })
})

describe('z3 interns a Bool const by name within a context', () => {
  // NOT sabotageable from this repo: it is a `z3-solver` property, and `contradiction.ts` rests
  // on it when it asserts a context group's atoms with `ctx.Bool.const(name)` against formulas
  // that were materialized separately. Nothing else in the suite would notice if an upgrade
  // made two same-named Bools distinct — every group check would simply go `sat` and the tier
  // would report a clean spec forever. This case is the alarm for that.
  const NAME = 'sys__lift_controller__pre__door_open'

  it('gives the same AST for two independent constructions', async () => {
    const ctx = await getContext('symspec-encode-interning')
    const direct = ctx.Bool.const(NAME)
    const viaFormula = materialize(ctx, atom(NAME))
    expect(direct.eqIdentity(viaFormula)).toBe(true)
    expect(direct.id()).toBe(viaFormula.id())
    // Non-vacuity: identity is not `true` for everything.
    expect(direct.eqIdentity(ctx.Bool.const(`${NAME}_2`))).toBe(false)
  })

  it('makes a separately-asserted atom constrain a materialized formula', async () => {
    // The behavioural form of the same property, which is the one the tier depends on.
    const ctx = await getContext('symspec-encode-interning-behaviour')
    const solver = new ctx.Solver()
    solver.add(
      materialize(ctx, implies(atom(NAME), atom('sys__lift_controller__resp__halt_the_car'))),
    )
    solver.add(ctx.Bool.const(NAME))
    solver.add(ctx.Not(ctx.Bool.const('sys__lift_controller__resp__halt_the_car')))
    expect(await solver.check()).toBe('unsat')
  })
})
