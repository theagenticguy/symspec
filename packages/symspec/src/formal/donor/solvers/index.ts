/**
 * Solver orchestrator.
 *
 * Runs two tiers over a document:
 *
 *   1. free tier — exact duplicates, ambiguity (weasel words), and the
 *      pairwise candidate filter. Always runs; deterministic and in-process.
 *   2. formal tier — in-process Z3 (WASM) SMT checks. Opt-in: only runs when
 *      the caller injects a {@link FormalTier} runner (`opts.formal`). The
 *      free tier's candidate pairs are routed to it for the pairwise
 *      subsumption/redundancy checks; whole-spec checks (contradiction,
 *      vacuity) run inside the injected runner over the same requirement
 *      views. `pairsChecked` reports how many candidate pairs the formal tier
 *      actually evaluated (the formal-pair counter).
 *
 * The formal tier is INJECTED rather than imported so this module stays
 * decoupled from `../formal/*` (which already imports `./types.js`, so a
 * static dependency here would create a cycle) and so the tier can be stubbed
 * in tests. The default `check` pipeline (AC-6-8, `../pipeline/check.ts`)
 * supplies the real Z3-backed runner; when no runner is given the orchestrator
 * runs the free tier alone.
 */

import type { Doc } from '../core/doc.ts'
import { listRequirements } from '../core/doc.ts'
import { detectAmbiguity } from './free/ambiguity.ts'
import { detectExactDuplicates } from './free/duplicates.ts'
import { emitCandidatePairs } from './free/pairwise-filter.ts'
import { asView, type CandidatePair, type ReqView, type SolverFinding } from './types.ts'

/** The input a {@link FormalTier} receives: the requirement views plus the free-tier candidate pairs. */
export type FormalTierInput = {
  /** Every requirement, projected to the solver view. Whole-spec checks (contradiction/vacuity) run over this. */
  reqs: readonly ReqView[]
  /** The free-tier candidate pairs to route to the pairwise (subsumption/redundancy) checks. */
  pairs: readonly CandidatePair[]
}

/** What a {@link FormalTier} returns: solver findings plus the count of candidate pairs it evaluated. */
export type FormalTierResult = {
  /** Formal findings, already projected into the shared {@link SolverFinding} union (source `formal.smt`). */
  findings: SolverFinding[]
  /** How many candidate pairs the formal tier evaluated (the formal-pair counter). */
  pairsChecked: number
}

/**
 * An injected formal-tier runner. The default `check` pipeline supplies a
 * Z3-backed implementation; tests may stub it. Kept as a plain async function
 * so this module never statically imports `../formal/*`.
 */
export type FormalTier = (input: FormalTierInput) => Promise<FormalTierResult>

export type RunSolversOptions = {
  /** Override the lexical-similarity threshold used by the pairwise filter. */
  similarityThreshold?: number
  /** Injected formal tier. When present, the orchestrator routes candidate pairs to it. */
  formal?: FormalTier
}

export type SolverReport = {
  findings: SolverFinding[]
  candidatePairs: CandidatePair[]
  /** How many candidate pairs the formal tier evaluated. 0 when no formal tier was injected. */
  pairsChecked: number
}

export async function runSolvers(doc: Doc, opts: RunSolversOptions = {}): Promise<SolverReport> {
  const reqs = listRequirements(doc).map(asView)

  const findings: SolverFinding[] = []

  // ---- Free tier --------------------------------------------------------
  findings.push(...detectExactDuplicates(reqs))
  findings.push(...detectAmbiguity(reqs))
  const candidatePairs = emitCandidatePairs(
    reqs,
    opts.similarityThreshold !== undefined ? { similarityThreshold: opts.similarityThreshold } : {},
  )

  // ---- Formal tier (opt-in) --------------------------------------------
  let pairsChecked = 0
  if (opts.formal !== undefined) {
    const formal = await opts.formal({ reqs, pairs: candidatePairs })
    findings.push(...formal.findings)
    pairsChecked = formal.pairsChecked
  }

  return { findings, candidatePairs, pairsChecked }
}

export function summarize(report: SolverReport): string {
  const lines = [
    `${report.findings.length} finding(s); ${report.candidatePairs.length} candidate pair(s); ${report.pairsChecked} formal pair check(s).`,
  ]
  for (const f of report.findings) {
    lines.push(`  [${f.kind} / ${f.source} / ${f.confidence}] ${f.message}`)
  }
  return lines.join('\n')
}
