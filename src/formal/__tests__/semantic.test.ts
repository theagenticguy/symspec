/**
 * AC-9-5: the semantic paraphrase finder. Uses a deterministic fake embedder
 * (a small hand-authored vector table) so the test is offline and reproducible.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../embed.js'
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  findOppositionCandidates,
  findSimilarSemantic,
  type SemanticRequirement,
} from '../semantic.js'

/** A fake embedder mapping known phrases to hand-chosen unit vectors. */
function fakeEmbedder(table: Record<string, [number, number]>): Embedder {
  return async (texts) =>
    texts.map((t) => {
      const v = table[t] ?? [0, 0]
      const norm = Math.hypot(v[0], v[1]) || 1
      return Float32Array.from([v[0] / norm, v[1] / norm])
    })
}

const req = (
  id: string,
  systemResponse: string,
  systemName = 'auth service',
): SemanticRequirement => ({ id, systemName, systemResponse })

describe('findSimilarSemantic (AC-9-5)', () => {
  it('fires FND_SIMILAR_SEMANTIC for a high-cosine unmerged same-system pair', async () => {
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0.02],
      'issue a login credential': [1, 0.05], // ~parallel → high cosine
    })
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a login credential')],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_SIMILAR_SEMANTIC')
    expect(findings[0]!.severity).toBe('info')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.cosine).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_THRESHOLD)
    expect(findings[0]!.message).toContain('symspec glossary add')
    expect(findings[0]!.message).toContain('not a verdict')
  })

  it('does not fire when responses already unify to the same atom', async () => {
    const embedder = fakeEmbedder({ 'issue a session token': [1, 0] })
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a session token')],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toEqual([])
  })

  it('does not fire below threshold', async () => {
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0],
      'delete the audit log': [0, 1], // orthogonal → cosine 0
    })
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'delete the audit log')],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toEqual([])
  })

  it('never bridges across different systems (per-system atom scoping)', async () => {
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0],
      'issue a login credential': [1, 0.01],
    })
    const findings = await findSimilarSemantic(
      [
        req('A', 'issue a session token', 'auth service'),
        req('B', 'issue a login credential', 'billing service'),
      ],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toEqual([])
  })

  it('also suggests `antonym add` when a high-cosine pair shares the SAME trigger', async () => {
    // Same system AND same trigger + high cosine ⇒ the pair might be polar
    // OPPOSITES, not synonyms (antonyms embed close). The message must point at
    // BOTH glossary (synonym path) and antonym (opposition path), with concrete
    // verb heads, and stay a suggestion — never a verdict.
    const embedder = fakeEmbedder({
      'open the valve': [1, 0.02],
      'shut the valve': [1, 0.05],
    })
    const findings = await findSimilarSemantic(
      [
        {
          id: 'A',
          systemName: 'ctrl',
          systemResponse: 'open the valve',
          trigger: 'pressure rises',
        },
        {
          id: 'B',
          systemName: 'ctrl',
          systemResponse: 'shut the valve',
          trigger: 'pressure rises',
        },
      ],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toHaveLength(1)
    const msg = findings[0]!.message
    expect(msg).toContain('symspec glossary add')
    expect(msg).toContain('symspec antonym add open shut')
    expect(msg).toContain('SAME trigger')
    expect(msg).toContain('not a verdict')
  })

  it('does NOT add the antonym hint when triggers differ (only the glossary path)', async () => {
    const embedder = fakeEmbedder({
      'open the valve': [1, 0.02],
      'shut the valve': [1, 0.05],
    })
    const findings = await findSimilarSemantic(
      [
        {
          id: 'A',
          systemName: 'ctrl',
          systemResponse: 'open the valve',
          trigger: 'pressure rises',
        },
        {
          id: 'B',
          systemName: 'ctrl',
          systemResponse: 'shut the valve',
          trigger: 'pressure drops',
        },
      ],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD },
    )
    expect(findings).toHaveLength(1)
    const msg = findings[0]!.message
    expect(msg).toContain('symspec glossary add')
    expect(msg).not.toContain('symspec antonym add')
  })

  it('skips a pair already merged by the glossary index', async () => {
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0.02],
      'issue a login credential': [1, 0.05],
    })
    // Glossary maps the normalized alias to the canonical normalized form.
    const glossary = new Map([['issue_a_login_credential', 'issue_a_session_token']])
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a login credential')],
      embedder,
      { threshold: DEFAULT_SEMANTIC_THRESHOLD, glossary },
    )
    expect(findings).toEqual([])
  })
})

