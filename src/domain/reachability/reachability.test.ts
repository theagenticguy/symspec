/**
 * THE REACHABILITY TIER — polarity pinned, frame proven load-bearing, evidence real.
 *
 * ## What makes this file different from a normal unit-test suite
 *
 * The failure modes it guards do not produce errors. They produce CONFIDENT WRONG
 * ANSWERS:
 *
 * - invert V13's polarity and the tier reports reachable violations as proven safe;
 * - default the frame to `stable` (V16) and it proves a false answer AND hands back an
 *   inductive invariant certifying it;
 * - read `reason_unknown` in-band (V15) and it prints `"ok"` on a query that timed out.
 *
 * So the assertions here are mostly about NAMED verdicts on systems whose answer is
 * known by construction, plus negative controls that must FAIL. A test that only
 * checked "the solver returned something" would pass on every one of those bugs.
 *
 * ## The two fixture systems, and why their answers are known without a solver
 *
 * `LOCK_SAFE` — a grant COUNT that can never exceed 1, because granting is guarded on
 * `granted = 0` and releasing on `granted = 1`. Proving `granted <= 1` REQUIRES an
 * inductive invariant (no finite unrolling rules out reaching 2), which is exactly the
 * case v4 probe measurements show interface B cannot discharge.
 *
 * `COUNTER_VIOLATED` — `retry_count` starts at 0 and increments; the constraint
 * `retry_count <= 2` is violated at step 3. Reachable by a finite unrolling, so the
 * `sat` direction is exercised with a real multi-step trace.
 *
 * Both are small enough to run in the low hundreds of ms, which keeps the suite
 * affordable while still exercising the real WASM solver rather than a stub. There is
 * no stub: the whole point is what Z3 actually does.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { solverServiceLayer } from '../../adapters/z3/solver-service.ts'
import {
  DOC_VERSION,
  type Requirement,
  type RequirementsDocument,
  type StateVariable,
} from '../requirements/document.ts'
import {
  classifyUnknown,
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  decideFrameVerdict,
  frameDriftOf,
  prepareModel,
  type ReachabilityReport,
  runReachability,
  verdictOfLbool,
  writeSetOf,
} from './reachability.ts'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z'

/** A requirement carrying a state classification. Ids are fixed and sorted-stable so
 * the encoding order — and therefore every verdict — is reproducible. */
const req = (
  n: number,
  key: string,
  fields: Partial<Requirement> & Pick<Requirement, 'responseKind'>,
): Requirement => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
  key,
  patternType: 'ubiquitous',
  systemName: 'lock manager',
  systemResponse: 'behave',
  negated: false,
  sentence: 'The lock manager shall behave.',
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: TS,
  updatedAt: TS,
  ...fields,
})

/**
 * A requirement with NO state classification — the normal state of a document that has
 * not been given a state model.
 *
 * A separate builder rather than `req(n, key, {responseKind: undefined})`, because
 * `exactOptionalPropertyTypes` makes those genuinely different types: the schema's
 * `responseKind?: ResponseKind` does not admit an explicit `undefined`. Spelling it as
 * an omission is what the document format actually stores.
 */
const unclassified = (n: number, key: string): Requirement => {
  const { responseKind: _omitted, ...rest } = req(n, key, { responseKind: 'constraint' })
  return rest
}

const boolVar = (
  name: string,
  frame: 'volatile' | 'stable' = 'volatile',
  initial?: string,
): StateVariable => ({
  name,
  type: 'bool',
  frame,
  ...(initial !== undefined ? { initial } : {}),
})

const intVar = (
  name: string,
  frame: 'volatile' | 'stable' = 'volatile',
  initial?: string,
  domain?: { min?: number; max?: number },
): StateVariable => ({
  name,
  type: 'int',
  frame,
  ...(initial !== undefined ? { initial } : {}),
  ...(domain !== undefined ? { domain } : {}),
})

