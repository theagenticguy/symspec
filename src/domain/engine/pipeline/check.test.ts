/**
 * Two documents `runCheck`'s coverage contract has to be honest about: the smallest one, and the
 * smallest one that can buy a certificate it did not earn.
 *
 * ## The one-requirement document
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
 *
 * ## The eligibility-only cross-requirement finding
 *
 * The pipeline decides "a comparison happened" from a finding's id COUNT and its membership in
 * `PROPOSE_ONLY_FND_CODES` / `COVERAGE_GAP_FND_CODES`. It never reads severity. So an `info`
 * finding that names ≥2 ids is, absent that membership, indistinguishable from a solver verdict:
 * it clears `inconclusive`, deletes the `no-decide-tier-comparison` demotion, and suppresses the
 * `FND_NO_PAIRS_CHECKED` disclaimer.
 *
 * `FND_INCOMPLETE` is exactly that shape. It names its whole same-trigger group, and its SAT
 * answer is fixed by the encoding rather than read off the document (`formal/incomplete.ts`), so
 * it fires on eligibility alone. `twoRequirementDoc` below is the minimal document where it is
 * the ONLY cross-requirement finding: identical responses and one shared trigger atom (so no
 * "same event, different reactions" candidate), non-overlapping preconditions and low sentence
 * Jaccard (so no candidate pair and no shared context group), which leaves `pairsChecked === 0`.
 * Zero requirement pairs are compared, so the run must say so on every channel at once.
 */

import { describe, expect, it } from 'vitest'
import { emitCandidatePairs } from '../solvers/free/pairwise-filter.ts'
import { asView } from '../solvers/types.ts'
import { runCheck } from './check.ts'

const TS = '2026-01-01T00:00:00.000Z'
const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ID_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ID_B = 'aaaaaaaa-0000-4000-8000-00000000000b'

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
  terms: [],
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

const guardedReq = (o: { id: string; preCondition: string; sentence: string }) => ({
  id: o.id,
  patternType: 'event-driven' as const,
  systemName: 'auth service',
  preCondition: o.preCondition,
  trigger: 'the user signs in',
  systemResponse: 'issue a session token',
  negated: false,
  sentence: o.sentence,
  priority: 'medium' as const,
  status: 'draft' as const,
  createdAt: TS,
  updatedAt: TS,
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
})

const twoRequirementDoc = () => ({
  requirements: {
    [ID_A]: guardedReq({
      id: ID_A,
      preCondition: 'the account is verified',
      sentence:
        'While the account is verified, when the user signs in, the auth service shall issue a session token.',
    }),
    [ID_B]: guardedReq({
      id: ID_B,
      preCondition: 'the tenant quota remains below its monthly ceiling',
      sentence:
        'While the tenant quota remains below its monthly ceiling, upon sign-in the auth service shall issue a session token.',
    }),
  },
  glossary: [],
  antonyms: [],
  waivers: [],
  terms: [],
  stateModel: { variables: [] },
})

describe('a document whose only cross-requirement finding is the completeness heuristic', () => {
  it('is the shape the fixture claims: FND_INCOMPLETE over two ids, and nothing else compared', async () => {
    // The premise the two assertions below rest on. Without it, a green run could be green
    // because some other tier did compare the pair, or because the tier never fired at all.
    const report = await runCheck(twoRequirementDoc() as never, {})
    expect(report.pairsChecked).toBe(0)
    expect(report.residualRisk.noPairsChecked).toBe(true)
    // The disclaimer itself spans both ids, so it is excluded here — this premise has to hold
    // whether or not the disclaimer fires, otherwise it stops being an independent premise.
    const crossReq = report.findings.filter(
      (f) => f.requirementIds.length >= 2 && f.code !== 'FND_NO_PAIRS_CHECKED',
    )
    expect(crossReq.map((f) => f.code)).toEqual(['FND_INCOMPLETE'])
  })

  it('still emits the "nothing was compared" disclaimer', async () => {
    const report = await runCheck(twoRequirementDoc() as never, {})
    // `residualRisk.noPairsChecked` and a missing FND_NO_PAIRS_CHECKED are the internal
    // contradiction COVERAGE_GAP_FND_CODES exists to prevent: the report would state that
    // nothing was compared while hiding the finding that says so.
    expect(report.findings.map((f) => f.code)).toContain('FND_NO_PAIRS_CHECKED')
  })

  it('records the no-decide-tier-comparison demotion, so eligibility alone never certifies', async () => {
    const report = await runCheck(twoRequirementDoc() as never, {})
    expect(report.coverage.demotions.map((d) => d.reason)).toContain('no-decide-tier-comparison')
    expect(report.verified).toBe(false)
  })
})

