/**
 * THE MODEL PRE-WARM SEAM — one service so `download-model` is testable offline.
 *
 * ## Why a service, and not a direct call
 *
 * `donor/formal/model-cache.ts` already implements the fetch: `downloadModelAssets()`
 * force-fetches all three pinned assets, sha256-verifies each, and reports which were
 * already cached. The seam goes above that call, not inside it — the project rule for
 * anything with a network cost, so a test never depends on the fetch's interior.
 *
 * It also cannot be tested by pre-seeding a cache directory. `readIfValid` verifies the
 * pinned digest, and a sha256 preimage cannot be fabricated — so stub bytes in a temp
 * `SYMSPEC_MODEL_DIR` fail verification and fall straight through to a real 110 MB fetch.
 * Any test that tried it would either download the model in CI or fail with a network
 * error, and neither is a test of this operation.
 *
 * So the seam goes ABOVE the expensive call: one service with one effect, the real Layer
 * wrapping `downloadModelAssets()`, and {@link modelDownloadOf} supplying a hand-authored
 * report. Same three-part shape as `EmbedderService` and `SolverService`, for the same
 * reason — the expensive thing is reached only by the operation that needs it.
 *
 * ## The error is `ERR_EMBED_MODEL_MISSING`, not a new code
 *
 * A failed fetch, a digest mismatch, and an offline host all leave the caller in exactly
 * the state that code names, and its remedy text already names this command — so the loop
 * closes rather than forking. A 22nd `ERR_*` would move every code-count assertion in the
 * catalog for no agent-facing gain.
 */

import { Context, Effect, Layer } from 'effect'
import { ErrEmbedModelMissing } from '../../app/runtime/errors.ts'
import { EMBED_ALLOW_REMOTE_ENV } from './embedder.ts'
import type { DownloadReport } from './model-cache.ts'

export type { DownloadReport }

/** The pre-warm capability: fetch every pinned asset, or fail with the typed error. */
export interface ModelDownloadShape {
  /**
   * Force-fetch the pinned assets into the cache and report what happened.
   *
   * Idempotent: an already-complete cache is a no-op that reports
   * `alreadyComplete: true`, which is how a caller tells a real fetch from a second run.
   */
  readonly run: Effect.Effect<DownloadReport, ErrEmbedModelMissing>
}

/** The service key. `Context.Service` — v4's class-style key; there is no `Context.Tag`. */
export class ModelDownload extends Context.Service<ModelDownload, ModelDownloadShape>()(
  'symspec/ModelDownload',
) {}

/**
 * Every failure becomes the typed error, because they all mean one thing to a caller.
 *
 * The suggestions name the two remedies that exist — retry with a reachable network, or
 * provision the cache directory out of band — and deliberately do NOT suggest
 * `SYMSPEC_EMBED_ALLOW_REMOTE`: this command already allows remote fetching, so pointing
 * at that variable would send a reader to a switch that is already on.
 */
const asFailure = (cause: unknown): ErrEmbedModelMissing =>
  new ErrEmbedModelMissing({
    error:
      'The embedding model could not be fetched: ' +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    suggestions: [
      'Every asset is sha256-pinned, so a corrupt or truncated download fails verification rather than being cached — retrying on a reachable network is safe and resumes nothing.',
      'Air-gapped hosts: copy the three asset files into the cache directory by hand and set SYMSPEC_MODEL_DIR to it; the filenames are printed by a successful run elsewhere.',
      `A run that only needs to SKIP the tier does not need the model: pass --semantic=false to \`check\`, or set ${EMBED_ALLOW_REMOTE_ENV}=1 to fetch it lazily on first use instead of ahead of time.`,
    ],
    repair: { ops: [], commands: ['symspec download-model'] },
  })

/**
 * THE LAYER. The dynamic import is what keeps the model-cache module — and its onnx
 * baggage — out of every command that is not this one.
 */
export const modelDownloadLayer: Layer.Layer<ModelDownload> = Layer.succeed(ModelDownload)(
  ModelDownload.of({
    run: Effect.tryPromise({
      try: async () => {
        const { downloadModelAssets } = await import('./model-cache.ts')
        return downloadModelAssets()
      },
      catch: asFailure,
    }),
  }),
)

/** A Layer supplying a fixed report — the test seam. See the module header for why a
 * seeded cache directory cannot serve this purpose. */
export const modelDownloadOf = (report: DownloadReport): Layer.Layer<ModelDownload> =>
  Layer.succeed(ModelDownload)(ModelDownload.of({ run: Effect.succeed(report) }))

/** A Layer whose fetch always fails — the seam for the failure-mapping assertion. */
export const modelDownloadFailingWith = (cause: unknown): Layer.Layer<ModelDownload> =>
  Layer.succeed(ModelDownload)(ModelDownload.of({ run: Effect.fail(asFailure(cause)) }))
