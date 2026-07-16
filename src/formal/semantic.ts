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

import { ANTONYM_INDEX, type AntonymEntry } from './antonyms.js'
import { type Atom, atomize, deInflectHead, normalize } from './atomize.js'
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
  /**
   * Optional trigger clause. When two high-cosine responses fire under the SAME
   * system AND the SAME trigger, the pair is a candidate for opposition (polar
   * opposites), not just synonymy — so `findSimilarSemantic` extends its message
   * to ALSO point at `antonym add` in that case. Callers pass the stored trigger
   * (a `ReqView` already carries it); omitted ⇒ the antonym hint is not added.
   * Declared `string | undefined` (not merely optional) so a `ReqView` — whose
   * `trigger` is `string | undefined` — is assignable under
   * `exactOptionalPropertyTypes`.
   */
  readonly trigger?: string | undefined
}

/** Options for {@link findSimilarSemantic}. */
export interface FindSimilarSemanticOptions {
  /**
   * Cosine threshold to fire a finding (default {@link DEFAULT_SEMANTIC_THRESHOLD},
   * overridable via `--semantic-threshold`).
   */
  threshold?: number
  /** Glossary index (AC-9-2): pairs that already unify through it are skipped. */
  glossary?: ReadonlyMap<string, string>
}

/**
 * Default cosine similarity above which a same-system, un-unified response pair
 * is proposed as a glossary merge (`FND_SIMILAR_SEMANTIC`).
 *
 * ## What the number measures
 *
 * A cosine over CLS-pooled, L2-normalized `Xenova/bge-base-en-v1.5` embeddings
 * (see {@link Embedder} / `embed.ts`). The pair's raw response phrasings are
 * embedded with NO instruction prefix — BGE was trained with a retrieval query
 * prefix ("Represent this sentence for searching relevant passages:"), so
 * symmetric raw-text pairs score MORE COMPRESSED than the numbers quoted from
 * BGE retrieval benchmarks. Do not calibrate this threshold against those
 * benchmark figures; calibrate it against the real same-model, same-pooling,
 * no-prefix band below.
 *
 * ## Measured separation band (this model + CLS pooling + no prefix)
 *
 * Measured over generic requirement-response pairs with the repo's own embedder
 * (`loadEmbedder`), cosines cluster into two clearly separated bands:
 *   - Unrelated same-domain pairs (different intent): ~0.44–0.58 — the noise
 *     floor.
 *   - Divergent-wording paraphrases (same intent, different head nouns/verbs):
 *     ~0.75–0.79, e.g. "issue a session token" vs "issue a login credential"
 *     ≈ 0.75, "reject the connection" vs "deny the request" ≈ 0.77.
 *   - Near-identical paraphrases: ~0.87–0.89.
 *
 * The old default of 0.82 sat ABOVE the divergent-paraphrase band, so every
 * genuine same-intent pair with different word choice was silently missed and
 * only near-verbatim restatements ever fired.
 *
 * ## Why 0.72
 *
 * 0.72 sits below the divergent-paraphrase band (capturing the ~0.75 pairs, with
 * a little headroom for slight wording variants) while keeping a ~0.14 margin
 * above the ~0.58 unrelated-same-domain noise floor. This tier is PROPOSE-only:
 * a `FND_SIMILAR_SEMANTIC` finding is an info-tier suggestion to add a glossary
 * entry — it NEVER decides a verdict. A false suggestion costs the agent one
 * ignored glossary line; a MISS hides a real paraphrased conflict the SMT tier
 * could then prove. That asymmetry means recall is worth far more than precision
 * here, so we tune to the recall-favoring edge of the safe gap rather than the
 * middle.
 *
 * Overridable per-run via `--semantic-threshold` (mapped to
 * {@link FindSimilarSemanticOptions.threshold}).
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.72

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
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD
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

      // When the two responses fire under the SAME trigger (not just the same
      // system), high cosine is equally consistent with them being polar
      // OPPOSITES (antonyms embed close — shared topic — so cosine cannot tell
      // opposites from synonyms). In that case also point at `antonym add`, so an
      // agent triaging a same-trigger paraphrase is not railroaded toward
      // `glossary add` when the pair might really be a contradiction. Reuse the
      // same head-extraction as findOppositionCandidates for a concrete verb
      // suggestion; fall back to a generic pointer if a clean head is unavailable.
      const sameTrigger =
        a.trigger !== undefined &&
        b.trigger !== undefined &&
        normalize(a.trigger) === normalize(b.trigger)
      let antonymHint = ''
      if (sameTrigger) {
        const [headA] = fuseNegatingPrefix(normalize(a.systemResponse))
        const [headB] = fuseNegatingPrefix(normalize(b.systemResponse))
        antonymHint =
          headA !== '' && headB !== '' && headA !== headB
            ? ` These fire under the SAME trigger, so if they are polar OPPOSITES rather than ` +
              `synonyms, run \`symspec antonym add ${headA} ${headB}\` instead — the formal tier ` +
              'will then collapse them to one atom at opposite polarity and can prove the conflict.'
            : ' These fire under the SAME trigger, so if these responses are opposites rather than ' +
              'synonyms, register an antonym instead (see `symspec antonym add`).'
      }

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
          `conflict the shared atom exposes.${antonymHint} This is a suggestion, not a verdict.`,
      })
    }
  }

  return findings
}

/** An info-severity opposition-candidate finding (Appendix B `FND_OPPOSITION_CANDIDATE`). */
export interface OppositionCandidateFinding {
  readonly code: 'FND_OPPOSITION_CANDIDATE'
  readonly severity: 'info'
  /** Both requirement ids, lexicographically ordered for stability. */
  readonly requirementIds: [string, string]
  /** The two differing verb heads, ordered `[a, b]` as they should be committed. */
  readonly verbs: [string, string]
  /** The cosine similarity that confirmed topical relatedness, rounded to 3 dp. */
  readonly cosine: number
  readonly message: string
}

