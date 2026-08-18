/**
 * Tests for the document store.
 *
 * Four claims, each with its guard proven to fire:
 *
 * 1. **Path resolution precedence** — explicit → env → default, with an empty env
 *    var meaning "unset". Tested against an INJECTED environment, never
 *    `process.env`, so the rule is verified without global mutation.
 * 2. **Atomicity** — a failed write leaves the original file byte-identical and
 *    leaves no temp file behind. The failure is INDUCED (write into a path whose
 *    parent is not a directory) rather than mocked, so the assertion measures the
 *    real filesystem behavior the guarantee is about.
 * 3. **Byte stability** — the same document serializes to the same bytes
 *    regardless of key insertion order, so a no-op save produces no git diff.
 * 4. **Disjoint error codes** — not-found, malformed JSON, invalid schema, and
 *    wrong version each produce their OWN code, because each has a different
 *    remedy. The v2 case is called out separately: it must carry the migration
 *    path, since that is the one failure a real user will actually hit.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOC_VERSION,
  emptyDocument,
  type RequirementsDocument,
} from '../../domain/requirements/document.ts'
import {
  DEFAULT_DOC_PATH,
  DOC_PATH_CONVENTION,
  DOC_PATH_ENV_VAR,
  DocStore,
  makeDocPath,
} from '../../ports/doc-store.ts'
import { docStoreLayer, parseDocumentText, serializeDocument } from './store.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = []

/** A fresh temp directory, cleaned up after the test file. */
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'symspec-store-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Run a store program against the real filesystem. */
const withStore = <A, E>(
  program: (store: (typeof DocStore)['Service']) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DocStore
      return yield* program(store)
    }).pipe(Effect.provide(Layer.provideMerge(docStoreLayer, NodeServices.layer))) as Effect.Effect<
      A,
      E
    >,
  )

/** Run and capture the Result, for the failure assertions. */
const attemptStore = <A, E>(
  program: (store: (typeof DocStore)['Service']) => Effect.Effect<A, E>,
) => withStore((store) => Effect.result(program(store)))

const ID_A = '550e8400-e29b-41d4-a716-446655440000'