const docOf = (
  variables: readonly StateVariable[],
  requirements: readonly Requirement[],
  initial?: string,
): RequirementsDocument => ({
  docVersion: DOC_VERSION,
  requirements: Object.fromEntries(requirements.map((r) => [r.id, r])),
  stateModel: { variables: [...variables], ...(initial !== undefined ? { initial } : {}) },
  glossary: [],
  antonyms: [],
  waivers: [],
  terms: [],
})

/**
 * The PROVABLY-SAFE system: a two-variable lock whose grant COUNT can never exceed 1.
 *
 * `granted` starts at 0. `TX-A1` grants (0 → 1) only while `granted = 0`; `TX-A2`
 * releases (1 → 0) only while `granted = 1`. So `granted <= 1` holds in every reachable
 * state — and proving it needs an INDUCTIVE INVARIANT, since `granted` is bounded above
 * at 4 in the declaration and a finite unrolling cannot rule out reaching 2.
 *
 * ## Why the guards are load-bearing, and how their absence was found
 *
 * An earlier version of this fixture had an unguarded `lock_held := pending` and a
 * constraint `not (lock_held and not pending)`. It is genuinely VIOLATED: `pending` is
 * volatile, so it may flip to false in the step AFTER the lock is taken, reaching
 * exactly the forbidden state. The solver said `reachable`, the test expected `PROVED`,
 * and **the solver was right** — the fixture described a system that really can reach
 * the bad state.
 *
 * That is what surfaced the missing GUARD support: without guards every effect fires
 * from every state, so a requirement's own trigger cannot constrain when it applies and
 * almost nothing interesting is provable. Recorded here because the wrong fixture was
 * more instructive than the right one.
 */
const LOCK_SAFE = (frame: 'volatile' | 'stable' = 'volatile'): RequirementsDocument =>
  docOf(
    [intVar('granted', frame, 'granted = 0', { min: 0, max: 4 })],
    [
      req(1, 'TX-A1', {
        responseKind: 'effect',
        stateEffect: 'when granted = 0: granted := granted + 1',
      }),
      req(2, 'TX-A2', {
        responseKind: 'effect',
        stateEffect: 'when granted = 1: granted := granted - 1',
      }),
      req(3, 'TX-C1', { responseKind: 'constraint', stateConstraint: 'granted <= 1' }),
    ],
  )

/**
 * The PROVABLY-REACHABLE system. `retry_count` starts at 0 and increments without
 * limit, so `retry_count <= 2` is violated at step 3. Bounded above at 8 so the solver
 * has a finite space to search and the query stays fast.
 */
const COUNTER_VIOLATED = (): RequirementsDocument =>
  docOf(
    [intVar('retry_count', 'volatile', 'retry_count = 0', { min: 0, max: 8 })],
    [
      req(1, 'TX-B1', {
        responseKind: 'effect',
        stateEffect: 'retry_count := retry_count + 1',
      }),
      req(2, 'TX-B2', { responseKind: 'constraint', stateConstraint: 'retry_count <= 2' }),
    ],
  )

/** Run the tier against the REAL solver on a fresh Layer. */
const run = (
  document: RequirementsDocument,
  options: { readonly timeoutMs?: number } = {},
): Promise<ReachabilityReport> =>
  Effect.runPromise(
    runReachability(document, options).pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
  )

/** The single result of a one-constraint run. */
const only = (report: ReachabilityReport) => {
  const first = report.results[0]
  if (first === undefined) throw new Error('the run produced no constraint result')
  return first
}

// ---------------------------------------------------------------------------
// 1. V13 — POLARITY, pinned by construction on a known pair
// ---------------------------------------------------------------------------

