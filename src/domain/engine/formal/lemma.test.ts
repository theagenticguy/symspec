/**
 * `deInflectHead` — the closed 3sg rules, row by row.
 *
 * The row that earns this file is `-zes`. A `-ze` verb takes plain `-s`
 * (energizes = energize + s), so stripping `-es` off every `-zes` token mangles
 * the head to `energiz` — which then matches neither the seed antonym pair
 * `energize/de_energize` (`antonyms.ts`) nor the prefix-pair comparison
 * `semantic.ts` documents against exactly this example. Only a DOUBLED z takes
 * `-es` (buzzes = buzz + es).
 */

import { describe, expect, it } from 'vitest'
import { deInflectHead } from './lemma.ts'

describe('the closed 3sg rules', () => {
  it.each([
    // -ze verbs take plain -s: strip ONE character, not two.
    ['energizes', 'energize'],
    ['analyzes', 'analyze'],
    ['seizes', 'seize'],
    ['memoizes', 'memoize'],
    // doubled z takes -es
    ['buzzes', 'buzz'],
    // the sibilant -es rows
    ['passes', 'pass'],
    ['pushes', 'push'],
    ['matches', 'match'],
    ['fixes', 'fix'],
    ['goes', 'go'],
    // -ies -> -y
    ['denies', 'deny'],
    // plain -s strip, with the protected endings
    ['opens', 'open'],
    ['status', 'status'],
    ['basis', 'basis'],
  ])('%s -> %s', (token, base) => {
    expect(deInflectHead(token)).toBe(base)
  })

  it('is idempotent on base forms', () => {
    for (const base of ['open', 'energize', 'buzz', 'pass', 'go', 'deny']) {
      expect(deInflectHead(base)).toBe(base)
    }
  })
})
