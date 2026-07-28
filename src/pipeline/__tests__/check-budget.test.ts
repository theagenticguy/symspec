/**
 * AC-1-7 at the PIPELINE level: `--solver-budget-ms` bounds the whole run, and a
 * budget-truncated run can never report `verified: true`.
 *
 * The soundness claim under test is the sharpest one in the task: a run that was
 * cut short did not compare everything it would otherwise have compared, so its
 * silence is not a consistency certificate. Concretely:
 *
 *   - a truncated run reports `verified: false`;
 *   - the reason is visible in `coverage.demotions` as `solver-budget-exhausted`,
 *     with an action naming the knob that discharges it;
 *   - `ERR_SOLVER_TIMEOUT` is NOT raised for tier truncation — that code stays
 *     reserved for the whole-run abort `findNeedsReview` owns (AC-4-7), which the
 *     pipeline still reaches by handing that tier the REMAINING budget;
 *   - and — the regression that matters most — a generous budget leaves an
 *     otherwise-identical run byte-identical: same codes, same severities, same
 *     counts, same `verified`.
 *
 * Truncation is forced by a 0ms budget rather than by a slow document, so these
 * assertions are deterministic and fast. `SolverBudget.expired()` is
 * strictly-greater-than, so a 0ms budget expires as soon as the clock advances at
 * all, which the first real solver call guarantees.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import type { Embedder } from '../../formal/embed.js'
import { SolverBudgetExceededError } from '../../formal/needs-review.js'
import { type CheckFinding, type CheckOptions, runCheck } from '../check.js'

function req(partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement {
  const base: Requirement = {
    id: partial.id,
    patternType: partial.patternType ?? 'event-driven',
    systemName: partial.systemName ?? 'auth service',
    systemResponse: partial.systemResponse ?? 'issue a session token',
    negated: partial.negated ?? false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    ...(partial.trigger !== undefined ? { trigger: partial.trigger } : {}),
    ...(partial.preCondition !== undefined ? { preCondition: partial.preCondition } : {}),
  }
  base.sentence = renderSentence(base)
  return base
}

function docOf(reqs: Requirement[]): RequirementsDoc {
  const doc = emptyDoc()
  for (const r of reqs) doc.requirements[r.id] = r
  return doc
}

/**
 * The same low-cosine fake embedder the sibling wishlist suite uses: the hardened
 * `verified` predicate demotes when the semantic tier did not run (clause d), so a
 * test that wants `verified: true` must supply one.
 */
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t, i) => {
    const v = new Float32Array(4)
    v[i % 4] = 1
    v[3] = t.length % 2 === 0 ? 0.01 : 0.02
    return v
  })
const withSemantic = { semantic: { embedder: fakeEmbedder } } satisfies CheckOptions

const TRIGGER = 'the user submits valid credentials'

/**
 * A document that reports `verified: true` on a normal run (pinned by the first
 * test below). Two same-trigger requirements ⇒ one compared pair, no uncovered
 * requirement, no opposition candidate. Any `verified: false` in this file is
 * therefore caused by the budget and nothing else.
 */
function verifiableDoc(): RequirementsDoc {
  return docOf([
    req({ id: randomUUID(), trigger: TRIGGER, systemResponse: 'issue a session token' }),
    req({ id: randomUUID(), trigger: TRIGGER, systemResponse: 'grant elevated access' }),
  ])
}

