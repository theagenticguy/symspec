/**
 * THE ANTONYM CLASS MAP — the snapshot `antonyms.ts` says exists.
 *
 * `SEED_ANTONYM_PAIRS`s docstring promises "the resolved class → canonical map is
 * snapshot-tested so any edit that silently merges or re-canonicalizes classes fails loudly".
 * This file is that snapshot, and the reason it has to be a whole-map snapshot rather than a
 * handful of assertions is the canonical rule itself:
 *
 *     canonical = [...members].sort()[0]
 *
 * A class canonical is not a stable identifier — it is a function of the class MEMBERSHIP. So
 * adding one pair that merely touches an existing class renames every atom that class owns and
 * flips the polarity of every member that lands on the far side of the new smallest member. One
 * committed `abort ↔ commit` pair rewrites `commit_the_transaction` to `abort_the_transaction`
 * at inverted polarity, across every requirement in every document — and the last case in this
 * file drives that consequence through `atomize` so the blast radius is a gate, not a warning.
 *
 * A polarity flip on a response atom is not cosmetic: `FND_CONTRADICTION` fires exactly when two
 * responses land on one atom at opposite polarity, so the sign IS the verdict.
 */

import { describe, expect, it } from 'vitest'
import {
  ANTONYM_INDEX,
  type AntonymEntry,
  buildAntonymIndex,
  buildAntonymIndexWithDoc,
  SEED_ANTONYM_PAIRS,
} from './antonyms.ts'
import { atomize } from './atomize.ts'

/** Every verb the seed table mentions, from the table itself rather than a typed list. */
const SEED_VERBS = [...new Set(SEED_ANTONYM_PAIRS.flat())].sort()

/** One row per member: `<canonical>  <polarity>  <verb>`, sorted, so a diff names the verb. */
const render = (index: ReadonlyMap<string, AntonymEntry>): string => {
  const rows = [...index].map(([verb, e]) => `${e.canonical}\t${e.negated ? '-' : '+'}\t${verb}`)
  return `${rows.sort().join('\n')}\n`
}

describe('the resolved seed index', () => {
  it('renders every class with every member, byte-stable', async () => {
    await expect(render(ANTONYM_INDEX)).toMatchFileSnapshot('./__snapshots__/antonym-classes.txt')
  })

  it('is non-vacuous — every seed verb is in it, and nothing else is', () => {
    // A snapshot of an empty map passes forever. The floor is derived from the pair table, so a
    // seed pair that stops resolving shrinks the map and fails here as well as in the snapshot.
    expect([...ANTONYM_INDEX.keys()].sort()).toEqual(SEED_VERBS)
  })

  it('puts every pair on one canonical at opposite polarity', () => {
    // The defining property of the table, asserted over the whole table rather than by example:
    // this is what "a response led by `a` and one led by `b` resolve to the same atom with
    // opposite polarity" means operationally.
    for (const [a, b] of SEED_ANTONYM_PAIRS) {
      const ea = ANTONYM_INDEX.get(a)
      const eb = ANTONYM_INDEX.get(b)
      expect(ea?.canonical, `${a} unresolved`).toBe(eb?.canonical)
      expect(ea?.negated, `${a} / ${b} share a polarity`).not.toBe(eb?.negated)
    }
  })

  it('canonicalizes on the lexicographically smallest member, itself positive', () => {
    const membersOf = new Map<string, string[]>()
    for (const [verb, e] of ANTONYM_INDEX) {
      membersOf.set(e.canonical, [...(membersOf.get(e.canonical) ?? []), verb])
    }
    for (const [canonical, members] of membersOf) {
      expect([...members].sort()[0]).toBe(canonical)
      expect(ANTONYM_INDEX.get(canonical)?.negated, `${canonical} is negative`).toBe(false)
    }
  })

  it('resolves a shared member into ONE class rather than an ambiguous pair', () => {
    // `accept↔reject`, `approve↔reject` and `accept↔decline` all touch the same two verbs. A
    // flat pair map would make `reject` ambiguous; the signed union-find puts all four in one
    // class, with the two same-side near-synonyms unified as a documented consequence.
    for (const verb of ['accept', 'approve']) {
      expect(ANTONYM_INDEX.get(verb)).toEqual({ canonical: 'accept', negated: false })
    }
    for (const verb of ['reject', 'decline']) {
      expect(ANTONYM_INDEX.get(verb)).toEqual({ canonical: 'accept', negated: true })
    }
  })
})

describe('buildAntonymIndex', () => {
  it('rejects an odd polarity cycle, so atomization cannot become order-dependent', () => {
    expect(() =>
      buildAntonymIndex([
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ]),
    ).toThrow(/Inconsistent antonym pairs/)
  })

  it('is order-independent over the pair list', () => {
    expect(render(buildAntonymIndex([...SEED_ANTONYM_PAIRS].reverse()))).toBe(render(ANTONYM_INDEX))
  })
})

describe('a document pair that touches a seed class', () => {
  it('leaves the seed index untouched when the document commits nothing', () => {
    expect(buildAntonymIndexWithDoc([])).toBe(ANTONYM_INDEX)
  })

  it('renames the class and flips every member below the new canonical', () => {
    // `commit` is its own class canonical against `roll_back`/`rollback`. Committing
    // `abort ↔ commit` makes `abort` the smallest member, so `commit` becomes the NEGATIVE side
    // of a class named after a verb no requirement used.
    const merged = buildAntonymIndexWithDoc([['abort', 'commit']])
    expect(ANTONYM_INDEX.get('commit')).toEqual({ canonical: 'commit', negated: false })
    expect(merged.get('commit')).toEqual({ canonical: 'abort', negated: true })
    expect(merged.get('roll_back')).toEqual({ canonical: 'abort', negated: false })
  })

  it('rewrites the atom NAME and its polarity for every requirement in the document', () => {
    // The consequence, at the layer that decides verdicts. The name moves and the sign inverts,
    // so a document that was consistent under the seed table can report a contradiction under
    // the merged one, with no requirement edited.
    const seeded = atomize({ kind: 'resp', text: 'commit the transaction', systemName: 'ledger' })
    expect(seeded).toMatchObject({
      name: 'sys__ledger__resp__commit_the_transaction',
      negated: false,
    })
    const merged = atomize({
      kind: 'resp',
      text: 'commit the transaction',
      systemName: 'ledger',
      antonyms: buildAntonymIndexWithDoc([['abort', 'commit']]),
    })
    expect(merged).toMatchObject({
      name: 'sys__ledger__resp__abort_the_transaction',
      negated: true,
    })
  })
})
