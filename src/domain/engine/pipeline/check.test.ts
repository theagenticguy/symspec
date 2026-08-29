/**
 * Documents `runCheck`'s coverage contract has to be honest about: the smallest one, the ones
 * that can buy a certificate they did not earn, and the one whose evidence has to name which
 * EARS slot each blamed bound came out of.
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
 *
 * `FND_NEEDS_REVIEW` is the other one, and it is the strongest case for reading membership
 * rather than severity: it is the solver's own `unknown`, which `formal/needs-review.ts` says
 * is "NEVER interpreted as no conflict". `ubiquitousPairDoc` is the minimal document where a
 * context group has two members, so the finding can name two ids and become eligible for every
 * ≥2-id predicate the report computes.
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

/**
 * Two UBIQUITOUS requirements, on two different systems.
 *
 * The shape is chosen so one solver answer decides everything the assertions read. Both
 * requirements have an empty guard, so both are members of the baseline context group —
 * that is the only way a group's `memberIds` reaches two, and `FND_NEEDS_REVIEW` needs
 * two to name two. The systems differ, so `emitCandidatePairs` skips the pair on its
 * first test and `pairsChecked` is 0, which is what puts `FND_NO_PAIRS_CHECKED` and the
 * `no-decide-tier-comparison` demotion in play. Both sentences are lint-clean, so the
 * AC-3-7 gate admits them and the needs-review tier actually runs over them.
 */
const ubiquitousPairDoc = () => {
  const ubi = (id: string, systemName: string, systemResponse: string) => ({
    id,
    patternType: 'ubiquitous' as const,
    systemName,
    systemResponse,
    negated: false,
    sentence: `The ${systemName} shall ${systemResponse}.`,
    priority: 'medium' as const,
    status: 'draft' as const,
    createdAt: TS,
    updatedAt: TS,
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
  })
  return {
    requirements: {
      [ID_A]: ubi(ID_A, 'billing ledger', 'record the settled invoice'),
      [ID_B]: ubi(ID_B, 'telemetry probe', 'publish the heartbeat'),
    },
    glossary: [],
    antonyms: [],
    waivers: [],
    terms: [],
    stateModel: { variables: [] },
  }
}

/**
 * An `unknown` is the strongest possible NON-verdict, and the verdict is computed here.
 *
 * `formal/needs-review.ts` pins that an inconclusive group becomes `FND_NEEDS_REVIEW` and
 * is "NEVER interpreted as no conflict". That pin stops one tier short of the claim: the
 * finding then flows into the same `formal[]` array `runCheck` reads its coverage
 * predicates off, and those predicates are id-count plus set membership — they never read
 * severity. So an `info` finding naming ≥2 ids is, absent membership, indistinguishable
 * from a solver verdict, and an undecided group would CERTIFY the run it declined to
 * decide.
 *
 * Every assertion below therefore lives at the `runCheck` level, and each one is the
 * observable of a different mechanism: `inconclusive-group` for the demotion,
 * `no-decide-tier-comparison` for `PROPOSE_ONLY_FND_CODES`, `FND_NO_PAIRS_CHECKED` for
 * `COVERAGE_GAP_FND_CODES`, `participates` for the coverage row.
 */
