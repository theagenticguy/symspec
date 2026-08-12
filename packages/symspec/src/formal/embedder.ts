/**
 * `EmbedderService` — the semantic tier's PROPOSE half, behind an Effect Layer.
 *
 * G2a left this seam open deliberately: `donor/formal/embed.ts` was reduced to the
 * `Embedder` injection TYPE plus `cosine`, and the note there said a real loader
 * lands in G2b "by ADDING a producer of this type, not by reshaping any consumer".
 * This is that producer.
 *
 * ## The doctrine this module must not violate (`embeddings-propose-smt-decide`)
 *
 * Embeddings PROPOSE. Committed tables DECIDE. Never a verdict.
 *
 * The tier embeds response phrasings and reports high-cosine pairs that did NOT
 * already unify. Its entire durable output is a SUGGESTED `glossary add` or
 * `antonym add` — a `DocumentOp` an agent commits after review — and the
 * deterministic SMT path then reads the COMMITTED table, never a score. That is what
 * keeps `check` byte-reproducible given (document + tables + pinned model): the fuzzy
 * step ran once, was reviewed, and is in git.
 *
 * Two consequences enforced elsewhere but worth naming here, because this module is
 * where someone would be tempted to break them:
 *
 * - `FND_SIMILAR_SEMANTIC` and `FND_OPPOSITION_CANDIDATE` are `info` severity and in
 *   the pipeline's `PROPOSE_ONLY_FND_CODES` set. They may DEMOTE `verified` toward
 *   abstention (an untriaged opposition candidate means the tool has not ruled out a
 *   conflict) and can never PROMOTE it. Demotion-only, in one direction.
 * - the opposition finding's message offers BOTH `antonym add` and `glossary add`
 *   with an explicit warning, because embeddings CANNOT tell opposites from synonyms
 *   — antonyms embed CLOSE. Committing the wrong one MANUFACTURES a false
 *   contradiction, which is the tool's worst available bug.
 *
 * ## Why a Layer, and why the boot is an EFFECT inside the shape
 *
 * Exactly the shape `SolverService` uses, for exactly the reason recorded there: on
 * beta.102 a PROVIDED Layer is BUILT EAGERLY, with or without a consumer, and
 * `Layer.mergeAll` builds every member. So a shape carrying a loaded `Embedder` as a
 * plain value would fetch and boot a ~110 MB ONNX model on `symspec version`.
 *
 * `Effect.cached` inside the shape defers the cost to first use while the LAYER keeps
 * ownership of the lifetime. The `Effect.provideService(Scope.Scope, scope)` is
 * mandatory rather than decorative — `cached` defers the effect, and by the time a
 * caller yields it the construction effect has returned and the ambient Scope is
 * gone (`Service not found: effect/Scope`, probed in G2a).
 *
 * ## Fail CLOSED, and why that is the opposite of the donor's first design
 *
 * The donor's AC-9-4 shipped the tier as LAZY and OPT-IN ("default check pays zero
 * cost"). A red-team eval retired that half: a certification gate whose opposition
 * detector can be silently skipped is GAMEABLE BY OMISSION — 25/30 wins against
 * `--strict`. So a missing model is `ERR_EMBED_MODEL_MISSING` (exit 2) rather than a
 * silent skip.
 *
 * v5 keeps the fail-closed rule and its shape, with one difference that is a
 * consequence of the ops table rather than a change of mind: `--semantic` is a real
 * flag again, defaulting ON. The donor made it a deprecated no-op because it had
 * already shipped it as opt-in and could not change the meaning of a flag agents
 * were passing. v5 has no such history, and a flag whose only documented behavior is
 * "does nothing" is worse for an agent reading the manifest than a flag that says
 * what it does. `--semantic=false` is the escape hatch for an air-gapped host with no
 * cache, and it DEMOTES rather than passing quietly — the skip is disclosed as
 * `semantic-tier-skipped`, exactly as the absence of an embedder always was.
 */

import { Context, Effect, Layer, Scope } from 'effect'
// STATIC, not dynamic, and deliberately so. The transplanted `embed.ts` is
// interface-only — a type, a five-line `cosine`, and the model-id constant — so
// importing it eagerly costs nothing. The EXPENSIVE things (`model-cache.ts`,
// `onnxruntime-web`, the tokenizer) stay dynamic inside `loadRealEmbedder`, which is
// where the ~110 MB actually lives.
//
// The build still reports INEFFECTIVE_DYNAMIC_IMPORT for `embed.ts`, and it is
// EXPECTED rather than a defect to chase: `donor/formal/semantic.ts` lazy-imports it
// per call (`await import('./embed.ts')` for `cosine`), and that file is byte-guarded
// against the donor. Its laziness was load-bearing when `embed.ts` still contained
// the ONNX loader; now that the loader lives here, the lazy import buys nothing but
// cannot be removed without editing a verbatim tier. The correct trade is the warning.
import { EMBED_MODEL, type Embedder } from '../donor/formal/embed.ts'
import { ErrEmbedModelMissing } from '../kernel/errors.ts'

