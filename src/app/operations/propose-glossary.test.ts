/**
 * `propose-glossary` at the OPERATION boundary.
 *
 * `formal/glossary-plan.test.ts` covers the algorithm. What is left is the wiring, and the
 * wiring carries three claims a unit test cannot make: the envelope shape an agent branches
 * on, the exit code (always 0, because a propose-only signal must never gate), and failing
 * CLOSED when the model is missing rather than returning an empty plan that reads as "your
 * vocabulary is already coherent".
 */

import { Effect, Layer, type Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { Embedder } from '../../domain/engine/formal/embed.ts'
import { DOC_VERSION, type RequirementsDocument } from '../../domain/requirements/document.ts'
import { decodeOp } from '../../domain/requirements/ops.ts'
import { DocPath, DocStore, makeDocPath } from '../../ports/doc-store.ts'
import { EmbedderService, embedderLayerOf } from '../../ports/embedder.ts'
import { ErrDocNotFound, ErrEmbedModelMissing, type OperationalError } from '../../ports/errors.ts'
import { EXIT_CLEAN } from '../../ports/exit.ts'
import { exitCodeForEnvelope } from '../runtime/exit.ts'
import { runOperation } from '../runtime/operation.ts'
import { type GlossaryProposalPayload, proposeGlossaryOp } from './propose-glossary.ts'

const TS = '2026-01-01T00:00:00.000Z'

const tableEmbedder = (table: Readonly<Record<string, readonly [number, number]>>): Embedder => {
  const unit = (v: readonly [number, number]): Float32Array => {
    const n = Math.hypot(v[0], v[1]) || 1
    return Float32Array.from([v[0] / n, v[1] / n])
  }
  return async (texts) => texts.map((t) => unit(table[t] ?? [1, 0]))
}

let seq = 0
const req = (systemResponse: string) => {
  seq += 1
  const id = `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'event-driven' as const,
      systemName: 'auth service',
      systemResponse,
      trigger: 'the user signs in',
      negated: false,
      sentence: `When the user signs in, the auth service shall ${systemResponse}.`,
      priority: 'medium' as const,
      status: 'draft' as const,
      createdAt: TS,
      updatedAt: TS,
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    },
  ] as const
}

const paraphraseDoc = (): RequirementsDocument =>
  ({
    docVersion: DOC_VERSION,
    requirements: Object.fromEntries([
      req('issue a session token'),
      req('issue a login credential'),
      req('mint an access token'),
    ]),
    glossary: [],
    antonyms: [],
    waivers: [],
    stateModel: { variables: [] },
  }) as unknown as RequirementsDocument

const TABLE = {
  'issue a session token': [1, 0.05],
  'issue a login credential': [1, 0.08],
  'mint an access token': [1, 0.11],
} as const

const run = (
  document: RequirementsDocument | undefined,
  embedder: Layer.Layer<EmbedderService> = embedderLayerOf(tableEmbedder(TABLE)),
  input: Record<string, unknown> = {},
): Promise<
  | { readonly _tag: 'Success'; readonly success: { readonly data: GlossaryProposalPayload } }
  | { readonly _tag: 'Failure'; readonly failure: OperationalError | Schema.SchemaError }
> => {
  const store = Layer.succeed(DocStore)(
    DocStore.of({
      load: () =>
        document === undefined
          ? Effect.fail(new ErrDocNotFound({ error: 'no document', suggestions: [] }))
          : Effect.succeed({ document, unknownKeys: {}, diagnostics: [] }),
      save: () => Effect.void,
      exists: () => Effect.succeed(document !== undefined),
    }),
  )
  return Effect.runPromise(
    Effect.result(runOperation(proposeGlossaryOp, { file: 'doc.json', ...input })).pipe(
      Effect.provide(Layer.mergeAll(store, Layer.succeed(DocPath)(makeDocPath({})), embedder)),
    ),
  ) as never
}

const expectOk = async (
  document: RequirementsDocument,
  input: Record<string, unknown> = {},
): Promise<GlossaryProposalPayload> => {
  const result = await run(document, undefined, input)
  expect(result._tag, JSON.stringify(result)).toBe('Success')
  if (result._tag !== 'Success') throw new Error('unreachable')
  return result.success.data
}

describe('the envelope an agent branches on', () => {
  it('carries ops that `apply` decodes BY CONSTRUCTION', async () => {
    const data = await expectOk(paraphraseDoc())
    expect(data.ops.length).toBeGreaterThan(0)
    // The "tool owns the load-bearing format" contract: every op it emits is a record the
    // decoder accepts, so an agent never hand-writes one.
    for (const op of data.ops) {
      expect(() => decodeOp(op), JSON.stringify(op)).not.toThrow()
    }
  })

  it('emits opsJsonl a redirect can consume, and EMPTY rather than blank when there is nothing', async () => {
    const data = await expectOk(paraphraseDoc())
    const lines = data.opsJsonl.trimEnd().split('\n')
    expect(lines).toHaveLength(data.ops.length)
    expect(lines.map((l) => JSON.parse(l))).toEqual(data.ops)

    // A document with nothing to merge must give an EMPTY string, not "\n" — otherwise
    // `--field data.opsJsonl > ops.jsonl` writes a file whose one blank line `apply` reads
    // as a malformed op.
    const single = {
      ...paraphraseDoc(),
      requirements: Object.fromEntries([req('delete the audit log')]),
    } as RequirementsDocument
    const empty = await expectOk(single)
    expect(empty.ops).toEqual([])
    expect(empty.opsJsonl).toBe('')
  })

  it('reports the path it read, and never writes', async () => {
    const document = paraphraseDoc()
    const before = JSON.stringify(document)
    const data = await expectOk(document)
    expect(data.path).toBe('doc.json')
    // The store's `save` would have thrown nothing, so assert the document itself is
    // untouched — a propose-only operation that mutated its input would be undetectable
    // through the envelope alone.
    expect(JSON.stringify(document)).toBe(before)
  })

  it('interpolates every count in `summary` rather than writing one out', async () => {
    const data = await expectOk(paraphraseDoc())
    expect(data.summary).toContain(`${data.classes.length} class(es)`)
    expect(data.summary).toContain(`${data.corpus.pairsCompared} same-system pair(s)`)
    // NEGATIVE GUARD: the source must not carry a literal count. A hardcoded number that
    // happens to be right today is exactly how three places kept claiming 75 codes.
    const source = String(
      // biome-ignore lint/suspicious/noExplicitAny: reading the module's own text
      (proposeGlossaryOp as any).handler,
    )
    expect(source).not.toMatch(/\d+ class\(es\)/)
  })

  it('reports the oppositions it found, with the counts interpolated too', async () => {
    // A document whose only interesting property is an opposition: same object, different
    // verb. Nothing merges, so without this clause the summary would read as "nothing
    // clusters" and say nothing about the half that manufactures rather than masks.
    const doc = {
      ...paraphraseDoc(),
      requirements: Object.fromEntries([req('seal the vault'), req('close the vault')]),
    } as RequirementsDocument
    const data = await expectOk(doc, {})
    expect(data.oppositions.length).toBeGreaterThan(0)
    expect(data.summary).toContain(`${data.oppositions.length} structurally-opposed pair(s)`)
    // The reason it is safe to read: none of them is applyable.
    expect(data.summary).toContain('none of them is in `ops`')
    expect(data.opsJsonl).toBe('')
  })

  it('says when the floor filtered an opposition out, rather than staying silent', async () => {
    // `oppositionSignals` counts BEFORE the floor. Without surfacing it, "no oppositions"
    // would be indistinguishable from "some were judged unrelated" — the same
    // found-nothing/did-not-look distinction `pairsCompared` draws for merges.
    const doc = {
      ...paraphraseDoc(),
      requirements: Object.fromEntries([req('seal the vault'), req('close the vault')]),
    } as RequirementsDocument
    // Orthogonal vectors put the pair far below the topical floor.
    const result = await run(
      doc,
      embedderLayerOf(tableEmbedder({ 'seal the vault': [1, 0], 'close the vault': [0, 1] })),
    )
    expect(result._tag, JSON.stringify(result)).toBe('Success')
    if (result._tag !== 'Success') throw new Error('unreachable')
    const data = result.success.data
    expect(data.oppositions).toEqual([])
    expect(data.corpus.oppositionSignals).toBeGreaterThan(0)
    expect(data.summary).toContain(`${data.corpus.oppositionSignals} pair(s) carried an opposition`)
    expect(data.summary).toContain(`${data.oppositionCosineFloor} topical floor`)
  })
})

describe('the exit contract', () => {
  it('is CLEAN even with unresolved choices, because propose-only never gates', async () => {
    // A withheld class is a request for a decision, not a defect in the document. `check
    // --strict` is the gate; this is the authoring aid that makes passing it cheap.
    const doc = {
      ...paraphraseDoc(),
      requirements: Object.fromEntries([req('seal the vault'), req('close the vault')]),
    } as RequirementsDocument
    const data = await expectOk(doc, {})
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'glossaryProposal', data })).toBe(EXIT_CLEAN)
  })

  it('is CLEAN on a clean plan too', async () => {
    const data = await expectOk(paraphraseDoc())
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'glossaryProposal', data })).toBe(EXIT_CLEAN)
  })
})

