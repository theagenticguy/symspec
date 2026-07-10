import { describe, expect, it } from 'vitest'
import type { Atomize, AtomLit, EncodableRequirement } from '../encode.js'
import { encode } from '../encode.js'
import {
  findNeedsReview,
  planNeedsReviewGroups,
  SolverBudgetExceededError,
} from '../needs-review.js'

// A deterministic atomizer for the pure planNeedsReviewGroups tests, mirroring
// contradiction.test.ts's `fakeAtomize` shape.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
const fakeAtomize: Atomize = (kind, slotText, systemName, negated): AtomLit => ({
  atom: `sys__${norm(systemName)}__${kind}__${norm(slotText)}`,
  negated,
})

const req = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('planNeedsReviewGroups — member-id projection over AC-4-3 grouping (pure)', () => {
  it('attaches member ids matching each group key', () => {
    const a = encode(
      req({ id: 'A', patternType: 'event-driven', trigger: 'the user logs in' }),
      fakeAtomize,
    )
    const b = encode(
      req({ id: 'B', patternType: 'event-driven', trigger: 'the user logs in' }),
      fakeAtomize,
    )
    const c = encode(
      req({ id: 'C', patternType: 'event-driven', trigger: 'the user logs out' }),
      fakeAtomize,
    )
    const groups = planNeedsReviewGroups([a, b, c])
    // baseline (empty, no members) + shared-trigger group {A,B} + distinct-trigger group {C}
    expect(groups).toHaveLength(3)
    const baseline = groups.find((g) => g.key === '')
    expect(baseline?.memberIds).toEqual([])
    const shared = groups.find((g) => g.contextAtoms.length > 0 && g.memberIds.includes('A'))
    expect(shared?.memberIds).toEqual(['A', 'B'])
    const solo = groups.find((g) => g.memberIds.includes('C'))
    expect(solo?.memberIds).toEqual(['C'])
  })

  it('a ubiquitous requirement is a member of the baseline empty group', () => {
    const u = encode(req({ id: 'U', patternType: 'ubiquitous' }), fakeAtomize)
    const groups = planNeedsReviewGroups([u])
    const baseline = groups.find((g) => g.key === '')
    expect(baseline?.memberIds).toEqual(['U'])
  })
})

describe('findNeedsReview — per-group unknown/timeout → FND_NEEDS_REVIEW, run continues (AC-4-7)', () => {
  it('forced per-group unknown on one group → FND_NEEDS_REVIEW naming that group, run completes with other groups checked', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'revoke the session',
      }),
    ]

    const checkedGroups: string[] = []
    const findings = await findNeedsReview(reqs, {
      checkGroup: async (group) => {
        checkedGroups.push(group.key)
        // Force the FIRST group ('' baseline) to be unknown; all others sat.
        if (group.key === '') return 'unknown'
        return 'sat'
      },
    })

    // Run continued through every group, not just the forced one.
    expect(checkedGroups.length).toBeGreaterThan(1)

    // Only the baseline group has zero members (nothing to name) — force a
    // non-empty group unknown instead to prove the finding names ids.
    const findingsB = await findNeedsReview(reqs, {
      checkGroup: async (group) => {
        if (group.memberIds.includes('A')) return 'unknown'
        return 'sat'
      },
    })
    expect(findingsB).toHaveLength(1)
    expect(findingsB[0]?.code).toBe('FND_NEEDS_REVIEW')
    expect(findingsB[0]?.severity).toBe('info')
    expect(findingsB[0]?.requirementIds).toEqual(['A'])
    void findings
  })

  it('multiple groups going unknown each produce their own FND_NEEDS_REVIEW finding', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'revoke the session',
      }),
    ]
    const findings = await findNeedsReview(reqs, {
      checkGroup: async () => 'unknown',
    })
    // baseline group (no members) is skipped; the two non-empty groups both fire.
    expect(findings).toHaveLength(2)
    for (const f of findings) {
      expect(f.code).toBe('FND_NEEDS_REVIEW')
      expect(f.severity).toBe('info')
    }
    const allIds = findings.flatMap((f) => f.requirementIds).sort()
    expect(allIds).toEqual(['A', 'B'])
  })

  it('sat/unsat groups never produce FND_NEEDS_REVIEW', async () => {
    const reqs: EncodableRequirement[] = [
      req({ id: 'A', patternType: 'ubiquitous', systemResponse: 'log the request' }),
    ]
    const findings = await findNeedsReview(reqs, {
      checkGroup: async () => 'sat',
    })
    expect(findings).toEqual([])
  })

  it('a real forced-unknown per-group timeout (timeoutMs 1) still resolves via the real solver without throwing', async () => {
    // Uses the REAL default checker (no injected checkGroup) against a
    // deliberately minuscule per-group timeout so `unknown` is a plausible
    // real outcome; regardless of whether this particular run happens to
    // finish inside 1ms, findNeedsReview must not throw and must return an
    // array (never an ERR_SOLVER_* for a per-group outcome).
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    const findings = await findNeedsReview(reqs, { timeoutMs: 1 })
    expect(Array.isArray(findings)).toBe(true)
    for (const f of findings) {
      expect(f.code).toBe('FND_NEEDS_REVIEW')
    }
  })
})

describe('findNeedsReview — whole-run budget exhaustion → ERR_SOLVER_TIMEOUT, run aborts (AC-4-7)', () => {
  it('forced whole-run budget exhaustion throws SolverBudgetExceededError (ERR_SOLVER_TIMEOUT), never a per-group finding', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'revoke the session',
      }),
    ]

    // Deterministic fake clock: first now() call (the `start` capture) reads
    // 0; every call thereafter reads far past the budget, so the very first
    // per-group budget check inside the loop throws.
    let calls = 0
    const now = () => (calls++ === 0 ? 0 : 100_000)

    let caught: unknown
    try {
      await findNeedsReview(reqs, {
        solverBudgetMs: 10,
        now,
        checkGroup: async () => 'sat', // would never even be reached
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SolverBudgetExceededError)
    const err = caught as SolverBudgetExceededError
    expect(err.code).toBe('ERR_SOLVER_TIMEOUT')
    expect(err.suggestions.some((s) => s.includes('--solver-budget-ms'))).toBe(true)
  })

  it('no solverBudgetMs supplied → whole-run budget is never enforced, even with a slow clock', async () => {
    const reqs: EncodableRequirement[] = [
      req({ id: 'A', patternType: 'ubiquitous', systemResponse: 'log the request' }),
    ]
    let calls = 0
    const now = () => (calls++ === 0 ? 0 : 100_000)
    const findings = await findNeedsReview(reqs, {
      now,
      checkGroup: async () => 'sat',
    })
    expect(findings).toEqual([])
  })

  it('budget check runs BEFORE the group check, so a group never partially runs past budget', async () => {
    const reqs: EncodableRequirement[] = [
      req({ id: 'A', patternType: 'ubiquitous', systemResponse: 'log the request' }),
    ]
    let checkGroupCalls = 0
    let calls = 0
    const now = () => (calls++ === 0 ? 0 : 100_000)

    await expect(
      findNeedsReview(reqs, {
        solverBudgetMs: 10,
        now,
        checkGroup: async () => {
          checkGroupCalls++
          return 'sat'
        },
      }),
    ).rejects.toBeInstanceOf(SolverBudgetExceededError)
    expect(checkGroupCalls).toBe(0)
  })
})

describe('findNeedsReview — degenerate inputs', () => {
  it('empty spec → no findings, no throw', async () => {
    const findings = await findNeedsReview([])
    expect(findings).toEqual([])
  })
})
