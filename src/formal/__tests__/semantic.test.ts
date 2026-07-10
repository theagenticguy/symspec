/**
 * AC-9-5: the semantic paraphrase finder. Uses a deterministic fake embedder
 * (a small hand-authored vector table) so the test is offline and reproducible.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../embed.js'
import { findSimilarSemantic, type SemanticRequirement } from '../semantic.js'

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
      { threshold: 0.82 },
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_SIMILAR_SEMANTIC')
    expect(findings[0]!.severity).toBe('info')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.cosine).toBeGreaterThanOrEqual(0.82)
    expect(findings[0]!.message).toContain('symspec glossary add')
    expect(findings[0]!.message).toContain('not a verdict')
  })

  it('does not fire when responses already unify to the same atom', async () => {
    const embedder = fakeEmbedder({ 'issue a session token': [1, 0] })
    const findings = await findSimilarSemantic(
      [req('A', 'issue a session token'), req('B', 'issue a session token')],
      embedder,
      { threshold: 0.82 },
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
      { threshold: 0.82 },
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
      { threshold: 0.82 },
    )
    expect(findings).toEqual([])
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
      { threshold: 0.82, glossary },
    )
    expect(findings).toEqual([])
  })
})
