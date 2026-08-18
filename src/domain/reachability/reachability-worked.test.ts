/**
 * THE WORKED FIXTURE — one small document where `check` PROVES one constraint and FINDS a
 * genuine violation of another, end to end through the real operation.
 *
 * ## Why this file exists separately from the other reachability tests
 *
 * `reachability.test.ts` tests the tier, `reachability-report.test.ts` tests the
 * projection, `reachability-guards.test.ts` tests that each mitigation is load-bearing.
 * None of them shows what the capability is FOR. This does: a document an author could
 * plausibly write, the two verdicts it produces, and the exact evidence each carries.
 *
 * It doubles as the craft-surface example, which is why the assertions read as claims about
 * the OUTPUT an author sees rather than about internal shapes. If this test needs editing
 * to stay green, the agent-facing story changed and the docs need to change with it.
 *
 * ## The model is the real TX-C1, transposed into state-model form
 *
 * From the hex-bonk `agent-run-triggers` production document, verbatim:
 *
 *   TX-C1 (ubiquitous) — "The run service shall assign runs that share a conversation the
 *   Procrastinate lock keyed on the conversation id so they execute sequentially."
 *
 * That is a MUTUAL-EXCLUSION invariant: at most one run per conversation holds the lock at
 * a time. Written as a state model:
 *
 *   - `held` (int 0..3) — how many runs currently hold the conversation lock.
 *   - `queued` (bool)   — whether a run is waiting for it.
 *
 *   TX-A1 acquire  `when held = 0: held := held + 1, queued := false`
 *   TX-A2 release  `when held = 1: held := held - 1`
 *   TX-A3 enqueue  `when held = 1: queued := true`
 *
 *   TX-C1 the invariant  `held <= 1`         <- PROVED
 *   TX-C2 a second one   `not (queued and held = 0)`   <- VIOLATED, with a trace
 *
 * TX-C2 says "nothing waits for a free lock", which sounds reasonable and is FALSE: TX-A3
 * can enqueue while the lock is held, and TX-A2 can then release it, leaving a queued run
 * and a free lock. That is a real ordering defect of the shape a spec review misses, and
 * the trace names the two requirements that produce it in order.
 *
 * Both constraints are checked in ONE run over ONE document, which is the point — the
 * capability is not "prove a property", it is "tell me which of my invariants survive".
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { stubEmbedder } from '../../adapters/embedding/embedder.ts'
import { solverServiceLayer } from '../../adapters/z3/solver-service.ts'
import { type CheckPayload, checkOp } from '../../app/operations/check.ts'
import { runOperation } from '../../app/runtime/operation.ts'
import { DocPath, DocStore, makeDocPath } from '../../ports/doc-store.ts'
import { embedderLayerOf } from '../../ports/embedder.ts'
import { ErrDocNotFound } from '../../ports/errors.ts'
import {
  DOC_VERSION,
  type Requirement,
  type RequirementsDocument,
} from '../requirements/document.ts'

const TS = '2026-01-01T00:00:00.000Z'
const id = (n: number) => `eeeeeeee-0000-4000-8000-00000000000${n}`

const req = (
  n: number,
  key: string,
  sentence: string,
  over: Partial<Requirement>,
): Requirement => ({
  id: id(n),
  key,
  patternType: 'ubiquitous',
  systemName: 'run service',
  systemResponse: 'operate',
  negated: false,
  sentence,
  priority: 'high',
  status: 'approved',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: TS,
  updatedAt: TS,
  ...over,
})

/**
 * The conversation-lock document: three effects and two constraints, one provable and one
 * genuinely violated.
 *
 * Every `stateEffect` is GUARDED, because an unguarded effect fires from every state and
 * would make almost any invariant violable by a transition the document never licensed.
 * The guards are what an EARS trigger means formally.
 */
