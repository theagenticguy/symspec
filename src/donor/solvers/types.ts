/**
 * Shared types for the solver layer.
 *
 * Solvers fall into two tiers:
 *   - free/    : deterministic, in-process, ~microseconds per pair. Run over
 *                the whole graph. Emit two things: findings, and a list of
 *                candidate pairs worth escalating to the formal tier.
 *   - formal/  : in-process Z3 (WASM) SMT checks. Contradiction and vacuity
 *                run per context-group over the whole spec; subsumption and
 *                redundancy run only over the candidate pairs the free tier
 *                flagged. A solver verdict is a proof, not a probability.
 *
 * Every finding carries:
 *   - source: which solver produced it (debugging + dedup)
 *   - confidence: "high" if formally proved OR deterministic; "low" if the
 *                 result depends on a lossy NL parse or a fuzzy heuristic.
 *   - rationale: optional human-readable reason (for the formal tier this is
 *                the solver artifact — unsat core / witness — surfaced as prose).
 */

import type { Requirement } from '../core/schema.ts'

export type Confidence = 'high' | 'low'
export type SolverSource = 'free.exact-duplicate' | 'free.weasel-words' | 'formal.smt'

export type SolverFinding =
  | {
      kind: 'ExactDuplicate'
      ids: [string, string]
      source: SolverSource
      confidence: Confidence
      message: string
    }
  | {
      kind: 'Contradiction'
      ids: [string, string]
      source: SolverSource
      confidence: Confidence
      message: string
      rationale?: string
    }
  | {
      kind: 'Subsumption'
      moreGeneral: string
      moreSpecific: string
      source: SolverSource
      confidence: Confidence
      message: string
      rationale?: string
    }
  | {
      kind: 'Ambiguity'
      id: string
      phrases: string[]
      source: SolverSource
      confidence: Confidence
      message: string
      rationale?: string
      suggestedRewrites?: string[]
    }
  | {
      kind: 'NeedsReview'
      ids: string[]
      source: SolverSource
      confidence: Confidence
      message: string
      rationale?: string
    }

/** A candidate pair the free tier has flagged for a formal (SMT) follow-up. */
export type CandidatePair = {
  a: string
  b: string
  /** Why the free tier thinks this pair is interesting. Drives which formal query runs. */
  reason:
    | 'same-system-same-trigger-different-response'
    | 'same-system-overlapping-precondition'
    | 'near-duplicate-sentence'
}

/**
 * Minimal projection of a Requirement used by solvers. Carries `negated` (the
 * persisted AC-2-4 response-polarity flag, C1) so the exact-duplicate hash and
 * the encoder path see the same polarity the stored requirement declares — a
 * negated/positive pair must NOT collapse to an exact duplicate.
 */
export type ReqView = Pick<
  Requirement,
  | 'id'
  | 'patternType'
  | 'preCondition'
  | 'trigger'
  | 'systemName'
  | 'systemResponse'
  | 'negated'
  | 'sentence'
  | 'priority'
  | 'status'
>

export function asView(r: Requirement): ReqView {
  return {
    id: r.id,
    patternType: r.patternType,
    preCondition: r.preCondition,
    trigger: r.trigger,
    systemName: r.systemName,
    systemResponse: r.systemResponse,
    negated: r.negated,
    sentence: r.sentence,
    priority: r.priority,
    status: r.status,
  }
}
