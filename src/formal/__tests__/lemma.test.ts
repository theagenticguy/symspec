import { describe, expect, it } from 'vitest'
import { deInflectHead, IRREGULAR_VERB_LEMMAS } from '../lemma.js'

describe('deInflectHead — closed verb de-inflection (leading head token only)', () => {
  it('handles third-person -s forms', () => {
    expect(deInflectHead('opens')).toBe('open')
    expect(deInflectHead('denies')).toBe('deny')
    expect(deInflectHead('engages')).toBe('engage')
    expect(deInflectHead('rolls')).toBe('roll')
    expect(deInflectHead('passes')).toBe('pass')
    expect(deInflectHead('pushes')).toBe('push')
    expect(deInflectHead('goes')).toBe('go')
    expect(deInflectHead('applies')).toBe('apply')
  })

  it('handles irregular past/participle forms from the vendored table', () => {
    expect(deInflectHead('kept')).toBe('keep')
    expect(deInflectHead('held')).toBe('hold')
    expect(deInflectHead('went')).toBe('go')
    expect(deInflectHead('sent')).toBe('send')
    expect(deInflectHead('built')).toBe('build')
    expect(deInflectHead('withdrew')).toBe('withdraw')
    expect(deInflectHead('withheld')).toBe('withhold')
    expect(deInflectHead('overrode')).toBe('override')
  })

  it('protects -ss/-us/-is and short tokens', () => {
    expect(deInflectHead('pass')).toBe('pass')
    expect(deInflectHead('status')).toBe('status')
    expect(deInflectHead('basis')).toBe('basis')
    expect(deInflectHead('is')).toBe('is')
    expect(deInflectHead('as')).toBe('as')
  })

  it('is idempotent on base forms', () => {
    for (const base of ['open', 'keep', 'hold', 'grant', 'deny', 'seal', 'commit']) {
      expect(deInflectHead(base)).toBe(base)
    }
  })

  it('is idempotent on every irregular-table VALUE (base forms never re-map)', () => {
    for (const base of new Set(IRREGULAR_VERB_LEMMAS.values())) {
      expect(deInflectHead(base)).toBe(base)
    }
  })

  it('returns unknown tokens unchanged (OOV falls through, no guessing)', () => {
    expect(deInflectHead('memoized')).toBe('memoized')
    expect(deInflectHead('quarantine')).toBe('quarantine')
  })
})
