/**
 * `EmbedderService` — the embedding capability as a contract.
 *
 * The SHAPE (a memoized `load`, an honest `isStub` disclosure), the env-var
 * switches, and the test seam ({@link embedderLayerOf}) live here; the real
 * ONNX loader and the production Layer live in
 * `adapters/embedding/embedder.ts`.
 */

import { Context, Effect, Layer } from 'effect'
import type { Embedder } from '../domain/engine/formal/embed.ts'
import type { ErrEmbedModelMissing } from './errors.ts'

export type { Embedder }

/** The env var that enables the deterministic TEST stub. */
export const EMBED_STUB_ENV = 'SYMSPEC_EMBED_STUB'

/** The env var that allows a first-use model download. */
export const EMBED_ALLOW_REMOTE_ENV = 'SYMSPEC_EMBED_ALLOW_REMOTE'

/**
 * The pinned model, re-exported from the transplanted interface so the loader, the
 * error text, and any future `download-model` surface quote ONE string.
 */
export { EMBED_MODEL } from '../domain/engine/formal/embed.ts'

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * What a consumer of the semantic tier may do.
 *
 * ONE member, and it is an Effect for the eager-Layer reason in the module header:
 * a plain `Embedder` value here would load the model on every command.
 */
export interface EmbedderShape {
  /**
   * Load (or reuse) the embedder.
   *
   * Memoized via `Effect.cached`: the FIRST caller pays the model load, every later
   * one is free. Fails with `ERR_EMBED_MODEL_MISSING` when the model is absent and
   * remote loading is off — the tier fails CLOSED rather than silently skipping.
   */
  readonly load: Effect.Effect<Embedder, ErrEmbedModelMissing>
  /** Whether this embedder is the deterministic TEST stub. Exposed so a caller can
   * DISCLOSE that the run's cosines are meaningless rather than leaving an agent to
   * infer it from an env var it cannot see. */
  readonly isStub: boolean
}

/** The service key. `Context.Service` — v4's class-style key; there is no
 * `Context.Tag`. */
export class EmbedderService extends Context.Service<EmbedderService, EmbedderShape>()(
  'symspec/EmbedderService',
) {}

/**
 * A Layer supplying a CALLER-PROVIDED embedder — the test seam.
 *
 * Distinct from the stub: the stub is a hash function chosen for determinism, while
 * this takes a hand-authored vector table so a test can assert what happens at a
 * SPECIFIC cosine (just above the threshold, just below it, at the noise floor).
 * That is how a threshold gets tested at all, since the stub's cosines are
 * deliberately meaningless.
 */
export const embedderLayerOf = (embedder: Embedder): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(
    EmbedderService.of({ load: Effect.succeed(embedder), isStub: false }),
  )
