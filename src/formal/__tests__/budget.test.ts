/**
 * AC-1-7: `--timeout-ms` and `--solver-budget-ms` must bound EVERY solver-driving
 * tier, and a budget-truncated run must never pass as a complete one.
 *
 * Before this task both knobs reached 2 of 7 tiers: `solver.set('timeout', …)`
 * existed only in `contradiction.ts` and `needs-review.ts`, and the whole-run
 * budget was consulted only in `findNeedsReview`'s per-group loop. The documented
 * `ERR_SOLVER_TIMEOUT` boundary was therefore unreachable in practice, and a
 * 100-requirement run under `--solver-budget-ms 2000` took ~50s and still
 * reported `verified: true`.
 *
 * What is pinned here, per tier in the AC-1-7 scope:
 *
 *   1. PER-SOLVER TIMEOUT is observably applied. Asserted through a recording
 *      {@link recordingContext} that wraps a real `Z3Context` and captures every
 *      `solver.set(key, value)` call — a genuine observation of the tier's solver
 *      configuration, not a mock of the tier's behavior. The tier still runs a
 *      real Z3 check and still returns its real verdict, so a test that passes
 *      here cannot be passing on a stubbed solver.
 *   2. WHOLE-RUN BUDGET stops the tier and RECORDS the truncation. Forced
 *      deterministically with an injectable clock (the `findNeedsReview`
 *      precedent), never with real sleeps.
 *   3. CHECK-BEFORE-WORK: an already-expired budget means the tier performs ZERO
 *      solver work, so a unit never half-runs past the deadline and a truncated
 *      run is always a strict PREFIX of the full run.
 *   4. `unknown` HANDLING IS UNCHANGED: a per-solver timeout surfacing as
 *      `unknown` must never become a finding. Pinned by asserting a timeout of 1ms
 *      yields no MORE findings than the unbounded run for each tier.
 */

import { describe, expect, it } from 'vitest'
import { makeAtomize } from '../atomize.js'
import { getContext, type Z3Context } from '../backend.js'
import { SolverBudget } from '../budget.js'
import { type Atomize, type AtomLit, type EncodableRequirement, encode } from '../encode.js'
import { checkCompleteness } from '../incomplete.js'
import { extractNumericPredicates } from '../numeric.js'
import { findNumericContradictions } from '../numeric-contradiction.js'
import { checkSubsumption } from '../subsumption.js'
import { findTemporalContradictions } from '../temporal.js'
import { earsToTemporal } from '../temporal-patterns.js'
import { checkVacuity } from '../vacuity.js'

// ---------------------------------------------------------------------------
// The observation seam
// ---------------------------------------------------------------------------

/** One captured `solver.set(key, value)` call. */
interface SetCall {
  key: string
  value: unknown
}

/**
 * Wrap a real {@link Z3Context} so every `new ctx.Solver()` the tier constructs
 * is a REAL solver whose `set()` calls are recorded. Everything else on the
 * context passes through untouched, so the tier under test runs a genuine Z3
 * check and returns its genuine verdict — this observes configuration without
 * faking behavior.
 */
function recordingContext(ctx: Z3Context): {
  ctx: Z3Context
  /** Every `set` call across every solver the tier built, in order. */
  calls: SetCall[]
  /** How many solvers the tier constructed — the "did it do any work" probe. */
  solverCount: () => number
} {
  const calls: SetCall[] = []
  let solvers = 0
  const RealSolver = ctx.Solver
  // A `function` expression, not an arrow: the tiers call `new ctx.Solver()`, and
  // an arrow function is not constructible.
  const SpySolver = function (this: unknown, ...args: unknown[]) {
    solvers += 1
    const inner = new (RealSolver as unknown as new (...a: unknown[]) => object)(...args)
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'set') {
          return (key: string, value: unknown): void => {
            calls.push({ key, value })
            ;(target as { set: (k: string, v: unknown) => void }).set(key, value)
          }
        }
        const got = Reflect.get(target, prop, receiver)
        return typeof got === 'function' ? got.bind(target) : got
      },
    })
  } as unknown as Z3Context['Solver']

  // A shallow spread would drop the context's getters, so proxy instead and
  // substitute only `Solver`.
  const proxied = new Proxy(ctx as unknown as object, {
    get(target, prop, receiver) {
      if (prop === 'Solver') return SpySolver
      return Reflect.get(target, prop, receiver)
    },
  }) as Z3Context

  return { ctx: proxied, calls, solverCount: () => solvers }
}