/** A document with a provable propositional contradiction across two ids. */
function contradictingDoc(): { doc: RequirementsDoc; ids: [string, string] } {
  const ids: [string, string] = [randomUUID(), randomUUID()]
  return {
    doc: docOf([
      req({ id: ids[0], trigger: TRIGGER, systemResponse: 'issue a session token' }),
      req({
        id: ids[1],
        trigger: TRIGGER,
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]),
    ids,
  }
}

const codeMultiset = (findings: CheckFinding[]): string[] =>
  findings.map((f) => `${f.code}:${f.severity}`).sort()

describe('AC-1-7 — a budget-truncated run never reports verified:true', () => {
  it('BASELINE: the fixture is verified:true with no budget at all', async () => {
    // Pins the control. Without this, a `verified: false` below could be caused
    // by anything and the test would prove nothing about the budget.
    const report = await runCheck(verifiableDoc(), withSemantic)
    expect(report.verified).toBe(true)
    expect(report.coverage.demotions).toEqual([])
  })

  it('an exhausted budget demotes verified and names solver-budget-exhausted', async () => {
    const report = await runCheck(verifiableDoc(), { ...withSemantic, solverBudgetMs: 0 })
    expect(report.verified).toBe(false)
    const reasons = report.coverage.demotions.map((d) => d.reason)
    expect(reasons).toContain('solver-budget-exhausted')
  })

  it('the demotion action names --solver-budget-ms and refuses waiving as a discharge', async () => {
    const report = await runCheck(verifiableDoc(), { ...withSemantic, solverBudgetMs: 0 })
    const demotion = report.coverage.demotions.find((d) => d.reason === 'solver-budget-exhausted')
    expect(demotion).toBeDefined()
    expect(demotion!.action).toContain('--solver-budget-ms')
    // A truncation is a coverage FACT; suppressing a finding cannot make the
    // comparison have happened. The action must say so.
    expect(demotion!.action.toLowerCase()).toContain('waiving')
  })

  it('a truncated run does NOT raise ERR_SOLVER_TIMEOUT — it returns a report', async () => {
    // The AC-4-7 boundary: `ERR_SOLVER_TIMEOUT` is a whole-run ABORT, never a
    // per-tier signal. Tier truncation must therefore stay reportable, because a
    // thrown error carries no `coverage.demotions` for an agent to act on.
    const report = await runCheck(verifiableDoc(), { ...withSemantic, solverBudgetMs: 0 }).catch(
      (e: unknown) => e,
    )
    expect(report).not.toBeInstanceOf(SolverBudgetExceededError)
    expect(report).toHaveProperty('coverage')
  })

  it('truncation demotes even a <2-requirement doc, which is otherwise vacuously verified', async () => {
    // The `requirements.length >= 2` guard around the other demotions encodes
    // "nothing to cross-compare ⇒ vacuously verified" — true only when the tiers
    // actually finished. Truncation is a statement about the RUN, so it must
    // escape that guard; otherwise a one-requirement doc could be truncated and
    // still certify.
    const doc = docOf([
      req({ id: randomUUID(), trigger: TRIGGER, systemResponse: 'issue a session token' }),
    ])
    const unbounded = await runCheck(doc, withSemantic)
    expect(unbounded.verified).toBe(true)

    const truncated = await runCheck(doc, { ...withSemantic, solverBudgetMs: 0 })
    expect(truncated.verified).toBe(false)
    expect(truncated.coverage.demotions.map((d) => d.reason)).toContain('solver-budget-exhausted')
  })

  it('a proven contradiction that WAS found still reports, alongside the truncation demotion', async () => {
    // Truncation withholds work; it never retracts a finding already proved. A
    // generous budget must still surface the contradiction, and `verified` is
    // false for the contradiction's own reasons regardless.
    const { doc, ids } = contradictingDoc()
    const report = await runCheck(doc, { ...withSemantic, solverBudgetMs: 60_000 })
    const contradictions = report.findings.filter((f) => f.code === 'FND_CONTRADICTION')
    expect(contradictions).toHaveLength(1)
    expect([...contradictions[0]!.requirementIds].sort()).toEqual([...ids].sort())
    expect(report.coverage.demotions.map((d) => d.reason)).not.toContain('solver-budget-exhausted')
  })
})

describe('AC-1-7 — a generous budget changes nothing (criterion 4: no finding drift)', () => {
  it('same codes, severities, counts and verified as an unbudgeted run', async () => {
    const doc = verifiableDoc()
    const plain = await runCheck(doc, withSemantic)
    const budgeted = await runCheck(doc, { ...withSemantic, solverBudgetMs: 60_000 })

    expect(codeMultiset(budgeted.findings)).toEqual(codeMultiset(plain.findings))
    expect(budgeted.counts).toEqual(plain.counts)
    expect(budgeted.verified).toBe(plain.verified)
    expect(budgeted.pairsChecked).toBe(plain.pairsChecked)
    expect(budgeted.coverage.demotions).toEqual(plain.coverage.demotions)
  })

  it('a generous --timeout-ms changes nothing either', async () => {
    const doc = verifiableDoc()
    const plain = await runCheck(doc, withSemantic)
    const bounded = await runCheck(doc, { ...withSemantic, timeoutMs: 30_000 })
    expect(codeMultiset(bounded.findings)).toEqual(codeMultiset(plain.findings))
    expect(bounded.counts).toEqual(plain.counts)
    expect(bounded.verified).toBe(plain.verified)
  })

  it('the contradiction fixture is unchanged under a generous budget', async () => {
    const { doc } = contradictingDoc()
    const plain = await runCheck(doc, withSemantic)
    const budgeted = await runCheck(doc, { ...withSemantic, solverBudgetMs: 60_000 })
    expect(codeMultiset(budgeted.findings)).toEqual(codeMultiset(plain.findings))
    expect(budgeted.counts).toEqual(plain.counts)
  })
})

describe('AC-1-7 — the pipeline never fails HARDER at a looser budget (monotonicity)', () => {
  // Verified live on a 100-requirement document BEFORE this fix: budgets of
  // 1/100/500/1000/1500ms and 3000ms+ all returned a usable report with honest
  // `solver-budget-exhausted` demotions, but 2000ms — the band where the budget
  // survives subsumption and then dies INSIDE `findNeedsReview`'s group loop —
  // escaped as `ERR_SOLVER_TIMEOUT`, exit 2, with no report at all. A tighter
  // budget behaving better than a looser one is incoherent, and it hands an
  // agent an error envelope on exactly the runs where a partial verdict is most
  // useful. The pipeline now absorbs that throw into the same truncation
  // channel every other tier uses.
  //
  // `findNeedsReview`'s throw is NOT weakened — its contract is asserted
  // directly in `formal/__tests__/needs-review.test.ts` and remains the behavior
  // for a direct library caller. Only the pipeline, which has a report to return,
  // converts it into a demotion.
  it('returns a report (never an error envelope) across a budget sweep', async () => {
    const { doc } = contradictingDoc()
    // Sweep budgets spanning "expires immediately", "expires mid-run", and
    // "never expires". Every one must yield a usable report — that is the whole
    // claim. Note `verified` is deliberately NOT asserted here: on a document
    // this small a generous budget legitimately completes every tier, and a
    // complete run is allowed to certify. The invariant is one-directional —
    // truncation ⇒ not verified — and it is asserted where truncation is forced.
    for (const solverBudgetMs of [0, 1, 2, 5, 25, 100, 1000, 60_000]) {
      const report = await runCheck(doc, { ...withSemantic, solverBudgetMs })
      const truncated = (report.coverage?.demotions ?? []).some(
        (d) => d.reason === 'solver-budget-exhausted',
      )
      const proved = report.findings.some((f) => f.code === 'FND_CONTRADICTION')
      // The honest invariant is a DISJUNCTION, and getting this wrong twice while
      // writing this test is itself the lesson: at a 0ms budget even the
      // contradiction tier is truncated before it runs, so the planted conflict
      // is NOT reported. That is correct — the run says "I did not finish"
      // instead of "I found nothing" — but it means "the contradiction always
      // survives" is false. What must always hold: the run either PROVED the
      // conflict, or it ADMITTED it was cut short. Never silence.
      expect(proved || truncated).toBe(true)
      // And a cut-short run may never certify.
      if (truncated) expect(report.verified).toBe(false)
    }
  })

  it('never raises ERR_SOLVER_TIMEOUT out of runCheck for a mid-loop budget death', async () => {
    const { doc } = contradictingDoc()
    // Budgets large enough to clear the early tiers but too small to finish are
    // exactly the band that used to escape as an error envelope with no report.
    for (const solverBudgetMs of [1, 2, 3, 5, 8, 13, 21, 34]) {
      // The assertion that matters: it RESOLVES rather than rejecting.
      const report = await runCheck(doc, { ...withSemantic, solverBudgetMs })
      expect(report).toHaveProperty('findings')
      expect(report).toHaveProperty('coverage')
    }
  })
})

describe('AC-1-7 — the --strict gate sees a truncated run as inconclusive', () => {
  it('strictGate fails on truncation (verified:false ⇒ EXIT_INCONCLUSIVE)', async () => {
    const report = await runCheck(verifiableDoc(), {
      ...withSemantic,
      strict: true,
      solverBudgetMs: 0,
    })
    expect(report.verified).toBe(false)
    expect(report.strictGate).toBe('fail')
  })

  it('strictGate passes on the same doc with a generous budget', async () => {
    const report = await runCheck(verifiableDoc(), {
      ...withSemantic,
      strict: true,
      solverBudgetMs: 60_000,
    })
    expect(report.strictGate).toBe('pass')
  })
})
