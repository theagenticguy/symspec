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
