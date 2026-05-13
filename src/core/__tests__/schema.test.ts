import { describe, expect, it } from 'vitest'
import { CreateRequirementAttrsSchema, RequirementSchema, renderSentence } from '../schema.js'

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
