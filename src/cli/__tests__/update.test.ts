import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import type { RequirementsDoc } from '../../core/schema.js'
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from '../envelope.js'
import { runUpdate, runUpdateBulk, runUpdateMany, UPDATE_USAGE } from '../update.js'

/**
 * AC-6-11: the explicit `--clear` flag replaces the v1 magic string-`"null"`
 * sentinel. Spec verification clause: `update --clear` clears an optional
 * attr; the literal "null" is stored as text, not null.
 */

const ID_A = '11111111-1111-4111-8111-111111111111'

function docWithA(): RequirementsDoc {
  const doc = emptyDoc()
  doc.requirements[ID_A] = {
    id: ID_A,
    patternType: 'event-driven',
    trigger: 'a request arrives',
    systemName: 'api',
    systemResponse: 'respond within 100ms',
    negated: false,
    sentence: 'When a request arrives, the api shall respond within 100ms.',
    priority: 'medium',
    status: 'draft',
    verificationMethod: 'test',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  return doc
}

describe('update --clear clears a nullable optional attr (AC-6-11)', () => {
  it('removes the attr key entirely (absent, not null/undefined)', () => {
    // Clear verificationMethod: never pattern-load-bearing, so MN6 does not
    // block it — isolates the AC-6-11 key-removal behavior.
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'verificationMethod', clear: true })
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    const r = res.next.requirements[ID_A]
    expect(r && Object.hasOwn(r, 'verificationMethod')).toBe(false)
    expect(res.envelope.type).toBe('update')
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.action).toBe('cleared')
      expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('clears each of the three NULLABLE_ATTRS when the pattern does not require it', () => {
    // A ubiquitous requirement needs NEITHER trigger nor preCondition, so MN6
    // (which only blocks clearing a pattern-required slot) leaves all three
    // NULLABLE_ATTRS freely clearable.
    for (const attr of ['preCondition', 'trigger', 'verificationMethod'] as const) {
      const doc = emptyDoc()
      doc.requirements[ID_A] = {
        id: ID_A,
        patternType: 'ubiquitous',
        preCondition: 'the cache is warm',
        trigger: 'a request arrives',
        systemName: 'api',
        systemResponse: 'log the access',
        negated: false,
        sentence: 'The api shall log the access.',
        priority: 'medium',
        status: 'draft',
        verificationMethod: 'test',
        derives: [],
        satisfies: [],
        verifies: [],
        refines: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const res = runUpdate(doc, { id: ID_A, attr, clear: true })
      expect('next' in res).toBe(true)
      if ('next' in res) {
        const r = res.next.requirements[ID_A]
        expect(r && Object.hasOwn(r, attr)).toBe(false)
      }
    }
  })

  it('blocks clearing a pattern-required slot with ERR_NULL_REQUIRED (MN6)', () => {
    // Clearing an event-driven requirement's trigger would render "When , the
    // …" — MN6 refuses up front rather than persisting a broken sentence.
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'trigger', clear: true })
    expect('next' in res).toBe(false)
    if ('next' in res) return
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_NULL_REQUIRED')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('does not mutate the input document', () => {
    const doc = docWithA()
    runUpdate(doc, { id: ID_A, attr: 'verificationMethod', clear: true })
    expect(doc.requirements[ID_A]?.verificationMethod).toBe('test')
  })

  it('--clear on a required attr surfaces ERR_NULL_REQUIRED as an envelope, not a throw', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'systemName', clear: true })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_NULL_REQUIRED')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
      expect(res.envelope.suggestions.length).toBeGreaterThan(0)
    }
  })
})

describe('the literal string "null" is text, not a sentinel (AC-6-11)', () => {
  it('stores the four characters n-u-l-l as the attr value', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'trigger', value: 'null' })
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    const r = res.next.requirements[ID_A]
    expect(r?.trigger).toBe('null')
    expect(r && Object.hasOwn(r, 'trigger')).toBe(true)
    if (res.envelope.type !== 'error') expect(res.envelope.data.action).toBe('set')
  })

  it('"null" on a REQUIRED attr also stores text — v1 would have thrown ERR_NULL_REQUIRED', () => {
    // The sharpest regression: under the v1 sentinel, `update systemName null`
    // meant "clear systemName" and blew up. In v2 it is an ordinary set.
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'systemName', value: 'null' })
    expect('next' in res).toBe(true)
    if ('next' in res) expect(res.next.requirements[ID_A]?.systemName).toBe('null')
  })
})

describe('ordinary set path', () => {
  it('sets a metadata attr and reports action "set"', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'priority', value: 'high' })
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(res.next.requirements[ID_A]?.priority).toBe('high')
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data).toEqual({ id: ID_A, attr: 'priority', action: 'set' })
    }
  })

  it('an EARS-slot set re-renders the sentence (AC-1-6 still holds through this path)', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'systemResponse', value: 'queue the job' })
    expect('next' in res).toBe(true)
    if ('next' in res) {
      expect(res.next.requirements[ID_A]?.sentence).toBe(
        'When a request arrives, the api shall queue the job.',
      )
    }
  })

  it('a ChangeSchema rejection surfaces as an envelope, not a Zod stack trace', () => {
    // Force ChangeSchema.parse to throw inside applyChange: plant a requirement
    // under a non-UUID key so the guard passes but `f.id` validation fails.
    const doc = docWithA()
    const rogue = structuredClone(doc.requirements[ID_A])
    if (rogue === undefined) throw new Error('fixture missing')
    doc.requirements['not-a-uuid'] = rogue
    const res = runUpdate(doc, { id: 'not-a-uuid', attr: 'priority', value: 'high' })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })
})

