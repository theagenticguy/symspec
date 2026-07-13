/**
 * Deterministic requirement similarity graph + missing-trace-link proposals
 * (AC-32-1, AC-32-2, AC-32-4) — the always-on embedding-graph tier.
 *
 * ## The determinism discipline (the whole reason this can be always-on)
 *
 * An embedding graph is only allowed to be a first-class, always-on capability
 * because it is built DETERMINISTICALLY and emits PROPOSALS ONLY — never a
 * verdict. The trace-link-recovery literature is unambiguous that embedding
 * link suggestions have too-low precision to auto-commit, so every finding here
 * is `info` and suggests an edge an agent confirms into the committed DAG; the
 * deterministic tiers (SMT, structural DAG checks) read only committed edges.
 *
 * Determinism is engineered, not assumed:
 *   - The embedder is INJECTED (tests pass a fake vector table). In production
 *     it is the pinned CPU/ONNX-WASM model — CPU inference is byte-reproducible
 *     where GPU is not.
 *   - Cosine is QUANTIZED to a fixed precision before any threshold comparison,
 *     so sub-ULP floating-point jitter can never flip an edge in or out.
 *   - Neighbor ties break on the requirement id (a total order), so the kNN set
 *     is deterministic even when two neighbors share a quantized score.
 *   - Clustering is union-find over the (already-deterministic) edge set — no
 *     random seed, no iteration-order dependence — so communities are stable.
 *
 * Given `(doc + pinned model)` the graph, its clusters, and its findings are
 * byte-identical across runs (AC-32-5).
 */

import type { Embedder } from './embed.js'

/** A requirement projection this tier needs: id, its text, and its committed edges. */
export interface GraphRequirement {
  readonly id: string
  /** The text embedded for similarity (typically the rendered sentence). */
  readonly text: string
  /**
   * Ids this requirement is ALREADY linked to via a committed trace edge
   * (`refines`/`derives`/`satisfies` — direction-agnostic for "is there a link").
   * A pair already in this relation never yields a missing-link proposal.
   */
  readonly linkedTo: readonly string[]
}

/** An info-tier proposal that two requirements should perhaps be trace-linked (AC-32-4). */
export interface MissingTraceLinkFinding {
  readonly code: 'FND_MISSING_TRACE_LINK'
  readonly severity: 'info'
  /** The two ids, lexicographically ordered for stability. */
  readonly requirementIds: [string, string]
  /** Quantized cosine that triggered the proposal. */
  readonly cosine: number
  readonly message: string
}

/** An info-tier near-duplicate cluster (AC-32-2): >2 mutually-similar requirements. */
export interface DuplicateClusterFinding {
  readonly code: 'FND_DUPLICATE_CLUSTER'
  readonly severity: 'info'
  /** All member ids, lexicographically sorted. */
  readonly requirementIds: string[]
  readonly message: string
}

/** What the graph tier emits. */
export type GraphFinding = MissingTraceLinkFinding | DuplicateClusterFinding

/** Options for {@link buildSimilarityGraph}. */
export interface GraphOptions {
  /**
   * Cosine ≥ this (after quantization) makes an edge (default
   * {@link DEFAULT_GRAPH_THRESHOLD}).
   */
  threshold?: number
  /** Max neighbors kept per node in the kNN graph (default 5). */
  k?: number
  /** Decimal places cosine is rounded to before comparison (default 4). */
  quantizePrecision?: number
}

/**
 * Default cosine above which two requirements get a similarity edge in the kNN
 * graph — the basis for a missing-trace-link proposal (`FND_MISSING_TRACE_LINK`)
 * or a near-duplicate cluster (`FND_DUPLICATE_CLUSTER`).
 *
 * ## Deliberately NOT the semantic-paraphrase threshold
 *
 * This is a DIFFERENT judgment from `semantic.ts`'s `DEFAULT_SEMANTIC_THRESHOLD`,
 * so it is a separate constant on purpose:
 *   - The paraphrase tier asks "do these two RESPONSE phrasings mean the same
 *     thing?" — synonymy — and embeds just the response phrase. It favors recall
 *     (a miss hides a provable conflict), so it uses a lower bar (0.72).
 *   - This graph tier asks "are these two whole requirements near-duplicates or
 *     plausibly in a refines/derives relationship?" — topical relatedness — and
 *     embeds the FULL rendered sentence (trigger + system + response). A
 *     trace-link/duplication proposal wants pairs that are strongly similar as
 *     whole statements, not merely pairs sharing a synonymous verb phrase, so it
 *     holds a higher bar.
 *
 * ## Why 0.82
 *
 * Over the same CLS-pooled, L2-normalized, no-prefix BGE-base-en-v1.5 embeddings
 * (scores compressed vs BGE retrieval benchmarks — see `DEFAULT_SEMANTIC_THRESHOLD`),
 * full-sentence pairs that are true near-duplicates land high (≈0.87+), while
 * merely same-topic-different-intent requirements sit well below. 0.82 keeps
 * this tier's proposals tight: the trace-link-recovery literature is clear that
 * embedding link suggestions have low precision, so — even though this tier is
 * also PROPOSE-only (info-tier, agent-confirmed) — it errs toward precision to
 * avoid drowning the agent in weak edge suggestions, the opposite balance from
 * the paraphrase tier. Additional structural guards (top-k pruning, cosine
 * quantization, id-based tie-breaks) keep the graph deterministic.
 *
 * Overridable per-run via the `threshold` option.
 */
export const DEFAULT_GRAPH_THRESHOLD = 0.82
const DEFAULT_K = 5
const DEFAULT_QUANTIZE = 4

