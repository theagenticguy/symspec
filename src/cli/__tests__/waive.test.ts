import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import type { RequirementsDoc } from '../../core/schema.js'
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from '../envelope.js'
import { waiveAdd, waiveList, waiveRemove } from '../waive.js'

/**
 * Wishlist #3: `waive` manages committed finding waivers. add is idempotent,
 * remove of an absent waiver is a no-op, list is read-only; the optional scope
 * accepts a key or UUID and is stored as the UUID.
 */

const ID_A = '11111111-1111-4111-8111-111111111111'

function docWithKeyedReq(): RequirementsDoc {
  const doc = emptyDoc()
  doc.requirements[ID_A] = {
    id: ID_A,
    key: 'G1',
    patternType: 'ubiquitous',
    systemName: 'svc',
    systemResponse: 'do a',
    negated: false,
    sentence: 'The svc shall do a.',
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  return doc
}

describe('waive add', () => {
  it('adds a document-wide waiver with a reason', () => {
    const res = waiveAdd(emptyDoc(), 'GTWR_R6_MISSING_UNITS', 'RFC 9457 is a standard identifier')
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
    expect(res.next.waivers).toHaveLength(1)
    expect(res.next.waivers[0]?.code).toBe('GTWR_R6_MISSING_UNITS')
    expect(res.next.waivers[0]?.requirementId).toBeUndefined()
  })

  it('resolves a --ref key to the stable UUID scope', () => {
    const res = waiveAdd(docWithKeyedReq(), 'GTWR_R7_VAGUE', 'reviewed', 'G1')
    expect('next' in res).toBe(true)
    if ('next' in res) expect(res.next.waivers[0]?.requirementId).toBe(ID_A)
  })

  it('is idempotent — re-adding the same code+scope is a no-op', () => {
    const first = waiveAdd(emptyDoc(), 'GTWR_R7_VAGUE', 'reviewed')
    if (!('next' in first)) throw new Error('expected next')
    const second = waiveAdd(first.next, 'GTWR_R7_VAGUE', 'a different reason')
    // no-op: no new next, waiver count unchanged.
    expect('next' in second).toBe(false)
    if (second.envelope.type !== 'error') expect(second.envelope.data.action).toBe('noop')
  })

  it('an unresolvable --ref is ERR_NOT_FOUND', () => {
    const res = waiveAdd(emptyDoc(), 'GTWR_R7_VAGUE', 'reviewed', 'NOPE')
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_NOT_FOUND')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('an empty reason is ERR_USAGE', () => {
    const res = waiveAdd(emptyDoc(), 'GTWR_R7_VAGUE', '   ')
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })
})

describe('waive remove / list', () => {
  it('removes a matching waiver', () => {
    const added = waiveAdd(emptyDoc(), 'GTWR_R7_VAGUE', 'reviewed')
    if (!('next' in added)) throw new Error('expected next')
    const res = waiveRemove(added.next, 'GTWR_R7_VAGUE')
    expect('next' in res).toBe(true)
    if ('next' in res) expect(res.next.waivers).toHaveLength(0)
  })

  it('remove of an absent waiver is a no-op success', () => {
    const res = waiveRemove(emptyDoc(), 'GTWR_R7_VAGUE')
    expect('next' in res).toBe(false)
    if (res.envelope.type !== 'error') expect(res.envelope.data.action).toBe('noop')
  })

  it('list is read-only', () => {
    const added = waiveAdd(emptyDoc(), 'GTWR_R7_VAGUE', 'reviewed')
    if (!('next' in added)) throw new Error('expected next')
    const res = waiveList(added.next)
    expect('next' in res).toBe(false)
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.action).toBe('listed')
      expect(res.envelope.data.waivers).toHaveLength(1)
    }
  })

  it('does not mutate the input document', () => {
    const doc = emptyDoc()
    waiveAdd(doc, 'GTWR_R7_VAGUE', 'reviewed')
    expect(doc.waivers).toHaveLength(0)
  })
})