describe('mutual exclusion of --clear and <value> (ERR_USAGE)', () => {
  it('both --clear and a value → ERR_USAGE citing the usage line', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'trigger', value: 'x', clear: true })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_USAGE')
      expect(res.envelope.suggestions[0]).toBe(`Usage: ${UPDATE_USAGE}`)
    }
  })

  it('neither --clear nor a value → ERR_USAGE', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'trigger' })
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })
})

/** A ubiquitous fixture with a stable key, for multi-attr / bulk / key tests. */
function keyedDoc(): RequirementsDoc {
  const doc = emptyDoc()
  doc.requirements[ID_A] = {
    id: ID_A,
    key: 'G1',
    patternType: 'ubiquitous',
    systemName: 'api',
    systemResponse: 'log the access',
    negated: false,
    sentence: 'The api shall log the access.',
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

describe('runUpdateMany — multi-attribute update (#7)', () => {
  it('sets several attributes in one call', () => {
    const res = runUpdateMany(docWithA(), ID_A, [
      { attr: 'status', value: 'approved' },
      { attr: 'priority', value: 'high' },
    ])
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    const r = res.next.requirements[ID_A]
    expect(r?.status).toBe('approved')
    expect(r?.priority).toBe('high')
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.attrs).toEqual(['status', 'priority'])
    }
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('resolves the ref by stable key (#2)', () => {
    const res = runUpdateMany(keyedDoc(), 'G1', [{ attr: 'status', value: 'approved' }])
    expect('next' in res).toBe(true)
    if ('next' in res) expect(res.next.requirements[ID_A]?.status).toBe('approved')
  })

  it('a bad attr in the batch fails atomically (nothing set)', () => {
    const res = runUpdateMany(docWithA(), ID_A, [
      { attr: 'status', value: 'approved' },
      { attr: 'bogus', value: 'x' },
    ])
    expect('next' in res).toBe(false)
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_INVALID_ATTR')
  })

  it('an empty assignment list is ERR_USAGE', () => {
    const res = runUpdateMany(docWithA(), ID_A, [])
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })

  it('an unresolvable ref is ERR_NOT_FOUND', () => {
    const res = runUpdateMany(docWithA(), 'NOPE', [{ attr: 'status', value: 'approved' }])
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_NOT_FOUND')
  })

  it('does not mutate the input document', () => {
    const doc = docWithA()
    runUpdateMany(doc, ID_A, [{ attr: 'status', value: 'approved' }])
    expect(doc.requirements[ID_A]?.status).toBe('draft')
  })
})

describe('runUpdateBulk — --all --where transition (#8)', () => {
  function twoDrafts(): RequirementsDoc {
    const doc = emptyDoc()
    for (const id of [ID_A, '22222222-2222-4222-8222-222222222222']) {
      doc.requirements[id] = {
        id,
        patternType: 'ubiquitous',
        systemName: 'api',
        systemResponse: `do ${id.slice(0, 4)}`,
        negated: false,
        sentence: `The api shall do ${id.slice(0, 4)}.`,
        priority: 'medium',
        status: 'draft',
        derives: [],
        satisfies: [],
        verifies: [],
        refines: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    }
    // A third requirement already approved — must NOT be re-touched by a
    // status=draft filter.
    doc.requirements['33333333-3333-4333-8333-333333333333'] = {
      ...doc.requirements[ID_A],
      id: '33333333-3333-4333-8333-333333333333',
      status: 'approved',
    } as RequirementsDoc['requirements'][string]
    return doc
  }

  it('applies the transition to every matching requirement', () => {
    const res = runUpdateBulk(
      twoDrafts(),
      { attr: 'status', value: 'draft' },
      { attr: 'status', value: 'approved' },
    )
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.matched).toHaveLength(2)
    }
    const statuses = Object.values(res.next.requirements).map((r) => r.status)
    expect(statuses.filter((s) => s === 'approved')).toHaveLength(3)
  })

  it('zero matches is a successful no-op with an empty matched list', () => {
    const res = runUpdateBulk(
      twoDrafts(),
      { attr: 'status', value: 'verified' },
      { attr: 'priority', value: 'high' },
    )
    expect('next' in res).toBe(true)
    if ('next' in res && res.envelope.type !== 'error') {
      expect(res.envelope.data.matched).toHaveLength(0)
    }
  })

  it('a bad --where attr is ERR_INVALID_ATTR', () => {
    const res = runUpdateBulk(
      twoDrafts(),
      { attr: 'bogus', value: 'draft' },
      { attr: 'status', value: 'approved' },
    )
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_INVALID_ATTR')
  })
})
