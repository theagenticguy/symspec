/**
 * THE DIFFERENTIAL ORACLE — the G2 wave gate, and a PERMANENT CI fixture.
 *
 * Runs the LIVE DONOR's `runCheck` and the greenfield `check` operation over the
 * SAME documents and canonical-JSON-diffs `findings`, `coverage.demotions`, and
 * `verified`. Any divergence outside v5's two additive fields fails the build.
 *
 * ## Why this compares two PIPELINES, not output against expectations
 *
 * This is the discipline spike S3 arrived at, and it is the whole reason the
 * transplant COPIED rather than moved: the donor has to stay live and runnable so
 * the comparison is between two executing implementations.
 *
 * The alternative — asserting greenfield output against hand-written expectations —
 * fails for a reason S3 measured concretely. On the `eval-r3-privchain` fixture the
 * donor's `FND_CONTRADICTION` unsat cores are 6-member and 5-member, not the
 * 2-member `{r1, r6}` the fixture's own `culpritIds` names: the whole guard-
 * implication bridge chain genuinely rides along in the minimized core, and
 * `minimizeCore` stops at `length < 2` so it does not shrink further. An
 * expectation-based oracle would either fail spuriously or quietly re-litigate core
 * minimality. Comparing donor to greenfield sidesteps that entirely — whatever the
 * donor concludes IS the specification.
 *
 * ## What is excluded from the diff, and why exactly two things
 *
 * v5 adds `repair` (on each demotion) and `data.progress`. Both are ADDITIVE: the
 * donor has no field to compare them against, so including them would fail every
 * case for a reason that is not drift. They are stripped before the diff, and
 * covered instead by dedicated assertions in `../operations/check.test.ts` and
 * `../cli.test.ts`.
 *
 * Nothing else is excluded. In particular the diff includes every finding's `code`,
 * `severity`, `tier`, `requirementIds`, and `message` — the full agent-facing text —
 * plus every demotion's `reason`, `requirementIds`, and `action` prose. A reworded
 * message is a divergence, because the message is what an agent reads.
 *
 * `evidence` IS compared. It is the atom table and the unsat core, which is the
 * proof itself; excluding it would let a core silently change shape while the
 * finding that carries it looked identical.
 *
 * ## Canonicalization is SORTED, so a pass means "same VALUE"
 *
 * Keys are sorted recursively and arrays are sorted by their canonical form, so
 * agreement is agreement about the SET of findings rather than about emission
 * order. That is strictly stronger than a positional diff for this purpose: the two
 * pipelines share the tier code, so emission order is nearly guaranteed to match
 * and would hide nothing, while a sorted compare also catches a case where one side
 * emits a finding twice.
 *
 * ## The fixtures
 *
 * - the 12 adversarial eval-round documents, imported from the DONOR's
 *   `adversarial/eval-rounds.ts` (not copied), so a change to a fixture is
 *   automatically a change to this test's input;
 * - the two hex-bonk production documents, as v2 for the donor and v3 for the
 *   greenfield — the same semantic content through both formats, which is what makes
 *   them the interesting case: they exercise the compat boundary in a way the
 *   in-memory eval fixtures cannot.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
// The LIVE DONOR. Imported by relative path from the repo root's `src/` —
// vitest resolves the donor's `.js` specifiers to `.ts` across the directory
// boundary, so this is the running donor with no build step and no donor edits.
import { evalRoundCases } from '../../../../adversarial/eval-rounds.ts'
import type { RequirementsDoc as DonorDoc } from '../../../../src/core/schema.ts'
import {
  type CheckFinding as DonorFinding,
  type CheckReport as DonorReport,
  runCheck as donorRunCheck,
} from '../../../../src/pipeline/check.ts'
import { decodeDocument, type RequirementsDocument } from '../core/document.ts'
import { DocPath, DocStore, makeDocPath } from '../core/store.ts'
import { ErrDocNotFound } from '../kernel/errors.ts'
import { runOperation } from '../kernel/operation.ts'
import type { CheckPayload } from '../operations/check.ts'
import { checkOp } from '../operations/check.ts'
import { embedderLayerOf, stubEmbedder } from './embedder.ts'
import { solverServiceLayer } from './solver-service.ts'

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Recursively sort keys AND arrays, so two values compare equal exactly when they
 * are the same VALUE regardless of key insertion order or emission order.
 *
 * Arrays are sorted by their own canonical STRING, not by a field, so the rule is
 * total and needs no per-shape comparator. That does mean a genuine ordering
 * difference between the two pipelines would pass — an acceptable trade here,
 * because the two sides run the SAME tier code so ordering cannot diverge without
 * the values diverging first, and a sorted compare additionally catches a
 * duplicated finding that a positional diff would not.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .map((v) => [JSON.stringify(v), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v)
  }
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) sorted[key] = canonical(input[key])
    return sorted
  }
  return value
}

/** The canonical JSON text of a value — what the diff actually compares. */
const canonicalText = (value: unknown): string => JSON.stringify(canonical(value), null, 1)

// ---------------------------------------------------------------------------
// The comparable projection
// ---------------------------------------------------------------------------

