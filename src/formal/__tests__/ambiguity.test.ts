import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../solvers/types.js'
import { type AmbiguityFinding, detectAmbiguity } from '../ambiguity.js'

/**
 * Build a `ReqView` for the deterministic ambiguity tests. `sentence` is the
 * field every detector reads, so most tests set it explicitly; the structured
 * slots default to a clean, unambiguous baseline.
 */
const view = (overrides: Partial<ReqView> = {}): ReqView => ({
  id: overrides.id ?? 'req-1',
  patternType: overrides.patternType ?? 'event-driven',
  preCondition: overrides.preCondition,
  trigger: 'trigger' in overrides ? overrides.trigger : 'a payment fails',
  systemName: overrides.systemName ?? 'billing service',
  systemResponse: overrides.systemResponse ?? 'log the payment failure',
  sentence:
    overrides.sentence ??
    'When a payment fails, the billing service shall log the payment failure.',
  negated: overrides.negated ?? false,
  priority: overrides.priority ?? 'medium',
  status: overrides.status ?? 'draft',
})

const codesOf = (fs: AmbiguityFinding[]): string[] => fs.map((f) => f.code)

describe('detectAmbiguity — FND_AMBIGUOUS_VAGUE (AC-31-1)', () => {
  it('flags a known vague term with a correct char span + evidence', () => {
    const sentence = 'The system shall provide a fast response to every request.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const vague = findings.filter((f) => f.code === 'FND_AMBIGUOUS_VAGUE')
    expect(vague).toHaveLength(1)
    const f = vague[0]
    expect(f?.severity).toBe('info')
    expect(f?.requirementIds).toEqual(['R1'])
    expect(f?.evidence?.phrase).toBe('fast')
    // Span points exactly at "fast".
    expect(f?.span).toBeDefined()
    const [start, end] = f?.span ?? [-1, -1]
    expect(sentence.slice(start, end)).toBe('fast')
  })

  it('is silent on clean, measurable text', () => {
    const sentence = 'The system shall respond within 200 ms.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    expect(codesOf(findings)).not.toContain('FND_AMBIGUOUS_VAGUE')
  })

  it('does not match a vague term embedded in a larger word (word-boundary)', () => {
    // "breakfast" contains "fast" but must not fire.
    const sentence = 'The system shall log the breakfast order for auditing.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    expect(codesOf(findings)).not.toContain('FND_AMBIGUOUS_VAGUE')
  })

  it('reports a repeated vague term only once (deduplicated by phrase)', () => {
    const sentence = 'The service shall be robust and remain robust under load.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const vague = findings.filter((f) => f.code === 'FND_AMBIGUOUS_VAGUE')
    expect(vague).toHaveLength(1)
  })
})

describe('detectAmbiguity — FND_AMBIGUOUS_QUANTIFIER (AC-31-2)', () => {
  it('flags un-parenthesized and…or coordination as a WARN (verdict-eligible)', () => {
    const sentence = 'The system shall encrypt data and archive logs or purge records.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const q = findings.filter((f) => f.code === 'FND_AMBIGUOUS_QUANTIFIER')
    expect(q).toHaveLength(1)
    expect(q[0]?.severity).toBe('warn')
    expect(q[0]?.evidence?.pattern).toBe('and-or-coordination')
    const [start, end] = q[0]?.span ?? [-1, -1]
    expect(sentence.slice(start, end).toLowerCase()).toContain('and')
    expect(sentence.slice(start, end).toLowerCase()).toContain('or')
  })

  it('does NOT flag parenthesized (and)…or coordination — grouping disambiguates', () => {
    const sentence = 'The system shall (encrypt data and archive logs) or purge records.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const coord = findings.filter(
      (f) => f.code === 'FND_AMBIGUOUS_QUANTIFIER' && f.evidence?.pattern === 'and-or-coordination',
    )
    expect(coord).toHaveLength(0)
  })

  it('flags a leading universal + determiner as info', () => {
    const sentence = 'All the records shall be encrypted at rest.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const q = findings.filter(
      (f) => f.code === 'FND_AMBIGUOUS_QUANTIFIER' && f.evidence?.pattern === 'leading-universal',
    )
    expect(q).toHaveLength(1)
    expect(q[0]?.severity).toBe('info')
  })

  it('flags a bare plural subject of shall as info', () => {
    const sentence = 'Administrators shall approve every deployment request.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence, systemName: 'admin console' })])
    const q = findings.filter(
      (f) => f.code === 'FND_AMBIGUOUS_QUANTIFIER' && f.evidence?.pattern === 'bare-plural-subject',
    )
    expect(q).toHaveLength(1)
    expect(q[0]?.severity).toBe('info')
    const [start, end] = q[0]?.span ?? [-1, -1]
    expect(sentence.slice(start, end)).toBe('Administrators')
  })

  it('does NOT treat a determiner-scoped plural as bare ("The users shall")', () => {
    const sentence = 'The users shall receive a confirmation email.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    const q = findings.filter(
      (f) => f.code === 'FND_AMBIGUOUS_QUANTIFIER' && f.evidence?.pattern === 'bare-plural-subject',
    )
    expect(q).toHaveLength(0)
  })
})

