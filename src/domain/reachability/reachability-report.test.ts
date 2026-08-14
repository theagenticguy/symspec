/**
 * THE PROJECTION — every reachability verdict's finding, demotion, and repair.
 *
 * Pure: `projectReachability` is a function of a `ReachabilityReport`, so every rule here
 * is asserted WITHOUT booting Z3. That is the whole reason the projection is a separate
 * module from the tier — the solver-backed cases in `reachability.test.ts` are slow and
 * few, and these are fast and exhaustive.
 *
 * ## What is actually being guarded
 *
 * The demotion-only doctrine, and the honesty of the prose. Specifically:
 *
 * - `PROVED` is the ONLY verdict that adds no demotion, which is the mechanism by which
 *   `verified` may stay true. Every other verdict must demote, and a missing demotion is
 *   how a tool starts certifying things it did not establish.
 * - `FND_REACHABILITY_VIOLATED` is the ONLY error-severity code, so it is the only one
 *   that can fail a build.
 * - a proof that did not re-verify is reported as UNKNOWN and never as a proof.
 * - the "silence made visible" disclosure fires whenever coverage is partial, because a
 *   question never asked reads exactly like a question answered cleanly.
 */

import { describe, expect, it } from 'vitest'
import type { ConstraintResult, ReachabilityReport } from './reachability.ts'
import { REACHABILITY_FND_CODES } from './reachability-codes.ts'
import { projectReachability, REACHABILITY_DEMOTION_REASONS } from './reachability-report.ts'

const DOC = './requirements.json'

/** A report with sensible defaults, so each case states only what it is about. */
const reportOf = (over: Partial<ReachabilityReport> = {}): ReachabilityReport => ({
  results: [],
  skipped: [],
  effects: 1,
  variables: 1,
  frameDrift: [],
  emptyTransitionRelation: false,
  // The DEFAULT is the healthy model: an initial state exists. Spelled out rather than
  // left off so a case about vacuity has to say so, and so every existing case is
  // explicitly a non-vacuous one.
  vacuousInitialState: false,
  initialPredicates: [],
  refusedParams: [],
  elapsedMs: 10,
  timeoutMs: 2000,
  ...over,
})

/** One constraint result, defaulted to the PROVED shape. */
const resultOf = (over: Partial<ConstraintResult> = {}): ConstraintResult => ({
  label: 'TX-C1',
  requirementId: 'aaaaaaaa-0000-4000-8000-000000000001',
  verdict: 'PROVED',
  strict: 'unreachable',
  invariant: { invariant: '(<= granted 1)', certificateVerified: true },
  elapsedMs: 10,
  refusedParams: [],
  ...over,
})

const codesOf = (report: ReachabilityReport) =>
  projectReachability(report, DOC).findings.map((f) => f.code)

const reasonsOf = (report: ReachabilityReport) =>
  projectReachability(report, DOC).demotions.map((d) => d.reason)

// ---------------------------------------------------------------------------
// 1. The demotion-only doctrine
// ---------------------------------------------------------------------------