/**
 * Default cosine FLOOR above which two same-object/different-verb responses are
 * topically related enough to propose as an opposition candidate (#6).
 *
 * ## Why a FLOOR, and why cosine is only a confirmation here
 *
 * Cosine CANNOT distinguish antonymy from synonymy — antonyms embed CLOSE
 * (shared context/topic), not far. So low cosine does NOT signal opposition; it
 * signals unrelatedness. The load-bearing opposition signal is DETERMINISTIC:
 * two same-system responses that share an object remainder but differ on the
 * leading verb and did not already unify through the antonym/glossary tables.
 * Cosine is used only as a topical-relatedness FLOOR — to drop pairs whose
 * shared object is coincidental noise — never as the primary signal. The floor
 * is deliberately generous (below the synonym band) because the deterministic
 * structural match already carries the precision.
 */
export const DEFAULT_OPPOSITION_COSINE_FLOOR = 0.5

/** Split a normalized response body into `[head, rest]` (rest keeps no leading `_`). */
function headAndRest(body: string): [string, string] {
  const sep = body.indexOf('_')
  if (sep === -1) return [body, '']
  return [body.slice(0, sep), body.slice(sep + 1)]
}

/**
 * Split a normalized response body into a DE-INFLECTED head and rest, fusing a
 * standalone negating-prefix token back onto the verb it modifies: normalize
 * turns "de-energize the coil" into `de_energize_the_coil`, whose first token
 * is just `de`; this reassembles the head as `de_energize` so it compares
 * against "energizes the coil" (head `energize`) as a prefix pair.
 */
function fuseNegatingPrefix(body: string): [string, string] {
  const tokens = body.split('_')
  const first = tokens[0] ?? ''
  if ((first === 'de' || first === 'un' || first === 'dis') && tokens.length >= 2) {
    const head = `${first}_${deInflectHead(tokens[1] as string)}`
    return [head, tokens.slice(2).join('_')]
  }
  const [head, rest] = headAndRest(body)
  return [deInflectHead(head), rest]
}

/**
 * True when two de-inflected verb heads relate by a negating prefix —
 * `de-`/`un-`/`dis-` — i.e. one is exactly the other with the prefix attached
 * (energize/de_energize → deenergize after normalize drops the hyphen? No:
 * normalize turns "de-energize" into `de_energize`, whose HEAD token is `de`,
 * so multiword-head handling upstream fuses it; here we compare the fused or
 * plain heads: seal/unseal, engage/disengage, energize/deenergize). Purely
 * structural and deterministic — no embedding involved — so a prefix pair is
 * proposed as an opposition candidate even below the topical cosine floor.
 */
function isNegatingPrefixPair(a: string, b: string): boolean {
  const plain = (s: string) => s.replace(/_/g, '')
  const pa = plain(a)
  const pb = plain(b)
  for (const prefix of ['de', 'un', 'dis']) {
    if (pa === prefix + pb || pb === prefix + pa) return true
  }
  return false
}

