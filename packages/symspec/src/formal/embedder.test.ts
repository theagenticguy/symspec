/**
 * The `EmbedderService` Layer and the propose-only doctrine it must not violate.
 *
 * ## Four claims, in order of how much they matter
 *
 * 1. **The Layer is LAZY.** Providing it must cost nothing until a consumer yields
 *    `load`. On beta.102 a provided Layer is BUILT EAGERLY, so this is a property to
 *    verify by probe rather than infer from "layers are lazy" — and it is the reason
 *    the expensive thing sits behind `Effect.cached` INSIDE the service shape.
 * 2. **It fails CLOSED.** A missing model is `ERR_EMBED_MODEL_MISSING`, never a
 *    silent skip. A detector that can be skipped is a gate that can be gamed by
 *    omission, which is the red-team result that retired the donor's opt-in design.
 * 3. **PROPOSE-ONLY, demotion-only.** The semantic findings are `info` severity, they
 *    may push `verified` toward abstention, and they can NEVER promote it. Asserted
 *    against the real transplanted tier with a hand-authored vector table, because
 *    that is the only way to control a cosine precisely.
 * 4. **The stub is deterministic and NOT a fallback.** Determinism is what lets the
 *    differential oracle run the tier on both sides; not-a-fallback is what keeps the
 *    fail-closed rule from having a hole in it.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { glossaryIndex } from '../donor/formal/atomize.ts'
import type { Embedder } from '../donor/formal/embed.ts'
import { cosine } from '../donor/formal/embed.ts'
import {
  DEFAULT_OPPOSITION_COSINE_FLOOR,
  DEFAULT_SEMANTIC_THRESHOLD,
  findOppositionCandidates,
  findSimilarSemantic,
  type SemanticRequirement,
} from '../donor/formal/semantic.ts'
import {
  EMBED_ALLOW_REMOTE_ENV,
  EMBED_STUB_ENV,
  EmbedderService,
  embedderLayerOf,
  embedderServiceLayer,
  stubEmbedder,
} from './embedder.ts'

// ---------------------------------------------------------------------------
// 1. Laziness
// ---------------------------------------------------------------------------

describe('the Layer is LAZY — providing it costs nothing', () => {
  it('does NOT load the embedder when nothing yields `load`', async () => {
    // The trap this guards, verified by probe in G2a: `Effect.provide(layer)` RUNS the
    // layer's construction effect even with no consumer, and `Layer.mergeAll` builds
    // every member. So "the model only loads when check needs it" is a claim about
    // where `Effect.cached` sits, not about Layer semantics.
    let loads = 0
    const counting = Layer.succeed(EmbedderService)(
      EmbedderService.of({
        load: Effect.sync(() => {
          loads += 1
          return stubEmbedder()
        }),
        isStub: true,
      }),
    )
    // Reach the SERVICE without yielding `load` — this is what a cheap command does.
    const reached = await Effect.runPromise(
      Effect.map(EmbedderService, (s) => s.isStub).pipe(Effect.provide(counting)),
    )
    expect(reached).toBe(true)
    expect(loads, 'reaching the service must not load the model').toBe(0)
  })

  it('loads AT MOST ONCE across many consumers (the `cached` half)', async () => {
    let loads = 0
    const layer = Layer.effect(EmbedderService)(
      Effect.gen(function* () {
        const load = yield* Effect.cached(
          Effect.sync(() => {
            loads += 1
            return stubEmbedder()
          }),
        )
        return EmbedderService.of({ load, isStub: true })
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* EmbedderService
        yield* service.load
        yield* service.load
        yield* service.load
      }).pipe(Effect.provide(layer)),
    )
    expect(loads).toBe(1)
  })

  it('the REAL layer builds without loading anything, even with no model cached', async () => {
    // The production layer, provided and built, with the stub env unset and remote
    // fetching off — the configuration in which loading WOULD fail. Building must
    // still succeed, because nothing yields `load`. If construction eagerly loaded,
    // every `symspec version` on a host with no model would fail.
    const withoutEnv = { ...process.env }
    delete withoutEnv[EMBED_STUB_ENV]
    delete withoutEnv[EMBED_ALLOW_REMOTE_ENV]
    const restore = process.env
    try {
      process.env = withoutEnv
      const built = await Effect.runPromise(
        Effect.map(EmbedderService, (s) => s.isStub).pipe(Effect.provide(embedderServiceLayer)),
      )
      expect(built).toBe(false)
    } finally {
      process.env = restore
    }
  })

  it('snapshots the ENV at construction, not per call', async () => {
    // "Config snapshots env at init". A later mutation of `process.env` must not
    // change a built layer's behavior, so two operations in one invocation cannot see
    // different configurations.
    const restore = process.env
    try {
      process.env = { ...process.env, [EMBED_STUB_ENV]: '1' }
      const service = await Effect.runPromise(
        Effect.map(EmbedderService, (s) => s).pipe(Effect.provide(embedderServiceLayer)),
      )
      expect(service.isStub).toBe(true)
      // Flip the env AFTER construction; the built service is unaffected.
      process.env = { ...process.env, [EMBED_STUB_ENV]: '0' }
      expect(service.isStub).toBe(true)
    } finally {
      process.env = restore
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Fail closed
// ---------------------------------------------------------------------------

describe('it fails CLOSED — a missing model is an error, never a silent skip', () => {
  it('yields ERR_EMBED_MODEL_MISSING when the model is absent and remote is off', async () => {
    const restore = process.env
    try {
      // No stub, no remote, and a cache directory that cannot contain the model.
      process.env = {
        ...process.env,
        SYMSPEC_MODEL_DIR: '/nonexistent/symspec-model-cache-for-this-test',
      }
      delete (process.env as Record<string, string | undefined>)[EMBED_STUB_ENV]
      delete (process.env as Record<string, string | undefined>)[EMBED_ALLOW_REMOTE_ENV]

      const result = await Effect.runPromise(
        Effect.result(
          Effect.flatMap(EmbedderService, (s) => s.load).pipe(Effect.provide(embedderServiceLayer)),
        ),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag !== 'Failure') return
      expect(result.failure._tag).toBe('ERR_EMBED_MODEL_MISSING')
      // The suggestions name the two REAL remedies plus the disclosed-skip escape
      // hatch, rather than describing the internal fault.
      const suggestions = result.failure.suggestions.join(' ')
      expect(suggestions).toContain(EMBED_ALLOW_REMOTE_ENV)
      expect(suggestions).toContain('--semantic=false')
      // And it explains WHY it did not just skip — the gameable-by-omission argument.
      expect(suggestions).toContain('gamed by omission')
      // The repair is a command an agent can run verbatim.
      expect(result.failure.repair?.commands.length).toBeGreaterThan(0)
    } finally {
      process.env = restore
    }
  }, 30_000)

  it('the STUB is not a fallback — it needs the env var, not a missing model', async () => {
    // The hole this closes: if the stub substituted whenever the model was absent, the
    // fail-closed rule would be decorative and every air-gapped run would silently
    // get meaningless cosines while reporting a completed semantic tier.
    const restore = process.env
    try {
      process.env = { ...process.env, SYMSPEC_MODEL_DIR: '/nonexistent/symspec-cache' }
      delete (process.env as Record<string, string | undefined>)[EMBED_STUB_ENV]
      const service = await Effect.runPromise(
        Effect.map(EmbedderService, (s) => s).pipe(Effect.provide(embedderServiceLayer)),
      )
      expect(service.isStub, 'a missing model must NOT silently become the stub').toBe(false)
    } finally {
      process.env = restore
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Propose-only, demotion-only
// ---------------------------------------------------------------------------

/**
 * A hand-authored vector table — the ONLY way to test a threshold.
 *
 * The stub's cosines are meaningless by construction, so it cannot exercise a cut.
 * These are 2-D unit vectors at chosen angles, so the cosine between any pair is
 * exactly computable and a case can sit deliberately just above or just below the
 * threshold.
 */
