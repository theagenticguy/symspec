import { describe, expect, it } from 'vitest'
import { findContradictions } from '../../../formal/contradiction.js'
import type { EncodableRequirement } from '../../../formal/encode.js'
import type { CandidatePair, ReqView } from '../../types.js'
import { emitCandidatePairs } from '../pairwise-filter.js'

const view = (overrides: Partial<ReqView> = {}): ReqView => ({
  id: overrides.id ?? 'req-1',
  patternType: overrides.patternType ?? 'event-driven',
  preCondition: overrides.preCondition,
  // `'trigger' in overrides` (rather than `??`) so a test can explicitly clear
  // the default trigger by passing `trigger: undefined`.
  trigger: 'trigger' in overrides ? overrides.trigger : 'the user submits credentials',
  systemName: overrides.systemName ?? 'auth service',
  systemResponse: overrides.systemResponse ?? 'issue a session token',
  sentence:
    overrides.sentence ??
    'When the user submits credentials, the auth service shall issue a session token.',
  priority: overrides.priority ?? 'medium',
  status: overrides.status ?? 'draft',
})

const pairFor = (pairs: CandidatePair[], a: string, b: string): CandidatePair | undefined =>
  pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))

describe('emitCandidatePairs — AC-3-4 (candidate generator for subsumption/redundancy only)', () => {
  it('Rule 1: same system + same trigger + different response → candidate with the correct reason', () => {
    const reqs = [
      view({
        id: 'A',
        trigger: 'the user submits credentials',
        systemResponse: 'issue a session token',
      }),
      view({
        id: 'B',
        trigger: 'the user submits credentials',
        systemResponse: 'create a login token',
      }),
    ]
    const pairs = emitCandidatePairs(reqs)
    const p = pairFor(pairs, 'A', 'B')
    expect(p).toBeDefined()
    expect(p?.reason).toBe('same-system-same-trigger-different-response')
  })

  it('Rule 2: same system + overlapping precondition → candidate with the correct reason', () => {
    const reqs = [
      view({
        id: 'A',
        trigger: undefined,
        preCondition: 'the account is active',
        systemResponse: 'allow login',
        sentence: 'While the account is active, the auth service shall allow login.',
      }),
      view({
        id: 'B',
        trigger: undefined,
        preCondition: 'the account is active and verified',
        systemResponse: 'grant elevated access',
        sentence:
          'While the account is active and verified, the auth service shall grant elevated access.',
      }),
    ]
    const pairs = emitCandidatePairs(reqs)
    const p = pairFor(pairs, 'A', 'B')
    expect(p).toBeDefined()
    expect(p?.reason).toBe('same-system-overlapping-precondition')
  })

  it('Rule 3: high lexical similarity (Jaccard ≥ 0.7) on the sentence → near-duplicate candidate', () => {
    // Distinct triggers (rule 1 does not fire) and no precondition on either
    // side (rule 2 does not fire) — only the near-duplicate sentence overlap
    // should classify this pair.
    const reqs = [
      view({
        id: 'A',
        trigger: 'a payment fails',
        systemName: 'billing service',
        systemResponse: 'retry the failed payment up to three times',
        sentence:
          'When a payment fails, the billing service shall retry the failed payment up to three times.',
      }),
      view({
        id: 'B',
        trigger: 'a payment fails immediately',
        systemName: 'billing service',
        systemResponse: 'retry the failed payment up to three times',
        sentence:
          'When a payment fails immediately, the billing service shall retry the failed payment up to three times.',
      }),
    ]
    const pairs = emitCandidatePairs(reqs)
    const p = pairFor(pairs, 'A', 'B')
    expect(p).toBeDefined()
    expect(p?.reason).toBe('near-duplicate-sentence')
  })

  it('excludes a pair that detectExactDuplicates already caught as an exact duplicate', () => {
    // Full slot tuple matches exactly → detectExactDuplicates reports this pair;
    // the pairwise filter must NOT re-emit it as a candidate under any rule
    // (Rule 1 requires a different response so it would not fire anyway, but
    // Rule 3's high-similarity path would otherwise catch an exact restatement).
    const reqs = [view({ id: 'A' }), view({ id: 'B' })]
    const pairs = emitCandidatePairs(reqs)
    expect(pairFor(pairs, 'A', 'B')).toBeUndefined()
  })

  it('does not emit a pair across different systemNames', () => {
    const reqs = [
      view({ id: 'A', systemName: 'auth service' }),
      view({ id: 'B', systemName: 'billing service', systemResponse: 'issue a receipt' }),
    ]
    expect(emitCandidatePairs(reqs)).toEqual([])
  })

  it('never emits a duplicate pair across multiple matching rules', () => {
    // Same trigger + different response (Rule 1) AND highly similar sentence
    // (Rule 3) both apply — only one CandidatePair should be emitted for the pair.
    const reqs = [
      view({
        id: 'A',
        trigger: 'the user submits credentials',
        systemResponse: 'issue a session token',
        sentence:
          'When the user submits credentials, the auth service shall issue a session token.',
      }),
      view({
        id: 'B',
        trigger: 'the user submits credentials',
        systemResponse: 'issue a login token',
        sentence: 'When the user submits credentials, the auth service shall issue a login token.',
      }),
    ]
    const pairs = emitCandidatePairs(reqs)
    const matches = pairs.filter(
      (p) => (p.a === 'A' && p.b === 'B') || (p.a === 'B' && p.b === 'A'),
    )
    expect(matches).toHaveLength(1)
  })

  it('respects a custom similarityThreshold override', () => {
    const reqs = [
      view({
        id: 'A',
        trigger: undefined,
        systemResponse: 'log the request',
        sentence: 'The gateway shall log the request for audit purposes across every region.',
      }),
      view({
        id: 'B',
        trigger: undefined,
        systemResponse: 'record the transaction',
        sentence: 'The gateway shall record the transaction for audit purposes in some regions.',
      }),
    ]
    const loose = emitCandidatePairs(reqs, { similarityThreshold: 0.1 })
    expect(pairFor(loose, 'A', 'B')).toBeDefined()
    const strict = emitCandidatePairs(reqs, { similarityThreshold: 0.99 })
    expect(pairFor(strict, 'A', 'B')).toBeUndefined()
  })
})