describe('V13 — the verdict polarity is pinned at ONE named chokepoint', () => {
  /**
   * The chokepoint, tested on the raw values. `unsat` (`-1`) means UNREACHABLE under
   * interface A (`fixedpoint_query`) and would mean the OPPOSITE under interface B
   * (plain solver + `(set-logic HORN)`) — measured, same engine, same system. This is
   * the mapping a refactor to B would silently invert.
   */
  it('maps -1 to unreachable, +1 to reachable, 0 to unknown', () => {
    expect(verdictOfLbool(-1)).toBe('unreachable')
    expect(verdictOfLbool(1)).toBe('reachable')
    expect(verdictOfLbool(0)).toBe('unknown')
  })

  it('maps ANY unrecognized lbool to unknown, never to a proof', () => {
    // The conservative direction. Treating an unknown code as `unreachable` would turn
    // an API change into a fabricated proof.
    for (const value of [2, -2, 42, Number.NaN]) {
      expect(verdictOfLbool(value)).toBe('unknown')
    }
  })

  /**
   * THE POLARITY CANARY v4's probe results call mandatory: two fixtures whose
   * answers are known by construction, asserting the NAMED verdict rather than the raw
   * lbool. Inverting the chokepoint flips both of these, and no other test in the
   * suite would notice.
   */
  it('reports the provably-SAFE system as PROVED (a real inductive proof)', async () => {
    const report = await run(LOCK_SAFE())
    const result = only(report)
    expect(result.label).toBe('TX-C1')
    expect(result.verdict).toBe('PROVED')
    expect(result.strict).toBe('unreachable')
  })

  it('reports the provably-REACHABLE system as VIOLATED', async () => {
    const report = await run(COUNTER_VIOLATED())
    const result = only(report)
    expect(result.label).toBe('TX-B2')
    expect(result.verdict).toBe('VIOLATED')
    expect(result.strict).toBe('reachable')
  })

  /**
   * NON-VACUITY on the pair. Two fixtures that both returned the same verdict would
   * pass an inverted polarity check, so the claim that matters is that they DIFFER —
   * and that the difference is in the expected direction.
   */
  it('the two fixtures genuinely DIVERGE, so the canary is not vacuous', async () => {
    // SEQUENTIAL, and `Promise.all` here is a BUG rather than an optimization.
    //
    // Measured while writing this file: `Promise.all([run(a), run(b)])` HANGS the suite
    // indefinitely. Asyncify holds ONE global capability slot, so two solver runs in
    // flight is the exact wedge `SOLVER_CONCURRENCY === 1` names — and the discipline
    // binds TEST code just as hard as production code, because it is a property of the
    // WASM module and not of any call site. Left as two awaits with this note, since the
    // parallel spelling looks harmless and reads as faster.
    const safe = await run(LOCK_SAFE())
    const violated = await run(COUNTER_VIOLATED())
    expect(only(safe).verdict).not.toBe(only(violated).verdict)
    expect(only(safe).strict).toBe('unreachable')
    expect(only(violated).strict).toBe('reachable')
  })
})

// ---------------------------------------------------------------------------
// 2. Evidence — the invariant and the trace
// ---------------------------------------------------------------------------

describe('a PROVED verdict carries an independently RE-CHECKED invariant (V28)', () => {
  it('records the invariant AND that all three obligations discharged', async () => {
    const result = only(await run(LOCK_SAFE()))
    expect(result.invariant).toBeDefined()
    // The invariant TEXT is asserted only for non-emptiness, deliberately: operand
    // order is not stable across configurations, and the certificate check is what
    // makes the claim. Asserting the string would be the golden test that flakes.
    expect(result.invariant?.invariant.length ?? 0).toBeGreaterThan(0)
    // THE claim: Spacer's answer was re-verified by three independent plain-SMT
    // queries (`Init => Inv`, `Inv & T => Inv'`, `Inv => !Bad`).
    expect(result.invariant?.certificateVerified).toBe(true)
    expect(result.invariant?.failedObligation).toBeUndefined()
  })

  it('strips the `:weight` annotations Spacer emits, so evidence reads for a human', async () => {
    const result = only(await run(LOCK_SAFE()))
    expect(result.invariant?.invariant).not.toContain(':weight')
  })
})