/** Quantize a cosine to a fixed decimal precision (kills ULP-flip nondeterminism). */
function quantize(value: number, precision: number): number {
  const f = 10 ** precision
  return Math.round(value * f) / f
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Dot product of two equal-length vectors (embedder returns L2-normalized ⇒ cosine). */
function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/**
 * Build the deterministic kNN similarity graph and emit info-tier proposals:
 * missing trace links (high-cosine unlinked pairs, AC-32-4) and near-duplicate
 * clusters (AC-32-2). Async only because embedding is; pure given the embedder.
 */
export async function buildSimilarityGraph(
  reqs: readonly GraphRequirement[],
  embedder: Embedder,
  options: GraphOptions = {},
): Promise<GraphFinding[]> {
  const threshold = options.threshold ?? DEFAULT_GRAPH_THRESHOLD
  const k = options.k ?? DEFAULT_K
  const precision = options.quantizePrecision ?? DEFAULT_QUANTIZE
  if (reqs.length < 2) return []

  const vectors = await embedder(reqs.map((r) => r.text))

  // 1. All-pairs quantized cosine (deterministic). Record edges ≥ threshold.
  interface Edge {
    a: number
    b: number
    score: number
  }
  const edges: Edge[] = []
  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const va = vectors[i]
      const vb = vectors[j]
      if (va === undefined || vb === undefined) continue
      const score = quantize(dot(va, vb), precision)
      if (score >= threshold) edges.push({ a: i, b: j, score })
    }
  }

  // 2. kNN pruning: keep each node's top-k neighbors, ties broken by id. An
  //    edge survives if it is in EITHER endpoint's top-k (mutual-or set), so the
  //    graph is symmetric and deterministic.
  const kept = pruneToKnn(reqs, edges, k)

  // 3. Missing-trace-link proposals: a kept edge whose endpoints are not already
  //    committed-linked (AC-32-4).
  const linked = new Set<string>()
  for (const r of reqs) {
    for (const t of r.linkedTo) linked.add(pairKey(r.id, t))
  }

  const findings: GraphFinding[] = []
  for (const e of kept) {
    const ra = reqs[e.a]!
    const rb = reqs[e.b]!
    const key = pairKey(ra.id, rb.id)
    if (linked.has(key)) continue
    const [lo, hi] = ra.id < rb.id ? [ra.id, rb.id] : [rb.id, ra.id]
    findings.push({
      code: 'FND_MISSING_TRACE_LINK',
      severity: 'info',
      requirementIds: [lo, hi],
      cosine: e.score,
      message:
        `${lo} and ${hi} are semantically similar (cosine ${e.score} ≥ ${threshold}) but have no ` +
        'committed trace link. If one refines or derives the other, add the edge (e.g. ' +
        `\`symspec derive ${lo} ${hi}\`). This is a suggestion, not a verdict.`,
    })
  }

  // 4. Near-duplicate clusters: connected components over the kept edges with
  //    ≥3 members are surfaced as a review prompt (AC-32-2).
  findings.push(...clusterFindings(reqs, kept))

  // Deterministic output order: code, then first id.
  findings.sort(
    (x, y) =>
      x.code.localeCompare(y.code) ||
      (x.requirementIds[0] ?? '').localeCompare(y.requirementIds[0] ?? ''),
  )
  return findings
}

/** Keep edges that are in either endpoint's top-k by (score desc, neighbor id asc). */
function pruneToKnn(
  reqs: readonly GraphRequirement[],
  edges: ReadonlyArray<{ a: number; b: number; score: number }>,
  k: number,
): Array<{ a: number; b: number; score: number }> {
  const neighbors = new Map<number, Array<{ other: number; score: number }>>()
  for (let i = 0; i < reqs.length; i++) neighbors.set(i, [])
  for (const e of edges) {
    neighbors.get(e.a)!.push({ other: e.b, score: e.score })
    neighbors.get(e.b)!.push({ other: e.a, score: e.score })
  }

  const topk = new Set<string>()
  for (const [node, ns] of neighbors) {
    ns.sort((p, q) => q.score - p.score || (reqs[p.other]!.id < reqs[q.other]!.id ? -1 : 1))
    for (const n of ns.slice(0, k))
      topk.add(node < n.other ? `${node}:${n.other}` : `${n.other}:${node}`)
  }

  return edges.filter((e) => topk.has(`${e.a}:${e.b}`))
}

/** Connected components (union-find) over kept edges; components of ≥3 → findings. */
function clusterFindings(
  reqs: readonly GraphRequirement[],
  kept: ReadonlyArray<{ a: number; b: number }>,
): DuplicateClusterFinding[] {
  const parent = reqs.map((_r, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    return r
  }
  const union = (x: number, y: number): void => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry)
  }
  for (const e of kept) union(e.a, e.b)

  const groups = new Map<number, string[]>()
  for (let i = 0; i < reqs.length; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (g === undefined) groups.set(root, [reqs[i]!.id])
    else g.push(reqs[i]!.id)
  }

  const findings: DuplicateClusterFinding[] = []
  for (const ids of groups.values()) {
    if (ids.length < 3) continue
    const sorted = [...ids].sort()
    findings.push({
      code: 'FND_DUPLICATE_CLUSTER',
      severity: 'info',
      requirementIds: sorted,
      message:
        `${sorted.length} requirements form a tight semantic cluster (${sorted.join(', ')}). ` +
        'Review for near-duplication or an unstated shared parent. This is a suggestion, not a verdict.',
    })
  }
  return findings
}
