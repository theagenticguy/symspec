import { describe, expect, it } from 'vitest'
import type { CandidatePair } from '../../solvers/types.js'
import { getContext } from '../backend.js'
import { type Atomize, type AtomLit, type EncodableRequirement, encode } from '../encode.js'
import { checkSubsumption, checkSubsumptionPair, type SubsumptionFinding } from '../subsumption.js'

/**
 * Kind-scoped fake atomizer (matches the real AC-4-2a shape), so atom names read
 * like production and identical slot text unifies to one atom. The subsumption
 * checks are atomizer-agnostic; this stand-in only has to be deterministic.
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

const view = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

/** A broad event-driven req `X ⇒ Y` and a narrow complex req `(P ∧ X) ⇒ Y`. */
const general = (id: string) =>
  encode(
    view({
      id,
      patternType: 'event-driven',
      trigger: 'the user submits valid credentials',
      systemResponse: 'issue a session token',
    }),
    fakeAtomize,
  )

const specific = (id: string) =>
  encode(
    view({
      id,
      patternType: 'event-driven', // complex → event-driven mapping (Tier 1)
      preCondition: 'maintenance mode is off',
      trigger: 'the user submits valid credentials',
      systemResponse: 'issue a session token',
    }),
    fakeAtomize,
  )

describe('subsumption — direction is pinned by id, never positional (whichOf trap, AC-4-5)', () => {
  it('assigns moreGeneral/moreSpecific from the valid implication direction', async () => {
    const ctx = await getContext('subsumption-direction')
    const g = general('REQ-GENERAL')
    const s = specific('REQ-SPECIFIC')
    const result = await checkSubsumptionPair(ctx, g, s)
    expect(result?.code).toBe('FND_SUBSUMPTION')
    const f = result as SubsumptionFinding
    expect(f.moreGeneral).toBe('REQ-GENERAL')
    expect(f.moreSpecific).toBe('REQ-SPECIFIC')
  })

  it('DEFEATS the v1 whichOf trap: general req in the `a` slot still maps to moreGeneral', async () => {
    // The pair is (a = general, b = specific). A positional assignment that says
    // "moreGeneral = a" would pass this by luck — so the sibling test below puts
    // general in the `b` slot, where positional assignment is provably wrong.
    const ctx = await getContext('subsumption-a-slot')
    const g = general('REQ-A-IS-GENERAL')
    const s = specific('REQ-B-IS-SPECIFIC')
    const f = (await checkSubsumptionPair(ctx, g, s)) as SubsumptionFinding
    expect(f.moreGeneral).toBe('REQ-A-IS-GENERAL')
    expect(f.moreSpecific).toBe('REQ-B-IS-SPECIFIC')
  })

  it('DEFEATS the v1 whichOf trap: general req in the `b` slot still maps to moreGeneral', async () => {
    // pair.a = specific, pair.b = general. A positional "moreGeneral = a" (the v1
    // whichOf bug) would wrongly name the specific requirement general. The
    // direction must come from the SMT implication, mapped back by id.
    const ctx = await getContext('subsumption-b-slot')
    const s = specific('REQ-A-IS-SPECIFIC')
    const g = general('REQ-B-IS-GENERAL')
    const f = (await checkSubsumptionPair(ctx, s, g)) as SubsumptionFinding
    expect(f.code).toBe('FND_SUBSUMPTION')
    expect(f.moreGeneral).toBe('REQ-B-IS-GENERAL')
    expect(f.moreSpecific).toBe('REQ-A-IS-SPECIFIC')
    // requirementIds preserve the pair's [a, b] order for stable reporting.
    expect(f.requirementIds).toEqual(['REQ-A-IS-SPECIFIC', 'REQ-B-IS-GENERAL'])
  })
})

describe('subsumption — redundancy on bi-implication (AC-4-5)', () => {
  it('bi-implication emits FND_REDUNDANCY, not FND_SUBSUMPTION', async () => {
    const ctx = await getContext('subsumption-redundancy')
    // Two requirements that encode to logically-equivalent bodies (identical
    // trigger + identical response ⇒ identical `T ⇒ R`).
    const a = general('REQ-DUP-1')
    const b = general('REQ-DUP-2')
    const result = await checkSubsumptionPair(ctx, a, b)
    expect(result?.code).toBe('FND_REDUNDANCY')
    expect(result?.requirementIds).toEqual(['REQ-DUP-1', 'REQ-DUP-2'])
    // A redundancy finding must NOT carry moreGeneral/moreSpecific.
    expect(result && 'moreGeneral' in result).toBe(false)
  })
})

describe('subsumption — no finding when neither direction is valid (AC-4-5)', () => {
  it('two unrelated requirements yield no subsumption/redundancy', async () => {
    const ctx = await getContext('subsumption-unrelated')
    const a = general('REQ-X')
    const b = encode(
      view({
        id: 'REQ-Y',
        patternType: 'event-driven',
        trigger: 'a token expires',
        systemResponse: 'revoke the session',
      }),
      fakeAtomize,
    )
    const result = await checkSubsumptionPair(ctx, a, b)
    expect(result).toBeUndefined()
  })
})

describe('checkSubsumption — drives over candidate pairs only (AC-3-4 → AC-4-5)', () => {
  it('reports subsumption for a candidate pair and skips gate-excluded ids', async () => {
    const ctx = await getContext('subsumption-batch')
    const g = general('REQ-G')
    const s = specific('REQ-S')
    const encodedById = new Map([
      [g.id, g],
      [s.id, s],
    ])
    const pairs: CandidatePair[] = [
      { a: 'REQ-S', b: 'REQ-G', reason: 'same-system-overlapping-precondition' },
      // A pair naming an id absent from the map (excluded by the AC-3-7 gate) is
      // silently skipped, never a crash.
      { a: 'REQ-G', b: 'REQ-EXCLUDED', reason: 'near-duplicate-sentence' },
    ]
    const findings = await checkSubsumption(ctx, encodedById, pairs)
    expect(findings).toHaveLength(1)
    const f = findings[0] as SubsumptionFinding
    expect(f.code).toBe('FND_SUBSUMPTION')
    // Direction resolved by id even though general is in the `b` slot.
    expect(f.moreGeneral).toBe('REQ-G')
    expect(f.moreSpecific).toBe('REQ-S')
  })
})
