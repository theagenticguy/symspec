import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../solvers/types.js'
import { findSimilarUnunified, type SimilarityRequirement } from '../similar.js'

const view = (overrides: Partial<ReqView> & { negated?: boolean } = {}): SimilarityRequirement => {
  const base: ReqView = {
    id: overrides.id ?? 'req-1',
    patternType: overrides.patternType ?? 'event-driven',
    preCondition: overrides.preCondition,
    trigger: 'trigger' in overrides ? overrides.trigger : 'a payment fails',
    systemName: overrides.systemName ?? 'billing service',
    systemResponse: overrides.systemResponse ?? 'log the payment failure for audit purposes',
    sentence:
      overrides.sentence ??
      'When a payment fails, the billing service shall log the payment failure for audit purposes.',
    negated: overrides.negated ?? false,
    priority: overrides.priority ?? 'medium',
    status: overrides.status ?? 'draft',
  }
  return base
}

describe('findSimilarUnunified — reuse Rule 3 Jaccard as an info reporter (AC-4-12)', () => {
  it('flags a near-synonym pair whose responses do NOT auto-unify', () => {
    const a = view({
      id: 'A',
      trigger: 'a payment fails during checkout',
      systemResponse: 'log the payment failure for audit purposes across every region',
      sentence:
        'When a payment fails during checkout, the billing service shall log the payment failure for audit purposes across every region.',
    })
    const b = view({
      id: 'B',
      trigger: 'a payment fails during retry',
      systemResponse: 'record the payment failure for audit purposes across every region',
      sentence:
        'When a payment fails during retry, the billing service shall record the payment failure for audit purposes across every region.',
    })

    const findings = findSimilarUnunified([a, b])
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f?.code).toBe('FND_SIMILAR_UNUNIFIED')
    expect(f?.severity).toBe('info')
    expect(f?.requirementIds).toEqual(['A', 'B'])
    expect(f?.message).toContain('A')
    expect(f?.message).toContain('B')
    // Suggests a real command path, not the phantom `symspec atoms merge` (MD1).
    expect(f?.message).toContain('symspec update')
    expect(f?.message).not.toContain('atoms merge')
  })

  it('does not fire when the two responses are identical (auto-unified, same atom)', () => {
    const a = view({
      id: 'A',
      trigger: 'a payment fails during checkout',
      systemResponse: 'log the payment failure for audit purposes across every region',
      sentence:
        'When a payment fails during checkout, the billing service shall log the payment failure for audit purposes across every region.',
    })
    const b = view({
      id: 'B',
      trigger: 'a payment fails during retry',
      systemResponse: 'log the payment failure for audit purposes across every region',
      sentence:
        'When a payment fails during retry, the billing service shall log the payment failure for audit purposes across every region.',
    })

    expect(findSimilarUnunified([a, b])).toEqual([])
  })

  it('does not fire when the two responses unify via the seed antonym table (grant/revoke)', () => {
    // Antonym-table hit ⇒ same atom, opposite polarity ⇒ a DESIGNED unification,
    // not a miss — this must not be reported as similar-but-not-unified.
    const a = view({
      id: 'A',
      trigger: 'the incident begins',
      systemResponse: 'grant emergency access to the support team for the incident window',
      sentence:
        'When the incident begins, the billing service shall grant emergency access to the support team for the incident window.',
    })
    const b = view({
      id: 'B',
      trigger: 'the incident ends',
      systemResponse: 'revoke emergency access to the support team for the incident window',
      sentence:
        'When the incident ends, the billing service shall revoke emergency access to the support team for the incident window.',
    })

    expect(findSimilarUnunified([a, b])).toEqual([])
  })

  it('does not fire on a pair below the similarity threshold', () => {
    const a = view({
      id: 'A',
      trigger: 'the user logs in',
      systemResponse: 'issue a session token',
      sentence: 'When the user logs in, the billing service shall issue a session token.',
    })
    const b = view({
      id: 'B',
      trigger: 'a refund is requested',
      systemResponse: 'notify the finance team',
      sentence: 'When a refund is requested, the billing service shall notify the finance team.',
    })

    expect(findSimilarUnunified([a, b])).toEqual([])
  })

  it('does not fire on an exact-duplicate pair (excluded upstream by the candidate filter)', () => {
    const a = view({ id: 'A' })
    const b = view({ id: 'B' })
    expect(findSimilarUnunified([a, b])).toEqual([])
  })

  it('ignores Rule 1 (same-trigger-different-response) and Rule 2 (overlapping-precondition) candidates', () => {
    // Same trigger, different (and lexically DISSIMILAR) response → Rule 1 only.
    const a = view({
      id: 'A',
      trigger: 'the user submits credentials',
      systemResponse: 'issue a session token',
      sentence:
        'When the user submits credentials, the billing service shall issue a session token.',
    })
    const b = view({
      id: 'B',
      trigger: 'the user submits credentials',
      systemResponse: 'send a welcome email',
      sentence:
        'When the user submits credentials, the billing service shall send a welcome email.',
    })
    expect(findSimilarUnunified([a, b])).toEqual([])
  })

  it('respects a custom similarityThreshold and forwards it into the message', () => {
    const a = view({
      id: 'A',
      trigger: undefined,
      systemResponse: 'log the request',
      sentence: 'The gateway shall log the request for audit purposes across every region.',
    })
    const b = view({
      id: 'B',
      trigger: undefined,
      systemResponse: 'record the transaction',
      sentence: 'The gateway shall record the transaction for audit purposes in some regions.',
    })

    expect(findSimilarUnunified([a, b])).toEqual([])
    const loose = findSimilarUnunified([a, b], { similarityThreshold: 0.1 })
    expect(loose).toHaveLength(1)
    expect(loose[0]?.message).toContain('0.1')
  })
})