const conversationLockDoc = (): RequirementsDocument => ({
  docVersion: DOC_VERSION,
  requirements: {
    [id(1)]: req(
      1,
      'TX-A1',
      'When an agent worker claims a run, the run service shall acquire the conversation lock.',
      {
        patternType: 'event-driven',
        trigger: 'an agent worker claims a run',
        systemResponse: 'acquire the conversation lock',
        responseKind: 'effect',
        stateEffect: 'when held = 0: held := held + 1, queued := false',
      },
    ),
    [id(2)]: req(
      2,
      'TX-A2',
      'When a run reaches a terminal state, the run service shall release the conversation lock.',
      {
        patternType: 'event-driven',
        trigger: 'a run reaches a terminal state',
        systemResponse: 'release the conversation lock',
        responseKind: 'effect',
        stateEffect: 'when held = 1: held := held - 1',
      },
    ),
    [id(3)]: req(
      3,
      'TX-A3',
      'When a run for a locked conversation is queued, the run service shall mark it waiting.',
      {
        patternType: 'event-driven',
        trigger: 'a run for a locked conversation is queued',
        systemResponse: 'mark the run waiting',
        responseKind: 'effect',
        stateEffect: 'when held = 1: queued := true',
      },
    ),
    // The REAL TX-C1, from the hex-bonk production document.
    [id(4)]: req(
      4,
      'TX-C1',
      'The run service shall assign runs that share a conversation the Procrastinate lock keyed on the conversation id so they execute sequentially.',
      {
        systemResponse: 'hold at most one conversation lock at a time',
        responseKind: 'constraint',
        stateConstraint: 'held <= 1',
      },
    ),
    // The plausible-but-FALSE one.
    [id(5)]: req(
      5,
      'TX-C2',
      'The run service shall never leave a run waiting on a conversation lock that is free.',
      {
        systemResponse: 'never leave a run waiting on a free lock',
        responseKind: 'constraint',
        stateConstraint: 'not (queued and held = 0)',
      },
    ),
  },
  stateModel: {
    variables: [
      {
        name: 'held',
        type: 'int',
        frame: 'volatile',
        initial: 'held = 0',
        domain: { min: 0, max: 3 },
      },
      { name: 'queued', type: 'bool', frame: 'volatile', initial: 'queued = false' },
    ],
  },
  glossary: [],
  antonyms: [],
  waivers: [],
  terms: [],
})

/** Run the REAL `check` operation over an in-memory document. */
const check = (document: RequirementsDocument): Promise<CheckPayload> =>
  Effect.runPromise(
    runOperation(checkOp, { file: 'doc.json' }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DocStore)(
            DocStore.of({
              load: (path) =>
                path === 'doc.json'
                  ? Effect.succeed({ document, unknownKeys: {}, diagnostics: [] })
                  : Effect.fail(
                      new ErrDocNotFound({ error: `no document at ${path}`, suggestions: [] }),
                    ),
              save: () => Effect.void,
              exists: () => Effect.succeed(true),
            }),
          ),
          Layer.succeed(DocPath)(makeDocPath({})),
          solverServiceLayer,
          embedderLayerOf(stubEmbedder()),
        ),
      ),
      Effect.map((envelope) => envelope.data),
    ),
  )