describe('emitCandidatePairs — AC-3-4 boundary (contradiction fires on a NON-candidate pair)', () => {
  it('a pair the pairwise filter does NOT flag can still be caught by whole-spec contradiction detection', async () => {
    // UBI has no trigger/preCondition and a sentence with near-zero lexical
    // overlap with EVT's sentence, so none of the three pairwise rules fire —
    // this pair is absent from emitCandidatePairs' output. Yet both requirements
    // resolve to the SAME response atom with opposite polarity, and EVT's
    // trigger-group reachability check includes UBI's whole-spec formula
    // (AC-4-3), so findContradictions must still report the conflict.
    const ubi: ReqView = view({
      id: 'UBI',
      patternType: 'ubiquitous',
      trigger: undefined,
      preCondition: undefined,
      systemResponse: 'issue a session token',
      sentence:
        'The gateway must decline any request that arrives outside the approved maintenance window, full stop, no exceptions granted to any caller regardless of internal priority level assigned.',
    })
    const evt: ReqView = view({
      id: 'EVT',
      patternType: 'event-driven',
      trigger: 'the customer clicks the checkout button after verifying their shipping address',
      preCondition: undefined,
      systemResponse: 'issue a session token',
      sentence:
        'Whenever a customer clicks the checkout button after verifying their shipping address, the gateway shall issue a session token so the payment step can proceed without re-authentication.',
    })

    const pairs = emitCandidatePairs([ubi, evt])
    expect(pairFor(pairs, 'UBI', 'EVT')).toBeUndefined()

    const encodable: EncodableRequirement[] = [
      { ...ubi, negated: true },
      { ...evt, negated: false },
    ]
    const findings = await findContradictions(encodable)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.requirementIds).toEqual(['EVT', 'UBI'])
  })
})
