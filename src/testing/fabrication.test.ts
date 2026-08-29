/**
 * THE FABRICATION GATE — the false-positive direction, as a standing number.
 *
 * `./fabrication.ts` carries the corpus and the reason each fixture must hold. This runs
 * it: build the plan, apply everything the plan was willing to emit, re-check fully armed,
 * and count error-severity findings. That count is the metric, and it is zero.
 *
 * ## Two assertions, because one is satisfiable by doing nothing
 *
 * A planner that proposed nothing at all would pass the fabrication assertion perfectly.
 * So the gate also asserts NON-VACUITY — over the corpus, the pass must have looked: it
 * compared pairs, and it embedded every node. Without that half, deleting the planner would
 * turn this file green.
 *
 * ## The hazard is proved WITHOUT the solver
 *
 * The last two fixtures are safe only because their guards are distinct. Showing what a
 * guard merge would cost does not need Z3: `planContextGroups` is pure, and the antecedent
 * `findContradictions` needs is exactly "two requirements live in one group, their response
 * atoms equal, their polarities opposite". Asserting that composition is cheaper than a
 * solver boot and states the mechanism more precisely than a verdict would —
 * `check.test.ts` already owns the step from that antecedent to `FND_CONTRADICTION`.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { solverServiceLayer } from '../adapters/z3/solver-service.ts'
import { type CheckPayload, checkOp } from '../app/operations/check.ts'
import { runOperation } from '../app/runtime/operation.ts'
import { toEngineDoc } from '../domain/compat.ts'
import { contextAtomsOf, liveIn, planContextGroups } from '../domain/engine/formal/contradiction.ts'
import type { Embedder } from '../domain/engine/formal/embed.ts'
import { encodeIncluded } from '../domain/engine/pipeline/check.ts'
import { buildGlossaryPlan } from '../domain/glossary/glossary-plan.ts'
import type { RequirementsDocument } from '../domain/requirements/document.ts'
import { foldOps } from '../domain/requirements/mutate.ts'
import type { DocumentOp } from '../domain/requirements/ops.ts'
import { DocPath, DocStore, makeDocPath } from '../ports/doc-store.ts'
import { embedderLayerOf } from '../ports/embedder.ts'
import { ErrDocNotFound } from '../ports/errors.ts'
import { crossSlotBridgeDoc, fabricationCases, req } from './fabrication.ts'

const TS = '2026-01-01T00:00:00.000Z'

/** Unit vectors from a 2-D table, so every cosine is exactly computable. */
const tableEmbedder = (
  table: Readonly<Record<string, readonly [number, number]>>,
): Embedder & { calls: string[][] } => {
  const calls: string[][] = []
  const fn = async (texts: readonly string[]) => {
    calls.push([...texts])
    return texts.map((t) => {
      const v = table[t] ?? [1, 0]
      const n = Math.hypot(v[0], v[1]) || 1
      return Float32Array.from([v[0] / n, v[1] / n])
    })
  }
  return Object.assign(fn, { calls })
}

/**
 * The eval's own configuration — `--strict --temporal`, semantic tier on.
 *
 * The same ARMED shape `adversarial.test.ts` uses, for the same reason: scoring a weakened
 * run would make this gate easier to pass than the risk it represents.
 */
const ARMED = { strict: true, temporalBound: 10, semantic: true } as const

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
          embedderLayerOf(async (texts) => texts.map(() => Float32Array.from([1, 0]))),
        ),
      ),
    ),
  )
  // `runOperation` surfaces a failure as an Effect failure, so `runPromise` would already
  // have rejected — the envelope here is always the success shape.
  return envelope.data
}

const applyOps = (document: RequirementsDocument, ops: readonly DocumentOp[]) => {
  if (ops.length === 0) return document
  const folded = foldOps(document, ops, TS, { continueOnError: false })
  expect(
    folded.results.every((r) => r.ok),
    `the plan emitted ops the fold refused: ${JSON.stringify(folded.results)}`,
  ).toBe(true)
  return folded.document
}

/**
 * Every GUARDED requirement id, grouped by the context-group key its guard atoms produce.
 *
 * Liveness is `contradiction.ts`'s own {@link liveIn}, so this helper cannot answer the
 * co-liveness question differently from the tier it is making a claim about. The extra
 * non-empty-guard clause is this helper's own: every fixture below is safe because two GUARDS
 * are distinct, and an unconditional requirement is live in every group by definition, so
 * counting one would put a member in every row and say nothing about the guards.
 */
