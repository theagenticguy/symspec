/**
 * A numeric bound is a fact only where its GUARD holds.
 *
 * `contradiction.ts`'s header names the rule: "a global conjunction that asserts ALL
 * triggers true at once manufactures spurious conflicts between mutually exclusive
 * triggers". This tier reads bounds out of the guard slots too, so it needs the same
 * context partition — and it is verdict-eligible at `error` severity, where a false
 * positive is the cardinal sin.
 *
 * Most cases here drive `findNumericContradictions` directly with hand-built contexts, so the
 * partition is pinned without depending on how a sentence atomizes. `fabrication.ts` carries
 * the end-to-end halves: `disjoint-temperature-guards` for the fence that holds, and
 * `crossSlotBridgeDoc` for the one that does not.
 *
 * Each "no conflict" assertion is paired with a POSITIVE control on the same bounds, so it
 * cannot pass because the arithmetic was satisfiable or the tier stopped running.
 *
 * One `describe` reads the planned CELL LIST instead of the findings, because collapsing
 * duplicate cells is invisible in the findings — the finding map drops a repeated core
 * anyway — so a findings-only suite cannot tell that mechanism's presence from its absence.
 */

import { describe, expect, it } from 'vitest'
import { getContext } from './backend.ts'
import type { NumericPredicate, PredicateSlot } from './numeric.ts'
import {
  findNumericContradictions,
  planComparisonCells,
  type RequirementPredicates,
} from './numeric-contradiction.ts'

const WARM = 'sys__vent__pre__temperature_above_5'
const COLD = 'sys__vent__pre__temperature_below_3'
const RUNNING = 'sys__vent__trig__the_fan_starts'
/** The COLD guard as a TRIGGER, so a two-slot context is one `pre` plus one `trig` — the
 * only shape a requirement can actually have, since it owns one slot of each kind. */
const COLD_TRIG = 'sys__vent__trig__temperature_below_3'

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

  it('reports one conflict once when two DIFFERENT cells minimize to the same core', async () => {
    // The `nested` case above cannot distinguish the two de-duplications from each other:
    // its three groups all yield the same live id set, so the cell key already collapses
    // them and the finding map never sees a repeat. Here the live sets DIFFER —
    // `{req-loose, req-tight}` in the baseline group and `{req-loose, req-tight, req-warm}`
    // in `{WARM}` — so two cells reach the solver, and `req-warm`'s vacuous `>= 0` bound
    // minimizes away in the second. Only the FINDING key stops the duplicate.
    const findings = await run('same-core', [
      req('req-tight', [], [bound('<=', 10)]),
      req('req-loose', [], [bound('>=', 500)]),
      req('req-warm', [WARM], [bound('>=', 0, 'pre')]),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-loose', 'req-tight']])
  })

  it('reports two conflicts when two cells hold two different cores', async () => {
    // The half of the SPLIT claim that runs the other way: a finer partition removes
    // co-assertions, so it can never invent a conflict, but the FINDING COUNT can rise. One
    // global pass per quantity collapses every minimal core on that quantity into one solver
    // call and one finding; here the guarded pair and the unconditional pair are two cells
    // with two cores, and both are real.
    //
    // The ids are chosen so the guarded pair sorts FIRST inside the `{WARM}` cell, which
    // holds all four bounds and admits both cores. Which one z3 names is a function of the
    // id-sorted sequence it is fed — the module header's determinism claim — so the naming is
    // the fixture's lever, not an accident: with the unconditional pair sorting first, both
    // cells minimize to it and the finding map collapses them to one.
    const findings = await run('two-cores', [
      req('req-a-hi', [WARM], [bound('>=', 1000, 'resp')]),
      req('req-a-lo', [WARM], [bound('<=', 500, 'resp')]),
      req('req-z-hi', [], [bound('>=', 100)]),
      req('req-z-lo', [], [bound('<=', 10)]),
    ])
    // The baseline group is planned first, so its cell's finding leads.
    expect(findings.map((f) => f.requirementIds)).toEqual([
      ['req-z-hi', 'req-z-lo'],
      ['req-a-hi', 'req-a-lo'],
    ])
  })
})

/**
 * The cell partition, asserted on the cell LIST rather than through the solver.
 *
 * Collapsing duplicate cells changes no output: two cells with one live id set prove one
 * core, and the finding map drops the repeat. So the only way to know the cell key is a
 * gate rather than dead weight is to read the plan it produces — the solver-call count and
 * the `budget.truncate` skipped figure are its only other observables, and neither is
 * reachable from a passing assertion on findings.
 */
describe('the planned cell list', () => {
  it('collapses nested groups that host the same live requirements', () => {
    // Three groups (baseline, `{WARM}`, `{WARM, RUNNING}`), one live id set in each,
    // because `req-warm` and `req-both` carry no bounds on the quantity.
    const cells = planComparisonCells([
      req('req-tight', [], [bound('<=', 10)]),
      req('req-loose', [], [bound('>=', 500)]),
      req('req-warm', [WARM], []),
      req('req-both', [WARM, RUNNING], []),
    ])
    expect(cells.map((c) => [...c.distinctIds].sort())).toEqual([['req-loose', 'req-tight']])
  })

  it('keeps two cells when the live requirements differ, even on one quantity', () => {
    // The negative guard. Keying on the comparison key alone would collapse these two —
    // same quantity, same base unit — and drop a cell whose assertion set is strictly
    // larger, which is where a conflict only `req-warm` participates in would live.
    const cells = planComparisonCells([
      req('req-tight', [], [bound('<=', 10)]),
      req('req-loose', [], [bound('>=', 500)]),
      req('req-warm', [WARM], [bound('>=', 0, 'pre')]),
    ])
    expect(cells.map((c) => [...c.distinctIds].sort())).toEqual([
      ['req-loose', 'req-tight'],
      ['req-loose', 'req-tight', 'req-warm'],
    ])
  })
})

/**
 * A requirement inconsistent with ITSELF, which the tier reports with ONE id.
 *
 * Two guard slots put two opposed bounds on one quantity key, so the requirement's own
 * claims cannot co-hold and z3's core names it alone. `minimizeNumericCore` refuses to
 * shrink a core below two ids but does not constrain the core it receives, so the one-id
 * core reaches `requirementIds` untouched — pinned here because the shape is easy to
 * assume away, and the pipeline's certification predicate is written around it.
 */
describe('a self-inconsistent requirement', () => {
  it('is blamed alone, once its cell has a second contributor', async () => {
    const findings = await run('self', [
      req('req-bridge', [WARM, COLD_TRIG], [bound('>', 5, 'pre'), bound('<', 3, 'trig')]),
      req('req-warm', [WARM], [bound('>', 5, 'pre')]),
    ])
    expect(findings.map((f) => f.requirementIds)).toEqual([['req-bridge']])
    // The message renders the id list, so a one-id core reads as a plural sentence about a
    // single requirement. Asserted so the wording is a decision on record rather than an
    // accident of `join(', ')`.
    expect(findings[0]?.message).toBe(
      'Requirements req-bridge place jointly unsatisfiable numeric constraints on "temperature".',
    )
  })

  it('is not reported when it is its cell`s only contributor', async () => {
    // The `distinctIds.size < 2` skip, and the whole of what it hides: the same
    // requirement, alone. A MISS, the honest direction.
    const findings = await run('self-alone', [
      req('req-bridge', [WARM, COLD_TRIG], [bound('>', 5, 'pre'), bound('<', 3, 'trig')]),
    ])
    expect(findings).toEqual([])
  })
})
