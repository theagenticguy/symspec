import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import {
  contextAtomsOf,
  findContradictions,
  minimizeCore,
  planContextGroups,
} from '../contradiction.js'
import type { Atomize, AtomLit, EncodableRequirement } from '../encode.js'
import { encode } from '../encode.js'

// A deterministic atomizer used ONLY for the pure planContextGroups tests, so
// grouping is asserted without booting the WASM solver. Mirrors the real
// AC-4-2a scoping shape (`sys__<system>__<kind>__<slot>`).
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

/**
 * AC-4-3 — per-context-group whole-spec reachability contradiction detection.
 *
 * These tests pin the ONE soundness rule the task exists for (research-smt.md
 * §1.2): each group asserts only ITS OWN context atoms and never all triggers
 * in one global conjunction, so mutually exclusive triggers cannot fake a
 * conflict — while including EVERY requirement's guarded formula so a ubiquitous
 * `¬R` can conflict with a guarded `T ⇒ R` through a shared response atom.
 *
 * The real AC-4-2a `atomize` is used (no fake) so the whole-spec reachability
 * proof exercises the shipped atom table, per-system scoping, and antonym unify.
 */

const req = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('planContextGroups — grouping discipline (AC-4-3, pure)', () => {
  it('always includes a baseline empty-context group first', () => {
    const encoded = [encode(req({ id: 'U', patternType: 'ubiquitous' }), fakeAtomize)]
    const groups = planContextGroups(encoded)
    expect(groups[0]?.key).toBe('')
    expect(groups[0]?.contextAtoms).toEqual([])
  })

  it('unifies requirements that share a trigger into ONE group', () => {
    const a = encode(
      req({ id: 'A', patternType: 'event-driven', trigger: 'the user logs in' }),
      fakeAtomize,
    )
    const b = encode(
      req({ id: 'B', patternType: 'event-driven', trigger: 'the user logs in' }),
      fakeAtomize,
    )
    const groups = planContextGroups([a, b])
    // baseline + exactly one shared trigger group
    expect(groups).toHaveLength(2)
  })

  it('keeps mutually exclusive triggers in DISTINCT groups (never asserted together)', () => {
    const a = encode(
      req({ id: 'A', patternType: 'event-driven', trigger: 'the user logs in' }),
      fakeAtomize,
    )
    const b = encode(
      req({ id: 'B', patternType: 'event-driven', trigger: 'the user logs out' }),
      fakeAtomize,
    )
    const groups = planContextGroups([a, b])
    // baseline + two distinct trigger groups — no group asserts both triggers
    expect(groups).toHaveLength(3)
    for (const g of groups) {
      expect(g.contextAtoms.length).toBeLessThanOrEqual(1)
    }
  })

  it('contextAtomsOf returns only trig/pre atoms, not the response', () => {
    const e = encode(
      req({
        id: 'C',
        patternType: 'event-driven',
        preCondition: 'maintenance mode is off',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const ctx = contextAtomsOf(e)
    expect(ctx).toHaveLength(2)
    expect(ctx.some((a) => a.includes('__resp__'))).toBe(false)
  })
})

describe('findContradictions — reachable guarded conflict IS found (AC-4-3)', () => {
  it('same trigger, opposite-polarity response → FND_CONTRADICTION with both ids', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'REQ-001',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'REQ-002',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.code).toBe('FND_CONTRADICTION')
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.requirementIds).toEqual(['REQ-001', 'REQ-002'])
  })

  it('antonym-unified responses under one trigger conflict (grant vs revoke)', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'G',
        patternType: 'event-driven',
        trigger: 'the admin approves the request',
        systemResponse: 'grant access',
      }),
      req({
        id: 'R',
        patternType: 'event-driven',
        trigger: 'the admin approves the request',
        systemResponse: 'revoke access',
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['G', 'R'])
  })
})

describe('findContradictions — mutually exclusive triggers do NOT fake a conflict (the soundness rule)', () => {
  it('different triggers with opposite responses are consistent → no finding', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'REQ-101',
        patternType: 'event-driven',
        trigger: 'the user logs in',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'REQ-102',
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    // If the checker asserted BOTH triggers in one global conjunction this would
    // be a spurious unsat. Per-group scoping keeps them apart.
    const findings = await findContradictions(reqs)
    expect(findings).toEqual([])
  })
})