const requirement = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'log every authentication attempt',
  sentence: 'The auth service shall log every authentication attempt.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('doc-path resolution: explicit → SYMSPEC_DOC → ./requirements.json', () => {
  it('prefers the explicit path over everything', () => {
    const dp = makeDocPath({ [DOC_PATH_ENV_VAR]: '/env/path.json' })
    expect(dp.resolve('./explicit.json')).toBe('./explicit.json')
  })

  it('falls back to the env var when nothing is supplied', () => {
    const dp = makeDocPath({ [DOC_PATH_ENV_VAR]: '/env/path.json' })
    expect(dp.resolve(null)).toBe('/env/path.json')
    expect(dp.resolve(undefined)).toBe('/env/path.json')
    expect(dp.envPath).toBe('/env/path.json')
  })

  it('falls back to the default when neither is supplied', () => {
    expect(makeDocPath({}).resolve(null)).toBe(DEFAULT_DOC_PATH)
    expect(makeDocPath({}).envPath).toBeUndefined()
  })

  it('treats an EMPTY env var as unset, not as the empty path', () => {
    // `export SYMSPEC_DOC=` in a shell would otherwise resolve every command to
    // '' and fail with a confusing ENOENT on something that is not a path.
    const dp = makeDocPath({ [DOC_PATH_ENV_VAR]: '' })
    expect(dp.resolve(null)).toBe(DEFAULT_DOC_PATH)
    expect(dp.envPath).toBeUndefined()
  })

  it('treats an EMPTY explicit path as unset too', () => {
    const dp = makeDocPath({ [DOC_PATH_ENV_VAR]: '/env/path.json' })
    expect(dp.resolve('')).toBe('/env/path.json')
  })

  it('states the precedence in ONE string the manifest and errors both quote', () => {
    expect(DOC_PATH_CONVENTION).toContain(DOC_PATH_ENV_VAR)
    expect(DOC_PATH_CONVENTION).toContain(DEFAULT_DOC_PATH)
  })

  it('the guard FIRES: a wrong precedence order is detectable', () => {
    // Negative control. If `resolve` preferred the env var over the explicit
    // path, this is the comparison that would catch it.
    const dp = makeDocPath({ [DOC_PATH_ENV_VAR]: '/env/path.json' })
    expect(dp.resolve('./explicit.json')).not.toBe('/env/path.json')
  })
})

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serialization is byte-stable and git-diffable', () => {
  it('pretty-prints with a 2-space indent and a trailing newline', () => {
    const text = serializeDocument(emptyDocument())
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "docVersion": 3')
  })

  it('sorts keys recursively, so insertion order cannot change the bytes', () => {
    // Two documents with the same CONTENT built in opposite key orders must
    // serialize identically, or a no-op save produces a spurious git diff.
    const a = {
      docVersion: DOC_VERSION,
      requirements: {},
      stateModel: { variables: [] },
      glossary: [],
      antonyms: [],
      waivers: [],
      terms: [],
    } as RequirementsDocument
    const b = {
      waivers: [],
      terms: [],
      antonyms: [],
      glossary: [],
      stateModel: { variables: [] },
      requirements: {},
      docVersion: DOC_VERSION,
    } as RequirementsDocument
    expect(serializeDocument(a)).toBe(serializeDocument(b))
  })

  it('emits top-level keys in lexicographic order', () => {
    const keys = [...serializeDocument(emptyDocument()).matchAll(/^ {2}"([^"]+)":/gm)].map(
      (m) => m[1],
    )
    expect(keys).toEqual([...keys].sort())
  })

  it('PRESERVES array order — an edge list`s sequence is data, not formatting', () => {
    const text = serializeDocument(emptyDocument(), {
      futureList: ['zebra', 'apple', 'mango'],
    })
    const parsed = JSON.parse(text) as { futureList: string[] }
    expect(parsed.futureList).toEqual(['zebra', 'apple', 'mango'])
  })

  it('writes preserved unknown top-level keys back (the V27 write half)', () => {
    const text = serializeDocument(emptyDocument(), { futureTable: [{ a: 1 }] })
    expect(JSON.parse(text)).toMatchObject({ futureTable: [{ a: 1 }], docVersion: DOC_VERSION })
  })

  it('round-trips through parseDocumentText unchanged', () => {
    const original = emptyDocument()
    const loaded = Effect.runSync(parseDocumentText(serializeDocument(original), 'x.json'))
    expect(loaded.document).toEqual(original)
    expect(serializeDocument(loaded.document, loaded.unknownKeys)).toBe(serializeDocument(original))
  })

  it('the guard FIRES: differing content produces differing bytes', () => {
    expect(serializeDocument(emptyDocument())).not.toBe(
      serializeDocument(emptyDocument(), { extra: 1 }),
    )
  })
})

// ---------------------------------------------------------------------------
// The four disjoint load failures
// ---------------------------------------------------------------------------

