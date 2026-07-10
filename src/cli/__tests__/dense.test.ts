import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RequirementSchema } from '../../core/schema.js'
import {
  denseEnvelope,
  densifyEnvelope,
  densifyValue,
  minifyJson,
  stripAgnostic,
} from '../dense.js'
import {
  API_VERSION,
  type Envelope,
  ErrorEnvelopeSchema,
  failure,
  SuccessEnvelopeSchema,
  success,
} from '../envelope.js'

/**
 * AC-6-4: `--dense` emits token-economical output by (1) minifying JSON,
 * (2) omitting keys whose value equals the schema default or is null, and
 * (3) eliding heavy `evidence`/atom-table fields unless `--evidence` is also
 * passed — while keeping field names and the typed schema identical. Dense
 * output MUST validate against the same Zod schema as non-dense and round-trip.
 */

// A canonical requirement, exactly as `RequirementSchema.parse` would produce:
// defaults present (priority/status/edges), optionals absent (no trigger/pre).
const CANONICAL_REQ = RequirementSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: 'the auth service shall issue a session token',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
})

// A formal finding carrying the heavy AC-4-6 `evidence` field (atom table +
// unsat core). Shape mirrors `formal/finding.ts`'s WithEvidence findings.
const FINDING_WITH_EVIDENCE = {
  code: 'FND_CONTRADICTION',
  severity: 'error',
  requirementIds: ['REQ-1', 'REQ-2'],
  message: 'requirements conflict',
  evidence: {
    atomTable: [
      { kind: 'response', atom: 'sys__x__resp__do', slotText: 'do', negated: false },
      { kind: 'response', atom: 'sys__x__resp__do', slotText: 'not do', negated: true },
    ],
    core: ['REQ-1', 'REQ-2'],
  },
}

describe('minifyJson (AC-6-4 reduction 1: minified JSON)', () => {
  it('emits no pretty-print whitespace', () => {
    const s = minifyJson({ a: 1, b: [1, 2], c: { d: 'e' } })
    expect(s).toBe('{"a":1,"b":[1,2],"c":{"d":"e"}}')
    expect(s).not.toContain('\n')
    expect(s).not.toMatch(/: /)
  })
})

describe('densifyValue omits default keys (AC-6-4 reduction 2)', () => {
  it('drops keys equal to their Zod .default(...) value', () => {
    const dense = densifyValue(RequirementSchema, CANONICAL_REQ, {
      keepEvidence: true,
    }) as Record<string, unknown>
    // Defaults are dropped.
    expect('priority' in dense).toBe(false) // default 'medium'
    expect('status' in dense).toBe(false) // default 'draft'
    expect('derives' in dense).toBe(false) // default []
    expect('satisfies' in dense).toBe(false)
    expect('verifies' in dense).toBe(false)
    expect('refines' in dense).toBe(false)
    // Non-default, required fields survive.
    expect(dense.id).toBe(CANONICAL_REQ.id)
    expect(dense.systemResponse).toBe('issue a session token')
  })

  it('keeps a key whose value differs from the default', () => {
    const withHigh = { ...CANONICAL_REQ, priority: 'high' as const }
    const dense = densifyValue(RequirementSchema, withHigh, {
      keepEvidence: true,
    }) as Record<string, unknown>
    expect(dense.priority).toBe('high')
    // A non-empty edge array (differs from the [] default) is retained.
    const withEdge = { ...CANONICAL_REQ, derives: ['REQ-9'] }
    const denseEdge = densifyValue(RequirementSchema, withEdge, {
      keepEvidence: true,
    }) as Record<string, unknown>
    expect(denseEdge.derives).toEqual(['REQ-9'])
  })

  it('omits optional keys that are absence-safe null, keeps required nullable null', () => {
    // optional field: null is absence-safe → dropped.
    const optSchema = z.object({ a: z.string().optional(), b: z.string() })
    const denseOpt = densifyValue(optSchema, { a: null, b: 'keep' }) as Record<string, unknown>
    expect('a' in denseOpt).toBe(false)
    expect(denseOpt.b).toBe('keep')
    // pure nullable (required) field: dropping null would break validation → kept.
    const nulSchema = z.object({ a: z.string().nullable() })
    const denseNul = densifyValue(nulSchema, { a: null }) as Record<string, unknown>
    expect(denseNul.a).toBeNull()
  })
})