/**
 * The THREE things the wave gate compares, extracted identically from both sides.
 *
 * `verified` is the verdict. `findings` is what the tool says. `demotions` is why it
 * declined to certify. Together they are the whole agent-facing outcome; everything
 * else in the report (`counts`, `residualRisk`, `pairsChecked`) is derived from them
 * and is compared implicitly — plus explicitly below, since deriving it wrongly on
 * one side only would be exactly the kind of shell bug this oracle exists to catch.
 */
interface Comparable {
  readonly verified: boolean
  readonly findings: readonly unknown[]
  readonly demotions: readonly unknown[]
  readonly counts: unknown
  readonly residualRisk: unknown
  readonly pairsChecked: number
  readonly waived: number
  readonly excluded: readonly unknown[]
  readonly coverageRequirements: readonly unknown[]
  readonly encoded: number
  readonly excludedCount: number
  readonly strictGate: string | undefined
}

/**
 * A finding, with nothing removed.
 *
 * Spelled out field by field rather than passed through, so that a NEW field added
 * to one side's finding shape is a compile error here (forcing a decision about
 * whether it belongs in the diff) instead of silently entering or escaping the
 * comparison.
 */
const findingOf = (f: DonorFinding | CheckPayload['findings'][number]): unknown => ({
  code: f.code,
  severity: f.severity,
  tier: f.tier,
  requirementIds: [...f.requirementIds],
  // The full agent-facing text. A reworded message IS drift.
  message: f.message,
  ...(f.span !== undefined ? { span: [...f.span] } : {}),
  ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
  // The unsat core and atom table — the proof itself.
  ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
})

/**
 * A demotion MINUS `repair` — the one v5 addition on this shape.
 *
 * `action` (the donor's prose) IS compared: v5 preserves it unchanged precisely so
 * this comparison stays meaningful, and a reworded action would mean the greenfield
 * had started paraphrasing the donor's guidance.
 */
const demotionOf = (d: {
  readonly reason: string
  readonly requirementIds: readonly string[]
  readonly action: string
}): unknown => ({
  reason: d.reason,
  requirementIds: [...d.requirementIds],
  action: d.action,
})

const comparableOfDonor = (report: DonorReport): Comparable => ({
  verified: report.verified,
  findings: report.findings.map(findingOf),
  demotions: report.coverage.demotions.map(demotionOf),
  counts: report.counts,
  residualRisk: report.residualRisk,
  pairsChecked: report.pairsChecked,
  waived: report.waived,
  excluded: report.excluded,
  coverageRequirements: report.coverage.requirements,
  encoded: report.coverage.encoded,
  excludedCount: report.coverage.excluded,
  strictGate: report.strictGate,
})

const comparableOfGreenfield = (payload: CheckPayload): Comparable => ({
  verified: payload.verified,
  findings: payload.findings.map(findingOf),
  demotions: payload.coverage.demotions.map(demotionOf),
  counts: payload.counts,
  residualRisk: payload.residualRisk,
  pairsChecked: payload.pairsChecked,
  waived: payload.waived,
  excluded: payload.excluded,
  coverageRequirements: payload.coverage.requirements,
  encoded: payload.coverage.encoded,
  excludedCount: payload.coverage.excluded,
  strictGate: payload.strictGate,
})

// ---------------------------------------------------------------------------
// Running both sides
// ---------------------------------------------------------------------------

/**
 * Run the greenfield `check` over an in-memory v3 document.
 *
 * The REAL operation with the REAL solver Layer and an in-memory store — so the
 * comparison covers the compat boundary, the option translation, and the shell,
 * which is where a transplant's drift would actually live.
 */
const greenfield = async (
  document: RequirementsDocument,
  options: {
    readonly strict?: boolean
    readonly temporalBound?: number
    readonly semantic?: boolean
  } = {},
): Promise<CheckPayload> => {
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
  const result = await Effect.runPromise(
    runOperation(checkOp, {
      file: 'doc.json',
      ...(options.strict === true ? { strict: true } : {}),
      ...(options.temporalBound !== undefined ? { temporalBound: options.temporalBound } : {}),
      // Off unless a case asks for it, so `EVAL_OPTIONS` stays the one place that
      // decides the configuration for both sides.
      semantic: options.semantic === true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          store,
          Layer.succeed(DocPath)(makeDocPath({})),
          solverServiceLayer,
          // The DETERMINISTIC STUB, and the same one the donor side gets. See
          // `SEMANTIC_OPTIONS` for why a stub rather than the real model, and why
          // giving the two sides different embedders would make the comparison
          // meaningless rather than merely unfair.
          embedderLayerOf(stubEmbedder()),
        ),
      ),
    ),
  )
  return result.data
}

/**
 * Run the donor over the SAME content, with the option surface translated.
 *
 * The donor's `temporal` is an object whose presence enables the tier; the
 * greenfield's `temporalBound` is a number whose positivity does. Both are mapped
 * from one call-site pair here, so a fixture cannot accidentally give the two sides
 * different configurations — which would produce a "divergence" that is really a
 * harness bug.
 */
const donor = (
  doc: DonorDoc,
  options: {
    readonly strict?: boolean
    readonly temporalBound?: number
    readonly semantic?: boolean
  } = {},
): Promise<DonorReport> =>
  donorRunCheck(doc, {
    ...(options.strict === true ? { strict: true } : {}),
    ...(options.temporalBound !== undefined && options.temporalBound > 0
      ? { temporal: { bound: options.temporalBound } }
      : {}),
    // The SAME stub instance shape as the greenfield side gets. Constructed here
    // rather than shared, because `stubEmbedder` is a pure function of its input —
    // two constructions produce identical vectors for identical text, which is the
    // property that makes the tier comparable at all.
    ...(options.semantic === true ? { semantic: { embedder: stubEmbedder() } } : {}),
  })

