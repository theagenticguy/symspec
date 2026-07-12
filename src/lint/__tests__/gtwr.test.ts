/**
 * T-AC-3-2: ~24 INCOSE GtWR v4 lint rules.
 *
 * AC-3-2: "symspec shall extend lint coverage to the ~24 regex/lexicon-checkable
 * INCOSE GtWR v4 rules, emitting each finding with a stable code
 * (GTWR_R<n>_<slug>), a severity (error|warn|info), the offending character
 * span, and a rewrite suggestion where one is defined."
 *
 * Verification (this file): ONE fixture per rule triggers its code with the
 * correct severity and a character span that actually covers the offending
 * text. Plus a reachability guard: every code in the GtwrCodeSchema enum
 * (AC-6-3, append-only) is produced by some producer here.
 *
 * Cite: AC-3-2; research-ears-incose.md §2 (checkability rollup, verbatim word
 * lists), §4 Layer A; Appendix B (finding-code enum).
 */

import { describe, expect, it } from 'vitest'
import type { Requirement } from '../../core/schema'
import { GtwrCodes } from '../codes'
import { checkGtWRules, checkGtWRulesSet, type GtWRFinding } from '../gtwr'

/** Minimal ubiquitous requirement whose rendered sentence is the raw text. */
function makeReq(text: string, id = 'req-1'): Requirement {
  return {
    id,
    patternType: 'ubiquitous',
    systemName: 'system',
    systemResponse: text,
    sentence: text,
    priority: 'medium',
    status: 'draft',
    verificationMethod: 'inspection',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  }
}

/** Assert a finding's span actually brackets non-empty text within the sentence. */
function assertSpanValid(f: GtWRFinding, sentence: string): void {
  const [start, end] = f.span
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  expect(end).toBeLessThanOrEqual(sentence.length)
  expect(sentence.slice(start, end).length).toBeGreaterThan(0)
}

/**
 * The per-statement rule table: [code, severity, fixture sentence]. Each entry
 * is a minimal sentence engineered to trip exactly that rule. `checkGtWRules`
 * is run on the sentence and the finding for `code` must be present at the
 * given severity with a valid span.
 */
const PER_STATEMENT: ReadonlyArray<
  [code: string, severity: GtWRFinding['severity'], sentence: string]
> = [
  ['GTWR_R1_PATTERN', 'error', 'Fast response times are important'],
  ['GTWR_R2_PASSIVE', 'warn', 'the sensor data shall be stored in the database'],
  ['GTWR_R5_INDEFINITE_ARTICLE', 'warn', 'the system shall log an event'],
  ['GTWR_R6_MISSING_UNITS', 'error', 'the system shall store 42 records'],
  ['GTWR_R7_VAGUE', 'error', 'the system shall provide adequate performance'],
  ['GTWR_R8_ESCAPE', 'error', 'the system shall log events where possible'],
  [
    'GTWR_R9_OPEN_ENDED',
    'error',
    'the system shall support formats including but not limited to JSON',
  ],
  ['GTWR_R10_SUPERFLUOUS_INFINITIVE', 'warn', 'the system shall be able to parse input'],
  [
    'GTWR_R15_LOGICAL_EXPR',
    'warn',
    'When the user logs in and the session is valid, the system shall grant access',
  ],
  ['GTWR_R16_NEGATION', 'warn', 'the system shall not store plaintext'],
  ['GTWR_R17_OBLIQUE', 'warn', 'the system shall log errors and/or warnings'],
  ['GTWR_R18_MULTIPLE_SHALL', 'error', 'the system shall log events and shall alert admins'],
  ['GTWR_R19_COMBINATOR', 'warn', 'the system shall validate and store the input'],
  ['GTWR_R20_PURPOSE', 'warn', 'the system shall cache results in order to improve speed'],
  ['GTWR_R21_PARENTHESES', 'warn', 'the system shall encrypt data (using AES-256 encryption)'],
  ['GTWR_R24_PRONOUN', 'warn', 'the system shall validate it before processing'],
  ['GTWR_R26_ABSOLUTE', 'error', 'the system shall respond to all events'],
  ['GTWR_R32_UNIVERSAL', 'warn', 'the system shall handle any request'],
  ['GTWR_R33_MISSING_TOLERANCE', 'warn', 'the system shall respond in 5 seconds'],
  ['GTWR_R34_IMMEASURABLE', 'warn', 'the system shall be robust'],
  ['GTWR_R35_TEMPORAL', 'warn', 'the system shall eventually converge'],
  ['GTWR_R37_ACRONYM', 'warn', 'the system shall export via SFTP'],
  ['GTWR_R38_ABBREVIATION', 'warn', 'the system shall load the config'],
]

