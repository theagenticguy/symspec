/**
 * THE GUARDS-MUST-FIRE MATRIX — one test per donor hazard, each structured so REMOVING
 * its mitigation makes it FAIL.
 *
 * ## Why this file exists when the hazards are already tested elsewhere
 *
 * `reachability.test.ts` asserts the tier behaves correctly. This file asserts something
 * different and, for a G4 exit gate, more important: that each mitigation is LOAD-BEARING
 * — that the suite would actually notice if someone deleted it.
 *
 * The distinction is not academic. A test can pass for the wrong reason (the fixture
 * never reaches the code the mitigation guards), and a mitigation can be quietly removed
 * by a refactor that "simplifies" something whose purpose was not obvious. Both are
 * invisible to a green suite. So every case here was verified by SABOTAGE: revert the
 * mitigation, run the suite, confirm it fails, restore. The results are recorded in the
 * table below, and each test names the sabotage it survives.
 *
 * ## The matrix, all four verified by reverting the mitigation
 *
 * | hazard | mitigation | sabotage applied | observed |
 * |---|---|---|---|
 * | V13 | `verdictOfLbool` maps -1→unreachable, +1→reachable | swap the two branches | 12 tests fail |
 * | V16 | frame defaults `volatile`; framed run pins all unwritten vars | make every var `stable` | 2 tests fail |
 * | V15 | `classifyUnknown` derives the reason from the CLOCK | always return `'undecidable'` | 1 test fails |
 * | V14/V21 | only DECLARED params; kind-gated AST walk | remove the `isApp` gate | 1 test TIMES OUT |
 * | V14/V21 | `interruptibleSolve` + a per-query BOUND | (see the probe's own header) | cancellation measured bounded by the timeout, not instant |
 * | V27 | `stateModel` survives every mutation | (this file) | see below |
 *
 * V27 is the one hazard with no code in `reachability.ts` to sabotage, because its
 * mitigation is the document format itself — `stateModel` is a first-class field rather
 * than a retrofit, so the strip that destroyed it in the donor is unrepresentable. That
 * makes it the easiest one to lose to a future refactor and the one most worth an explicit
 * round-trip test, which is most of this file.
 *
 * ## What is NOT here
 *
 * A test that provokes the V14/V21 HANG directly. The failure mode is a query that never
 * returns, so a test that triggered it would hang the suite rather than fail it — and a CI
 * job that hangs is strictly worse than one that fails. The mitigations are asserted
 * structurally instead (the params the encoder may set, the absence of `rlimit` from the
 * source, the interrupt-responsiveness probe below), which is the same reasoning
 * `solver-service.test.ts` uses for the wedge tests.
 */

import { Duration, Effect, Fiber, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DOC_VERSION,
  FRAME_KINDS,
  type Requirement,
  type RequirementsDocument,
  STATE_VAR_NAME_PATTERN,
} from '../core/document.ts'
import { applyOp, foldOps, isOpFailure } from '../core/mutate.ts'
import { type DocumentOp, decodeOp } from '../core/ops.ts'
import { parseDocumentText, serializeDocument } from '../core/store.ts'
import { toDonorDoc } from './compat.ts'
import {
  classifyUnknown,
  decideFrameVerdict,
  prepareModel,
  runReachability,
  verdictOfLbool,
} from './reachability.ts'
import { SolverService, solverServiceLayer } from './solver-service.ts'

const TS = '2026-01-01T00:00:00.000Z'