describe('a context group the solver could not decide', () => {
  /** Forces the AC-4-7 `unknown` branch. z3 reads `timeout: 0` as no timeout and decides
   * a two-atom document in microseconds at `1`, so the real solver cannot supply this
   * outcome as a fixture — only as a race. */
  const alwaysUnknown = async () => 'unknown' as const

  it('is the shape the fixture claims: no pair compared, and the group names both ids', async () => {
    // Two premises, because either failing would make the assertions below pass for the
    // wrong reason. (1) Without the forced `unknown` the document is the control — it
    // already discloses "nothing compared" and raises no needs-review finding. (2) With
    // it, exactly one finding fires and it names BOTH requirements, which is what makes
    // it eligible for every ≥2-id predicate in the report.
    const control = await runCheck(ubiquitousPairDoc() as never, {})
    expect(control.pairsChecked).toBe(0)
    expect(control.findings.map((f) => f.code)).not.toContain('FND_NEEDS_REVIEW')

    const report = await runCheck(ubiquitousPairDoc() as never, {
      needsReviewCheckGroup: alwaysUnknown,
    })
    expect(
      report.findings.filter((f) => f.code === 'FND_NEEDS_REVIEW').map((f) => f.requirementIds),
    ).toEqual([[ID_A, ID_B]])
  })

  it('cannot certify the run, and says so with its own demotion', async () => {
    const report = await runCheck(ubiquitousPairDoc() as never, {
      needsReviewCheckGroup: alwaysUnknown,
    })
    expect(report.verified).toBe(false)
    const demotion = report.coverage.demotions.find((d) => d.reason === 'inconclusive-group')
    expect(demotion?.requirementIds).toEqual([ID_A, ID_B])
    // The action has to name the lever that actually moves a per-group `unknown`. The
    // whole-run budget does not: raising it gives the group no more time.
    expect(demotion?.action).toContain('--timeout-ms')
  })

  it('does not count as the decide-tier comparison the run never made', async () => {
    const report = await runCheck(ubiquitousPairDoc() as never, {
      needsReviewCheckGroup: alwaysUnknown,
    })
    expect(report.coverage.demotions.map((d) => d.reason)).toContain('no-decide-tier-comparison')
    // The participation clause reads the same predicate: an undecided group must not mark
    // its members as having been compared with a peer.
    expect(report.coverage.requirements.map((r) => r.participates)).toEqual([false, false])
  })

  it('keeps the "nothing was compared" disclaimer it would otherwise hide', async () => {
    const report = await runCheck(ubiquitousPairDoc() as never, {
      needsReviewCheckGroup: alwaysUnknown,
    })
    // `noPairsChecked` is derived from the counter, so it stays true regardless. The
    // disclaimer is what a reader sees, and dropping it while the counter says nothing was
    // compared is the report contradicting itself in two adjacent fields.
    expect(report.residualRisk.noPairsChecked).toBe(true)
    expect(report.findings.map((f) => f.code)).toContain('FND_NO_PAIRS_CHECKED')
  })
})

/**
 * A genuine numeric conflict between a GUARD bound and a RESPONSE bound.
 *
 * Both requirements carry the same precondition, so they are co-live in one context
 * group; the committed `flush latency` alias routes the response's verb-led label onto
 * the guard's quantity key, which is the documented job of a `glossary add` (it is what
 * `FND_QUANTITY_ALIAS_CANDIDATE` proposes). The result is one cell holding a `pre` bound
 * of `> 500 ms` and a `resp` bound of `< 100 ms`.
 *
 * The point of the fixture is the SLOT ROLE. `numeric-contradiction.ts` receives the slot
 * as data and `numeric.test.ts` pins the extractor, but the three string literals that
 * decide which EARS slot each bound is reported under live in `runCheck` alone
 * (`extractNumericPredicates(r.trigger, …, 'trig', …)` and its `pre`/`resp` siblings), and
 * an author reading the core has to be able to tell the obligation from the precondition
 * without re-reading the sentence. Nothing between the extractor's unit test and here
 * crosses that wiring.
 */
const guardVsResponseBoundDoc = () => {
  const stateReq = (id: string, systemResponse: string) => ({
    id,
    patternType: 'state-driven' as const,
    systemName: 'flush worker',
    preCondition: 'the flush latency is above 500 ms',
    systemResponse,
    negated: false,
    sentence: `While the flush latency is above 500 ms, the flush worker shall ${systemResponse}.`,
    priority: 'medium' as const,
    status: 'draft' as const,
    createdAt: TS,
    updatedAt: TS,
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
  })
  return {
    requirements: {
      [ID_A]: stateReq(ID_A, 'raise the backlog alarm'),
      [ID_B]: stateReq(ID_B, 'hold the flush latency below 100 ms'),
    },
    glossary: [{ canonical: 'flush latency', aliases: ['hold the flush latency'] }],
    antonyms: [],
    waivers: [],
    terms: [],
    stateModel: { variables: [] },
  }
}

describe('a numeric conflict spanning a guard and a response', () => {
  it('names the EARS slot each blamed bound was read out of', async () => {
    const report = await runCheck(guardVsResponseBoundDoc() as never, {})
    const numeric = report.findings.find((f) => f.code === 'FND_NUMERIC_CONTRADICTION')
    expect(numeric?.requirementIds).toEqual([ID_A, ID_B])
    // Every bound in the core, with the slot it came from. Both roles appear, so a wiring
    // that stamped one label on all three would be visible here — which is the only place
    // it is visible, because the extractor's own tests never cross this call.
    expect(
      numeric?.evidence?.numeric?.predicates.map((p) => [p.slot, p.comparator, p.value]),
    ).toEqual([
      ['pre', '>', 500],
      ['resp', '<', 100],
      ['pre', '>', 500],
    ])
  })
})