describe('it fails CLOSED without the embedding model', () => {
  it('surfaces ERR_EMBED_MODEL_MISSING rather than an empty plan', async () => {
    // The red-team result the always-on semantic tier exists for: a detector that can be
    // skipped silently is a gate that can be gamed by omission. An empty plan here would
    // read as "your vocabulary is already coherent", which is the lie.
    const failing = Layer.succeed(EmbedderService)(
      EmbedderService.of({
        load: Effect.fail(
          new ErrEmbedModelMissing({ error: 'no model', suggestions: ['symspec download-model'] }),
        ),
        isStub: false,
      }),
    )
    const result = await run(paraphraseDoc(), failing)
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect((result.failure as { _tag: string })._tag).toBe('ERR_EMBED_MODEL_MISSING')
  })

  it('reads the document BEFORE the model, so a missing file costs no load', async () => {
    // Ordering claim: a `load` that threw would mean the model was reached first.
    const neverLoads = Layer.succeed(EmbedderService)(
      EmbedderService.of({
        load: Effect.sync(() => {
          throw new Error('the model must not be loaded for a missing document')
        }),
        isStub: false,
      }),
    )
    const result = await run(undefined, neverLoads)
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect((result.failure as { _tag: string })._tag).toBe('ERR_DOC_NOT_FOUND')
  })

  it('DISCLOSES a stub embedder, so a reader knows the cosines are meaningless', async () => {
    const stub = Layer.succeed(EmbedderService)(
      EmbedderService.of({ load: Effect.succeed(tableEmbedder(TABLE)), isStub: true }),
    )
    const result = await run(paraphraseDoc(), stub)
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    expect(result.success.data.embedderIsStub).toBe(true)
  })
})

describe('the threshold flag', () => {
  it('overrides the measured default, and the default is REPORTED', async () => {
    const loose = await expectOk(paraphraseDoc(), { semanticThreshold: 0.1 })
    expect(loose.threshold).toBe(0.1)
    const standard = await expectOk(paraphraseDoc())
    // Not hardcoded here either: the payload must publish whatever the constant says.
    expect(standard.threshold).toBeGreaterThan(0)
    expect(standard.threshold).not.toBe(0.1)
  })
})