/**
 * A candidate pair the pairwise tier PRUNES: same system (so the free-tier filter emits it) with
 * one precondition containing the other (so rule 2 fires), and every other slot different — so
 * the two bodies share no atom and `sharesAtom` skips the pair before any solve.
 *
 * The pair is the whole point. `pairsChecked` is what `coverage.pairsCheckedNote` renders as
 * "N candidate pair(s) shared an atom and were compared", and what `residualRisk.noPairsChecked`
 * and the `no-decide-tier-comparison` demotion key on. Counting a pruned pair there certifies a
 * comparison that did not happen, on the strength of a pair that shared no vocabulary.
 */
const prunedPairDoc = () => ({
  requirements: {
    [ID_A]: {
      ...guardedReq({
        id: ID_A,
        preCondition: 'the account is verified',
        sentence:
          'While the account is verified, when the user signs in, the auth service shall issue a session token.',
      }),
    },
    [ID_B]: {
      ...guardedReq({
        id: ID_B,
        preCondition: 'the account is verified and the tenant is active',
        sentence:
          'While the account is verified and the tenant is active, when the client requests a refresh, the auth service shall rotate the signing key.',
      }),
      trigger: 'the client requests a refresh',
      systemResponse: 'rotate the signing key',
    },
  },
  glossary: [],
  antonyms: [],
  waivers: [],
  terms: [],
  stateModel: { variables: [] },
})

describe('a candidate pair the pairwise tier prunes', () => {
  it('is the shape the fixture claims: one candidate pair, and no atom shared', async () => {
    // Two independent premises, because either one failing would make the assertion below pass
    // for the wrong reason. (1) The free tier really emits the pair — otherwise "0 compared" is
    // true trivially. (2) Every atom in the document is a singleton — that is atom-disjointness
    // measured through the report, and it is what makes the pair prunable.
    const views = Object.values(prunedPairDoc().requirements).map((r) => asView(r as never))
    const pairs = emitCandidatePairs(views)
    expect(pairs.map((p) => p.reason)).toEqual(['same-system-overlapping-precondition'])

    const report = await runCheck(prunedPairDoc() as never, {})
    expect(report.coverage.encoded).toBe(2)
    expect(report.residualRisk.unmatchedAtoms).toBe(6)
  })

  it('counts as a pair NOT compared, so the coverage note stops claiming it was', async () => {
    const report = await runCheck(prunedPairDoc() as never, {})
    expect(report.pairsChecked).toBe(0)
    expect(report.coverage.pairsCheckedNote).toContain('0 candidate pair(s) shared an atom')
    // The negative guard: the candidate count is 1, and that is the number this note must not
    // report. Asserting only the correct string passes just as happily against the candidate
    // total when the document happens to have one prunable pair and one compared one.
    expect(report.coverage.pairsCheckedNote).not.toContain('1 candidate pair(s) shared an atom')
  })

  it('leaves the run inconclusive, because nothing cross-requirement was decided', async () => {
    const report = await runCheck(prunedPairDoc() as never, {})
    expect(report.residualRisk.noPairsChecked).toBe(true)
    expect(report.findings.map((f) => f.code)).toContain('FND_NO_PAIRS_CHECKED')
    expect(report.coverage.demotions.map((d) => d.reason)).toContain('no-decide-tier-comparison')
  })
})