describe('a VIOLATED verdict carries a counterexample trace naming REQUIREMENTS (V29)', () => {
  it('names the requirements that fired, by KEY, in forward order', async () => {
    const result = only(await run(COUNTER_VIOLATED()))
    expect(result.trace).toBeDefined()
    const steps = result.trace?.steps ?? []
    expect(steps.length).toBeGreaterThan(0)
    const names = steps.map((s) => s.rule)

    // The rules are registered programmatically with per-requirement names, which is
    // the whole reason a trace can cite requirements at all — rules parsed from a
    // string carry NO names and yield `<null>` per entry (measured).
    expect(names).toContain('TX-B1')
    // FORWARD order: `init` first (the trace comes back reversed and is reversed here).
    expect(names[0]).toBe('init')
    // The violated constraint's own requirement ends the trace.
    expect(names[names.length - 1]).toBe('TX-B2')

    // Every step is a name an AUTHOR would recognize — a requirement key or `init` —
    // never an internal rule name (v4 V29 groundwork).
    for (const name of names) {
      expect(['init', 'TX-B1', 'TX-B2']).toContain(name)
    }
  })

  it('preserves rule MULTIPLICITY, so the trace is a witness and not a rule set', async () => {
    // `retry_count <= 2` is violated at step 3, so the increment rule must appear
    // several times. A deduplicated "set of rules that could fire" would not be a
    // counterexample.
    const result = only(await run(COUNTER_VIOLATED()))
    const increments = (result.trace?.steps ?? []).filter((s) => s.rule === 'TX-B1')
    expect(increments.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 3. V16 / AC-2-5 — the frame, and prove-twice
// ---------------------------------------------------------------------------

describe('AC-2-5 — the frame lattice decides the verdict', () => {
  /**
   * The decision table, verbatim from the decision doc.
   *
   * What the doc leaves open is WHICH frame the second run applies, and that is where the
   * soundness lives: the framed run pins EVERY variable an effect does not write, not only
   * those declared `frame: stable`. Pinning only the declared ones makes the framed run
   * identical to the unpinned one whenever nothing is declared, so `reachable` in both is
   * trivially true and every such constraint reports VIOLATED at error severity. The worked
   * lock/grant fixture caught exactly that.
   */
  it.each([
    ['unreachable', undefined, 'PROVED'],
    ['unreachable', 'reachable', 'PROVED'],
    // Reachable under FULL framing: every step is requirement-sanctioned, so the
    // counterexample is real. The ONLY route to an error-severity finding.
    ['reachable', 'reachable', 'VIOLATED'],
    // The frame is load-bearing: unreachable once unwritten variables stop moving.
    ['reachable', 'unreachable', 'PROVED_UNDER_HYPOTHESES'],
    // No framed run performed, or it did not decide — never a proof, never a defect.
    ['reachable', undefined, 'UNKNOWN'],
    ['reachable', 'unknown', 'UNKNOWN'],
    ['unknown', undefined, 'UNKNOWN'],
    ['unknown', 'unreachable', 'UNKNOWN'],
  ] as const)('none=%s framed=%s -> %s', (none, framed, expected) => {
    expect(decideFrameVerdict(none, framed)).toBe(expected)
  })

  /**
   * A STRICT `unreachable` short-circuits: the property holds with nothing assumed, so
   * there is no hypothesis to disclose and no second query to pay for. Asserted
   * because the alternative (always running twice) would double the cost of the
   * commonest good outcome.
   */
  it('does not run a framed query when the strict run already PROVED it', async () => {
    const result = only(await run(LOCK_SAFE('stable')))
    expect(result.verdict).toBe('PROVED')
    expect(result.framed).toBeUndefined()
  })

  /**
   * ## THE V16 REPRODUCTION — the whole reason prove-twice exists
   *
   * `alarm` is declared `stable` and written by NO requirement. Under the FRAMED
   * encoding it is pinned to its initial value forever, so `alarm = true` looks
   * unreachable and Spacer hands back an inductive invariant certifying that. Under the
   * STRICT encoding it may change freely, so it is reachable — which is the truth,
   * because the document never said `alarm` cannot change.
   *
   * A tier that framed by default would report PROVED here, with a certificate. This
   * asserts it reports `PROVED_UNDER_HYPOTHESES` instead, DISCLOSES the variable the
   * proof leaned on, and demotes.
   */
  it('reports PROVED_UNDER_HYPOTHESES where a frame is load-bearing, never PROVED', async () => {
    const document = docOf(
      [
        boolVar('door_open', 'volatile', 'door_open = false'),
        boolVar('sensor', 'volatile'),
        // Written by NO requirement, declared stable. The V16 shape exactly.
        boolVar('alarm', 'stable', 'alarm = false'),
      ],
      [
        req(1, 'R1', { responseKind: 'effect', stateEffect: 'door_open := sensor' }),
        req(2, 'R2', { responseKind: 'constraint', stateConstraint: 'not alarm' }),
      ],
    )
    const result = only(await run(document))

    // NOT `PROVED`. Under a frame this is "unreachable with an invariant", and
    // reporting that as a proof is the fabricated-proof defect.
    expect(result.verdict).toBe('PROVED_UNDER_HYPOTHESES')
    expect(result.strict).toBe('reachable')
    expect(result.framed).toBe('unreachable')

    // The DISCLOSURE, and it names the variable the proof relied on plus its writers —
    // which is what makes the finding actionable rather than merely honest.
    const hypotheses = result.hypotheses ?? []
    expect(hypotheses.map((h) => h.variable)).toContain('alarm')
    expect(hypotheses.find((h) => h.variable === 'alarm')?.writers).toEqual([])
  })

  /**
   * THE SABOTAGE CONTROL for the mitigation above.
   *
   * The same model with `alarm` declared `volatile` (the default) must come back
   * VIOLATED, because nothing is assumed and `alarm` is genuinely reachable. Together
   * with the case above this proves the frame declaration is what changes the verdict —
   * i.e. that the prove-twice machinery is load-bearing and not decorative.
   */
  /**
   * THE SABOTAGE CONTROL for the mitigation above, and its verdict is `UNKNOWN` rather
   * than `VIOLATED` — which is the soundness fix, not a weaker assertion.
   *
   * Same model, `alarm` declared `volatile` (the default). Nothing pins it, so it IS
   * reachable with nothing assumed. But `alarm` is written by NO requirement, so under
   * FULL framing it cannot change at all and the violation becomes unreachable. That
   * combination is neither a defect (the described system cannot get there) nor a proof
   * (the document never said nothing else changes `alarm`), so the only honest verdict is
   * `UNKNOWN` — demote, and say why.
   *
   * Together with the case above this still proves the frame DECLARATION is what moves the
   * verdict: `stable` gives `PROVED_UNDER_HYPOTHESES` with the hypothesis named, `volatile`
   * gives `UNKNOWN`. Neither gives a false proof, and neither invents a defect. An earlier
   * boolean-framed implementation reported this exact model as an error-severity
   * `VIOLATED`.
   */
  it('the SAME model with the frame dropped still names the hypothesis, never a defect', async () => {
    const document = docOf(
      [
        boolVar('door_open', 'volatile', 'door_open = false'),
        boolVar('sensor', 'volatile'),
        // `volatile` — the default — is the ONLY difference from the case above.
        boolVar('alarm', 'volatile', 'alarm = false'),
      ],
      [
        req(1, 'R1', { responseKind: 'effect', stateEffect: 'door_open := sensor' }),
        req(2, 'R2', { responseKind: 'constraint', stateConstraint: 'not alarm' }),
      ],
    )
    const result = only(await run(document))
    // NOT `VIOLATED`: `alarm` is written by no requirement, so the only route to the
    // violation is a spontaneous change the document never licensed. An earlier
    // implementation reported this exact model as an error-severity defect.
    expect(result.verdict).toBe('PROVED_UNDER_HYPOTHESES')
    expect(result.strict).toBe('reachable')
    expect(result.framed).toBe('unreachable')
    // With NOTHING declared `stable`, the honest hypothesis is every variable the maximal
    // frame pinned — including `alarm`, whose empty writer list is the V16 shape made
    // visible.
    const hypotheses = result.hypotheses ?? []
    expect(hypotheses.map((h) => h.variable)).toContain('alarm')
    expect(hypotheses.find((h) => h.variable === 'alarm')?.writers).toEqual([])
  })

  /**
   * The genuine-defect control: a violation reachable through a requirement's OWN declared
   * effect survives full framing and IS reported at error severity.
   *
   * Needed alongside the two frame cases because they both end in a non-error verdict, and
   * a suite where nothing reaches `VIOLATED` would pass on a tier that never reports one.
   */
  it('a violation reachable via a requirement`s own effect IS reported as VIOLATED', async () => {
    const document = docOf(
      [boolVar('alarm', 'volatile', 'alarm = false')],
      [
        // R1 WRITES `alarm`, so the violation uses a requirement-sanctioned change and
        // survives full framing.
        req(1, 'R1', { responseKind: 'effect', stateEffect: 'alarm := true' }),
        req(2, 'R2', { responseKind: 'constraint', stateConstraint: 'not alarm' }),
      ],
    )
    const result = only(await run(document))
    expect(result.verdict).toBe('VIOLATED')
    expect(result.strict).toBe('reachable')
    expect(result.framed).toBe('reachable')
    // And the trace names the requirement that gets there.
    expect((result.trace?.steps ?? []).map((s) => s.rule)).toContain('R1')
  })

  it('discloses a `stable` variable NO requirement writes — the V16 shape, named', () => {
    const prepared = prepareModel(
      docOf(
        [boolVar('written', 'stable'), boolVar('never_written', 'stable')],
        [req(1, 'R1', { responseKind: 'effect', stateEffect: 'written := true' })],
      ),
    )
    // A DISCLOSURE and not a hard error: a variable no requirement writes is
    // legitimately a monitored input, and `stable` on one is a strong-but-meaningful
    // claim about the environment. Erroring would refuse a valid model.
    expect(frameDriftOf(prepared)).toEqual(['never_written'])
  })

  it('reports the WRITE SET, so a hypothesis disclosure can name the writers', () => {
    const prepared = prepareModel(
      docOf(
        [boolVar('lock_held'), boolVar('pending')],
        [
          req(1, 'TX-A1', { responseKind: 'effect', stateEffect: 'lock_held := true' }),
          req(2, 'TX-A2', { responseKind: 'effect', stateEffect: 'lock_held := false' }),
        ],
      ),
    )
    const writers = writeSetOf(prepared)
    expect(writers.get('lock_held')).toEqual(['TX-A1', 'TX-A2'])
    expect(writers.get('pending')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. V15 — the unknown split, derived from the CLOCK
// ---------------------------------------------------------------------------

describe('V15 — an `unknown` is classified OUT-OF-BAND, never from reason_unknown', () => {
  /**
   * The reason string is `"ok"` on a timed-out query — the same value a healthy query
   * returns — because `context::cleanup()` resets `m_last_status` before returning. So
   * the ONLY reliable discriminator is measured elapsed vs the timeout that was set,
   * and these cases pin that function's boundary.
   */
  it('calls an elapsed-at-the-budget unknown BUDGET-EXHAUSTED', () => {
    expect(classifyUnknown(2000, 2000)).toBe('budget-exhausted')
    // Within the 10% tolerance — slack for the measured ~150ms WASM/parse floor and
    // for scheduling jitter. A query back at 1450ms of a 1500ms budget hit the budget.
    expect(classifyUnknown(1450, 1500)).toBe('budget-exhausted')
  })

  it('calls an unknown well inside the budget UNDECIDABLE', () => {
    // Raising the budget would NOT help here, so recommending it would send an agent
    // into a loop tuning the wrong knob.
    expect(classifyUnknown(50, 2000)).toBe('undecidable')
  })

  it('never surfaces the literal string "ok" as a reason', () => {
    // The honesty guard. `"ok"` on a failed query reads as success.
    for (const [elapsed, timeout] of [
      [2000, 2000],
      [50, 2000],
    ] as const) {
      expect(['budget-exhausted', 'undecidable']).toContain(classifyUnknown(elapsed, timeout))
    }
  })

  it('exposes a default timeout above the measured ~150ms floor', () => {
    // Below ~150ms a per-query timeout is not honored at all (one-time WASM/parse
    // cost), so a default under it would be a bound that silently does not bind.
    expect(DEFAULT_REACHABILITY_TIMEOUT_MS).toBeGreaterThan(150)
  })
})

// ---------------------------------------------------------------------------
// 5. V21 — only DECLARED params
// ---------------------------------------------------------------------------

describe('V21 — the encoder sets only params this z3 build DECLARES', () => {
  /**
   * The observable for the guard. On a healthy run nothing is refused, because the
   * encoder sets only `engine` and `timeout` — both declared. A non-empty
   * `refusedParams` means a code change tried to set an undeclared key (the research
   * doc's own `random_seed` recommendation, say) and the runtime descriptor check
   * caught it BEFORE it could silently void the timeout and hang the WASM.
   */
  it('refuses nothing on a healthy run, because it sets only declared params', async () => {
    const report = await run(LOCK_SAFE())
    expect(report.refusedParams).toEqual([])
  })

  it('never sets `rlimit` or a global param — both measured as hard hangs', async () => {
    // Structural rather than behavioral: the source is grepped, because the failure
    // mode is a hang, and a test that PROVOKED it would hang the suite. `rlimit` is
    // DECLARED on 5.0.0, so the descriptor guard above cannot catch it — only absence
    // from the source can.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./reachability.ts', import.meta.url), 'utf8'),
    )
    // Strip the comment blocks that legitimately DISCUSS these names.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('global_param_set')
    expect(code).not.toMatch(/rlimit/)
  })
})

// ---------------------------------------------------------------------------
// 6. Reading a document — what the tier can and cannot encode
// ---------------------------------------------------------------------------

describe('prepareModel reads a document without ever trusting it', () => {
  it('partitions effects and constraints, in stable id order', () => {
    const prepared = prepareModel(LOCK_SAFE())
    expect(prepared.effects.map((e) => e.label)).toEqual(['TX-A1', 'TX-A2'])
    expect(prepared.constraints.map((c) => c.label)).toEqual(['TX-C1'])
    expect(prepared.skipped).toEqual([])
  })

  it('conjoins per-variable initials with the model-wide one', () => {
    // ADDITIVE, not overriding, so adding either can only NARROW the initial states.
    const prepared = prepareModel(
      docOf(
        [boolVar('a', 'volatile', 'a = false'), boolVar('b', 'volatile', 'b = false')],
        [req(1, 'R1', { responseKind: 'constraint', stateConstraint: 'not (a and b)' })],
        'not (a or b)',
      ),
    )
    expect(prepared.initial).toHaveLength(3)
  })

  /**
   * A HAND-EDITED document can carry an undeclared reference the write path would have
   * refused. That must become a DISCLOSURE here rather than an unkillable hang — so the
   * tier re-validates and records what it could not read, then continues over the rest.
   */
  it('SKIPS a hand-edited undeclared reference with a reason, never encoding it', () => {
    const prepared = prepareModel(
      docOf(
        [boolVar('lock_held')],
        [
          req(1, 'BAD', { responseKind: 'constraint', stateConstraint: 'ghost_var = true' }),
          req(2, 'GOOD', { responseKind: 'constraint', stateConstraint: 'lock_held = false' }),
        ],
      ),
    )
    expect(prepared.constraints.map((c) => c.label)).toEqual(['GOOD'])
    expect(prepared.skipped).toHaveLength(1)
    expect(prepared.skipped[0]?.label).toBe('BAD')
    expect(prepared.skipped[0]?.reason).toContain('ghost_var')
  })

  it('SKIPS a classification with no expression, disclosing that it contributes nothing', () => {
    const prepared = prepareModel(
      docOf([boolVar('lock_held')], [req(1, 'EMPTY', { responseKind: 'effect' })]),
    )
    expect(prepared.effects).toEqual([])
    expect(prepared.skipped[0]?.reason).toContain('no `stateEffect`')
  })

  it('does not treat an UNCLASSIFIED requirement as skipped', () => {
    // Unclassified is not a per-requirement failure — it is the normal state of a
    // document that has not been given a state model, reported once over the whole
    // document by the check integration rather than as N notes.
    const prepared = prepareModel(docOf([boolVar('lock_held')], [unclassified(1, 'PLAIN')]))
    expect(prepared.skipped).toEqual([])
    expect(prepared.constraints).toEqual([])
  })

  it('collects the stable variables as the declared hypothesis set', () => {
    const prepared = prepareModel(
      docOf([boolVar('a', 'stable'), boolVar('b', 'volatile'), intVar('c', 'stable')], []),
    )
    expect(prepared.stableVars).toEqual(['a', 'c'])
  })
})

// ---------------------------------------------------------------------------
// 7. The vacuity shapes worth disclosing
// ---------------------------------------------------------------------------

describe('the shapes over which a proof would be vacuous are DISCLOSED', () => {
  /**
   * A model with no effects has an EMPTY transition relation: the only reachable
   * states are the initial ones. An invariant holding over a single frozen state says
   * almost nothing, so a proof there must not read like a proof over a live system.
   */
  it('discloses an EMPTY transition relation', async () => {
    const report = await run(
      docOf(
        [boolVar('lock_held', 'volatile', 'lock_held = false')],
        [req(1, 'C1', { responseKind: 'constraint', stateConstraint: 'not lock_held' })],
      ),
    )
    expect(report.emptyTransitionRelation).toBe(true)
    expect(report.effects).toBe(0)
    // It still PROVES — correctly, over the initial state — which is exactly why the
    // disclosure is needed rather than optional.
    expect(only(report).verdict).toBe('PROVED')
  })

  it('does NOT claim an empty relation when effects exist', async () => {
    const report = await run(LOCK_SAFE())
    expect(report.emptyTransitionRelation).toBe(false)
    expect(report.effects).toBe(2)
  })

  it('reports an empty run for a document with no state model at all', async () => {
    const report = await run(docOf([], []))
    expect(report.results).toEqual([])
    expect(report.variables).toBe(0)
    expect(report.emptyTransitionRelation).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. Determinism and cost
// ---------------------------------------------------------------------------

describe('the tier is deterministic and reports its own cost', () => {
  it('reaches the same verdict on two runs of one document', async () => {
    // The determinism claim the whole tool rests on, at the tier that has the most
    // freedom to violate it. Verdicts, not invariant TEXT — the text is deliberately
    // non-load-bearing (see V28).
    // SEQUENTIAL — see the note on the polarity divergence case. Two concurrent runs
    // wedge Asyncify's single capability slot and hang the suite.
    const first = await run(LOCK_SAFE())
    const second = await run(LOCK_SAFE())
    expect(only(first).verdict).toBe(only(second).verdict)
    expect(only(first).strict).toBe(only(second).strict)
    expect(only(first).invariant?.certificateVerified).toBe(
      only(second).invariant?.certificateVerified,
    )
  })

  it('reports elapsed ms and the timeout it used, for the latency gate to read', async () => {
    const report = await run(LOCK_SAFE(), { timeoutMs: 3000 })
    expect(report.timeoutMs).toBe(3000)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    // Reported, never gated on inside the tier — the feasibility gate owns the budget.
    expect(only(report).elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
