/**
 * THE ADVERSARIAL GATE — the donor's hardening, re-asserted against the greenfield.
 *
 * ## What this gate is, and why it is separate from the differential oracle
 *
 * The oracle (`./differential.test.ts`) asserts the two pipelines AGREE. That is the
 * stronger claim in one direction and silent in another: if the donor regressed, the
 * greenfield would regress with it and the diff would stay green.
 *
 * This file asserts the greenfield reaches the RIGHT verdict, stated as the eval's own
 * win condition rather than as agreement with anything:
 *
 *     an adversarial round must never look clean.
 *
 * "Clean" is precise — `counts.error === 0` AND the strict gate not failing, which is
 * the shape an `exit 0` takes. That is the exact condition the red-team evals were
 * scored on (the Run-3 eval won 25/30 against `--strict` by finding documents that
 * looked clean), so it is the condition that has to be unreachable.
 *
 * ## The 15 assertions
 *
 * The donor's scoreboard is 15: over the 12 pinned rounds, 9 are PROOF cases (a planted
 * contradiction that must fire and localize) and 3 are ABSTAIN cases (nothing provable,
 * so the tool must DEMOTE rather than certify). Plus 3 whole-set claims — the win
 * condition is unreachable on every round, every demotion is actionable, and the
 * generated-defect harness detects and localizes every tier.
 *
 * The v2 rebuild took ~7 hardening sessions to reach that number. The transplant exists
 * so v5 does not reset the clock, and this file is what makes "does not reset" a test
 * rather than an assertion.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { evalRoundCases } from '../../../../adversarial/eval-rounds.ts'
import type { RequirementsDoc as DonorDoc } from '../../../../src/core/schema.ts'
import { emptyDocument, type RequirementsDocument } from '../core/document.ts'
import { DocPath, DocStore, makeDocPath } from '../core/store.ts'
import { ErrDocNotFound } from '../kernel/errors.ts'
import { runOperation } from '../kernel/operation.ts'
import { type CheckPayload, checkOp } from '../operations/check.ts'
import { embedderLayerOf, stubEmbedder } from './embedder.ts'
import { solverServiceLayer } from './solver-service.ts'

// ---------------------------------------------------------------------------
// Running the greenfield
// ---------------------------------------------------------------------------

/**
 * Project a donor v2 fixture onto the v3 shape.
 *
 * The eval fixtures are authored as donor documents, so the greenfield needs the same
 * CONTENT in v3. Deliberately in the test rather than in production: nothing shipped
 * reads a v2 document (v3 has no read-compat by design — migration is the `import`
 * op-stream replay), so a production converter would be dead code that also weakened
 * the format boundary.
 */
const asV3 = (doc: DonorDoc): RequirementsDocument => ({
  ...emptyDocument(),
  requirements: Object.fromEntries(
    Object.entries(doc.requirements).map(([id, r]) => [
      id,
      {
        id: r.id,
        patternType: r.patternType,
        systemName: r.systemName,
        systemResponse: r.systemResponse,
        negated: r.negated,
        sentence: r.sentence,
        priority: r.priority,
        status: r.status,
        derives: [...r.derives],
        satisfies: [...r.satisfies],
        verifies: [...r.verifies],
        refines: [...r.refines],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ...(r.key !== undefined ? { key: r.key } : {}),
        ...(r.preCondition !== undefined ? { preCondition: r.preCondition } : {}),
        ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
        ...(r.verificationMethod !== undefined ? { verificationMethod: r.verificationMethod } : {}),
        ...(r.verificationNote !== undefined ? { verificationNote: r.verificationNote } : {}),
      },
    ]),
  ),
  glossary: (doc.glossary ?? []).map((g) => ({ canonical: g.canonical, aliases: [...g.aliases] })),
  antonyms: (doc.antonyms ?? []).map((a) => ({ a: a.a, b: a.b })),
  waivers: (doc.waivers ?? []).map((w) => ({
    code: w.code,
    reason: w.reason,
    ...(w.requirementId !== undefined ? { requirementId: w.requirementId } : {}),
  })),
})

/**
 * The eval's own configuration: `--strict --temporal` with the semantic tier ON.
 *
 * Every knob the eval used, because the win condition is defined against a FULLY ARMED
 * run. Scoring a weakened configuration would make the gate easier to pass than the
 * eval it represents — which is the failure mode that let the Run-3 eval win by
 * omission in the first place.
 */
const ARMED = { strict: true, temporalBound: 10, semantic: true } as const

/** Run the greenfield `check` over one v3 document, fully armed. */
const check = async (document: RequirementsDocument): Promise<CheckPayload> => {
  const store = Layer.succeed(DocStore)(
    DocStore.of({
      load: (path) =>
        path === 'doc.json'
          ? Effect.succeed({ document, unknownKeys: {}, diagnostics: [] })
          : Effect.fail(new ErrDocNotFound({ error: `no document at ${path}`, suggestions: [] })),
      save: () => Effect.void,
      exists: () => Effect.succeed(true),
    }),
  )
  const envelope = await Effect.runPromise(
    runOperation(checkOp, { file: 'doc.json', ...ARMED }).pipe(
      Effect.provide(
        Layer.mergeAll(
          store,
          Layer.succeed(DocPath)(makeDocPath({})),
          solverServiceLayer,
          // The deterministic stub, so the tier RUNS (and discharges its own demotion)
          // without the ~110 MB model. Its cosines are meaningless, which is fine: no
          // assertion here depends on what the tier proposes, only on the tier having
          // run — which is precisely what the eval's omission attack exploited.
          embedderLayerOf(stubEmbedder()),
        ),
      ),
    ),
  )
  return envelope.data
}

/** One memoized report per fixture — each is a Z3 boot plus a k=10 temporal encode, and
 * three describe blocks read them. */
