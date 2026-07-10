/**
 * AC-9-4 pre-warm: the model asset cache + `download-model` core logic.
 *
 * Hermetic + offline: `globalThis.fetch` is stubbed (no real network) and the
 * cache is redirected to a throwaway temp dir via `SYMSPEC_MODEL_DIR`. The pins
 * (digests) are fixed upstream, so we cannot fabricate bytes that hash to them;
 * instead these tests pin the CONTRACTS that don't require the real weights:
 * cache-dir resolution, the offline cache-miss error, digest rejection of a bad
 * download, HTTP-error mapping, and that a stale cached file is never trusted.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadModelAssets,
  ensureModelAssets,
  ModelAssetsUnavailableError,
  modelCacheDir,
} from '../model-cache.js'

/** The pinned model weights' sha256 (from model-cache.ts) — used for a sanity check. */
const MODEL_SHA = 'c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d'

describe('model-cache (AC-9-4)', () => {
  let dir: string
  const prevEnv = process.env.SYMSPEC_MODEL_DIR

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'symspec-model-cache-test-'))
    process.env.SYMSPEC_MODEL_DIR = dir
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.SYMSPEC_MODEL_DIR
    else process.env.SYMSPEC_MODEL_DIR = prevEnv
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('honors SYMSPEC_MODEL_DIR for the cache directory', () => {
    expect(modelCacheDir()).toBe(dir)
  })

  it('ensureModelAssets throws (no fetch) when an asset is absent and remote is off', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(ensureModelAssets(false)).rejects.toBeInstanceOf(ModelAssetsUnavailableError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a download whose bytes fail sha256 verification', async () => {
    const badFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', badFetch)
    await expect(downloadModelAssets()).rejects.toThrow(/sha256/i)
    expect(badFetch).toHaveBeenCalled()
  })

  it('maps an HTTP error to ModelAssetsUnavailableError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    await expect(downloadModelAssets()).rejects.toBeInstanceOf(ModelAssetsUnavailableError)
  })

  it('never trusts a stale cached file whose digest does not match the pin', async () => {
    const stale = new Uint8Array([42, 42, 42, 42])
    // Sanity: our filler bytes are not an accidental digest collision with the pin.
    expect(createHash('sha256').update(stale).digest('hex')).not.toBe(MODEL_SHA)
    await writeFile(join(dir, 'model_quantized.onnx'), stale)
    // The stale file is rejected → the fetch path runs and (serving mismatched
    // bytes) fails the digest check, rather than falsely accepting the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0]), { status: 200 })),
    )
    await expect(downloadModelAssets()).rejects.toThrow(/sha256|not cached|download/i)
  })
})
