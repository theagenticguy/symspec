/**
 * Solver orchestrator.
 *
 * Stages:
 *   1. free tier — exact duplicates, ambiguity (weasel words), pairwise filter
 *   2. llm tier  — ensemble pair-judge over candidate pairs, ensemble
 *                  ambiguity-judge over every requirement (skip if free tier
 *                  already flagged the same phrase)
 *
 * The CallModel function is injected so tests can run the orchestrator
 * without hitting AWS.
 */

import type { Doc } from '../core/doc.js'
import { listRequirements } from '../core/doc.js'
import { detectAmbiguity } from './free/ambiguity.js'
import { detectExactDuplicates } from './free/duplicates.js'
import { emitCandidatePairs } from './free/pairwise-filter.js'
import type { CallArbiter } from './llm/arbiter.js'
import { type CallModel, MODELS } from './llm/bedrock-client.js'
import { ensembleAmbiguity, ensemblePair } from './llm/ensemble.js'
import { asView, type CandidatePair, type SolverFinding } from './types.js'

export type RunSolversOptions = {
  /** If provided, LLM tier runs. If omitted, only the free tier runs. */
  llm?: {
    call: CallModel
    primaryModelId?: string
    secondaryModelId?: string
    /**
     * Optional Claude Opus 4.7 arbiter. When configured, the ensemble routes
     * pairwise disagreements through extended-thinking arbitration instead of
     * emitting a NeedsReview finding.
     */
    arbiter?: CallArbiter
  }
  /** Override the lexical-similarity threshold used by the pairwise filter. */
  similarityThreshold?: number
  /** Cap on number of pairs sent to the LLM tier — guards cost. Default 50. */
  maxLlmPairs?: number
}

export type SolverReport = {
  findings: SolverFinding[]
  candidatePairs: CandidatePair[]
  llmPairsRun: number
}

export async function runSolvers(doc: Doc, opts: RunSolversOptions = {}): Promise<SolverReport> {
  const reqs = listRequirements(doc).map(asView)
  const byId = new Map(reqs.map((r) => [r.id, r]))

  const findings: SolverFinding[] = []

  // ---- Free tier --------------------------------------------------------
  findings.push(...detectExactDuplicates(reqs))
  findings.push(...detectAmbiguity(reqs))
  const candidatePairs = emitCandidatePairs(
    reqs,
    opts.similarityThreshold !== undefined ? { similarityThreshold: opts.similarityThreshold } : {},
  )

  // Drop pairs where both endpoints were already flagged as exact duplicates —
  // no point asking the LLM to confirm a deterministic finding.
  const dupedSet = new Set<string>()
  for (const f of findings) {
    if (f.kind === 'ExactDuplicate') {
      dupedSet.add(pairKey(f.ids[0], f.ids[1]))
    }
  }
  const llmCandidates = candidatePairs.filter((p) => !dupedSet.has(pairKey(p.a, p.b)))

  // ---- LLM tier ---------------------------------------------------------
  let llmPairsRun = 0
  if (opts.llm) {
    const cfg: import('./llm/ensemble.js').EnsembleConfig = {
      call: opts.llm.call,
      primaryModelId: opts.llm.primaryModelId ?? MODELS.primary,
      secondaryModelId: opts.llm.secondaryModelId ?? MODELS.secondary,
    }
    if (opts.llm.arbiter) cfg.arbiter = opts.llm.arbiter

    const cap = opts.maxLlmPairs ?? 50
    const pairsToRun = llmCandidates.slice(0, cap)

    const pairResults = await Promise.all(
      pairsToRun.map(async (p) => {
        const a = byId.get(p.a)!
        const b = byId.get(p.b)!
        return ensemblePair(cfg, a, b, p)
      }),
    )
    for (const r of pairResults) findings.push(...r)
    llmPairsRun = pairsToRun.length

    // Ambiguity: skip requirements the free tier already flagged.
    const freeAmbiguityIds = new Set(
      findings
        .filter((f) => f.kind === 'Ambiguity' && f.source === 'free.weasel-words')
        .map((f) => (f.kind === 'Ambiguity' ? f.id : '')),
    )
    const ambiguityTargets = reqs.filter((r) => !freeAmbiguityIds.has(r.id))
    const ambiguityResults = await Promise.all(
      ambiguityTargets.map((r) => ensembleAmbiguity(cfg, r)),
    )
    for (const r of ambiguityResults) findings.push(...r)
  }

  return { findings, candidatePairs, llmPairsRun }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function summarize(report: SolverReport): string {
  const lines = [
    `${report.findings.length} finding(s); ${report.candidatePairs.length} candidate pair(s); ${report.llmPairsRun} LLM pair call(s).`,
  ]
  for (const f of report.findings) {
    lines.push(`  [${f.kind} / ${f.source} / ${f.confidence}] ${f.message}`)
  }
  return lines.join('\n')
}
