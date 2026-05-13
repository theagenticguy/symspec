/**
 * Shared types for the solver layer.
 *
 * Solvers fall into two tiers:
 *   - free/    : deterministic, in-process, ~microseconds per pair. Run over
 *                the whole graph. Emit two things: findings, and a list of
 *                candidate pairs worth escalating to the LLM tier.
 *   - llm/     : Bedrock-backed judges using two models in parallel. Each
 *                call is seconds and costs a few tenths of a cent. We only
 *                run them on pairs the free tier already flagged.
 *
 * Every finding carries:
 *   - source: which solver produced it (debugging + dedup)
 *   - confidence: "high" if deterministic OR both LLMs agreed; "low" if only
 *                 one LLM said so or the structural heuristic is fuzzy.
 *   - rationale: optional human-readable reason (LLM-produced for the LLM tier).
 */

import type { Requirement } from '../core/schema.js'

export type Confidence = 'high' | 'low'
export type SolverSource =
  | 'free.exact-duplicate'
  | 'free.contradiction-candidate'
  | 'free.subsumption-candidate'
  | 'free.weasel-words'
  | 'llm.pair-judge'
  | 'llm.ambiguity-judge'

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

/** A candidate pair the free tier has flagged for LLM follow-up. */
export type CandidatePair = {
  a: string
  b: string
  /** Why the free tier thinks this pair is interesting. Drives the LLM prompt. */
  reason:
    | 'same-system-same-trigger-different-response'
    | 'same-system-overlapping-precondition'
    | 'near-duplicate-sentence'
}

/** Minimal projection of a Requirement used by solvers. */
export type ReqView = Pick<
  Requirement,
  | 'id'
  | 'patternType'
  | 'preCondition'
  | 'trigger'
  | 'systemName'
  | 'systemResponse'
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
    sentence: r.sentence,
    priority: r.priority,
    status: r.status,
  }
}
