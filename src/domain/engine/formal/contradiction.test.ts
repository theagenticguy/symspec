/**
 * WHICH requirements a contradiction blames is a function of the requirement SET,
 * never of where in the file an author put a rule (invariant 5: byte-reproducible
 * given the document, its committed tables, and the pinned model).
 *
 * A group can admit MORE THAN ONE minimal unsat subset. The smallest such group is
 * `A ⇒ p`, `B ⇒ ¬p`, `C ⇒ ¬p` — one rule demanding a response and two forbidding
 * it — where `{A,B}` and `{A,C}` are both minimal and `{B,C}` is sat. Every fixture
 * in this file is that shape, propositionally, arithmetically, and temporally.
 *
 * Reporting either overlapping core is SOUND: both are real conflicts, and the
 * unreported one is a MISS — the honest failure direction. What is not acceptable
 * is which one being decided by a line number, because the culprit ids are OUTPUT
 * BYTES: `requirementIds` on the finding, and the ids interpolated into `message`.
 *
 * Two layers hold that property, and this file gates them separately because they
 * fail separately.
 *
 *   1. THE TIER ENTRY POINTS feed the solver an id-sorted sequence. This is the
 *      layer that decides real output, because `unsatCore()` picks the candidate
 *      set, and — measured on this z3-solver build, in all three tiers, whether or
 *      not `smt.core.minimize` is set — its pick on a two-minimal-core group is
 *      already irreducible at two ids, so the deletion pass below gets nothing to
 *      delete. The `culprit set is a function of the requirement set` cases drive
 *      `findContradictions`, `findNumericContradictions` and
 *      `findTemporalContradictions` over every permutation of a three-requirement
 *      spec and pin ONE blame set per tier.
 *
 *   2. THE MINIMIZERS sort their candidates before deleting, so a core handed over
 *      in any order yields the same subset. This is belt-and-suspenders — it holds
 *      even if a future solver returned the same core in a different order, or
 *      returned a core wide enough for the deletion pass to bite. The
 *      `minimizeCore` / `minimizeNumericCore` cases drive the exported minimizers
 *      directly with a hand-built 3-element core, which is the only way to reach a
 *      candidate set the deletion loop actually shrinks.
 *
 * Each layer carries a negative control proving its fixture admits two distinct
 * minimal cores. Without one, a determinism assertion passes just as happily against
 * a degenerate fixture with a single core, where every order trivially agrees.
 *
 * The minimizers' canonical key is the requirement ID, not the rendered Z3 symbol.
 * Z3 quotes a symbol whose text is not a legal SMT-LIB2 *simple* symbol — a UUID
 * beginning with a digit renders as `|3f2a…|` — and `|` sorts after every letter, so
 * the two keys disagree. Each minimizer gets a case where they disagree on the
 * ANSWER, so the choice of key is gated rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { getContext, type Z3Context } from './backend.ts'
import { findContradictions, minimizeCore } from './contradiction.ts'
import { cmp, type EncodableRequirement, materialize, type Z3Bool } from './encode.ts'
import type { NumericPredicate } from './numeric.ts'
import {
  findNumericContradictions,
  minimizeNumericCore,
  type RequirementPredicates,
} from './numeric-contradiction.ts'
import { findTemporalContradictions, type RequirementTemporal } from './temporal.ts'
import { F, G, tAtom, tImplies, tNot } from './temporal-patterns.ts'

/** Every ordering of a 3-element tuple, so no permutation is left unprobed. */
function permutations<T>(items: readonly [T, T, T]): Array<[T, T, T]> {
  const [x, y, z] = items
  return [
    [x, y, z],
    [x, z, y],
    [y, x, z],
    [y, z, x],
    [z, x, y],
    [z, y, x],
  ]
}

/** Index permutations, for picking a fixture's three members in every order. */
const ORDERS = permutations([0, 1, 2] as const)

/**
 * `A ⇒ p`, `B ⇒ ¬p`, `C ⇒ ¬p` as permanent assertions, with the three guards as
 * assumption literals. `minimizeCore` re-checks on the same solver, exactly as
 * `findContradictions` does — the whole-spec formulas are `add()`ed and only the
 * guards are assumed.
 */
