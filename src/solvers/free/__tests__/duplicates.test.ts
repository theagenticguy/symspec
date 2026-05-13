import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../types.js'
import { detectAmbiguity } from '../ambiguity.js'
import { detectExactDuplicates } from '../duplicates.js'

const view = (overrides: Partial<ReqView> = {}): ReqView => ({
  id: overrides.id ?? 'req-1',
  patternType: overrides.patternType ?? 'event-driven',
  preCondition: overrides.preCondition,
  trigger: overrides.trigger ?? 'the user submits credentials',
  systemName: overrides.systemName ?? 'auth service',
  systemResponse: overrides.systemResponse ?? 'issue a session token',
  sentence:
    overrides.sentence ??
    'When the user submits credentials, the auth service shall issue a session token.',
  priority: overrides.priority ?? 'medium',
  status: overrides.status ?? 'draft',
})

describe('detectExactDuplicates', () => {
  it('returns no findings for an empty list', () => {
    expect(detectExactDuplicates([])).toEqual([])
  })

  it('returns no findings when no two reqs share the full slot tuple', () => {
    const findings = detectExactDuplicates([
      view({ id: 'a', systemResponse: 'issue a token' }),
      view({ id: 'b', systemResponse: 'log the attempt' }),
    ])
    expect(findings).toEqual([])
  })

  it('emits one ExactDuplicate finding per pair within a duplicate group', () => {
    const findings = detectExactDuplicates([
      view({ id: 'a' }),
      view({ id: 'b' }),
      view({ id: 'c' }),
    ])
    // 3 reqs in one group → 3 pairs
    expect(findings).toHaveLength(3)
    expect(findings.every((f) => f.kind === 'ExactDuplicate')).toBe(true)
    expect(findings.every((f) => f.confidence === 'high')).toBe(true)
  })

  it('treats a different preCondition as a different requirement', () => {
    const findings = detectExactDuplicates([
      view({ id: 'a', preCondition: 'maintenance mode is off' }),
      view({ id: 'b', preCondition: 'maintenance mode is on' }),
    ])
    expect(findings).toEqual([])
  })
})

describe('detectAmbiguity', () => {
  it('flags a weasel word in the systemResponse', () => {
    const findings = detectAmbiguity([
      view({
        id: 'a',
        systemResponse: 'respond fast',
        sentence: 'When ..., the auth service shall respond fast.',
      }),
    ])
    expect(findings).toHaveLength(1)
    const f = findings[0]
    if (f && f.kind === 'Ambiguity') {
      expect(f.phrases).toContain('fast')
      expect(f.suggestedRewrites).toBeDefined()
    }
  })

  it('does not flag a clean requirement', () => {
    expect(
      detectAmbiguity([
        view({
          id: 'a',
          systemResponse: 'return a 200 response within 200 ms',
        }),
      ]),
    ).toEqual([])
  })

  it('respects word boundaries — does not flag "many" inside "Germany"', () => {
    expect(
      detectAmbiguity([
        view({
          id: 'a',
          systemResponse: 'route the request to the Germany region',
        }),
      ]),
    ).toEqual([])
  })
})