describe('the tier may DEMOTE and may never promote', () => {
  it('PROVED adds a finding and NO demotion — the only verdict that does not demote', () => {
    // The absence IS the mechanism: `verified = demotions.length === 0`, so a demotion
    // here would make an unconditional proof unable to certify anything.
    const report = reportOf({ results: [resultOf()] })
    expect(codesOf(report)).toEqual(['FND_REACHABILITY_PROVED'])
    expect(reasonsOf(report)).toEqual([])
  })

  /**
   * The verdicts that mean "I could not establish this" demote. Note which one does NOT:
   * `VIOLATED` — see the case below.
   */
  it.each([
    [
      'PROVED_UNDER_HYPOTHESES',
      {
        verdict: 'PROVED_UNDER_HYPOTHESES',
        strict: 'reachable',
        framed: 'unreachable',
        hypotheses: [{ variable: 'granted', writers: ['TX-A1'] }],
      },
    ],
    ['UNKNOWN', { verdict: 'UNKNOWN', strict: 'unknown', unknownReason: 'undecidable' }],
  ] as const)('%s DEMOTES, because the tier could not establish the property', (_label, over) => {
    const report = reportOf({ results: [resultOf(over as Partial<ConstraintResult>)] })
    expect(reasonsOf(report).length).toBeGreaterThan(0)
  })

  /**
   * VIOLATED does NOT demote, and that is v4's semantics rather than an omission.
   *
   * `verified` answers "did the tool COMPARE enough to certify?", not "is the document
   * good". A proven contradiction is an ERROR FINDING — the tool worked, the spec failed —
   * and v4 treats it exactly this way: `FND_CONTRADICTION` pushes no demotion, and
   * the exit contract maps an error-severity finding to exit 1 independently of
   * `verified`. Adding a demotion here would conflate "I could not check" with "I checked
   * and found a defect", which is the 1-vs-3 distinction the exit codes exist to make.
   *
   * Asserted explicitly because the first version of this suite expected the opposite, and
   * a demotion added to satisfy that wrong expectation would have quietly changed what
   * `verified` means.
   */
  it('VIOLATED does NOT demote — it is an error FINDING, which is a different signal', () => {
    const report = reportOf({
      results: [
        resultOf({
          verdict: 'VIOLATED',
          strict: 'reachable',
          framed: 'reachable',
          trace: { steps: [{ rule: 'init' }, { rule: 'TX-A1' }] },
        }),
      ],
    })
    expect(reasonsOf(report)).toEqual([])
    // The signal is the severity, which drives exit 1 through the existing contract.
    expect(projectReachability(report, DOC).findings[0]?.severity).toBe('error')
  })

  it('every demotion reason it emits is in the CLOSED published list', () => {
    // So `check`'s mapping can be exhaustive over them, and so a new reason cannot reach
    // an agent as a string nothing documents.
    const reports = [
      reportOf({
        results: [resultOf({ verdict: 'VIOLATED', strict: 'reachable', framed: 'reachable' })],
      }),
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [{ variable: 'x', writers: [] }],
          }),
        ],
      }),
      reportOf({
        results: [
          resultOf({ verdict: 'UNKNOWN', unknownReason: 'budget-exhausted', elapsedMs: 2000 }),
        ],
      }),
      reportOf({ results: [resultOf({ verdict: 'UNKNOWN', unknownReason: 'undecidable' })] }),
      reportOf({ variables: 0 }),
    ]
    for (const report of reports) {
      for (const reason of reasonsOf(report)) {
        expect(REACHABILITY_DEMOTION_REASONS as readonly string[]).toContain(reason)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Severity — only ONE code can fail a build
// ---------------------------------------------------------------------------

describe('only a genuine violation reaches error severity', () => {
  it('VIOLATED is error-severity and carries the trace as evidence', () => {
    const projection = projectReachability(
      reportOf({
        results: [
          resultOf({
            verdict: 'VIOLATED',
            strict: 'reachable',
            framed: 'reachable',
            trace: { steps: [{ rule: 'init' }, { rule: 'TX-A1' }, { rule: 'TX-C1' }] },
          }),
        ],
      }),
      DOC,
    )
    const finding = projection.findings[0]
    expect(finding?.code).toBe('FND_REACHABILITY_VIOLATED')
    expect(finding?.severity).toBe('error')
    // The trace is the evidence, and it reads as a PATH — requirement keys, in order.
    expect(finding?.message).toContain('init -> TX-A1 -> TX-C1')
    expect(finding?.evidence?.trace).toEqual(['init', 'TX-A1', 'TX-C1'])
  })

  it('the VIOLATED message does NOT claim declared frames when none were declared', () => {
    // An earlier version said "reachable with the declared frames as well as without
    // them" on every violation, including documents that declared no frame at all. The
    // claim has to describe the run that was actually performed.
    const finding = projectReachability(
      reportOf({
        results: [resultOf({ verdict: 'VIOLATED', strict: 'reachable', framed: 'reachable' })],
      }),
      DOC,
    ).findings[0]
    expect(finding?.message).not.toContain('declared frames')
    // What it says instead is the property that makes the trace trustworthy.
    expect(finding?.message).toContain('every variable no effect writes')
  })

  it('every OTHER reachability code is info — "cannot decide" must not fail a build', () => {
    const nonError = REACHABILITY_FND_CODES.filter((c) => c !== 'FND_REACHABILITY_VIOLATED')
    const reports = [
      reportOf({ results: [resultOf()] }),
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [{ variable: 'x', writers: [] }],
          }),
        ],
      }),
      reportOf({ results: [resultOf({ verdict: 'UNKNOWN', unknownReason: 'undecidable' })] }),
      reportOf({ variables: 0 }),
    ]
    for (const report of reports) {
      for (const finding of projectReachability(report, DOC).findings) {
        if ((nonError as readonly string[]).includes(finding.code)) {
          expect(finding.severity, `${finding.code} must be info`).toBe('info')
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. A proof that did not re-verify is NOT a proof
// ---------------------------------------------------------------------------

describe('an answer that failed its certificate check is reported as UNKNOWN', () => {
  /**
   * The contract is "never report proven unless it is proven", so a `PROVED` verdict whose
   * three obligations did not discharge must not become a weaker proof — there is no
   * "proved but unchecked" rung on the ladder. It becomes UNKNOWN, and demotes.
   */
  it('downgrades to UNKNOWN, names the failed obligation, and DEMOTES', () => {
    const projection = projectReachability(
      reportOf({
        results: [
          resultOf({
            invariant: {
              invariant: '(<= granted 1)',
              certificateVerified: false,
              failedObligation: 'Inv => !Bad',
            },
          }),
        ],
      }),
      DOC,
    )
    const finding = projection.findings[0]
    expect(finding?.code).toBe('FND_REACHABILITY_UNKNOWN')
    expect(finding?.message).toContain('did NOT independently re-verify')
    expect(finding?.message).toContain('Inv => !Bad')
    // And it is honest about whose fault it is.
    expect(finding?.message).toContain('tool-level failure')
    expect(projection.demotions).toHaveLength(1)
  })

  it('a VERIFIED certificate is stated positively, so a reader can rely on the proof', () => {
    const finding = projectReachability(reportOf({ results: [resultOf()] }), DOC).findings[0]
    expect(finding?.code).toBe('FND_REACHABILITY_PROVED')
    expect(finding?.evidence?.certificateVerified).toBe(true)
    expect(finding?.message).toContain('re-verified')
  })
})

// ---------------------------------------------------------------------------
// 4. The hypothesis disclosure
// ---------------------------------------------------------------------------

describe('PROVED_UNDER_HYPOTHESES discloses what the proof leaned on', () => {
  it('names each variable WITH its writers, so the disclosure is actionable', () => {
    const projection = projectReachability(
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [
              { variable: 'granted', writers: ['TX-A1', 'TX-A2'] },
              { variable: 'alarm', writers: [] },
            ],
          }),
        ],
      }),
      DOC,
    )
    const finding = projection.findings[0]
    expect(finding?.message).toContain('granted (written by TX-A1, TX-A2)')
    // A variable NO requirement writes is the sharpest V16 case, and it says so rather
    // than printing an empty list.
    expect(finding?.message).toContain('alarm (written by NO requirement)')
  })

  it('states what the proof does NOT entail, in the same breath', () => {
    // The decision doc's required wording shape (Kind2's rhetorical move, shipped by
    // SPARK/GNATprove): never "P is unreachable" full stop.
    const finding = projectReachability(
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [{ variable: 'granted', writers: ['TX-A1'] }],
          }),
        ],
      }),
      DOC,
    ).findings[0]
    expect(finding?.message).toContain('THE DOCUMENT DOES NOT STATE THAT')
    expect(finding?.message).toContain('IS violable')
    expect(finding?.message).toContain('demoted')
  })

  it('offers RELEASING the frame as the mechanical repair', () => {
    // The one discharge that is mechanical. The other — author the requirements that
    // justify the assumption — is content this must never invent.
    const demotion = projectReachability(
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [{ variable: 'granted', writers: ['TX-A1'] }],
          }),
        ],
      }),
      DOC,
    ).demotions[0]
    expect(demotion?.reason).toBe('reachability-frame-relied-upon')
    expect(demotion?.repair?.ops).toEqual([
      { op: 'state', name: 'granted', type: 'bool', frame: 'volatile' },
    ])
  })
})