/**
 * Propose opposition candidates (#6): same-system response pairs that share an
 * object remainder but differ on the leading verb and are NOT already unified as
 * antonyms. Propose-only (info-tier) — it suggests `symspec antonym add`, which
 * is what actually changes a verdict, mirroring how `FND_SIMILAR_SEMANTIC`
 * suggests `glossary add`. Reuses the SAME embedder as the paraphrase pass; the
 * cosine is only a topical-relatedness floor (see {@link DEFAULT_OPPOSITION_COSINE_FLOOR}).
 *
 * The `antonyms` index (default {@link ANTONYM_INDEX}, or a doc-augmented one) is
 * consulted so a pair the antonym tables ALREADY unify is skipped — that pair is
 * a proven-or-provable conflict, not a candidate needing confirmation.
 */
export async function findOppositionCandidates(
  reqs: readonly SemanticRequirement[],
  embedder: Embedder,
  options: {
    cosineFloor?: number
    glossary?: ReadonlyMap<string, string>
    antonyms?: ReadonlyMap<string, AntonymEntry>
  } = {},
): Promise<OppositionCandidateFinding[]> {
  const floor = options.cosineFloor ?? DEFAULT_OPPOSITION_COSINE_FLOOR
  const antonyms = options.antonyms ?? ANTONYM_INDEX
  if (reqs.length < 2) return []

  const { cosine } = await import('./embed.js')
  const vectors = await embedder(reqs.map((r) => r.systemResponse))

  const findings: OppositionCandidateFinding[] = []
  const seen = new Set<string>()

  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const a = reqs[i] as SemanticRequirement
      const b = reqs[j] as SemanticRequirement
      if (a.systemName !== b.systemName) continue

      // Already unified (glossary/antonym/identical) ⇒ not a candidate.
      const atomA = responseAtom(a, options.glossary)
      const atomB = responseAtom(b, options.glossary)
      if (atomA.name === atomB.name) continue

      // Structural opposition shape: same object remainder, different verb head.
      // Heads are de-inflected (opens/open) and a negating prefix token
      // (de-/un-/dis-, split off by punctuation normalization: "de-energize" →
      // `de_energize`) is fused back onto the verb so prefix opposites compare
      // as one head against their base form.
      const [headA, restA] = fuseNegatingPrefix(normalize(a.systemResponse))
      const [headB, restB] = fuseNegatingPrefix(normalize(b.systemResponse))
      if (restA === '' || restA !== restB) continue
      if (headA === headB) continue

      // Skip pairs the antonym tables ALREADY relate — those unify (handled
      // above) or are a real conflict, not a candidate to propose.
      const entryA = antonyms.get(headA)
      const entryB = antonyms.get(headB)
      if (entryA !== undefined && entryB !== undefined && entryA.canonical === entryB.canonical) {
        continue
      }

      const key = pairKey(a.id, b.id)
      if (seen.has(key)) continue

      // A negating-prefix pair (seal/unseal, energize/de-energize) is opposition
      // by MORPHOLOGY — deterministic structure, no embedding needed — so it is
      // proposed regardless of the topical cosine floor.
      const prefixPair = isNegatingPrefixPair(headA, headB)
      const va = vectors[i]
      const vb = vectors[j]
      const score = va !== undefined && vb !== undefined ? cosine(va, vb) : 0
      // Cosine is a topical-relatedness FLOOR only (antonyms embed close), not
      // the opposition signal — the shared-object/different-verb structure is.
      if (!prefixPair && score < floor) continue

      seen.add(key)
      const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
      findings.push({
        code: 'FND_OPPOSITION_CANDIDATE',
        severity: 'info',
        requirementIds: [lo, hi],
        verbs: [headA, headB],
        cosine: round3(score),
        message:
          `${lo} and ${hi} respond under the same system with the same object but different ` +
          `leading verbs ("${headA}" vs "${headB}"). These verbs differ, but embeddings CANNOT ` +
          'tell opposites (open/shut) from synonyms (delete/remove) — decide which these are: ' +
          `if they are polar OPPOSITES, run \`symspec antonym add ${headA} ${headB}\` (the formal ` +
          'tier will then collapse them to one atom at opposite polarity and can prove a conflict); ' +
          `if they are SYNONYMS, run \`symspec glossary add "${a.systemResponse}" "${b.systemResponse}"\` ` +
          'instead. Committing the WRONG one manufactures a false contradiction, so confirm the ' +
          'direction before applying. This is a suggestion, not a verdict.',
      })
    }
  }

  return findings
}