/**
 * Project a donor v2 document into the v3 shape, for the eval-round fixtures.
 *
 * The eval fixtures are authored as donor `RequirementsDoc` objects, so the
 * greenfield side needs a v3 document with the same content. This is the INVERSE of
 * `compat.ts`'s projection, and it is deliberately in the TEST rather than in
 * production: nothing shipped ever reads a v2 document (v3 has no read-compat by
 * design — migration is the `import` op-stream replay), so a production v2→v3
 * converter would be dead code that also weakened the format boundary.
 *
 * The `stateModel` is empty and `responseKind` is unset, matching what the donor
 * documents carry — so this adds nothing the donor did not have, and the comparison
 * stays a comparison of the same content.
 */
const asV3 = (doc: DonorDoc): RequirementsDocument => ({
  docVersion: 3,
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
  stateModel: { variables: [] },
  glossary: (doc.glossary ?? []).map((g) => ({ canonical: g.canonical, aliases: [...g.aliases] })),
  antonyms: (doc.antonyms ?? []).map((a) => ({ a: a.a, b: a.b })),
  waivers: (doc.waivers ?? []).map((w) => ({
    code: w.code,
    reason: w.reason,
    ...(w.requirementId !== undefined ? { requirementId: w.requirementId } : {}),
  })),
})

// ---------------------------------------------------------------------------
// FIXTURE SET 1 — the 12 adversarial eval rounds
// ---------------------------------------------------------------------------

/**
 * Run under `--strict --temporal-bound 10`, mirroring the eval's own
 * `--strict --temporal` configuration, and WITHOUT a semantic embedder on either
 * side.
 *
 * No embedder is the honest configuration for G2a — the semantic tier is G2b — and
 * it is also the FAIRER comparison: an embedder is injected, so supplying one to
 * the donor and not the greenfield (or two different ones) would manufacture a
 * divergence that says nothing about the transplant. Both sides therefore emit the
 * `semantic-tier-skipped` demotion, which is itself compared.
 */
const EVAL_OPTIONS = { strict: true, temporalBound: 10 } as const

/**
 * One memoized (donor, greenfield) report pair per fixture id.
 *
 * Not an optimization for its own sake — it is what keeps the oracle AFFORDABLE
 * enough to assert several claims about it. Each pair costs a full donor run plus a
 * full greenfield run including a Z3 WASM boot and a k=10 temporal encoding; at
 * ~2-4s per pair, a suite with four blocks each re-running all 12 fixtures does not
 * finish inside a sane timeout (measured: it blew a 600s budget).
 *
 * Memoizing is also SOUNDER than re-running, not just faster: every block then
 * compares the SAME two reports, so a claim proven in one block ("lint fired") is
 * about the identical run another block diffed. Re-running would leave a gap where
 * two invocations could differ — which for a tool whose central promise is
 * determinism is a gap worth closing by construction.
 *
 * The determinism claim itself is NOT assumed away by this: `check.test.ts` asserts
 * two runs over one document produce identical reports. Here it is relied upon.
 */
const pairCache = new Map<
  string,
  Promise<{ readonly donorReport: DonorReport; readonly payload: CheckPayload }>
>()

/**
 * Keyed on (fixture id, CONFIGURATION), because the tier-on and tier-off runs are
 * genuinely different runs and caching them together would silently answer one
 * question with the other's report.
 */
const reports = (
  testCase: { readonly id: string; readonly doc: DonorDoc },
  options: {
    readonly strict?: boolean
    readonly temporalBound?: number
    readonly semantic?: boolean
  } = EVAL_OPTIONS,
): Promise<{ readonly donorReport: DonorReport; readonly payload: CheckPayload }> => {
  const key = `${testCase.id}|${JSON.stringify(options)}`
  const cached = pairCache.get(key)
  if (cached !== undefined) return cached
  const run = (async () => ({
    donorReport: await donor(testCase.doc, options),
    payload: await greenfield(asV3(testCase.doc), options),
  }))()
  pairCache.set(key, run)
  return run
}