// ---------------------------------------------------------------------------
// 5. The unknown split — different causes, different remedies
// ---------------------------------------------------------------------------

describe('an unknown names its cause and recommends the RIGHT knob', () => {
  it('budget exhaustion recommends raising the timeout', () => {
    const projection = projectReachability(
      reportOf({
        timeoutMs: 2000,
        results: [
          resultOf({ verdict: 'UNKNOWN', unknownReason: 'budget-exhausted', elapsedMs: 2000 }),
        ],
      }),
      DOC,
    )
    expect(projection.findings[0]?.message).toContain('budget was exhausted')
    expect(projection.demotions[0]?.reason).toBe('reachability-budget-exhausted')
    // 4x rather than 2x: a bound that failed at N rarely succeeds at N+epsilon, and each
    // retry pays the full truncated cost.
    //
    // And it names the TIER'S OWN flag (G5), not the shared `--timeout-ms`: raising the
    // shared knob 4x to decide one fixedpoint query would also hand seven per-pair
    // propositional solvers 4x the rope, which is a different change to the run than the
    // one the demotion is asking for.
    expect(projection.demotions[0]?.repair?.commands?.[0]).toContain(
      '--reachability-timeout-ms 8000',
    )
    expect(projection.demotions[0]?.repair?.commands?.[0]).not.toMatch(
      /(?<!reachability-)--timeout-ms/,
    )
    expect(projection.demotions[0]?.action).toContain('--reachability-timeout-ms 8000')
  })

  it('undecidability says raising the budget will NOT help', () => {
    // The distinction that matters: recommending a bigger budget for an undecidable model
    // sends an agent into a loop tuning the wrong knob.
    const projection = projectReachability(
      reportOf({
        results: [resultOf({ verdict: 'UNKNOWN', unknownReason: 'undecidable', elapsedMs: 40 })],
      }),
      DOC,
    )
    expect(projection.findings[0]?.message).toContain('will NOT help')
    expect(projection.demotions[0]?.reason).toBe('reachability-undecidable')
    expect(projection.demotions[0]?.action).toContain('--min')
  })

  it('NEVER surfaces the solver`s own reason string', () => {
    // A timed-out Spacer query reports `reason_unknown === "ok"`, which would read as
    // success on a failed query.
    for (const reason of ['budget-exhausted', 'undecidable'] as const) {
      const projection = projectReachability(
        reportOf({ results: [resultOf({ verdict: 'UNKNOWN', unknownReason: reason })] }),
        DOC,
      )
      expect(JSON.stringify(projection)).not.toContain('"ok"')
    }
  })
})

