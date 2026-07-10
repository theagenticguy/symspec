import { describe, expect, it } from 'vitest'
import type { ContradictionFinding } from '../contradiction.js'
import { type Atomize, type AtomLit, type EncodableRequirement, encode } from '../encode.js'
import { attachEvidence, attachEvidenceToAll, collectAtomTable } from '../finding.js'
import type { RedundancyFinding, SubsumptionFinding } from '../subsumption.js'
import type { VacuityFinding } from '../vacuity.js'

/**
 * Kind-scoped fake atomizer (mirrors the real AC-4-2a shape) so this task's
 * tests never boot the WASM solver — `finding.ts` is atomizer- and
 * solver-agnostic, consuming only the plain-data `EncodedRequirement.atoms`
 * rows `encode.ts` already produces.
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

describe('finding — evidence enrichment (AC-4-6)', () => {
  it('FND_CONTRADICTION: evidence carries the atom table for both requirement ids and the core', () => {
    const a = encode(
      view({
        id: 'REQ-A',
        patternType: 'ubiquitous',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const b = encode(
      view({
        id: 'REQ-B',
        patternType: 'ubiquitous',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      fakeAtomize,
    )
    const encodedById = new Map([
      [a.id, a],
      [b.id, b],
    ])

    const plain: ContradictionFinding = {
      code: 'FND_CONTRADICTION',
      severity: 'error',
      requirementIds: ['REQ-A', 'REQ-B'],
      message: 'REQ-A and REQ-B cannot both hold.',
    }

    const enriched = attachEvidence(plain, encodedById)

    // Original finding fields survive untouched.
    expect(enriched.code).toBe('FND_CONTRADICTION')
    expect(enriched.requirementIds).toEqual(['REQ-A', 'REQ-B'])

    // AC-4-6: evidence carries the atom table (both ids' rows) and the core.
    expect(enriched.evidence.core).toEqual(['REQ-A', 'REQ-B'])
    expect(enriched.evidence.witness).toBeUndefined()
    expect(enriched.evidence.atomTable).toHaveLength(2)
    const atomNames = enriched.evidence.atomTable.map((row) => row.atom)
    expect(atomNames).toEqual([
      'sys__auth_service__resp__issue_a_session_token',
      'sys__auth_service__resp__issue_a_session_token',
    ])
    // Original detection finding is never mutated.
    expect(plain).not.toHaveProperty('evidence')
  })

  it('FND_SUBSUMPTION: evidence names the pair and pulls each side atom table row', () => {
    const general = encode(
      view({
        id: 'REQ-GEN',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const specific = encode(
      view({
        id: 'REQ-SPEC',
        patternType: 'event-driven',
        preCondition: 'the account is not locked',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      fakeAtomize,
    )
    const encodedById = new Map([
      [general.id, general],
      [specific.id, specific],
    ])

    const plain: SubsumptionFinding = {
      code: 'FND_SUBSUMPTION',
      severity: 'warn',
      moreGeneral: 'REQ-GEN',
      moreSpecific: 'REQ-SPEC',
      requirementIds: ['REQ-GEN', 'REQ-SPEC'],
      message: 'REQ-GEN subsumes REQ-SPEC.',
    }

    const enriched = attachEvidence(plain, encodedById)

    expect(enriched.moreGeneral).toBe('REQ-GEN')
    expect(enriched.moreSpecific).toBe('REQ-SPEC')
    expect(enriched.evidence.core).toEqual(['REQ-GEN', 'REQ-SPEC'])
    // general contributes {trig, resp}; specific contributes {pre, trig, resp}.
    // trig/resp rows are byte-identical (same slot text, same polarity) across
    // both requirements, so they dedup to one row each: pre + trig + resp = 3.
    expect(enriched.evidence.atomTable).toHaveLength(3)
    expect(enriched.evidence.atomTable.map((row) => row.kind).sort()).toEqual([
      'pre',
      'resp',
      'trig',
    ])
  })

  it('FND_REDUNDANCY: evidence is populated identically to subsumption', () => {
    const a = encode(view({ id: 'REQ-A' }), fakeAtomize)
    const b = encode(view({ id: 'REQ-B' }), fakeAtomize)
    const encodedById = new Map([
      [a.id, a],
      [b.id, b],
    ])
    const plain: RedundancyFinding = {
      code: 'FND_REDUNDANCY',
      severity: 'warn',
      requirementIds: ['REQ-A', 'REQ-B'],
      message: 'REQ-A and REQ-B are logically equivalent.',
    }
    const enriched = attachEvidence(plain, encodedById)
    expect(enriched.evidence.core).toEqual(['REQ-A', 'REQ-B'])
    expect(enriched.evidence.atomTable.length).toBeGreaterThan(0)
  })

  it('FND_VACUITY: singular requirementId names the evidence core (single-element array)', () => {
    const target = encode(
      view({
        id: 'REQ-VAC',
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
      }),
      fakeAtomize,
    )
    const encodedById = new Map([[target.id, target]])

    const plain: VacuityFinding = {
      code: 'FND_VACUITY',
      severity: 'warn',
      confidence: 'low',
      requirementId: 'REQ-VAC',
      message: "REQ-VAC's guard is unreachable.",
    }

    const enriched = attachEvidence(plain, encodedById)
    expect(enriched.evidence.core).toEqual(['REQ-VAC'])
    expect(enriched.evidence.atomTable).toHaveLength(target.atoms.length)
  })

  it('drops ids absent from encodedById rather than throwing (best-effort evidence)', () => {
    const known = encode(view({ id: 'REQ-KNOWN' }), fakeAtomize)
    const encodedById = new Map([[known.id, known]])

    const plain: ContradictionFinding = {
      code: 'FND_CONTRADICTION',
      severity: 'error',
      requirementIds: ['REQ-KNOWN', 'REQ-MISSING'],
      message: 'placeholder',
    }

    const enriched = attachEvidence(plain, encodedById)
    expect(enriched.evidence.core).toEqual(['REQ-KNOWN', 'REQ-MISSING'])
    expect(enriched.evidence.atomTable).toHaveLength(known.atoms.length)
  })

  it('deduplicates identical atom-table rows across ids, keeping distinct provenance', () => {
    const a = encode(view({ id: 'REQ-A', systemResponse: 'issue a session token' }), fakeAtomize)
    const b = encode(view({ id: 'REQ-B', systemResponse: 'issue a session token' }), fakeAtomize)
    const rows = collectAtomTable(
      ['REQ-A', 'REQ-A', 'REQ-B'],
      new Map([
        [a.id, a],
        [b.id, b],
      ]),
    )
    // Same requirement id repeated collapses to one set of rows; distinct ids
    // with the SAME atom name+text+polarity also collapse (dedup key is the
    // full row, and both requirements share identical slot text here).
    expect(rows).toHaveLength(1)
    expect(rows[0]?.atom).toBe('sys__auth_service__resp__issue_a_session_token')
  })

  it('attachEvidenceToAll enriches a mixed batch and every result is JSON-serializable', () => {
    const a = encode(view({ id: 'REQ-A' }), fakeAtomize)
    const b = encode(view({ id: 'REQ-B', negated: true }), fakeAtomize)
    const encodedById = new Map([
      [a.id, a],
      [b.id, b],
    ])

    const findings: ContradictionFinding[] = [
      {
        code: 'FND_CONTRADICTION',
        severity: 'error',
        requirementIds: ['REQ-A', 'REQ-B'],
        message: 'conflict',
      },
    ]

    const enriched = attachEvidenceToAll(findings, encodedById)
    expect(enriched).toHaveLength(1)

    // AC-4-6 verification: "finding includes atom table + core; serializable JSON."
    const roundTripped = JSON.parse(JSON.stringify(enriched))
    expect(roundTripped).toEqual(enriched)
    expect(roundTripped[0].evidence.atomTable.length).toBeGreaterThan(0)
    expect(roundTripped[0].evidence.core).toEqual(['REQ-A', 'REQ-B'])
  })
})
