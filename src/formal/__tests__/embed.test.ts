/**
 * AC-9-4: the local embedding backend. Uses an injected pipeline factory so no
 * real model loads — the test asserts the wiring (mean/normalize call, cosine,
 * and the offline ERR_EMBED_MODEL_MISSING path), not the model's quality.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cosine, EMBED_MODEL, EmbedModelMissingError, loadEmbedder } from '../embed.js'

// The vitest config sets SYMSPEC_EMBED_STUB=1 globally (so spawned-CLI tests
// don't need the real model). THESE tests exercise the real loadEmbedder wiring
// — injected factories and the fail-closed path — so the stub must be off.
beforeAll(() => {
  delete process.env.SYMSPEC_EMBED_STUB
})
afterAll(() => {
  process.env.SYMSPEC_EMBED_STUB = '1'
})

describe('loadEmbedder (AC-9-4)', () => {
  it('builds an embedder from an injected pipeline and returns one vector per text', async () => {
    const calls: Array<{ texts: readonly string[]; opts: unknown }> = []
    const embedder = await loadEmbedder({
      pipelineFactory: async () => async (texts, opts) => {
        calls.push({ texts, opts })
        return { tolist: () => texts.map((_t, i) => [i, 1 - i]) }
      },
    })
    const vecs = await embedder(['a', 'b'])
    expect(vecs).toHaveLength(2)
    expect(Array.from(vecs[0]!)).toEqual([0, 1])
    // CLS-pooled + normalized are requested (how BGE was trained; cosine == dot).
    expect(calls[0]!.opts).toEqual({ pooling: 'cls', normalize: true })
  })

  it('returns [] for empty input without calling the model', async () => {
    const embedder = await loadEmbedder({
      pipelineFactory: async () => async () => {
        throw new Error('should not be called')
      },
    })
    expect(await embedder([])).toEqual([])
  })

  it('throws EmbedModelMissingError (ERR_EMBED_MODEL_MISSING) when the model cannot load', async () => {
    const load = loadEmbedder({
      pipelineFactory: async () => {
        throw new Error('model not in cache')
      },
    })
    await expect(load).rejects.toBeInstanceOf(EmbedModelMissingError)
    await load.catch((e: EmbedModelMissingError) => {
      expect(e.code).toBe('ERR_EMBED_MODEL_MISSING')
      expect(e.suggestions.length).toBeGreaterThan(0)
    })
  })

  it('pins the BGE-ONNX model id', () => {
    expect(EMBED_MODEL).toBe('Xenova/bge-base-en-v1.5')
  })
})

describe('cosine', () => {
  it('is the dot product of unit vectors', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
  })

  it('returns 0 on mismatched lengths (defensive)', () => {
    expect(cosine(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0]))).toBe(0)
  })
})