describe('findContradictions — whole-spec inclusion: ubiquitous ¬R vs guarded T⇒R (AC-4-3)', () => {
  it('ubiquitous ¬R plus event-driven T⇒R (same response atom) → conflict when T group checked', async () => {
    const reqs: EncodableRequirement[] = [
      // Ubiquitous negative: the service shall NOT issue a session token (bare ¬R).
      req({
        id: 'UBI',
        patternType: 'ubiquitous',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      // Event-driven positive on the same response atom under a trigger.
      req({
        id: 'EVT',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
    ]
    const findings = await findContradictions(reqs)
    // The ubiquitous formula (belonging to NO trigger group) must be present in
    // the T-group's conjunction for this conflict to be reachable — proving
    // whole-spec inclusion.
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['EVT', 'UBI'])
  })

  it('two unconditional ubiquitous requirements R and ¬R conflict via the baseline group', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'P',
        patternType: 'ubiquitous',
        systemResponse: 'log the request',
        negated: false,
      }),
      req({ id: 'N', patternType: 'ubiquitous', systemResponse: 'log the request', negated: true }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['N', 'P'])
  })
})

describe('findContradictions — distinct response atoms are NOT a conflict (false-negative direction)', () => {
  it('same trigger but unrelated responses → no finding (sound modulo atomization)', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'create a login token',
        negated: true,
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toEqual([])
  })

  it('identical response text under DIFFERENT systems does not unify (per-system scoping)', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'AUTH',
        patternType: 'event-driven',
        systemName: 'auth service',
        trigger: 'the request arrives',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'BILL',
        patternType: 'event-driven',
        systemName: 'billing service',
        trigger: 'the request arrives',
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    // Cross-system responses are distinct atoms → no spurious contradiction.
    const findings = await findContradictions(reqs)
    expect(findings).toEqual([])
  })

  it('a single requirement cannot contradict itself → no finding', async () => {
    const findings = await findContradictions([
      req({ id: 'SOLO', patternType: 'ubiquitous', systemResponse: 'issue a session token' }),
    ])
    expect(findings).toEqual([])
  })
})

/**
 * AC-4-4 — MINIMAL unsat core → EXACTLY the conflicting REQ-* ids.
 *
 * Z3 cores are not minimal by default, and each group's conjunction spans the
 * WHOLE spec (AC-4-3), so an innocent requirement that shares no atom could ride
 * along in a non-minimal core. These tests plant such an innocent third
 * requirement and confirm it is ABSENT from the reported ids — proving the
 * `smt.core.minimize` option + deletion-based `minimizeCore` refinement.
 */
describe('findContradictions — minimal core: no innocent third (AC-4-4)', () => {
  it('2-way conflict with an innocent disjoint-atom third → EXACTLY the two ids', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'REQ-001',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'REQ-002',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      // Innocent third: same trigger group, but an entirely unrelated response
      // atom shared with nothing else. It must NOT appear in the core.
      req({
        id: 'REQ-003',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'write an audit log entry',
        negated: false,
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['REQ-001', 'REQ-002'])
    expect(findings[0]?.requirementIds).not.toContain('REQ-003')
  })

  it('antonym conflict with an innocent ubiquitous third → EXACTLY the two ids', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'G',
        patternType: 'event-driven',
        trigger: 'the admin approves the request',
        systemResponse: 'grant access',
      }),
      req({
        id: 'R',
        patternType: 'event-driven',
        trigger: 'the admin approves the request',
        systemResponse: 'revoke access',
      }),
      // Innocent ubiquitous requirement on a disjoint atom — present in every
      // group's whole-spec conjunction, yet irrelevant to the grant/revoke clash.
      req({ id: 'INNOCENT', patternType: 'ubiquitous', systemResponse: 'emit a metric' }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['G', 'R'])
  })

  it('distinct-response-atom "conflict" emits nothing even with a third present', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'create a login token',
        negated: true,
      }),
      req({
        id: 'C',
        patternType: 'ubiquitous',
        systemResponse: 'emit a metric',
      }),
    ]
    // No two responses resolve to the same atom with opposite polarity → SAT →
    // no finding (documented false-negative direction, AC-4-11).
    const findings = await findContradictions(reqs)
    expect(findings).toEqual([])
  })
})

/**
 * Multiple INDEPENDENT conflicts within a single context group must ALL be
 * reported. A single group can host more than one disjoint conflict — two
 * requirement pairs clashing on DIFFERENT response atoms under the same asserted
 * context, or (for an all-ubiquitous spec) any number of pairs in the baseline
 * group. A single `check`/core extraction surfaces only the first and silently
 * drops the rest — a false negative the enumeration loop fixes by dropping a
 * reported core's guards and re-checking until the group is `sat`.
 */
