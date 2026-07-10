/**
 * Pinned model + tokenizer asset cache for the semantic tier (AC-9-4).
 *
 * The embedding tier runs the `bge-base-en-v1.5` sentence model on the ONNX
 * **WASM** runtime (`onnxruntime-web`, no native `onnxruntime-node`). Three
 * assets are needed at runtime: the ~110 MB quantized `.onnx` weights and two
 * small tokenizer files. Bundling 110 MB in the npm tarball is hostile to every
 * install, so instead this module fetches the assets ON FIRST USE into an OS
 * cache directory, verifies each against a **pinned sha256**, and reuses them
 * forever after — the package ships as code only.
 *
 * ## Pinned to a commit, verified by digest (the reproducibility invariant)
 *
 * Every asset is fetched from ONE frozen HuggingFace revision and checked
 * against a hardcoded sha256. A silent upstream change (or a corrupt/partial
 * download) fails the digest check rather than poisoning embeddings, so given
 * (pinned revision + pinned digests) the semantic tier is byte-reproducible —
 * the same discipline `embed.ts` documents for the propose/decide split.
 *
 * ## Offline discipline (mirrors the Lean-toolchain pattern)
 *
 * `allowRemote` defaults OFF. When an asset is already cached it loads with no
 * network (fully offline). When it is absent AND remote fetching is not enabled
 * (`SYMSPEC_EMBED_ALLOW_REMOTE=1`), {@link ensureModelAssets} throws so the
 * caller surfaces `ERR_EMBED_MODEL_MISSING` — it NEVER blocks the SMT/lint
 * tiers, which run independently.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The pinned model: `Xenova/bge-base-en-v1.5` at a frozen commit. Single-file
 * quantized (int8) export — the BAAI weights, but one `.onnx` file with no
 * external-data sidecar (which avoids an onnxruntime-web multi-thread hang on
 * external-data models). Cite AC-9-4.
 */
const MODEL_REPO = 'Xenova/bge-base-en-v1.5'
const MODEL_REVISION = '4d6cd88e18e51a5e020c2c305726d76ada9c03cf'

/** One fetched-and-verified asset: its repo-relative path and pinned digest. */
interface PinnedAsset {
  /** Path within the HF repo (and the basename used in the local cache). */
  readonly repoPath: string
  /** Local cache filename (basename of {@link repoPath}). */
  readonly cacheName: string
  /** Hex sha256 the downloaded bytes MUST match, or the fetch fails. */
  readonly sha256: string
  /** Bytes; large assets (the model) are worth reporting in the error text. */
  readonly bytes: number
}

/** The three pinned assets, each digest-verified. */
const ASSETS = {
  model: {
    repoPath: 'onnx/model_quantized.onnx',
    cacheName: 'model_quantized.onnx',
    sha256: 'c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d',
    bytes: 110_083_337,
  },
  tokenizer: {
    repoPath: 'tokenizer.json',
    cacheName: 'tokenizer.json',
    sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    bytes: 711_396,
  },
  tokenizerConfig: {
    repoPath: 'tokenizer_config.json',
    cacheName: 'tokenizer_config.json',
    sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    bytes: 366,
  },
} as const satisfies Record<string, PinnedAsset>

/** Resolved local paths to the three verified assets. */
export interface ModelAssets {
  /** Absolute path to the quantized `.onnx` weights. */
  readonly modelPath: string
  /** Absolute path to `tokenizer.json`. */
  readonly tokenizerPath: string
  /** Absolute path to `tokenizer_config.json`. */
  readonly tokenizerConfigPath: string
}

/** Raised when an asset is absent from cache and remote fetching is disabled. */
export class ModelAssetsUnavailableError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(reason)
    this.name = 'ModelAssetsUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * The cache directory for symspec model assets. Honors `SYMSPEC_MODEL_DIR`, then
 * `XDG_CACHE_HOME`, falling back to `~/.cache` (or the OS temp dir if there is
 * no home). Pinned by revision so a model bump lands in a fresh subdir.
 */
export function modelCacheDir(): string {
  const override = process.env.SYMSPEC_MODEL_DIR
  if (override !== undefined && override.length > 0) return override
  const xdg = process.env.XDG_CACHE_HOME
  const home = homedir()
  const base =
    xdg && xdg.length > 0 ? xdg : home && home.length > 0 ? join(home, '.cache') : tmpdir()
  return join(base, 'symspec', 'models', `${MODEL_REPO.replace('/', '__')}@${MODEL_REVISION}`)
}

/** Read a cached file and confirm its sha256; returns bytes or null on any miss. */
async function readIfValid(path: string, sha256: string): Promise<Buffer | null> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return null
  }
  const digest = createHash('sha256').update(buf).digest('hex')
  return digest === sha256 ? buf : null
}

/** The HF resolve URL for a pinned asset at the frozen revision. */
function assetUrl(asset: PinnedAsset): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${asset.repoPath}`
}

/**
 * Ensure one asset is present and digest-valid at `dir/cacheName`. Uses the
 * cache when valid; otherwise (only if `allowRemote`) downloads, verifies, and
 * atomically writes it. Throws {@link ModelAssetsUnavailableError} on a cache
 * miss with remote disabled, a network failure, or a digest mismatch.
 */
async function ensureAsset(dir: string, asset: PinnedAsset, allowRemote: boolean): Promise<string> {
  const dest = join(dir, asset.cacheName)
  if ((await readIfValid(dest, asset.sha256)) !== null) return dest

  if (!allowRemote) {
    throw new ModelAssetsUnavailableError(
      `Model asset "${asset.cacheName}" is not cached and remote fetching is disabled.`,
    )
  }

  let bytes: Buffer
  try {
    const res = await fetch(assetUrl(asset))
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${asset.repoPath}`)
    }
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw new ModelAssetsUnavailableError(`Failed to download "${asset.cacheName}".`, e)
  }

  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) {
    throw new ModelAssetsUnavailableError(
      `Downloaded "${asset.cacheName}" failed sha256 verification ` +
        `(expected ${asset.sha256}, got ${digest}).`,
    )
  }

  // Atomic publish: write to a temp sibling, then rename into place so a
  // concurrent reader never sees a half-written file.
  await mkdir(dir, { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, dest)
  return dest
}

/**
 * Ensure all three pinned assets are cached and digest-valid, fetching any that
 * are missing when `allowRemote` is set. Returns their absolute local paths.
 * The model download is ~110 MB and happens at most once per pinned revision.
 */
export async function ensureModelAssets(allowRemote: boolean): Promise<ModelAssets> {
  const dir = modelCacheDir()
  const [modelPath, tokenizerPath, tokenizerConfigPath] = await Promise.all([
    ensureAsset(dir, ASSETS.model, allowRemote),
    ensureAsset(dir, ASSETS.tokenizer, allowRemote),
    ensureAsset(dir, ASSETS.tokenizerConfig, allowRemote),
  ])
  return { modelPath, tokenizerPath, tokenizerConfigPath }
}
