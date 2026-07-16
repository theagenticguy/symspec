import { describe, expect, it } from 'vitest'
import { analyze } from '../analyze.js'
import type { EarsPattern, Requirement, RequirementsDoc } from '../schema.js'
import { SCHEMA_VERSION } from '../schema.js'

const now = '2024-01-01T00:00:00.000Z'

/** Build a plain-object Requirement. */
const req = (
  id: string,
  patternType: EarsPattern,
  systemName: string,
  systemResponse: string,
  extras: Partial<
    Pick<Requirement, 'trigger' | 'preCondition' | 'derives' | 'satisfies' | 'verifies' | 'refines'>
  > = {},
): Requirement => ({
  id,
  patternType,
  systemName,
  systemResponse,
  sentence: `The ${systemName} shall ${systemResponse}.`,
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: now,
  updatedAt: now,
  ...extras,
})

/** Build a plain-object RequirementsDoc snapshot. */
const docOf = (...reqs: Requirement[]): RequirementsDoc => ({
  schemaVersion: SCHEMA_VERSION,
  requirements: Object.fromEntries(reqs.map((r) => [r.id, r])),
})

describe('analyze', () => {
  it('returns no findings for a single ubiquitous requirement', () => {
    const doc = docOf(req('a', 'ubiquitous', 'svc', 'log everything'))
    expect(analyze(doc)).toEqual([])
  })

  it('flags MissingTrigger for an event-driven requirement with no trigger', () => {
    const doc = docOf(req('a', 'event-driven', 'svc', 'do thing'))
    const findings = analyze(doc)
    expect(findings.some((f) => f.kind === 'MissingTrigger' && f.id === 'a')).toBe(true)
  })

  it('flags MissingPreCondition for state-driven and optional-feature without precondition', () => {
    const doc = docOf(
      req('state', 'state-driven', 'svc', 'reject logins'),
      req('opt', 'optional-feature', 'svc', 'redirect to IdP'),
    )
    const findings = analyze(doc)
    expect(findings.filter((f) => f.kind === 'MissingPreCondition')).toHaveLength(2)
  })

  it('flags DanglingReference when an edge target no longer exists in the snapshot', () => {
    const doc = docOf(req('a', 'ubiquitous', 'svc', 'do A', { derives: ['missing'] }))
    const findings = analyze(doc)
    const dangling = findings.find((f) => f.kind === 'DanglingReference')
    expect(dangling).toBeDefined()
    if (dangling && dangling.kind === 'DanglingReference') {
      expect(dangling.from).toBe('a')
      expect(dangling.to).toBe('missing')
      expect(dangling.relation).toBe('derives')
    }
  })

  it('flags CycleDetected on a derives cycle', () => {
    const doc = docOf(
      req('a', 'ubiquitous', 'svc', 'do A', { derives: ['b'] }),
      req('b', 'ubiquitous', 'svc', 'do B', { derives: ['a'] }),
    )
    const findings = analyze(doc)
    expect(findings.some((f) => f.kind === 'CycleDetected')).toBe(true)
  })

  it('flags a self-loop (a derives a) exactly once', () => {
    const doc = docOf(req('a', 'ubiquitous', 'svc', 'do A', { derives: ['a'] }))
    const findings = analyze(doc).filter((f) => f.kind === 'CycleDetected')
    expect(findings).toHaveLength(1)
    if (findings[0] && findings[0].kind === 'CycleDetected') {
      expect(findings[0].nodes).toEqual(['a'])
    }
  })

  it('dedupes the same cycle found from two different entry nodes (canonical rotation)', () => {
    // a -> b -> c -> a is one cycle; DFS starting from each node independently
    // would (pre-fix) find and report it once per entry node it starts from
    // within the same traversal. Add a 4th node that also derives into the
    // cycle at a different point, so the DFS root loop visits the cycle from
    // more than one starting id and the dedupe must collapse them.
    const doc = docOf(
      req('a', 'ubiquitous', 'svc', 'do A', { derives: ['b'] }),
      req('b', 'ubiquitous', 'svc', 'do B', { derives: ['c'] }),
      req('c', 'ubiquitous', 'svc', 'do C', { derives: ['a'] }),
      req('d', 'ubiquitous', 'svc', 'do D', { derives: ['b'] }),
    )
    const findings = analyze(doc).filter((f) => f.kind === 'CycleDetected')
    expect(findings).toHaveLength(1)
    if (findings[0] && findings[0].kind === 'CycleDetected') {
      // canonical rotation starts at the lexicographically-smallest node id
      expect(findings[0].nodes).toEqual(['a', 'b', 'c'])
    }
  })

  it('dedupes the same cycle regardless of requirement insertion order', () => {
    const cycleAtA = docOf(
      req('a', 'ubiquitous', 'svc', 'do A', { derives: ['b'] }),
      req('b', 'ubiquitous', 'svc', 'do B', { derives: ['c'] }),
      req('c', 'ubiquitous', 'svc', 'do C', { derives: ['a'] }),
    )
    const cycleAtC = docOf(
      req('c', 'ubiquitous', 'svc', 'do C', { derives: ['a'] }),
      req('a', 'ubiquitous', 'svc', 'do A', { derives: ['b'] }),
      req('b', 'ubiquitous', 'svc', 'do B', { derives: ['c'] }),
    )
    const findingsA = analyze(cycleAtA).filter((f) => f.kind === 'CycleDetected')
    const findingsC = analyze(cycleAtC).filter((f) => f.kind === 'CycleDetected')
    expect(findingsA).toHaveLength(1)
    expect(findingsC).toHaveLength(1)
    if (
      findingsA[0] &&
      findingsA[0].kind === 'CycleDetected' &&
      findingsC[0] &&
      findingsC[0].kind === 'CycleDetected'
    ) {
      expect(findingsA[0].nodes).toEqual(findingsC[0].nodes)
    }
  })

  it('flags OrphanRequirement for edgeless nodes once the doc uses at least one trace link', () => {
    // Trace-gate: an orphan is only meaningful relative to a document that
    // traces. Here c→d is a committed link, so the tier is un-gated and the two
    // genuinely edgeless nodes (a, b) are flagged. c and d have edges, so they
    // are not orphans.
    const doc = docOf(
      req('a', 'ubiquitous', 'svc', 'do A'),
      req('b', 'ubiquitous', 'svc', 'do B'),
      req('c', 'ubiquitous', 'svc', 'do C', { derives: ['d'] }),
      req('d', 'ubiquitous', 'svc', 'do D'),
    )
    const orphans = analyze(doc).filter((f) => f.kind === 'OrphanRequirement')
    expect(orphans.map((f) => (f.kind === 'OrphanRequirement' ? f.id : '')).sort()).toEqual([
      'a',
      'b',
    ])
  })

  it('does NOT flag orphans in a doc that uses ZERO trace links (trace-gate suppresses the noise)', () => {
    // A trace-free doc: every requirement is trivially edgeless, so flagging them
    // all just penalizes an author who has not adopted trace links yet. No trace
    // edge anywhere ⇒ no OrphanRequirement findings.
    const doc = docOf(req('a', 'ubiquitous', 'svc', 'do A'), req('b', 'ubiquitous', 'svc', 'do B'))
    const findings = analyze(doc)
    expect(findings.filter((f) => f.kind === 'OrphanRequirement')).toHaveLength(0)
  })

  it('does not flag OrphanRequirement for a single-requirement snapshot', () => {
    const doc = docOf(req('a', 'ubiquitous', 'svc', 'do A'))
    const findings = analyze(doc)
    expect(findings.filter((f) => f.kind === 'OrphanRequirement')).toHaveLength(0)
  })
})