describe('T-AC-3-2: GtWR per-statement rules — one fixture per rule', () => {
  for (const [code, severity, sentence] of PER_STATEMENT) {
    it(`${code}: fires at ${severity} with a valid span`, () => {
      const req = makeReq(sentence)
      const findings = checkGtWRules(req, sentence)
      const finding = findings.find((f) => f.code === code)

      expect(finding, `${code} not produced for: "${sentence}"`).toBeDefined()
      if (!finding) return
      expect(finding.severity).toBe(severity)
      assertSpanValid(finding, sentence)
      // Per-statement findings never carry a set-level requirementId.
      expect(finding.requirementId).toBeUndefined()
    })
  }

  it('every finding carries the required shape (code/severity/span/message)', () => {
    const req = makeReq('the system shall provide adequate performance where possible')
    const findings = checkGtWRules(req, req.sentence)
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.code).toMatch(/^GTWR_R\d+_/)
      expect(['error', 'warn', 'info']).toContain(f.severity)
      expect(Array.isArray(f.span)).toBe(true)
      expect(f.span).toHaveLength(2)
      expect(typeof f.message).toBe('string')
      expect(f.message.length).toBeGreaterThan(0)
    }
  })

  it('a clean EARS sentence is finding-free', () => {
    // Deliberately avoids every lexicon: definite article, single shall, no
    // number (so no R6/R33), no vague/temporal/absolute words, valid EARS
    // pattern, no combinator in the response.
    const clean = 'the export service shall return the requested payload'
    const req = makeReq(clean)
    const findings = checkGtWRules(req, clean)
    expect(findings, JSON.stringify(findings)).toEqual([])
  })

  it('R1 does NOT fire on a well-formed EARS sentence', () => {
    const req = makeReq('When the order is confirmed, the checkout service shall send a receipt')
    const findings = checkGtWRules(req, req.sentence)
    expect(findings.find((f) => f.code === 'GTWR_R1_PATTERN')).toBeUndefined()
  })
})

describe('T-AC-3-2: R40 decimal-format consistency — set-level', () => {
  const mk = (id: string, sentence: string) => ({ requirement: makeReq(sentence, id), sentence })

  it('GTWR_R40_DECIMAL_FORMAT: flags the odd-precision literal at info with its requirementId + span', () => {
    const set = [
      mk('a', 'the system shall respond within 2.0 seconds'),
      mk('b', 'the system shall respond within 2.00 seconds'),
      mk('c', 'the system shall respond within 3.0 seconds'),
    ]
    const findings = checkGtWRulesSet(set)
    const r40 = findings.filter((f) => f.code === 'GTWR_R40_DECIMAL_FORMAT')

    expect(r40).toHaveLength(1)
    const finding = r40[0]!
    expect(finding.severity).toBe('info')
    expect(finding.requirementId).toBe('b')
    // Span points at "2.00" inside requirement b's own sentence.
    expect(set[1]!.sentence.slice(finding.span[0], finding.span[1])).toBe('2.00')
  })

  it('a set with a single consistent precision produces no R40 finding', () => {
    const set = [
      mk('a', 'the system shall respond within 2.0 seconds'),
      mk('b', 'the system shall respond within 3.5 seconds'),
    ]
    expect(checkGtWRulesSet(set)).toEqual([])
  })

  it('a set with no decimal literals produces no R40 finding', () => {
    const set = [mk('a', 'the system shall log every request')]
    expect(checkGtWRulesSet(set)).toEqual([])
  })
})