function twoMinimalCores(
  ctx: Z3Context,
  ids: readonly [string, string, string],
  tag: string,
): { solver: InstanceType<Z3Context['Solver']>; guards: [Z3Bool, Z3Bool, Z3Bool] } {
  const [essential, forbidA, forbidB] = ids
  const solver = new ctx.Solver()
  const p = ctx.Bool.const(`${tag}_response`)
  const g = (id: string) => ctx.Bool.const(id)
  solver.add(ctx.Implies(g(essential), p))
  solver.add(ctx.Implies(g(forbidA), ctx.Not(p)))
  solver.add(ctx.Implies(g(forbidB), ctx.Not(p)))
  return { solver, guards: [g(essential), g(forbidA), g(forbidB)] }
}

/** The requirement id a guard names, with Z3's `|...|` quoting stripped. */
const guardIdOf = (b: Z3Bool): string => b.toString().replace(/^\|(.*)\|$/, '$1')

/** The requirement ids a minimized core names, as an order-free comparison string. */
const idsOf = (core: readonly Z3Bool[]): string => core.map(guardIdOf).sort().join(',')

/**
 * The id tuples the propositional minimizer cases instantiate. Each is a separate
 * instantiation of `twoMinimalCores`, so each needs its own control.
 */
const PROP_ID_TUPLES: ReadonlyArray<readonly [string, string, string]> = [
  ['req-a', 'req-b', 'req-c'],
  ['a-essential', '4quoted', 't-plain'],
]

describe('minimizeCore over a group with two minimal unsat cores', () => {
  it('returns the same requirement ids for every input order', async () => {
    const ctx = await getContext('symspec-contradiction-determinism')
    const ids = ['req-a', 'req-b', 'req-c'] as const
    const results = new Set<string>()
    for (const order of ORDERS) {
      const { solver, guards } = twoMinimalCores(ctx, ids, 'prop')
      const minimal = await minimizeCore(
        solver,
        order.map((i) => guards[i]),
      )
      expect(minimal.length).toBe(2)
      results.add(idsOf(minimal))
    }
    expect([...results]).toEqual(['req-a,req-c'])
  })

  it('canonicalizes on requirement id, not on the rendered Z3 symbol', async () => {
    const ctx = await getContext('symspec-contradiction-determinism-quoted')
    // `4quoted` is not a legal SMT-LIB2 simple symbol, so Z3 renders it `|4quoted|`
    // — which sorts AFTER `t-plain`, the reverse of the id order. The minimizer
    // drops the earlier of the two interchangeable guards, so the two keys pick
    // different survivors: id order keeps `t-plain`, symbol order keeps `4quoted`.
    const ids = ['a-essential', '4quoted', 't-plain'] as const
    expect(ctx.Bool.const('4quoted').toString()).toBe('|4quoted|')
    for (const order of ORDERS) {
      const { solver, guards } = twoMinimalCores(ctx, ids, 'quoted')
      const minimal = await minimizeCore(
        solver,
        order.map((i) => guards[i]),
      )
      expect(idsOf(minimal)).toBe('a-essential,t-plain')
    }
  })

  it('returns the culprits in ascending requirement id', async () => {
    // `minimizeCore` promises the survivors come back in the ascending-id order the
    // finding reports. The two cases above compare through `idsOf`, which sorts —
    // so neither of them can see the returned order at all.
    const ctx = await getContext('symspec-contradiction-determinism-order')
    const ids = ['a-essential', 'm-middle', 'z-last'] as const
    const { solver, guards } = twoMinimalCores(ctx, ids, 'order')
    const minimal = await minimizeCore(solver, [guards[2], guards[1], guards[0]])
    expect(minimal.map(guardIdOf)).toEqual(['a-essential', 'z-last'])
  })

  for (const ids of PROP_ID_TUPLES) {
    it(`admits two distinct minimal cores for (${ids.join(', ')})`, async () => {
      const ctx = await getContext(`symspec-contradiction-control-${ids[0]}`)
      const { solver, guards } = twoMinimalCores(ctx, ids, 'control')
      const [essential, forbidA, forbidB] = guards
      expect(await solver.check(essential, forbidA)).toBe('unsat')
      expect(await solver.check(essential, forbidB)).toBe('unsat')
      expect(await solver.check(forbidA, forbidB)).toBe('sat')
    })
  }
})

