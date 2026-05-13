/**
 * Two-model ensemble logic with optional Claude Opus 4.7 arbiter for
 * disagreements.
 *
 *   pairwise:
 *     - both contradiction  -> high-confidence Contradiction
 *     - both subsumption    -> high-confidence Subsumption (same direction) or low (different)
 *     - both redundant      -> high-confidence Subsumption (whichOf=null)
 *     - both compatible     -> drop
 *     - any disagreement:
 *         * arbiter configured  -> Claude Opus 4.7 extended-thinking pass produces final verdict
 *         * no arbiter          -> NeedsReview (route to human)
 *
 *   ambiguity:
 *     - both true   -> high-confidence Ambiguity
 *     - both false  -> drop
 *     - disagree    -> NeedsReview (arbiter doesn't currently handle ambiguity)
 *
 * The arbiter is async; both judges still run in parallel first, and the
 * arbiter only fires when their verdicts diverge, keeping cost bounded.
 */

import type { CandidatePair, ReqView, SolverFinding } from '../types.js'
import type { ArbitrationVerdict, CallArbiter } from './arbiter.js'
import type { CallModel } from './bedrock-client.js'
import { type AmbiguityJudgment, judgeAmbiguity } from './judge-ambiguity.js'
import { judgePair, type PairJudgment } from './judge-pair.js'

export type EnsembleConfig = {
  call: CallModel
  primaryModelId: string
  secondaryModelId: string
  /** Optional arbiter to resolve disagreements. */
  arbiter?: CallArbiter
}

// ---- Pairwise ensemble ----------------------------------------------------

export async function ensemblePair(
  cfg: EnsembleConfig,
  a: ReqView,
  b: ReqView,
  pair: CandidatePair,
): Promise<SolverFinding[]> {
  const [j1, j2] = await Promise.all([
    judgePair(cfg.call, cfg.primaryModelId, a, b, pair),
    judgePair(cfg.call, cfg.secondaryModelId, a, b, pair),
  ])

  // Agreement path — no arbiter needed.
  if (j1.judgment === j2.judgment) {
    return reconcileAgreement(a, b, j1, j2)
  }

  // Both compatible is caught above (same judgment); here we have a real
  // disagreement. Either invoke the arbiter or fall back to NeedsReview.
  if (cfg.arbiter) {
    const verdict = await cfg.arbiter({
      a,
      b,
      pair,
      primaryModelId: cfg.primaryModelId,
      primaryJudgment: j1,
      secondaryModelId: cfg.secondaryModelId,
      secondaryJudgment: j2,
    })
    return applyArbiterVerdict(a, b, j1, j2, verdict, cfg)
  }

  return [
    {
      kind: 'NeedsReview',
      ids: [a.id, b.id],
      source: 'llm.pair-judge',
      confidence: 'low',
      message: `Models disagree: primary="${j1.judgment}", secondary="${j2.judgment}"`,
      rationale: `Primary: ${j1.rationale}\nSecondary: ${j2.rationale}`,
    },
  ]
}

function reconcileAgreement(
  a: ReqView,
  b: ReqView,
  j1: PairJudgment,
  j2: PairJudgment,
): SolverFinding[] {
  const rationale = `Primary: ${j1.rationale}\nSecondary: ${j2.rationale}`
  switch (j1.judgment) {
    case 'contradiction':
      return [
        {
          kind: 'Contradiction',
          ids: [a.id, b.id],
          source: 'llm.pair-judge',
          confidence: 'high',
          message: `Two-model agreement: contradiction between "${a.sentence}" and "${b.sentence}"`,
          rationale,
        },
      ]
    case 'subsumption': {
      const same = j1.whichOf && j2.whichOf && j1.whichOf === j2.whichOf
      const moreGeneral = same ? (j1.whichOf === 'a' ? a.id : b.id) : a.id
      const moreSpecific = same ? (j1.whichOf === 'a' ? b.id : a.id) : b.id
      return [
        {
          kind: 'Subsumption',
          moreGeneral,
          moreSpecific,
          source: 'llm.pair-judge',
          confidence: same ? 'high' : 'low',
          message: same
            ? `Two-model agreement: subsumption (${moreGeneral} subsumes ${moreSpecific})`
            : `Both models say subsumption but disagree on direction — review needed`,
          rationale,
        },
      ]
    }
    case 'redundant':
      return [
        {
          kind: 'Subsumption',
          moreGeneral: a.id,
          moreSpecific: b.id,
          source: 'llm.pair-judge',
          confidence: 'high',
          message: `Two-model agreement: requirements are redundant restatements of one another`,
          rationale,
        },
      ]
    case 'compatible':
      return []
  }
}

