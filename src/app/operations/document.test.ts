/**
 * Tests for `init`, `list`, `show`, and the ref-resolution chokepoint.
 *
 * ## These run the REAL HANDLERS against an in-memory store
 *
 * The operations declare `DocStore` / `DocPath` as requirements, so a test can
 * provide an in-memory implementation and exercise the handler itself — not a
 * re-implementation of it, and not a subprocess. That is the payoff for putting the
 * store behind a Layer instead of importing `node:fs` in a handler: the behavior
 * under test is the shipped behavior, with the filesystem swapped out.
 *
 * `cli.test.ts` still drives the same commands through the real bundle and the real
 * filesystem, so nothing here is a substitute for the end-to-end path.
 *
 * ## The chokepoint claim is asserted, not assumed
 *
 * The donor lesson is that key⇄UUID addressing works everywhere BECAUSE there is
 * one resolver. So the tests assert both halves: that `show` accepts a key and a
 * UUID identically, and that the resolver itself handles every case (miss on an
 * empty document, miss with near-misses, exact-case preference).
 */

import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DOC_VERSION,
  emptyDocument,
  type LoadedDocument,
  type Requirement,
  type RequirementsDocument,
} from '../../domain/requirements/document.ts'
import {
  knownRefs,
  nearestRefs,
  requireRequirement,
  resolveId,
  resolveRef,
} from '../../domain/requirements/resolve.ts'
import { DocPath, DocStore, makeDocPath, type SaveInput } from '../../ports/doc-store.ts'
import { ErrDocNotFound, type OperationalError } from '../../ports/errors.ts'
import { type Operation, runOperation } from '../runtime/operation.ts'
import { initOp, listOp, showOp } from './document.ts'

// ---------------------------------------------------------------------------
// An in-memory store
// ---------------------------------------------------------------------------

/** A mutable in-memory filesystem, so a test can assert what a handler WROTE. */
interface MemoryFs {
  readonly files: Map<string, RequirementsDocument>
  readonly saves: SaveInput[]
}

const memoryStore = (fs: MemoryFs) =>
  Layer.succeed(DocStore)(
    DocStore.of({
      load: (path) => {
        const doc = fs.files.get(path)
        if (doc === undefined) {
          return Effect.fail(
            new ErrDocNotFound({
              error: `Could not read a requirements document at ${path}.`,
              suggestions: [`Run \`symspec init ${path}\`.`],
            }),
          )
        }
        return Effect.succeed({
          document: doc,
          unknownKeys: {},
          diagnostics: [],
        } satisfies LoadedDocument)
      },
      save: (path, input) =>
        Effect.sync(() => {
          fs.files.set(path, input.document)
          fs.saves.push(input)
        }),
      exists: (path) => Effect.succeed(fs.files.has(path)),
    }),
  )

const memoryPath = (env: Readonly<Record<string, string | undefined>> = {}) =>
  Layer.succeed(DocPath)(makeDocPath(env))

/**
 * Run an operation against an in-memory store, returning its Result.
 *
 * This is the whole payoff for the Layer indirection: the operation under test is
 * the SHIPPED handler, with only the filesystem substituted. `Effect.result` keeps
 * both branches, so a failure assertion inspects the real ERR_* instance rather
 * than a message string.
 */
