/**
 * Semantic paraphrase finder (AC-9-5) — the bridge from embeddings (PROPOSE) to
 * the committed glossary (DECIDE).
 *
 * For each pair of requirements under the SAME system whose response atoms did
 * NOT already unify (via atomize + antonym table + glossary), it embeds the two
 * response phrasings and, when their cosine similarity is ≥ threshold, emits an
 * info-tier `FND_SIMILAR_SEMANTIC` finding suggesting a concrete
 * `symspec glossary add` merge. It NEVER emits a conflict verdict — its only
 * durable effect is a suggestion the calling agent may confirm into the
 * glossary, after which the deterministic SMT tier can prove any real conflict
 * the shared atom exposes.
 *
 * Scope discipline (mirrors similar.ts): only responses under the same
 * `systemName` are compared — two systems with the same wording are genuinely
 * distinct atoms (AC-4-2a per-system scoping), so bridging across systems would
 * be unsound. Pairs already unified by atomize are skipped (nothing to bridge).
 */

import { type Atom, atomize } from './atomize.js'
import type { Embedder } from './embed.js'

/** An info-severity semantic-similarity finding (Appendix B `FND_SIMILAR_SEMANTIC`). */
export interface SimilarSemanticFinding {
  readonly code: 'FND_SIMILAR_SEMANTIC'
  readonly severity: 'info'
  /** Both requirement ids, lexicographically ordered for stability. */
  readonly requirementIds: [string, string]
  /** The cosine similarity that triggered the finding, rounded to 3 dp. */
  readonly cosine: number
  readonly message: string
}

/** A requirement projection this module needs: id, system, response, polarity. */
export interface SemanticRequirement {
  readonly id: string
  readonly systemName: string
  readonly systemResponse: string
  readonly negated?: boolean
  /** Optional glossary index (AC-9-2) so already-merged pairs are skipped. */
}

/** Options for {@link findSimilarSemantic}. */
export interface FindSimilarSemanticOptions {
  /** Cosine threshold to fire a finding (default 0.82, `--semantic-threshold`). */
  threshold?: number
  /** Glossary index (AC-9-2): pairs that already unify through it are skipped. */
  glossary?: ReadonlyMap<string, string>
}

const DEFAULT_THRESHOLD = 0.82

/** The scoped RESPONSE atom for a requirement, consulting the glossary (AC-9-2). */
function responseAtom(req: SemanticRequirement, glossary?: ReadonlyMap<string, string>): Atom {
  return atomize({
    kind: 'resp',
    text: req.systemResponse,
    systemName: req.systemName,
    ...(req.negated !== undefined ? { negated: req.negated } : {}),
    ...(glossary !== undefined ? { glossary } : {}),
  })
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * Embed response phrasings and report high-cosine pairs that did NOT already
 * unify to one atom. Async because embedding is (AC-9-5). Requires an injected
 * {@link Embedder} — the caller (the `check --semantic` path) loads it lazily
 * so the default `check` never touches the model.
 *
 * `cosine` is imported lazily-per-call rather than at module top so this file
 * does not pull the embed backend into the default import graph.
 */
export async function findSimilarSemantic(
  reqs: readonly SemanticRequirement[],
  embedder: Embedder,
  options: FindSimilarSemanticOptions = {},
): Promise<SimilarSemanticFinding[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  if (reqs.length < 2) return []

  const { cosine } = await import('./embed.js')

  // Embed every distinct response text once (dedup by normalized-free raw text).
  const texts = reqs.map((r) => r.systemResponse)
  const vectors = await embedder(texts)

  const findings: SimilarSemanticFinding[] = []
  const seen = new Set<string>()

  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const a = reqs[i] as SemanticRequirement
      const b = reqs[j] as SemanticRequirement
      // Same-system only (per-system atom scoping, AC-4-2a).
      if (a.systemName !== b.systemName) continue

      // Skip pairs already unified by atomize (glossary/antonym/identical).
      const atomA = responseAtom(a, options.glossary)
      const atomB = responseAtom(b, options.glossary)
      if (atomA.name === atomB.name) continue

      const key = pairKey(a.id, b.id)
      if (seen.has(key)) continue

      const va = vectors[i]
      const vb = vectors[j]
      if (va === undefined || vb === undefined) continue
      const score = cosine(va, vb)
      if (score < threshold) continue

      seen.add(key)
      const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
      findings.push({
        code: 'FND_SIMILAR_SEMANTIC',
        severity: 'info',
        requirementIds: [lo, hi],
        cosine: round3(score),
        message:
          `${lo} and ${hi} have semantically similar responses (cosine ${round3(score)} ≥ ` +
          `${threshold}) under the same system, but atomized to different atoms. If they mean ` +
          `the same thing, run \`symspec glossary add "${a.systemResponse}" "${b.systemResponse}"\` ` +
          'so the formal tier treats them as one atom, then re-run `symspec check` to surface any ' +
          'conflict the shared atom exposes. This is a suggestion, not a verdict.',
      })
    }
  }

  return findings
}
