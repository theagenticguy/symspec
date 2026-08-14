/**
 * `download-model`, tested WITHOUT downloading 110 MB.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The fetch itself is not under test here — it is sha256-verified vendored code, and
 * exercising it would mean either shipping the model into CI or asserting against the
 * network. What IS under test is everything around it, which is where an agent-facing
 * command actually breaks:
 *
 * 1. the ENVELOPE — every field of the report reaches the payload, with the derived
 *    `totalBytes` and the pinned identity intact;
 * 2. the FAILURE MAPPING — a failed fetch becomes `ERR_EMBED_MODEL_MISSING` at exit 2,
 *    carrying remedies that name a switch which is not already on;
 * 3. `modelCacheDir()`'s PRECEDENCE, which is the one part of the cache module that is a
 *    pure function of the environment and the one thing a user has to be able to predict;
 * 4. the command's PRESENCE in the manifest, which is what makes it discoverable — the
 *    bidirectional CLI-vs-manifest drift tests in `cli.test.ts` then cover `--help` for
 *    free.
 *
 * A "fails closed when offline" spawn test is absent on purpose: it needs the network to
 * FAIL, which no CI runner reliably provides, and (2) proves the same mapping through the
 * seam without depending on the weather.
 */

import { Effect, type Layer, type Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { modelCacheDir } from '../../adapters/embedding/model-cache.ts'
import {
  modelDownloadFailingWith,
  modelDownloadOf,
} from '../../adapters/embedding/model-download.ts'
import type { OperationalError } from '../../ports/errors.ts'
import type { DownloadReport, ModelDownload } from '../../ports/model-download.ts'
import { runOperation } from '../runtime/operation.ts'
import { currentManifest, downloadModelOp } from './index.ts'
import type { ModelDownloadPayload } from './model.ts'

/** The pinned identity, restated here so a silent re-pin of the model is a diff. */
const MODEL = 'Xenova/bge-base-en-v1.5'
const REVISION = '4d6cd88e18e51a5e020c2c305726d76ada9c03cf'

const REPORT: DownloadReport = {
  model: MODEL,
  revision: REVISION,
  cacheDir: '/tmp/symspec-cache',
  assets: [
    { name: 'model_quantized.onnx', bytes: 110_083_337, cached: false },
    { name: 'tokenizer.json', bytes: 711_396, cached: true },
    { name: 'tokenizer_config.json', bytes: 366, cached: true },
  ],
  alreadyComplete: false,
}

/** Run the operation over a supplied `ModelDownload`, the way the suite runs every other
 * operation: `Effect.result` so a failure is a value rather than a rejection. */
const run = (
  layer: Layer.Layer<ModelDownload>,
): Promise<
  | { readonly _tag: 'Success'; readonly success: { readonly data: ModelDownloadPayload } }
  | { readonly _tag: 'Failure'; readonly failure: OperationalError | Schema.SchemaError }
> =>
  Effect.runPromise(
    Effect.result(runOperation(downloadModelOp, {})).pipe(Effect.provide(layer)),
  ) as never

/** The success payload, or a failure that names the code rather than `undefined`. */
const expectOk = async (layer: Layer.Layer<ModelDownload>): Promise<ModelDownloadPayload> => {
  const result = await run(layer)
  if (result._tag !== 'Success') {
    throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  }
  return result.success.data
}

describe('download-model — the envelope', () => {
  it('projects every asset and derives the total, with the pinned identity intact', async () => {
    const data = await expectOk(modelDownloadOf(REPORT))
    expect(data.model).toBe(MODEL)
    expect(data.revision).toBe(REVISION)
    expect(data.cacheDir).toBe('/tmp/symspec-cache')
    expect(data.assets).toEqual([
      { name: 'model_quantized.onnx', bytes: 110_083_337, cached: false },
      { name: 'tokenizer.json', bytes: 711_396, cached: true },
      { name: 'tokenizer_config.json', bytes: 366, cached: true },
    ])
    // Derived rather than passed through, so a caller can report a size without summing.
    expect(data.totalBytes).toBe(110_083_337 + 711_396 + 366)
  })

  it('reports a no-op AS a no-op, so a setup step can run unconditionally', async () => {
    // The distinction that makes this command safe to put in an install script: an
    // already-warm cache has to be distinguishable from a ~110 MB fetch, or every run
    // reads as if it downloaded the model again.
    const data = await expectOk(
      modelDownloadOf({
        ...REPORT,
        alreadyComplete: true,
        assets: REPORT.assets.map((asset) => ({ ...asset, cached: true })),
      }),
    )
    expect(data.alreadyComplete).toBe(true)
    expect(data.assets.every((asset) => asset.cached)).toBe(true)
  })
})

describe('download-model — the failure path', () => {
  it('maps any fetch failure onto ERR_EMBED_MODEL_MISSING at exit 2', async () => {
    const result = await run(
      modelDownloadFailingWith(new Error('getaddrinfo ENOTFOUND huggingface.co')),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    const failure = result.failure as unknown as {
      _tag: string
      error: string
      suggestions: readonly string[]
    }
    expect(failure._tag).toBe('ERR_EMBED_MODEL_MISSING')
    // The underlying cause survives into the message: "could not be fetched" alone leaves
    // a reader with nothing to act on.
    expect(failure.error).toContain('ENOTFOUND')

    const suggestions = failure.suggestions.join(' ')
    // The remedy must not point at a switch this command already flipped.
    expect(suggestions).not.toContain('SYMSPEC_EMBED_ALLOW_REMOTE=1 to fetch it once')
    expect(suggestions).toContain('sha256-pinned')
    expect(suggestions).toContain('SYMSPEC_MODEL_DIR')
    expect(suggestions).toContain('--semantic=false')
  })
})

describe('the cache directory is predictable', () => {
  const saved = {
    dir: process.env.SYMSPEC_MODEL_DIR,
    xdg: process.env.XDG_CACHE_HOME,
  }

  afterEach(() => {
    // Restored rather than deleted, because the suite-wide `SYMSPEC_EMBED_STUB` lives in
    // the same environment and a blanket reset would take it with it.
    for (const [key, value] of [
      ['SYMSPEC_MODEL_DIR', saved.dir],
      ['XDG_CACHE_HOME', saved.xdg],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('takes SYMSPEC_MODEL_DIR VERBATIM, appending nothing', () => {
    // Verbatim matters for an air-gapped host: the operator provisions a directory and
    // needs the three files to be read from exactly that path, not a revision-named
    // subdirectory of it they would have to guess.
    process.env.SYMSPEC_MODEL_DIR = '/srv/models/symspec'
    expect(modelCacheDir()).toBe('/srv/models/symspec')
  })

  it('falls back to XDG_CACHE_HOME, under a REVISION-named directory', () => {
    delete process.env.SYMSPEC_MODEL_DIR
    process.env.XDG_CACHE_HOME = '/tmp/xdg'
    const dir = modelCacheDir()
    expect(dir.startsWith('/tmp/xdg/symspec/models/')).toBe(true)
    // The revision is IN the path, so bumping the pin lands in a fresh directory instead
    // of half-overwriting the previous model's assets.
    expect(dir).toContain(REVISION)
    expect(dir).toContain(MODEL.replace('/', '__'))
  })
})

describe('download-model is discoverable', () => {
  it('appears in the manifest, with a summary that says what it is for', () => {
    // Presence in the manifest is what makes it reachable for an agent that never reads a
    // README. `cli.test.ts`'s bidirectional drift tests take it from here to `--help`.
    const row = currentManifest().operations.find((op) => op.name === 'download-model')
    expect(row).toBeDefined()
    expect(row?.summary).toContain('offline')
    // No flags: the model is pinned and the cache location is an environment variable. An
    // EMPTY `properties`, not an absent one — and `type: 'object'` rather than the
    // object-or-array an unlowered empty struct produces, which is the shape every other
    // no-input operation is asserted to have.
    expect(row?.input).toMatchObject({ type: 'object', properties: {} })
    expect(JSON.stringify(row?.input)).not.toContain('"array"')
  })
})
