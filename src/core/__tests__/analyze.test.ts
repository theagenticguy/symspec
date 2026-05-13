import { describe, expect, it } from 'vitest'
import { analyze } from '../analyze.js'
import { applyChange, emptyDoc, newId } from '../doc.js'

const create = (
  id: string,
  patternType:
    | 'ubiquitous'
    | 'event-driven'
    | 'state-driven'
    | 'optional-feature'
    | 'unwanted-behavior',
  systemName: string,
  systemResponse: string,
  extras: { trigger?: string; preCondition?: string } = {},
) => ({
  kind: 'CreateRequirement' as const,
  id,
  attrs: { patternType, systemName, systemResponse, ...extras },
})

describe('analyze', () => {
  it('returns no findings for a single ubiquitous requirement', () => {
    const id = newId()
    const doc = applyChange(emptyDoc(), create(id, 'ubiquitous', 'svc', 'log everything'))
    expect(analyze(doc)).toEqual([])
  })

  it('flags MissingTrigger for an event-driven requirement with no trigger', () => {
    const id = newId()
    const doc = applyChange(emptyDoc(), create(id, 'event-driven', 'svc', 'do thing'))
    const findings = analyze(doc)
    expect(findings.some((f) => f.kind === 'MissingTrigger' && f.id === id)).toBe(true)
  })

  it('flags MissingPreCondition for state-driven and optional-feature without precondition', () => {
    const stateId = newId()
    const optId = newId()
    let doc = applyChange(emptyDoc(), create(stateId, 'state-driven', 'svc', 'reject logins'))
    doc = applyChange(doc, create(optId, 'optional-feature', 'svc', 'redirect to IdP'))
    const findings = analyze(doc)
    expect(findings.filter((f) => f.kind === 'MissingPreCondition')).toHaveLength(2)
  })

  it('flags DanglingReference when an edge target is deleted', () => {
    const a = newId()
    const b = newId()
    let doc = applyChange(emptyDoc(), create(a, 'ubiquitous', 'svc', 'do A'))
    doc = applyChange(doc, create(b, 'ubiquitous', 'svc', 'do B'))
    doc = applyChange(doc, { kind: 'AddRelationship', from: a, relation: 'derives', to: b })
    doc = applyChange(doc, { kind: 'DeleteRequirement', id: b })
    const findings = analyze(doc)
    const dangling = findings.find((f) => f.kind === 'DanglingReference')
    expect(dangling).toBeDefined()
    if (dangling && dangling.kind === 'DanglingReference') {
      expect(dangling.from).toBe(a)
      expect(dangling.to).toBe(b)
      expect(dangling.relation).toBe('derives')
    }
  })

  it('flags CycleDetected on a derives cycle', () => {
    const a = newId()
    const b = newId()
    let doc = applyChange(emptyDoc(), create(a, 'ubiquitous', 'svc', 'do A'))
    doc = applyChange(doc, create(b, 'ubiquitous', 'svc', 'do B'))
    doc = applyChange(doc, { kind: 'AddRelationship', from: a, relation: 'derives', to: b })
    doc = applyChange(doc, { kind: 'AddRelationship', from: b, relation: 'derives', to: a })
    const findings = analyze(doc)
    expect(findings.some((f) => f.kind === 'CycleDetected')).toBe(true)
  })

  it('flags OrphanRequirement only when more than one node exists and the orphan has no edges', () => {
    const a = newId()
    const b = newId()
    let doc = applyChange(emptyDoc(), create(a, 'ubiquitous', 'svc', 'do A'))
    doc = applyChange(doc, create(b, 'ubiquitous', 'svc', 'do B'))
    const findings = analyze(doc)
    expect(findings.filter((f) => f.kind === 'OrphanRequirement')).toHaveLength(2)
  })
})
