/**
 * Local sentence-embedding backend (AC-9-4) — the PROPOSE half of the semantic
 * paraphrase-bridging tier.
 *
 * Runs the pinned `Xenova/bge-base-en-v1.5` sentence model DIRECTLY on the ONNX
 * **WASM** runtime (`onnxruntime-web`) with a pure-JS tokenizer
 * (`@huggingface/tokenizers`) — no `@huggingface/transformers`, and no native
 * `onnxruntime-node` build, so the package stays portable and npm-installable.
 * Embeddings use **CLS pooling** (the `[CLS]` token at sequence position 0) and
 * are L2-normalized, matching how BGE was trained, so a plain dot product IS
 * cosine similarity.
 *
 * ## Offline + lazy discipline
 *
 * The model (~110 MB) is a large optional asset, so this module mirrors the
 * Lean-toolchain discovery pattern:
 *   - `onnxruntime-web`, the tokenizer, and the model assets are all **lazily
 *     loaded** — nothing here runs unless `check --semantic` (or a
 *     `glossary`-proposing path) actually executes, so the default `check` pays
 *     zero cost (AC-9-4).
 *   - `allowRemote` defaults OFF: the assets must already be in the local cache
 *     (see {@link ModelAssets}). When absent and remote loading is not enabled,
 *     {@link loadEmbedder} throws {@link EmbedModelMissingError}
 *     (→ `ERR_EMBED_MODEL_MISSING` envelope) with a download suggestion — it
 *     NEVER blocks the SMT/lint tiers, which run independently.
 *
 * ## Propose-only (the load-bearing invariant)
 *
 * This backend produces similarity SCORES. It never decides a conflict. The
 * only durable effect of a high score is a suggested glossary entry the calling
 * agent may confirm; the deterministic SMT verdict path consults the committed
 * glossary, never this model. Given (doc + glossary + pinned model) the run is
 * reproducible.
 */

import { readFile } from 'node:fs/promises'
import { ensureModelAssets, ModelAssetsUnavailableError } from './model-cache.js'

/** The pinned embedding model (user-specified). ONNX WASM, no native build. */
export const EMBED_MODEL = 'Xenova/bge-base-en-v1.5'

/** BGE's max sequence length (BERT WordPiece); longer inputs are truncated. */
const MAX_SEQ_LEN = 512

/** Raised when the model is not cached and remote loading is not enabled (AC-9-4). */
export class EmbedModelMissingError extends Error {
  readonly code = 'ERR_EMBED_MODEL_MISSING'
  readonly suggestions: string[]
  constructor(cause?: unknown) {
    super(
      `The embedding model "${EMBED_MODEL}" is not available in the local cache, ` +
        'and remote model loading is disabled.',
    )
    this.name = 'EmbedModelMissingError'
    this.suggestions = [
      `Pre-download the model into the symspec cache, or run with SYMSPEC_EMBED_ALLOW_REMOTE=1 once to fetch "${EMBED_MODEL}".`,
      'The semantic tier is opt-in (`check --semantic`); the structural, lint, and SMT tiers run without it.',
    ]
    if (cause !== undefined) this.cause = cause
  }
}

/** A loaded embedder: text[] → one L2-normalized vector per input. */
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>

/** Options for {@link loadEmbedder}. `allowRemote` overrides the offline default. */
export interface LoadEmbedderOptions {
  /** Allow fetching the model from the HF hub when absent from cache (default false). */
  allowRemote?: boolean
  /** Override the model id (tests inject a tiny local fixture model). */
  model?: string
  /**
   * Injected pipeline factory (tests supply a deterministic stub so no real
   * model loads). Defaults to the real lazily-loaded ONNX WASM pipeline.
   */
  pipelineFactory?: PipelineFactory
}