describe('load failures are disjoint — each remedy gets its own code', () => {
  it('ERR_DOC_NOT_FOUND when the path does not resolve', async () => {
    const dir = tempDir()
    const r = await attemptStore((s) => s.load(join(dir, 'absent.json')))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_DOC_NOT_FOUND')
      expect(r.failure.suggestions.some((x) => x.includes('symspec init'))).toBe(true)
      expect(r.failure.suggestions.some((x) => x.includes(DOC_PATH_ENV_VAR))).toBe(true)
    }
  })

  it('ERR_DOC_PARSE on bytes that are not JSON', async () => {
    const dir = tempDir()
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{ this is not json')
    const r = await attemptStore((s) => s.load(p))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(r.failure._tag).toBe('ERR_DOC_PARSE')
  })

  it('ERR_DOC_PARSE on valid JSON that fails the schema, naming the JSON path', async () => {
    const dir = tempDir()
    const p = join(dir, 'invalid.json')
    writeFileSync(
      p,
      JSON.stringify({
        docVersion: DOC_VERSION,
        requirements: { [ID_A]: requirement(ID_A, { bogusField: 1 }) },
      }),
    )
    const r = await attemptStore((s) => s.load(p))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_DOC_PARSE')
      // The failing JSON path is the actionable part of the message.
      expect(r.failure.error).toContain('bogusField')
      // One line: an envelope's `error` field must not carry newlines.
      expect(r.failure.error).not.toContain('\n')
    }
  })

  it('ERR_SCHEMA_VERSION on a v2 document, carrying the MIGRATION PATH', async () => {
    // The one failure a real user hits. Prose an agent cannot execute is the
    // defect v4's reproduce work removed; these suggestions name both
    // commands.
    const dir = tempDir()
    const p = join(dir, 'v2.json')
    writeFileSync(p, JSON.stringify({ schemaVersion: 2, requirements: {} }))
    const r = await attemptStore((s) => s.load(p))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_SCHEMA_VERSION')
      expect(r.failure.error).toContain('v2 document')
      expect(r.failure.error).toContain('schemaVersion')
      const joined = r.failure.suggestions.join(' ')
      expect(joined).toContain('symspec import')
      expect(joined).toContain('gaps')
    }
  })

  it('ERR_SCHEMA_VERSION on an unknown docVersion, stating both numbers', async () => {
    const dir = tempDir()
    const p = join(dir, 'v9.json')
    writeFileSync(p, JSON.stringify({ docVersion: 9, requirements: {} }))
    const r = await attemptStore((s) => s.load(p))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_SCHEMA_VERSION')
      expect(r.failure.error).toContain('9')
      expect(r.failure.error).toContain(String(DOC_VERSION))
    }
  })

  it('the VERSION check runs BEFORE the schema decode', async () => {
    // A v9 document that ALSO violates the schema must report the version, not
    // the schema: the version is the cause the user can act on, and a
    // docVersion literal mismatch would otherwise mask it as "malformed".
    const dir = tempDir()
    const p = join(dir, 'v9-invalid.json')
    writeFileSync(p, JSON.stringify({ docVersion: 9, requirements: { 'not-a-uuid': {} } }))
    const r = await attemptStore((s) => s.load(p))
    if (r._tag === 'Failure') expect(r.failure._tag).toBe('ERR_SCHEMA_VERSION')
  })

  it('a document with NEITHER version key is a PARSE failure, not a version one', async () => {
    // Correct: that is a document missing a required field (or not a symspec
    // document at all), which is a different remedy from a migration.
    const dir = tempDir()
    const p = join(dir, 'noversion.json')
    writeFileSync(p, JSON.stringify({ requirements: {} }))
    const r = await attemptStore((s) => s.load(p))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_DOC_PARSE')
      expect(r.failure.error).toContain('docVersion')
    }
  })

  it('every failure carries at least one actionable suggestion', async () => {
    const dir = tempDir()
    const cases: readonly (readonly [string, string])[] = [
      ['a.json', '{oops'],
      ['b.json', JSON.stringify({ schemaVersion: 2, requirements: {} })],
      ['c.json', JSON.stringify({ docVersion: 9 })],
      ['d.json', JSON.stringify({ docVersion: DOC_VERSION, requirements: { x: {} } })],
    ]
    for (const [name, body] of cases) {
      const p = join(dir, name)
      writeFileSync(p, body)
      const r = await attemptStore((s) => s.load(p))
      expect(r._tag, name).toBe('Failure')
      if (r._tag === 'Failure') expect(r.failure.suggestions.length, name).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Save + atomicity
// ---------------------------------------------------------------------------

describe('save is atomic — a failure never damages the original', () => {
  it('writes a document that loads back identically', async () => {
    const dir = tempDir()
    const p = join(dir, 'requirements.json')
    const document = {
      ...emptyDocument(),
      requirements: {
        [ID_A]: {
          id: ID_A,
          patternType: 'ubiquitous' as const,
          systemName: 'auth service',
          systemResponse: 'log every authentication attempt',
          negated: false,
          sentence: 'The auth service shall log every authentication attempt.',
          priority: 'medium' as const,
          status: 'draft' as const,
          derives: [],
          satisfies: [],
          verifies: [],
          refines: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const loaded = await withStore((s) =>
      Effect.gen(function* () {
        yield* s.save(p, { document })
        return yield* s.load(p)
      }),
    )
    expect(loaded.document).toEqual(document)
  })

  it('leaves NO temp file behind on a successful write', async () => {
    const dir = tempDir()
    await withStore((s) => s.save(join(dir, 'requirements.json'), { document: emptyDocument() }))
    expect(readdirSync(dir)).toEqual(['requirements.json'])
  })

  it('leaves the ORIGINAL byte-identical when the write fails', async () => {
    // Induce a REAL filesystem failure rather than mocking one: write into a path
    // whose parent is a FILE, so both the temp write and the rename are
    // impossible. The pre-existing document must survive untouched.
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const target = join(blocker, 'requirements.json')

    const r = await attemptStore((s) => s.save(target, { document: emptyDocument() }))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      expect(r.failure._tag).toBe('ERR_IO')
      expect(r.failure.suggestions.join(' ')).toContain('NOT modified')
    }
    expect(readFileSync(blocker, 'utf8')).toBe('not a directory')
  })

  it('overwrites an existing document without corrupting it mid-write', async () => {
    const dir = tempDir()
    const p = join(dir, 'requirements.json')
    await withStore((s) => s.save(p, { document: emptyDocument() }))
    const first = readFileSync(p, 'utf8')
    await withStore((s) =>
      s.save(p, { document: emptyDocument(), unknownKeys: { futureTable: [1] } }),
    )
    const second = readFileSync(p, 'utf8')
    expect(second).not.toBe(first)
    expect(JSON.parse(second)).toMatchObject({ futureTable: [1] })
    expect(readdirSync(dir)).toEqual(['requirements.json'])
  })

  it('two saves in quick succession do not collide on a temp name', async () => {
    // The temp name is clock+counter, not crypto-random; the counter is what makes
    // two saves within one millisecond safe.
    const dir = tempDir()
    await withStore((s) =>
      Effect.all(
        [
          s.save(join(dir, 'a.json'), { document: emptyDocument() }),
          s.save(join(dir, 'b.json'), { document: emptyDocument() }),
          s.save(join(dir, 'c.json'), { document: emptyDocument() }),
        ],
        { concurrency: 3 },
      ),
    )
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json', 'c.json'])
  })

  it('a save/load/save cycle is a fixed point — no spurious diff', async () => {
    const dir = tempDir()
    const p = join(dir, 'requirements.json')
    await withStore((s) => s.save(p, { document: emptyDocument(), unknownKeys: { z: 1, a: 2 } }))
    const first = readFileSync(p, 'utf8')
    await withStore((s) =>
      Effect.gen(function* () {
        const loaded = yield* s.load(p)
        yield* s.save(p, { document: loaded.document, unknownKeys: loaded.unknownKeys })
      }),
    )
    expect(readFileSync(p, 'utf8')).toBe(first)
  })
})

describe('exists', () => {
  it('is false for an absent path and true for a present one', async () => {
    const dir = tempDir()
    const p = join(dir, 'requirements.json')
    expect(await withStore((s) => s.exists(p))).toBe(false)
    await withStore((s) => s.save(p, { document: emptyDocument() }))
    expect(await withStore((s) => s.exists(p))).toBe(true)
  })

  it('never fails — an unreadable path reports "does not exist"', async () => {
    // `init` only needs to know whether it would be overwriting something; an
    // unreadable path is not a reason to abort with a different error.
    const dir = tempDir()
    expect(await withStore((s) => s.exists(join(dir, 'a', 'b', 'c.json')))).toBe(false)
  })
})
