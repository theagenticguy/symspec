/**
 * T-AC-3-7: pipeline-exclusion gate (error-severity → excluded from symbolize)
 *
 * Verification: "an error-severity statement is absent from the atom
 * table / solver input" (AC-3-7).
 *
 * Cite: AC-3-7; research-ears-incose.md §4 ("Rules that fail at Layer A
 * make Layer C unsound … pipeline order is forced").
 */

import { describe, expect, it } from 'vitest'
import { renderSentence } from '../../core/render.js'
import type { Requirement } from '../../core/schema.js'
import { atomize } from '../../formal/atomize.js'
import { encode } from '../../formal/encode.js'
import { excludedIds, type GateInput, gate, gateRequirements } from '../gate.js'

function makeReq(overrides: Partial<Requirement> & { id: string }): Requirement {
  const base = {
    patternType: 'ubiquitous' as const,
    systemName: 'export service',
    systemResponse: 'return the data within 2 seconds',
    priority: 'medium' as const,
    status: 'draft' as const,
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    ...overrides,
  }
  const sentence = overrides.sentence ?? renderSentence(base)
  return { ...base, sentence }
}

/** Adapts the AC-4-2a atomizer to the AC-4-2 `Atomize` shape used by `encode`. */
const realAtomize = (
  kind: 'trig' | 'pre' | 'resp',
  slotText: string,
  systemName: string,
  negated: boolean,
) => {
  const a = atomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}

describe('gate — pipeline-exclusion gate (AC-3-7)', () => {
  it('excludes an error-severity statement; it never reaches the atom table / solver input', () => {
    // "provide optimal performance" trips GTWR_R7_VAGUE at error severity.
    const vague = makeReq({
      id: 'REQ-VAGUE',
      systemName: 'perf service',
      systemResponse: 'provide optimal performance',
    })
    const clean = makeReq({
      id: 'REQ-CLEAN',
      systemName: 'export service',
      trigger: 'the user requests data',
      patternType: 'event-driven',
      systemResponse: 'return the data within 2 seconds',
    })

    const result = gateRequirements([vague, clean])

    expect(result.included.map((r) => r.id)).toEqual(['REQ-CLEAN'])
    expect(excludedIds(result).has('REQ-VAGUE')).toBe(true)
    expect(excludedIds(result).has('REQ-CLEAN')).toBe(false)

    const exclusion = result.excluded.find((e) => e.id === 'REQ-VAGUE')
    expect(exclusion?.reason).toBe('blocking-surface-check')
    expect(exclusion?.findings.some((f) => f.code === 'GTWR_R7_VAGUE')).toBe(true)
    expect(exclusion?.findings.every((f) => f.severity === 'error')).toBe(true)

    // The proof that matters for AC-3-7: build the atom table / solver input
    // from ONLY `result.included` (the way a real pipeline wiring would) and
    // assert the excluded requirement's id and its atoms are absent.
    const encoded = result.included.map((r) => encode(r, realAtomize))
    expect(encoded.map((e) => e.id)).not.toContain('REQ-VAGUE')
    const allAtomNames = encoded.flatMap((e) => e.atoms.map((a) => a.atom))
    expect(allAtomNames.some((name) => name.includes('optimal_performance'))).toBe(false)
  })

  it('warn/info-severity findings (AC-3-3 legitimate exceptions) do NOT exclude a statement', () => {
    // Event-driven so the rendered sentence carries a "when" conditional
    // clause — the AC-3-3 legitimate-exception context for R16/R26 alike.
    // Trips only GTWR_R16_NEGATION at warn severity (AC-3-3); no error finding.
    const warnOnly = makeReq({
      id: 'REQ-WARN',
      systemName: 'auth service',
      patternType: 'event-driven',
      trigger: 'a session expires',
      systemResponse: 'not store plaintext passwords',
    })
    const result = gateRequirements([warnOnly])

    expect(result.included.map((r) => r.id)).toEqual(['REQ-WARN'])
    expect(result.excluded).toEqual([])
  })

  it('a requirement with zero findings is included', () => {
    const clean = makeReq({
      id: 'REQ-CLEAN-2',
      systemName: 'export service',
      trigger: 'the user requests data',
      patternType: 'event-driven',
      systemResponse: 'return the data within 2 seconds',
    })
    const result = gateRequirements([clean])
    expect(result.included.map((r) => r.id)).toEqual(['REQ-CLEAN-2'])
    expect(result.excluded).toEqual([])
  })

  it('excludes a parse-failure input without running the surface check', () => {
    const failed = makeReq({ id: 'REQ-FAILED', systemResponse: 'return the data within 2 seconds' })
    const inputs: GateInput[] = [{ requirement: failed, parseFailed: true }]
    const result = gate(inputs)

    expect(result.included).toEqual([])
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0]?.reason).toBe('parse-failure')
    expect(result.excluded[0]?.findings).toEqual([])
  })

  it('mixed batch: only the error-severity statement is excluded, others survive to solver input', () => {
    const reqs = [
      makeReq({ id: 'A', systemName: 'sys', systemResponse: 'reject all invalid requests' }), // R26 error (no conditional)
      makeReq({
        id: 'B',
        systemName: 'sys',
        trigger: 'a request arrives',
        patternType: 'event-driven',
        systemResponse: 'return the data within 2 seconds',
      }), // clean-ish, no error
      makeReq({ id: 'C', systemName: 'sys', systemResponse: 'guarantee 100% availability' }), // R26 error (absolute, no conditional)
    ]

    const result = gateRequirements(reqs)
    const includedIds = new Set(result.included.map((r) => r.id))
    const excluded = excludedIds(result)

    expect(includedIds.has('B')).toBe(true)
    expect(excluded.has('A')).toBe(true)
    expect(excluded.has('C')).toBe(true)
    expect(includedIds.has('A')).toBe(false)
    expect(includedIds.has('C')).toBe(false)

    // Solver-input proof over the whole batch: neither excluded id nor its
    // response atom ever appears in the encoded set handed to the formal tier.
    const encoded = result.included.map((r) => encode(r, realAtomize))
    expect(encoded.map((e) => e.id)).toEqual(['B'])
  })

  it('is pure/deterministic: gating the same input twice yields an equal partition', () => {
    const reqs = [
      makeReq({ id: 'X', systemResponse: 'provide optimal performance' }),
      makeReq({
        id: 'Y',
        trigger: 'a request arrives',
        patternType: 'event-driven',
        systemResponse: 'return the data within 2 seconds',
      }),
    ]
    const first = gateRequirements(reqs)
    const second = gateRequirements(reqs)
    expect(first).toEqual(second)
  })
})
