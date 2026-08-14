/**
 * `FND_SIMILAR_UNUNIFIED` — the over-unification-adjacent review prompt (AC-4-12).
 *
 * The formal tier's soundness claim (AC-4-11, "sound modulo atomization GIVEN
 * conservative normalization") has exactly one false-positive risk class: two
 * DIFFERENT conditions collapsing onto one atom because normalization was too
 * aggressive. AC-4-2a's mitigation is to stay conservative (no stemming, no
 * stopword-stripping beyond a leading article, a small curated antonym table).
 * That conservatism buys soundness but costs recall the other way: genuine
 * near-synonyms that AREN'T in the seed antonym table ("log the failure" vs
 * "record the failure") stay on two distinct atoms and a real conflict can hide
 * (research-smt.md §4.3 rule 2 mitigation).
 *
 * This module does not try to fix that by unifying more aggressively — that
 * would reintroduce the over-unification risk it exists to guard against.
 * Instead it REUSES the existing Rule 3 Jaccard pass (`pairwise-filter.ts`,
 * AC-3-4) as a pure REPORTER: for every pair the Jaccard rule already flags as
 * lexically similar (≥ the shared threshold, default 0.7) it checks whether the
 * two requirements' RESPONSE atoms actually resolved to the same atom name
 * under `atomize` (AC-4-2a) — same name means "unified" regardless of polarity,
 * because an antonym-table hit (e.g. grant/revoke) is a DESIGNED unification
 * (opposite polarity, same atom), not a miss. When the names differ, symspec
 * emits an info-severity `FND_SIMILAR_UNUNIFIED` finding naming both
 * requirement ids and points the calling agent at a `symspec glossary` merge
 * for genuine synonyms the seed table missed (AC-4-12).
 *
 * ## Scope boundary
 *
 * This module never manufactures a conflict — it is strictly informational
 * (`severity: 'info'`), the correct posture for a heuristic that can only ever
 * be a hint, never a proof, that two requirements might describe the same
 * underlying condition.
 */

import { emitCandidatePairs } from '../solvers/free/pairwise-filter.ts'
import type { CandidatePair, ReqView } from '../solvers/types.ts'
import { atomize } from './atomize.ts'

/** An info-severity similar-but-not-unified finding (Appendix B `FND_SIMILAR_UNUNIFIED`). */
export interface SimilarUnunifiedFinding {
  readonly code: 'FND_SIMILAR_UNUNIFIED'
  readonly severity: 'info'
  /** Both requirement ids, in the candidate pair's stable `[a, b]` order. */
  readonly requirementIds: [string, string]
  readonly message: string
}

/**
 * A requirement projection this module accepts: {@link ReqView} plus the
 * optional parse-time `negated` flag (AC-2-4), matching the additive shape
 * `encode.ts`'s `EncodableRequirement` uses. Response-atom identity (not
 * polarity) is what this module compares, but the flag is threaded through
 * anyway so the SAME atomization the rest of the formal tier sees is used
 * here — never a polarity-blind stand-in.
 */
export type SimilarityRequirement = ReqView & { negated?: boolean }

/** Options for {@link findSimilarUnunified}. */
export interface FindSimilarUnunifiedOptions {
  /** Jaccard threshold forwarded to the Rule 3 candidate pass. Default 0.7 (AC-3-4/AC-4-12). */
  similarityThreshold?: number
}

/** The scoped RESPONSE atom name for a requirement, per AC-4-2a. Polarity-agnostic by design. */
function responseAtomName(req: SimilarityRequirement): string {
  return atomize({
    kind: 'resp',
    text: req.systemResponse,
    systemName: req.systemName,
    ...(req.negated !== undefined ? { negated: req.negated } : {}),
  }).name
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * Reuse the Rule 3 Jaccard pass over `reqs` (AC-3-4) and report, at `info`
 * severity, every candidate pair whose responses are lexically similar but
 * whose atoms did NOT unify to the same name under `atomize` (AC-4-2a).
 *
 * Only Rule 3 (`near-duplicate-sentence`) candidates are considered — Rule 1
 * (same trigger, different response) and Rule 2 (overlapping precondition) are
 * about structural relationships between DIFFERENT conditions, not lexical
 * near-synonymy, so they are out of scope for this reporter.
 */
export function findSimilarUnunified(
  reqs: readonly SimilarityRequirement[],
  options: FindSimilarUnunifiedOptions = {},
): SimilarUnunifiedFinding[] {
  const filterOpts =
    options.similarityThreshold === undefined
      ? {}
      : { similarityThreshold: options.similarityThreshold }
  const pairs: CandidatePair[] = emitCandidatePairs([...reqs], filterOpts)
  const byId = new Map(reqs.map((r) => [r.id, r] as const))

  const findings: SimilarUnunifiedFinding[] = []
  const seen = new Set<string>()

  for (const pair of pairs) {
    if (pair.reason !== 'near-duplicate-sentence') continue

    const a = byId.get(pair.a)
    const b = byId.get(pair.b)
    if (a === undefined || b === undefined) continue

    const key = pairKey(pair.a, pair.b)
    if (seen.has(key)) continue
    seen.add(key)

    const atomA = responseAtomName(a)
    const atomB = responseAtomName(b)
    // Same atom name ⇒ unified (identical text, or a seed-antonym-table hit
    // that unified them with opposite polarity by design) ⇒ no finding.
    if (atomA === atomB) continue

    findings.push({
      code: 'FND_SIMILAR_UNUNIFIED',
      severity: 'info',
      requirementIds: [pair.a, pair.b],
      message:
        `${pair.a} and ${pair.b} have lexically similar sentences (Jaccard ≥ ` +
        `${options.similarityThreshold ?? 0.7}) but their responses did not unify to the ` +
        'same atom under the conservative normalization/antonym table. If these are genuine ' +
        `synonyms (e.g. "${atomA}" vs "${atomB}"), reword one requirement's response via ` +
        '`symspec update` so both use the same phrasing, then re-run `symspec check` to ' +
        'surface any conflict the shared atom exposes.',
    })
  }

  return findings
}