describe('findContradictions — every disjoint conflict in a group is reported', () => {
  it('two disjoint conflicts under ONE trigger both surface', async () => {
    const T = 'the user submits valid credentials'
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'issue a session token',
        negated: true,
      }),
      req({
        id: 'C',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'flush the cache',
        negated: false,
      }),
      req({
        id: 'D',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'flush the cache',
        negated: true,
      }),
    ]
    const findings = await findContradictions(reqs)
    const ids = findings.map((f) => f.requirementIds).sort()
    expect(ids).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ])
  })

  it('two disjoint UBIQUITOUS conflicts both surface via the baseline group', async () => {
    const reqs: EncodableRequirement[] = [
      req({
        id: 'P1',
        patternType: 'ubiquitous',
        systemResponse: 'log the request',
        negated: false,
      }),
      req({
        id: 'N1',
        patternType: 'ubiquitous',
        systemResponse: 'log the request',
        negated: true,
      }),
      req({ id: 'P2', patternType: 'ubiquitous', systemResponse: 'emit a metric', negated: false }),
      req({ id: 'N2', patternType: 'ubiquitous', systemResponse: 'emit a metric', negated: true }),
    ]
    const findings = await findContradictions(reqs)
    const ids = findings.map((f) => f.requirementIds).sort()
    expect(ids).toEqual([
      ['N1', 'P1'],
      ['N2', 'P2'],
    ])
  })

  it('overlapping conflict on ONE atom (A vs B, A vs C) stays a single finding', async () => {
    // Three requirements clashing on the SAME atom are jointly unsat, but the
    // minimal cross-requirement conflict is still just the first pruned pair —
    // enumeration must not invent a spurious second finding here.
    const T = 'the user submits valid credentials'
    const reqs: EncodableRequirement[] = [
      req({
        id: 'A',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'issue a session token',
        negated: false,
      }),
      req({
        id: 'B',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'issue a session token',
        negated: true,
      }),
      req({
        id: 'C',
        patternType: 'event-driven',
        trigger: T,
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    const findings = await findContradictions(reqs)
    expect(findings).toHaveLength(1)
  })
})

/**
 * AC-4-4 — `minimizeCore` as a directly-exercised unit, against the real WASM
 * solver. Proves the deletion pass strips an inessential guard from a
 * deliberately non-minimal starting core.
 */
describe('minimizeCore — deletion-based irreducible subset (AC-4-4)', () => {
  it('drops an inessential guard from a non-minimal core, keeps the conflicting pair', async () => {
    const ctx = await getContext('symspec-test-minimize')
    const solver = new ctx.Solver()
    solver.set('timeout', 2000)

    const g1 = ctx.Bool.const('REQ-1')
    const g2 = ctx.Bool.const('REQ-2')
    const g3 = ctx.Bool.const('REQ-3')
    const T = ctx.Bool.const('T')
    const R = ctx.Bool.const('R')
    const X = ctx.Bool.const('X')
    const Y = ctx.Bool.const('Y')

    // REQ-1: T ⇒ R, REQ-2: T ⇒ ¬R  (the real conflict under asserted T).
    solver.add(ctx.Implies(g1, ctx.Implies(T, R)))
    solver.add(ctx.Implies(g2, ctx.Implies(T, ctx.Not(R))))
    // REQ-3: X ⇒ Y  (disjoint atoms — an innocent bystander).
    solver.add(ctx.Implies(g3, ctx.Implies(X, Y)))
    solver.add(T)

    // Feed a deliberately NON-minimal starting core containing the innocent g3.
    const minimal = await minimizeCore(solver, [g1, g2, g3])
    const names = minimal.map((b) => b.toString()).sort()
    expect(names).toEqual(['REQ-1', 'REQ-2'])
  })

  it('leaves an already-minimal pair untouched', async () => {
    const ctx = await getContext('symspec-test-minimize-2')
    const solver = new ctx.Solver()
    const g1 = ctx.Bool.const('REQ-1')
    const g2 = ctx.Bool.const('REQ-2')
    const T = ctx.Bool.const('T')
    const R = ctx.Bool.const('R')
    solver.add(ctx.Implies(g1, ctx.Implies(T, R)))
    solver.add(ctx.Implies(g2, ctx.Implies(T, ctx.Not(R))))
    solver.add(T)
    const minimal = await minimizeCore(solver, [g1, g2])
    expect(minimal.map((b) => b.toString()).sort()).toEqual(['REQ-1', 'REQ-2'])
  })
})
