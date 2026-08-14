/**
 * The one-requirement document — the smallest input the coverage contract has
 * to be honest about.
 *
 * `verified: true` on a single requirement is the documented vacuous-truth
 * convention: there is nothing to cross-compare, the run says so in
 * `pairsCheckedNote`, and a demotion here would violate the doctrine that
 * every demotion is finitely dischargeable ("write a second requirement" is
 * not a discharge — the document may legitimately have one).
 *
 * What that convention does NOT license is the coverage row lying about WHY
 * the requirement is uncovered. The generic suggestion tells the author to
 * rewrite it "to share guard/response vocabulary with the requirements it
 * relates to" — requirements that do not exist. An agent following that
 * instruction churns the only requirement in the document and re-checks into
 * the same row forever.
 */

import { describe, expect, it } from 'vitest'
import { runCheck } from './check.ts'

const TS = '2026-01-01T00:00:00.000Z'
const ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const oneRequirementDoc = () => ({
  requirements: {
    [ID]: {
      id: ID,
      patternType: 'event-driven' as const,
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      trigger: 'the user signs in',
      negated: false,
      sentence: 'When the user signs in, the auth service shall issue a session token.',
      priority: 'medium' as const,
      status: 'draft' as const,
      createdAt: TS,
      updatedAt: TS,
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    },
  },
  glossary: [],
  antonyms: [],
  waivers: [],
  stateModel: { variables: [] },
})

describe('a one-requirement document', () => {
  it('is vacuously verified, and SAYS the comparison never happened', async () => {
    const report = await runCheck(oneRequirementDoc() as never, {})
    expect(report.verified).toBe(true)
    expect(report.coverage.demotions).toEqual([])
    expect(report.coverage.pairsCheckedNote).toContain('Fewer than two requirements')
  })

  it('does not tell the author to align vocabulary with requirements that do not exist', async () => {
    const report = await runCheck(oneRequirementDoc() as never, {})
    const row = report.coverage.requirements[0]
    expect(row?.participates).toBe(false)
    // The row must name the REAL state — only requirement, nothing to compare
    // against yet — not hand out the multi-requirement rewrite advice.
    expect(row?.suggestion).toContain('only requirement')
    expect(row?.suggestion).not.toContain('Rewrite')
  })
})
