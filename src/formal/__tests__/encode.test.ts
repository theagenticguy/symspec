import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../solvers/types.js'
import { getContext } from '../backend.js'
import {
  type Atomize,
  type AtomLit,
  and,
  atom,
  type EncodableRequirement,
  encode,
  type Formula,
  implies,
  materialize,
  not,
  or,
} from '../encode.js'

/**
 * A deterministic stand-in for the AC-4-2a atomizer. It is NOT the real
 * atom table (owned by src/formal/atomize.ts, a parallel wave-mate) — the
 * encoder is pure over an injected {@link Atomize}, so these tests pin the
 * per-pattern formula SHAPE without depending on that file. It uses the same
 * conservative scoping shape (`sys__<system>__<kind>__<slot>`) so atom names
 * read like the real ones.
 */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')

const fakeAtomize: Atomize = (kind, slotText, systemName, negated): AtomLit => ({
  atom: `sys__${norm(systemName)}__${kind}__${norm(slotText)}`,
  negated,
})

const view = (overrides: Partial<EncodableRequirement> = {}): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('encode — per-pattern formula shape (AC-4-2)', () => {
  it('ubiquitous → guard ⇒ R (bare response, no context)', () => {
    const e = encode(view({ patternType: 'ubiquitous' }), fakeAtomize)
    expect(e.guard).toBe('REQ-1')
    expect(e.body).toEqual(atom('sys__auth_service__resp__issue_a_session_token'))
    expect(e.formula).toEqual(implies(atom('REQ-1'), e.body))
  })

  it('event-driven → guard ⇒ (T ⇒ R)', () => {
    const e = encode(
      view({
        id: 'REQ-2',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const T = atom('sys__auth_service__trig__user_submits_valid_credentials')
    const R = atom('sys__auth_service__resp__issue_a_session_token')
    expect(e.body).toEqual(implies(T, R))
    expect(e.formula).toEqual(implies(atom('REQ-2'), implies(T, R)))
  })

  it('unwanted-behavior → guard ⇒ (T ⇒ R) (same body shape as event-driven)', () => {
    const e = encode(
      view({
        patternType: 'unwanted-behavior',
        trigger: 'a token is expired',
        systemResponse: 'reject the request',
      }),
      fakeAtomize,
    )
    const T = atom('sys__auth_service__trig__token_is_expired')
    const R = atom('sys__auth_service__resp__reject_the_request')
    expect(e.body).toEqual(implies(T, R))
  })

  it('state-driven → guard ⇒ (P ⇒ R)', () => {
    const e = encode(
      view({
        patternType: 'state-driven',
        preCondition: 'the connection is open',
        systemResponse: 'stream events',
      }),
      fakeAtomize,
    )
    const P = atom('sys__auth_service__pre__connection_is_open')
    const R = atom('sys__auth_service__resp__stream_events')
    expect(e.body).toEqual(implies(P, R))
  })

  it('optional-feature → guard ⇒ (P ⇒ R) (P is the feature flag)', () => {
    const e = encode(
      view({
        patternType: 'optional-feature',
        preCondition: 'audit logging is enabled',
        systemResponse: 'record each request',
      }),
      fakeAtomize,
    )
    const P = atom('sys__auth_service__pre__audit_logging_is_enabled')
    const R = atom('sys__auth_service__resp__record_each_request')
    expect(e.body).toEqual(implies(P, R))
  })

  it('complex (precondition AND trigger) → guard ⇒ ((P ∧ T) ⇒ R)', () => {
    const e = encode(
      view({
        patternType: 'event-driven', // Tier-1 maps "complex" onto event-driven
        preCondition: 'maintenance mode is off',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const P = atom('sys__auth_service__pre__maintenance_mode_is_off')
    const T = atom('sys__auth_service__trig__user_submits_valid_credentials')
    const R = atom('sys__auth_service__resp__issue_a_session_token')
    expect(e.body).toEqual(implies(and([P, T]), R))
  })
})

describe('encode — negation threads AC-2-4 onto the SAME response atom (AC-4-2)', () => {
  it('negated response emits ¬R on the positive atom, not an atom containing "not"', () => {
    const positive = encode(
      view({ id: 'A', systemResponse: 'issue a session token', negated: false }),
      fakeAtomize,
    )
    const negatedReq = encode(
      view({ id: 'B', systemResponse: 'issue a session token', negated: true }),
      fakeAtomize,
    )
    const R = 'sys__auth_service__resp__issue_a_session_token'
    // Same atom name in both — only the polarity differs.
    expect(positive.body).toEqual(atom(R))
    expect(negatedReq.body).toEqual(not(atom(R)))
    expect(negatedReq.atoms.find((a) => a.kind === 'resp')?.atom).toBe(R)
    expect(negatedReq.atoms.find((a) => a.kind === 'resp')?.negated).toBe(true)
  })

  it('negation composes under a context guard: guard ⇒ (T ⇒ ¬R)', () => {
    const e = encode(
      view({
        id: 'REQ-9',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      fakeAtomize,
    )
    const T = atom('sys__auth_service__trig__user_submits_valid_credentials')
    const R = atom('sys__auth_service__resp__issue_a_session_token')
    expect(e.body).toEqual(implies(T, not(R)))
  })

  it('defaults negated=false for a plain ReqView with no flag', () => {
    const bare: ReqView = {
      id: 'REQ-0',
      patternType: 'ubiquitous',
      systemName: 'gateway',
      systemResponse: 'log the request',
      sentence: '',
      priority: 'low',
      status: 'draft',
    }
    const e = encode(bare, fakeAtomize)
    expect(e.atoms.find((a) => a.kind === 'resp')?.negated).toBe(false)
  })
})

describe('encode — per-system scoping propagates from the atomizer (AC-4-2a contract)', () => {
  it('identical response text under two systems yields two distinct atoms', () => {
    const a = encode(view({ id: 'A', systemName: 'auth service' }), fakeAtomize)
    const b = encode(view({ id: 'B', systemName: 'billing service' }), fakeAtomize)
    const aResp = a.atoms.find((x) => x.kind === 'resp')?.atom
    const bResp = b.atoms.find((x) => x.kind === 'resp')?.atom
    expect(aResp).not.toBe(bResp)
  })
})

describe('encode — atom table (feeds AC-4-6 evidence)', () => {
  it('lists exactly the referenced atoms with slot text and polarity', () => {
    const e = encode(
      view({
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    expect(e.atoms).toHaveLength(2)
    const trig = e.atoms.find((a) => a.kind === 'trig')
    const resp = e.atoms.find((a) => a.kind === 'resp')
    expect(trig?.slotText).toBe('the user submits valid credentials')
    expect(resp?.slotText).toBe('issue a session token')
    expect(resp?.negated).toBe(false)
  })

  it('empty-string optional slots are treated as absent (no context)', () => {
    const e = encode(
      view({ patternType: 'ubiquitous', trigger: '', preCondition: '' }),
      fakeAtomize,
    )
    expect(e.atoms).toHaveLength(1) // response only
    expect(e.atoms[0]?.kind).toBe('resp')
    expect(e.body.op).toBe('atom')
  })
})

describe('encode — purity (AC-4-2: pure over ReqView)', () => {
  it('does not mutate the input requirement', () => {
    const req = view({ patternType: 'event-driven', trigger: 'x happens' })
    const snapshot = structuredClone(req)
    encode(req, fakeAtomize)
    expect(req).toEqual(snapshot)
  })

  it('is deterministic — same input yields deeply-equal output', () => {
    const req = view({ patternType: 'state-driven', preCondition: 'p holds' })
    expect(encode(req, fakeAtomize)).toEqual(encode(req, fakeAtomize))
  })

  it('never calls the solver — encoding a spec touches only the injected atomize', () => {
    let calls = 0
    const counting: Atomize = (k, s, sys, n) => {
      calls++
      return fakeAtomize(k, s, sys, n)
    }
    encode(view({ patternType: 'event-driven', trigger: 't' }), counting)
    expect(calls).toBe(2) // trigger + response, no more
  })
})

describe('materialize — lowers a Formula into a checkable Z3 Bool (AC-4-2 solver boundary)', () => {
  it('the guarded contradiction pair is unsat with the context asserted', async () => {
    const ctx = await getContext('encode-materialize-test')
    const a = encode(
      view({
        id: 'REQ-001',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      fakeAtomize,
    )
    const b = encode(
      view({
        id: 'REQ-002',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      fakeAtomize,
    )
    const { Solver, Bool } = ctx
    const solver = new Solver()
    solver.add(materialize(ctx, a.formula))
    solver.add(materialize(ctx, b.formula))
    // Assert shared trigger context is reachable (research-smt.md §1.2).
    solver.add(ctx.Bool.const('sys__auth_service__trig__user_submits_valid_credentials'))
    const g1 = Bool.const('REQ-001')
    const g2 = Bool.const('REQ-002')
    const res = await solver.check(g1, g2)
    expect(res).toBe('unsat')
  })

  it('distinct response atoms are SAT even with the trigger asserted (false-negative direction)', async () => {
    const ctx = await getContext('encode-materialize-sat')
    const a = encode(
      view({
        id: 'REQ-101',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const b = encode(
      view({
        id: 'REQ-102',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'create a login token',
        negated: true,
      }),
      fakeAtomize,
    )
    const { Solver, Bool } = ctx
    const solver = new Solver()
    solver.add(materialize(ctx, a.formula))
    solver.add(materialize(ctx, b.formula))
    solver.add(ctx.Bool.const('sys__auth_service__trig__user_submits_valid_credentials'))
    const res = await solver.check(Bool.const('REQ-101'), Bool.const('REQ-102'))
    expect(res).toBe('sat')
  })
})

describe('Formula constructors — arity collapse keeps shapes minimal', () => {
  it('and/or with a single arg collapse to that arg', () => {
    const x = atom('x')
    expect(and([x])).toBe(x)
    expect(or([x])).toBe(x)
  })

  it('and/or with multiple args build the node', () => {
    const multi: Formula = and([atom('x'), atom('y')])
    expect(multi.op).toBe('and')
  })
})
