/**
 * Free solver: exact structural duplicates.
 *
 * Two requirements are exact duplicates when their full (patternType,
 * preCondition, trigger, systemName, systemResponse, negated) tuple matches.
 * `negated` is part of the key (C1): "shall X" and "shall not X" share every
 * other slot but are OPPOSITES, so they must NOT collapse to an exact
 * duplicate — that pair is a contradiction the formal tier reports, never a
 * "delete one of these" duplicate. This is cheap, deterministic, and
 * high-confidence — anything caught here doesn't need an LLM follow-up.
 */

import type { ReqView, SolverFinding } from '../types.js'

export function detectExactDuplicates(reqs: ReqView[]): SolverFinding[] {
  const groups = new Map<string, ReqView[]>()
  for (const r of reqs) {
    const key = [
      r.patternType,
      r.preCondition ?? '',
      r.trigger ?? '',
      r.systemName,
      r.systemResponse,
      r.negated === true ? 'neg' : 'pos',
    ].join('␟') // unit separator — avoid collisions with content
    const existing = groups.get(key)
    if (existing) existing.push(r)
    else groups.set(key, [r])
  }

  const findings: SolverFinding[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // Emit one finding per pair within the group (n*(n-1)/2 pairs).
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        findings.push({
          kind: 'ExactDuplicate',
          ids: [a.id, b.id],
          source: 'free.exact-duplicate',
          confidence: 'high',
          message: `Exact duplicate: "${a.sentence}"`,
        })
      }
    }
  }
  return findings
}