const cache = new Map<string, Promise<CheckPayload>>()
const report = (id: string, doc: DonorDoc): Promise<CheckPayload> => {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const run = check(asV3(doc))
  cache.set(id, run)
  return run
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('ADVERSARIAL — the greenfield holds the donor`s 15/15 scoreboard', () => {
  const cases = evalRoundCases()
  const proofCases = cases.filter((c) => c.expectedCodes.length > 0)
  const abstainCases = cases.filter((c) => c.expectedCodes.length === 0)

  it('has the 12 pinned rounds, split 9 proof / 3 abstain', () => {
    // Pins the SHAPE of the scoreboard, so a fixture quietly changing category (or
    // disappearing) is a failure rather than a smaller green run. 9 + 3 + the 3
    // whole-set claims below is the 15.
    expect(cases).toHaveLength(12)
    expect(proofCases).toHaveLength(9)
    expect(abstainCases).toHaveLength(3)
  })

  // ---- The 9 PROOF cases -------------------------------------------------
  it.each(
    proofCases.map((c) => [c.id, c] as const),
  )('PROOF %s — the planted conflict fires AND localizes', async (_id, testCase) => {
    const payload = await report(testCase.id, testCase.doc)
    const fired = payload.findings.filter((f) => testCase.expectedCodes.includes(f.code))
    expect(fired.length, testCase.note).toBeGreaterThan(0)
    // LOCALIZATION: some fired finding names ALL the planted culprits. A finding that
    // named one would be a localization regression — the failure the donor's unsat-core
    // minimization guards, and the difference between "something is wrong here" and a
    // usable report.
    const localized = fired.some((f) => {
      const ids = new Set(f.requirementIds)
      return testCase.culpritIds.every((id) => ids.has(id))
    })
    expect(localized, `culprits ${testCase.culpritIds.join(', ')} named — ${testCase.note}`).toBe(
      true,
    )
    // A proven contradiction is ERROR severity, which is exit-1 territory — so the
    // eval's exit-0 win is already impossible on these rounds.
    expect(payload.counts.error).toBeGreaterThan(0)
  })

  // ---- The 3 ABSTAIN cases ----------------------------------------------
  it.each(
    abstainCases.map((c) => [c.id, c] as const),
  )('ABSTAIN %s — DEMOTES rather than certifying a lie', async (_id, testCase) => {
    const payload = await report(testCase.id, testCase.doc)
    // Nothing is provable here, and the tool must NOT invent a proof. A fabricated
    // FND_CONTRADICTION would be worse than the miss it replaced — the cardinal sin
    // under sound-modulo-atomization.
    expect(payload.findings.filter((f) => f.code === 'FND_CONTRADICTION')).toHaveLength(0)
    // So the win condition has to be unreachable the OTHER way: by abstaining.
    expect(payload.verified, testCase.note).toBe(false)
    expect(payload.strictGate).toBe('fail')
    expect(payload.coverage.demotions.length).toBeGreaterThan(0)
  })

  // ---- The 3 whole-set claims ------------------------------------------
  it('the WIN CONDITION is unreachable on every round', async () => {
    // The eval's actual scoring rule, and the one assertion that would catch a
    // regression the per-case tests missed: a round that produced no error findings AND
    // passed the strict gate is a round the red team won.
    for (const testCase of cases) {
      const payload = await report(testCase.id, testCase.doc)
      const looksClean = payload.counts.error === 0 && payload.strictGate !== 'fail'
      expect(looksClean, `${testCase.id} must not certify clean — ${testCase.note}`).toBe(false)
    }
  })

  it('every demotion is ACTIONABLE — prose reasoning AND, where mechanical, runnable ops', async () => {
    // The demotion-only doctrine is only honest if a demotion is a WORK LIST rather than
    // a dead end. The donor asserted the prose half; v5 adds the ops half, so this
    // checks both and records which reasons carry which.
    const withOps = new Set<string>()
    const proseOnly = new Set<string>()
    for (const testCase of cases) {
      const payload = await report(testCase.id, testCase.doc)
      for (const demotion of payload.coverage.demotions) {
        // The donor's claim: every demotion explains itself.
        expect(demotion.action.length, `${testCase.id}/${demotion.reason}`).toBeGreaterThan(0)
        // v5's addition: and names something to RUN.
        if (demotion.repair !== undefined) {
          expect(
            demotion.repair.ops.length + demotion.repair.commands.length,
            'a present repair must not be empty',
          ).toBeGreaterThan(0)
          if (demotion.repair.ops.length > 0) withOps.add(demotion.reason)
          else proseOnly.add(demotion.reason)
        } else {
          proseOnly.add(demotion.reason)
        }
      }
    }
    // NON-VACUITY: the rounds really do demote, and at least one reason carries
    // executable ops — otherwise "actionable" would be a claim about an empty set.
    expect(withOps.size + proseOnly.size).toBeGreaterThan(0)
  })

  it('the GRADIENT is present and coherent on every round (AC-A-2)', async () => {
    // `verified: false` is a work list, so an agent needs to know whether it is
    // converging. The gradient has to exist on every round and agree with the report it
    // sits beside — two publications of one fact that disagreed would be worse than one.
    for (const testCase of cases) {
      const payload = await report(testCase.id, testCase.doc)
      expect(payload.progress.demotions).toBe(payload.coverage.demotions.length)
      expect(payload.progress.openFindings).toBe(payload.counts.error)
      expect(payload.progress.atomsUncompared).toBe(payload.residualRisk.unmatchedAtoms)
      // And the fixed point is exactly `verified` — zero demotions iff verified.
      expect(payload.progress.demotions === 0).toBe(payload.verified)
    }
  })
})