function applyArbiterVerdict(
  a: ReqView,
  b: ReqView,
  j1: PairJudgment,
  j2: PairJudgment,
  verdict: ArbitrationVerdict,
  cfg: EnsembleConfig,
): SolverFinding[] {
  const baseRationale = [
    `Arbiter (${`sided with ${verdict.agreedWith}`}): ${verdict.rationale}`,
    verdict.caveat ? `Caveat: ${verdict.caveat}` : null,
    `Primary (${cfg.primaryModelId}, ${j1.judgment}): ${j1.rationale}`,
    `Secondary (${cfg.secondaryModelId}, ${j2.judgment}): ${j2.rationale}`,
  ]
    .filter(Boolean)
    .join('\n')

  switch (verdict.finalJudgment) {
    case 'contradiction':
      return [
        {
          kind: 'Contradiction',
          ids: [a.id, b.id],
          source: 'llm.pair-judge',
          confidence: verdict.confidence,
          message: `Arbiter (Opus 4.7) verdict: contradiction (agreed with ${verdict.agreedWith}).`,
          rationale: baseRationale,
        },
      ]
    case 'subsumption': {
      const moreGeneral = verdict.whichOf === 'a' ? a.id : b.id
      const moreSpecific = verdict.whichOf === 'a' ? b.id : a.id
      return [
        {
          kind: 'Subsumption',
          moreGeneral,
          moreSpecific,
          source: 'llm.pair-judge',
          confidence: verdict.confidence,
          message: `Arbiter (Opus 4.7) verdict: subsumption (${moreGeneral} subsumes ${moreSpecific}).`,
          rationale: baseRationale,
        },
      ]
    }
    case 'redundant':
      return [
        {
          kind: 'Subsumption',
          moreGeneral: a.id,
          moreSpecific: b.id,
          source: 'llm.pair-judge',
          confidence: verdict.confidence,
          message: `Arbiter (Opus 4.7) verdict: redundant restatement.`,
          rationale: baseRationale,
        },
      ]
    case 'compatible':
      // Arbiter says no conflict. Drop the finding entirely.
      return []
  }
}

/**
 * Exposed for unit testing the reconciliation logic without I/O.
 * Note: callers should prefer `ensemblePair` which also wires the arbiter.
 */
export function reconcilePair(
  a: ReqView,
  b: ReqView,
  j1: PairJudgment,
  j2: PairJudgment,
): SolverFinding[] {
  if (j1.judgment === j2.judgment) return reconcileAgreement(a, b, j1, j2)
  return [
    {
      kind: 'NeedsReview',
      ids: [a.id, b.id],
      source: 'llm.pair-judge',
      confidence: 'low',
      message: `Models disagree: primary="${j1.judgment}", secondary="${j2.judgment}"`,
      rationale: `Primary: ${j1.rationale}\nSecondary: ${j2.rationale}`,
    },
  ]
}

// ---- Ambiguity ensemble ---------------------------------------------------

export async function ensembleAmbiguity(cfg: EnsembleConfig, r: ReqView): Promise<SolverFinding[]> {
  const [j1, j2] = await Promise.all([
    judgeAmbiguity(cfg.call, cfg.primaryModelId, r),
    judgeAmbiguity(cfg.call, cfg.secondaryModelId, r),
  ])
  return reconcileAmbiguity(r, j1, j2)
}

export function reconcileAmbiguity(
  r: ReqView,
  j1: AmbiguityJudgment,
  j2: AmbiguityJudgment,
): SolverFinding[] {
  if (!j1.ambiguous && !j2.ambiguous) return []
  if (j1.ambiguous && j2.ambiguous) {
    const phrases = Array.from(new Set([...j1.phrases, ...j2.phrases]))
    const rewrites = Array.from(new Set([...j1.suggestedRewrites, ...j2.suggestedRewrites]))
    return [
      {
        kind: 'Ambiguity',
        id: r.id,
        phrases,
        source: 'llm.ambiguity-judge',
        confidence: 'high',
        message: `Two-model agreement: contextual ambiguity in "${r.sentence}"`,
        rationale: `Primary: ${j1.rationale}\nSecondary: ${j2.rationale}`,
        suggestedRewrites: rewrites,
      },
    ]
  }
  return [
    {
      kind: 'NeedsReview',
      ids: [r.id],
      source: 'llm.ambiguity-judge',
      confidence: 'low',
      message: `Models disagree on ambiguity: primary=${j1.ambiguous}, secondary=${j2.ambiguous}`,
      rationale: `Primary: ${j1.rationale}\nSecondary: ${j2.rationale}`,
    },
  ]
}
