import { describe, expect, it } from 'vitest'
import { renderSentence } from '../render.js'

/**
 * AC-1-3: byte-for-byte port of the v1 `renderSentence` suite, now pointed at
 * the standalone `render.ts` module rather than importing through
 * `schema.ts`. `schema.test.ts` covers the same behavior via the
 * `schema.js` re-export (backward-compat surface); this file locks the pure
 * module itself.
 */
describe('renderSentence (src/core/render.ts)', () => {
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

  it('renders event-driven with neither pre nor trigger present (defensive slot omission)', () => {
    expect(
      renderSentence({
        patternType: 'event-driven',
        systemName: 'auth service',
        systemResponse: 'issue a session token',
      }),
    ).toBe('When , the auth service shall issue a session token.')
  })
})
