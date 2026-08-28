/**
 * THE ATOM-NAME CORPUS SNAPSHOT — the instrument nothing else provides.
 *
 * ## Why this file exists
 *
 * The atom name is the DECIDE key: `FND_CONTRADICTION` fires only when two responses resolve to
 * the same atom at opposite polarity, and `planContextGroups` keys a context group on the exact
 * sorted set of a requirement's guard atom names. So every claim of the form "this change only
 * SPLITS a group, it never merges one" is a claim about these strings — and until now nothing in
 * the repo could show them.
 *
 * Individual assertions cannot do this job. `atomize.test.ts` pins the bodies it happens to name,
 * which is exactly the set an author remembers to update; a whole-corpus snapshot pins the ones
 * they do not. A reviewer reads the diff and sees the blast radius instead of taking a comment's
 * word for it.
 *
 * ## What a diff here means
 *
 * - a line CHANGING is a renamed atom — safe if it is a pure rename, dangerous if two lines
 *   collapse into one;
 * - two lines BECOMING one is a merge, which is the direction that manufactures a conflict;
 * - one line BECOMING two is a split, which can only remove findings.
 *
 * That asymmetry is why the row count is asserted separately below: a merge is visible as a
 * shrinking corpus even when the individual names are too many to eyeball.
 *
 * ## No solver, no embedder
 *
 * Pure `encode` over `atomize`, so this runs in milliseconds and can never be the slow test that
 * gets skipped. The gate deliberately covers all three corpora — the pinned red-team rounds, the
 * generated ladder, and the fabrication fixtures — because they exercise different atomization
 * paths: committed glossaries, seed antonyms, and deliberately-close-but-distinct phrasings.
 */

import { describe, expect, it } from 'vitest'
import { toEngineDoc } from '../domain/compat.ts'
import type { Doc } from '../domain/engine/core/doc.ts'
import { encodeIncluded } from '../domain/engine/pipeline/check.ts'
import type { RequirementsDocument } from '../domain/requirements/document.ts'
import { evalRoundCases } from './eval-rounds.ts'
import { fabricationCases } from './fabrication.ts'
import { generateCases } from './generate.ts'

/** The generated ladder's four tiers at the pinned seed — `generateCases` is pure in (tier, seed). */
const LADDER_TIERS = [1, 2, 3, 4] as const
const LADDER_SEED = 0

/** One `<corpus>/<caseId>` label per document, so a diff line names where to look. */
interface Source {
  readonly label: string
  readonly doc: Doc
}

const sources = (): readonly Source[] => {
  const out: Source[] = []
  for (const c of evalRoundCases()) out.push({ label: `eval-rounds/${c.id}`, doc: c.doc })
  for (const tier of LADDER_TIERS) {
    for (const c of generateCases(tier, LADDER_SEED)) {
      out.push({ label: `generated-t${tier}/${c.id}`, doc: c.doc })
    }
  }
  for (const c of fabricationCases()) {
    // The fabrication corpus is greenfield-shaped; the other two are already engine-shaped.
    out.push({ label: `fabrication/${c.id}`, doc: toEngineDoc(c.doc as RequirementsDocument) })
  }
  return out
}

/**
 * One row per atom occurrence: `<label>  <kind>  <atom>  [NEG]  <- <slotText>`.
 *
 * The author's slot text rides along on purpose. An atom name alone cannot show a MERGE — two
 * different phrases landing on one name look like one line unless the phrase is printed, which is
 * the single most important thing this snapshot has to make visible.
 */
const render = (): string => {
  const rows = new Set<string>()
  for (const { label, doc } of sources()) {
    for (const enc of encodeIncluded(doc)) {
      for (const a of enc.atoms) {
        const neg = a.negated ? ' [NEG]' : ''
        rows.add(`${label}\t${a.kind}\t${a.atom}${neg}\t<- ${a.slotText}`)
      }
    }
  }
  return `${[...rows].sort().join('\n')}\n`
}

describe('the atom corpus', () => {
  it('renders every atom across all three corpora, byte-stable', async () => {
    await expect(render()).toMatchFileSnapshot('./__snapshots__/atom-corpus.txt')
  })

  it('is non-vacuous — every corpus contributes rows', () => {
    const text = render()
    for (const prefix of ['eval-rounds/', 'generated-t1/', 'generated-t4/', 'fabrication/']) {
      expect(text, `${prefix} contributed no atoms`).toContain(prefix)
    }
    // A snapshot of nothing passes forever, so the floor is DERIVED rather than typed: every
    // document must contribute at least one atom. A literal bound here would be a second count to
    // keep in step with the snapshot, and the snapshot already owns the exact number.
    const docs = sources().length
    expect(docs, 'no documents in any corpus').toBeGreaterThan(20)
    expect(text.trimEnd().split('\n').length).toBeGreaterThanOrEqual(docs)
  })

  it('never emits a bare `sys__` scope or a doubled separator inside a body', () => {
    // Two structural properties later slices rely on: a scope is never empty (an empty scope
    // merges two systems into one namespace), and `__` is reserved as the field separator, so a
    // body containing one would make the rendered name ambiguous to parse.
    for (const line of render().split('\n')) {
      if (line === '') continue
      const atom = line.split('\t')[2]?.replace(' [NEG]', '') ?? ''
      // TOTAL, not filtered. A `if (!atom.startsWith('sys__')) continue` guard here passed
      // silently under the renderAtom sabotage that this slice's gate exists to catch — every
      // atom stopped matching the prefix, so the loop skipped the whole corpus and reported green.
      // An assertion that opts out when its subject changes shape is not an assertion.
      expect(atom.startsWith('sys__'), `atom is not sys__-scoped: ${atom}`).toBe(true)
      const fields = atom.slice('sys__'.length).split('__')
      expect(fields.length, `atom is not sys__<scope>__<kind>__<body>: ${atom}`).toBe(3)
      expect(fields[0], `empty scope in ${atom}`).not.toBe('')
    }
  })
})
