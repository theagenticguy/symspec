/**
 * The relational blind-spot tier's first behavioral tests.
 *
 * ## Why this file exists
 *
 * `findRelationalUnchecked` shipped with no assertion anywhere on its grouping, either recognized
 * shape, or its demotion — the only test-file mention of `FND_RELATIONAL_UNCHECKED` in the repo was
 * inside `advice/repair.test.ts`'s exhaustive reason list, which pins that a repair EXISTS for the
 * reason and never that the reason is reachable.
 *
 * The cost of that gap was measured, not hypothesised. Sharing `guardKeyOf`'s composite
 * `<pre>|<trigger>` key made this tier's partition finer, which silently DELETED disclosures for
 * requirements that share one slot and differ in the other. Deleting a disclosure deletes its
 * demotion, and deleting a demotion moves `verified` toward `true` — so a document the fabrication
 * corpus files as a KNOWN open gap acquired `verified: true` beside two error-severity findings,
 * and nothing in 1696 tests noticed.
 *
 * ## The direction rule these tests encode
 *
 * The safe direction for a key is OPPOSITE for a prover and a discloser:
 *
 * - `findQuantityAliasCandidates` feeds a committed alias and then a proof, so a too-COARSE key
 *   co-asserts guards no requirement declared together and fabricates. Finer is safer.
 * - this tier only ever emits `info` and a demotion, so a too-coarse key over-discloses (harmless)
 *   while a too-FINE key under-discloses, which is the forbidden direction.
 *
 * Both tiers still derive from the same `guardKeyOf`, and that is fine — what differs is the
 * GRANULARITY each groups at, which is the thing these tests pin.
 */

import { describe, expect, it } from 'vitest'
import { findRelationalUnchecked, hasRelationalLanguage } from './relational.ts'

/** A member of the tier's input, with the fields a test actually varies. */
const member = (
  id: string,
  fields: {
    readonly systemName?: string
    readonly preCondition?: string
    readonly trigger?: string
    readonly responseText?: string
    readonly hasNumericBound?: boolean
    readonly hasUnmatchedAtom?: boolean
  } = {},
) => ({
  id,
  systemName: fields.systemName ?? 'pump',
  // `guardKey` is `''` only when wholly unguarded — that is the skip signal. Otherwise its exact
  // value is irrelevant to grouping, which reads the raw slots.
  guardKey:
    fields.preCondition === undefined && fields.trigger === undefined
      ? ''
      : `${fields.preCondition ?? ''}|${fields.trigger ?? ''}`,
  ...(fields.preCondition !== undefined ? { preCondition: fields.preCondition } : {}),
  ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
  responseText: fields.responseText ?? 'hold the pressure at most 10 bar',
  hasNumericBound: fields.hasNumericBound ?? true,
  hasUnmatchedAtom: fields.hasUnmatchedAtom ?? true,
})

describe('the relational tier groups on EACH guard slot, not on the slot pair', () => {
  it('discloses a pair that shares a TRIGGER and differs in precondition', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Under the composite `<pre>|<trigger>` key these two
    // requirements key apart, the group drops below two, and the disclosure — with its demotion —
    // vanishes.
    const found = findRelationalUnchecked([
      member('r1', { trigger: 'the cycle begins' }),
      member('r2', { trigger: 'the cycle begins', preCondition: 'the tank is primed' }),
    ])
    expect(found.map((f) => f.requirementIds)).toEqual([['r1', 'r2']])
  })

  it('discloses a pair that shares a PRECONDITION and differs in trigger', () => {
    // The mirror case, so the property is about slots rather than about `trigger` specifically.
    const found = findRelationalUnchecked([
      member('r1', { preCondition: 'the tank is primed' }),
      member('r2', { preCondition: 'the tank is primed', trigger: 'the cycle begins' }),
    ])
    expect(found.map((f) => f.requirementIds)).toEqual([['r1', 'r2']])
  })

  it('emits ONE finding for a pair that shares BOTH slots', () => {
    // Per-slot membership groups such a pair twice. Two findings naming one id set would
    // double-count one blind spot in `residualRisk` and push two identical demotions.
    const found = findRelationalUnchecked([
      member('r1', { preCondition: 'the tank is primed', trigger: 'the cycle begins' }),
      member('r2', { preCondition: 'the tank is primed', trigger: 'the cycle begins' }),
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.requirementIds).toEqual(['r1', 'r2'])
  })

  it('still separates two requirements that share NO slot', () => {
    // Coarser than the composite key, not global. Two unrelated contexts are still two groups, or
    // the tier would disclose on every document with two numeric bounds.
    expect(
      findRelationalUnchecked([
        member('r1', { trigger: 'the cycle begins' }),
        member('r2', { trigger: 'the vessel docks' }),
      ]),
    ).toEqual([])
  })

  it('still separates two systems that share a guard phrase', () => {
    expect(
      findRelationalUnchecked([
        member('r1', { systemName: 'pump', trigger: 'the cycle begins' }),
        member('r2', { systemName: 'valve', trigger: 'the cycle begins' }),
      ]),
    ).toEqual([])
  })

  it('skips a wholly unguarded requirement', () => {
    // An always-on group is the one context a reader can already see co-occurs, so skipping it is
    // an under-disclosure the tier accepts deliberately.
    expect(
      findRelationalUnchecked([member('r1'), member('r2')]),
      'unguarded requirements must not form a group',
    ).toEqual([])
  })
})

describe('the two recognized shapes', () => {
  it('shape A needs two numeric bounds AND an unmatched atom', () => {
    const base = { trigger: 'the cycle begins', responseText: 'hold the pressure at most 10 bar' }
    // Two bounds, no singleton atom: the tier declines.
    expect(
      findRelationalUnchecked([
        member('r1', { ...base, hasUnmatchedAtom: false }),
        member('r2', { ...base, hasUnmatchedAtom: false }),
      ]),
    ).toEqual([])
    // One bound only: the tier declines.
    expect(
      findRelationalUnchecked([
        member('r1', base),
        member('r2', { ...base, hasNumericBound: false }),
      ]),
    ).toEqual([])
  })

  it('shape B fires on inter-entity comparison language with no numeric bound at all', () => {
    const found = findRelationalUnchecked([
      member('r1', {
        trigger: 'the cycle begins',
        responseText: 'keep the outlet rate the same as the inlet rate',
        hasNumericBound: false,
        hasUnmatchedAtom: false,
      }),
      member('r2', {
        trigger: 'the cycle begins',
        responseText: 'report a reading that differs from the reference channel',
        hasNumericBound: false,
        hasUnmatchedAtom: false,
      }),
    ])
    expect(found.map((f) => f.requirementIds)).toEqual([['r1', 'r2']])
  })

  it('recognizes comparison BETWEEN entities and not every use of `from` or `same`', () => {
    expect(hasRelationalLanguage('report a reading that differs from the reference channel')).toBe(
      true,
    )
    expect(hasRelationalLanguage('keep the outlet rate the same as the inlet rate')).toBe(true)
    expect(hasRelationalLanguage('remove the entry from the queue')).toBe(false)
    expect(hasRelationalLanguage('log the same message')).toBe(false)
  })
})
