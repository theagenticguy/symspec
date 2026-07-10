import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import { type Atomize, type AtomLit, type EncodableRequirement, encode } from '../encode.js'
import { checkVacuity, checkVacuityOf } from '../vacuity.js'

/**
 * Kind-AGNOSTIC fake atomizer: it deliberately drops the slot `kind` from the
 * atom name, so a RESPONSE atom can coincide with a PRECONDITION atom. That
 * collision is the only way relational vacuity bites propositionally under
 * regex parsing — "one requirement's response atom is another's negated
 * precondition atom" (research-smt.md §1.5). The real kind-scoped atomizer
 * (AC-4-2a) makes this narrow, which is exactly why FND_VACUITY ships at low
 * confidence (AC-4-5). The module under test is atomizer-agnostic.
 */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')

const kindAgnostic: Atomize = (_kind, slotText, systemName, negated): AtomLit => ({
  atom: `sys__${norm(systemName)}__${norm(slotText)}`,
  negated,
})

const view = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ',
  patternType: 'ubiquitous',
  systemName: 'gateway',
  systemResponse: 'log the request',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('vacuity — relational, whole-spec (AC-4-5)', () => {
  it('flags a requirement whose guard is unreachable given another requirement', async () => {
    const ctx = await getContext('vacuity-hit')
    // A: ubiquitous, always disables maintenance mode → body asserts ¬maint.
    const a = encode(
      view({
        id: 'REQ-A',
        patternType: 'ubiquitous',
        systemResponse: 'maintenance mode is enabled',
        negated: true,
      }),
      kindAgnostic,
    )
    // B: fires only WHILE maintenance mode is enabled → guard atom `maint`.
    const b = encode(
      view({
        id: 'REQ-B',
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemResponse: 'flush the cache',
      }),
      kindAgnostic,
    )
    const finding = await checkVacuityOf(ctx, b, [a, b])
    expect(finding?.code).toBe('FND_VACUITY')
    expect(finding?.requirementId).toBe('REQ-B')
    expect(finding?.severity).toBe('warn')
    expect(finding?.confidence).toBe('low')
  })

  it('does NOT flag a guard that is merely satisfiable-in-isolation (AC-4-5)', async () => {
    const ctx = await getContext('vacuity-miss')
    const a = encode(
      view({
        id: 'REQ-A',
        patternType: 'ubiquitous',
        systemResponse: 'maintenance mode is enabled',
        negated: true,
      }),
      kindAgnostic,
    )
    // C's guard `user is logged in` is contradicted by nothing → reachable → SAT.
    const c = encode(
      view({
        id: 'REQ-C',
        patternType: 'state-driven',
        preCondition: 'user is logged in',
        systemResponse: 'show the dashboard',
      }),
      kindAgnostic,
    )
    const finding = await checkVacuityOf(ctx, c, [a, c])
    expect(finding).toBeUndefined()
  })

  it('does NOT flag a lone guard checked in isolation (AC-4-5: NOT "unsat guard")', async () => {
    // The trap AC-4-5 forbids: implementing vacuity as "is the guard unsat?".
    // A guard is a conjunction of DISTINCT atoms, so in isolation (no other
    // requirement bodies asserted) it is ALWAYS satisfiable and must never be
    // flagged. Checking the requirement against a spec containing only itself
    // proves the finding is relational, driven by OTHER requirements, not by the
    // guard alone.
    const ctx = await getContext('vacuity-lone-guard')
    const b = encode(
      view({
        id: 'REQ-LONE',
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemResponse: 'flush the cache',
      }),
      kindAgnostic,
    )
    const finding = await checkVacuityOf(ctx, b, [b])
    expect(finding).toBeUndefined()
  })

  it('never treats a ubiquitous (guardless) requirement as a vacuity candidate', async () => {
    const ctx = await getContext('vacuity-ubiquitous')
    const u = encode(
      view({ id: 'REQ-U', patternType: 'ubiquitous', systemResponse: 'record an audit entry' }),
      kindAgnostic,
    )
    const finding = await checkVacuityOf(ctx, u, [u])
    expect(finding).toBeUndefined()
  })
})

describe('checkVacuity — whole-spec sweep (AC-4-5)', () => {
  it('returns exactly the vacuous requirement across the spec', async () => {
    const ctx = await getContext('vacuity-sweep')
    const a = encode(
      view({
        id: 'REQ-A',
        patternType: 'ubiquitous',
        systemResponse: 'maintenance mode is enabled',
        negated: true,
      }),
      kindAgnostic,
    )
    const b = encode(
      view({
        id: 'REQ-B',
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemResponse: 'flush the cache',
      }),
      kindAgnostic,
    )
    const c = encode(
      view({
        id: 'REQ-C',
        patternType: 'state-driven',
        preCondition: 'user is logged in',
        systemResponse: 'show the dashboard',
      }),
      kindAgnostic,
    )
    const findings = await checkVacuity(ctx, [a, b, c])
    expect(findings.map((f) => f.requirementId)).toEqual(['REQ-B'])
  })
})