// ---------------------------------------------------------------------------
// 6. "Silence made visible" — the coverage disclosure
// ---------------------------------------------------------------------------

describe('partial coverage is DISCLOSED, in the FND_NO_PAIRS_CHECKED tradition', () => {
  it('no state model at all: discloses it and names the DECLARING command', () => {
    const projection = projectReachability(reportOf({ variables: 0, effects: 0 }), DOC)
    expect(projection.findings.map((f) => f.code)).toEqual(['FND_REACHABILITY_NOT_CHECKED'])
    expect(projection.findings[0]?.message).toContain('no state model is committed')
    expect(projection.demotions[0]?.reason).toBe('reachability-not-checked')
    // The repair names `state`, because that is what is missing.
    expect(projection.demotions[0]?.repair?.commands?.join(' ')).toContain('symspec state')
  })

  it('variables but no constraints: names the CLASSIFY command instead', () => {
    // The commonest half-authored state: declaring variables is the easy half. Naming
    // the wrong command here would send an agent confidently nowhere — the failure mode
    // v4's `<blocking-code>` placeholder had.
    const projection = projectReachability(reportOf({ variables: 2, results: [] }), DOC)
    expect(projection.findings[0]?.message).toContain('NO requirement carries a')
    expect(projection.demotions[0]?.repair?.commands?.join(' ')).toContain('symspec classify')
  })

  it('an EMPTY transition relation is disclosed as near-vacuous', () => {
    // Only the initial state is reachable, so an invariant holding there is not evidence
    // about a running system. Without this the report reads like a real proof.
    const projection = projectReachability(
      reportOf({ variables: 1, effects: 0, emptyTransitionRelation: true, results: [resultOf()] }),
      DOC,
    )
    const disclosure = projection.findings.find((f) => f.code === 'FND_REACHABILITY_NOT_CHECKED')
    expect(disclosure?.message).toContain('NO transitions')
    expect(disclosure?.message).toContain('vacuously')
  })

  it('a SKIPPED requirement is named with its reason, never silently dropped', () => {
    // A hand-edited document can carry an undeclared reference the write path refuses.
    // That must surface as a disclosure rather than as a quietly smaller run.
    const projection = projectReachability(
      reportOf({
        results: [resultOf()],
        skipped: [
          { label: 'BAD', reason: 'its constraint did not validate: "ghost" is not declared' },
        ],
      }),
      DOC,
    )
    const disclosure = projection.findings.find((f) => f.code === 'FND_REACHABILITY_NOT_CHECKED')
    expect(disclosure?.message).toContain('BAD')
    expect(disclosure?.message).toContain('ghost')
  })

  it('a FULLY covered run emits NO disclosure and NO demotion', () => {
    // The other half of the claim: the disclosure must be absent when it would be false,
    // or it becomes noise a reader learns to skip.
    const projection = projectReachability(
      reportOf({ variables: 1, effects: 1, results: [resultOf()] }),
      DOC,
    )
    expect(projection.findings.map((f) => f.code)).toEqual(['FND_REACHABILITY_PROVED'])
    expect(projection.demotions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 7. Frame drift — the V16 declaration named
// ---------------------------------------------------------------------------

describe('a `stable` variable nothing writes is named', () => {
  it('discloses the drifting variables, with releasing the frame as the repair', () => {
    const projection = projectReachability(
      reportOf({ results: [resultOf()], frameDrift: ['alarm'] }),
      DOC,
    )
    const drift = projection.findings.find((f) => f.message.includes('frame: stable'))
    expect(drift?.message).toContain('alarm')
    expect(drift?.message).toContain('NO requirement')
    expect(drift?.repair?.ops).toEqual([
      { op: 'state', name: 'alarm', type: 'bool', frame: 'volatile' },
    ])
  })

  it('does NOT demote on drift alone — prove-twice already prevents the false proof', () => {
    // A variable nothing writes is legitimately a monitored input, so `stable` on one is
    // a strong-but-meaningful claim. Quint hard-errors here; that would refuse a valid
    // model, so this discloses instead.
    const projection = projectReachability(
      reportOf({ variables: 1, effects: 1, results: [resultOf()], frameDrift: ['alarm'] }),
      DOC,
    )
    expect(projection.demotions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8. Every repair is runnable
// ---------------------------------------------------------------------------

describe('every emitted repair is runnable rather than a placeholder to parse', () => {
  it('carries no unresolved `<blocking-code>`-style placeholder in a COMMAND', () => {
    // v4's defect this closes: `action` prose naming `symspec waive add
    // <blocking-code>`, which an agent ran verbatim and got a usage error. Angle-bracket
    // slots are legitimate in an OP (an agent must supply the reason or the predicate),
    // but a COMMAND that cannot be run as-is is a dead end — except where the command IS
    // the "go look at this" read, which names a real ref.
    const projections = [
      projectReachability(reportOf({ variables: 0 }), DOC),
      projectReachability(
        reportOf({
          results: [
            resultOf({ verdict: 'UNKNOWN', unknownReason: 'budget-exhausted', elapsedMs: 2000 }),
          ],
        }),
        DOC,
      ),
      projectReachability(
        reportOf({
          results: [resultOf({ verdict: 'VIOLATED', strict: 'reachable', framed: 'reachable' })],
        }),
        DOC,
      ),
    ]
    for (const projection of projections) {
      for (const entry of [...projection.findings, ...projection.demotions]) {
        for (const command of entry.repair?.commands ?? []) {
          expect(command.startsWith('symspec ')).toBe(true)
          expect(command).toContain(DOC)
        }
      }
    }
  })

  it('a VIOLATED finding offers READS and no ops, because the fix is a judgment', () => {
    // Synthesizing "weaken the constraint" or "change the effect" would be inventing
    // requirements content — the one thing a repair must never do.
    const finding = projectReachability(
      reportOf({
        results: [resultOf({ verdict: 'VIOLATED', strict: 'reachable', framed: 'reachable' })],
      }),
      DOC,
    ).findings[0]
    expect(finding?.repair?.ops).toEqual([])
    expect(finding?.repair?.commands?.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 8. TOTALITY: every demoting verdict carries the SUPPLYING command (G5)
// ---------------------------------------------------------------------------

/**
 * The established pattern, asserted exhaustively rather than per-case.
 *
 * `repair` is optional by design — an `uncovered-requirement` demotion discharges through a
 * human rewrite and there is no command that performs one, so emitting
 * `{ops:[],commands:[]}` would tell an agent "there is a repair, it is nothing". But every
 * demotion THIS tier raises has a mechanical next step, because each names a missing input
 * (a variable, a classification) or a knob (the per-query bound) rather than a judgment.
 *
 * So the totality claim is narrow and checkable: **for each of the five demotion reasons,
 * the demotion carries at least one runnable command, and the command names the thing the
 * reason is about.** The cross-product loop is what makes adding a fifth reason a failure
 * rather than an omission — the existing per-case tests would all still pass.
 */
describe('every reachability demotion names the command that supplies what is missing', () => {
  /** One report per demotion reason, so the loop below is exhaustive over the closed list. */
  const byReason: ReadonlyArray<readonly [string, ReachabilityReport]> = [
    // No state model at all: `state` is what supplies it.
    ['reachability-not-checked', reportOf({ variables: 0 })],
    // Proved only under the frame: the discharge is authoring the requirements that justify
    // it, and the mechanical half is the `state` op that drops the declaration.
    [
      'reachability-frame-relied-upon',
      reportOf({
        results: [
          resultOf({
            verdict: 'PROVED_UNDER_HYPOTHESES',
            strict: 'reachable',
            framed: 'unreachable',
            hypotheses: [{ variable: 'granted', writers: ['TX-A1'] }],
          }),
        ],
      }),
    ],
    // Budget exhausted: raise THIS tier's bound.
    [
      'reachability-budget-exhausted',
      reportOf({
        results: [
          resultOf({ verdict: 'UNKNOWN', unknownReason: 'budget-exhausted', elapsedMs: 2000 }),
        ],
      }),
    ],
    // Undecidable: bound the domains. More time is the WRONG answer, so the command must
    // not be a timeout raise.
    [
      'reachability-undecidable',
      reportOf({
        results: [resultOf({ verdict: 'UNKNOWN', unknownReason: 'undecidable', elapsedMs: 40 })],
      }),
    ],
    // Vacuous initial state: the model admits no states, so the mechanical next step is
    // READING the contradiction (`list`) and re-running — which predicate to change is
    // authoring content the repair must not invent, so no `state-initial` op appears here.
    [
      'reachability-vacuous-initial-state',
      reportOf({
        vacuousInitialState: true,
        initialPredicates: ['held = 0', 'held = 2'],
        results: [
          resultOf({ verdict: 'UNKNOWN', strict: 'unknown', unknownReason: 'undecidable' }),
        ],
      }),
    ],
  ]

  it('covers every reason in the CLOSED list — a new reason fails here', () => {
    // The cross-product guard. Without it, a fifth demotion reason could ship with no
    // repair and every existing per-case test would stay green.
    expect(byReason.map(([reason]) => reason).sort()).toEqual(
      [...REACHABILITY_DEMOTION_REASONS].sort(),
    )
  })

  it.each(byReason)('%s carries at least one runnable command', (reason, report) => {
    const demotion = projectReachability(report, DOC).demotions.find((d) => d.reason === reason)
    expect(demotion, `no demotion with reason ${reason}`).toBeDefined()
    const commands = demotion?.repair?.commands ?? []
    expect(commands.length, `${reason} has no runnable command`).toBeGreaterThan(0)
    for (const command of commands) {
      expect(command.startsWith('symspec ')).toBe(true)
    }
    // And the ACTION prose says what to do, so a reason with a command but no explanation
    // is still a dead end for a human reviewer.
    expect((demotion?.action ?? '').length).toBeGreaterThan(40)
  })

  it('routes the two UNKNOWN causes to DIFFERENT commands — the whole point of the split', () => {
    const commandFor = (reason: string) => {
      const report = byReason.find(([r]) => r === reason)?.[1]
      if (report === undefined) throw new Error(`no fixture for ${reason}`)
      return (
        projectReachability(report, DOC).demotions.find((d) => d.reason === reason)?.repair
          ?.commands ?? []
      ).join(' ')
    }
    const budget = commandFor('reachability-budget-exhausted')
    const undecidable = commandFor('reachability-undecidable')
    // Budget exhaustion raises the TIER'S OWN bound (G5), not the shared one.
    expect(budget).toContain('--reachability-timeout-ms')
    // Undecidability must NOT recommend more time — that is the loop this split prevents.
    expect(undecidable).not.toContain('timeout-ms')
    expect(budget).not.toBe(undecidable)
  })
})