describe('densifyValue elides evidence unless keepEvidence (AC-6-4 reduction 3)', () => {
  const findingSchema = z.object({
    code: z.string(),
    severity: z.string(),
    requirementIds: z.array(z.string()),
    message: z.string(),
    evidence: z
      .object({
        atomTable: z.array(z.unknown()),
        core: z.array(z.string()).optional(),
      })
      .optional(),
  })

  it('drops the evidence field by default', () => {
    const dense = densifyValue(findingSchema, FINDING_WITH_EVIDENCE) as Record<string, unknown>
    expect('evidence' in dense).toBe(false)
    expect(dense.code).toBe('FND_CONTRADICTION')
    expect(dense.requirementIds).toEqual(['REQ-1', 'REQ-2'])
  })

  it('retains the evidence field (atom table + core) when keepEvidence is set', () => {
    const dense = densifyValue(findingSchema, FINDING_WITH_EVIDENCE, {
      keepEvidence: true,
    }) as Record<string, unknown>
    expect('evidence' in dense).toBe(true)
    expect((dense.evidence as { atomTable: unknown[] }).atomTable).toHaveLength(2)
  })

  it('elides evidence nested inside arrays and records', () => {
    const listSchema = z.object({ findings: z.array(findingSchema) })
    const dense = densifyValue(listSchema, { findings: [FINDING_WITH_EVIDENCE] }) as {
      findings: Record<string, unknown>[]
    }
    expect('evidence' in dense.findings[0]!).toBe(false)
  })
})

describe('densified output validates against the SAME schema (AC-6-4)', () => {
  it('a densified requirement re-validates against RequirementSchema', () => {
    const dense = densifyValue(RequirementSchema, CANONICAL_REQ, { keepEvidence: true })
    expect(() => RequirementSchema.parse(dense)).not.toThrow()
  })

  it('an evidence-elided finding still validates (evidence is optional)', () => {
    const findingSchema = z.object({
      code: z.string(),
      severity: z.string(),
      requirementIds: z.array(z.string()),
      message: z.string(),
      evidence: z.object({ atomTable: z.array(z.unknown()) }).optional(),
    })
    const dense = densifyValue(findingSchema, FINDING_WITH_EVIDENCE)
    expect(() => findingSchema.parse(dense)).not.toThrow()
  })
})

describe('densify round-trips to an equal object (AC-6-4)', () => {
  it('parse(densify(x)) deepEquals x for a canonical payload with evidence kept', () => {
    const dense = densifyValue(RequirementSchema, CANONICAL_REQ, { keepEvidence: true })
    const round = RequirementSchema.parse(dense)
    expect(round).toEqual(CANONICAL_REQ)
  })

  it('round-trips a UUID-keyed record of requirements', () => {
    const docSchema = z.object({
      schemaVersion: z.number(),
      requirements: z.record(z.string(), RequirementSchema),
    })
    const doc = {
      schemaVersion: 2,
      requirements: { [CANONICAL_REQ.id]: CANONICAL_REQ },
    }
    const dense = densifyValue(docSchema, doc, { keepEvidence: true }) as {
      requirements: Record<string, unknown>
    }
    // Record keys (UUIDs) are preserved; defaults inside the value are dropped.
    expect(Object.keys(dense.requirements)).toEqual([CANONICAL_REQ.id])
    expect('priority' in (dense.requirements[CANONICAL_REQ.id] as object)).toBe(false)
    expect(docSchema.parse(dense)).toEqual(doc)
  })
})

describe('stripAgnostic (schema-free data reduction)', () => {
  it('drops nulls and evidence when no schema is available', () => {
    const out = stripAgnostic({
      a: null,
      b: 'x',
      evidence: { atomTable: [] },
      nested: { c: null, d: 1 },
    }) as Record<string, unknown>
    expect('a' in out).toBe(false)
    expect('evidence' in out).toBe(false)
    expect(out.b).toBe('x')
    expect((out.nested as Record<string, unknown>).c).toBeUndefined()
    expect((out.nested as Record<string, unknown>).d).toBe(1)
  })

  it('keeps evidence when keepEvidence is set', () => {
    const out = stripAgnostic({ evidence: { atomTable: [] } }, { keepEvidence: true }) as Record<
      string,
      unknown
    >
    expect('evidence' in out).toBe(true)
  })
})