const groupsByKey = (document: RequirementsDocument): Map<string, string[]> => {
  const encoded = encodeIncluded(toEngineDoc(document))
  const byKey = new Map<string, string[]>()
  for (const group of planContextGroups(encoded)) {
    const live = encoded
      .filter((e) => {
        const context = contextAtomsOf(e)
        return context.length > 0 && liveIn(group, context)
      })
      .map((e) => e.id)
      .sort()
    byKey.set(group.key, live)
  }
  return byKey
}

describe('applying a whole-document glossary plan FABRICATES nothing', () => {
  for (const testCase of fabricationCases()) {
    it(`${testCase.id} — ${testCase.why.slice(0, 60)}…`, async () => {
      // A fixture may commit tables of its own. Those are applied FIRST, because the claim for
      // those cases is about what an already-committed table may do to a verdict — not about
      // what the planner proposes.
      const doc =
        testCase.committed === undefined
          ? testCase.doc
          : ({
              ...testCase.doc,
              terms: testCase.committed.terms ?? testCase.doc.terms,
              glossary: testCase.committed.glossary ?? testCase.doc.glossary,
            } as RequirementsDocument)

      const before = await check(doc)
      // A fixture that is already failing proves nothing. For a fixture with committed tables
      // this IS the assertion — the table was accepted by the CLI and must not have proven
      // anything — and for one without, it is the checker's own reading of the bare document.
      expect(
        before.counts.error,
        `the document FABRICATED ${before.counts.error} error-severity finding(s) before any ` +
          `plan was applied, and it has no conflict. Ground truth: ${testCase.why}\n` +
          JSON.stringify(
            before.findings.filter((f) => f.severity === 'error'),
            null,
            2,
          ),
      ).toBe(0)

      const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(testCase.table))

      // The FABRICATION claim first, and unconditionally. Asserting the withhold before it
      // would let the narrower expectation short-circuit the one this gate is named for —
      // so a regression that both merged wrongly AND fabricated would be reported only as
      // "the plan was not empty", which reads like a cosmetic surprise.
      const after = await check(applyOps(doc, plan.ops))
      expect(
        after.counts.error,
        `applying the plan MANUFACTURED ${after.counts.error} error-severity finding(s) in a ` +
          `document that has no conflict. Ground truth: ${testCase.why}\n` +
          JSON.stringify(
            after.findings.filter((f) => f.severity === 'error'),
            null,
            2,
          ),
      ).toBe(0)

      // Then the narrower claim: this fixture is safe because the planner DECLINED, not
      // because the merge happened to be harmless.
      if (testCase.expectsEmptyPlan) {
        expect(plan.ops, `expected a WITHHOLD, got ops: ${JSON.stringify(plan.ops)}`).toEqual([])
      }
    })
  }

  it('the corpus is NON-VACUOUS — the pass looked at every fixture', async () => {
    for (const testCase of fabricationCases()) {
      const plan = await buildGlossaryPlan(toEngineDoc(testCase.doc), tableEmbedder(testCase.table))
      // It embedded every node it found, across BOTH slot families...
      expect(plan.corpus.embedded, testCase.id).toBe(
        plan.corpus.responseNodes + plan.corpus.guardNodes,
      )
      expect(
        plan.corpus.responseNodes,
        `${testCase.id} produced no response nodes`,
      ).toBeGreaterThan(0)
      // Guard nodes are expected exactly when a guard slot exists. Read off the document
      // rather than asserted as a floor, so an unconditional fixture — which has no guard to
      // embed — is held to `0` instead of being excused from the sweep, and a guard family
      // that silently stops being embedded still fails for every fixture that has one.
      const guardSlots = Object.values(testCase.doc.requirements).filter(
        (r) => r.trigger !== undefined || r.preCondition !== undefined,
      ).length
      if (guardSlots === 0) {
        expect(
          plan.corpus.guardNodes,
          `${testCase.id} has no guard slot, so it must contribute no guard node`,
        ).toBe(0)
      } else {
        expect(plan.corpus.guardNodes, `${testCase.id} produced no guard nodes`).toBeGreaterThan(0)
      }
      // ...and it compared something, so "fabricated nothing" is not "never ran".
      expect(
        plan.corpus.pairsCompared + plan.corpus.alreadyUnified,
        `${testCase.id}: the pass neither compared a pair nor folded one — an empty plan here ` +
          'would be silence, not a withhold',
      ).toBeGreaterThan(0)
    }
  })

  it('at least one fixture reaches a deterministic WITHHOLD, not just a low cosine', async () => {
    // Without this the corpus could be green because nothing clustered, which would make the
    // gate a statement about the vectors rather than about the planner.
    const reasons: string[] = []
    for (const testCase of fabricationCases()) {
      const plan = await buildGlossaryPlan(toEngineDoc(testCase.doc), tableEmbedder(testCase.table))
      reasons.push(...plan.unresolved.map((u) => u.reason))
    }
    expect(reasons).toContain('opposition-candidate')
  })
})