describe('THE WORKED FIXTURE — one document, one proof, one genuine defect', () => {
  it('decides BOTH constraints in one run', async () => {
    const payload = await check(conversationLockDoc())
    expect(payload.reachability).toBeDefined()
    expect(payload.reachability?.variables).toBe(2)
    expect(payload.reachability?.effects).toBe(3)
    // TWO constraints, both decided — no `unknown`, which is what makes this a worked
    // example rather than a demonstration of the demotion path.
    expect(payload.reachability?.constraints).toBe(2)
    expect(payload.reachability?.unknown).toBe(0)
  })

  it('PROVES the real TX-C1 mutual-exclusion invariant, and the proof re-verifies', async () => {
    const payload = await check(conversationLockDoc())
    const proof = payload.findings.find(
      (f) =>
        (f.code === 'FND_REACHABILITY_PROVED' || f.code === 'FND_REACHABILITY_UNDER_HYPOTHESES') &&
        f.requirementIds.includes(id(4)),
    )
    expect(proof, 'TX-C1 must be proven at one strength or the other').toBeDefined()

    // THE INVARIANT is in the evidence, and it re-verified against the three independent
    // plain-SMT obligations. That re-check is what makes the invariant TEXT non-load-bearing
    // — the claim rests on the verification, not on the string.
    const evidence = proof?.evidence as unknown as
      | { readonly invariant?: string; readonly certificateVerified?: boolean }
      | undefined
    expect(evidence?.certificateVerified).toBe(true)
    expect((evidence?.invariant ?? '').length).toBeGreaterThan(0)

    // Info severity: a proof is not a build failure.
    expect(proof?.severity).toBe('info')
  })

  it('FINDS the genuine TX-C2 violation, with a trace naming the requirements in order', async () => {
    const payload = await check(conversationLockDoc())
    const violation = payload.findings.find(
      (f) => f.code === 'FND_REACHABILITY_VIOLATED' && f.requirementIds.includes(id(5)),
    )
    expect(violation, 'TX-C2 is genuinely violable and must be reported').toBeDefined()
    expect(violation?.severity).toBe('error')

    // THE TRACE, named by the author's own requirement keys rather than internal rule
    // names (v4 V29's groundwork). The defect needs TX-A3 (enqueue while held) and then
    // TX-A2 (release), so both must appear.
    const trace = (violation?.evidence as unknown as { readonly trace?: readonly string[] })?.trace
    expect(trace).toBeDefined()
    expect(trace).toContain('TX-A3')
    expect(trace).toContain('TX-A2')
    // It reads as a PATH in the message too, because that is what an author actually sees.
    expect(violation?.message).toContain('TX-A3')
    expect(violation?.message).toMatch(/->/)
  })

  it('the two verdicts DIFFER — the tier discriminates rather than answering uniformly', async () => {
    // The non-vacuity claim for the whole fixture. A tier that always said "violated" or
    // always said "proved" would pass a single-verdict test.
    const payload = await check(conversationLockDoc())
    expect(payload.reachability?.violated).toBe(1)
    expect(
      (payload.reachability?.proved ?? 0) + (payload.reachability?.provedUnderHypotheses ?? 0),
    ).toBe(1)
  })

  it('exits NON-ZERO through the existing contract, with no new wiring', async () => {
    // The error-severity reachability finding lands in `counts.error`, which is what the
    // exit-code mapping already reads. So `symspec check` on this document exits 1 because
    // of a reachability defect, and nothing in the exit contract had to learn about
    // reachability to make that happen.
    const payload = await check(conversationLockDoc())
    expect(payload.counts.error).toBeGreaterThan(0)
    expect(payload.findings.filter((f) => f.severity === 'error').map((f) => f.code)).toContain(
      'FND_REACHABILITY_VIOLATED',
    )
  })

  it('FIXING the defect removes the finding — the loop converges', async () => {
    // The agent-loop claim, and the one that makes the capability useful rather than merely
    // correct: the report is a work list. TX-C2's real fault is that TX-A2 releases the
    // lock without clearing `queued`. Fixing THAT requirement — not weakening the
    // constraint — should make the violation go away.
    const fixed = conversationLockDoc()
    const repaired: RequirementsDocument = {
      ...fixed,
      requirements: {
        ...fixed.requirements,
        [id(2)]: {
          ...(fixed.requirements[id(2)] as Requirement),
          // Release the lock AND clear the waiting flag, in one step.
          stateEffect: 'when held = 1: held := held - 1, queued := false',
        },
      },
    }
    const payload = await check(repaired)
    expect(
      payload.findings.some((f) => f.code === 'FND_REACHABILITY_VIOLATED'),
      'the fix must discharge the violation',
    ).toBe(false)
    expect(payload.reachability?.violated).toBe(0)
    // And BOTH constraints are now proven, at one strength or the other.
    expect(
      (payload.reachability?.proved ?? 0) + (payload.reachability?.provedUnderHypotheses ?? 0),
    ).toBe(2)
  })

  it('is fast enough to run in an edit loop', async () => {
    // Not a benchmark — a claim about usability. The whole point of an unbounded
    // reachability tier that runs in a fix loop is that it returns before an author's
    // attention does. The feasibility gate owns the real budget; this just refuses to let
    // the worked example become slow enough to stop being an example.
    const payload = await check(conversationLockDoc())
    expect(payload.reachability?.elapsedMs).toBeLessThan(5000)
  })
})