describe('densifyEnvelope preserves the AC-6-2 header and validates', () => {
  it('densifies a success envelope data payload and re-validates the envelope', () => {
    const env: Envelope<unknown> = success('check', {
      findings: [FINDING_WITH_EVIDENCE],
    })
    const dataSchema = z.object({
      findings: z.array(
        z.object({
          code: z.string(),
          severity: z.string(),
          requirementIds: z.array(z.string()),
          message: z.string(),
          evidence: z.object({ atomTable: z.array(z.unknown()) }).optional(),
        }),
      ),
    })
    const dense = densifyEnvelope(env, dataSchema)
    expect(dense.apiVersion).toBe(API_VERSION)
    expect(dense.type).toBe('check')
    // Header preserved; evidence elided from the nested finding.
    const data = (dense as { data: { findings: Record<string, unknown>[] } }).data
    expect('evidence' in data.findings[0]!).toBe(false)
    // Still a valid success envelope.
    expect(() => SuccessEnvelopeSchema.parse(dense)).not.toThrow()
  })

  it('strips a success envelope data agnostically when no data schema is given', () => {
    const env = success('show', { id: 'r1', trigger: null, evidence: { atomTable: [] } })
    const dense = densifyEnvelope(env)
    const data = (dense as { data: Record<string, unknown> }).data
    expect('trigger' in data).toBe(false)
    expect('evidence' in data).toBe(false)
    expect(data.id).toBe('r1')
    expect(() => SuccessEnvelopeSchema.parse(dense)).not.toThrow()
  })

  it('densifies an error envelope and re-validates against ErrorEnvelopeSchema', () => {
    const env = failure({
      error: 'no such document',
      code: 'ERR_DOC_NOT_FOUND',
      suggestions: ['run `symspec init`'],
    })
    const dense = densifyEnvelope(env)
    expect(dense.type).toBe('error')
    expect(() => ErrorEnvelopeSchema.parse(dense)).not.toThrow()
    // Round-trips to an equal object (no defaults/nulls to shed here).
    expect(ErrorEnvelopeSchema.parse(dense)).toEqual(env)
  })
})

describe('denseEnvelope produces minified, reduced output (AC-6-4 end-to-end)', () => {
  it('is minified and elides evidence by default', () => {
    const env = success('check', { findings: [FINDING_WITH_EVIDENCE] })
    const dataSchema = z.object({
      findings: z.array(
        z.object({
          code: z.string(),
          severity: z.string(),
          requirementIds: z.array(z.string()),
          message: z.string(),
          evidence: z.object({ atomTable: z.array(z.unknown()) }).optional(),
        }),
      ),
    })
    const out = denseEnvelope(env, dataSchema)
    expect(out).not.toContain('\n')
    expect(out).not.toContain('evidence')
    // Parses back to a valid envelope.
    expect(() => SuccessEnvelopeSchema.parse(JSON.parse(out))).not.toThrow()
  })

  it('keeps evidence when keepEvidence is passed (the --evidence escape hatch)', () => {
    const env = success('check', { findings: [FINDING_WITH_EVIDENCE] })
    const dataSchema = z.object({
      findings: z.array(
        z.object({
          code: z.string(),
          severity: z.string(),
          requirementIds: z.array(z.string()),
          message: z.string(),
          evidence: z.object({ atomTable: z.array(z.unknown()) }).optional(),
        }),
      ),
    })
    const out = denseEnvelope(env, dataSchema, { keepEvidence: true })
    expect(out).toContain('evidence')
    expect(out).toContain('atomTable')
  })

  it('dense output is strictly smaller than pretty output', () => {
    const env = success('check', { findings: [FINDING_WITH_EVIDENCE] })
    const pretty = JSON.stringify(env, null, 2)
    const dense = denseEnvelope(env)
    expect(dense.length).toBeLessThan(pretty.length)
  })
})
