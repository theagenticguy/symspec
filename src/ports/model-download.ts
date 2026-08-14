/**
 * `ModelDownload` — the model pre-warm capability as a contract.
 *
 * The SHAPE (one idempotent `run`), the report it yields, and nothing else.
 * The Layer that actually fetches — and the test seams that do not — live in
 * `adapters/embedding/model-download.ts`; the fetch itself is
 * `adapters/embedding/model-cache.ts`.
 */

import { Context, type Effect } from 'effect'
import type { ErrEmbedModelMissing } from './errors.ts'

/** One asset's line in a {@link DownloadReport}. */
export interface AssetReport {
  /** Cache filename. */
  readonly name: string
  /** Size in bytes (the pinned expectation). */
  readonly bytes: number
  /** Whether this asset was already cached-and-valid before this call. */
  readonly cached: boolean
}

/** The structured result of a {@link downloadModelAssets} run (the `download-model` envelope). */
export interface DownloadReport {
  /** The pinned model id (`repo`). */
  readonly model: string
  /** The frozen HF revision every asset is pinned to. */
  readonly revision: string
  /** Absolute cache directory the assets live in. */
  readonly cacheDir: string
  /** Per-asset cached/fetched status. */
  readonly assets: readonly AssetReport[]
  /** True when every asset was already present (nothing was downloaded). */
  readonly alreadyComplete: boolean
}

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
