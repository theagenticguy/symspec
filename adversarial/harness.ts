/**
 * Generative-adversarial detection harness (AC-34-2, AC-34-3).
 *
 * Runs `runCheck` over each labelled bad-spec fixture (adversarial/generate.ts)
 * and scores two things per case:
 *   - DETECTION: did any expected FND_* code fire?
 *   - LOCALIZATION: did the finding name the planted culprit requirement ids?
 * then escalates difficulty tier by tier until a detection miss or a tier
 * budget, recording which defect classes evade detection as a gap report.
 *
 * This is the autonomous "prove it catches increasingly subtle bad specs" loop:
 * escalate → detect → score → record, no human in the loop per round. The
 * built-in generator is deterministic, so the scoreboard is a reproducible
 * regression gate; the same harness accepts LLM-authored `{ doc, label }` cases
 * for open-ended adversarial pressure.
 *
 * Run: `pnpm exec tsx adversarial/harness.ts [--max-tier N] [--semantic]`
 */

import { loadEmbedder } from '../src/formal/embed.js'
import { runCheck } from '../src/pipeline/check.js'
import { type AdversarialCase, type DefectKind, generateCases } from './generate.js'

interface CaseResult {
  readonly id: string
  readonly kind: DefectKind
  readonly tier: number
  readonly detected: boolean
  readonly localized: boolean
  readonly firedCodes: string[]
}

/** Score one case: run check, test detection + localization against its label. */
async function scoreCase(
  c: AdversarialCase,
  embedder: Awaited<ReturnType<typeof loadEmbedder>> | undefined,
): Promise<CaseResult> {
  const report = await runCheck(
    c.doc,
    embedder !== undefined ? { semantic: { embedder } } : {},
  )
  const firedForKind = report.findings.filter((f) => c.expectedCodes.includes(f.code))
  const detected = firedForKind.length > 0
  // Localization: some fired finding names ALL planted culprits (order-free).
  const localized = firedForKind.some((f) => {
    const ids = new Set(f.requirementIds)
    return c.culpritIds.every((id) => ids.has(id))
  })
  return {
    id: c.id,
    kind: c.kind,
    tier: c.tier,
    detected,
    localized,
    firedCodes: [...new Set(report.findings.map((f) => f.code))],
  }
}

/** A per-tier scoreboard row. */
interface TierScore {
  readonly tier: number
  readonly total: number
  readonly detected: number
  readonly localized: number
  readonly misses: CaseResult[]
}

/**
 * Run the escalating harness from tier 1 up to `maxTier`. Stops early only if a
 * tier fully misses (0 detections) — otherwise runs every tier and reports the
 * gap set. `withSemantic` enables the embedding tiers (needed for paraphrase +
 * missing-link cases); when the model is unavailable those cases are skipped
 * with a logged note rather than failing the run.
 */
export async function runHarness(
  maxTier = 4,
  withSemantic = false,
): Promise<{ scores: TierScore[]; gaps: CaseResult[] }> {
  let embedder: Awaited<ReturnType<typeof loadEmbedder>> | undefined
  if (withSemantic) {
    try {
      embedder = await loadEmbedder()
    } catch {
      embedder = undefined
      // eslint-disable-next-line no-console
      console.error('[harness] embedding model unavailable — skipping semantic-dependent cases')
    }
  }

  const scores: TierScore[] = []
  const gaps: CaseResult[] = []

  for (let tier = 1; tier <= maxTier; tier++) {
    const cases = generateCases(tier)
    const results: CaseResult[] = []
    for (const c of cases) {
      // Cases whose ONLY expected codes are embedding-tier (missing-link,
      // semantic) are meaningful only with --semantic + a loaded model; skip
      // them when the model is unavailable. Glossary-bridged contradictions do
      // NOT need the model — the committed glossary + SMT decide them.
      const onlyModelCodes = c.expectedCodes.every(
        (code) => code === 'FND_MISSING_TRACE_LINK' || code === 'FND_SIMILAR_SEMANTIC',
      )
      if (onlyModelCodes && embedder === undefined) continue
      results.push(await scoreCase(c, embedder))
    }
    const detected = results.filter((r) => r.detected).length
    const localized = results.filter((r) => r.localized).length
    const misses = results.filter((r) => !r.detected)
    scores.push({ tier, total: results.length, detected, localized, misses })
    gaps.push(...misses)
  }

  return { scores, gaps }
}

/** CLI entry: run, print a scoreboard, exit non-zero if the tier-1 floor regressed. */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const maxTierArg = args.indexOf('--max-tier')
  const maxTier = maxTierArg >= 0 ? Number(args[maxTierArg + 1]) : 4
  const withSemantic = args.includes('--semantic')

  const { scores, gaps } = await runHarness(maxTier, withSemantic)

  // eslint-disable-next-line no-console
  console.log('\nAdversarial detection scoreboard')
  // eslint-disable-next-line no-console
  console.log('tier | cases | detected | localized')
  for (const s of scores) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${s.tier}  |   ${s.total}   |    ${s.detected}     |     ${s.localized}`,
    )
  }
  if (gaps.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\nGap report — defects that evaded detection:')
    for (const g of gaps) {
      // eslint-disable-next-line no-console
      console.log(`  [${g.kind} tier ${g.tier}] ${g.id} — fired: ${g.firedCodes.join(', ') || 'nothing'}`)
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\nNo detection gaps: every generated defect was caught.')
  }

  // Regression floor: tier-1 (blatant) defects that don't need the model must
  // ALL be detected, or the harness fails.
  const tier1 = scores.find((s) => s.tier === 1)
  if (tier1 && tier1.detected < tier1.total) {
    // eslint-disable-next-line no-console
    console.error(`\nREGRESSION: tier-1 detection ${tier1.detected}/${tier1.total} — floor is 100%.`)
    process.exit(1)
  }
}

// Run when invoked directly (tsx adversarial/harness.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