describe('T-AC-3-2: enum reachability (AC-6-3 append-only guard)', () => {
  it('every GtwrCode in the exported enum is produced by some fixture', () => {
    const produced = new Set<string>()

    // Per-statement producers.
    for (const [, , sentence] of PER_STATEMENT) {
      for (const f of checkGtWRules(makeReq(sentence), sentence)) produced.add(f.code)
    }
    // Set-level producer (R40).
    for (const f of checkGtWRulesSet([
      {
        requirement: makeReq('the system shall respond within 2.0 seconds', 'a'),
        sentence: 'the system shall respond within 2.0 seconds',
      },
      {
        requirement: makeReq('the system shall respond within 2.00 seconds', 'b'),
        sentence: 'the system shall respond within 2.00 seconds',
      },
    ])) {
      produced.add(f.code)
    }

    const missing = GtwrCodes.filter((code) => !produced.has(code))
    expect(missing, `unreachable GtWR codes: ${missing.join(', ')}`).toEqual([])
    // And nothing produced outside the enum.
    for (const code of produced) expect(GtwrCodes).toContain(code)
  })
})

describe('GtWR bare-number rules — standard-identifier allowlist (field-report fix)', () => {
  // A number that is part of a standard's NAME ("RFC 9457", "HTTP 401") is an
  // identifier, not a units-less quantity, so R6 (missing-units) and R33
  // (missing-tolerance) must NOT fire on it. Includes the hyphenated
  // "RFC-9457" form the field report explicitly hit.
  const STANDARD_IDENTIFIER_SENTENCES: ReadonlyArray<string> = [
    'the API shall return an RFC 9457 problem document',
    'the API shall emit an RFC-9457 response',
    'the client shall handle an HTTP 401 response',
    'the service shall emit an ISO 8601 timestamp',
    'the parser shall accept an IEEE 754 float',
  ]

  for (const sentence of STANDARD_IDENTIFIER_SENTENCES) {
    it(`GTWR_R6_MISSING_UNITS does NOT fire on: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      expect(findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')).toBeUndefined()
    })

    it(`GTWR_R33_MISSING_TOLERANCE does NOT fire on: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      expect(findings.find((f) => f.code === 'GTWR_R33_MISSING_TOLERANCE')).toBeUndefined()
    })
  }

  // REGRESSION: the allowlist must not over-suppress genuine bare quantities.
  const GENUINE_BARE_SENTENCES: ReadonlyArray<string> = [
    'the system shall store 42 records',
    'the buffer shall retain 128 blocks',
  ]

  for (const sentence of GENUINE_BARE_SENTENCES) {
    it(`GTWR_R6_MISSING_UNITS STILL fires on genuine bare quantity: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      const r6 = findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')
      expect(r6, `R6 should fire on "${sentence}"`).toBeDefined()
      if (!r6) return
      expect(r6.severity).toBe('error')
      assertSpanValid(r6, sentence)
    })
  }

  it('a mixed sentence flags the real bare number but not the standard id', () => {
    // "HTTP 401" is a standard id (suppressed); the trailing "5" is a genuine
    // bare quantity that must still be flagged by R6.
    const sentence = 'the auth service shall return HTTP 401 within 5'
    const findings = checkGtWRules(makeReq(sentence), sentence)
    const r6 = findings.filter((f) => f.code === 'GTWR_R6_MISSING_UNITS')
    // Exactly one R6 finding, and it points at the bare "5" — not the 401.
    expect(r6).toHaveLength(1)
    const finding = r6[0]!
    assertSpanValid(finding, sentence)
    expect(sentence.slice(finding.span[0], finding.span[1])).toBe('5')
  })
})
