import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocLoadError, loadRequirementsDoc, parseRequirementsDoc } from '../load.js'
import { SCHEMA_VERSION } from '../schema.js'

const now = '2026-05-13T00:00:00.000Z'

const validRequirement = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'log every attempt',
  sentence: 'The auth service shall log every attempt.',
  createdAt: now,
  updatedAt: now,
}

const validDocJson = () =>
  JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    requirements: { [validRequirement.id]: validRequirement },
  })

describe('parseRequirementsDoc (AC-1-4, AC-1-9)', () => {
  it('parses a valid v2 document', () => {
    const doc = parseRequirementsDoc(validDocJson())
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.requirements[validRequirement.id]?.id).toBe(validRequirement.id)
  })

  it('rejects malformed (non-JSON) text with ERR_DOC_PARSE', () => {
    const text = '{ this is not valid json'
    expect(() => parseRequirementsDoc(text)).toThrow(DocLoadError)
    try {
      parseRequirementsDoc(text)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DocLoadError)
      const e = err as DocLoadError
      expect(e.code).toBe('ERR_DOC_PARSE')
      // Generic, forward-looking suggestions only — no legacy/migrate wording.
      expect(e.suggestions.some((s) => s.includes('symspec init'))).toBe(true)
      expect(e.suggestions.every((s) => !/legacy/i.test(s))).toBe(true)
      expect(e.suggestions.every((s) => !/migrate/i.test(s))).toBe(true)
    }
  })

  it('rejects schema-invalid JSON (e.g. missing requirements map) with ERR_DOC_PARSE', () => {
    const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION })
    try {
      parseRequirementsDoc(text)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DocLoadError)
      expect((err as DocLoadError).code).toBe('ERR_DOC_PARSE')
    }
  })

  it('rejects schema-invalid JSON (bad requirement shape) with ERR_DOC_PARSE', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      requirements: { 'not-a-uuid-key': validRequirement },
    })
    try {
      parseRequirementsDoc(text)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DocLoadError)
      expect((err as DocLoadError).code).toBe('ERR_DOC_PARSE')
    }
  })

  it('rejects a v2-shaped JSON doc with an unrecognized schemaVersion as ERR_SCHEMA_VERSION, not ERR_DOC_PARSE', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      requirements: { [validRequirement.id]: validRequirement },
    })
    try {
      parseRequirementsDoc(text)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DocLoadError)
      const e = err as DocLoadError
      expect(e.code).toBe('ERR_SCHEMA_VERSION')
      // Forward-looking only: re-create via init + re-add, never mention v1/migration.
      expect(e.suggestions.some((s) => s.includes('symspec init'))).toBe(true)
      expect(e.suggestions.some((s) => s.includes('symspec parse'))).toBe(true)
      expect(e.suggestions.every((s) => !/migrate/i.test(s))).toBe(true)
      expect(e.suggestions.every((s) => !/legacy/i.test(s))).toBe(true)
    }
  })

  it('asserts SCHEMA_VERSION === 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })
})

describe('loadRequirementsDoc (disk integration)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'symspec-load-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a valid document from disk', async () => {
    const target = join(dir, 'doc.json')
    await writeFile(target, validDocJson(), 'utf8')
    const doc = await loadRequirementsDoc(target)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('surfaces ERR_DOC_PARSE for a non-JSON file on disk', async () => {
    const target = join(dir, 'garbage.json')
    await writeFile(target, 'not json at all', 'utf8')
    await expect(loadRequirementsDoc(target)).rejects.toMatchObject({ code: 'ERR_DOC_PARSE' })
  })
})