const tableEmbedder = (table: Readonly<Record<string, readonly [number, number]>>): Embedder => {
  const unit = (v: readonly [number, number]): Float32Array => {
    const n = Math.hypot(v[0], v[1]) || 1
    return Float32Array.from([v[0] / n, v[1] / n])
  }
  return async (texts) => texts.map((t) => unit(table[t] ?? [1, 0]))
}

const req = (id: string, systemResponse: string, trigger?: string): SemanticRequirement => ({
  id,
  systemName: 'auth service',
  systemResponse,
  negated: false,
  ...(trigger !== undefined ? { trigger } : {}),
})

describe('PROPOSE-ONLY — the tier suggests ops, it never decides', () => {
  it('fires FND_SIMILAR_SEMANTIC at INFO severity above the threshold', async () => {
    // Two texts at a cosine comfortably above the 0.72 default.
    const embedder = tableEmbedder({
      'issue a session token': [1, 0],
      'issue a login credential': [1, 0.2],
    })
    const findings = await findSimilarSemantic(
      [req('r1', 'issue a session token'), req('r2', 'issue a login credential')],
      embedder,
    )
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding?.code).toBe('FND_SIMILAR_SEMANTIC')
    // INFO, not warn and certainly not error — the severity IS the doctrine.
    expect(finding?.severity).toBe('info')
    expect(finding?.cosine).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_THRESHOLD)
    // The durable output is a SUGGESTED op, named in the message.
    expect(finding?.message).toContain('symspec glossary add')
    // And it says so explicitly, so an agent cannot read it as a verdict.
    expect(finding?.message).toContain('suggestion, not a verdict')
  })

  it('does NOT fire below the threshold — the cut is real', async () => {
    // The negative control on the threshold itself. Without it, the test above could
    // pass because the tier fires on everything.
    const embedder = tableEmbedder({
      'issue a session token': [1, 0],
      'delete the audit log': [1, 1],
    })
    const findings = await findSimilarSemantic(
      [req('r1', 'issue a session token'), req('r2', 'delete the audit log')],
      embedder,
    )
    // cos(45deg) ~= 0.707, just under the 0.72 measured default.
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0.7071, 0.7071]))).toBeLessThan(
      DEFAULT_SEMANTIC_THRESHOLD,
    )
    expect(findings).toHaveLength(0)
  })

  it('offers BOTH antonym add AND glossary add for an opposition candidate, with the warning', async () => {
    // The most dangerous suggestion the tool makes, and why the message shape matters:
    // embeddings CANNOT tell opposites (open/shut) from synonyms (delete/remove) —
    // antonyms embed CLOSE. Committing the WRONG one manufactures a FALSE
    // contradiction, which for a soundness-claiming tool is the worst available bug.
    // So the finding must never emit a bare `antonym add`.
    const embedder = tableEmbedder({
      'open the bypass valve': [1, 0],
      'shut the bypass valve': [1, 0.1],
    })
    const findings = await findOppositionCandidates(
      [
        req('r1', 'open the bypass valve', 'pressure exceeds the limit'),
        req('r2', 'shut the bypass valve', 'pressure exceeds the limit'),
      ],
      embedder,
    )
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding?.code).toBe('FND_OPPOSITION_CANDIDATE')
    expect(finding?.severity).toBe('info')
    // BOTH options, and the explicit warning.
    expect(finding?.message).toContain('symspec antonym add')
    expect(finding?.message).toContain('symspec glossary add')
    expect(finding?.message).toContain('manufactures a false contradiction')
    expect(finding?.message).toContain('suggestion, not a verdict')
  })

  it('uses cosine only as a topical FLOOR for opposition, not as the signal', async () => {
    // Cosine cannot signal opposition (antonyms embed close), so the load-bearing
    // signal is STRUCTURAL: same object remainder, different leading verb. The floor
    // only drops pairs whose shared object is coincidental. Below the floor, and with
    // no morphological prefix relationship, nothing is proposed.
    const embedder = tableEmbedder({
      'open the bypass valve': [1, 0],
      'shut the bypass valve': [0, 1],
    })
    const findings = await findOppositionCandidates(
      [
        req('r1', 'open the bypass valve', 'pressure exceeds the limit'),
        req('r2', 'shut the bypass valve', 'pressure exceeds the limit'),
      ],
      embedder,
    )
    // Orthogonal → cosine 0, below the 0.5 floor.
    expect(DEFAULT_OPPOSITION_COSINE_FLOOR).toBeGreaterThan(0)
    expect(findings).toHaveLength(0)
  })

  it('does NOT propose a pair the SEED antonym table already unifies', async () => {
    // A correction to a plausible-looking assumption, worth keeping as a test because
    // it is the propose/decide boundary working exactly as designed.
    //
    // `seal`/`unseal` looks like the textbook negating-prefix candidate. It is NOT a
    // candidate: the seed antonym table already relates them, so `atomize` collapses
    // both responses onto ONE atom at opposite polarity —
    // `sys__auth_service__resp__conceal_the_chamber` for both, verified by probe. That
    // pair is therefore a PROVEN-OR-PROVABLE conflict the SMT tier handles directly,
    // and proposing an `antonym add` for it would ask an agent to re-commit a decision
    // the code already ships.
    //
    // So the tier proposing NOTHING here is the correct, and stronger, behavior: the
    // propose tier stays out of the decide tier's way.
    const embedder = tableEmbedder({
      'seal the chamber': [1, 0],
      'unseal the chamber': [1, 0.05],
    })
    const findings = await findOppositionCandidates(
      [req('r1', 'seal the chamber'), req('r2', 'unseal the chamber')],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('proposes a MORPHOLOGICAL pair the seed table does NOT know, below the cosine floor', async () => {
    // The negating-prefix path proper. Finding a fixture for it took three attempts,
    // and the reason is itself the point: the seed antonym table is broad enough that
    // the obvious prefix pairs (seal/unseal, energize/de-energize) ALREADY unify, so
    // they are handled by the decide tier and correctly skipped here.
    // `fragment`/`defragment` is not in the seed table (verified: the two atomize to
    // DIFFERENT atoms), so it is a genuine candidate.
    //
    // Opposition by MORPHOLOGY is deterministic structure, not a fuzzy score, so it is
    // proposed even when the topical cosine sits below the floor — the one place the
    // tier ignores its own cosine, and sound precisely because the signal is not fuzzy.
    const embedder = tableEmbedder({
      'fragment the index': [1, 0],
      'defragment the index': [0, 1],
    })
    const findings = await findOppositionCandidates(
      [req('r1', 'fragment the index'), req('r2', 'defragment the index')],
      embedder,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.code).toBe('FND_OPPOSITION_CANDIDATE')
    expect(findings[0]?.verbs.slice().sort()).toEqual(['defragment', 'fragment'])
    // Orthogonal vectors → cosine 0, well below the floor, and it fired anyway.
    expect(findings[0]?.cosine).toBeLessThan(DEFAULT_OPPOSITION_COSINE_FLOOR)
  })

  it('never crosses SYSTEMS — two systems with the same wording are distinct atoms', async () => {
    // Per-system atom scoping. Bridging across systems would be unsound: "the api
    // shall lock the door" and "the vault shall lock the door" are genuinely different
    // claims, and merging them would let a conflict be proven between two systems that
    // never interact.
    const embedder = tableEmbedder({
      'issue a session token': [1, 0],
      'issue a login credential': [1, 0.1],
    })
    const findings = await findSimilarSemantic(
      [
        { id: 'r1', systemName: 'auth service', systemResponse: 'issue a session token' },
        { id: 'r2', systemName: 'billing service', systemResponse: 'issue a login credential' },
      ],
      embedder,
    )
    expect(findings).toHaveLength(0)
  })

  it('skips pairs the GLOSSARY already unified — nothing left to bridge', async () => {
    // The propose/decide loop closing: once the committed table unifies two phrasings,
    // they atomize to ONE atom and the SMT tier proves any real conflict directly.
    // Re-proposing the merge would nag about a decision already made.
    const embedder = tableEmbedder({
      'issue a session token': [1, 0],
      'issue a login credential': [1, 0.1],
    })
    // The index is keyed by NORMALIZED alias, not by raw text — built by
    // `glossaryIndex` from the document's committed table. Handing it raw phrases
    // silently unifies nothing, which is worth pinning: it is the shape a caller
    // constructing the map by hand would get wrong, and the failure is a MISSED
    // unification rather than an error.
    const glossary = glossaryIndex([
      { canonical: 'issue a session token', aliases: ['issue a login credential'] },
    ])
    expect([...glossary.keys()], 'the index is keyed by normalized alias').toEqual([
      'issue_a_login_credential',
    ])
    const findings = await findSimilarSemantic(
      [req('r1', 'issue a session token'), req('r2', 'issue a login credential')],
      embedder,
      { glossary },
    )
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The stub
// ---------------------------------------------------------------------------

describe('the stub embedder', () => {
  it('is DETERMINISTIC — the same text always yields the same vector', async () => {
    // The property the differential oracle rests on: both sides compute identical
    // vectors for identical text, so any divergence is a real divergence.
    const a = await stubEmbedder()(['issue a session token', 'revoke the token'])
    const b = await stubEmbedder()(['issue a session token', 'revoke the token'])
    expect([...(a[0] ?? [])]).toEqual([...(b[0] ?? [])])
    expect([...(a[1] ?? [])]).toEqual([...(b[1] ?? [])])
    // Different texts produce different vectors, or it would be a constant function
    // and the determinism claim would be vacuous.
    expect([...(a[0] ?? [])]).not.toEqual([...(a[1] ?? [])])
  })

  it('emits L2-NORMALIZED vectors, so cosine IS a dot product', async () => {
    // The invariant `cosine` assumes. A non-unit vector would make every score wrong
    // in a way no test of the threshold would attribute correctly.
    const [v] = await stubEmbedder()(['the auth service shall issue a session token'])
    expect(v).toBeDefined()
    if (v === undefined) return
    let norm = 0
    for (const x of v) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
    expect(cosine(v, v)).toBeCloseTo(1, 5)
  })

  it('handles an EMPTY batch without touching the model', async () => {
    expect(await stubEmbedder()([])).toEqual([])
  })
})

describe('embedderLayerOf — the injection seam', () => {
  it('supplies a caller-provided embedder and reports it is not the stub', async () => {
    const table = tableEmbedder({ x: [1, 0] })
    const service = await Effect.runPromise(
      Effect.map(EmbedderService, (s) => s).pipe(Effect.provide(embedderLayerOf(table))),
    )
    expect(service.isStub).toBe(false)
    const loaded = await Effect.runPromise(service.load)
    expect(await loaded(['x'])).toHaveLength(1)
  })
})
