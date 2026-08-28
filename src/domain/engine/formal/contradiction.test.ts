/**
 * Unsat-core minimization is a function of the core's MEMBERSHIP, not of the
 * order the solver happened to hand it over in (invariant 5: byte-reproducible
 * given the document, its committed tables, and the pinned model).
 *
 * Deletion-based minimization visits candidates in the order it receives them, so
 * it settles on a different minimal subset for a different input order whenever
 * the group admits more than one. This file's fixture is the smallest group that
 * does: `A ⇒ p`, `B ⇒ ¬p`, `C ⇒ ¬p`, where `{A,B}` and `{A,C}` are both minimal
 * unsat subsets and `{B,C}` is sat. In requirement terms that is one rule
 * demanding a response and two rules forbidding it — nothing exotic.
 *
 * The surviving subset is OUTPUT BYTES: `requirementIds` on the finding, and the
 * ids interpolated into `message`. Its input is `unsatCore()`, whose order is the
 * solver's internal business rather than anything the document fixes. So both
 * minimizers canonicalize on requirement id before deleting, and both are pinned
 * here — the propositional tier through the exported `minimizeCore`, the numeric
 * tier through `minimizeNumericCore`.
 *
 * Measured on this z3-solver build, with the canonicalization removed: the
 * propositional minimizer returns `{req-a, req-c}` for input order `(A, B, C)` and
 * `{req-a, req-b}` for `(A, C, B)`.
 *
 * These assertions are the WHOLE gate on it: remove the canonicalization from both
 * minimizers and exactly the four determinism cases below go red, because no other
 * committed fixture builds a group with two minimal cores.
 *
 * The canonical key is the requirement ID, not the rendered Z3 symbol. Z3 quotes a
 * symbol whose text is not a legal SMT-LIB2 *simple* symbol — a UUID beginning
 * with a digit renders as `|3f2a…|` — and `|` sorts after every letter, so the two
 * keys disagree. Each tier gets a case where they disagree on the ANSWER, so the
 * choice of key is gated rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { getContext, type Z3Context } from './backend.ts'
import { minimizeCore } from './contradiction.ts'
import { cmp, materialize, type Z3Bool } from './encode.ts'
import type { NumericPredicate } from './numeric.ts'
import { minimizeNumericCore } from './numeric-contradiction.ts'

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

/** The requirement ids a minimized core names, as a stable comparison string. */
const idsOf = (core: readonly Z3Bool[]): string =>
  [...core.map((b) => b.toString().replace(/^\|(.*)\|$/, '$1'))].sort().join(',')

describe('minimizeCore over a group with two minimal unsat cores', () => {
  it('returns the same requirement ids for every input order', async () => {
    const ctx = await getContext('symspec-contradiction-determinism')
    const ids = ['req-a', 'req-b', 'req-c'] as const
    const results = new Set<string>()
    for (const order of permutations([0, 1, 2] as const)) {
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
    for (const order of permutations([0, 1, 2] as const)) {
      const { solver, guards } = twoMinimalCores(ctx, ids, 'quoted')
      const minimal = await minimizeCore(
        solver,
        order.map((i) => guards[i]),
      )
      expect(idsOf(minimal)).toBe('a-essential,t-plain')
    }
  })
})

/** A bound on one shared quantity in one shared base unit, owned by `id`. */
function bound(comparator: NumericPredicate['comparator'], value: number): NumericPredicate {
  return {
    quantity: 'sys__probe__qty__replication_lag',
    label: 'replication lag',
    comparator,
    value,
    baseUnit: 'ms',
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
