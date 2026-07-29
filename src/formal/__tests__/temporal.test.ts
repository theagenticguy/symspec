/**
 * AC-33-2: bounded LTL→SMT temporal contradiction detection on real Z3-WASM.
 * A response obligation `G(T → F R)` with a co-triggered absence `G(T → ¬R)` and
 * T asserted is temporally unsatisfiable; a consistent set is not flagged.
 *
 * Plus the AC-2-6 soundness regressions. The eventuality lowerings used to
 * collapse at the horizon (`F φ` → `φ@k`, `X φ` → `false`, `φ U ψ` → `ψ@k`),
 * which `G` instantiates at EVERY step, so bounded `unsat` stopped implying a
 * real conflict and the tier emitted false positives at `error` severity /
 * exit 1. Those cases live in the `AC-2-6` describe block below.
 *
 * Why they need their own tests: the existing suites cannot catch this class of
 * bug. The headline fixture builds `G(T ∧ ¬R)` by HAND (T true at every step),
 * and the adversarial generator uses a global absence `G(¬R)` — both are genuine
 * conflicts, so they stay `unsat` under a broken lowering AND a correct one. A
 * horizon-induced false positive is only visible on a set that is genuinely
 * LTL-SATISFIABLE while the truncated encoding calls it `unsat`, which is
 * exactly what these tests assert.
 */