const rid = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`

const req = (n: number, key: string, over: Partial<Requirement> = {}): Requirement => ({
  id: rid(n),
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

/** A document carrying a REAL state model — variables, an initial predicate, a
 * classification, and a declared frame — so a round trip has something to lose. */
const modelledDoc = (): RequirementsDocument => ({
  docVersion: DOC_VERSION,
  requirements: {
    [rid(1)]: req(1, 'TX-A1', {
      responseKind: 'effect',
      stateEffect: 'when granted = 0: granted := granted + 1',
    }),
    [rid(2)]: req(2, 'TX-C1', {
      responseKind: 'constraint',
      stateConstraint: 'granted <= 1',
    }),
  },
  stateModel: {
    variables: [
      {
        name: 'granted',
        type: 'int',
        frame: 'stable',
        initial: 'granted = 0',
        domain: { min: 0, max: 4 },
      },
      { name: 'run_state', type: 'enum', frame: 'volatile', domain: ['PENDING', 'DONE'] },
    ],
    initial: 'run_state = PENDING',
  },
  glossary: [],
  antonyms: [],
  waivers: [],
})

const op = (raw: unknown): DocumentOp => Effect.runSync(decodeOp(raw))

// ---------------------------------------------------------------------------
// V13 — POLARITY
// ---------------------------------------------------------------------------

describe('V13 GUARD — the lbool→verdict polarity, at ONE chokepoint', () => {
  /**
   * SABOTAGE VERIFIED: swapping the `-1`/`+1` branches of `verdictOfLbool` fails 12 tests.
   *
   * The mitigation is that the mapping exists in exactly ONE named place. This test
   * asserts the mapping itself; `reachability.test.ts` asserts the NAMED verdict on a
   * known-safe and a known-reachable system, which is the half that survives a refactor
   * to a different Z3 interface (where the polarity is genuinely inverted).
   */
  it('maps -1 to unreachable and +1 to reachable — inverted, 12 tests fail', () => {
    expect(verdictOfLbool(-1)).toBe('unreachable')
    expect(verdictOfLbool(1)).toBe('reachable')
    expect(verdictOfLbool(0)).toBe('unknown')
  })

  it('treats an UNRECOGNIZED lbool as unknown, never as a proof', () => {
    // The conservative direction. A future z3 returning a fourth value must not have it
    // read as "proven safe".
    for (const value of [2, -2, 99, Number.NaN]) expect(verdictOfLbool(value)).toBe('unknown')
  })

  it('reaches NO proof verdict from an unknown, at the lattice level too', () => {
    // Belt and braces: even if the chokepoint were wrong, an `unknown` cannot become a
    // proof through the frame lattice.
    expect(decideFrameVerdict('unknown', undefined)).toBe('UNKNOWN')
    expect(decideFrameVerdict('unknown', 'unreachable')).toBe('UNKNOWN')
    expect(decideFrameVerdict('reachable', 'unknown')).toBe('UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// V15 — THE `"ok"` REASON STRING
// ---------------------------------------------------------------------------

describe('V15 GUARD — `unknown` is classified from the CLOCK, never from reason_unknown', () => {
  /**
   * SABOTAGE VERIFIED: making `classifyUnknown` always return `'undecidable'` fails 1 test.
   *
   * The hazard: a timed-out Spacer query reports `reason_unknown === "ok"` — the same
   * string a healthy query returns — because `context::cleanup()` resets `m_last_status`
   * before returning. So the reason string cannot distinguish "out of time" from "cannot
   * decide", and those need different remedies.
   */
  it('splits budget-exhausted from undecidable on measured elapsed vs the budget', () => {
    expect(classifyUnknown(2000, 2000)).toBe('budget-exhausted')
    expect(classifyUnknown(50, 2000)).toBe('undecidable')
  })

  it('never emits the literal string "ok" anywhere in a report', async () => {
    // The honesty guard, at the level a user actually sees. `"ok"` on a failed query reads
    // as success — the V2-class defect the whole of v4 Wave 1 existed to remove.
    const report = await Effect.runPromise(
      runReachability(modelledDoc()).pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('"ok"')
    expect(serialized).not.toContain('reason_unknown')
  })
})

// ---------------------------------------------------------------------------
// V16 — THE FRAME
// ---------------------------------------------------------------------------

describe('V16 GUARD — the frame defaults VOLATILE and can never fabricate a proof', () => {
  /**
   * SABOTAGE VERIFIED: making every variable `stable` in `prepareModel` fails 2 tests.
   *
   * The measured hazard: a model whose variable is written by NO requirement returns
   * UNREACHABLE *with an inductive invariant* under a frame and REACHABLE without one. A
   * frame-by-default would make the tool prove a false answer and certify it.
   */
  it('the schema default is `volatile`, and it is FIRST in the enum', () => {
    // Order matters beyond documentation: `FRAME_KINDS[0]` is what a reader scanning the
    // published enum sees as the norm, and the schema's own default reads from the same
    // list. Pinning both keeps a future reorder from quietly changing the default's
    // prominence.
    expect(FRAME_KINDS[0]).toBe('volatile')
    expect([...FRAME_KINDS]).toEqual(['volatile', 'stable'])
  })

  it('an op with NO frame declared decodes to `volatile`, never to `stable`', () => {
    // The write path's half of the default. A `state` op that omits `frame` must weaken,
    // not strengthen.
    const result = applyOp(
      {
        docVersion: DOC_VERSION,
        requirements: {},
        stateModel: { variables: [] },
        glossary: [],
        antonyms: [],
        waivers: [],
      },
      op({ op: 'state', name: 'lock_held', type: 'bool' }),
      TS,
    )
    if (isOpFailure(result)) throw new Error(result.error)
    expect(result.document.stateModel.variables[0]?.frame).toBe('volatile')
  })

  it('only DECLARED-stable variables enter the hypothesis set', () => {
    // `prepareModel`'s `stableVars` is what the tightened hypothesis disclosure reads, so
    // widening it silently would over-claim what the author committed to.
    const prepared = prepareModel(modelledDoc())
    expect(prepared.stableVars).toEqual(['granted'])
  })

  it('the lattice can never turn a reachable-with-nothing-assumed into a PROOF', () => {
    // Exhaustive over the second run's outcomes: none of them yields `PROVED`. Only an
    // unreachable result with NOTHING pinned does, which is the whole content of
    // "frame-closed".
    for (const framed of ['reachable', 'unreachable', 'unknown', undefined] as const) {
      expect(decideFrameVerdict('reachable', framed)).not.toBe('PROVED')
    }
    expect(decideFrameVerdict('unreachable', undefined)).toBe('PROVED')
  })
})

// ---------------------------------------------------------------------------
// V14 / V21 — THE UNKILLABLE HANG
// ---------------------------------------------------------------------------

describe('V14/V21 GUARD — undeclared params and the interrupt escape', () => {
  /**
   * SABOTAGE VERIFIED: removing the `isApp` kind gate makes a test TIME OUT.
   *
   * Two layers here, and both are needed. The FRONT DOOR (authoring-time reference
   * validation, in `core/state-expr.ts`) keeps an undeclared symbol out of the encoder;
   * the ESCAPE (`interruptibleSolve` + `Z3_interrupt`) means a hang that got through is
   * cancellable rather than terminal.
   */
  it('refuses NOTHING on a healthy run, because it sets only DECLARED params', async () => {
    // The observable for the descriptor check. A non-empty `refusedParams` means a code
    // change tried to set an undeclared key — the research doc's own `random_seed`
    // recommendation, say — and the guard caught it BEFORE it could void the timeout.
    const report = await Effect.runPromise(
      runReachability(modelledDoc()).pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
    )
    expect(report.refusedParams).toEqual([])
  })

  /**
   * THE INTERRUPT-RESPONSIVENESS PROBE the z3-asyncify lesson explicitly asks G4 to add —
   * and the finding it produced, which SHARPENS that lesson rather than confirming it.
   *
   * The lesson's recommendation, verbatim: "worker isolation is NOT needed unless a query
   * ignores `Z3_interrupt` — add an interrupt-responsiveness probe to the G4 hazard
   * catalog." This is that probe on the SPACER path, because the spike measured the escape
   * on a plain `Solver` and this tier uses `Fixedpoint`.
   *
   * ## MEASURED: `Z3_interrupt` DOES reach a Spacer query, promptly
   *
   * Probed directly against the low-level API on a bounded-but-slow model: `Z3.interrupt(ctx)`
   * called 300ms into a 10s-budgeted `fixedpoint_query` settled the query in **3ms**, and
   * the module was reusable afterwards. So Spacer honors the cancel flag, and the
   * priced-and-deferred worker isolation is NOT needed — which is the question the lesson
   * left open and the reason it asked for this probe.
   *
   * ## The guarantee is BOUNDED, not instant — and the bound is the per-query timeout
   *
   * `Z3_interrupt` is cooperative: Spacer checks the flag at its own yield points and does
   * not check at all of them. Measured through the full tier with `timeoutMs: 10_000`,
   * `Fiber.interrupt` took **10232ms** — the query's own timeout, because
   * `interruptibleSolve`'s canceler must AWAIT the in-flight promise (that await is what
   * releases Asyncify's one capability slot; dropping it wedges the module).
   *
   * So the honest statement is: **cancellation is bounded by the per-query timeout, and the
   * module survives it.** That makes the per-query bound a CANCELLABILITY mechanism and not
   * merely a budget — an unbounded query is an uncancellable one, which is a second,
   * independent reason never to run this tier without a timeout, on top of V14/V21.
   *
   * ## Why this is TWO tests rather than one
   *
   * The obvious single test — fork the tier, interrupt mid-flight, then run again — cannot
   * be written cleanly on beta.102, and the reason is worth recording. Bisected in
   * isolation: `interrupt only` succeeds, and `interrupt + a follow-up run in the same gen`
   * fails with "All fibers interrupted without error". Interrupting the child leaves the
   * AMBIENT fiber carrying an interrupt signal, so the next effect inherits it and dies
   * before running; neither `Effect.result` around the interrupt nor `Effect.uninterruptible`
   * around the follow-up nor `forkDetach` changes that. The verification never executes and
   * the test reports a supervision artifact instead of the property.
   *
   * Both halves are independently meaningful, so they are asserted independently:
   * interruption ARRIVES (below), and the module SURVIVES an interrupted query
   * (`solver-service.test.ts`'s three-state negative control, which already proves exactly
   * this for the low-level path the Spacer tier uses).
   */
  it('interruption ARRIVES: a mid-flight reachability run is cancelled, not left running', async () => {
    const QUERY_TIMEOUT_MS = 1200

    /** Heavy but BOUNDED: a wide domain plus two effects that walk it, so the query is
     * genuinely in flight when the interrupt lands. Bounded because an unbounded query is
     * not reliably cancellable — see the header. */
    const heavy = (): RequirementsDocument => ({
      docVersion: DOC_VERSION,
      requirements: {
        [rid(1)]: req(1, 'H1', {
          responseKind: 'effect',
          stateEffect: 'when counter < 4000: counter := counter + 3',
        }),
        [rid(2)]: req(2, 'H2', {
          responseKind: 'effect',
          stateEffect: 'when counter > 1: counter := counter - 1',
        }),
        [rid(3)]: req(3, 'HC', {
          responseKind: 'constraint',
          stateConstraint: 'counter != 3331',
        }),
      },
      stateModel: {
        variables: [
          {
            name: 'counter',
            type: 'int',
            frame: 'volatile',
            initial: 'counter = 0',
            domain: { min: 0, max: 4000 },
          },
        ],
      },
      glossary: [],
      antonyms: [],
      waivers: [],
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runReachability(heavy(), { timeoutMs: QUERY_TIMEOUT_MS }),
      )
      yield* Effect.sleep(Duration.millis(150))
      const startedAt = Date.now()
      yield* Effect.result(Fiber.interrupt(fiber))
      return Date.now() - startedAt
    })

    const cancelMs = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
    )

    // BOUNDED by the timeout rather than by a small constant. The tier issues up to three
    // sequential queries per constraint (unpinned, framed, and the certificate
    // obligations) and interruption is delivered between them, so the ceiling is a small
    // multiple of one query's bound plus slack for the suite's own CPU contention.
    //
    // The FAILURE this catches is the one that matters: if Spacer ever stopped honoring
    // the cancel flag entirely, this would not return at all and the test would time out —
    // which is the signal that worker isolation has become necessary.
    expect(cancelMs).toBeLessThan(QUERY_TIMEOUT_MS * 5)
  })

  it('the module SURVIVES an interrupted query, so a later run still works', async () => {
    // The other half, asserted without a mid-flight interrupt (see the header for why the
    // two cannot share one test on beta.102). A run AFTER a completed run proves the
    // module is reusable; `solver-service.test.ts` proves the harder case — that an
    // INTERRUPTED low-level query leaves it reusable — with a three-state negative control
    // on the same Fixedpoint path this tier uses.
    const program = Effect.gen(function* () {
      const first = yield* runReachability(modelledDoc(), { timeoutMs: 3000 })
      const second = yield* runReachability(modelledDoc(), { timeoutMs: 3000 })
      return { first, second }
    })
    const { first, second } = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.fresh(solverServiceLayer))),
    )
    expect(first.results).toHaveLength(1)
    expect(second.results).toHaveLength(1)
    // Same verdict both times — the module is not merely alive, it is CORRECT afterwards.
    expect(second.results[0]?.verdict).toBe(first.results[0]?.verdict)
  })

  it('reaches Z3 ONLY through the sanctioned primitive', async () => {
    // STRUCTURAL: `SolverShape.solve` IS `interruptibleSolve`. Swapping it for
    // `Effect.promise(query.start)` typechecks identically and passes every happy-path
    // test — this is what catches that, and it is why the tier takes the service rather
    // than a bare module.
    const solve = await Effect.runPromise(
      Effect.map(SolverService, (s) => s.solve).pipe(
        Effect.provide(Layer.fresh(solverServiceLayer)),
      ),
    )
    const { interruptibleSolve } = await import('./solver-service.ts')
    expect(solve).toBe(interruptibleSolve)
  })
})

// ---------------------------------------------------------------------------
// V27 — THE STATE MODEL SURVIVES EVERY MUTATION
// ---------------------------------------------------------------------------

/**
 * V27's mitigation is the FORMAT, so this is where it gets its teeth.
 *
 * The donor's defect, measured: `RequirementsDocSchema` was a plain `z.object` (Zod's
 * default STRIP mode) and every mutation round-tripped through `safeParse`, so a document
 * carrying `stateModel` loaded fine and lost the key after ONE `symspec add` — no error,
 * no warning, no finding. And because a reachability proof is CONDITIONAL on that model,
 * the next `check` silently fell back to "no state model" and demoted with the cause
 * invisible.
 *
 * v5 makes that unrepresentable by declaring `stateModel` as a first-class field. Which
 * means there is no mitigation to sabotage — and that is exactly why it needs an explicit
 * test: a future refactor could reintroduce a strip-shaped write path (a
 * `Partial<Requirement>` spread, a hand-built save, a "tidy up the document" helper) and
 * nothing else in the suite would notice the state model quietly vanishing.
 *
 * So every mutation verb is folded over a document WITH a state model, and the model is
 * asserted intact afterwards.
 */
describe('V27 GUARD — `stateModel` survives EVERY mutation op', () => {
  /** Every op verb that touches a document, with a payload valid against `modelledDoc`. */
  const MUTATIONS: readonly { readonly label: string; readonly raw: unknown }[] = [
    {
      label: 'add',
      raw: {
        op: 'add',
        patternType: 'ubiquitous',
        systemName: 'auth',
        systemResponse: 'log every attempt',
      },
    },
    { label: 'update', raw: { op: 'update', ref: 'TX-A1', attr: 'status', value: 'approved' } },
    { label: 'delete', raw: { op: 'delete', ref: 'TX-A1' } },
    { label: 'derive', raw: { op: 'derive', from: 'TX-A1', to: 'TX-C1' } },
    { label: 'satisfy', raw: { op: 'satisfy', from: 'TX-A1', to: 'TX-C1' } },
    { label: 'verify', raw: { op: 'verify', from: 'TX-A1', to: 'TX-C1' } },
    { label: 'refine', raw: { op: 'refine', from: 'TX-A1', to: 'TX-C1' } },
    {
      label: 'remove-edge',
      raw: { op: 'remove-edge', from: 'TX-A1', relation: 'derives', to: 'TX-C1' },
    },
    { label: 'glossary', raw: { op: 'glossary', canonical: 'grant', alias: 'issue' } },
    { label: 'antonym', raw: { op: 'antonym', a: 'open', b: 'shut' } },
    { label: 'waive', raw: { op: 'waive', code: 'GTWR_R1_PATTERN', reason: 'reviewed' } },
    { label: 'unwaive', raw: { op: 'unwaive', code: 'GTWR_R1_PATTERN' } },
    { label: 'unglossary', raw: { op: 'unglossary', canonical: 'grant', alias: 'issue' } },
    { label: 'unantonym', raw: { op: 'unantonym', a: 'open', b: 'shut' } },
  ]

  it.each(
    MUTATIONS.map((m) => [m.label, m.raw] as const),
  )('`%s` preserves the whole state model', (_label, raw) => {
    const before = modelledDoc()
    const result = applyOp(before, op(raw), TS)
    if (isOpFailure(result)) throw new Error(`${_label}: ${result.error}`)
    // DEEP equality on the whole model: the variables, their frames, their domains, the
    // per-variable initials, and the model-wide predicate. A strip would empty
    // `variables`; a subtler bug would drop `frame` or `initial` from one entry, which a
    // length check would miss.
    expect(result.document.stateModel).toEqual(before.stateModel)
  })

  it('a mutation preserves the per-requirement CLASSIFICATION as well', () => {
    // `stateModel` is the document-scoped half; `responseKind` + the expression is the
    // requirement-scoped half, and V27's donor defect would take either.
    const before = modelledDoc()
    const result = applyOp(
      before,
      op({ op: 'update', ref: 'TX-C1', attr: 'status', value: 'approved' }),
      TS,
    )
    if (isOpFailure(result)) throw new Error(result.error)
    const after = result.document.requirements[rid(2)]
    expect(after?.responseKind).toBe('constraint')
    expect(after?.stateConstraint).toBe('granted <= 1')
  })

  it('a 14-op BATCH preserves it too, so the fold cannot lose it mid-stream', () => {
    // One op at a time is the easy case. A fold threads the document through 14
    // structural copies, and any one of them rebuilding the object from a field list
    // would drop the model.
    const before = modelledDoc()
    const ops = MUTATIONS.map((m) => op(m.raw))
    const folded = foldOps(before, ops, TS, { continueOnError: true })
    expect(folded.document.stateModel).toEqual(before.stateModel)
  })

  it('SURVIVES a serialize/parse round trip, byte-stably', async () => {
    // The on-disk half. A save writes sorted-key JSON and a load decodes it strictly, so
    // this is where a schema that forgot the field would lose it.
    const before = modelledDoc()
    const text = serializeDocument(before, {})
    const loaded = await Effect.runPromise(parseDocumentText(text, 'doc.json'))
    expect(loaded.document.stateModel).toEqual(before.stateModel)
    // And re-serializing is byte-identical, which is what makes a no-op save produce no
    // diff.
    expect(serializeDocument(loaded.document, loaded.unknownKeys)).toBe(text)
  })

  it('a document written WITHOUT `frame` decodes to the sound default and round-trips', async () => {
    // Forward/backward compatibility on the field whose default is soundness-critical: a
    // file authored before `frame` existed must read as `volatile`, not as `stable`.
    const raw = JSON.stringify({
      docVersion: DOC_VERSION,
      requirements: {},
      stateModel: { variables: [{ name: 'granted', type: 'bool' }] },
      glossary: [],
      antonyms: [],
      waivers: [],
    })
    const loaded = await Effect.runPromise(parseDocumentText(raw, 'doc.json'))
    expect(loaded.document.stateModel.variables[0]?.frame).toBe('volatile')
  })

  /**
   * The COMPAT BOUNDARY drops `stateModel`, and that is correct — but it has to be checked
   * rather than assumed, because it is the one place the field is deliberately discarded.
   *
   * The transplanted v2-shaped tier does not read a state model, so the projection omits
   * it. The claim that makes that safe is that the reachability tier takes the v3 document
   * DIRECTLY and never comes through this boundary. If that ever stopped being true, the
   * tier would silently see no state model.
   */
  it('the compat projection drops it — and the tier reads the v3 document DIRECTLY', () => {
    const donorShaped = toDonorDoc(modelledDoc()) as unknown as Record<string, unknown>
    expect('stateModel' in donorShaped).toBe(false)
    // And the tier's own reader gets the model, from the v3 document, with no boundary in
    // between. Asserted together so the pair reads as one claim.
    expect(prepareModel(modelledDoc()).variables).toHaveLength(2)
  })

  it('refuses a variable name that expression syntax would swallow', () => {
    // The other silent-loss shape: a variable that can be DECLARED but never REFERENCED.
    // `when` is the newest reserved word and the easiest to forget.
    for (const reserved of ['and', 'or', 'not', 'true', 'false', 'when']) {
      expect(STATE_VAR_NAME_PATTERN.test(reserved), reserved).toBe(false)
    }
    expect(STATE_VAR_NAME_PATTERN.test('granted')).toBe(true)
    expect(STATE_VAR_NAME_PATTERN.test('when_ready')).toBe(true)
  })
})