/** A response-slot bound on one shared quantity in one shared base unit, owned by `id`. */
function bound(comparator: NumericPredicate['comparator'], value: number): NumericPredicate {
  return {
    quantity: 'sys__probe__qty__replication_lag',
    label: 'replication lag',
    comparator,
    value,
    baseUnit: 'ms',
    slot: 'resp',
    sourceText: `${comparator} ${value} ms`,
  }
}

describe('minimizeNumericCore over a quantity with two minimal unsat cores', () => {
  // `lag >= 100` conflicts with `lag <= 10` and with `lag <= 20` independently,
  // while the two upper bounds are jointly satisfiable — the arithmetic twin of
  // the propositional fixture above.
  const entries = [
    { id: 'a-essential', pred: bound('>=', 100) },
    { id: 'm-middle', pred: bound('<=', 10) },
    { id: 'z-last', pred: bound('<=', 20) },
  ]

  it('returns the same requirement ids for every input order', async () => {
    const ctx = await getContext('symspec-numeric-determinism')
    const results = new Set<string>()
    for (const order of permutations(['a-essential', 'm-middle', 'z-last'] as const)) {
      const minimal = await minimizeNumericCore(ctx, entries, [...order])
      results.add([...minimal].sort().join(','))
    }
    expect([...results]).toEqual(['a-essential,z-last'])
  })

  it('returns the culprits in ascending requirement id', async () => {
    const ctx = await getContext('symspec-numeric-determinism-order')
    const minimal = await minimizeNumericCore(ctx, entries, ['z-last', 'm-middle', 'a-essential'])
    expect(minimal).toEqual(['a-essential', 'z-last'])
  })

  it('proves the fixture admits two distinct minimal cores', async () => {
    // Without this the determinism assertions above would pass against a fixture
    // with ONE minimal core, where every order trivially agrees.
    const ctx = await getContext('symspec-numeric-determinism-control')
    const guarded = (ids: readonly string[]) => {
      const solver = new ctx.Solver()
      for (const { id, pred } of entries) {
        if (!ids.includes(id)) continue
        solver.add(
          ctx.Implies(
            ctx.Bool.const(id),
            materialize(ctx, cmp(pred.quantity, pred.comparator, pred.value)),
          ),
        )
      }
      return solver.check(...ids.map((id) => ctx.Bool.const(id)))
    }
    expect(await guarded(['a-essential', 'm-middle'])).toBe('unsat')
    expect(await guarded(['a-essential', 'z-last'])).toBe('unsat')
    expect(await guarded(['m-middle', 'z-last'])).toBe('sat')
  })
})

/**
 * The three numeric requirements of the two-minimal-core shape, by id.
 *
 * All three are unconditional (`contextAtoms: []`), so all three are live in the one
 * baseline context group and the cell that admits two minimal cores exists. A guard on
 * any of them would split them into separate groups, which is the property
 * `disjoint-temperature-guards` covers and this fixture must not depend on.
 */
const NUMERIC_TRIO: readonly [RequirementPredicates, RequirementPredicates, RequirementPredicates] =
  [
    { id: 'req-a', contextAtoms: [], predicates: [bound('>=', 100)] },
    { id: 'req-b', contextAtoms: [], predicates: [bound('<=', 10)] },
    { id: 'req-c', contextAtoms: [], predicates: [bound('<=', 20)] },
  ]

/**
 * The temporal twin: `G(t → F p)` demands the response the two `G(¬p)` rules forbid.
 */
const TEMPORAL_TRIO: readonly [RequirementTemporal, RequirementTemporal, RequirementTemporal] = [
  { id: 'req-a', formula: G(tImplies(tAtom('t'), F(tAtom('p')))) },
  { id: 'req-b', formula: G(tNot(tAtom('p'))) },
  { id: 'req-c', formula: G(tNot(tAtom('p'))) },
]

/** The bound the temporal cases check at — small, since the conflict is immediate. */
const K = 3

