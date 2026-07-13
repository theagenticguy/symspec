import { describe, expect, it } from 'vitest'
import { atomize as realAtomize } from '../atomize.js'
import { findContradictions } from '../contradiction.js'
import type { Atomize, EncodableRequirement } from '../encode.js'
import { establishedState, extractGuardImplications } from '../guard-implication.js'

/** The same default atomizer adapter contradiction.ts uses. */
const testAtomize: Atomize = (kind, text, systemName, negated) => {
  const a = realAtomize({ kind, text, systemName, negated })
  return { atom: a.name, negated: a.negated }
}

/**
 * #2 — guard-implication closure. A bridge requirement that establishes a state
 * ("while authenticated, be verified") links a rule guarded on `authenticated`
 * to a rule guarded on `verified`, making a previously unreachable contradiction
 * provable — with the bridge named in the core. Uses the real atomizer so the
 * state-vs-guard atom match exercises the shipped normalization + antonym table.
 */

const req = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'state-driven',
  systemName: 'system',
  systemResponse: 'grant access',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('establishedState — conservative state-establishment extraction', () => {
  it('extracts the state from a bare "be <state>" response', () => {
    expect(establishedState('be verified')).toBe('verified')
    expect(establishedState('become active')).toBe('active')
    expect(establishedState('remain locked')).toBe('locked')
  })

  it('extracts the state from a "mark/set <thing> as|to <state>" response', () => {
    expect(establishedState('mark the session as verified')).toBe('verified')
    expect(establishedState('set the flag to active')).toBe('active')
  })

  it('returns null for a non-establishment response', () => {
    expect(establishedState('issue a session token')).toBeNull()
    expect(establishedState('grant access')).toBeNull()
    expect(establishedState('')).toBeNull()
  })
})

describe('extractGuardImplications — inert-implication guard (pure)', () => {
  it('emits a bridge only when the established state matches another rule’s guard', () => {
    const reqs = [
      req({ id: 'R1', preCondition: 'the user is authenticated', systemResponse: 'grant access' }),
      req({ id: 'R2', preCondition: 'the user is verified', systemResponse: 'revoke access' }),
      req({
        id: 'BRIDGE',
        preCondition: 'the user is authenticated',
        systemResponse: 'be the user is verified',
      }),
    ]
    // real atomize via findContradictions' default path; here we call the pure
    // extractor with the same default atomizer through the module export.
    const bridges = extractGuardImplications(reqs, testAtomize)
    expect(bridges).toHaveLength(1)
    expect(bridges[0]!.bridgeId).toBe('BRIDGE')
  })

  it('drops a bridge whose established state matches no other guard (inert)', () => {
    const reqs = [
      req({ id: 'R1', preCondition: 'the user is authenticated', systemResponse: 'grant access' }),
      req({
        id: 'BRIDGE',
        preCondition: 'the user is authenticated',
        systemResponse: 'be quantum entangled',
      }),
    ]
    const bridges = extractGuardImplications(reqs, testAtomize)
    expect(bridges).toHaveLength(0)
  })
})

describe('findContradictions — transitive conflict via a state bridge (#2)', () => {
  it('is a FALSE NEGATIVE without the bridge (different guards, no shared context)', async () => {
    const reqs = [
      req({ id: 'R1', preCondition: 'the user is authenticated', systemResponse: 'grant access' }),
      req({ id: 'R2', preCondition: 'the user is verified', systemResponse: 'revoke access' }),
    ]
    const findings = await findContradictions(reqs)
    // grant/revoke is a seed antonym (same atom, opposite polarity), but the two
    // rules guard on DIFFERENT states, so no group asserts both contexts and the
    // conflict is unreachable.
    expect(findings).toHaveLength(0)
  })

  it('a bridge (authenticated ⟹ verified) makes it a proven FND_CONTRADICTION naming all three', async () => {
    const reqs = [
      req({ id: 'R1', preCondition: 'the user is authenticated', systemResponse: 'grant access' }),
      req({ id: 'R2', preCondition: 'the user is verified', systemResponse: 'revoke access' }),
      req({
        id: 'BRIDGE',
        preCondition: 'the user is authenticated',
        systemResponse: 'be the user is verified',
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_CONTRADICTION')
    expect(findings[0]!.requirementIds).toEqual(['BRIDGE', 'R1', 'R2'])
  })

  it('no spurious conflict when the bridge exists but the two rules do not clash', async () => {
    const reqs = [
      req({ id: 'R1', preCondition: 'the user is authenticated', systemResponse: 'grant access' }),
      req({ id: 'R2', preCondition: 'the user is verified', systemResponse: 'grant access' }),
      req({
        id: 'BRIDGE',
        preCondition: 'the user is authenticated',
        systemResponse: 'be the user is verified',
      }),
    ]
    const findings = await findContradictions(reqs)
    // Both rules grant — no opposite-polarity clash — so the reachable closure
    // proves nothing. The bridge only widens reachability; it never invents a
    // conflict.
    expect(findings).toHaveLength(0)
  })
})
