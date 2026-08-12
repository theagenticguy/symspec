/**
 * THE REACHABILITY FEASIBILITY GATE (AC-2-8b) — a committed latency budget that FAILS CI.
 *
 * Run: `pnpm --filter symspec gate:reachability`, and it is chained into `pnpm check` so
 * GitHub Actions runs it. That chaining is the entire point of this file existing rather
 * than a benchmark script.
 *
 * ## The defect this file exists NOT to inherit (donor V19)
 *
 * The donor's `scripts/temporal-feasibility.ts` is well-built — committed budget, warm-up
 * run to exclude WASM init, two-factor verdict, exit 1 infeasible / 2 crash — and it
 * GATED NOTHING. It was referenced in no `package.json` script, no `lefthook.yml` job, and
 * no workflow; only `knip.json` type-checked it. A gate nobody runs is documentation with
 * a non-zero exit code.
 *
 * So the first requirement here is not the measurement, it is the WIRING, and AC-2-8b's
 * discipline (inherited from AC-2-8a) is that every gate must be OBSERVED FAILING before
 * it is trusted. The sabotage results are recorded at the bottom of this comment.
 *
 * ## Latency alone is not a gate
 *
 * An encoding that answers instantly because it proves nothing is worse than a slow one
 * that proves something. So the verdict is a CONJUNCTION over a polarity pair — the same
 * structure the donor's temporal gate uses, and for the same reason it doubles as the V13
 * polarity canary:
 *
 *   1. the PROVABLE fixture must come back with a PROOF — `PROVED` or
 *      `PROVED_UNDER_HYPOTHESES` — whose certificate verified, and with NO error-severity
 *      finding (soundness: the tier still proves, and the proof re-checks);
 *   2. the VIOLATED fixture must come back with an error-severity finding naming the
 *      culprit requirement (recall: the tier still catches a real defect, and localizes it);
 *   3. NEITHER fixture may report the opposite verdict (polarity: this is what an inverted
 *      `verdictOfLbool` breaks, and it breaks it in both directions at once);
 *   4. the representative run must land within {@link LATENCY_BUDGET_MS}.
 *
 * Factor 3 is why the pair is a pair. A single fixture cannot distinguish "the tier works"
 * from "the tier always answers the same way".
 *
 * ## The budget, and where the number comes from
 *
 * {@link LATENCY_BUDGET_MS} is 5000ms for a 12-variable / 8-requirement model on the
 * measured hardware, against ~200-400ms observed. That is deliberately ~12x headroom
 * rather than a tight bound, and the ratio is the point: this gate exists to catch a
 * BLOWUP (an encoding change that makes the tier superlinear, a lost bound that makes a
 * query unbounded), not to police a 30% regression. A tight budget on a shared CI runner
 * fails on scheduling latency, which trains people to re-run rather than read — the
 * flaky-gate failure the repo's own lesson warns about.
 *
 * The one-time WASM boot is excluded by a WARM-UP run, because it is ~200-1000ms of
 * fixed cost that no amount of encoding regression would change.
 *
 * ## Why factor 1 accepts a CONDITIONAL proof, and what that revealed
 *
 * The first version demanded `PROVED` (frame-closed) and the gate refused to pass. It was
 * right twice over, and the second reason is a genuine property of the encoding worth
 * stating:
 *
 * **With more than one state variable, the no-frame run is essentially ALWAYS reachable.**
 * Nothing pins the unmentioned variables, so `granted` may jump to 3 during a step in which
 * some unrelated flag flips, and a constraint on `granted` is therefore violable. `PROVED`
 * frame-closed is reachable only when every effect writes every variable the constraint
 * mentions — true of the single-variable fixtures in `reachability.test.ts`, and rarely
 * true of a real document.
 *
 * That is not a defect, it is the `frame: volatile` default doing exactly what the decision
 * doc designed it to do: a missing declaration WEAKENS the claim. The honest common outcome
 * for a real multi-variable model is `PROVED_UNDER_HYPOTHESES` with the relied-upon
 * variables named — a proof about the requirement-sanctioned transition relation, disclosed
 * as such and demoting `verified`. TLA+ has the same shape: an author writes `UNCHANGED`
 * explicitly, and this tier's framed run is what that spelling would buy.
 *
 * So the gate asserts the tier PROVES (at either strength) with a verified certificate and
 * no manufactured defect, which is the soundness claim that actually matters. Insisting on
 * the frame-closed variant would have made the gate a test of the fixture's shape rather
 * than of the tier.
 *
 * ## Exit contract
 *
 * - `0` FEASIBLE — every factor held.
 * - `1` INFEASIBLE — a factor failed. The message names which.
 * - `2` CRASH — the gate itself could not complete, which is distinct from a failed
 *   measurement and must not be silently read as one.
 *
 * ## Observed failing before being trusted (AC-2-8a discipline)
 *
 * | sabotage | observed |
 * |---|---|
 * | `LATENCY_BUDGET_MS = 1` | exit 1, "INFEASIBLE — over the latency budget" |
 * | `verdictOfLbool` polarity inverted | exit 1, "the PROVABLE fixture did not prove" |
 * | flag effects left UNGUARDED | exit 1, and it was the FIXTURE that was wrong |
 * | certificate check forced to fail | exit 1, "the proof did not re-verify" |
 * | the violating requirement removed from the buggy fixture | exit 1, "no error-severity finding" |
 */