/**
 * A three-requirement spec of the two-minimal-core shape, per tier, permuted every
 * way and driven through the tier's own public entry point.
 *
 * This is the layer that decides what an author sees, and the minimizer cases above
 * cannot reach it: `unsatCore()` chooses the candidate set, its choice on these
 * fixtures is already irreducible at two ids, and every deletion loop bails below a
 * pair — so through an entry point the minimizers receive a 2-element core and
 * delete nothing. Feed a tier in document order and reordering the three
 * requirements renames the culprit.
 */
describe('the culprit set is a function of the requirement set, not of document order', () => {
  /** Distinct blame sets across every permutation of a fixture; one means stable. */
  const blameSets = async <T>(
    trio: readonly [T, T, T],
    run: (order: readonly T[]) => Promise<ReadonlyArray<{ requirementIds: readonly string[] }>>,
  ): Promise<string[]> => {
    const seen = new Set<string>()
    for (const order of permutations(trio)) {
      const findings = await run(order)
      seen.add(findings.map((f) => f.requirementIds.join('+')).join(' | '))
    }
    return [...seen]
  }

  it('holds for findContradictions', async () => {
    // One event-driven rule demanding a response, two ubiquitous rules forbidding
    // it. The baseline group cannot reach the conflict (nothing asserts the
    // trigger), so it is the trigger group that goes unsat with two overlapping
    // minimal cores.
    const req = (
      id: string,
      trigger: string | undefined,
      negated: boolean,
    ): EncodableRequirement => ({
      id,
      patternType: trigger === undefined ? 'ubiquitous' : 'event-driven',
      preCondition: undefined,
      trigger,
      systemName: 'controller',
      systemResponse: 'open the relief valve',
      negated,
      sentence: '',
      priority: 'medium',
      status: 'draft',
    })
    const trio = [
      req('req-a', 'the tank pressure exceeds the limit', false),
      req('req-b', undefined, true),
      req('req-c', undefined, true),
    ] as const
    expect(await blameSets(trio, (order) => findContradictions([...order]))).toEqual([
      'req-a+req-b',
    ])
  })

  it('holds for findNumericContradictions', async () => {
    const ctx = await getContext('symspec-numeric-entry-determinism')
    expect(await blameSets(NUMERIC_TRIO, (order) => findNumericContradictions(ctx, order))).toEqual(
      ['req-a+req-c'],
    )
  })

  it('holds for findTemporalContradictions', async () => {
    const ctx = await getContext('symspec-temporal-entry-determinism')
    expect(
      await blameSets(TEMPORAL_TRIO, (order) => findTemporalContradictions(ctx, order, K)),
    ).toEqual(['req-a+req-b'])
  })

  it('proves each tier fixture admits two distinct minimal cores', async () => {
    // The permutation assertions above pin ONE blame set. On a fixture with a
    // single minimal core they would pin it whatever the tiers did with order, so
    // each fixture is shown genuinely ambiguous through the tier itself: either
    // prohibition alone still conflicts with `req-a`, and the two prohibitions do
    // not conflict with each other.
    const ctx = await getContext('symspec-entry-determinism-control')
    const only = <T extends { id: string }>(trio: readonly T[], ids: readonly string[]) =>
      trio.filter((r) => ids.includes(r.id))

    const numeric = (ids: readonly string[]) =>
      findNumericContradictions(ctx, only(NUMERIC_TRIO, ids))
    expect((await numeric(['req-a', 'req-b'])).map((f) => f.requirementIds)).toEqual([
      ['req-a', 'req-b'],
    ])
    expect((await numeric(['req-a', 'req-c'])).map((f) => f.requirementIds)).toEqual([
      ['req-a', 'req-c'],
    ])
    expect(await numeric(['req-b', 'req-c'])).toEqual([])

    const temporal = (ids: readonly string[]) =>
      findTemporalContradictions(ctx, only(TEMPORAL_TRIO, ids), K)
    expect((await temporal(['req-a', 'req-b'])).map((f) => f.requirementIds)).toEqual([
      ['req-a', 'req-b'],
    ])
    expect((await temporal(['req-a', 'req-c'])).map((f) => f.requirementIds)).toEqual([
      ['req-a', 'req-c'],
    ])
    expect(await temporal(['req-b', 'req-c'])).toEqual([])
  })
})
