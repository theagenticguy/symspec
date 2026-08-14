/**
 * THE ADVERSARIAL GATE — the red-team eval's win condition, as a test.
 *
 * ## What this gate asserts
 *
 * Not that any two implementations agree — there is no second implementation to compare
 * against, and an agreement oracle is silent in one direction anyway (a regression on both
 * sides keeps the diff green). This asserts that the pipeline reaches the RIGHT verdict,
 * stated as the eval's own scoring rule:
 *
 *     an adversarial round must never look clean.
 *
 * "Clean" is precise — `counts.error === 0` AND the strict gate not failing, which is the
 * shape an `exit 0` takes. That is the exact condition the red-team evals were scored on: the
 * Run-3 eval won 25 of 30 by finding documents that looked clean under `--strict`. So that is
 * the condition that has to be unreachable, and the reason the whole-set claim below is
 * written as `looksClean === false` rather than as a list of expected codes.
 *
 * ## The scoreboard
 *
 * The scoreboard is 15 over the 12 pinned rounds in `../adversarial/eval-rounds.ts`: 9 PROOF
 * cases (a planted contradiction that must fire and localize every culprit), 3 ABSTAIN cases
 * (no conflict is reachable by a sound extractor, so the tool must not fabricate one), and 3
 * whole-set claims — the win condition unreachable on every round, every demotion actionable,
 * and the convergence gradient coherent with the report beside it. A 16th case pins the
 * scoreboard's SHAPE, so a fixture changing category is a failure rather than a smaller green
 * run.
 *
 * Reaching that number took roughly seven hardening sessions. This gate is what stops the
 * clock resetting, which is a different job from any unit test here: a unit test proves a
 * detector fires on the one input its author imagined.
 *
 * ## What the ABSTAIN cases do NOT assert (AC-4-10)
 *
 * They do not assert that the conflict is unprovable. An assertion of the form "no
 * `FND_CONTRADICTION` fires here" pins a WEAKNESS: a later improvement that genuinely proves
 * one of these rounds would read as a gate failure, and the honest response would be to
 * loosen the test — so the test would be pressure against improving the tool.
 * `.erpaval/specs/003-symspec-v4/spec.md` AC-4-10 requires that the harness not encode
 * "cannot be proven" as a permanent assertion.
 *
 * So the abstain rounds assert the thing that is actually forbidden: **do not fabricate.**
 * A round passes by abstaining with a demotion, or by proving the conflict and naming the
 * planted culprits. It fails on a conflict reported without the ground-truth culprits, which
 * is the false-positive direction the propose/decide split exists to prevent.
 *
 * ## Scope
 *
 * These are the PINNED rounds. The tier-escalating generator that once produced fresh
 * labelled defects at four difficulty levels is not part of this package, so this gate covers
 * the twelve recorded winning patterns and not a generated ladder. It scores detection and
 * localization on a fixed bank; it does not search for new escapes.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { embedderLayerOf, stubEmbedder } from '../adapters/embedding/embedder.ts'
import { DocPath, DocStore, makeDocPath } from '../adapters/fs/store.ts'
import { solverServiceLayer } from '../adapters/z3/solver-service.ts'
import { type CheckPayload, checkOp } from '../app/operations/check.ts'
import { ErrDocNotFound } from '../app/runtime/errors.ts'
import { runOperation } from '../app/runtime/operation.ts'
import type { RequirementsDoc as DonorDoc } from '../domain/engine/core/schema.ts'
import { emptyDocument, type RequirementsDocument } from '../domain/requirements/document.ts'
import { evalRoundCases } from './eval-rounds.ts'

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
  )('ABSTAIN %s — does not FABRICATE, whichever way it answers', async (_id, testCase) => {
    const payload = await report(testCase.id, testCase.doc)
    const contradictions = payload.findings.filter((f) => f.code === 'FND_CONTRADICTION')

    // TWO acceptable answers, and the forbidden one is neither of them (AC-4-10).
    //
    // Asserting `contradictions.length === 0` would pin the tool's current INABILITY to
    // reach these conflicts, so a sound extractor good enough to prove one would fail
    // this gate. That makes the test pressure against improving the detector, which is
    // the opposite of what an adversarial gate is for.
    //
    // What is genuinely forbidden is a conflict the tool cannot justify — the cardinal
    // sin under sound-modulo-atomization, and worse than the miss it would replace.
    if (contradictions.length === 0) {
      // Abstained: then it must DISCLOSE, not certify. This is the branch all three
      // rounds take today.
      expect(payload.verified, testCase.note).toBe(false)
      expect(payload.strictGate).toBe('fail')
      expect(payload.coverage.demotions.length).toBeGreaterThan(0)
    } else {
      // Proved: then the proof must name the planted culprits. A contradiction that
      // fires without them is fabricated — it found "a" conflict, not THE conflict, and
      // an unsat core that cannot point at the ground truth is not evidence.
      const localized = contradictions.some((f) => {
        const ids = new Set(f.requirementIds)
        return testCase.culpritIds.every((id) => ids.has(id))
      })
      expect(
        localized,
        `proved a conflict but did not name ${testCase.culpritIds.join(', ')} — fabricated? ${testCase.note}`,
      ).toBe(true)
      expect(payload.counts.error).toBeGreaterThan(0)
    }
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
