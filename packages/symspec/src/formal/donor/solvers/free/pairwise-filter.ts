/**
 * Free solver: pairwise candidate filter (AC-3-4).
 *
 * A cheap O(n²) filter that avoids running expensive checks over all
 * n*(n-1)/2 pairs. It is the candidate generator for exactly one thing: the
 * PAIRWISE formal checks — subsumption and redundancy (AC-4-5). It does NOT
 * gate contradiction or vacuity — those run per-context-group over the whole
 * spec
 * (AC-4-3/AC-4-4), independent of this filter, because a contradiction can
 * involve a requirement no pair-rule flagged (context groups are not pairs).
 * Rule 3 (Jaccard) additionally feeds the info-severity
 * `FND_SIMILAR_UNUNIFIED` reporter (AC-4-12).
 *
 * Three cheap structural heuristics generate candidates:
 *
 *   1. Same systemName + same trigger but DIFFERENT response
 *        → subsumption/redundancy candidate ("same event, different reactions")
 *   2. Same systemName + overlapping precondition
 *        → subsumption candidate ("one is a more specific case of the other")
 *   3. High lexical similarity (Jaccard ≥ 0.7) in the sentence field
 *        → near-duplicate candidate (might be a redundant restatement)
 *
 * Deduping against exact duplicates: T-AC-3-1's `detectExactDuplicates`
 * already reports the exact-tuple-match pairs as `ExactDuplicate` findings.
 * This filter excludes any pair already caught there, so the same pair is
 * never double-reported as both an exact duplicate and a subsumption/
 * redundancy candidate.
 */

import type { CandidatePair, ReqView } from '../types.ts'
import { detectExactDuplicates } from './duplicates.ts'

/** Returns true if either string contains the other (case-insensitive). */
function overlaps(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la.includes(lb) || lb.includes(la)
}

/** Jaccard similarity over word sets, case-insensitive. */
function lexicalSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean))
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean))
  if (wa.size === 0 && wb.size === 0) return 1
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / (wa.size + wb.size - inter)
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * The exact-duplicate pair keys already reported by `detectExactDuplicates`
 * (T-AC-3-1). AC-3-4 requires this filter to exclude those pairs — they are
 * already a maximal-confidence finding on their own, so re-emitting them as a
 * subsumption/redundancy *candidate* would be redundant noise for the AC-4-5
 * consumer.
 */
function exactDuplicatePairKeys(reqs: ReqView[]): Set<string> {
  const keys = new Set<string>()
  for (const f of detectExactDuplicates(reqs)) {
    if (f.kind !== 'ExactDuplicate') continue
    keys.add(pairKey(f.ids[0], f.ids[1]))
  }
  return keys
}

export function emitCandidatePairs(
  reqs: ReqView[],
  opts: { similarityThreshold?: number } = {},
): CandidatePair[] {
  const threshold = opts.similarityThreshold ?? 0.7
  const pairs: CandidatePair[] = []
  const seen = new Set<string>()
  const exactDupKeys = exactDuplicatePairKeys(reqs)
  const push = (p: CandidatePair) => {
    const k = pairKey(p.a, p.b)
    if (seen.has(k)) return
    if (exactDupKeys.has(k)) return
    seen.add(k)
    pairs.push(p)
  }

  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const a = reqs[i]!
      const b = reqs[j]!

      // Skip pairs that span different systems — they can't directly
      // subsume/redundantly-restate each other at the system-behavior level.
      if (a.systemName !== b.systemName) continue

      // Rule 1: same trigger, different response → subsumption/redundancy
      // candidate (AC-4-5 decides which, or neither, via the SMT check).
      if (
        a.trigger &&
        b.trigger &&
        a.trigger.toLowerCase() === b.trigger.toLowerCase() &&
        a.systemResponse !== b.systemResponse
      ) {
        push({
          a: a.id,
          b: b.id,
          reason: 'same-system-same-trigger-different-response',
        })
        continue
      }

      // Rule 2: overlapping precondition + same/related response →
      // possible subsumption ("one is a more specific case of the other").
      if (overlaps(a.preCondition, b.preCondition)) {
        push({
          a: a.id,
          b: b.id,
          reason: 'same-system-overlapping-precondition',
        })
        continue
      }

      // Rule 3: high lexical similarity on the rendered sentence — feeds
      // AC-4-5 subsumption/redundancy AND (separately) the AC-4-12
      // FND_SIMILAR_UNUNIFIED reporter.
      if (lexicalSimilarity(a.sentence, b.sentence) >= threshold) {
        push({
          a: a.id,
          b: b.id,
          reason: 'near-duplicate-sentence',
        })
      }
    }
  }
  return pairs
}
