/**
 * AC-32-1/2/4: the deterministic embedding similarity graph. Uses an injected
 * fake embedder (hand-authored unit vectors) so the test is offline and the
 * kNN graph, clusters, and proposals are exercised without a real model.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../embed.js'
import { buildSimilarityGraph, DEFAULT_GRAPH_THRESHOLD, type GraphRequirement } from '../graph.js'

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
      'unrelated statement': [0, 1],
      'linked target': [0.1, 1],
    })
    // The doc uses at least one trace link somewhere (C→D), so the missing-link
    // tier is un-gated and the unlinked A/B pair yields a proposal. (An entirely
    // trace-free doc suppresses these — see the dedicated trace-gate test below.)
    const findings = await buildSimilarityGraph(
      [
        gr('A', 'issue a session token'),
        gr('B', 'issue a login credential'),
        gr('C', 'unrelated statement', ['D']),
        gr('D', 'linked target'),
      ],
      embedder,
      { threshold: 0.82 },
    )
    const links = findings.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')
    expect(links).toHaveLength(1)
    expect(links[0]!.severity).toBe('info')
    expect(links[0]!.requirementIds).toEqual(['A', 'B'])
  })

  it('suppresses missing-trace-link proposals in a doc that uses ZERO trace links', async () => {
    // Trace-gate: in a completely trace-free doc, every high-cosine pair is
    // unlinked, so proposing a link on each would just spam an author who has
    // not adopted tracing. No `linkedTo` anywhere ⇒ no FND_MISSING_TRACE_LINK.
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0.02],
      'issue a login credential': [1, 0.05],
    })
    const findings = await buildSimilarityGraph(
      [gr('A', 'issue a session token'), gr('B', 'issue a login credential')],
      embedder,
      { threshold: 0.82 },
    )
    expect(findings.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')).toEqual([])
  })

  it('still detects the unlinked pair once ANY trace link exists (orphans meaningful vs a tracing doc)', async () => {
    // Mirror of the suppression test: add a single committed link (A→B here is
    // NOT it; instead a separate C→A link) and the tier re-engages for the
    // remaining unlinked high-cosine pair.
    const embedder = fakeEmbedder({
      'issue a session token': [1, 0.02],
      'issue a login credential': [1, 0.05],
      seed: [0, 1],
    })
    const findings = await buildSimilarityGraph(
      [
        gr('A', 'issue a session token'),
        gr('B', 'issue a login credential'),
        gr('C', 'seed', ['A']), // one committed trace link ⇒ un-gates the tier
      ],
      embedder,
      { threshold: 0.82 },
    )
    const links = findings.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')
    expect(links).toHaveLength(1)
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

  it('defaults the edge threshold to DEFAULT_GRAPH_THRESHOLD (relatedness, held higher than paraphrase)', async () => {
    // The graph tier is a distinct judgment from paraphrase-synonymy and holds a
    // higher, precision-favoring bar. Assert the exported value and that it is
    // applied when no threshold option is passed.
    expect(DEFAULT_GRAPH_THRESHOLD).toBe(0.82)

    // cosine ≈ 0.79 sits ABOVE the paraphrase default (0.72) but BELOW the graph
    // default (0.82): [1,0] · [0.79, sqrt(1-0.79^2)] = 0.79. No edge by default.
    const y = Math.sqrt(1 - 0.79 * 0.79)
    const embedder = fakeEmbedder({ a: [1, 0], b: [0.79, y] })
    const noEdge = await buildSimilarityGraph([gr('A', 'a'), gr('B', 'b')], embedder)
    expect(noEdge).toEqual([])

    // A truly near-duplicate pair (cosine ≈ 0.999) clears the default bar. A
    // committed trace link elsewhere (C→D) un-gates the missing-link tier so the
    // A/B proposal fires (the trace-gate is exercised on its own above).
    const near = fakeEmbedder({ a: [1, 0.02], b: [1, 0.05], seed: [0, 1], other: [0.05, 1] })
    const edge = await buildSimilarityGraph(
      [gr('A', 'a'), gr('B', 'b'), gr('C', 'seed', ['D']), gr('D', 'other')],
      near,
    )
    expect(edge.filter((f) => f.code === 'FND_MISSING_TRACE_LINK')).toHaveLength(1)
  })
})