const runOp = <A, E>(
  effect: Effect.Effect<A, E, DocStore | DocPath>,
  fs: MemoryFs,
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  Effect.runSync(
    Effect.provide(Effect.result(effect), Layer.mergeAll(memoryStore(fs), memoryPath(env))),
  )

/**
 * Build the effect for one operation, so `runOp` receives an ALREADY-CONCRETE
 * Effect.
 *
 * Two small helpers rather than one, deliberately. Threading the generic `Fields`
 * through a single helper leaves `Schema.Struct.DecodingServices<Fields>`
 * irreducible — the compiler correctly refusing to assume an arbitrary schema
 * needs no services — and the only ways out are a cast or a constraint that lies.
 * Resolving the generic at the CALL SITE (where the schema is concrete and its
 * decoding requirement really is `never`) needs neither.
 */
const op = <Fields extends Schema.Struct.Fields, T extends string, D>(
  operation: Operation<Fields, T, D, DocStore | DocPath>,
  raw: unknown,
) => runOperation(operation, raw)

/** A fresh in-memory filesystem. */
const freshFs = (): MemoryFs => ({ files: new Map(), saves: [] })

/**
 * Narrow a run failure to a catalog error.
 *
 * `runOperation`'s error channel is `OperationalError | SchemaError`, and BOTH have
 * a `_tag` — so a bare `'_tag' in failure` check narrows nothing and reading
 * `.suggestions` off it is a type error. Testing for `suggestions` is the honest
 * discriminator: it is the field only the catalog classes carry, and it is the one
 * these assertions actually want.
 */
const asCatalogError = (
  failure: OperationalError | Schema.SchemaError,
): OperationalError | undefined => (Schema.isSchemaError(failure) ? undefined : failure)

// ---------------------------------------------------------------------------
// Requirement fixtures
// ---------------------------------------------------------------------------

const ID_A = '550e8400-e29b-41d4-a716-446655440000'
const ID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ID_C = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

const requirement = (id: string, extra: Partial<Requirement> = {}): Requirement => ({
  id,
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'log every attempt',
  negated: false,
  sentence: 'The auth service shall log every attempt.',
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const docWith = (...requirements: readonly Requirement[]): RequirementsDocument => ({
  ...emptyDocument(),
  requirements: Object.fromEntries(requirements.map((r) => [r.id, r])),
})

// ---------------------------------------------------------------------------
// The resolver — the single chokepoint
// ---------------------------------------------------------------------------

describe('ref resolution: UUID first, then stable key', () => {
  const doc = docWith(
    requirement(ID_A, { key: 'TX-B6' }),
    requirement(ID_B, { key: 'TX-L2' }),
    requirement(ID_C),
  )

  it('resolves a UUID', () => {
    expect(resolveRef(doc, ID_A)?.id).toBe(ID_A)
    expect(resolveId(doc, ID_A)).toBe(ID_A)
  })

  it('resolves a stable key to the same requirement', () => {
    expect(resolveRef(doc, 'TX-B6')?.id).toBe(ID_A)
    expect(resolveId(doc, 'TX-B6')).toBe(ID_A)
  })

  it('returns the UUID from a key — what a write path must persist', () => {
    // Storing the raw ref would fail the document schema's UUID check, and even if
    // it did not, would break the moment anything renamed.
    expect(resolveId(doc, 'TX-L2')).toBe(ID_B)
  })

  it('returns undefined for a miss', () => {
    expect(resolveRef(doc, 'TX-B7')).toBeUndefined()
    expect(resolveId(doc, 'nope')).toBeUndefined()
  })

  it('is case-SENSITIVE — a key is an exact handle, not a search', () => {
    expect(resolveRef(doc, 'tx-b6')).toBeUndefined()
  })

  it('handles a keyless requirement (resolvable by UUID only)', () => {
    expect(resolveRef(doc, ID_C)?.id).toBe(ID_C)
    expect(resolveRef(doc, ID_C)?.key).toBeUndefined()
  })

  it('lists known refs deterministically: keys sorted, then UUIDs sorted', () => {
    const refs = knownRefs(doc)
    expect(refs.slice(0, 2)).toEqual(['TX-B6', 'TX-L2'])
    expect(refs.slice(2)).toEqual([ID_A, ID_B, ID_C].sort())
    // Determinism matters because these strings land in an envelope an agent may
    // diff between runs.
    expect(knownRefs(doc)).toEqual(refs)
  })

  it('suggests near misses, preferring a case-only difference', () => {
    expect(nearestRefs(doc, 'tx-b6')[0]).toBe('TX-B6')
    expect(nearestRefs(doc, 'TX-')).toContain('TX-B6')
    expect(nearestRefs(doc, 'zzz')).toEqual([])
  })
})

describe('requireRequirement — the guard every ref-taking op funnels through', () => {
  const doc = docWith(requirement(ID_A, { key: 'TX-B6' }), requirement(ID_B, { key: 'TX-L2' }))

  it('returns the requirement on a hit', () => {
    const found = requireRequirement(doc, 'TX-B6')
    expect('_tag' in found).toBe(false)
  })

  it('fails with ERR_NOT_FOUND and did-you-mean on a near miss', () => {
    const found = requireRequirement(doc, 'TX-B7')
    expect('_tag' in found && found._tag).toBe('ERR_NOT_FOUND')
    if ('_tag' in found) {
      expect(found.suggestions.join(' ')).toContain('Did you mean')
      expect(found.suggestions.join(' ')).toContain('TX-B6')
      // A runnable repair, so a near miss is self-correcting rather than a dead end.
      expect(found.repair?.commands).toEqual(['symspec show TX-B6'])
    }
  })

  it('says the document is EMPTY rather than offering did-you-mean over nothing', () => {
    const found = requireRequirement(emptyDocument(), 'anything')
    if ('_tag' in found) {
      expect(found.error).toContain('no requirements at all')
      expect(found.suggestions.join(' ')).not.toContain('Did you mean')
    }
  })

  it('names both spellings it tried, so the failure is diagnosable', () => {
    const found = requireRequirement(doc, 'zzz')
    if ('_tag' in found) {
      expect(found.error).toContain('UUID')
      expect(found.error).toContain('stable key')
    }
  })

  it('the guard FIRES: a present ref never produces the error', () => {
    for (const ref of knownRefs(doc)) {
      expect('_tag' in requireRequirement(doc, ref), ref).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('init', () => {
  it('writes an empty v3 document at the resolved path', () => {
    const fs = freshFs()
    const r = runOp(op(initOp, { file: './requirements.json' }), fs)
    expect(r._tag).toBe('Success')
    expect(fs.files.get('./requirements.json')).toEqual(emptyDocument())
  })

  it('reports the path, the version, and a zero requirement count', () => {
    const fs = freshFs()
    const r = runOp(op(initOp, { file: './r.json' }), fs)
    if (r._tag === 'Success') {
      expect(r.success.data).toEqual({
        path: './r.json',
        docVersion: DOC_VERSION,
        created: true,
        overwritten: false,
        requirements: 0,
      })
    }
  })

  it('REFUSES to overwrite an existing document', () => {
    // A requirements document is hand-authored work; clobbering one would be
    // unrecoverable. Refusing is what lets an agent call init speculatively.
    const fs = freshFs()
    const existing = docWith(requirement(ID_A))
    fs.files.set('./r.json', existing)
    const r = runOp(op(initOp, { file: './r.json' }), fs)
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const failure = asCatalogError(r.failure)
      expect(failure).toBeDefined()
      if (failure === undefined) return
      expect(failure._tag).toBe('ERR_DOC_EXISTS')
    }
    // And the existing document is untouched.
    expect(fs.files.get('./r.json')).toBe(existing)
    expect(fs.saves).toEqual([])
  })

  it('overwrites with --force, and says it did', () => {
    const fs = freshFs()
    fs.files.set('./r.json', docWith(requirement(ID_A)))
    const r = runOp(op(initOp, { file: './r.json', force: true }), fs)
    expect(r._tag).toBe('Success')
    if (r._tag === 'Success') {
      expect((r.success.data as { overwritten: boolean }).overwritten).toBe(true)
    }
    expect(fs.files.get('./r.json')).toEqual(emptyDocument())
  })

  it('resolves the path through DocPath: env var when no argument', () => {
    const fs = freshFs()
    runOp(op(initOp, {}), fs, { SYMSPEC_DOC: '/from/env.json' })
    expect([...fs.files.keys()]).toEqual(['/from/env.json'])
  })

  it('resolves to ./requirements.json when neither is supplied', () => {
    const fs = freshFs()
    runOp(op(initOp, {}), fs)
    expect([...fs.files.keys()]).toEqual(['./requirements.json'])
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  const doc = docWith(
    requirement(ID_B, { key: 'TX-L2', priority: 'high', status: 'approved' }),
    requirement(ID_A, { key: 'TX-B6', priority: 'critical' }),
    requirement(ID_C, { derives: [ID_A, ID_B] }),
  )

  const listed = (
    fs: MemoryFs = (() => {
      const f = freshFs()
      f.files.set('./r.json', doc)
      return f
    })(),
  ) => {
    const r = runOp(op(listOp, { file: './r.json' }), fs)
    if (r._tag !== 'Success') throw new Error('list failed')
    return r.success.data as {
      count: number
      requirements: readonly { id: string; key?: string; sentence: string }[]
      counts: Record<string, number>
      diagnostics: readonly unknown[]
    }
  }

  it('lists every requirement', () => {
    expect(listed().count).toBe(3)
    expect(listed().requirements).toHaveLength(3)
  })

  it('sorts KEYED requirements first in key order, then keyless by UUID', () => {
    // Deterministic order is what makes list output diffable between runs.
    expect(listed().requirements.map((r) => r.key ?? r.id)).toEqual(['TX-B6', 'TX-L2', ID_C])
  })

  it('OMITS an absent key rather than emitting null', () => {
    const keyless = listed().requirements.find((r) => r.id === ID_C)
    expect(keyless).toBeDefined()
    expect(Object.hasOwn(keyless as object, 'key')).toBe(false)
  })

  it('includes the sentence, so a row is humanly identifiable', () => {
    for (const row of listed().requirements) expect(row.sentence.length).toBeGreaterThan(0)
  })

  it('does NOT return the whole requirement — list is for orienting', () => {
    // Returning every field would make `list` as expensive as reading the file,
    // which the agent could have done itself.
    for (const row of listed().requirements) {
      expect(Object.keys(row).sort()).toEqual(
        ['id', 'key', 'patternType', 'priority', 'sentence', 'status'].filter(
          (k) => k !== 'key' || row.key !== undefined,
        ),
      )
    }
  })

  it('reports the aggregate counts, including total edges', () => {
    expect(listed().counts).toEqual({
      edges: 2,
      glossary: 0,
      antonyms: 0,
      waivers: 0,
      stateVariables: 0,
    })
  })

  it('surfaces the load diagnostics — a disclosure an agent never sees is not one', () => {
    expect(listed().diagnostics).toEqual([])
  })

  it('fails with ERR_DOC_NOT_FOUND on a missing document', () => {
    const r = runOp(op(listOp, { file: './absent.json' }), freshFs())
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const failure = asCatalogError(r.failure)
      expect(failure).toBeDefined()
      if (failure === undefined) return
      expect(failure._tag).toBe('ERR_DOC_NOT_FOUND')
    }
  })

  it('lists an empty document as count 0, not as an error', () => {
    const fs = freshFs()
    fs.files.set('./r.json', emptyDocument())
    const r = runOp(op(listOp, { file: './r.json' }), fs)
    expect(r._tag).toBe('Success')
    if (r._tag === 'Success') expect((r.success.data as { count: number }).count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe('show', () => {
  const doc = docWith(requirement(ID_A, { key: 'TX-B6' }), requirement(ID_B))
  const fsWithDoc = (): MemoryFs => {
    const fs = freshFs()
    fs.files.set('./r.json', doc)
    return fs
  }

  const shown = (ref: string) => {
    const r = runOp(op(showOp, { ref, file: './r.json' }), fsWithDoc())
    return r
  }

  it('shows a requirement by its stable key', () => {
    const r = shown('TX-B6')
    expect(r._tag).toBe('Success')
    if (r._tag === 'Success') {
      const data = r.success.data as { requirement: Requirement; resolvedFrom: string }
      expect(data.requirement.id).toBe(ID_A)
      expect(data.resolvedFrom).toBe('TX-B6')
    }
  })

  it('shows the SAME requirement by its UUID — one chokepoint, both spellings', () => {
    const byKey = shown('TX-B6')
    const byId = shown(ID_A)
    if (byKey._tag === 'Success' && byId._tag === 'Success') {
      const a = (byKey.success.data as { requirement: Requirement }).requirement
      const b = (byId.success.data as { requirement: Requirement }).requirement
      expect(a).toEqual(b)
    }
  })

  it('reports resolvedFrom alongside the id, so an agent can write the UUID', () => {
    // An agent that resolved by key and now wants to write an edge needs the UUID;
    // making the mapping explicit stops it persisting the key by mistake.
    const r = shown('TX-B6')
    if (r._tag === 'Success') {
      const data = r.success.data as { requirement: Requirement; resolvedFrom: string }
      expect(data.resolvedFrom).toBe('TX-B6')
      expect(data.requirement.id).toBe(ID_A)
    }
  })

  it('returns the WHOLE requirement, unlike list', () => {
    const r = shown(ID_B)
    if (r._tag === 'Success') {
      expect((r.success.data as { requirement: Requirement }).requirement).toEqual(
        doc.requirements[ID_B],
      )
    }
  })

  it('fails with ERR_NOT_FOUND and did-you-mean on a miss', () => {
    const r = shown('TX-B7')
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const failure = asCatalogError(r.failure)
      expect(failure).toBeDefined()
      if (failure === undefined) return
      expect(failure._tag).toBe('ERR_NOT_FOUND')
      expect(failure.suggestions.join(' ')).toContain('TX-B6')
    }
  })

  it('fails with ERR_DOC_NOT_FOUND when the DOCUMENT is missing', () => {
    // Disjoint from a ref miss: a different remedy, so a different code.
    const r = runOp(op(showOp, { ref: 'TX-B6', file: './absent.json' }), freshFs())
    if (r._tag === 'Failure') {
      const failure = asCatalogError(r.failure)
      expect(failure).toBeDefined()
      if (failure === undefined) return
      expect(failure._tag).toBe('ERR_DOC_NOT_FOUND')
    }
  })
})
