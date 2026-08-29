/**
 * A numeric bound is a fact only where its GUARD holds.
 *
 * `contradiction.ts`'s header names the rule: "a global conjunction that asserts ALL
 * triggers true at once manufactures spurious conflicts between mutually exclusive
 * triggers". This tier reads bounds out of the guard slots too, so it needs the same
 * context partition — and it is verdict-eligible at `error` severity, where a false
 * positive is the cardinal sin.
 *
 * Every case here drives `findNumericContradictions` directly with hand-built contexts, so
 * the partition is pinned without depending on how a sentence atomizes. `fabrication.ts`'s
 * `disjoint-temperature-guards` fixture carries the end-to-end half.
 *
 * Each "no conflict" assertion is paired with a POSITIVE control on the same bounds, so it
 * cannot pass because the arithmetic was satisfiable or the tier stopped running.
 */

import { describe, expect, it } from 'vitest'
import { getContext } from './backend.ts'
import type { NumericPredicate, PredicateSlot } from './numeric.ts'
import { findNumericContradictions, type RequirementPredicates } from './numeric-contradiction.ts'

const WARM = 'sys__vent__pre__temperature_above_5'
const COLD = 'sys__vent__pre__temperature_below_3'
const RUNNING = 'sys__vent__trig__the_fan_starts'

/** One bound on the one shared quantity, so every case is about the partition. */
const bound = (
  comparator: NumericPredicate['comparator'],
  value: number,
  slot: PredicateSlot = 'resp',
): NumericPredicate => ({
  quantity: 'sys__vent__qty__temperature',
  label: 'temperature',
  comparator,
  value,
  baseUnit: '',
  slot,
  sourceText: `${comparator} ${value}`,
})

const req = (
  id: string,
  contextAtoms: readonly string[],
  predicates: readonly NumericPredicate[],
): RequirementPredicates => ({ id, contextAtoms, predicates })

const run = async (name: string, reqs: readonly RequirementPredicates[]) =>
  findNumericContradictions(await getContext(`symspec-numeric-context-${name}`), reqs)

describe('the numeric sweep is per reachable context', () => {
  it('proves nothing between two bounds whose guards cannot both hold', async () => {
    // FABRICATION C. `temp > 5` and `temp < 3` are jointly unsatisfiable arithmetic and
    // ALSO two antecedents of two different requirements, so they are never facts at the
    // same time. Two disjoint guards are two groups, each hosting one requirement.
    const findings = await run('disjoint', [
      req('req-warm', [WARM], [bound('>', 5, 'pre')]),
      req('req-cold', [COLD], [bound('<', 3, 'pre')]),
    ])
    expect(findings).toEqual([])
  })

  it('proves the SAME bounds once the two requirements share a guard', async () => {
    // The control. Identical arithmetic, one guard: the conflict is real and reported, so
    // the case above is a statement about liveness rather than about the solver.
    const findings = await run('shared', [
      req('req-warm', [WARM], [bound('>', 5, 'pre')]),
      req('req-cold', [WARM], [bound('<', 3, 'resp')]),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-cold', 'req-warm']])
  })

  it('names the slot each blamed bound came from', async () => {
    // The role is output bytes: an author reading the core has to be able to tell the
    // obligation from the precondition without re-reading the sentence.
    const findings = await run('slots', [
      req('req-warm', [WARM], [bound('>', 5, 'pre')]),
      req('req-cold', [WARM], [bound('<', 3, 'resp')]),
    ])
    expect(findings[0]?.evidence.numeric?.predicates.map((p) => [p.requirementId, p.slot])).toEqual(
      [
        ['req-warm', 'pre'],
        ['req-cold', 'resp'],
      ],
    )
  })

  it('keeps an UNCONDITIONAL pair comparable, because an empty guard holds everywhere', async () => {
    // `[] ⊆ anything`: two ubiquitous bounds always co-hold, and they meet in the baseline
    // group. An all-unconditional document therefore behaves exactly as it did before the
    // context partition existed.
    const findings = await run('ubiquitous', [
      req('req-tight', [], [bound('<=', 10)]),
      req('req-loose', [], [bound('>=', 500)]),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-loose', 'req-tight']])
  })

  it('compares an unconditional bound against a GUARDED one inside the guard`s group', async () => {
    // The other half of `[] ⊆ anything`, and the reason liveness is a subset test rather
    // than key equality: an unconditional obligation is in force while the guard holds, so
    // the conflict is reachable and must still be proved.
    const findings = await run('mixed', [
      req('req-anytime', [], [bound('<=', 10)]),
      req('req-warm', [WARM], [bound('>=', 500, 'resp')]),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-anytime', 'req-warm']])
  })

  it('reports one conflict once, even though nested groups both reach it', async () => {
    // `{WARM}` and `{WARM, RUNNING}` are two groups and the unconditional pair is live in
    // both, so the same core is provable twice. One conflict is one finding.
    const findings = await run('nested', [
      req('req-tight', [], [bound('<=', 10)]),
      req('req-loose', [], [bound('>=', 500)]),
      req('req-warm', [WARM], []),
      req('req-both', [WARM, RUNNING], []),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-loose', 'req-tight']])
  })
})
