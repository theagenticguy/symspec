/**
 * Free solver: emit pairs of requirements worth running through the LLM judge.
 *
 * Running an LLM judge on all n*(n-1)/2 pairs is wasteful — for 200 reqs that's
 * 20k LLM calls. This pass filters to the small set of pairs that *might*
 * conflict, using cheap structural heuristics:
 *
 *   1. Same systemName + same trigger but DIFFERENT response
 *        → strong contradiction candidate ("same event, different reactions")
 *   2. Same systemName + overlapping precondition
 *        → subsumption candidate ("one is a more specific case of the other")
 *   3. High lexical similarity in the sentence field
 *        → near-duplicate candidate (might be a redundant restatement)
 *
 * The LLM tier then disambiguates each candidate. Exact duplicates are
 * removed by detectExactDuplicates before this runs, so this never re-emits
 * those.
 */

import type { CandidatePair, ReqView } from '../types.js'

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

export function emitCandidatePairs(
  reqs: ReqView[],
  opts: { similarityThreshold?: number } = {},
): CandidatePair[] {
  const threshold = opts.similarityThreshold ?? 0.7
  const pairs: CandidatePair[] = []
  const seen = new Set<string>()
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const push = (p: CandidatePair) => {
    const k = pairKey(p.a, p.b)
    if (seen.has(k)) return
    seen.add(k)
    pairs.push(p)
  }

  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const a = reqs[i]!
      const b = reqs[j]!

      // Skip pairs that span different systems — they can't directly
      // contradict each other at the system-behavior level.
      if (a.systemName !== b.systemName) continue

      // Rule 1: same trigger, different response → contradiction candidate.
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
      // possible subsumption.
      if (overlaps(a.preCondition, b.preCondition)) {
        push({
          a: a.id,
          b: b.id,
          reason: 'same-system-overlapping-precondition',
        })
        continue
      }

      // Rule 3: high lexical similarity on the rendered sentence.
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