/**
 * The cross-slot bridge, RECORDED rather than endorsed.
 *
 * `fabrication.ts`'s {@link crossSlotBridgeDoc} carries the document and the mechanism. This
 * pins what the tool does with it today, for one reason: the comments in
 * `formal/numeric-contradiction.ts` state the fence's real reach — same-slot-kind guards
 * cannot meet, a cross-slot bridge still puts them in one group — and a claim about this
 * package's own behavior needs a gate or it is only prose.
 *
 * Every assertion here is a statement of a GAP. A fence turns them red, and the fix is then
 * to move the document up into {@link fabricationCases}, where `counts.error === 0` is the
 * standing assertion.
 */
describe('a cross-slot bridge is a fabrication surface still open', () => {
  const A = 'ffffffff-0000-4000-8000-000000000070'
  const B = 'ffffffff-0000-4000-8000-000000000071'
  const BRIDGE = 'ffffffff-0000-4000-8000-000000000072'

  it('puts two mutually exclusive guards in one context group', async () => {
    // The mechanism, proved without the solver — the same composition the fenced fixtures use.
    // The bridge requirement's guard-atom set is a group, and `liveIn` is a subset test, so
    // both single-guard requirements are live in it alongside the bridge.
    const groups = groupsByKey(crossSlotBridgeDoc())
    const shared = [...groups.values()].filter((ids) => ids.includes(A) && ids.includes(B))
    expect(shared).toEqual([[A, B, BRIDGE]])
  })

  it('blames the two requirements that do not conflict', async () => {
    const report = await check(crossSlotBridgeDoc())
    // TWO error-severity findings on a document whose only defect is that req 72 can never
    // fire. Both tiers reach the same wrong conclusion through the same bridge group.
    expect(
      report.findings
        .filter((f) => f.severity === 'error')
        .map((f) => [f.code, f.requirementIds] as const),
    ).toEqual([
      ['FND_CONTRADICTION', [A, B]],
      ['FND_NUMERIC_CONTRADICTION', [A, B]],
    ])
    // And the honest reading of the document is present on the same run, at warn severity:
    // the bridge requirement's guard is unreachable. That finding is the whole story; the two
    // above are the fabrication.
    expect(
      report.findings.filter((f) => f.code === 'FND_VACUITY').map((f) => f.requirementIds),
    ).toEqual([[BRIDGE]])
  })
})

