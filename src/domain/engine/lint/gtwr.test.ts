/**
 * The GtWR lint tier's first tests, scoped to R37 — the acronym rule.
 *
 * ## Why this file did not exist
 *
 * `src/domain/engine/lint/` shipped 24 rules with no test file at all. R37 was covered only
 * by construction: `catalog.test.ts` byte-pins its catalog DESCRIPTION and
 * `agents-doc.test.ts` asserts its code appears in the generated docs, so both stayed green
 * while the finding's own `message` claimed a check the function cannot perform — its whole
 * scope is `(sentence: string, findings: GtWRFinding[])`, and it said "ensure it is defined
 * in the glossary". A description gate cannot see a message, which is why the two agreed on
 * a false claim for as long as the claim existed.
 *
 * What is asserted here is therefore the finding's OWN text, its severity, and the
 * reachability of every allowlist entry — the three things nothing else reads.
 */

import { describe, expect, it } from 'vitest'
import type { Requirement } from '../core/schema.ts'
import { ACRONYM_PATTERN, COMMON_ACRONYMS, checkGtWRules } from './gtwr.ts'

const TS = '2026-01-01T00:00:00.000Z'

const req = (sentence: string): Requirement => ({
  id: '11111111-1111-4111-8111-111111111111',
  patternType: 'event-driven',
  systemName: 'billing service',
  systemResponse: 'publish the report',
  trigger: 'the window closes',
  negated: false,
  sentence,
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: TS,
  updatedAt: TS,
})

const r37Of = (sentence: string) =>
  checkGtWRules(req(sentence), sentence).filter((f) => f.code === 'GTWR_R37_ACRONYM')

describe('GTWR_R37_ACRONYM', () => {
  it('flags an acronym at warn severity, with the span pointing at it', () => {
    const sentence = 'When the SLA window closes, the billing service shall publish the report.'
    const found = r37Of(sentence)
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe('warn')
    // The span must select the acronym itself, or a caller cannot underline it.
    expect(sentence.slice(found[0]?.span[0] as number, found[0]?.span[1] as number)).toBe('SLA')
  })

  it('describes only what one sentence can decide', () => {
    const found = r37Of('When the SLA window closes, the billing service shall publish the report.')
    const text = `${found[0]?.message} ${found[0]?.suggestion}`

    // THE NEGATIVE ASSERTION, and it is the load-bearing one. This function has no table in
    // scope — it cannot know whether the acronym is defined anywhere — so any claim about
    // the glossary is a claim it did not check. Asserting the new sentence is PRESENT would
    // pass just as happily on a message containing both, which is how a corrected count in
    // this repo came back twice after being fixed once.
    expect(text).not.toContain('ensure it is defined in the glossary')
    expect(text).not.toContain('add to project glossary')
    expect(found[0]?.message).not.toContain('glossary')

    // What it DOES claim: the acronym is unexpanded in this statement.
    expect(found[0]?.message).toContain('"SLA"')
    expect(found[0]?.message).toContain('this statement')
    expect(found[0]?.suggestion).toContain('first use')
  })

  it('points the document-level question at the tier that can answer it', () => {
    // The claim R37 gave up is not dropped, it moved. `FND_ACRONYM_UNDEFINED` makes it where
    // both committed tables are arguments. This pins the division so a future edit cannot
    // quietly restore the unfounded claim on the grounds that nothing else covers it.
    expect(COMMON_ACRONYMS.has('SLA')).toBe(false)
  })

  it('pins the allowlist MEMBERSHIP, not just the behavior of whatever is in it', () => {
    // Written because the reachability loop below passed a sabotage that DELETED an entry.
    // A test that iterates the set and asserts each member behaves is trivially satisfied by
    // a smaller set — it can only catch a member that misbehaves, never one that vanished.
    // Two tiers now share this set, so a silent removal would make `FND_ACRONYM_UNDEFINED`
    // start demanding a definition for `EOF` with nothing going red.
    expect([...COMMON_ACRONYMS].sort()).toEqual([
      'API',
      'EOF',
      'HTTP',
      'JSON',
      'REST',
      'SMS',
      'SSH',
      'TLS',
      'URL',
      'UUID',
    ])
  })

  it('stays silent on every allowlisted acronym, one at a time', () => {
    // Per-entry REACHABILITY, which is the other half: an entry present but never able to
    // silence anything (a case mismatch, a trailing space) is a dead entry, and the sibling
    // lesson on lexicons exists because six of those once shipped.
    for (const acronym of COMMON_ACRONYMS) {
      const sentence = `When the ${acronym} request fails, the billing service shall retry once.`
      expect(r37Of(sentence), `${acronym} is allowlisted but still flagged`).toEqual([])
    }
    // And the allowlist is not vacuously silencing everything.
    expect(r37Of('When the ZZZ request fails, the billing service shall retry once.')).toHaveLength(
      1,
    )
  })

  it('needs two capitals, so a single initial is not an acronym', () => {
    expect(r37Of('When the A record changes, the billing service shall reload the zone.')).toEqual(
      [],
    )
  })

  it('reports each distinct acronym occurrence in one statement', () => {
    const found = r37Of(
      'When the SLA and the OLA both lapse, the billing service shall escalate once.',
    )
    expect(found.map((f) => f.message)).toHaveLength(2)
    expect(found.some((f) => f.message.includes('"SLA"'))).toBe(true)
    expect(found.some((f) => f.message.includes('"OLA"'))).toBe(true)
  })
})

describe('the shared acronym vocabulary', () => {
  it('exposes ONE pattern and ONE allowlist for both tiers', () => {
    // Two independent copies would let the document-level check demand a definition for a
    // token R37 considers a non-acronym, and the two findings would then contradict each
    // other about one sentence. Shared by reference, so they cannot.
    ACRONYM_PATTERN.lastIndex = 0
    expect([...'the SLA and the OLA lapse'.matchAll(ACRONYM_PATTERN)].map((m) => m[0])).toEqual([
      'SLA',
      'OLA',
    ])
  })

  it('is stateful, so a consumer must reset lastIndex', () => {
    // Documented on the export, and asserted because a shared `g` regex is a classic
    // action-at-a-distance bug: the second consumer silently starts mid-string.
    expect(ACRONYM_PATTERN.global).toBe(true)
    ACRONYM_PATTERN.lastIndex = 0
    expect(ACRONYM_PATTERN.exec('SLA')?.[0]).toBe('SLA')
    // lastIndex has now advanced; without a reset the same call finds nothing.
    expect(ACRONYM_PATTERN.exec('SLA')).toBeNull()
  })
})
