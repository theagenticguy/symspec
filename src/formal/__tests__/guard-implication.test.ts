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

  it('de-inflects the head verb — 3sg and irregular forms recognized', () => {
    expect(establishedState('marks the session as verified')).toBe('verified')
    expect(establishedState('keeps the reactor online')).toBe('the reactor online')
    expect(establishedState('kept the valve sealed')).toBe('the valve sealed')
    expect(establishedState('holds the coolant valve sealed')).toBe('the coolant valve sealed')
  })

  it('recognizes the eval-expansion object-form verbs and connectors', () => {
    expect(establishedState('classify the principal as trusted')).toBe('trusted')
    expect(establishedState('escalate the principal to privileged')).toBe('privileged')
    expect(establishedState('promotes the record to published')).toBe('published')
    expect(establishedState('transition the gateway to the quiescent state')).toBe(
      'the quiescent state',
    )
    expect(establishedState('place the record in quarantine')).toBe('quarantine')
    expect(establishedState('registers the origin as external')).toBe('external')
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

  it('a "mark <thing> as <state>" bridge matches a copula guard ("while the session is authenticated")', async () => {
    // Run 3 escape #4: the bridge established "the session verified" but the
    // guard read "the session is verified" — the copula was a byte gap that
    // dropped the bridge as inert. Guard atomization now strips one copula.
    const reqs = [
      req({
        id: 'R1',
        preCondition: 'the session is authenticated',
        systemResponse: 'deny access to the vault',
      }),
      req({
        id: 'R2',
        preCondition: 'the session is verified',
        systemResponse: 'grant access to the vault',
      }),
      req({
        id: 'BRIDGE',
        preCondition: 'the session is authenticated',
        systemResponse: 'mark the session as verified',
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['BRIDGE', 'R1', 'R2'])
  })

  it('proves the Run 3 privilege-chain contradiction (authenticated→verified→trusted→privileged, grant vs deny)', async () => {
    // Round 1 of Run 3: symspec exited 0/verified=true on this shape. The
    // 4-hop bridge chain + the grant/deny class merge now prove it.
    const reqs = [
      req({
        id: 'DENY',
        preCondition: 'the session is authenticated',
        systemResponse: 'deny access to the vault',
      }),
      req({
        id: 'B1',
        trigger: 'a user signs in',
        systemResponse: 'mark the session authenticated',
        patternType: 'event-driven',
      }),
      req({
        id: 'B2',
        preCondition: 'the session is authenticated',
        systemResponse: 'mark the session verified',
      }),
      req({
        id: 'B3',
        preCondition: 'the session is verified',
        systemResponse: 'mark the session trusted',
      }),
      req({
        id: 'B4',
        preCondition: 'the session is trusted',
        systemResponse: 'mark the session privileged',
      }),
      req({
        id: 'GRANT',
        preCondition: 'the session is privileged',
        systemResponse: 'grant access to the vault',
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const f = findings[0]!
    expect(f.code).toBe('FND_CONTRADICTION')
    expect(f.requirementIds).toContain('DENY')
    expect(f.requirementIds).toContain('GRANT')
  })

  it('a "keeps <thing> <state>" bridge matches the copula guard (Run 2 reactor round)', async () => {
    // "while the coolant pump is engaged, keep the reactor online" vs
    // "when overheating, shut down the reactor" — with the overheating→pump
    // bridge, the reactor is forced online and offline at once. shut_down is
    // not an antonym of keep-online; instead phrase the conflicting pair on
    // one verb class: keep online vs take offline needs domain antonyms, so
    // test the reachability half: keeps→state matches the copula guard.
    const reqs = [
      req({
        id: 'R1',
        preCondition: 'the reactor is online',
        systemResponse: 'grant power to the grid',
      }),
      req({
        id: 'R2',
        preCondition: 'the coolant pump is engaged',
        systemResponse: 'deny power to the grid',
      }),
      req({
        id: 'BRIDGE',
        preCondition: 'the coolant pump is engaged',
        systemResponse: 'keeps the reactor online',
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['BRIDGE', 'R1', 'R2'])
  })
})