describe('the propose tier and the decide tier atomize the SAME document', () => {
  /**
   * The property AC-2-7 claims and nothing asserted: `encodeIncluded` (which the propose tier
   * derives its nodes from) and the main `check` closure must be the same function of the same
   * document tables.
   *
   * It rested on two textually-identical `makeAtomize(...)` expressions on two lines. Threading
   * a committed table into one and not the other is a recorded prior bug, and it was invisible:
   * `makeAtomize` takes positional arguments, so a missing third one still compiles, and no test
   * contrasted the two sites. `pipelineAtomize` now makes the divergence unrepresentable — this
   * gate is what catches it coming back.
   *
   * TWO-DIRECTIONAL by construction. A committed term that unifies two response atoms must move
   * both numbers: `check`'s own `atomsUncompared`, and the plan's `responseNodes`. Un-threading
   * either site moves exactly one of them, so neither assertion alone would localize the fault.
   */
  const twinDoc = (terms: readonly { canonical: string; aliases: string[] }[]) =>
    ({
      docVersion: 3,
      requirements: Object.fromEntries([
        req(20, 'auth service', 'the user signs in', 'issue a session token'),
        req(21, 'auth service', 'the user signs in', 'issue a login credential', true),
      ]),
      glossary: [],
      antonyms: [],
      waivers: [],
      terms,
      stateModel: { variables: [] },
    }) as unknown as RequirementsDocument

  const TWIN_TABLE = {
    'issue a session token': [1, 0] as const,
    'issue a login credential': [0, 1] as const,
    'the user signs in': [1, 0] as const,
  }

  it('a committed term moves BOTH tiers, or one of them is not seeing it', async () => {
    const withoutTerms = twinDoc([])
    const withTerms = twinDoc([{ canonical: 'session token', aliases: ['login credential'] }])

    // The DECIDE tier: `check`'s own atom roster.
    const before = await check(withoutTerms)
    const after = await check(withTerms)
    expect(before.progress.atomsUncompared, 'two distinct response atoms before the term').toBe(2)
    expect(
      after.progress.atomsUncompared,
      'the main check closure did not see `terms` — atoms stayed apart',
    ).toBe(0)

    // The PROPOSE tier: the node set derived from `encodeIncluded`.
    const planBefore = await buildGlossaryPlan(toEngineDoc(withoutTerms), tableEmbedder(TWIN_TABLE))
    const planAfter = await buildGlossaryPlan(toEngineDoc(withTerms), tableEmbedder(TWIN_TABLE))
    expect(planBefore.corpus.responseNodes, 'two response nodes before the term').toBe(2)
    expect(
      planAfter.corpus.responseNodes,
      '`encodeIncluded` did not see `terms` — the plan still sees two nodes where check sees one',
    ).toBe(1)
  })

  it('and the unified atom is what makes the conflict PROVABLE', async () => {
    // The payoff, so the gate above is not just about two counters agreeing. One committed
    // noun-phrase entry, and a contradiction the document always had becomes provable.
    const after = await check(
      twinDoc([{ canonical: 'session token', aliases: ['login credential'] }]),
    )
    expect(after.findings.map((f) => f.code)).toContain('FND_CONTRADICTION')
  })
})

describe('what a GUARD merge would cost, without booting the solver', () => {
  /**
   * These fixtures are safe only because their guards are distinct. Merging them collapses two
   * context groups into one, which is the antecedent a contradiction needs.
   *
   * `compound-guard-shared-threshold` guards on a `preCondition` rather than a `trigger`, so the
   * guard is read through {@link guardOf} — `planContextGroups` keys on `pre` and `trig` alike, so
   * the hazard does not care which one carries the condition and neither should the test.
   */
  const guardCases = [
    'mutually-exclusive-guards-opposed-response',
    'distinct-agents-same-report',
    'compound-guard-shared-threshold',
    'symbolic-threshold-split',
    'disjoint-temperature-guards',
  ]

  const guardOf = (r: { trigger?: string; preCondition?: string }): string => {
    const guard = r.trigger ?? r.preCondition
    if (guard === undefined) throw new Error('fixture requirement carries no guard slot')
    return guard
  }

  it.each(guardCases)('%s keeps its requirements in SEPARATE context groups', (id) => {
    const testCase = fabricationCases().find((c) => c.id === id)
    expect(testCase, `no fixture named ${id}`).toBeDefined()
    const groups = groupsByKey(testCase?.doc as RequirementsDocument)
    // No single group hosts both requirements, which is exactly why the document is consistent.
    const both = [...groups.values()].filter((ids) => ids.length > 1)
    expect(both, `some group already hosts both: ${JSON.stringify([...groups])}`).toEqual([])
  })

  it.each(guardCases)('%s WOULD host both once the guards are aligned', (id) => {
    const testCase = fabricationCases().find((c) => c.id === id)
    const doc = testCase?.doc as RequirementsDocument
    const guards = Object.values(doc.requirements).map(guardOf).sort()
    expect(guards).toHaveLength(2)

    // The op a guard-slot proposal would suggest, constructed by hand — nothing emits it today.
    const merged = applyOps(doc, [
      { op: 'glossary', canonical: guards[0] as string, alias: guards[1] as string },
    ])
    const groups = groupsByKey(merged)
    const both = [...groups.values()].filter((ids) => ids.length > 1)
    expect(
      both.length,
      `aligning ${JSON.stringify(guards)} should have put both requirements in one group`,
    ).toBeGreaterThan(0)

    // And the other half of the antecedent: one response atom, opposite polarities.
    const responses = encodeIncluded(toEngineDoc(merged)).flatMap((e) =>
      e.atoms.filter((a) => a.kind === 'resp').map((a) => ({ atom: a.atom, negated: a.negated })),
    )
    expect(new Set(responses.map((r) => r.atom)).size, JSON.stringify(responses)).toBe(1)
    expect(new Set(responses.map((r) => r.negated))).toEqual(new Set([true, false]))
  })
})
