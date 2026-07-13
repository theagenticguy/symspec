/**
 * #1: the antonym command core — add / remove / list over the doc's committed
 * antonym pairs. The opposition analogue of the glossary core; same pure
 * `{next?, envelope}` shape. Both heads are normalized and matched in either
 * order; add is idempotent and rejects a self-pair or an inconsistent pair.
 */

import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { antonymAdd, antonymList, antonymRemove } from '../glossary.js'

describe('antonym command core (#1)', () => {
  it('add creates a normalized pair and returns the mutated doc', () => {
    const res = antonymAdd(emptyDoc(), 'open', 'shut')
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(res.next.antonyms).toEqual([{ a: 'open', b: 'shut' }])
    if (res.envelope.type !== 'error') expect(res.envelope.data.action).toBe('added')
  })

  it('normalizes both heads (leading article + case stripped)', () => {
    const res = antonymAdd(emptyDoc(), 'The Open', 'shut')
    if (!('next' in res)) throw new Error('expected next')
    expect(res.next.antonyms).toEqual([{ a: 'open', b: 'shut' }])
  })

  it('add is idempotent, matching either order (existing pair → noop, no next)', () => {
    const first = antonymAdd(emptyDoc(), 'open', 'shut')
    if (!('next' in first)) throw new Error('expected next')
    // Same pair, reversed order → noop.
    const again = antonymAdd(first.next, 'shut', 'open')
    expect('next' in again).toBe(false)
    if (again.envelope.type !== 'error') expect(again.envelope.data.action).toBe('noop')
  })

  it('rejects a self-pair (a verb cannot be its own antonym)', () => {
    const res = antonymAdd(emptyDoc(), 'open', 'the open')
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })

  it('rejects an empty head', () => {
    const res = antonymAdd(emptyDoc(), 'open', '   ')
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
  })

  it('rejects a pair inconsistent with the seed table (odd polarity cycle)', () => {
    // The seeds already assert open↔close (opposite). Asserting open↔close-as-same
    // via a bridge that forces same polarity must be rejected. Concretely: open
    // and close are opposite in the seeds; asserting they are... we instead force
    // a cycle by asserting open↔x and close↔x (making open and close SAME sign),
    // which contradicts the seed open↔close.
    const step1 = antonymAdd(emptyDoc(), 'open', 'ajar')
    if (!('next' in step1)) throw new Error('expected next')
    const step2 = antonymAdd(step1.next, 'close', 'ajar')
    // open↔ajar and close↔ajar ⇒ open and close share polarity, but the seed
    // open↔close says they are opposite → inconsistent cycle → rejected.
    expect('next' in step2).toBe(false)
    expect(step2.envelope.type).toBe('error')
    if (step2.envelope.type === 'error') expect(step2.envelope.code).toBe('ERR_USAGE')
  })

  it('remove drops a pair (either order) and no-ops when absent', () => {
    const added = antonymAdd(emptyDoc(), 'open', 'shut')
    if (!('next' in added)) throw new Error('expected next')
    const removed = antonymRemove(added.next, 'shut', 'open')
    if (!('next' in removed)) throw new Error('expected next')
    expect(removed.next.antonyms).toEqual([])

    const absent = antonymRemove(emptyDoc(), 'grant', 'deny')
    expect('next' in absent).toBe(false)
    if (absent.envelope.type !== 'error') expect(absent.envelope.data.action).toBe('noop')
  })

  it('list is read-only and reflects committed pairs', () => {
    const added = antonymAdd(emptyDoc(), 'open', 'shut')
    if (!('next' in added)) throw new Error('expected next')
    const listed = antonymList(added.next)
    expect('next' in listed).toBe(false)
    if (listed.envelope.type !== 'error') {
      expect(listed.envelope.data.action).toBe('listed')
      expect(listed.envelope.data.antonyms).toEqual([{ a: 'open', b: 'shut' }])
    }
  })
})
