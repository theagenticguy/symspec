/**
 * AC-30-2: the numeric-predicate extractor. Deterministic regex/lexicon parse
 * of `(quantity, comparator, value, unit)` tuples with unit normalization and
 * per-system quantity-identity.
 */

import { describe, expect, it } from 'vitest'
import { extractNumericPredicates } from '../numeric.js'

describe('extractNumericPredicates (AC-30-2)', () => {
  it('extracts an upper-bound with unit normalization (s → ms)', () => {
    const preds = extractNumericPredicates('respond within 2 seconds', 'api')
    expect(preds).toHaveLength(1)
    expect(preds[0]!.comparator).toBe('<=')
    expect(preds[0]!.value).toBe(2000) // 2 s → 2000 ms
    expect(preds[0]!.baseUnit).toBe('ms')
  })

  it('extracts "at most N" as <=', () => {
    const preds = extractNumericPredicates('retry at most 3 retries', 'worker')
    expect(preds).toHaveLength(1)
    expect(preds[0]!.comparator).toBe('<=')
    expect(preds[0]!.value).toBe(3)
    expect(preds[0]!.baseUnit).toBe('') // "retries" is not a known unit → unitless
  })

  it('extracts "above N" as > and "below N" as <', () => {
    const above = extractNumericPredicates('keep temperature above 40', 'oven')
    expect(above[0]!.comparator).toBe('>')
    expect(above[0]!.value).toBe(40)
    const below = extractNumericPredicates('keep temperature below 30', 'oven')
    expect(below[0]!.comparator).toBe('<')
    expect(below[0]!.value).toBe(30)
  })

  it('scopes the quantity per system: same label, different system → different key', () => {
    const a = extractNumericPredicates('respond within 200 ms', 'service a')
    const b = extractNumericPredicates('respond within 200 ms', 'service b')
    expect(a[0]!.quantity).not.toBe(b[0]!.quantity)
  })

  it('unifies the same quantity across article/casing variants', () => {
    const a = extractNumericPredicates('the Latency within 200 ms', 'api')
    const b = extractNumericPredicates('latency at most 100 ms', 'api')
    expect(a[0]!.quantity).toBe(b[0]!.quantity)
  })

  it('returns [] when no numeric predicate is present', () => {
    expect(extractNumericPredicates('issue a session token', 'auth')).toEqual([])
  })

  it('normalizes byte units (kb → B)', () => {
    const preds = extractNumericPredicates('payload no more than 2 kb', 'api')
    expect(preds[0]!.comparator).toBe('<=')
    expect(preds[0]!.value).toBe(2000)
    expect(preds[0]!.baseUnit).toBe('B')
  })
})

/**
 * T-AC-1-1: `quantity` is an IDENTITY (what is bounded); `baseUnit` is a SCALE
 * (what the value was normalized onto). They are separate fields on purpose —
 * unit comparability is decided by the consumers that group predicates
 * (`numeric-contradiction.ts` `comparisonKey`, `quantity-alias.ts`), never by
 * mutating the decide-tier key. These tests pin that split so a future "fix" to
 * unit handling cannot silently rename the quantity key (which would change the
 * emitted `evidence.numeric.quantity` and SMT-LIB2 Real const of every already
 * correct same-unit finding).
 */
describe('T-AC-1-1 — quantity key excludes baseUnit; baseUnit carries the scale', () => {
  it('one label with different units shares the quantity key but differs in baseUnit', () => {
    const unitless = extractNumericPredicates('respond within 5', 'controller')
    const millis = extractNumericPredicates('respond over 2000 ms', 'controller')
    expect(unitless[0]!.quantity).toBe(millis[0]!.quantity)
    expect(unitless[0]!.baseUnit).toBe('')
    expect(millis[0]!.baseUnit).toBe('ms')
  })

  it('the quantity key carries no unit suffix', () => {
    const preds = extractNumericPredicates('respond within 5 ms', 'controller')
    expect(preds[0]!.quantity).toBe('sys__controller__qty__respond')
  })

  it('different dimensions on one label are distinguished only by baseUnit', () => {
    const time = extractNumericPredicates('transfer within 100 ms', 'api')
    const bytes = extractNumericPredicates('transfer over 2000 kb', 'api')
    expect(time[0]!.quantity).toBe(bytes[0]!.quantity)
    expect(time[0]!.baseUnit).toBe('ms')
    expect(bytes[0]!.baseUnit).toBe('B')
  })

  it('an unrecognized unit token stays unitless rather than inventing a base', () => {
    // "retries" is not in DIMENSIONS, so the predicate is unitless — its
    // magnitude is unknown and it must never be compared to a normalized bound.
    const preds = extractNumericPredicates('retry at most 3 retries', 'worker')
    expect(preds[0]!.baseUnit).toBe('')
  })
})