describe('detectAmbiguity — FND_AMBIGUOUS_REFERENCE (AC-31-3)', () => {
  const twoSystems = () => [
    view({
      id: 'R1',
      systemName: 'billing service',
      sentence: 'When a payment fails, the billing service shall retry it three times.',
    }),
    view({
      id: 'R2',
      systemName: 'audit service',
      sentence: 'When a payment fails, the audit service shall record the failure.',
    }),
  ]

  it('flags a pronoun with ≥2 candidate antecedents, listing the candidates', () => {
    const findings = detectAmbiguity(twoSystems())
    const ref = findings.filter((f) => f.code === 'FND_AMBIGUOUS_REFERENCE')
    expect(ref).toHaveLength(1)
    const f = ref[0]
    expect(f?.severity).toBe('info')
    expect(f?.requirementIds).toEqual(['R1'])
    expect(f?.evidence?.reference).toBe('it')
    // Candidates are the distinct systems in scope, sorted.
    expect(f?.evidence?.candidates).toEqual(['audit service', 'billing service'])
  })

  it('flags a bare definite NP ("the system") when >1 system is in scope', () => {
    const reqs = [
      view({ id: 'R1', systemName: 'gateway', sentence: 'The system shall reject the request.' }),
      view({ id: 'R2', systemName: 'ledger', sentence: 'The ledger shall record the balance.' }),
    ]
    const findings = detectAmbiguity(reqs)
    const ref = findings.filter((f) => f.code === 'FND_AMBIGUOUS_REFERENCE')
    expect(ref.map((f) => f.requirementIds[0])).toContain('R1')
    const r1 = ref.find((f) => f.requirementIds[0] === 'R1')
    expect(r1?.evidence?.reference?.toLowerCase()).toBe('the system')
  })

  it('is silent when only a single system is in scope (no rival antecedent)', () => {
    const reqs = [
      view({
        id: 'R1',
        systemName: 'billing service',
        sentence: 'When a payment fails, the billing service shall retry it three times.',
      }),
      view({
        id: 'R2',
        systemName: 'billing service',
        sentence: 'When a refund posts, the billing service shall record it.',
      }),
    ]
    const findings = detectAmbiguity(reqs)
    expect(codesOf(findings)).not.toContain('FND_AMBIGUOUS_REFERENCE')
  })

  it('picks the earliest reference deterministically when several appear', () => {
    const reqs = [
      view({
        id: 'R1',
        systemName: 'billing service',
        sentence: 'It shall retry the charge, and they shall be notified.',
      }),
      view({ id: 'R2', systemName: 'audit service', sentence: 'The audit service shall log.' }),
    ]
    const findings = detectAmbiguity(reqs)
    const ref = findings.find((f) => f.code === 'FND_AMBIGUOUS_REFERENCE')
    expect(ref?.evidence?.reference).toBe('It')
    expect(ref?.span?.[0]).toBe(0)
  })
})

describe('detectAmbiguity — FND_AMBIGUITY_NEEDS_JUDGMENT (AC-31-5)', () => {
  it('emits a per-requirement info marker for a long requirement with no deterministic finding', () => {
    const sentence =
      'When a customer completes checkout during a promotional window, the order service shall reconcile the cart contents against inventory levels before confirming the purchase to the customer via email notification.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence, systemName: 'order service' })])
    const j = findings.filter((f) => f.code === 'FND_AMBIGUITY_NEEDS_JUDGMENT')
    expect(j).toHaveLength(1)
    expect(j[0]?.severity).toBe('info')
    expect(j[0]?.requirementIds).toEqual(['R1'])
    // The structured punt is a whole-requirement marker: no span.
    expect(j[0]?.span).toBeUndefined()
    expect(j[0]?.message.toLowerCase()).toContain('review')
  })

  it('does NOT emit the marker for a short requirement', () => {
    const sentence = 'The service shall respond within 200 ms.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence })])
    expect(codesOf(findings)).not.toContain('FND_AMBIGUITY_NEEDS_JUDGMENT')
  })

  it('does NOT emit the marker when a deterministic finding already fired (low-noise)', () => {
    // Long AND vague — the deterministic vague finding suppresses the punt.
    const sentence =
      'When a customer completes checkout during a promotional window, the order service shall provide a fast and seamless reconciliation of the cart contents before confirming.'
    const findings = detectAmbiguity([view({ id: 'R1', sentence, systemName: 'order service' })])
    expect(codesOf(findings)).toContain('FND_AMBIGUOUS_VAGUE')
    expect(codesOf(findings)).not.toContain('FND_AMBIGUITY_NEEDS_JUDGMENT')
  })
})

describe('detectAmbiguity — determinism + purity', () => {
  it('returns byte-identical findings across repeated runs on the same input', () => {
    const reqs = [
      view({
        id: 'R1',
        systemName: 'billing service',
        sentence: 'All the users shall get a fast response, and it shall be logged or archived.',
      }),
      view({
        id: 'R2',
        systemName: 'audit service',
        sentence:
          'When an event is recorded during a maintenance window under heavy concurrent load, the audit service shall persist the record durably to the primary and secondary stores.',
      }),
    ]
    const a = detectAmbiguity(reqs)
    const b = detectAmbiguity(reqs)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not mutate the input array', () => {
    const reqs = [view({ id: 'R1', sentence: 'The system shall be robust.' })]
    const snapshot = JSON.stringify(reqs)
    detectAmbiguity(reqs)
    expect(JSON.stringify(reqs)).toBe(snapshot)
  })

  it('returns an empty array on empty input', () => {
    expect(detectAmbiguity([])).toEqual([])
  })

  it('emits findings in requirement order, then category order within a requirement', () => {
    const reqs = [
      view({
        id: 'R1',
        systemName: 'billing service',
        sentence: 'All the users shall get a fast response, and it shall be logged or archived.',
      }),
      view({ id: 'R2', systemName: 'audit service', sentence: 'The audit service shall log.' }),
    ]
    const findings = detectAmbiguity(reqs)
    const r1 = findings.filter((f) => f.requirementIds[0] === 'R1').map((f) => f.code)
    // vague ("fast") comes before the quantifier + reference categories.
    expect(r1[0]).toBe('FND_AMBIGUOUS_VAGUE')
  })
})