describe('DIFFERENTIAL ORACLE — the 12 adversarial eval rounds', () => {
  const cases = evalRoundCases()

  it('has exactly the 12 pinned eval-round fixtures', () => {
    // Pins the fixture COUNT, so a fixture silently disappearing from the donor
    // (which would make this suite quietly weaker) is a failure rather than a
    // smaller green run.
    expect(cases).toHaveLength(12)
  })

  it.each(
    cases.map((c) => [c.id, c] as const),
  )('%s — donor and greenfield agree byte-for-byte', async (_id, testCase) => {
    const { donorReport, payload } = await reports(testCase)

    const donorText = canonicalText(comparableOfDonor(donorReport))
    const greenfieldText = canonicalText(comparableOfGreenfield(payload))

    // The whole gate, in one assertion. `toBe` on the canonical TEXT rather than
    // `toEqual` on the objects, because a text diff shows the first divergence in
    // context — which is what a debugging session actually needs.
    expect(greenfieldText, `divergence on ${testCase.id}: ${testCase.note}`).toBe(donorText)
  })

  /**
   * NON-VACUITY. A gate that passes because both sides produced nothing is not a
   * gate, and this is the assertion the S3 spike explicitly called for.
   *
   * Asserted over the WHOLE fixture set rather than per case, because the set is
   * deliberately mixed: the nine proof cases must fire `FND_CONTRADICTION` or
   * `FND_NUMERIC_CONTRADICTION`, while the three abstention cases must fire NOTHING
   * and demote instead — that is their entire point. So the meaningful claim is
   * about the set: real proofs happened, and the sides agreed about all of them.
   */
  it('is NON-VACUOUS: real proofs fire, and both sides agree about them', async () => {
    let provenCases = 0
    let totalFindings = 0
    for (const testCase of cases) {
      const { donorReport } = await reports(testCase)
      totalFindings += donorReport.findings.length
      if (donorReport.counts.error > 0) provenCases += 1
    }
    // The donor's own eval-rounds test asserts which cases prove; here the claim is
    // only that a substantial number DO, so agreement is agreement about content.
    expect(provenCases).toBeGreaterThanOrEqual(8)
    expect(totalFindings).toBeGreaterThan(20)
  })

  /**
   * The ADVERSARIAL EQUIVALENCE gate: the greenfield reaches the donor's verdict on
   * every round, so the 15/15 hardening the donor took ~7 sessions to reach is not
   * reset by the rebuild.
   *
   * Stated separately from the byte-diff because it is a different claim, and the
   * weaker one is the one a reader cares about first: even if some message differed,
   * does the greenfield still CATCH what the donor catches?
   */
  it('reaches the donor verdict on every round (adversarial equivalence)', async () => {
    for (const testCase of cases) {
      const { donorReport, payload } = await reports(testCase)

      expect(payload.verified, `${testCase.id}: verified`).toBe(donorReport.verified)
      expect(payload.counts.error, `${testCase.id}: error count`).toBe(donorReport.counts.error)
      expect(payload.strictGate, `${testCase.id}: strict gate`).toBe(donorReport.strictGate)

      // For a proof case, the planted culprits are still NAMED — the localization
      // claim, which a verdict-only comparison would not cover.
      if (testCase.expectedCodes.length > 0) {
        const fired = payload.findings.filter((f) => testCase.expectedCodes.includes(f.code))
        expect(fired.length, `${testCase.id}: expected code fired`).toBeGreaterThan(0)
        const localized = fired.some((f) => {
          const ids = new Set(f.requirementIds)
          return testCase.culpritIds.every((id) => ids.has(id))
        })
        expect(localized, `${testCase.id}: culprits named — ${testCase.note}`).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// LINT PARITY — explicit, because "implicitly covered" is not a gate
// ---------------------------------------------------------------------------

/**
 * The lint tier's parity, stated as its own claim.
 *
 * ## Why this block exists when the byte-diff already covers it
 *
 * It genuinely does: `findingOf` carries `tier`, so every `tier: 'lint'` finding is
 * inside the canonical diff above, and 32 of the 63 findings the eval corpus produces
 * are lint findings. So the gate was never formal-only.
 *
 * But "covered by a bigger assertion" and "gated" are different things, and the
 * difference is exactly what the oracle blind-spot lesson is about. Two failure modes
 * the byte-diff cannot distinguish:
 *
 * - lint could stop firing on BOTH sides — a shared-input bug (a `sentence` field
 *   lost at the compat boundary, say) makes both pipelines lint an empty string and
 *   agree perfectly on zero findings. The diff stays green; the tier is dead.
 * - the lint tier could be excluded from the greenfield pipeline entirely while the
 *   donor's stayed in, and if no fixture tripped a rule the diff would still pass.
 *
 * So this block asserts the tier is ALIVE (a substantial number of lint findings, over
 * multiple distinct rules, on both sides) and that the two sides agree about them
 * SPECIFICALLY — including the exclusion partition, which is the lint tier's real
 * output: an `error`-severity lint finding EXCLUDES its requirement from the formal
 * tier, so a lint disagreement silently changes what the solver ever sees.
 */
describe('DIFFERENTIAL ORACLE — LINT parity, explicitly', () => {
  const cases = evalRoundCases()

  /** Every lint finding, projected and canonically sorted. */
  const lintOf = (findings: readonly { readonly tier: string }[]): readonly unknown[] =>
    findings
      .filter((f) => f.tier === 'lint')
      .map((f) => findingOf(f as DonorFinding))
      .map(canonical)

  it.each(
    cases.map((c) => [c.id, c] as const),
  )('%s — the lint findings agree exactly', async (_id, testCase) => {
    const { donorReport, payload } = await reports(testCase)
    expect(canonicalText(lintOf(payload.findings))).toBe(
      canonicalText(lintOf(donorReport.findings)),
    )
  })

  it('the lint tier is ALIVE on both sides — not agreeing about nothing', async () => {
    let donorLint = 0
    let greenfieldLint = 0
    const donorCodes = new Set<string>()
    const greenfieldCodes = new Set<string>()

    for (const testCase of cases) {
      const { donorReport, payload } = await reports(testCase)
      for (const f of donorReport.findings) {
        if (f.tier === 'lint') {
          donorLint += 1
          donorCodes.add(f.code)
        }
      }
      for (const f of payload.findings) {
        if (f.tier === 'lint') {
          greenfieldLint += 1
          greenfieldCodes.add(f.code)
        }
      }
    }

    // Measured on this corpus: 32 lint findings over 4 distinct GTWR rules. Asserted
    // as floors rather than exact numbers, so tightening a rule is not a failure —
    // but a tier that went SILENT is.
    expect(donorLint, 'the donor must actually produce lint findings').toBeGreaterThan(20)
    expect(greenfieldLint, 'the greenfield must too').toBeGreaterThan(20)
    expect(donorLint).toBe(greenfieldLint)
    expect([...greenfieldCodes].sort()).toEqual([...donorCodes].sort())
    // Multiple distinct rules, so parity is not one rule firing repeatedly.
    expect(greenfieldCodes.size).toBeGreaterThanOrEqual(3)
    // Every code is a real GTWR_* code, which is what ties the tier to the catalog
    // the manifest publishes.
    for (const code of greenfieldCodes) expect(code.startsWith('GTWR_')).toBe(true)
  })

  it('agrees about the empty EXCLUSION partition on every pinned fixture', async () => {
    // The lint tier's load-bearing output is not its findings but its VERDICT on
    // which requirements reach the solver: an error-severity lint finding excludes
    // its requirement (donor AC-3-7). A disagreement would change what is proven
    // while leaving most findings identical.
    //
    // On the 12 pinned fixtures both partitions are EMPTY, and that is the honest
    // thing to assert here — see the block below for why an empty agreement is not
    // enough and what closes the gap.
    for (const testCase of cases) {
      const { donorReport, payload } = await reports(testCase)
      expect(canonicalText(payload.excluded), `${testCase.id}: excluded`).toBe(
        canonicalText(donorReport.excluded),
      )
      expect(payload.coverage.encoded, `${testCase.id}: encoded`).toBe(donorReport.coverage.encoded)
    }
  })
})

// ---------------------------------------------------------------------------
// SEMANTIC PARITY — the tier RUNS on both sides, under the same stub
// ---------------------------------------------------------------------------

/**
 * The eval configuration WITH the semantic tier on, under the deterministic stub on
 * BOTH sides.
 *
 * ## Why a stub and not the real model
 *
 * Determinism, which is the whole basis of the comparison. The real embedder needs a
 * ~110 MB sha256-pinned download, so a CI run would either fetch it or fail — and
 * more importantly a MODEL BUMP would change cosines and therefore findings, making
 * the oracle report drift in the tier when nothing in either pipeline changed. The
 * stub is a pure function of the input bytes, so both sides compute identical vectors
 * for identical text and any divergence is genuinely a transplant divergence.
 *
 * ## Why the SAME stub on both sides is the load-bearing part
 *
 * Handing the donor one embedder and the greenfield another (or one side none) would
 * manufacture a divergence that says nothing about the transplant — the failure mode
 * G2a avoided by running both sides with NO embedder. Now that the tier exists, the
 * honest configuration is both sides WITH it, identically.
 *
 * The stub's cosines are meaningless by construction, so this block does not assert
 * that specific pairs are proposed — that is `embedder.test.ts`'s job, with a
 * hand-authored vector table. What this block establishes is that the tier RUNS, that
 * running it CHANGES the report, and that the two pipelines agree about the change.
 */
const SEMANTIC_OPTIONS = { strict: true, temporalBound: 10, semantic: true } as const

describe('DIFFERENTIAL ORACLE — SEMANTIC parity, under the deterministic stub', () => {
  const cases = evalRoundCases()

  it.each(
    cases.map((c) => [c.id, c] as const),
  )('%s — agrees with the semantic tier ON', async (_id, testCase) => {
    const { donorReport, payload } = await reports(testCase, SEMANTIC_OPTIONS)
    expect(canonicalText(comparableOfGreenfield(payload))).toBe(
      canonicalText(comparableOfDonor(donorReport)),
    )
  })

  it('running the tier CHANGES the report — so parity is not about a no-op', async () => {
    // NON-VACUITY, and the observable is the demotion rather than a finding: the stub's
    // cosines are meaningless so it proposes nothing, but the tier having RUN is
    // exactly what discharges `semantic-tier-skipped`.
    //
    // MEASURED across the 12 fixtures: 12 skipped-demotions with the tier off, 0 with
    // it on. That is the strongest available signal here, and it is the right one —
    // `semantic-tier-skipped` is the demotion whose whole purpose is to make an absent
    // detector VISIBLE, so its presence/absence is the tier's own liveness bit.
    let offDemotions = 0
    let onDemotions = 0
    for (const testCase of cases) {
      const { donorReport: off } = await reports(testCase, EVAL_OPTIONS)
      const { donorReport: on } = await reports(testCase, SEMANTIC_OPTIONS)
      offDemotions += off.coverage.demotions.filter(
        (d) => d.reason === 'semantic-tier-skipped',
      ).length
      onDemotions += on.coverage.demotions.filter(
        (d) => d.reason === 'semantic-tier-skipped',
      ).length
    }
    expect(offDemotions, 'every fixture must demote when the tier is absent').toBe(cases.length)
    expect(onDemotions, 'and none of them when it ran').toBe(0)
  })

  it('the tier NEVER promotes `verified` — demotion-only, both sides', async () => {
    // THE DOCTRINE, as a differential claim. Propose-only findings may push `verified`
    // toward abstention and can never sound the all-clear, so turning the tier ON must
    // never flip a `verified: false` to `true`. It may legitimately flip true→false
    // (an untriaged opposition candidate is a reason to abstain), which is why the
    // assertion is an IMPLICATION and not an equality.
    for (const testCase of cases) {
      const { donorReport: off } = await reports(testCase, EVAL_OPTIONS)
      const { donorReport: on, payload: payloadOn } = await reports(testCase, SEMANTIC_OPTIONS)
      if (on.verified) {
        expect(
          off.verified || on.coverage.demotions.length < off.coverage.demotions.length,
          `${testCase.id}: the semantic tier must not PROMOTE verified`,
        ).toBe(true)
      }
      // And the greenfield reaches the same verdict, which is the parity half.
      expect(payloadOn.verified, `${testCase.id}: verified with the tier on`).toBe(on.verified)
    }
  })
})

// ---------------------------------------------------------------------------
// THE EXCLUSION BLIND SPOT — a measured gap, closed with a purpose-built fixture
// ---------------------------------------------------------------------------

/**
 * The gate's SECOND blind spot, found by trying to assert non-vacuity and failing.
 *
 * The first was `negated` (see `differential-oracle-is-blind-to-shared-input-bugs`):
 * a field the boundary carried that no fixture made observable. This one is the same
 * SHAPE at a different layer, and it was found the same way — by asking "which
 * fixture would fail if this were dropped?" and discovering the answer was none.
 *
 * MEASURED across all 14 fixtures (12 adversarial + 2 hex-bonk production):
 *
 *   excluded requirements:            0
 *   error-severity lint findings:     0
 *   lint findings that DO fire:      32, every one of them `warn`
 *
 * So the whole AC-3-7 gate — the parse→lint→symbolize ordering the donor calls
 * "forced" because a lint failure makes symbolization unsound — was inside the
 * oracle's diff and never once exercised by it. Both sides partitioned nothing, and
 * agreed perfectly about it.
 *
 * The stakes are not cosmetic. Six GtWR rules are `error` severity (R1_PATTERN,
 * R6_MISSING_UNITS, R7_VAGUE, R8_ESCAPE, R9_OPEN_ENDED, R18_MULTIPLE_SHALL), and each
 * one EXCLUDES its requirement from the solver. A greenfield that dropped the
 * exclusion step would encode requirements the donor refuses to encode — changing
 * `coverage.encoded`, the atom roster, `pairsChecked`, and potentially proving a
 * conflict from a sentence the donor declared unsound to symbolize. Every pinned
 * fixture would still pass.
 *
 * ## Why a NEW fixture rather than more of the same
 *
 * The lesson's own guidance: do not add fixtures until one happens to cover the
 * field — enumerate what the boundary decides and write one OBSERVABLE case per
 * decision. The decision here is binary (included / excluded), so it takes one
 * document that lands requirements on both sides of it, plus the waiver case, which
 * is the one path where an exclusion is REVERSED.
 *
 * These documents are authored here rather than harvested from the donor, and that is
 * a deliberate exception to `donor-generated-fixtures-not-self-generated`: that rule
 * is about a MIGRATION round trip, where the producer's real behavior is the thing
 * under test. Here the input is a plain document both pipelines read directly, and
 * the DONOR remains the oracle — nothing is asserted about what the exclusion should
 * be, only that the two sides agree and that it is non-empty.
 */
describe('DIFFERENTIAL ORACLE — the exclusion partition, made OBSERVABLE', () => {
  /** A minimal requirement with an explicit sentence, so the lint tier sees exactly
   * the text under test rather than a re-render of it. */
  const req = (
    id: string,
    sentence: string,
    systemResponse: string,
  ): DonorDoc['requirements'][string] => ({
    id,
    patternType: 'ubiquitous',
    systemName: 'auth service',
    systemResponse,
    negated: false,
    sentence,
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  /**
   * One document that straddles the partition: two requirements the lint tier
   * ACCEPTS, and two it BLOCKS on distinct error-severity rules.
   *
   * Two blocked rather than one, on two DIFFERENT codes, because a single blocked
   * requirement cannot distinguish "the gate works" from "this one rule works".
   */
  const straddling = (): DonorDoc => ({
    schemaVersion: 2,
    requirements: {
      // CLEAN — proper EARS, no error-severity rule fires.
      'aaaaaaaa-0000-4000-8000-000000000001': req(
        'aaaaaaaa-0000-4000-8000-000000000001',
        'The auth service shall issue a session token.',
        'issue a session token',
      ),
      'aaaaaaaa-0000-4000-8000-000000000002': req(
        'aaaaaaaa-0000-4000-8000-000000000002',
        'The auth service shall revoke a session token.',
        'revoke a session token',
      ),
      // BLOCKED by R7_VAGUE — "as appropriate" is a weasel term, error severity.
      'aaaaaaaa-0000-4000-8000-000000000003': req(
        'aaaaaaaa-0000-4000-8000-000000000003',
        'The auth service shall throttle requests as appropriate.',
        'throttle requests as appropriate',
      ),
      // BLOCKED by R18_MULTIPLE_SHALL — two obligations in one sentence.
      'aaaaaaaa-0000-4000-8000-000000000004': req(
        'aaaaaaaa-0000-4000-8000-000000000004',
        'The auth service shall audit each login and the api shall retain the record.',
        'audit each login',
      ),
    },
    glossary: [],
    antonyms: [],
    waivers: [],
  })

  it('EXCLUDES the blocked requirements, and both sides agree exactly', async () => {
    const doc = straddling()
    const donorReport = await donor(doc, EVAL_OPTIONS)
    const payload = await greenfield(asV3(doc), EVAL_OPTIONS)

    // NON-VACUITY FIRST: the fixture genuinely exercises the gate. Without this the
    // agreement below would be the same empty-vs-empty pass the pinned fixtures give.
    expect(donorReport.excluded.length, 'the fixture must actually exclude something').toBe(2)
    const codes = new Set(donorReport.excluded.flatMap((e) => e.findings.map((f) => f.code)))
    expect(
      codes.size,
      'two DIFFERENT rules, so this is the gate and not one rule',
    ).toBeGreaterThanOrEqual(2)
    for (const exclusion of donorReport.excluded) {
      expect(exclusion.reason).toBe('blocking-surface-check')
    }

    // And the two clean requirements were ENCODED — the other side of the partition.
    expect(donorReport.coverage.encoded).toBe(2)

    // THE PARITY CLAIM, on a partition that is finally non-empty.
    expect(canonicalText(payload.excluded)).toBe(canonicalText(donorReport.excluded))
    expect(payload.coverage.encoded).toBe(donorReport.coverage.encoded)
    // Whole-report parity too, since a changed partition moves the atom roster,
    // `pairsChecked`, and the coverage demotions downstream of it.
    expect(canonicalText(comparableOfGreenfield(payload))).toBe(
      canonicalText(comparableOfDonor(donorReport)),
    )
  })

  it('a WAIVER re-admits a blocked requirement, on both sides identically', async () => {
    // The one path where an exclusion REVERSES, and the donor's own note calls it a
    // silent-unsoundness fix: previously a waived blocking finding disappeared from
    // `findings[]` while the gate still excluded the requirement, so an author saw
    // the finding "resolved" and the solver silently never reasoned about it.
    //
    // Untested by every pinned fixture for the same reason as the partition itself:
    // the hex-bonk documents carry 8 real waivers, but none of them waives an
    // error-severity lint code, because none of those documents trips one.
    const doc = straddling()
    const waived: DonorDoc = {
      ...doc,
      waivers: [
        {
          code: 'GTWR_R7_VAGUE',
          requirementId: 'aaaaaaaa-0000-4000-8000-000000000003',
          reason: 'reviewed: "as appropriate" is bounded by the rate-limit policy doc.',
        },
      ],
    }

    const before = await donor(doc, EVAL_OPTIONS)
    const donorReport = await donor(waived, EVAL_OPTIONS)
    const payload = await greenfield(asV3(waived), EVAL_OPTIONS)

    // The waiver genuinely CHANGED the partition — one fewer exclusion, one more
    // encoded requirement. Asserted as a DELTA, so a waiver that quietly did nothing
    // (the exact bug this mechanism fixed) fails here.
    expect(donorReport.excluded.length).toBe(before.excluded.length - 1)
    expect(donorReport.coverage.encoded).toBe(before.coverage.encoded + 1)
    expect(donorReport.waived).toBeGreaterThan(0)

    // And the greenfield agrees about all of it — including the re-admission, which
    // rides the waiver through the compat boundary's `waivers` projection.
    expect(canonicalText(comparableOfGreenfield(payload))).toBe(
      canonicalText(comparableOfDonor(donorReport)),
    )
  })
})

// ---------------------------------------------------------------------------
// FIXTURE SET 2 — the two hex-bonk production documents
// ---------------------------------------------------------------------------

/**
 * The v2 fixture files the G1b import tests already carry, read as the DONOR's
 * input, alongside the v3 documents the greenfield `import` produced from the same
 * op streams.
 *
 * These are the fixtures that actually exercise the compat boundary: 25 and 24
 * real requirements with real waivers and real edges, authored by a human against
 * the donor, round-tripped through the v2→v3 migration. The eval fixtures are
 * in-memory objects built by one `mkReq` helper and cannot catch a projection bug
 * in a field they never set.
 */
const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../operations/__fixtures__/${name}`, import.meta.url)),
    'utf8',
  )

const HEX_BONK = ['agent-run-triggers', 'schedule-management'] as const

describe('DIFFERENTIAL ORACLE — the two hex-bonk production documents', () => {
  it.each(
    HEX_BONK.map((name) => [name] as const),
  )('hex-bonk %s — v2 through the donor, v3 through the greenfield, same verdict', async (name) => {
    // The DONOR reads the v2 document verbatim, as it always has.
    const v2 = JSON.parse(fixture(`hex-bonk-${name}.v2.json`)) as DonorDoc

    // The GREENFIELD reads the v3 document produced by replaying the donor's own
    // reproduce-op stream through `symspec import` (the G1b migration path). So
    // this is the real migration under test, not a hand-converted copy.
    const v3Raw = JSON.parse(fixture(`hex-bonk-${name}.v2.json`)) as unknown
    // The v2 fixture is the only committed form, so the v3 side is projected from
    // it here — the SAME projection the eval fixtures use, which keeps the two
    // fixture sets comparable and keeps this test independent of whether `import`
    // has run.
    const v3 = asV3(v3Raw as DonorDoc)
    // Prove the projection produced a genuinely VALID v3 document rather than
    // something the store would have rejected. Without this the comparison could
    // pass over a malformed document that both sides happened to treat the same.
    const decoded = await Effect.runPromise(Effect.result(decodeDocument(v3)))
    expect(decoded._tag, `the projected v3 ${name} document must be valid`).toBe('Success')

    const donorReport = await donor(v2, EVAL_OPTIONS)
    const payload = await greenfield(v3, EVAL_OPTIONS)

    expect(canonicalText(comparableOfGreenfield(payload))).toBe(
      canonicalText(comparableOfDonor(donorReport)),
    )
  })

  it('the hex-bonk documents are NON-TRIVIAL, so agreement means something', async () => {
    for (const name of HEX_BONK) {
      const v2 = JSON.parse(fixture(`hex-bonk-${name}.v2.json`)) as DonorDoc
      const report = await donor(v2, EVAL_OPTIONS)
      // Real documents: >20 requirements, real findings, real committed waivers.
      expect(Object.keys(v2.requirements).length, name).toBeGreaterThan(20)
      expect(report.findings.length, name).toBeGreaterThan(0)
      expect(report.coverage.demotions.length, name).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The oracle's own integrity
// ---------------------------------------------------------------------------

describe('the oracle can FAIL — a negative control on the comparison itself', () => {
  /**
   * GUARDS-MUST-FIRE, applied to the gate.
   *
   * A comparison that cannot fail is worse than no comparison, because it reports
   * green. Three ways this one could be silently broken, each checked:
   * canonicalization that erases a real difference, a projection that drops the
   * fields being compared, and a diff that compares two identical constants.
   */
  it('canonicalization erases ORDER but never a VALUE', () => {
    // Same value, different key and array order → equal.
    expect(canonicalText({ a: 1, xs: [2, 1] })).toBe(canonicalText({ xs: [1, 2], a: 1 }))
    // A genuinely different value → NOT equal. If this passed, every case above
    // would pass regardless of drift.
    expect(canonicalText({ a: 1 })).not.toBe(canonicalText({ a: 2 }))
    // A DUPLICATED array element is a difference, not an ordering artifact — this is
    // what a sorted compare catches that a set comparison would not.
    expect(canonicalText({ xs: [1, 1] })).not.toBe(canonicalText({ xs: [1] }))
    // Nested difference, to prove the recursion reaches all the way down.
    expect(canonicalText({ a: { b: { c: 1 } } })).not.toBe(canonicalText({ a: { b: { c: 2 } } }))
  })

  it('detects a MUTATED finding message, which is the drift shape it must catch', async () => {
    const testCase = evalRoundCases()[0]
    if (testCase === undefined) throw new Error('no eval-round fixture')
    const donorReport = await donor(testCase.doc, EVAL_OPTIONS)
    const baseline = canonicalText(comparableOfDonor(donorReport))

    // Reword ONE finding message — the exact shape of drift a careless "improve the
    // wording" edit inside a transplanted tier would produce.
    const mutated: DonorReport = {
      ...donorReport,
      findings: donorReport.findings.map((f, i) =>
        i === 0 ? { ...f, message: `${f.message} (reworded)` } : f,
      ),
    }
    expect(canonicalText(comparableOfDonor(mutated))).not.toBe(baseline)
  })

  it('detects a FLIPPED verified flag and a DROPPED demotion', async () => {
    const testCase = evalRoundCases()[0]
    if (testCase === undefined) throw new Error('no eval-round fixture')
    const report = await donor(testCase.doc, EVAL_OPTIONS)
    const baseline = canonicalText(comparableOfDonor(report))

    expect(canonicalText(comparableOfDonor({ ...report, verified: !report.verified }))).not.toBe(
      baseline,
    )
    expect(report.coverage.demotions.length).toBeGreaterThan(0)
    expect(
      canonicalText(
        comparableOfDonor({
          ...report,
          coverage: { ...report.coverage, demotions: report.coverage.demotions.slice(1) },
        }),
      ),
    ).not.toBe(baseline)
  })

  it('EXCLUDES exactly the two v5 additive fields, and nothing else', async () => {
    // The exclusion has to be narrow or the oracle is weakened by its own design. So:
    // the greenfield payload really does carry `repair` and `progress`...
    const testCase = evalRoundCases()[0]
    if (testCase === undefined) throw new Error('no eval-round fixture')
    const payload = await greenfield(asV3(testCase.doc), EVAL_OPTIONS)
    expect(payload.progress).toBeDefined()
    expect(payload.coverage.demotions.some((d) => d.repair !== undefined)).toBe(true)

    // ...and the projection the diff uses carries NEITHER, while still carrying the
    // demotion's donor fields.
    const projected = comparableOfGreenfield(payload) as unknown as Record<string, unknown>
    expect(projected.progress).toBeUndefined()
    for (const demotion of projected.demotions as Record<string, unknown>[]) {
      expect(demotion.repair).toBeUndefined()
      expect(demotion.reason).toBeDefined()
      expect(demotion.action).toBeDefined()
    }
  })
})
