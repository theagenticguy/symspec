import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyChange, applyChanges, ChangeError } from '../changes.js'
import { emptyDoc } from '../doc.js'
import type { RequirementsDoc } from '../schema.js'

// Valid v4-shaped UUIDs (Zod v4 constrains the version nibble to 1-8 and the
// variant nibble to 8/9/a/b).
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-9222-222222222222'
const ID_C = '33333333-3333-4333-a333-333333333333'

const createA = {
  kind: 'CreateRequirement' as const,
  id: ID_A,
  attrs: {
    patternType: 'event-driven' as const,
    systemName: 'auth service',
    systemResponse: 'issue a session token',
    trigger: 'the user submits valid credentials',
  },
}

describe('applyChange over a plain-object doc (AC-1-5)', () => {
  it('CreateRequirement adds a plain-object requirement with a rendered sentence', () => {
    const doc = applyChange(emptyDoc(), createA)
    const r = doc.requirements[ID_A]
    expect(r).toBeDefined()
    expect(r?.id).toBe(ID_A)
    expect(r?.patternType).toBe('event-driven')
    expect(r?.sentence).toBe(
      'When the user submits valid credentials, the auth service shall issue a session token.',
    )
    // Defaults filled in.
    expect(r?.priority).toBe('medium')
    expect(r?.status).toBe('draft')
    expect(r?.derives).toEqual([])
  })

  it('does not include optional slots that were not supplied (exactOptionalPropertyTypes)', () => {
    const doc = applyChange(emptyDoc(), createA)
    const r = doc.requirements[ID_A]
    // preCondition was never provided — the key must be omitted, not set to undefined.
    expect(r && Object.hasOwn(r, 'preCondition')).toBe(false)
    expect(r && Object.hasOwn(r, 'verificationMethod')).toBe(false)
  })

  it('CreateRequirement on an existing id throws ERR_DUPLICATE_ID (AC-1-8)', () => {
    const doc = applyChange(emptyDoc(), createA)
    expect(() => applyChange(doc, createA)).toThrow(/already exists/)
    try {
      applyChange(doc, createA)
      expect.unreachable('applyChange should have thrown on a duplicate id')
    } catch (err) {
      expect(err).toBeInstanceOf(ChangeError)
      const changeErr = err as ChangeError
      expect(changeErr.code).toBe('ERR_DUPLICATE_ID')
      expect(changeErr.suggestions.join(' ')).toMatch(/symspec update/)
    }
  })

  it('UpdateAttribute patches a metadata attr without re-rendering the sentence', () => {
    const doc = applyChange(emptyDoc(), createA)
    const before = doc.requirements[ID_A]?.sentence
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'priority',
      value: 'high',
    })
    expect(next.requirements[ID_A]?.priority).toBe('high')
    expect(next.requirements[ID_A]?.sentence).toBe(before)
  })

  it('metadata edits never re-render (status, verificationMethod) — non-EARS half of the gate', () => {
    const doc = applyChange(emptyDoc(), createA)
    const before = doc.requirements[ID_A]?.sentence
    let next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'status',
      value: 'approved',
    })
    expect(next.requirements[ID_A]?.sentence).toBe(before)
    next = applyChange(next, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'verificationMethod',
      value: 'test',
    })
    expect(next.requirements[ID_A]?.verificationMethod).toBe('test')
    expect(next.requirements[ID_A]?.sentence).toBe(before)
  })

  it('UpdateAttribute on an EARS slot re-renders the sentence', () => {
    const doc = applyChange(emptyDoc(), createA)
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'systemResponse',
      value: 'reject the request',
    })
    expect(next.requirements[ID_A]?.sentence).toBe(
      'When the user submits valid credentials, the auth service shall reject the request.',
    )
  })

  it('five-way re-render gate: each of the five EARS slots individually re-renders the sentence (AC-1-6)', () => {
    const base = applyChange(emptyDoc(), createA)
    const baseline = base.requirements[ID_A]?.sentence

    const bySystemName = applyChange(base, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'systemName',
      value: 'billing service',
    })
    expect(bySystemName.requirements[ID_A]?.sentence).not.toBe(baseline)
    expect(bySystemName.requirements[ID_A]?.sentence).toContain('billing service')

    const bySystemResponse = applyChange(base, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'systemResponse',
      value: 'deny access',
    })
    expect(bySystemResponse.requirements[ID_A]?.sentence).not.toBe(baseline)
    expect(bySystemResponse.requirements[ID_A]?.sentence).toContain('deny access')

    const byTrigger = applyChange(base, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'trigger',
      value: 'the session expires',
    })
    expect(byTrigger.requirements[ID_A]?.sentence).not.toBe(baseline)
    expect(byTrigger.requirements[ID_A]?.sentence).toContain('the session expires')

    // preCondition is not set on createA (event-driven pattern); switching
    // patternType to state-driven and setting preCondition exercises both
    // remaining slots of the five-way gate.
    const byPatternType = applyChange(base, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'patternType',
      value: 'state-driven',
    })
    expect(byPatternType.requirements[ID_A]?.sentence).not.toBe(baseline)
    expect(byPatternType.requirements[ID_A]?.patternType).toBe('state-driven')

    const byPreCondition = applyChange(byPatternType, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'preCondition',
      value: 'the vault is unlocked',
    })
    expect(byPreCondition.requirements[ID_A]?.sentence).toContain('the vault is unlocked')
  })

  it('UpdateAttribute with null clears an optional (nullable) attr', () => {
    const doc = applyChange(emptyDoc(), createA)
    expect(doc.requirements[ID_A]?.trigger).toBe('the user submits valid credentials')
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: ID_A,
      attr: 'trigger',
      value: null,
    })
    const r = next.requirements[ID_A]
    expect(r && Object.hasOwn(r, 'trigger')).toBe(false)
  })

  it('UpdateAttribute with null on a required attr throws ERR_NULL_REQUIRED', () => {
    const doc = applyChange(emptyDoc(), createA)
    expect(() =>
      applyChange(doc, { kind: 'UpdateAttribute', id: ID_A, attr: 'systemName', value: null }),
    ).toThrow(/Cannot null required/)
    try {
      applyChange(doc, { kind: 'UpdateAttribute', id: ID_A, attr: 'priority', value: null })
      expect.unreachable('nulling a required metadata attr should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ChangeError)
      const changeErr = err as ChangeError
      expect(changeErr.code).toBe('ERR_NULL_REQUIRED')
      expect(changeErr.suggestions.length).toBeGreaterThan(0)
    }
  })

  it('UpdateAttribute on a missing requirement throws', () => {
    expect(() =>
      applyChange(emptyDoc(), {
        kind: 'UpdateAttribute',
        id: ID_A,
        attr: 'priority',
        value: 'low',
      }),
    ).toThrow(/not found/)
  })

  it('AddRelationship adds an edge and is idempotent', () => {
    let doc = applyChanges(emptyDoc(), [
      createA,
      { ...createA, id: ID_B, attrs: { ...createA.attrs, systemResponse: 'log the attempt' } },
    ])
    doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
    expect(doc.requirements[ID_A]?.derives).toEqual([ID_B])
    // Idempotent: re-adding does not duplicate.
    doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
    expect(doc.requirements[ID_A]?.derives).toEqual([ID_B])
  })

  // Ported from the deleted v1 `scripts/smoke-incremental.ts` Step 6
  // (idempotency scenarios preserved verbatim in git history at HEAD
  // `7d10e18`, per the T-AC-1-5/8-4 handoff note and the gate-wave-2 log).
  it('AddRelationship applied three times in a row still yields exactly one edge', () => {
    let doc = applyChanges(emptyDoc(), [
      createA,
      { ...createA, id: ID_B, attrs: { ...createA.attrs, systemResponse: 'log the attempt' } },
    ])
    doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
    doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
    doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
    const derivesCount = doc.requirements[ID_A]?.derives.filter((t) => t === ID_B).length
    expect(derivesCount).toBe(1)
  })

  it('AddRelationship on a missing source requirement throws (not "safe to call defensively")', () => {
    const doc = applyChange(emptyDoc(), createA)
    expect(() =>
      applyChange(doc, { kind: 'AddRelationship', from: ID_C, relation: 'derives', to: ID_A }),
    ).toThrow(/not found/)
  })

  it('RemoveRelationship removes an edge and no-ops on a missing source', () => {
    let doc = applyChanges(emptyDoc(), [
      createA,
      { ...createA, id: ID_B, attrs: { ...createA.attrs, systemResponse: 'log the attempt' } },
      { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B },
    ])
    doc = applyChange(doc, {
      kind: 'RemoveRelationship',
      from: ID_A,
      relation: 'derives',
      to: ID_B,
    })
    expect(doc.requirements[ID_A]?.derives).toEqual([])
    // No-op on a source that does not exist.
    const same = applyChange(doc, {
      kind: 'RemoveRelationship',
      from: ID_C,
      relation: 'derives',
      to: ID_B,
    })
    expect(same.requirements[ID_C]).toBeUndefined()
  })

  // Ported from the deleted v1 `scripts/smoke-incremental.ts` Step 7: a
  // phantom remove (edge that was never added) leaves a genuinely existing
  // edge on the same source untouched.
  it('RemoveRelationship on an edge that was never added is a no-op and preserves an existing edge', () => {
    let doc = applyChanges(emptyDoc(), [
      createA,
      { ...createA, id: ID_B, attrs: { ...createA.attrs, systemResponse: 'log the attempt' } },
      { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B },
    ])
    doc = applyChange(doc, {
      kind: 'RemoveRelationship',
      from: ID_A,
      relation: 'derives',
      to: ID_C, // never added
    })
    expect(doc.requirements[ID_A]?.derives).toEqual([ID_B])
  })

  it('DeleteRequirement removes the entry and no-ops on a missing id', () => {
    let doc = applyChange(emptyDoc(), createA)
    doc = applyChange(doc, { kind: 'DeleteRequirement', id: ID_A })
    expect(doc.requirements[ID_A]).toBeUndefined()
    // No-op: deleting an absent id does not throw.
    expect(() => applyChange(doc, { kind: 'DeleteRequirement', id: ID_C })).not.toThrow()
  })

  // Ported from the deleted v1 `scripts/smoke-incremental.ts` Step 8:
  // deleting the SAME id twice in a row must not throw the second time.
  it('DeleteRequirement is idempotent across repeated calls on the same id', () => {
    let doc = applyChange(emptyDoc(), createA)
    doc = applyChange(doc, { kind: 'DeleteRequirement', id: ID_A })
    doc = applyChange(doc, { kind: 'DeleteRequirement', id: ID_A })
    expect(doc.requirements[ID_A]).toBeUndefined()
  })

  it('is non-mutating: the input document is left untouched', () => {
    const doc = emptyDoc()
    const snapshotBefore = JSON.stringify(doc)
    const next = applyChange(doc, createA)
    expect(JSON.stringify(doc)).toBe(snapshotBefore)
    expect(next).not.toBe(doc)
    expect(Object.keys(next.requirements)).toEqual([ID_A])
    expect(Object.keys(doc.requirements)).toEqual([])
  })

  it('produces a plain object with no proxy wrapper (AC-1-5)', () => {
    const doc: RequirementsDoc = applyChange(emptyDoc(), createA)
    const r = doc.requirements[ID_A]
    // A plain object round-trips through JSON identically and exposes no
    // proxy symbols/getters.
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
    expect(r?.constructor).toBe(Object)
    expect(Object.getOwnPropertySymbols(r ?? {})).toEqual([])
  })

  it('rejects a malformed Change via ChangeSchema before mutating', () => {
    expect(() => applyChange(emptyDoc(), { kind: 'Nonsense' })).toThrow()
    expect(() => applyChange(emptyDoc(), { kind: 'CreateRequirement', id: 'not-a-uuid' })).toThrow()
  })
})

describe('clean-slate: core modules carry no v1/CRDT/migration residue (SC-1/SC-2, AC-8-4)', () => {
  const coreDir = fileURLToPath(new URL('..', import.meta.url))

  // v2 behaves as if v1 never existed: no source file — code OR comment — may
  // reference the old CRDT substrate or the deleted migrate ceremony.
  const FORBIDDEN = /automerge|\bmigrate\b|\blegacy\b/i

  it('core modules contain no automerge/migrate/legacy reference at all', () => {
    for (const file of [
      'doc.ts',
      'changes.ts',
      'storage.ts',
      'analyze.ts',
      'schema.ts',
      'load.ts',
    ]) {
      const src = readFileSync(new URL(file, `file://${coreDir}/`), 'utf8')
      expect(src, `${file} still references v1 residue`).not.toMatch(FORBIDDEN)
    }
  })
})