/** Every `timeout` value the tier configured. */
const timeouts = (calls: SetCall[]): unknown[] =>
  calls.filter((c) => c.key === 'timeout').map((c) => c.value)

/**
 * A budget that is ALREADY expired when handed to a tier. Built from an
 * injectable clock (never a real sleep) so the assertion is deterministic: the
 * clock reports 0 at construction and `budgetMs + 1` on every subsequent read.
 */
function expiredBudget(budgetMs = 1000): SolverBudget {
  let first = true
  return new SolverBudget(budgetMs, {
    now: () => {
      if (first) {
        first = false
        return 0
      }
      return budgetMs + 1
    },
  })
}

/** A budget with plenty of time left, so no tier truncates. */
function livingBudget(): SolverBudget {
  return new SolverBudget(60_000, { now: () => 0 })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const view = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

/** A general/specific pair on a SHARED trigger, so the atom-sharing prune keeps it. */
const generalReq = encode(
  view({
    id: 'REQ-GENERAL',
    patternType: 'event-driven',
    trigger: 'the user submits valid credentials',
    systemResponse: 'issue a session token',
  }),
  fakeAtomize,
)
const specificReq = encode(
  view({
    id: 'REQ-SPECIFIC',
    patternType: 'event-driven',
    preCondition: 'maintenance mode is off',
    trigger: 'the user submits valid credentials',
    systemResponse: 'issue a session token',
  }),
  fakeAtomize,
)
const subsumptionPairs = [
  { a: 'REQ-GENERAL', b: 'REQ-SPECIFIC', reason: 'same-system-same-trigger-different-response' },
] as const
const subsumptionById = new Map([
  ['REQ-GENERAL', generalReq],
  ['REQ-SPECIFIC', specificReq],
])

/** A guarded requirement plus one whose response negates its precondition ⇒ vacuous. */
const vacuitySpec = [
  encode(
    view({
      id: 'REQ-DISABLE',
      patternType: 'ubiquitous',
      systemResponse: 'maintenance mode is enabled',
      negated: true,
    }),
    fakeAtomize,
  ),
  encode(
    view({
      id: 'REQ-GUARDED',
      patternType: 'state-driven',
      preCondition: 'maintenance mode is enabled',
      systemResponse: 'queue the request',
    }),
    fakeAtomize,
  ),
]

/** Two same-trigger requirements with unrelated preconditions ⇒ FND_INCOMPLETE. */
const incompleteSpec = [
  encode(
    view({
      id: 'REQ-P',
      patternType: 'event-driven',
      trigger: 'a request arrives',
      preCondition: 'the cache is warm',
      systemResponse: 'serve from cache',
    }),
    fakeAtomize,
  ),
  encode(
    view({
      id: 'REQ-Q',
      patternType: 'event-driven',
      trigger: 'a request arrives',
      preCondition: 'the quota is available',
      systemResponse: 'serve from origin',
    }),
    fakeAtomize,
  ),
]

/**
 * Two conflicting bounds on ONE quantity in ONE base unit ⇒ a genuine
 * `FND_NUMERIC_CONTRADICTION` (`latency <= 200 ms ∧ latency > 900 ms`). Both are
 * in `ms` on purpose so the pair is comparable and the conflict is real — the
 * point of these tests is to watch a REAL finding be bounded, not to exercise the
 * grouping rules that `numeric-contradiction.test.ts` owns.
 */
const numericSpec = [
  { id: 'REQ-FAST', predicates: extractNumericPredicates('respond within 200 ms', 'api') },
  { id: 'REQ-SLOW', predicates: extractNumericPredicates('respond over 900 ms', 'api') },
]

/**
 * Two same-trigger response obligations at OPPOSITE response polarity:
 * `G(T → F resp)` vs `G(T → F ¬resp)`. These are jointly SATISFIABLE — respond
 * at one step, don't at another — so this fixture measures `sat` and yields NO
 * finding. Its comment used to claim it produced `FND_TEMPORAL_CONTRADICTION`,
 * which it never has (corrected with AC-2-6).
 *
 * It is still the right fixture for these tests, and its behavior must not
 * change: what AC-1-7 pins here is that the temporal tier CONFIGURES its solver
 * and RESPECTS its budget, which needs a spec that reaches the solver at all —
 * not one that proves a conflict. The `sat` verdict is load-bearing for the
 * `unknown`-handling test too (a tier that can only withhold findings must be
 * observed on input where a finding is not owed). Real temporal conflicts, and
 * the AC-2-6 false-positive regressions, live in `temporal.test.ts`.
 *
 * AC-2-7: the `earsToTemporal` calls now pass the shared atomizer (mechanical —
 * the signature gained a required parameter). The fixture's MEANING is unchanged
 * and its `sat` verdict is re-verified: "notify the operator" leads with `notify`,
 * which is in no antonym class, so unification adds nothing here and the pair is
 * still one atom at two polarities across two steps — satisfiable, no finding.
 */
const temporalAtomize = makeAtomize()
const temporalSpec = [
  {
    id: 'REQ-RESPOND',
    formula: earsToTemporal(
      view({
        id: 'REQ-RESPOND',
        patternType: 'event-driven',
        trigger: 'an alarm fires',
        systemResponse: 'notify the operator',
      }) as never,
      temporalAtomize,
    ),
  },
  {
    id: 'REQ-SILENT',
    formula: earsToTemporal(
      view({
        id: 'REQ-SILENT',
        patternType: 'event-driven',
        trigger: 'an alarm fires',
        systemResponse: 'notify the operator',
        negated: true,
      }) as never,
      temporalAtomize,
    ),
  },
]

// ---------------------------------------------------------------------------
// 1. Per-solver timeout is observably applied by EVERY tier in scope
// ---------------------------------------------------------------------------

describe('AC-1-7 — every solver-driving tier applies the per-solver timeout', () => {
  it('subsumption sets timeout on every solver it builds (the O(N²) hot path)', async () => {
    const { ctx, calls, solverCount } = recordingContext(await getContext('budget-sub-timeout'))
    await checkSubsumption(ctx, subsumptionById, subsumptionPairs, { timeoutMs: 4321 })
    // Two `implies` solves per pair, each its own solver, each configured.
    expect(solverCount()).toBe(2)
    expect(timeouts(calls)).toEqual([4321, 4321])
  })

  it('vacuity sets timeout on every per-requirement solver', async () => {
    const { ctx, calls, solverCount } = recordingContext(await getContext('budget-vac-timeout'))
    await checkVacuity(ctx, vacuitySpec, { timeoutMs: 4321 })
    expect(solverCount()).toBeGreaterThan(0)
    expect(timeouts(calls)).toEqual(Array.from({ length: solverCount() }, () => 4321))
  })

  it('incomplete sets timeout on every per-group solver', async () => {
    const { ctx, calls, solverCount } = recordingContext(await getContext('budget-inc-timeout'))
    await checkCompleteness(ctx, incompleteSpec, { timeoutMs: 4321 })
    expect(solverCount()).toBeGreaterThan(0)
    expect(timeouts(calls)).toEqual(Array.from({ length: solverCount() }, () => 4321))
  })

  it('numeric-contradiction sets timeout on the group solver AND every minimizer re-check', async () => {
    const { ctx, calls, solverCount } = recordingContext(await getContext('budget-num-timeout'))
    const findings = await findNumericContradictions(ctx, numericSpec, { timeoutMs: 4321 })
    // The conflict is genuinely proved, so the minimizer runs too — both the
    // main-loop solver (:82) and the minimizer solver (:148) must be bounded.
    expect(findings).toHaveLength(1)
    expect(solverCount()).toBeGreaterThan(0)
    expect(timeouts(calls)).toEqual(Array.from({ length: solverCount() }, () => 4321))
  })

  it('temporal sets timeout on the bounded solver (and thus on minimizer re-checks)', async () => {
    const { ctx, calls, solverCount } = recordingContext(await getContext('budget-tmp-timeout'))
    await findTemporalContradictions(ctx, temporalSpec, 5, { timeoutMs: 4321 })
    expect(solverCount()).toBeGreaterThan(0)
    expect(timeouts(calls)).toEqual(Array.from({ length: solverCount() }, () => 4321))
  })

  it('omitting timeoutMs leaves every solver unconfigured (pre-AC-1-7 behavior preserved)', async () => {
    const { ctx, calls } = recordingContext(await getContext('budget-no-timeout'))
    await checkSubsumption(ctx, subsumptionById, subsumptionPairs)
    await checkVacuity(ctx, vacuitySpec)
    await checkCompleteness(ctx, incompleteSpec)
    await findNumericContradictions(ctx, numericSpec)
    await findTemporalContradictions(ctx, temporalSpec, 5)
    expect(timeouts(calls)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2 + 3. The whole-run budget stops each tier, records it, and does no work
// ---------------------------------------------------------------------------

describe('AC-1-7 — an exhausted whole-run budget stops each tier before any work', () => {
  it('subsumption stops before the first pair and records the unrun pair count', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-sub-stop'))
    const budget = expiredBudget()
    const findings = await checkSubsumption(ctx, subsumptionById, subsumptionPairs, { budget })
    expect(findings).toEqual([])
    // Check-before-work: ZERO solvers constructed, so no pair half-ran.
    expect(solverCount()).toBe(0)
    expect(budget.truncated()).toBe(true)
    expect(budget.skippedBy('subsumption')).toBe(subsumptionPairs.length)
  })

  it('vacuity stops before the first requirement and records the unrun count', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-vac-stop'))
    const budget = expiredBudget()
    expect(await checkVacuity(ctx, vacuitySpec, { budget })).toEqual([])
    expect(solverCount()).toBe(0)
    expect(budget.skippedBy('vacuity')).toBe(vacuitySpec.length)
  })

  it('incomplete stops before the first group and records the unrun group count', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-inc-stop'))
    const budget = expiredBudget()
    expect(await checkCompleteness(ctx, incompleteSpec, { budget })).toEqual([])
    expect(solverCount()).toBe(0)
    expect(budget.skippedBy('incomplete')).toBeGreaterThan(0)
  })

  it('numeric-contradiction stops before the first quantity group, suppressing a REAL conflict', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-num-stop'))
    const budget = expiredBudget()
    // The same input proves a contradiction when the budget is alive (asserted in
    // the timeout suite above). Truncation therefore causes a false NEGATIVE —
    // the honest failure direction — and the recorded truncation is what forces
    // the pipeline to demote `verified` so the miss is never read as a clean run.
    expect(await findNumericContradictions(ctx, numericSpec, { budget })).toEqual([])
    expect(solverCount()).toBe(0)
    expect(budget.skippedBy('numeric-contradiction')).toBeGreaterThan(0)
  })

  it('temporal stops before the whole-spec check and records the requirement count', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-tmp-stop'))
    const budget = expiredBudget()
    expect(await findTemporalContradictions(ctx, temporalSpec, 5, { budget })).toEqual([])
    expect(solverCount()).toBe(0)
    expect(budget.skippedBy('temporal')).toBe(temporalSpec.length)
  })

  it('a budget with time left truncates nothing and changes no verdict', async () => {
    const ctx = await getContext('budget-alive')
    const budget = livingBudget()
    const numeric = await findNumericContradictions(ctx, numericSpec, { budget })
    const subs = await checkSubsumption(ctx, subsumptionById, subsumptionPairs, { budget })
    await checkVacuity(ctx, vacuitySpec, { budget })
    await checkCompleteness(ctx, incompleteSpec, { budget })
    await findTemporalContradictions(ctx, temporalSpec, 5, { budget })
    expect(budget.truncated()).toBe(false)
    expect(budget.truncations()).toEqual([])
    // And the verdicts match the no-bounds run exactly.
    expect(numeric).toEqual(await findNumericContradictions(ctx, numericSpec))
    expect(subs).toEqual(await checkSubsumption(ctx, subsumptionById, subsumptionPairs))
  })
})

// ---------------------------------------------------------------------------
// 4. `unknown` from a per-solver timeout never becomes a finding
// ---------------------------------------------------------------------------

describe('AC-1-7 — a per-solver timeout can only withhold a finding, never create one', () => {
  it('a 1ms timeout never yields MORE findings than the unbounded run, in any tier', async () => {
    const ctx = await getContext('budget-unknown')
    // Each tier's `unknown` branch is the conservative one (subsumption
    // `=== 'unsat'`, vacuity/numeric/temporal `!== 'unsat'`, incomplete
    // `!== 'sat'`), so a timeout-induced `unknown` must never add a finding.
    const tight = { timeoutMs: 1 }
    expect(
      (await checkSubsumption(ctx, subsumptionById, subsumptionPairs, tight)).length,
    ).toBeLessThanOrEqual((await checkSubsumption(ctx, subsumptionById, subsumptionPairs)).length)
    expect((await checkVacuity(ctx, vacuitySpec, tight)).length).toBeLessThanOrEqual(
      (await checkVacuity(ctx, vacuitySpec)).length,
    )
    expect((await checkCompleteness(ctx, incompleteSpec, tight)).length).toBeLessThanOrEqual(
      (await checkCompleteness(ctx, incompleteSpec)).length,
    )
    expect((await findNumericContradictions(ctx, numericSpec, tight)).length).toBeLessThanOrEqual(
      (await findNumericContradictions(ctx, numericSpec)).length,
    )
    expect(
      (await findTemporalContradictions(ctx, temporalSpec, 5, tight)).length,
    ).toBeLessThanOrEqual((await findTemporalContradictions(ctx, temporalSpec, 5)).length)
  })
})

// ---------------------------------------------------------------------------
// 5. The disjoint-atom prune is behavior-preserving, not a soundness trade
// ---------------------------------------------------------------------------

describe('AC-1-7 — the subsumption prune skips only pairs that provably cannot subsume', () => {
  it('a pair sharing no atom is skipped with ZERO solver contact', async () => {
    const { ctx, solverCount } = recordingContext(await getContext('budget-prune-skip'))
    const alpha = encode(
      view({
        id: 'REQ-ALPHA',
        patternType: 'event-driven',
        trigger: 'a shipment is scanned',
        systemResponse: 'update the manifest',
      }),
      fakeAtomize,
    )
    const beta = encode(
      view({
        id: 'REQ-BETA',
        patternType: 'event-driven',
        trigger: 'a refund is authorized',
        systemResponse: 'credit the ledger',
      }),
      fakeAtomize,
    )
    const findings = await checkSubsumption(
      ctx,
      new Map([
        ['REQ-ALPHA', alpha],
        ['REQ-BETA', beta],
      ]),
      [{ a: 'REQ-ALPHA', b: 'REQ-BETA', reason: 'near-duplicate-sentence' }],
    )
    expect(findings).toEqual([])
    expect(solverCount()).toBe(0)
  })

  it('the solver AGREES the skipped pair has no valid implication either way', async () => {
    // The prune's soundness claim, checked against Z3 rather than asserted: two
    // bodies over disjoint atoms can never imply each other, so running the pair
    // through the solver must also produce no finding. If this ever disagreed
    // with the test above, the prune would be unsound.
    const ctx = await getContext('budget-prune-agree')
    const { checkSubsumptionPair } = await import('../subsumption.js')
    const alpha = encode(
      view({
        id: 'REQ-ALPHA',
        patternType: 'event-driven',
        trigger: 'a shipment is scanned',
        systemResponse: 'update the manifest',
      }),
      fakeAtomize,
    )
    const beta = encode(
      view({
        id: 'REQ-BETA',
        patternType: 'event-driven',
        trigger: 'a refund is authorized',
        systemResponse: 'credit the ledger',
      }),
      fakeAtomize,
    )
    expect(await checkSubsumptionPair(ctx, alpha, beta)).toBeUndefined()
    expect(await checkSubsumptionPair(ctx, beta, alpha)).toBeUndefined()
  })

  it('a pair that DOES share an atom still reaches the solver and still fires', async () => {
    // Guards against a prune that silently swallows real findings.
    const ctx = await getContext('budget-prune-keep')
    const findings = await checkSubsumption(ctx, subsumptionById, subsumptionPairs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.code).toBe('FND_SUBSUMPTION')
  })
})

// ---------------------------------------------------------------------------
// 6. SolverBudget's own arithmetic
// ---------------------------------------------------------------------------

describe('SolverBudget', () => {
  it('reports elapsed/remaining from the injected clock and expires only past the budget', () => {
    let t = 1000
    const budget = new SolverBudget(500, { now: () => t })
    expect(budget.budgetMs).toBe(500)
    expect(budget.elapsedMs()).toBe(0)
    expect(budget.remainingMs()).toBe(500)
    expect(budget.expired()).toBe(false)
    t = 1500 // exactly at the budget — not yet past it
    expect(budget.expired()).toBe(false)
    expect(budget.remainingMs()).toBe(0)
    t = 1501
    expect(budget.expired()).toBe(true)
    expect(budget.remainingMs()).toBe(-1)
  })

  it('accumulates truncations per tier', () => {
    const budget = new SolverBudget(1, { now: () => 0 })
    expect(budget.truncated()).toBe(false)
    budget.truncate('subsumption', 12)
    budget.truncate('subsumption', 3)
    budget.truncate('vacuity', 7)
    expect(budget.skippedBy('subsumption')).toBe(15)
    expect(budget.skippedBy('vacuity')).toBe(7)
    expect(budget.skippedBy('temporal')).toBe(0)
    expect(budget.truncations()).toHaveLength(3)
    expect(budget.truncated()).toBe(true)
  })
})