describe('DEFAULT_SEMANTIC_THRESHOLD (retuned for paraphrase recall)', () => {
  it('is 0.72 — below the divergent-paraphrase band, above the noise floor', () => {
    // Grounded in real Xenova/bge-base-en-v1.5 (CLS-pooled, L2-normalized,
    // no-prefix) cosines: divergent paraphrases ~0.75–0.79, unrelated same-domain
    // ~0.44–0.58. 0.72 captures the former with margin above the latter.
    expect(DEFAULT_SEMANTIC_THRESHOLD).toBe(0.72)
  })

  it('fires by default (no threshold passed) on a divergent paraphrase the old 0.82 missed', async () => {
    // A pair whose cosine ≈ 0.77 sits BETWEEN the retuned default (0.72) and the
    // old magic default (0.82): [1,0] · [0.77, sqrt(1-0.77^2)] = 0.77. Under the
    // old 0.82 this was silently missed; the retune surfaces it by DEFAULT.
    const y = Math.sqrt(1 - 0.77 * 0.77)
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0],
      'issue a login credential': [0.77, y],
    })
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a login credential')],
      embedder,
      // No threshold option → falls back to DEFAULT_SEMANTIC_THRESHOLD.
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.cosine).toBeCloseTo(0.77, 2)
    expect(findings[0]!.cosine).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_THRESHOLD)
    expect(findings[0]!.cosine).toBeLessThan(0.82) // would have been missed before

    // Same pair under the OLD default: below 0.82 → no finding (proves the gain).
    const missedUnderOldDefault = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a login credential')],
      embedder,
      { threshold: 0.82 },
    )
    expect(missedUnderOldDefault).toEqual([])
  })
})

describe('findOppositionCandidates (#6)', () => {
  it('proposes FND_OPPOSITION_CANDIDATE for same-object/different-verb pairs not already antonyms', async () => {
    // "open the valve" vs "shut the valve": same object "the valve", different
    // verb heads open/shut (not a seed antonym), topically related (high cosine).
    const embedder = fakeEmbedder({
      'open the valve': [1, 0.1],
      'shut the valve': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'open the valve'), req('B', 'shut the valve')],
      embedder,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_OPPOSITION_CANDIDATE')
    expect(findings[0]!.severity).toBe('info')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.verbs.sort()).toEqual(['open', 'shut'])
    // The message suggests the antonym command, warns about the synonym trap,
    // and offers the glossary alternative — never a verdict.
    expect(findings[0]!.message).toContain('symspec antonym add')
    expect(findings[0]!.message).toContain('symspec glossary add')
    expect(findings[0]!.message.toLowerCase()).toContain('synonym')
  })

  it('does NOT propose for different objects (structure guard)', async () => {
    const embedder = fakeEmbedder({
      'open the valve': [1, 0.1],
      'shut the door': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'open the valve'), req('B', 'shut the door')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('does NOT propose for a pair already unified as seed antonyms (grant/revoke access)', async () => {
    // grant/revoke IS a seed antonym → they already unify to one atom, so this is
    // a real/provable conflict, not a candidate to propose.
    const embedder = fakeEmbedder({
      'grant access': [1, 0.1],
      'revoke access': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'grant access'), req('B', 'revoke access')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('does NOT propose across different systems', async () => {
    const embedder = fakeEmbedder({
      'open the valve': [1, 0.1],
      'shut the valve': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'open the valve', 'sysX'), req('B', 'shut the valve', 'sysY')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('does NOT propose when cosine is below the topical-relatedness floor', async () => {
    // Same-object/different-verb structurally, but the embeddings are orthogonal
    // (coincidental object overlap) → below the floor → dropped.
    const embedder = fakeEmbedder({
      'open the valve': [1, 0],
      'shut the valve': [0, 1],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'open the valve'), req('B', 'shut the valve')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('proposes de-/un-/dis- prefix pairs EVEN below the cosine floor (morphological opposition)', async () => {
    // "mount the volume" vs "unmount the volume": opposition by negating prefix
    // (NOT in the seed table, so atomize does not already unify them) —
    // deterministic structure, so the orthogonal (below-floor) embeddings must
    // not suppress the proposal.
    const embedder = fakeEmbedder({
      'mount the volume': [1, 0],
      'unmount the volume': [0, 1],
      'pressurize the tank': [1, 0],
      'de-pressurize the tank': [0, 1],
    })
    const mounted = await findOppositionCandidates(
      [req('A', 'mount the volume'), req('B', 'unmount the volume')],
      embedder,
    )
    expect(mounted).toHaveLength(1)
    expect(mounted[0]!.verbs.sort()).toEqual(['mount', 'unmount'])
    expect(mounted[0]!.message).toContain('symspec antonym add')
    const pressurized = await findOppositionCandidates(
      [req('C', 'pressurize the tank'), req('D', 'de-pressurize the tank')],
      embedder,
    )
    expect(pressurized).toHaveLength(1)
  })

  it('skips pairs the expanded seed table already unifies (seal/unseal, suspend/resume)', async () => {
    // These are now seed antonyms — atomize collapses them to one atom at
    // opposite polarity, a proven-or-provable conflict, NOT a candidate.
    const embedder = fakeEmbedder({
      'seal the record': [1, 0.1],
      'unseal the record': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'seal the record'), req('B', 'unseal the record')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('de-inflects heads so 3sg phrasing still matches the structural shape', async () => {
    // "escalates the ticket" vs "dismisses the ticket" — heads de-inflect to
    // escalate/dismiss (not seeded antonyms); same object remainder → candidate
    // (high cosine).
    const embedder = fakeEmbedder({
      'escalates the ticket': [1, 0.1],
      'dismisses the ticket': [1, 0.12],
    })
    const findings = await findOppositionCandidates(
      [req('A', 'escalates the ticket'), req('B', 'dismisses the ticket')],
      embedder,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.verbs.sort()).toEqual(['dismiss', 'escalate'])
  })
})