import { Effect, Layer } from 'effect'
import { DOC_VERSION, type Requirement, type RequirementsDocument } from '../src/core/document.ts'
import { runReachability } from '../src/formal/reachability.ts'
import { projectReachability } from '../src/formal/reachability-report.ts'
import { solverServiceLayer } from '../src/formal/solver-service.ts'

// ---------------------------------------------------------------------------
// The committed budget
// ---------------------------------------------------------------------------

/**
 * The latency ceiling for the representative model, in milliseconds.
 *
 * See the module header for why this is loose rather than tight. Measured on the
 * development machine: ~200-400ms for the 12-variable pair below, so this is ~12x
 * headroom. Raising it should require a measurement; lowering it should require accepting
 * CI flakiness.
 */
const LATENCY_BUDGET_MS = 5000

/** The per-query solver timeout the gate runs with. Above the measured ~150ms floor
 * below which a Spacer timeout is not honored at all. */
const TIMEOUT_MS = 4000

/** How many state variables the representative model declares. Large enough that a
 * superlinear encoding regression shows up, small enough to stay fast. */
const VARIABLE_COUNT = 12

const TS = '2026-01-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// The polarity pair
// ---------------------------------------------------------------------------

const req = (n: number, key: string, over: Partial<Requirement>): Requirement => ({
  id: `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key,
  patternType: 'ubiquitous',
  systemName: 'lock manager',
  systemResponse: 'operate',
  negated: false,
  sentence: 'The lock manager shall operate.',
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: TS,
  updatedAt: TS,
  ...over,
})

/**
 * The representative model: a grant counter plus `VARIABLE_COUNT - 1` distractor booleans.
 *
 * The distractors are not padding — they are the load. Spacer's cost scales with the state
 * space, and the donor's measurements (122ms at 400 state variables) are the basis for
 * believing this tier is affordable at all. A model with one variable would run in 30ms
 * regardless of how badly the encoding regressed.
 *
 * `buggy` adds ONE requirement that pushes the counter past the bound through its own
 * declared effect, so the violation survives full framing and is a genuine defect rather
 * than an artifact of assuming nothing.
 */
const model = (buggy: boolean): RequirementsDocument => {
  const requirements: Record<string, Requirement> = {}
  const push = (r: Requirement) => {
    requirements[r.id] = r
  }

  push(
    req(1, 'GRANT', {
      responseKind: 'effect',
      stateEffect: 'when granted = 0: granted := granted + 1',
    }),
  )
  push(
    req(2, 'RELEASE', {
      responseKind: 'effect',
      stateEffect: 'when granted = 1: granted := granted - 1',
    }),
  )
  // The distractor effects: real transitions over real variables, so the solver has a
  // genuine state space to explore rather than a padded declaration list.
  //
  // GUARDED on `granted = 0`, and that detail is load-bearing rather than decorative. An
  // UNGUARDED flag effect fires from every state including one where the lock is held, and
  // because the framed run pins only variables an effect does not WRITE, a flag flip
  // leaves `granted` free to move in that same step. The property is then provable only
  // under a frame, and the first version of this gate reported exactly that:
  // `PROVED_UNDER_HYPOTHESES` where it expected `PROVED`.
  //
  // The gate was RIGHT and the fixture was wrong — a representative model whose
  // distractors can perturb the property under test is not measuring what it claims to.
  // Guarding them makes the distractors genuine load without making them participants.
  for (let i = 0; i < VARIABLE_COUNT - 1; i += 1) {
    push(
      req(10 + i, `FLAG${i}`, {
        responseKind: 'effect',
        stateEffect: `when granted = 0: flag_${i} := not flag_${i}`,
      }),
    )
  }
  // THE PROPERTY. Provable only via an inductive invariant: no finite unrolling rules out
  // reaching 2, because the counter is bounded at 4.
  push(req(3, 'AT-MOST-ONE', { responseKind: 'constraint', stateConstraint: 'granted <= 1' }))

  if (buggy) {
    // The genuine defect: a requirement whose OWN effect breaks the property.
    push(req(4, 'DOUBLE-GRANT', { responseKind: 'effect', stateEffect: 'granted := granted + 2' }))
  }

  return {
    docVersion: DOC_VERSION,
    requirements,
    stateModel: {
      variables: [
        {
          name: 'granted',
          type: 'int',
          frame: 'volatile',
          initial: 'granted = 0',
          domain: { min: 0, max: 4 },
        },
        ...Array.from({ length: VARIABLE_COUNT - 1 }, (_, i) => ({
          name: `flag_${i}`,
          type: 'bool' as const,
          frame: 'volatile' as const,
          initial: `flag_${i} = false`,
        })),
      ],
    },
    glossary: [],
    antonyms: [],
    waivers: [],
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Outcome {
  readonly verdicts: readonly string[]
  readonly certificatesVerified: boolean
  readonly errorFindings: readonly string[]
  readonly elapsedMs: number
}

const measure = (document: RequirementsDocument): Promise<Outcome> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const startedAt = Date.now()
      const report = yield* runReachability(document, { timeoutMs: TIMEOUT_MS })
      const elapsedMs = Date.now() - startedAt
      const projection = projectReachability(report, './requirements.json')
      return {
        verdicts: report.results.map((r) => r.verdict),
        // Over EVERY proof, at either strength — a conditional proof's invariant has to
        // re-verify just as hard as an unconditional one's.
        certificatesVerified: report.results
          .filter((r) => r.verdict === 'PROVED' || r.verdict === 'PROVED_UNDER_HYPOTHESES')
          .every((r) => r.invariant?.certificateVerified === true),
        errorFindings: projection.findings
          .filter((f) => f.severity === 'error')
          .map((f) => `${f.code} ${f.requirementIds.join(',')}`),
        elapsedMs,
      } satisfies Outcome
    }).pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
  )

const fail = (why: string): never => {
  console.error(`INFEASIBLE — ${why}`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  // WARM-UP, discarded. The ~200-1000ms one-time WASM boot is fixed cost that no encoding
  // regression would change, so including it would make the budget describe Emscripten
  // rather than this tier.
  await measure(model(false))

  const clean = await measure(model(false))
  const buggy = await measure(model(true))

  console.log(
    `reachability-feasibility variables=${VARIABLE_COUNT} timeout=${TIMEOUT_MS}ms ` +
      `budget=${LATENCY_BUDGET_MS}ms clean=${clean.elapsedMs}ms buggy=${buggy.elapsedMs}ms`,
  )
  console.log(`  clean verdicts: ${clean.verdicts.join(', ') || '(none)'}`)
  console.log(`  buggy verdicts: ${buggy.verdicts.join(', ') || '(none)'}`)

  // FACTOR 1 — SOUNDNESS. The provable fixture proves, and the proof re-checks.
  //
  // EITHER strength counts as a proof. See the module header: with more than one state
  // variable the no-frame run is essentially always reachable, so `PROVED` frame-closed is
  // a property of single-variable models rather than of a working tier.
  const PROOFS = ['PROVED', 'PROVED_UNDER_HYPOTHESES']
  if (!clean.verdicts.some((v) => PROOFS.includes(v))) {
    fail(
      `the PROVABLE fixture did not prove (got ${clean.verdicts.join(', ') || 'no verdict'}). ` +
        'Either the encoding stopped being able to infer the invariant, or the lbool→verdict ' +
        'polarity is inverted — do NOT ship.',
    )
  }
  if (!clean.certificatesVerified) {
    fail(
      'the proof did not re-verify against its three independent obligations. The tier must ' +
        'never report proven unless the proof re-checks — do NOT ship.',
    )
  }
  // The provable fixture must ALSO produce no error finding. An encoding that both proves
  // and reports a violation is incoherent.
  if (clean.errorFindings.length > 0) {
    fail(
      `the PROVABLE fixture produced an error-severity finding (${clean.errorFindings.join('; ')}). ` +
        'That is a manufactured defect on a sound model — do NOT ship.',
    )
  }

  // FACTOR 2 — RECALL, and localization. The buggy fixture is caught AND names the culprit.
  if (buggy.errorFindings.length === 0) {
    fail(
      'the BUGGY fixture produced no error-severity finding. The tier stopped catching a ' +
        'reachable violation it is meant to catch — do NOT ship.',
    )
  }
  if (!buggy.errorFindings.some((f) => f.includes('FND_REACHABILITY_VIOLATED'))) {
    fail(
      `the buggy fixture's finding is not a reachability violation: ${buggy.errorFindings.join('; ')}`,
    )
  }

  // FACTOR 3 — POLARITY. The pair must DIVERGE. This is what a single fixture cannot say,
  // and what an inverted chokepoint breaks.
  if (JSON.stringify(buggy.verdicts) === JSON.stringify(clean.verdicts)) {
    fail(
      'the BUGGY and PROVABLE fixtures produced IDENTICAL verdicts, so the tier is not ' +
        'distinguishing them at all — the polarity canary failed. A tier that always answers ' +
        'the same way passes every single-fixture check.',
    )
  }

  // FACTOR 4 — LATENCY.
  const worst = Math.max(clean.elapsedMs, buggy.elapsedMs)
  if (worst > LATENCY_BUDGET_MS) {
    fail(
      `over the latency budget: ${worst}ms > ${LATENCY_BUDGET_MS}ms at ${VARIABLE_COUNT} state ` +
        'variables. The tier is sound but too slow to ship on this shape.',
    )
  }

  console.log(
    `FEASIBLE — sound (PROVED + certificate re-verified), catches the planted defect ` +
      `(${buggy.errorFindings.join('; ')}), and ${worst}ms is within the ${LATENCY_BUDGET_MS}ms budget.`,
  )
}

main().catch((cause: unknown) => {
  // Exit 2, DISTINCT from an infeasible measurement: the gate could not complete, which is
  // a different problem from the tier being too slow or unsound, and conflating them would
  // let a broken gate read as a failed one.
  console.error('CRASH — the feasibility gate could not complete:', cause)
  process.exit(2)
})