/** The minimal shape of a feature-extraction pipeline we use. */
export type FeaturePipeline = (
  texts: readonly string[],
  opts: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

/** Factory that builds a {@link FeaturePipeline} for a model id. */
export type PipelineFactory = (model: string, allowRemote: boolean) => Promise<FeaturePipeline>

/** The subset of `@huggingface/tokenizers`'s `encode` result we consume. */
interface Encoding {
  ids: number[]
  attention_mask: number[]
  token_type_ids?: number[]
}

/**
 * The real pipeline factory: lazily loads `onnxruntime-web` (WASM EP,
 * single-threaded) and a pure-JS tokenizer, fetches the pinned assets on first
 * use (digest-verified), and returns a feature-extraction pipeline that CLS-
 * pools and L2-normalizes. Never imported at module load — only when an
 * embedder is actually requested.
 */
const defaultPipelineFactory: PipelineFactory = async (_model, allowRemote) => {
  // 1. Resolve the pinned assets (cache hit → offline; miss + allowRemote →
  //    fetch + sha256-verify; miss + offline → ModelAssetsUnavailableError).
  const assets = await ensureModelAssets(allowRemote)

  // 2. Lazily load the runtime + tokenizer. A missing runtime is the same
  //    contract as a missing model: ERR_EMBED_MODEL_MISSING.
  const [ort, { Tokenizer }] = await Promise.all([
    import('onnxruntime-web'),
    import('@huggingface/tokenizers'),
  ])

  // Single-threaded WASM is the safe Node config (no SharedArrayBuffer/worker
  // requirement); pin the WASM EP so no native/GPU provider is selected.
  ort.env.wasm.numThreads = 1

  const [tokenizerJson, tokenizerConfig, modelBytes] = await Promise.all([
    readFile(assets.tokenizerPath, 'utf8').then((s) => JSON.parse(s) as object),
    readFile(assets.tokenizerConfigPath, 'utf8').then((s) => JSON.parse(s) as object),
    readFile(assets.modelPath),
  ])
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })

  return async (texts, opts) => {
    if (texts.length === 0) return { tolist: () => [] }

    // Tokenize + right-pad to the batch's longest sequence (truncated to 512).
    const encs = texts.map(
      (t) =>
        tokenizer.encode(t, { add_special_tokens: true, return_token_type_ids: true }) as Encoding,
    )
    const seqLen = Math.min(
      MAX_SEQ_LEN,
      encs.reduce((m, e) => Math.max(m, e.ids.length), 0),
    )
    const batch = encs.length
    const ids = new BigInt64Array(batch * seqLen)
    const mask = new BigInt64Array(batch * seqLen)
    const type = new BigInt64Array(batch * seqLen)
    for (let b = 0; b < batch; b++) {
      const e = encs[b]!
      const n = Math.min(seqLen, e.ids.length)
      for (let j = 0; j < n; j++) {
        ids[b * seqLen + j] = BigInt(e.ids[j]!)
        mask[b * seqLen + j] = BigInt(e.attention_mask[j]!)
        type[b * seqLen + j] = BigInt(e.token_type_ids?.[j] ?? 0)
      }
      // Remaining positions stay 0 — [PAD]=0, attention 0, type 0.
    }
    const dims = [batch, seqLen]
    const output = await session.run({
      input_ids: new ort.Tensor('int64', ids, dims),
      attention_mask: new ort.Tensor('int64', mask, dims),
      token_type_ids: new ort.Tensor('int64', type, dims),
    })

    // BGE = CLS pooling: take the [CLS] token (seq index 0) of last_hidden_state
    // [batch, seq, hidden], then L2-normalize so cosine == dot product.
    const hidden = output.last_hidden_state as { data: Float32Array; dims: readonly number[] }
    const H = hidden.dims[2] as number
    const data = hidden.data
    const pool = opts.pooling
    const rows: number[][] = []
    for (let b = 0; b < batch; b++) {
      const vec = new Array<number>(H)
      if (pool === 'mean') {
        // Attention-masked mean over the sequence (defensive; BGE uses CLS).
        let count = 0
        vec.fill(0)
        for (let j = 0; j < seqLen; j++) {
          if (mask[b * seqLen + j] === 0n) continue
          count++
          const off = (b * seqLen + j) * H
          for (let h = 0; h < H; h++) vec[h]! += data[off + h]!
        }
        const denom = count || 1
        for (let h = 0; h < H; h++) vec[h]! /= denom
      } else {
        const off = b * seqLen * H // CLS at seq index 0
        for (let h = 0; h < H; h++) vec[h] = data[off + h]!
      }
      if (opts.normalize) {
        let norm = 0
        for (let h = 0; h < H; h++) norm += vec[h]! * vec[h]!
        norm = Math.sqrt(norm) || 1
        for (let h = 0; h < H; h++) vec[h]! /= norm
      }
      rows.push(vec)
    }
    return { tolist: () => rows }
  }
}

/**
 * Load an {@link Embedder}. Lazy + offline by default (AC-9-4): the model must
 * be cached unless `allowRemote` (or `SYMSPEC_EMBED_ALLOW_REMOTE=1`) is set.
 * Throws {@link EmbedModelMissingError} when the model cannot be loaded.
 */
export async function loadEmbedder(options: LoadEmbedderOptions = {}): Promise<Embedder> {
  const allowRemote = options.allowRemote ?? process.env.SYMSPEC_EMBED_ALLOW_REMOTE === '1'
  const model = options.model ?? EMBED_MODEL
  const factory = options.pipelineFactory ?? defaultPipelineFactory
  let extractor: FeaturePipeline
  try {
    extractor = await factory(model, allowRemote)
  } catch (e) {
    // Any factory failure (cache miss, offline, corrupt model) is the same
    // contract: ERR_EMBED_MODEL_MISSING. Preserve an already-typed error.
    throw e instanceof EmbedModelMissingError ? e : new EmbedModelMissingError(e)
  }

  return async (texts) => {
    if (texts.length === 0) return []
    // BGE trains on CLS pooling; the pipeline pools + normalizes internally.
    const output = await extractor(texts, { pooling: 'cls', normalize: true })
    return output.tolist().map((row) => Float32Array.from(row))
  }
}

/**
 * Cosine similarity of two L2-normalized vectors — a plain dot product, since
 * `normalize: true` guarantees unit length. Returns a value in `[-1, 1]`.
 * Mismatched lengths return 0 (defensive; never thrown).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

// `ModelAssetsUnavailableError` is wrapped into EmbedModelMissingError above;
// re-exported so callers can distinguish an asset problem if they wish.
export { ModelAssetsUnavailableError }
