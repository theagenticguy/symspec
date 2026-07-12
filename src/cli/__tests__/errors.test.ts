import { describe, expect, it } from 'vitest'
import { ChangeError } from '../../core/changes.js'
import { emptyDoc } from '../../core/doc.js'
import { RELATIONS, UPDATABLE_ATTRS } from '../../core/schema.js'
import { API_VERSION, ErrorEnvelopeSchema } from '../envelope.js'
import {
  invalidAttrError,
  invalidRelationError,
  notFoundError,
  parseAttr,
  parseRelation,
  requireRequirement,
  toErrorEnvelope,
  usageError,
} from '../errors.js'
import { runUpdate } from '../update.js'

/**
 * AC-6-10: invalid/missing arguments return ERR_USAGE (or the specific
 * ERR_NOT_FOUND / ERR_INVALID_RELATION / ERR_INVALID_ATTR) as a typed error
 * envelope — never an unhandled stack trace. Spec verification clause: bad
 * relation → ERR_INVALID_RELATION; unknown id → ERR_NOT_FOUND; each is an
 * envelope.
 */

const ID_A = '11111111-1111-4111-8111-111111111111'
const MISSING = '99999999-9999-4999-8999-999999999999'

const docWithA = () => {
  const doc = emptyDoc()
  doc.requirements[ID_A] = {
    id: ID_A,
    patternType: 'ubiquitous',
    systemName: 'api',
    systemResponse: 'respond',
    sentence: 'The api shall respond.',
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

describe('envelope builders (AC-6-10)', () => {
  it('bad relation → ERR_INVALID_RELATION, and it is a valid error envelope', () => {
    const env = invalidRelationError('blocks')
    expect(env.code).toBe('ERR_INVALID_RELATION')
    expect(env.type).toBe('error')
    expect(env.apiVersion).toBe(API_VERSION)
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    // Appendix A suggestion: the valid relations list.
    expect(env.suggestions.join(' ')).toContain('derives/satisfies/verifies/refines')
  })

  it('unknown id → ERR_NOT_FOUND, and it is a valid error envelope', () => {
    const env = notFoundError(MISSING)
    expect(env.code).toBe('ERR_NOT_FOUND')
    expect(env.error).toContain(MISSING)
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.suggestions.join(' ')).toContain('symspec list')
  })

  it('unknown attr → ERR_INVALID_ATTR listing the updatable attrs', () => {
    const env = invalidAttrError('color')
    expect(env.code).toBe('ERR_INVALID_ATTR')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    for (const attr of UPDATABLE_ATTRS) {
      expect(env.suggestions.join(' ')).toContain(attr)
    }
  })

  it('usage error → ERR_USAGE with the usage line as the first suggestion', () => {
    const env = usageError('missing <id>', 'symspec show <id>')
    expect(env.code).toBe('ERR_USAGE')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.suggestions[0]).toBe('Usage: symspec show <id>')
  })
})

describe('argument guards (AC-6-10)', () => {
  it('parseRelation accepts every member of RELATIONS', () => {
    for (const rel of RELATIONS) {
      const res = parseRelation(rel)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(rel)
    }
  })

  it('parseRelation rejects a non-relation with the ERR_INVALID_RELATION envelope', () => {
    const res = parseRelation('depends-on')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.envelope.code).toBe('ERR_INVALID_RELATION')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('parseAttr accepts every member of UPDATABLE_ATTRS and rejects others', () => {
    for (const attr of UPDATABLE_ATTRS) {
      expect(parseAttr(attr).ok).toBe(true)
    }
    const res = parseAttr('sentence') // real field, but NOT updatable
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.envelope.code).toBe('ERR_INVALID_ATTR')
  })

  it('requireRequirement resolves an existing id and rejects a missing one', () => {
    const doc = docWithA()
    const hit = requireRequirement(doc, ID_A)
    expect(hit.ok).toBe(true)
    if (hit.ok) expect(hit.value.id).toBe(ID_A)

    const miss = requireRequirement(doc, MISSING)
    expect(miss.ok).toBe(false)
    if (!miss.ok) {
      expect(miss.envelope.code).toBe('ERR_NOT_FOUND')
      expect(() => ErrorEnvelopeSchema.parse(miss.envelope)).not.toThrow()
    }
  })

  it('requireRequirement resolves a stable human key to the same node (#2)', () => {
    const doc = docWithA()
    // Attach a key to the fixture's requirement.
    const node = doc.requirements[ID_A]
    if (node !== undefined) node.key = 'G1'

    const byKey = requireRequirement(doc, 'G1')
    expect(byKey.ok).toBe(true)
    if (byKey.ok) expect(byKey.value.id).toBe(ID_A)

    // A key that no requirement uses is still ERR_NOT_FOUND.
    const miss = requireRequirement(doc, 'NOPE')
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.envelope.code).toBe('ERR_NOT_FOUND')
  })
})

describe('toErrorEnvelope — no unhandled stack traces (AC-6-10)', () => {
  it('lifts a coded core error (ChangeError) preserving its own code + suggestions', () => {
    const thrown = new ChangeError('ERR_NULL_REQUIRED', 'cannot null systemName', [
      'Provide a value instead of null.',
    ])
    const env = toErrorEnvelope(thrown)
    expect(env.code).toBe('ERR_NULL_REQUIRED')
    expect(env.error).toBe('cannot null systemName')
    expect(env.suggestions).toContain('Provide a value instead of null.')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('lifts a raw Error to the fallback code (default ERR_USAGE)', () => {
    const env = toErrorEnvelope(new Error('boom'))
    expect(env.code).toBe('ERR_USAGE')
    expect(env.error).toBe('boom')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('honors an explicit fallback code for non-coded throws', () => {
    const env = toErrorEnvelope(new Error('disk gone'), 'ERR_IO')
    expect(env.code).toBe('ERR_IO')
  })

  it('lifts a non-Error thrown value without crashing', () => {
    const env = toErrorEnvelope('just a string')
    expect(env.code).toBe('ERR_USAGE')
    expect(env.error).toBe('just a string')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('ignores a bogus code on a thrown error and falls back', () => {
    const bogus = Object.assign(new Error('weird'), { code: 'ENOENT' })
    const env = toErrorEnvelope(bogus)
    expect(env.code).toBe('ERR_USAGE')
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })
})

describe('command-path integration: update surfaces guard envelopes (AC-6-10)', () => {
  it('update on an unknown id yields the ERR_NOT_FOUND envelope, not a throw', () => {
    const res = runUpdate(docWithA(), { id: MISSING, attr: 'priority', value: 'high' })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_NOT_FOUND')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('update on an unknown attr yields the ERR_INVALID_ATTR envelope', () => {
    const res = runUpdate(docWithA(), { id: ID_A, attr: 'nickname', value: 'x' })
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_INVALID_ATTR')
  })
})
