import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `node:fs/promises` ESM exports are non-configurable, so `vi.spyOn` can't
// override them directly (vitest.dev/guide/browser/#limitations). Instead we
// mock the module up front and let each AC-1-11 test flip a shared failure
// toggle to simulate a write/rename failure on demand, falling through to the
// real implementation otherwise.
const fsFailure: { writeFile?: Error; rename?: Error } = {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsFailure.writeFile) {
        const err = fsFailure.writeFile
        fsFailure.writeFile = undefined
        throw err
      }
      return actual.writeFile(...args)
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (fsFailure.rename) {
        const err = fsFailure.rename
        fsFailure.rename = undefined
        throw err
      }
      return actual.rename(...args)
    }),
  }
})

import {
  atomicWriteFile,
  deserializeDoc,
  IoError,
  readDocFile,
  serializeDoc,
  writeDocFile,
} from '../storage.js'

describe('serializeDoc', () => {
  it('produces pretty-printed, sorted-key, byte-stable JSON', () => {
    const doc = {
      schemaVersion: 2,
      requirements: {
        'b-id': { id: 'b-id', zeta: 1, alpha: 2 },
        'a-id': { id: 'a-id', beta: 3 },
      },
    }
    const out = serializeDoc(doc)
    expect(out).toBe(
      [
        '{',
        '  "requirements": {',
        '    "a-id": {',
        '      "beta": 3,',
        '      "id": "a-id"',
        '    },',
        '    "b-id": {',
        '      "alpha": 2,',
        '      "id": "b-id",',
        '      "zeta": 1',
        '    }',
        '  },',
        '  "schemaVersion": 2',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('is byte-stable regardless of the input key insertion order', () => {
    const docA = { z: 1, a: { d: 4, c: 3 } }
    const docB = { a: { c: 3, d: 4 }, z: 1 }
    expect(serializeDoc(docA)).toBe(serializeDoc(docB))
  })

  it('sorts keys lexicographically at every nesting depth', () => {
    const doc = { charlie: 1, alpha: { delta: 1, bravo: 2 }, bravo: 3 }
    const out = serializeDoc(doc)
    const alphaIdx = out.indexOf('"alpha"')
    const bravoIdx = out.indexOf('"bravo"')
    const charlieIdx = out.indexOf('"charlie"')
    expect(alphaIdx).toBeLessThan(bravoIdx)
    expect(bravoIdx).toBeLessThan(charlieIdx)
    // nested keys sorted too
    const nestedBravoIdx = out.indexOf('"bravo"', alphaIdx)
    const nestedDeltaIdx = out.indexOf('"delta"')
    expect(nestedBravoIdx).toBeLessThan(nestedDeltaIdx)
  })

  it('preserves array element order (only object keys are sorted)', () => {
    const doc = { list: ['z', 'a', 'm'] }
    const out = serializeDoc(doc)
    expect(deserializeDoc<{ list: string[] }>(out).list).toEqual(['z', 'a', 'm'])
  })

  it('ends with a trailing newline', () => {
    expect(serializeDoc({ a: 1 }).endsWith('\n')).toBe(true)
  })
})

describe('serializeDoc/deserializeDoc round-trip', () => {
  it('load == save: deserializing a serialized doc reproduces the original value', () => {
    const doc = {
      schemaVersion: 2,
      requirements: {
        r1: { id: 'r1', derives: ['r2', 'r3'], nested: { x: 1, y: 2 } },
        r2: { id: 'r2', derives: [] },
      },
    }
    const roundTripped = deserializeDoc(serializeDoc(doc))
    expect(roundTripped).toEqual(doc)
  })

  it('re-serializing a round-tripped doc is byte-identical to the first serialization', () => {
    const doc = { b: 2, a: 1, nested: { y: 2, x: 1 } }
    const first = serializeDoc(doc)
    const second = serializeDoc(deserializeDoc(first))
    expect(second).toBe(first)
  })
})

describe('atomicWriteFile / writeDocFile / readDocFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'symspec-storage-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes contents that can be read back verbatim', async () => {
    const target = join(dir, 'doc.json')
    await atomicWriteFile(target, 'hello world\n')
    expect(await readFile(target, 'utf8')).toBe('hello world\n')
  })

  it('does not leave a stray temp file behind after a successful write', async () => {
    const target = join(dir, 'doc.json')
    await atomicWriteFile(target, 'contents\n')
    const entries = await readdir(dir)
    expect(entries).toEqual(['doc.json'])
  })

  it('writeDocFile + readDocFile round-trip a document through disk', async () => {
    const target = join(dir, 'doc.json')
    const doc = {
      schemaVersion: 2,
      requirements: { [randomBytes(4).toString('hex')]: { id: 'x', status: 'draft' } },
    }
    await writeDocFile(target, doc)
    const loaded = await readDocFile<typeof doc>(target)
    expect(loaded).toEqual(doc)
  })

  it('writeDocFile persists byte-stable sorted-key pretty JSON on disk', async () => {
    const target = join(dir, 'doc.json')
    await writeDocFile(target, { z: 1, a: 2 })
    const raw = await readFile(target, 'utf8')
    expect(raw).toBe('{\n  "a": 2,\n  "z": 1\n}\n')
  })

  it('overwrites an existing file atomically (rename over target)', async () => {
    const target = join(dir, 'doc.json')
    await atomicWriteFile(target, 'first\n')
    await atomicWriteFile(target, 'second\n')
    expect(await readFile(target, 'utf8')).toBe('second\n')
  })

  describe('AC-1-11: simulated write failure leaves original intact + ERR_IO', () => {
    afterEach(() => {
      fsFailure.writeFile = undefined
      fsFailure.rename = undefined
    })

    it('throws IoError (ERR_IO) when the temp-file write fails, leaving the original untouched', async () => {
      const target = join(dir, 'doc.json')
      await writeFile(target, 'original contents\n', 'utf8')

      fsFailure.writeFile = new Error('EACCES: permission denied')

      await expect(atomicWriteFile(target, 'new contents\n')).rejects.toThrow(IoError)

      // Original file is completely untouched.
      expect(await readFile(target, 'utf8')).toBe('original contents\n')
      // No orphaned temp file left behind.
      expect(await readdir(dir)).toEqual(['doc.json'])
    })

    it('throws IoError (ERR_IO) when the rename step fails, leaving the original untouched', async () => {
      const target = join(dir, 'doc.json')
      await writeFile(target, 'original contents\n', 'utf8')

      fsFailure.rename = new Error('ENOSPC: no space left on device')

      await expect(atomicWriteFile(target, 'new contents\n')).rejects.toThrow(IoError)

      // Original file is completely untouched.
      expect(await readFile(target, 'utf8')).toBe('original contents\n')
      // No orphaned temp file left behind (best-effort cleanup on rename failure).
      expect(await readdir(dir)).toEqual(['doc.json'])
    })

    it('sets code === "ERR_IO" on the thrown error', async () => {
      const target = join(dir, 'doc.json')
      fsFailure.writeFile = new Error('EACCES')

      try {
        await atomicWriteFile(target, 'contents\n')
        expect.unreachable('atomicWriteFile should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(IoError)
        expect((err as IoError).code).toBe('ERR_IO')
        expect((err as IoError).suggestions.length).toBeGreaterThan(0)
      }
    })

    it('writeDocFile propagates the same ERR_IO failure without leaving a partial document', async () => {
      const target = join(dir, 'doc.json')
      await writeFile(target, '{"schemaVersion":2,"requirements":{}}\n', 'utf8')

      fsFailure.writeFile = new Error('EACCES: permission denied')

      await expect(
        writeDocFile(target, { schemaVersion: 2, requirements: { x: 1 } }),
      ).rejects.toThrow(IoError)

      expect(await readFile(target, 'utf8')).toBe('{"schemaVersion":2,"requirements":{}}\n')
    })

    it('a real permission failure (chmod 0444 on the containing dir) surfaces as ERR_IO', async () => {
      // Skip when running as root, where permission bits are bypassed.
      if (process.getuid && process.getuid() === 0) return

      const target = join(dir, 'doc.json')
      await writeFile(target, 'original contents\n', 'utf8')
      await chmod(dir, 0o555) // read+execute only, no write, on the directory

      try {
        await expect(atomicWriteFile(target, 'new contents\n')).rejects.toThrow(IoError)
        expect(await readFile(target, 'utf8')).toBe('original contents\n')
      } finally {
        await chmod(dir, 0o755)
      }
    })
  })
})
