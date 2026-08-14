/**
 * v4's `src/formal/embed.ts`, reduced to its INTERFACE — the PROPOSE half
 * of the semantic paraphrase-bridging tier, minus the model loader.
 *
 * ## Why this file is reduced (and it is NOT one of the four material edits)
 *
 * v4 original loads the pinned `Xenova/bge-base-en-v1.5` sentence model on
 * the ONNX WASM runtime through a sha256-pinned local cache (`./model-cache.ts`,
 * ~110 MB of assets). That whole apparatus — `loadEmbedder`, the pipeline factory,
 * the tokenizer, `EmbedModelMissingError`, the offline/allowRemote discipline — is
 * the SEMANTIC TIER, which the G2a brief explicitly defers to G2b/G3:
 *
 *   "Parse ladder, GtWR lint, semantic/embeddings tier, and install targets are
 *    G2b/G3 (do NOT do them now, but do not architect them out)."
 *
 * "Do not architect them out" is why this file exists at all rather than being
 * deleted. Three things are kept, and they are exactly what the G2a check path
 * touches:
 *
 * - {@link Embedder} — the injection type. `semantic.ts`, `graph.ts`, and
 *   `pipeline/check.ts`'s `CheckOptions.semantic.embedder` are all typed against
 *   it, unchanged, so G2b lands a real loader by ADDING a producer of this type,
 *   not by reshaping any consumer.
 * - {@link cosine} — verbatim (a dot product over L2-normalized vectors). The two
 *   semantic tiers import it lazily-per-call, so it must resolve even when no
 *   model exists.
 * - {@link EMBED_MODEL} — the pin, kept as a constant so the G2b loader and any
 *   `download-model` surface quote one string.
 *
 * G2a therefore runs `check` with `options.semantic` ABSENT, which v4
 * pipeline already handles as a first-class case: it emits a
 * `semantic-tier-skipped` demotion carrying the supplying command, so `verified`
 * can never be true over a document whose opposition candidates went untriaged.
 * The absence is DISCLOSED, not silently defaulted — the same demotion v4
 * produces for a library caller who supplies no embedder.
 *
 * ## Propose-only (the load-bearing invariant, preserved)
 *
 * An embedder produces similarity SCORES. It never decides a conflict. The only
 * durable effect of a high score is a suggested glossary entry the calling agent
 * may confirm; the deterministic SMT verdict path consults the committed
 * glossary, never a model. That is why dropping the loader costs correctness
 * nothing — it removes a PROPOSER, and the pipeline demotes accordingly.
 */

/** The pinned embedding model (user-specified). ONNX WASM, no native build. */
export const EMBED_MODEL = 'Xenova/bge-base-en-v1.5'

/** A loaded embedder: text[] → one L2-normalized vector per input. */
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>

/**
 * Cosine similarity of two L2-normalized vectors — a plain dot product, since
 * `normalize: true` guarantees unit length. Returns a value in `[-1, 1]`.
 * Mismatched lengths return 0 (defensive; never thrown).
 *
 * Verbatim from v4.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}