/** The env var that enables the deterministic TEST stub. */
export const EMBED_STUB_ENV = 'SYMSPEC_EMBED_STUB'

/** The env var that allows a first-use model download. */
export const EMBED_ALLOW_REMOTE_ENV = 'SYMSPEC_EMBED_ALLOW_REMOTE'

/**
 * The pinned model, re-exported from the transplanted interface so the loader, the
 * error text, and any future `download-model` surface quote ONE string.
 */
export { EMBED_MODEL } from '../donor/formal/embed.ts'

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------

/**
 * The deterministic hash-based stub embedder, enabled ONLY by
 * `SYMSPEC_EMBED_STUB=1`.
 *
 * A TEST-ONLY escape hatch so the suite (and any spawned-CLI test) exercises the
 * always-on tier without the ~110 MB model. It hashes each text into a fixed
 * pseudo-vector — a pure function of the bytes — so runs are REPRODUCIBLE while the
 * cosines are meaningless.
 *
 * Three properties, each load-bearing:
 *
 * - It is NOT a fallback. Without the env var a missing model still fails closed.
 *   A stub that silently substituted for an absent model would restore exactly the
 *   gameable-by-omission hole the fail-closed rule exists to close.
 * - It is DETERMINISTIC. The semantic tier is on by default, so without a stub every
 *   test that runs `check` either downloads 110 MB or asserts against a moving target.
 *   A random stub would make the tier's findings unpinnable and the propose-only claim
 *   untestable.
 * - Its behavior is fixed (FNV-1a seed, xorshift, 16 dimensions, L2 normalization), so a
 *   recorded cosine stays valid across runs and machines.
 */
export const stubEmbedder = (): Embedder => {
  const DIM = 16
  return async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(DIM)
      let h = 2166136261
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      for (let d = 0; d < DIM; d++) {
        h ^= h << 13
        h ^= h >>> 17
        h ^= h << 5
        v[d] = ((h >>> 0) % 2000) / 1000 - 1
      }
      let norm = 0
      for (let d = 0; d < DIM; d++) norm += (v[d] as number) ** 2
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < DIM; d++) v[d] = (v[d] as number) / norm
      return v
    })
}

// ---------------------------------------------------------------------------
// The real loader
// ---------------------------------------------------------------------------

/** The subset of `@huggingface/tokenizers`' `encode` result this consumes. */
interface Encoding {
  ids: number[]
  attention_mask: number[]
  token_type_ids?: number[]
}

/** BGE's max sequence length (BERT WordPiece); longer inputs are truncated. */
const MAX_SEQ_LEN = 512

/**
 * Build the real embedder: the pinned `Xenova/bge-base-en-v1.5` ONNX model on the
 * **WASM** runtime, with a pure-JS tokenizer.
 *
 * Every line of the pipeline below is a decision the donor recorded, and three of
 * them are the difference between working and silently wrong:
 *
 * - **`onnxruntime-web` directly, NOT transformers.js.** `@huggingface/transformers`
 *   hard-binds `onnxruntime-node` at import time in Node and `device: 'wasm'` THROWS
 *   `Unsupported device` — the Node branch never registers wasm. So "pure WASM, no
 *   native binary" is UNACHIEVABLE through that library, and driving the runtime plus
 *   a pure-JS tokenizer is the only way to honor the portability constraint.
 * - **CLS pooling, not mean.** BGE trains on the `[CLS]` token at position 0. Mean
 *   pooling is off-spec for this model and produces plausible-looking vectors with
 *   wrong geometry — the worst failure shape, since nothing errors.
 * - **`token_type_ids` is a REQUIRED input** for the BERT/BGE export, even though it
 *   is all zeros. Omitting it fails at session run, not at load.
 *
 * `numThreads = 1` is the safe Node config (no SharedArrayBuffer/worker) and also
 * avoids a multi-thread hang on external-data models.
 *
 * Lazily imported, all of it: nothing here is in the module graph of a `symspec
 * version`.
 */
