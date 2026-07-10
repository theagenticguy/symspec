/**
 * Local sentence-embedding backend (AC-9-4) — the PROPOSE half of the semantic
 * paraphrase-bridging tier.
 *
 * Uses `@huggingface/transformers` feature-extraction with the pinned
 * `onnx-community/bge-base-en-v1.5-ONNX` model, running on the ONNX **WASM**
 * runtime (no native `onnxruntime-node` build — keeps the package portable and
 * npm-installable). Embeddings are mean-pooled and L2-normalized, so a plain
 * dot product IS cosine similarity.
 *
 * ## Offline + lazy discipline
 *
 * The model (~100 MB) is a large optional asset, so this module mirrors the
 * Lean-toolchain discovery pattern:
 *   - The transformers library and the model are **lazily imported** — nothing
 *     here loads unless `check --semantic` (or a `glossary`-proposing path)
 *     actually runs, so the default `check` pays zero cost (AC-9-4).
 *   - `allowRemoteModels` defaults to OFF: the model must already be in the
 *     local transformers cache. When it is absent and remote loading is not
 *     explicitly enabled, {@link loadEmbedder} throws {@link EmbedModelMissingError}
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

/** The pinned embedding model (user-specified). ONNX WASM, no native build. */
export const EMBED_MODEL = 'onnx-community/bge-base-en-v1.5-ONNX'

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
      `Pre-download the model into the transformers cache, or run with SYMSPEC_EMBED_ALLOW_REMOTE=1 once to fetch "${EMBED_MODEL}".`,
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
   * model loads). Defaults to the real lazily-imported transformers pipeline.
   */
  pipelineFactory?: PipelineFactory
}

/** The minimal shape of a transformers feature-extraction pipeline we use. */
export type FeaturePipeline = (
  texts: readonly string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

/** Factory that builds a {@link FeaturePipeline} for a model id. */
export type PipelineFactory = (model: string, allowRemote: boolean) => Promise<FeaturePipeline>

/**
 * The real pipeline factory: lazily imports `@huggingface/transformers`,
 * configures offline/remote loading, and builds a feature-extraction pipeline.
 * Never imported at module load — only when an embedder is actually requested.
 */
const defaultPipelineFactory: PipelineFactory = async (model, allowRemote) => {
  let mod: typeof import('@huggingface/transformers')
  try {
    mod = await import('@huggingface/transformers')
  } catch (e) {
    throw new EmbedModelMissingError(e)
  }
  mod.env.allowRemoteModels = allowRemote
  try {
    const extractor = await mod.pipeline('feature-extraction', model)
    return extractor as unknown as FeaturePipeline
  } catch (e) {
    throw new EmbedModelMissingError(e)
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
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
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
