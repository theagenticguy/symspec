import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ChangeSchema,
  CreateRequirementAttrsSchema,
  f,
  RelationshipAddInputShape,
  RelationshipRemoveInputShape,
  RequirementCreateInputShape,
  RequirementDeleteInputShape,
  RequirementSchema,
  type RequirementsDoc,
  RequirementsDocSchema,
  RequirementUpdateInputShape,
  renderSentence,
  SCHEMA_VERSION,
} from '../schema.js'

describe('renderSentence', () => {
  it('renders ubiquitous as "The X shall Y."', () => {
    expect(
      renderSentence({
        patternType: 'ubiquitous',
        systemName: 'auth service',
        systemResponse: 'log every authentication attempt',
      }),
    ).toBe('The auth service shall log every authentication attempt.')
  })

  it('renders event-driven with only trigger as "When T, the X shall Y."', () => {
    expect(
      renderSentence({
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemName: 'auth service',
        systemResponse: 'issue a session token',
      }),
    ).toBe('When the user submits valid credentials, the auth service shall issue a session token.')
  })

  it('renders event-driven with both pre + trigger as "While P, when T, ..."', () => {
    expect(
      renderSentence({
        patternType: 'event-driven',
        preCondition: 'maintenance mode is off',
        trigger: 'the user submits valid credentials',
        systemName: 'auth service',
        systemResponse: 'issue a session token',
      }),
    ).toBe(
      'While maintenance mode is off, when the user submits valid credentials, the auth service shall issue a session token.',
    )
  })

  it('renders state-driven as "While P, the X shall Y."', () => {
    expect(
      renderSentence({
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemName: 'auth service',
        systemResponse: 'reject all login attempts',
      }),
    ).toBe('While maintenance mode is enabled, the auth service shall reject all login attempts.')
  })

  it('renders optional-feature as "Where P, the X shall Y."', () => {
    expect(
      renderSentence({
        patternType: 'optional-feature',
        preCondition: 'SSO is configured for the tenant',
        systemName: 'auth service',
        systemResponse: 'redirect login to the configured IdP',
      }),
    ).toBe(
      'Where SSO is configured for the tenant, the auth service shall redirect login to the configured IdP.',
    )
  })

  it('renders unwanted-behavior as "If T, then the X shall Y."', () => {
    expect(
      renderSentence({
        patternType: 'unwanted-behavior',
        trigger: 'five consecutive failed logins occur within 10 minutes',
        systemName: 'auth service',
        systemResponse: 'lock the account for 15 minutes',
      }),
    ).toBe(
      'If five consecutive failed logins occur within 10 minutes, then the auth service shall lock the account for 15 minutes.',
    )
  })
})

describe('RequirementSchema defaults', () => {
  it('fills priority/status/edges with sensible defaults', () => {
    const parsed = RequirementSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every attempt',
      sentence: 'The auth service shall log every attempt.',
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    })
    expect(parsed.priority).toBe('medium')
    expect(parsed.status).toBe('draft')
    expect(parsed.derives).toEqual([])
    expect(parsed.satisfies).toEqual([])
    expect(parsed.verifies).toEqual([])
    expect(parsed.refines).toEqual([])
  })

  it('rejects an empty systemName', () => {
    const result = RequirementSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      patternType: 'ubiquitous',
      systemName: '',
      systemResponse: 'log every attempt',
      sentence: 'irrelevant',
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown patternType', () => {
    const result = RequirementSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      patternType: 'made-up-pattern',
      systemName: 'x',
      systemResponse: 'y',
      sentence: 'z',
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })
})

