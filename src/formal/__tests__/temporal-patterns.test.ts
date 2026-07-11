import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../solvers/types.js'
import {
  earsToTemporal,
  F,
  G,
  type TemporalFormula,
  tAtom,
  tImplies,
  tNot,
} from '../temporal-patterns.js'

/**
 * Per-pattern shape tests for the EARS → Dwyer/SPS temporal mapping (AC-33-1).
 * The mapping is pure, so we assert directly on the returned AST structure —
 * no solver, no WASM boot. Atom names use the same `sys__<system>__<kind>__
 * <slot>` scoping the propositional atomizer emits (AC-4-2a), so a temporal
 * atom and its propositional counterpart line up by name.
 */

const view = (overrides: Partial<ReqView> = {}): ReqView => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  negated: false,
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

const RESP = 'sys__auth_service__resp__issue_a_session_token'

describe('earsToTemporal — EARS pattern → Dwyer/SPS temporal shape (AC-33-1)', () => {
  it('event-driven → Response: G(trig → F resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
    )
    const trig = tAtom('sys__auth_service__trig__user_submits_valid_credentials')
    expect(f).toEqual(G(tImplies(trig, F(tAtom(RESP)))))
  })

  it('unwanted-behavior → Absence: G(cond → ¬resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'unwanted-behavior',
        trigger: 'five consecutive failed logins occur',
        systemResponse: 'issue a session token',
      }),
    )
    const cond = tAtom('sys__auth_service__trig__five_consecutive_failed_logins_occur')
    expect(f).toEqual(G(tImplies(cond, tNot(tAtom(RESP)))))
  })

  it('state-driven → Universality within scope: G(state → resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemResponse: 'issue a session token',
      }),
    )
    const state = tAtom('sys__auth_service__pre__maintenance_mode_is_enabled')
    expect(f).toEqual(G(tImplies(state, tAtom(RESP))))
  })

  it('optional-feature → Universality gated by a feature literal: G(feature → resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'optional-feature',
        preCondition: 'SSO is configured for the tenant',
        systemResponse: 'issue a session token',
      }),
    )
    const feature = tAtom('sys__auth_service__feat__sso_is_configured_for_the_tenant')
    expect(f).toEqual(G(tImplies(feature, tAtom(RESP))))
  })

  it('ubiquitous → Universality: G(resp)', () => {
    const f = earsToTemporal(view({ patternType: 'ubiquitous' }))
    expect(f).toEqual(G(tAtom(RESP)))
  })
})

describe('earsToTemporal — response polarity threads AC-2-4 onto the same atom', () => {
  it('negated ubiquitous → G(¬resp) on the positive atom name', () => {
    const f = earsToTemporal(view({ patternType: 'ubiquitous', negated: true }))
    expect(f).toEqual(G(tNot(tAtom(RESP))))
  })

  it('negated event-driven composes: G(trig → F ¬resp) on the positive atom', () => {
    const f = earsToTemporal(
      view({
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'issue a session token',
        negated: true,
      }),
    )
    const trig = tAtom('sys__auth_service__trig__user_logs_out')
    expect(f).toEqual(G(tImplies(trig, F(tNot(tAtom(RESP))))))
  })
})

describe('earsToTemporal — purity and determinism (AC-33-1)', () => {
  it('does not mutate its input', () => {
    const req = view({ patternType: 'event-driven', trigger: 'x happens' })
    const snapshot = structuredClone(req)
    earsToTemporal(req)
    expect(req).toEqual(snapshot)
  })

  it('is deterministic — same input yields a deeply-equal AST', () => {
    const req = view({ patternType: 'state-driven', preCondition: 'p holds' })
    expect(earsToTemporal(req)).toEqual(earsToTemporal(req))
  })

  it('per-system scoping: same response text under two systems yields distinct atoms', () => {
    const a = earsToTemporal(view({ systemName: 'auth service' })) as Extract<
      TemporalFormula,
      { op: 'G' }
    >
    const b = earsToTemporal(view({ systemName: 'billing service' })) as Extract<
      TemporalFormula,
      { op: 'G' }
    >
    expect(a.arg).not.toEqual(b.arg)
  })
})
