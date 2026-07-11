/**
 * AC-32-1/2/4: the deterministic embedding similarity graph. Uses an injected
 * fake embedder (hand-authored unit vectors) so the test is offline and the
 * kNN graph, clusters, and proposals are exercised without a real model.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../embed.js'
import { buildSimilarityGraph, type GraphRequirement } from '../graph.js'

/** Fake embedder: maps each input text to a hand-chosen 2-D unit vector. */
function fakeEmbedder(table: Record<string, [number, number]>): Embedder {
  return async (texts) =>
    texts.map((t) => {
      const v = table[t] ?? [0, 0]
      const n = Math.hypot(v[0], v[1]) || 1
      return Float32Array.from([v[0] / n, v[1] / n])
    })
}

const gr = (id: string, text: string, linkedTo: string[] = []): GraphRequirement => ({
  id,
  text,
  linkedTo,
})

describe('buildSimilarityGraph (AC-32-4)', () => {
  it('proposes a missing trace link for a high-cosine unlinked pair', async () => {
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0.02],
      'issue a login credential': [1, 0.05], // ~parallel → high cosine
    })
    const findings = await buildSimilarityGraph(
      [gr('A', 'issue a session token'), gr('B', 'issue a login credential')],
      embedder,
      { threshold: 0.82 },
    )
    const links = findings.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')
    expect(links).toHaveLength(1)
    expect(links[0]!.severity).toBe('info')
    expect(links[0]!.requirementIds).toEqual(['A', 'B'])
  })

  it('does NOT propose a link for an already-linked pair', async () => {
    const embedder = fakeEmbedder({
      x: [1, 0],
      y: [1, 0.01],
    })
    const findings = await buildSimilarityGraph(
      [gr('A', 'x', ['B']), gr('B', 'y')], // A already refines/derives/satisfies B
      embedder,
      { threshold: 0.82 },
    )
    expect(findings.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')).toEqual([])
  })

  it('does NOT propose a link for a low-cosine pair', async () => {
    const embedder = fakeEmbedder({ x: [1, 0], y: [0, 1] }) // orthogonal → cosine 0
    const findings = await buildSimilarityGraph([gr('A', 'x'), gr('B', 'y')], embedder, {
      threshold: 0.82,
    })
    expect(findings).toEqual([])
  })

  it('surfaces a near-duplicate cluster of >=3 mutually-similar requirements', async () => {
    const embedder = fakeEmbedder({
      a: [1, 0.01],
      b: [1, 0.02],
      c: [1, 0.03],
    })
    const findings = await buildSimilarityGraph(
      [gr('A', 'a'), gr('B', 'b'), gr('C', 'c')],
      embedder,
      { threshold: 0.82 },
    )
    const clusters = findings.filter((f) => f.code === 'FND_DUPLICATE_CLUSTER')
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.requirementIds).toEqual(['A', 'B', 'C'])
  })

  it('is deterministic: identical input yields byte-identical output (AC-32-5)', async () => {
    const embedder = fakeEmbedder({
      a: [1, 0.01],
      b: [1, 0.02],
      c: [0.9, 0.2],
    })
    const reqs = [gr('A', 'a'), gr('B', 'b'), gr('C', 'c')]
    const one = await buildSimilarityGraph(reqs, embedder, { threshold: 0.8 })
    const two = await buildSimilarityGraph(reqs, embedder, { threshold: 0.8 })
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })

  it('quantizes cosine so a sub-precision score below threshold does not flip in', async () => {
    // cosine ≈ 0.8199 rounds to 0.8199 at precision 4; with threshold 0.82 it
    // stays OUT (deterministic boundary, not FP-jitter dependent).
    const embedder = fakeEmbedder({ a: [0.8199, 0.5725], b: [1, 0] })
    const findings = await buildSimilarityGraph([gr('A', 'a'), gr('B', 'b')], embedder, {
      threshold: 0.82,
      quantizePrecision: 4,
    })
    expect(findings).toEqual([])
  })
})
