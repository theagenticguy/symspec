import { describe, expect, it } from 'vitest'
import { extractNegation, NEGATORS } from '../negation.js'

describe('T-AC-2-4: explicit modal-adjacent negation extraction', () => {
  describe('the spec anchor: "shall not store plaintext"', () => {
    it('sets negated:true and keeps the POSITIVE response atom (no "not" in text)', () => {
      const r = extractNegation('not store plaintext passwords')
      expect(r.negated).toBe(true)
      expect(r.response).toBe('store plaintext passwords')
      expect(r.response).not.toMatch(/\bnot\b/)
      expect(r.negator).toBe('not')
    })
  })

  describe('the three explicit negators (AC-2-4)', () => {
    it('"not" → negated, stripped', () => {
      const r = extractNegation('not cache credentials')
      expect(r).toEqual({ negated: true, response: 'cache credentials', negator: 'not' })
    })

    it('"never" → negated, stripped', () => {
      const r = extractNegation('never allow anonymous access')
      expect(r).toEqual({ negated: true, response: 'allow anonymous access', negator: 'never' })
    })

    it('"not be able to" → negated, stripped (longest-match wins over bare "not")', () => {
      const r = extractNegation('not be able to modify audit logs')
      expect(r).toEqual({
        negated: true,
        response: 'modify audit logs',
        negator: 'not be able to',
      })
    })

    it('every canonical negator is recognized', () => {
      for (const neg of NEGATORS) {
        const r = extractNegation(`${neg} do the thing`)
        expect(r.negated).toBe(true)
        expect(r.negator).toBe(neg)
        expect(r.response).toBe('do the thing')
      }
    })
  })

  describe('NEVER lexical inversion (research §1.3, §1.6) — load-bearing for AC-4-2a', () => {
    it('"reject" is NOT inverted to a positive atom (left for the antonym table)', () => {
      const r = extractNegation('reject expired tokens')
      expect(r.negated).toBe(false)
      expect(r.response).toBe('reject expired tokens')
      expect(r.negator).toBeUndefined()
    })

    it('"prevent" is lexical negation, left verbatim', () => {
      const r = extractNegation('prevent unauthorized writes')
      expect(r).toEqual({ negated: false, response: 'prevent unauthorized writes' })
    })

    it('"disable" is left for the enable↔disable antonym pair', () => {
      const r = extractNegation('disable the deprecated endpoint')
      expect(r.negated).toBe(false)
      expect(r.response).toBe('disable the deprecated endpoint')
    })

    it('"deny" is left for the allow↔deny antonym pair', () => {
      const r = extractNegation('deny access to expired sessions')
      expect(r.negated).toBe(false)
    })
  })

  describe('word-boundary guards — a negator must be a standalone token', () => {
    it('"notify" is not read as "not"', () => {
      const r = extractNegation('notify the operator')
      expect(r.negated).toBe(false)
      expect(r.response).toBe('notify the operator')
    })

    it('"nevertheless" is not read as "never"', () => {
      const r = extractNegation('nevertheless proceed to log')
      expect(r.negated).toBe(false)
      expect(r.response).toBe('nevertheless proceed to log')
    })

    it('"notable" is not read as "not"', () => {
      const r = extractNegation('notable events shall be recorded')
      expect(r.negated).toBe(false)
    })

    it('a negator embedded mid-clause (not leading) is not stripped', () => {
      const r = extractNegation('log events that are not archived')
      expect(r.negated).toBe(false)
      expect(r.response).toBe('log events that are not archived')
    })
  })

  describe('purity + determinism', () => {
    it('same input yields deep-equal output across calls', () => {
      const input = 'not store plaintext passwords'
      expect(extractNegation(input)).toEqual(extractNegation(input))
    })

    it('does not mutate or retain input', () => {
      const input = '  never   log secrets  '
      const before = input
      extractNegation(input)
      expect(input).toBe(before)
    })
  })

  describe('normalization robustness', () => {
    it('trims surrounding whitespace on non-negated input', () => {
      const r = extractNegation('  cache the token  ')
      expect(r).toEqual({ negated: false, response: 'cache the token' })
    })

    it('collapses internal whitespace inside the negator phrase', () => {
      const r = extractNegation('not  be   able  to  purge records')
      expect(r).toEqual({
        negated: true,
        response: 'purge records',
        negator: 'not be able to',
      })
    })

    it('is case-insensitive on the negator', () => {
      const r = extractNegation('Never expose stack traces')
      expect(r.negated).toBe(true)
      expect(r.negator).toBe('never')
      expect(r.response).toBe('expose stack traces')
    })

    it('a bare negator with no response yields an empty positive atom', () => {
      const r = extractNegation('never')
      expect(r).toEqual({ negated: true, response: '', negator: 'never' })
    })
  })
})