import { describe, expect, it } from 'vitest'
import { renderSentence } from '../../core/render.js'
import type { EarsPattern, Requirement } from '../../core/schema.js'
import type { ReqView } from '../../solvers/types.js'
import { makeAtomize } from '../atomize.js'
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
  U,
  X,
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
    // AC-2-7: mechanical — `earsToTemporal` now takes the shared atomizer.
    expect(() => earsToTemporal(reqA, makeAtomize())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC-2-6: the horizon must not force an eventuality (no false positives)
// ---------------------------------------------------------------------------

describe('AC-2-6 — an eventuality at the horizon must not manufacture a contradiction', () => {
  const a = tAtom('a')
  const b = tAtom('b')
  const p = tAtom('p')
  const q = tAtom('q')

  /**
   * The V18 reproducer, in three REAL EARS shapes `earsToTemporal` emits:
   *   R1 event-driven      G(a → F b)   "WHEN a the system SHALL eventually b"
   *   R2 unwanted-behavior G(a → ¬b)    "WHEN a the system SHALL NOT b"
   *   R3 event-driven      G(b → F a)   "WHEN b the system SHALL eventually a"
   *
   * LTL-SATISFIABLE by the period-2 lasso {a,¬b} → {¬a,b} ↺ (verified against an
   * independent lasso oracle). R3 is what makes three requirements necessary: it
   * forces `b` reachable too, so the solver cannot dodge by keeping `b` false.
   *
   * Measured `unsat` — an error-severity FALSE POSITIVE, exit 1 — at k=2,4,8,12
   * before AC-2-6, because `F b` instantiated at t=k collapsed to `b@k` while
   * `G(a → ¬b)` plus reachability forced `¬b@k`.
   */
  const reproducer = [
    { id: 'R1', formula: G(tImplies(a, F(b))) },
    { id: 'R2', formula: G(tImplies(a, tNot(b))) },
    { id: 'R3', formula: G(tImplies(b, F(a))) },
  ]

  it.each([
    2, 4, 8, 12,
  ])('does NOT flag the LTL-satisfiable 3-requirement lasso at k=%i', async (k) => {
    const ctx = await getContext(`ac26-repro-${k}`)
    expect(await findTemporalContradictions(ctx, reproducer, k)).toEqual([])
  })

  it('does NOT flag it at the default bound either (the shipped code path)', async () => {
    const ctx = await getContext('ac26-repro-default')
    expect(await findTemporalContradictions(ctx, reproducer)).toEqual([])
  })

  it.each([2, 5])('does NOT flag an X obligation at the horizon (k=%i)', async (k) => {
    // G(a → X b): whenever `a`, `b` at the NEXT step. With `a` reachable this is
    // satisfiable — `b` simply happens one step later, possibly past the horizon.
    // `X` at t=k used to lower to literal `false`, forcing ¬a@k and, with the
    // reachability premise, a spurious `unsat`.
    const ctx = await getContext(`ac26-x-${k}`)
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'X1', formula: G(tImplies(a, X(b))) },
        { id: 'X2', formula: G(tImplies(a, a)) },
      ],
      k,
    )
    expect(findings).toEqual([])
  })

  it.each([2, 5])('does NOT flag a U obligation at the horizon (k=%i)', async (k) => {
    // G(a → (p U q)) with G(a → ¬q): `q` may first hold after `a` clears, so the
    // set is satisfiable. `φ U ψ` at t=k used to collapse to ψ@k, forcing q@k
    // against ¬q@k.
    const ctx = await getContext(`ac26-u-${k}`)
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'U1', formula: G(tImplies(a, U(p, q))) },
        { id: 'U2', formula: G(tImplies(a, tNot(q))) },
      ],
      k,
    )
    expect(findings).toEqual([])
  })

  it.each([
    3, 6,
  ])('gives each eventuality its OWN tail step, never a shared one (k=%i)', async (k) => {
    // G(t → F r) + G(c → F d) + G(¬(r ∧ d)). Satisfiable: `r` and `d` just have
    // to happen at DIFFERENT steps. A single tail index shared between the two
    // pendings forces both at the same step and returns `unsat` — the measured
    // unsoundness that makes per-eventuality tails mandatory.
    const ctx = await getContext(`ac26-tails-${k}`)
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'S1', formula: G(tImplies(tAtom('tt'), F(tAtom('rr')))) },
        { id: 'S2', formula: G(tImplies(tAtom('cc'), F(tAtom('dd')))) },
        { id: 'S3', formula: G(tNot(tAnd2(tAtom('rr'), tAtom('dd')))) },
      ],
      k,
    )
    expect(findings).toEqual([])
  })

  it.each([5, 8])('STILL proves the real response-vs-global-absence conflict (k=%i)', async (k) => {
    // The shape the adversarial red-team generator emits: G(T → F R) vs a GLOBAL
    // absence G(¬R). The pending escape hatch must not silence it — the tail
    // asserts `pend → R@τ` and (from the global body) `pend → ¬R@τ`, forcing
    // `pend` false and collapsing back to the bounded encoding. Recall guard.
    const ctx = await getContext(`ac26-recall-${k}`)
    const t = tAtom('sys__c__trig__t')
    const r = tAtom('sys__c__resp__r')
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'A', formula: G(tImplies(t, F(r))) },
        { id: 'B', formula: G(tNot(r)) },
      ],
      k,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_TEMPORAL_CONTRADICTION')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
  })

  it('keeps the finding message honest about bound-dependence', async () => {
    // The pre-AC-2-6 message claimed the contradiction was "not bound-dependent
    // to refute", which the horizon bug falsified. The verdict IS relative to the
    // reachability premise (every guarded trigger occurs within k steps), so the
    // message must say so and must not re-assert the old absolute claim.
    const ctx = await getContext('ac26-message')
    const t = tAtom('sys__c__trig__t')
    const r = tAtom('sys__c__resp__r')
    const findings = await findTemporalContradictions(
      ctx,
      [
        { id: 'A', formula: G(tImplies(t, F(r))) },
        { id: 'B', formula: G(tNot(r)) },
      ],
      6,
    )
    expect(findings).toHaveLength(1)
    const { message } = findings[0]!
    expect(message).not.toContain('not bound-dependent')
    expect(message).toContain('k=6')
    expect(message).toMatch(/within 6 steps/)
  })

  it.each([
    ['F under G', G(tImplies(tAtom('a'), F(tAtom('b'))))],
    ['X under G', G(tImplies(tAtom('a'), X(tAtom('b'))))],
    ['U under G', G(tImplies(tAtom('a'), U(tAtom('p'), tAtom('q'))))],
  ])('lowers %s deterministically — fresh symbols are content-addressed, not counted', async (_label, formula) => {
    // The pending/tail scheme mints fresh Bools. Naming them from a mutable
    // counter or nonce would make `lowerAt` non-deterministic and break the
    // repo's determinism contract, so this pins two calls to identical output.
    const ctx = await getContext('ac26-determinism')
    expect(lowerAt(ctx, formula, 0, 4).toString()).toBe(lowerAt(ctx, formula, 0, 4).toString())
  })
})
