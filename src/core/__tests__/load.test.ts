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

  it('rejects a current-shaped JSON doc with an unrecognized schemaVersion as ERR_SCHEMA_VERSION, not ERR_DOC_PARSE', () => {
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
      // AC-1-5 revision (deliberate). This assertion used to be "re-create via
      // init + re-add", pinning a pair of PROSE suggestions — including one
      // naming `symspec parse` — as the whole contract. That is unactionable for
      // an agent, which is the defect AC-1-5 names: "the loader shall carry a
      // prior-schema document forward, OR shall report the exact ops that
      // reproduce it." The second disjunct is the only reachable one here (this
      // branch runs strictly AFTER RequirementsDocSchema accepted the document,
      // so its content is fully readable and never needs re-parsing from prose),
      // so the suggestions now carry a MACHINE-APPLICABLE `symspec apply` op
      // stream. `symspec parse` is deliberately gone from the payload: the EARS
      // slots are already structured in the document, so re-parsing sentences
      // would be a lossy detour. The forward-looking discipline is unchanged and
      // still asserted — no prior-schema vocabulary anywhere in the payload.
      expect(e.suggestions.some((s) => s.includes('symspec init'))).toBe(true)
      expect(e.suggestions.some((s) => s.includes('symspec apply'))).toBe(true)
      expect(e.suggestions.every((s) => !/migrate/i.test(s))).toBe(true)
      expect(e.suggestions.every((s) => !/legacy/i.test(s))).toBe(true)
    }
  })

  it('reports the exact executable ops that reproduce the document (AC-1-5)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      requirements: { [validRequirement.id]: validRequirement },
    })
    try {
      parseRequirementsDoc(text)
      expect.unreachable()
    } catch (err) {
      const e = err as DocLoadError
      // Structured plan for library callers.
      expect(e.reproduce).toBeDefined()
      expect(e.reproduce?.ops).toEqual([
        {
          op: 'add',
          id: validRequirement.id,
          patternType: 'ubiquitous',
          systemName: 'auth service',
          systemResponse: 'log every attempt',
          negated: false,
          priority: 'medium',
          status: 'draft',
        },
      ])
      // The same ops rendered onto `suggestions` — the only field
      // `cli/errors.ts`'s toErrorEnvelope forwards onto the CLI envelope, so an
      // agent driving `dist/cli.mjs` sees them too.
      const opLines = e.suggestions.filter((s) => s.startsWith('{'))
      expect(opLines).toEqual((e.reproduce?.ops ?? []).map((o) => JSON.stringify(o)))
      // Every emitted op verb is one `apply` actually accepts.
      for (const line of opLines) {
        const op = JSON.parse(line) as { op: string }
        expect(['add', 'derive', 'satisfy', 'verify', 'refine']).toContain(op.op)
      }
      // The message itself states the count, so a human reading `--pretty`
      // knows ops are present without scanning the list.
      expect(e.message).toContain('1 `symspec apply` op record')
    }
  })

  it('omits `reproduce` on the ERR_DOC_PARSE path — nothing readable to derive ops from', () => {
    try {
      parseRequirementsDoc('{ this is not valid json')
      expect.unreachable()
    } catch (err) {
      const e = err as DocLoadError
      expect(e.code).toBe('ERR_DOC_PARSE')
      expect(Object.hasOwn(e, 'reproduce')).toBe(false)
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
