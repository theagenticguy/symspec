/**
 * AC-33-2: bounded LTL→SMT temporal contradiction detection on real Z3-WASM.
 * A response obligation `G(T → F R)` with a co-triggered absence `G(T → ¬R)` and
 * T asserted is temporally unsatisfiable; a consistent set is not flagged.
 */

import { describe, expect, it } from 'vitest'
import { renderSentence } from '../../core/render.js'
import type { EarsPattern, Requirement } from '../../core/schema.js'
import type { ReqView } from '../../solvers/types.js'
import { getContext } from '../backend.js'
import { findTemporalContradictions, lowerAt } from '../temporal.js'
import {
  earsToTemporal,
  F,
  G,
  type TemporalFormula,
  tAnd,
  tAtom,
  tImplies,
  tNot,
} from '../temporal-patterns.js'

/** 2-arg `and` convenience over the arity-collapsing tAnd. */
function tAnd2(a: TemporalFormula, b: TemporalFormula): TemporalFormula {
  return tAnd([a, b])
}

function view(
  id: string,
  patternType: EarsPattern,
  systemName: string,
  systemResponse: string,
  extras: Partial<Pick<Requirement, 'trigger' | 'preCondition' | 'negated'>> = {},
): ReqView {
  const base: Requirement = {
    id,
    patternType,
    systemName,
    systemResponse,
    negated: extras.negated ?? false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    ...(extras.trigger !== undefined ? { trigger: extras.trigger } : {}),
    ...(extras.preCondition !== undefined ? { preCondition: extras.preCondition } : {}),
  }
  base.sentence = renderSentence(base)
  return base
}

describe('findTemporalContradictions (AC-33-2)', () => {
  it('flags a response-vs-absence temporal contradiction, naming both ids', async () => {
    const ctx = await getContext('temporal-test-1')
    // R-A: always, if trigger then eventually response  → G(T → F R)
    // R-B: always, trigger holds and response never     → G(T ∧ ¬R)
    // Together, T holds every step while R never can — F R is unsatisfiable.
    const t = tAtom('sys__c__trig__t')
    const r = tAtom('sys__c__resp__r')
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'A', formula: G(tImplies(t, F(r))) },
        { id: 'B', formula: G(tAnd2(t, tNot(r))) },
      ],
      8,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_TEMPORAL_CONTRADICTION')
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.evidence.temporal?.bound).toBe(8)
    expect(findings[0]!.evidence.temporal?.complete).toBe(false)
  })

  it('does NOT flag a temporally-consistent set', async () => {
    const ctx = await getContext('temporal-test-2')
    const t = tAtom('sys__c__trig__t')
    const r = tAtom('sys__c__resp__r')
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'A', formula: G(tImplies(t, F(r))) },
        { id: 'B', formula: G(tImplies(t, F(r))) },
      ],
      8,
    )
    expect(findings).toEqual([])
  })

  it('lowers G to a per-step conjunction (deterministic)', async () => {
    const ctx = await getContext('temporal-test-4')
    const f = G(tAtom('p'))
    const one = lowerAt(ctx, f, 0, 3).toString()
    const two = lowerAt(ctx, f, 0, 3).toString()
    expect(one).toBe(two)
  })

  it('maps EARS requirements via earsToTemporal without throwing', () => {
    const reqA = view('A', 'event-driven', 'controller', 'open the relief valve', {
      trigger: 'the sensor reports overheat',
    })
    expect(() => earsToTemporal(reqA)).not.toThrow()
  })
})