const loadRealEmbedder = async (allowRemote: boolean): Promise<Embedder> => {
  const { ensureModelAssets } = await import('../donor/formal/model-cache.ts')
  // Cache hit → fully offline. Miss + allowRemote → fetch + sha256-verify. Miss +
  // offline → throws, which the Layer maps to ERR_EMBED_MODEL_MISSING.
  const assets = await ensureModelAssets(allowRemote)

  const { readFile } = await import('node:fs/promises')
  const [ort, { Tokenizer }] = await Promise.all([
    import('onnxruntime-web'),
    import('@huggingface/tokenizers'),
  ])

  ort.env.wasm.numThreads = 1

  const [tokenizerJson, tokenizerConfig, modelBytes] = await Promise.all([
    readFile(assets.tokenizerPath, 'utf8').then((s) => JSON.parse(s) as object),
    readFile(assets.tokenizerConfigPath, 'utf8').then((s) => JSON.parse(s) as object),
    readFile(assets.modelPath),
  ])
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })

  return async (texts) => {
    if (texts.length === 0) return []

    const encs = texts.map(
      (t) =>
        tokenizer.encode(t, { add_special_tokens: true, return_token_type_ids: true }) as Encoding,
    )
    const seqLen = Math.min(
      MAX_SEQ_LEN,
      encs.reduce((m, e) => Math.max(m, e.ids.length), 0),
    )
    const batch = encs.length
    const ids = new BigInt64Array(batch * seqLen)
    const mask = new BigInt64Array(batch * seqLen)
    const type = new BigInt64Array(batch * seqLen)
    for (let b = 0; b < batch; b++) {
      const e = encs[b]
      if (e === undefined) continue
      const n = Math.min(seqLen, e.ids.length)
      for (let j = 0; j < n; j++) {
        ids[b * seqLen + j] = BigInt(e.ids[j] ?? 0)
        mask[b * seqLen + j] = BigInt(e.attention_mask[j] ?? 0)
        type[b * seqLen + j] = BigInt(e.token_type_ids?.[j] ?? 0)
      }
      // Remaining positions stay 0 — [PAD]=0, attention 0, type 0.
    }
    const dims = [batch, seqLen]
    const output = await session.run({
      input_ids: new ort.Tensor('int64', ids, dims),
      attention_mask: new ort.Tensor('int64', mask, dims),
      token_type_ids: new ort.Tensor('int64', type, dims),
    })

    // CLS pooling: the [CLS] token (sequence index 0) of last_hidden_state
    // [batch, seq, hidden], then L2-normalize so cosine IS a dot product.
    const hidden = output.last_hidden_state as { data: Float32Array; dims: readonly number[] }
    const H = hidden.dims[2] as number
    const data = hidden.data
    const rows: Float32Array[] = []
    for (let b = 0; b < batch; b++) {
      const vec = new Float32Array(H)
      const off = b * seqLen * H
      for (let h = 0; h < H; h++) vec[h] = data[off + h] as number
      let norm = 0
      for (let h = 0; h < H; h++) norm += (vec[h] as number) ** 2
      norm = Math.sqrt(norm) || 1
      for (let h = 0; h < H; h++) vec[h] = (vec[h] as number) / norm
      rows.push(vec)
    }
    return rows
  }
}

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
 * Wrap ANY loader failure in the typed error, so the contract holds regardless of
 * where the failure came from.
 *
 * A cache miss, an offline host, a corrupt download failing its digest, a missing
 * runtime — all of them mean the same thing to a caller: the tier cannot run. The
 * donor's `loadEmbedder` wrapped its factory the same way and for the same reason,
 * and the suggestions name the two real remedies rather than describing the internal
 * fault.
 */
const asMissing = (cause: unknown, model: string): ErrEmbedModelMissing =>
  new ErrEmbedModelMissing({
    error:
      `The embedding model "${model}" is not available: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    suggestions: [
      `Set ${EMBED_ALLOW_REMOTE_ENV}=1 to fetch it once into the OS cache (~110 MB, sha256-pinned).`,
      'Air-gapped hosts: provision the cache directory, then every later run is fully offline.',
      'The semantic tier is part of every check — a missing model fails the run CLOSED rather than silently skipping opposition detection, because a detector that can be skipped is a gate that can be gamed by omission.',
      `Pass --semantic=false to run without it; the skip is then DISCLOSED as a \`semantic-tier-skipped\` demotion and \`verified\` cannot be true.`,
    ],
    repair: {
      ops: [],
      commands: [`${EMBED_ALLOW_REMOTE_ENV}=1 symspec check`],
    },
  })

/**
 * THE LAYER. Same three-part construction as `solverServiceLayer`, and each part is
 * load-bearing for the same probed reasons:
 *
 * 1. the Layer's own `Scope` is captured, because `Layer.effect` discharges a `Scope`
 *    requirement from its construction effect;
 * 2. `Effect.cached` makes the load lazy AND once — unused means zero model loads,
 *    which is what keeps `manifest`/`list`/`show` free;
 * 3. the env is read ONCE at construction (the "Config snapshots env at init"
 *    discipline), so every operation in one invocation sees the same configuration
 *    and a test cannot be affected by a later mutation of `process.env`.
 *
 * The Scope is captured but not currently used by the loader — an ONNX session has no
 * finalizer worth registering, and pretending otherwise would be theatre. It is
 * captured because the moment the loader DOES own something releasable, the seam has
 * to exist already; see `solver-service.ts` for what happens when a deferred acquire
 * needs a scope that has gone.
 */
export const embedderServiceLayer: Layer.Layer<EmbedderService> = Layer.effect(EmbedderService)(
  Effect.gen(function* () {
    yield* Scope.Scope
    // Snapshot the environment at INIT, not per call.
    const useStub = process.env[EMBED_STUB_ENV] === '1'
    const allowRemote = process.env[EMBED_ALLOW_REMOTE_ENV] === '1'

    const load = yield* Effect.cached(
      useStub
        ? Effect.sync(stubEmbedder)
        : Effect.tryPromise({
            try: () => loadRealEmbedder(allowRemote),
            catch: (cause) => asMissing(cause, EMBED_MODEL),
          }),
    )

    return EmbedderService.of({ load, isStub: useStub })
  }),
)

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