describe('RequirementsDoc shape (AC-1-2)', () => {
  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })

  it('models the document as { schemaVersion, requirements: Record<uuid, Requirement> }', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const requirement = RequirementSchema.parse({
      id,
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every attempt',
      sentence: 'The auth service shall log every attempt.',
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    })

    const doc: RequirementsDoc = {
      schemaVersion: SCHEMA_VERSION,
      requirements: { [id]: requirement },
    }

    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.requirements[id]).toBe(requirement)
  })

  it('keys the flat map by the UUID equal to requirement.id, not a positional index', () => {
    const id = '7a1b1111-2222-4333-8444-555566667777'
    const requirement = RequirementSchema.parse({
      id,
      patternType: 'ubiquitous',
      systemName: 'checkout pipeline',
      systemResponse: 'process the order',
      sentence: 'The checkout pipeline shall process the order.',
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    })

    const doc: RequirementsDoc = {
      schemaVersion: SCHEMA_VERSION,
      requirements: { [id]: requirement },
    }

    for (const [key, req] of Object.entries(doc.requirements)) {
      expect(key).toBe(req.id)
    }
    expect(Object.keys(doc.requirements)).toEqual([id])
  })
})

describe('RequirementsDocSchema (AC-1-4)', () => {
  it('parses a well-formed document', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const result = RequirementsDocSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      requirements: {
        [id]: {
          id,
          patternType: 'ubiquitous',
          systemName: 'auth service',
          systemResponse: 'log every attempt',
          sentence: 'The auth service shall log every attempt.',
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a document whose requirements map is keyed by a non-UUID', () => {
    const result = RequirementsDocSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      requirements: {
        'not-a-uuid': {
          id: 'not-a-uuid',
          patternType: 'ubiquitous',
          systemName: 'auth service',
          systemResponse: 'log every attempt',
          sentence: 'The auth service shall log every attempt.',
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a document missing the requirements map entirely', () => {
    const result = RequirementsDocSchema.safeParse({ schemaVersion: SCHEMA_VERSION })
    expect(result.success).toBe(false)
  })

  it('rejects a document whose a requirement fails RequirementSchema', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const result = RequirementsDocSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      requirements: {
        [id]: { id, patternType: 'made-up-pattern' },
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('CreateRequirementAttrsSchema', () => {
  it('accepts a minimal ubiquitous create payload', () => {
    const result = CreateRequirementAttrsSchema.safeParse({
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every attempt',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an event-driven create payload with a trigger', () => {
    const result = CreateRequirementAttrsSchema.safeParse({
      patternType: 'event-driven',
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      trigger: 'the user submits valid credentials',
    })
    expect(result.success).toBe(true)
  })
})

describe('.describe() corpus carries no stale v1 machinery (AC-8-5, SC-1/SC-2)', () => {
  // The describes drive `symspec manifest` and the generated agent docs, so
  // they must document v2 on its own terms: no CRDT storage layer, no
  // Automerge, no MCP tool surface, no `analysis_run` tool, no migrate
  // ceremony, no Bedrock solver tier.
  const FORBIDDEN = /CRDT|Automerge|automerge|MCP|analysis_run|migrate|Bedrock/

  /** Recursively collect every `description` string from a JSON-Schema projection. */
  const collectDescriptions = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const item of node) collectDescriptions(item, out)
      return out
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'description' && typeof value === 'string') out.push(value)
        else collectDescriptions(value, out)
      }
    }
    return out
  }

  it('no forbidden token appears in any description of any composed schema or input shape', () => {
    const surfaces: Record<string, z.ZodType> = {
      RequirementSchema,
      RequirementsDocSchema,
      CreateRequirementAttrsSchema,
      ChangeSchema,
      atomicFields: z.object(f),
      RequirementCreateInputShape: z.object(RequirementCreateInputShape),
      RequirementUpdateInputShape: z.object(RequirementUpdateInputShape),
      RelationshipAddInputShape: z.object(RelationshipAddInputShape),
      RelationshipRemoveInputShape: z.object(RelationshipRemoveInputShape),
      RequirementDeleteInputShape: z.object(RequirementDeleteInputShape),
    }
    for (const [name, schema] of Object.entries(surfaces)) {
      const descriptions = collectDescriptions(z.toJSONSchema(schema, { io: 'input' }))
      expect(descriptions.length, `${name} projected zero descriptions`).toBeGreaterThan(0)
      for (const description of descriptions) {
        expect(description, `${name} description references stale v1 machinery`).not.toMatch(
          FORBIDDEN,
        )
      }
    }
  })

  it('no forbidden token appears anywhere in schema.ts source (comments included)', () => {
    const src = readFileSync(fileURLToPath(new URL('../schema.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(FORBIDDEN)
  })
})
