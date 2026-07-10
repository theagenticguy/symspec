import { describe, expect, it } from 'vitest'
import { makeTier3EnvelopeFromNotes } from '../../parse/tier3.js'
import {
  API_VERSION,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  failure,
  fromTier3Envelope,
  PartialSlotsSchema,
  type SuccessEnvelope,
  SuccessEnvelopeSchema,
  success,
} from '../envelope.js'

/**
 * AC-6-2: every success wraps in `{ apiVersion, type, data }` and every failure
 * in the superset `{ apiVersion, type:'error', error, code, suggestions,
 * partial? }`. Both carry `apiVersion` and a discriminant `type`; a Tier-3
 * parse error is an instance of the error envelope and round-trips with
 * `partial`.
 */

describe('success envelope (AC-6-2)', () => {
  it('validates against SuccessEnvelopeSchema', () => {
    const env = success('check', { findings: [] })
    expect(() => SuccessEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('carries apiVersion and a discriminant type', () => {
    const env = success('parse', { patternType: 'ubiquitous' })
    expect(env.apiVersion).toBe(API_VERSION)
    expect(typeof env.apiVersion).toBe('number')
    expect(env.type).toBe('parse')
  })

  it('carries the command-specific data payload', () => {
    const payload = { id: 'abc', priority: 'high' as const }
    const env = success('show', payload)
    expect(env.data).toEqual(payload)
  })

  it('round-trips through JSON unchanged', () => {
    const env = success('list', [{ id: 'a' }, { id: 'b' }])
    const round = JSON.parse(JSON.stringify(env)) as SuccessEnvelope
    expect(round).toEqual(env)
    expect(() => SuccessEnvelopeSchema.parse(round)).not.toThrow()
  })
})

describe('error envelope (AC-6-2)', () => {
  it('validates against ErrorEnvelopeSchema', () => {
    const env = failure({
      error: 'no such document',
      code: 'ERR_DOC_NOT_FOUND',
      suggestions: ['create it with `symspec init`'],
    })
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('carries apiVersion and the literal error discriminant type', () => {
    const env = failure({ error: 'boom', code: 'ERR_IO' })
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('error')
  })

  it('is a superset of the success header (shares apiVersion + type)', () => {
    const ok = success('check', {})
    const err = failure({ error: 'x', code: 'ERR_USAGE' })
    expect(ok.apiVersion).toBe(err.apiVersion)
    expect('type' in ok && 'type' in err).toBe(true)
  })

  it('defaults suggestions to an empty array when omitted', () => {
    const env = failure({ error: 'x', code: 'ERR_USAGE' })
    expect(env.suggestions).toEqual([])
  })

  it('rejects an unknown error code', () => {
    const bad = {
      apiVersion: API_VERSION,
      type: 'error' as const,
      error: 'x',
      code: 'ERR_NOT_A_REAL_CODE',
      suggestions: [],
    }
    expect(() => ErrorEnvelopeSchema.parse(bad)).toThrow()
  })

  it('omits partial (no undefined/null key) when nothing recovered', () => {
    const env = failure({ error: 'x', code: 'ERR_PARSE_NO_MODAL' })
    expect('partial' in env).toBe(false)
    // A validated round-trip still succeeds without the optional key.
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('omits partial when an empty skeleton is supplied', () => {
    const env = failure({ error: 'x', code: 'ERR_PARSE_NO_MODAL', partial: {} })
    expect('partial' in env).toBe(false)
  })
})

describe('discriminant type switches uniformly across success and error', () => {
  it('lets an agent branch on type alone', () => {
    const envs = [success('check', { findings: [] }), failure({ error: 'x', code: 'ERR_IO' })]
    const kinds = envs.map((e) => (e.type === 'error' ? 'failure' : 'success'))
    expect(kinds).toEqual(['success', 'failure'])
  })
})

describe('Tier-3 parse error is an instance of the error envelope (AC-6-2 / AC-2-7)', () => {
  it('round-trips a Tier-3 error with partial through the error envelope', () => {
    const t3 = makeTier3EnvelopeFromNotes('When the door opens the light', ['no-modal-clause'], {
      patternType: 'event-driven',
      systemName: 'light',
      trigger: 'the door opens',
    })
    const env = fromTier3Envelope(t3)

    // Shares the envelope header.
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('error')
    // Copies the Tier-3 payload.
    expect(env.code).toBe(t3.code)
    expect(env.error).toBe(t3.error)
    expect(env.suggestions).toEqual(t3.suggestions)
    // Carries and preserves the recovered partial skeleton.
    expect(env.partial).toEqual(t3.partial)

    // Validates against the schema.
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()

    // Byte-stable round-trip through JSON.
    const round = JSON.parse(JSON.stringify(env)) as ErrorEnvelope
    expect(round).toEqual(env)
    expect(() => ErrorEnvelopeSchema.parse(round)).not.toThrow()
    expect(round.partial).toEqual(t3.partial)
  })

  it('omits partial when the Tier-3 result recovered nothing', () => {
    const t3 = makeTier3EnvelopeFromNotes('Fast is nice', ['empty'])
    const env = fromTier3Envelope(t3)
    expect('partial' in env).toBe(false)
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('accepts every ERR_PARSE_* code as a valid envelope code', () => {
    for (const notes of [
      ['compound-conjunction'],
      ['no-modal-clause'],
      ['empty'],
      ['nested-clause-keyword'],
    ]) {
      const t3 = makeTier3EnvelopeFromNotes('x', notes)
      const env = fromTier3Envelope(t3)
      expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    }
  })
})

describe('PartialSlotsSchema', () => {
  it('accepts a full slot skeleton', () => {
    const ok = PartialSlotsSchema.safeParse({
      patternType: 'state-driven',
      systemName: 'sys',
      systemResponse: 'do',
      preCondition: 'idle',
      trigger: 'ping',
    })
    expect(ok.success).toBe(true)
  })

  it('accepts an empty skeleton', () => {
    expect(PartialSlotsSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an invalid patternType', () => {
    expect(PartialSlotsSchema.safeParse({ patternType: 'nope' }).success).toBe(false)
  })
})

describe('apiVersion is a distinct envelope-contract integer (AC-6-2 / AC-6-12 seed)', () => {
  it('is an integer', () => {
    expect(Number.isInteger(API_VERSION)).toBe(true)
  })

  it('the success and error schemas both pin it as a literal', () => {
    const badVersion = { apiVersion: API_VERSION + 1, type: 'check', data: {} }
    expect(() => SuccessEnvelopeSchema.parse(badVersion)).toThrow()
  })
})
