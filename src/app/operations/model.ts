/**
 * `download-model` — fetch the embedding model once, so every later run is offline.
 *
 * ## Why this command has to exist
 *
 * The semantic tier is on by DEFAULT (`check.ts`'s `semantic` option), and a missing model
 * fails the run CLOSED with `ERR_EMBED_MODEL_MISSING` rather than skipping the tier — a
 * detector that can be skipped is a gate that can be gamed by omission. That is the right
 * posture, and it means a first `check` on a fresh machine fails until the model is
 * present.
 *
 * There are two ways to get it there. `SYMSPEC_EMBED_ALLOW_REMOTE=1 symspec check …` fetches
 * it lazily, mid-check, which mixes a ~110 MB download into the latency of the operation an
 * agent is timing. This command does it deliberately, once, with the download as the thing
 * being reported rather than a side effect of something else — which is what an install
 * script, a Dockerfile layer, or an agent's setup step actually wants.
 *
 * ## No flags, on purpose
 *
 * The model is sha256-PINNED: repo, revision, and per-asset digest are constants, so there
 * is no version to choose and offering one would imply a choice that does not exist. The
 * cache location is configured by `SYMSPEC_MODEL_DIR` (an environment variable, because a
 * Dockerfile and a shell profile can both set it and neither can pass a flag), and the
 * resolved directory is REPORTED so a caller never has to guess where the bytes landed.
 *
 * Idempotent by construction: `alreadyComplete` distinguishes "nothing to do" from "fetched
 * ~110 MB", so a setup step can run this unconditionally and still say something true.
 */

import { Effect, Schema } from 'effect'
import type { ErrEmbedModelMissing } from '../../ports/errors.ts'
import { ModelDownload } from '../../ports/model-download.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

/** One asset's outcome. `cached` is what makes a no-op distinguishable from a fetch. */
export interface ModelAssetPayload {
  readonly name: string
  readonly bytes: number
  readonly cached: boolean
}

/** The `download-model` payload. */
export interface ModelDownloadPayload {
  /** The pinned model id. */
  readonly model: string
  /** The frozen upstream revision every asset is pinned to. */
  readonly revision: string
  /** Absolute cache directory the assets live in, resolved — never a pattern to expand. */
  readonly cacheDir: string
  readonly assets: readonly ModelAssetPayload[]
  /** True when every asset was already present and nothing was downloaded. */
  readonly alreadyComplete: boolean
  /** Total bytes across every asset, so a caller can report a size without summing. */
  readonly totalBytes: number
}

export const downloadModelOp = defineOperation({
  name: 'download-model',
  summary: 'Fetch the pinned embedding model into the local cache, so later runs are offline',
  type: 'modelDownload',
  // `Schema.Struct({})` — the same no-input shape as `version` and `manifest`, which the
  // manifest projection lowers to `{"type":"object"}` rather than an object-or-array.
  input: Schema.Struct({}),
  handler: (): Effect.Effect<
    ReturnType<typeof ok<'modelDownload', ModelDownloadPayload>>,
    ErrEmbedModelMissing,
    ModelDownload
  > =>
    Effect.flatMap(ModelDownload, (service) =>
      Effect.map(service.run, (report) =>
        ok('modelDownload', {
          model: report.model,
          revision: report.revision,
          cacheDir: report.cacheDir,
          assets: report.assets.map((asset) => ({
            name: asset.name,
            bytes: asset.bytes,
            cached: asset.cached,
          })),
          alreadyComplete: report.alreadyComplete,
          totalBytes: report.assets.reduce((sum, asset) => sum + asset.bytes, 0),
        }),
      ),
    ),
})
