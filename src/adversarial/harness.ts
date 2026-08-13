/**
 * THE GENERATIVE-ADVERSARIAL DETECTION HARNESS — escalate, detect, score, record.
 *
 * Runs the real pipeline over each labelled fixture from `./generate.ts` and scores two
 * things per case:
 *
 * - **DETECTION** — did any expected `FND_*` code fire?
 * - **LOCALIZATION** — did the finding name the planted culprit requirement ids?
 *
 * then climbs the difficulty tiers, recording which defect classes evade detection as a gap
 * report. Localization is scored separately because "something is wrong in this document" and
 * "these two requirements conflict" are different products, and only the second is usable.
 *
 * ## The generator does not author verdicts
 *
 * A fixture labels what was planted. The tool under test decides what to report, and this
 * compares the two. A harness whose generator also declared the expected verdict would be
 * marking its own homework.
 *
 * ## The embedder is INJECTED, not loaded
 *
 * The original took no argument and called a `loadEmbedder` that no longer exists, which also
 * meant it could not run without a ~110 MB download. Passing an `Embedder` (or nothing) puts
 * the seam above the expensive call — the same discipline `SolverService` and `ModelDownload`
 * follow — so the regression gate runs the deterministic tiers with no model at all, and a
 * caller with the real model can score the embedding-dependent cases too.
 *
 * Cases whose ONLY expected codes come from the embedding tier are SKIPPED rather than failed
 * when no embedder is supplied, and the skip is counted in `skipped` so a run cannot look
 * complete when it was not. A glossary-bridged contradiction needs no model: the committed
 * table plus the solver decide it.
 */

import type { Embedder } from '../donor/formal/embed.ts'
import { runCheck } from '../donor/pipeline/check.ts'
import { type AdversarialCase, type DefectKind, generateCases } from './generate.ts'

/** The codes that cannot fire without a real embedding model. */
const MODEL_ONLY_CODES: ReadonlySet<string> = new Set([
  'FND_MISSING_TRACE_LINK',
  'FND_SIMILAR_SEMANTIC',
])

/** One scored case. */
export interface CaseResult {
  readonly id: string
  readonly kind: DefectKind
  readonly tier: number
  readonly detected: boolean
  readonly localized: boolean
  readonly firedCodes: readonly string[]
}

/** A per-tier scoreboard row. */
export interface TierScore {
  readonly tier: number
  readonly total: number
  readonly detected: number
  readonly localized: number
  /** Cases not scored because they need a model this run did not have. */
  readonly skipped: number
  readonly misses: readonly CaseResult[]
}

/** Score one case: run the real pipeline, test detection and localization against the label. */
const scoreCase = async (
  testCase: AdversarialCase,
  embedder: Embedder | undefined,
): Promise<CaseResult> => {
  const report = await runCheck(
    testCase.doc,
    embedder !== undefined ? { semantic: { embedder } } : {},
  )
  const fired = report.findings.filter((f) => testCase.expectedCodes.includes(f.code))
  // LOCALIZATION: some fired finding names ALL the planted culprits, order-free. A finding
  // that named one of two would be a localization regression — the difference between a
  // report an author can act on and one that only says "look somewhere".
  const localized = fired.some((f) => {
    const ids = new Set(f.requirementIds)
    return testCase.culpritIds.every((id) => ids.has(id))
  })
  return {
    id: testCase.id,
    kind: testCase.kind,
    tier: testCase.tier,
    detected: fired.length > 0,
    localized,
    firedCodes: [...new Set(report.findings.map((f) => f.code))],
  }
}

/**
 * Run the escalating harness from tier 1 up to `maxTier`.
 *
 * Every tier runs — it does not stop at the first miss, because the gap REPORT is the product
 * and a run that halted early would hide which classes evade detection at the harder tiers.
 */
export const runHarness = async (
  maxTier = 4,
  embedder?: Embedder,
): Promise<{ readonly scores: readonly TierScore[]; readonly gaps: readonly CaseResult[] }> => {
  const scores: TierScore[] = []
  const gaps: CaseResult[] = []

  for (let tier = 1; tier <= maxTier; tier++) {
    const results: CaseResult[] = []
    let skipped = 0
    for (const testCase of generateCases(tier)) {
      if (embedder === undefined && testCase.expectedCodes.every((c) => MODEL_ONLY_CODES.has(c))) {
        skipped += 1
        continue
      }
      results.push(await scoreCase(testCase, embedder))
    }
    const misses = results.filter((r) => !r.detected)
    scores.push({
      tier,
      total: results.length,
      detected: results.filter((r) => r.detected).length,
      localized: results.filter((r) => r.localized).length,
      skipped,
      misses,
    })
    gaps.push(...misses)
  }

  return { scores, gaps }
}

/** The gap report, as the line a failing gate should print. */
export const formatGaps = (gaps: readonly CaseResult[]): string =>
  gaps
    .map(
      (g) => `[${g.kind} tier ${g.tier}] ${g.id} — fired: ${g.firedCodes.join(', ') || 'nothing'}`,
    )
    .join('\n')
