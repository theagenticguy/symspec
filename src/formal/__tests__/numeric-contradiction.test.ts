/**
 * AC-30-3: numeric contradiction detection over LIA/LRA via real Z3-WASM.
 * Groups per-system quantity predicates and proves joint unsatisfiability,
 * naming the culprit ids from the minimal unsat core.
 */

import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import { extractNumericPredicates } from '../numeric.js'
import { findNumericContradictions, type RequirementPredicates } from '../numeric-contradiction.js'

/** Build a RequirementPredicates from a slot text under one system. */
function rp(id: string, text: string, system = 'api'): RequirementPredicates {
  return { id, predicates: extractNumericPredicates(text, system) }
}

describe('findNumericContradictions (AC-30-3)', () => {
  it('flags jointly-unsat bounds on the same quantity with both ids', async () => {
    const ctx = await getContext('num-test-1')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'keep temperature above 40'), // temp > 40
      rp('B', 'keep temperature below 30'), // temp < 30
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_NUMERIC_CONTRADICTION')
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.evidence.numeric?.label).toContain('temperature')
  })

  it('detects a conflict across mixed units (unit-normalized)', async () => {
    const ctx = await getContext('num-test-2')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'respond within 2 seconds'), // latency <= 2000 ms
      rp('B', 'respond over 3000 ms'), // latency > 3000 ms  → impossible together
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
  })

  it('does NOT flag satisfiable bounds on the same quantity', async () => {
    const ctx = await getContext('num-test-3')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'respond within 500 ms'), // latency <= 500
      rp('B', 'respond over 100 ms'), // latency > 100  → 100 < latency <= 500 is fine
    ])
    expect(findings).toEqual([])
  })

  it('does NOT flag bounds on DIFFERENT quantities', async () => {
    const ctx = await getContext('num-test-4')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'latency within 100 ms'),
      rp('B', 'retries at most 3'),
    ])
    expect(findings).toEqual([])
  })

  it('does NOT flag a cross-system same-label pair (per-system scoping)', async () => {
    const ctx = await getContext('num-test-5')
    const findings = await findNumericContradictions(ctx, [
      { id: 'A', predicates: extractNumericPredicates('temperature above 40', 'oven') },
      { id: 'B', predicates: extractNumericPredicates('temperature below 30', 'fridge') },
    ])
    expect(findings).toEqual([])
  })

  it('names only the minimal core when an innocent third shares the quantity', async () => {
    const ctx = await getContext('num-test-6')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'temperature above 40'), // > 40
      rp('B', 'temperature below 30'), // < 30  (A∧B already unsat)
      rp('C', 'temperature above 10'), // > 10  (innocent — consistent with either)
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
  })
})
