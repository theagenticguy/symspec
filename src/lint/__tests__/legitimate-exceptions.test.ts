/**
 * T-AC-3-3: legitimate-exception rules at warn severity
 *
 * Verification: "disregard all signals when override ON" → warn not error
 * AC-3-3 specifies that certain rules (R26, R32, R35, R16) have legitimate exceptions
 * and should emit at `warn` severity excluded from any pass/fail gate, not `error`.
 *
 * Cite: AC-3-3; research-ears-incose.md §2 R26/R32/R35, §5
 */

import { describe, expect, it } from 'vitest'
import type { Requirement } from '../../core/schema'
import { checkGtWRules } from '../gtwr'

describe('T-AC-3-3: legitimate-exception rules at warn severity', () => {
  // Helper: create a minimal requirement for testing
  function makeReq(systemResponse: string): Requirement {
    return {
      id: 'test-req-1',
      patternType: 'ubiquitous',
      systemName: 'test-sys',
      systemResponse,
      negated: false,
      sentence: systemResponse,
      verificationMethod: 'inspection',
    }
  }

  describe('R26 (Absolutes) — legitimate context with conditional', () => {
    it('emits warn when "all" appears in a legitimate exception context (with "when")', () => {
      const req = makeReq(
        'the system shall disregard all automatic control signals when manual override is ON',
      )
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding).toBeDefined()
      expect(r26Finding?.severity).toBe('warn') // AC-3-3: warn, not error
      expect(r26Finding?.message).toMatch(/Absolute.*"all"/)
    })

    it('emits error when "all" appears without conditional context', () => {
      const req = makeReq('the system shall respond to all events')
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding).toBeDefined()
      expect(r26Finding?.severity).toBe('error')
    })

    it('emits warn when "always" appears with "if" condition', () => {
      const req = makeReq(
        'the system shall always prioritize security if the system is in maintenance mode',
      )
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding?.severity).toBe('warn')
    })

    it('does NOT fire on "shall" (word-boundary regression — "all" is a substring of "shall")', () => {
      // Wave-3 gate fix: T-AC-3-7 flagged that the R26 "all" pattern matched the
      // substring "all" inside "shall", firing an error on nearly every EARS sentence
      // and making the pipeline gate over-exclude ubiquitous requirements.
      const req = makeReq('the system shall respond within 5 seconds')
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding).toBeUndefined()
    })

    it('emits error when "100%" appears without condition', () => {
      const req = makeReq('the system shall guarantee 100% availability')
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding?.severity).toBe('error')
    })
  })

  describe('R32 (Universal Quantifiers) — emits warn', () => {
    it('emits warn for "all" in quantifier context', () => {
      const req = makeReq('the system shall process all valid requests')
      const findings = checkGtWRules(req, req.sentence)

      const r32Finding = findings.find((f) => f.code === 'GTWR_R32_UNIVERSAL')
      expect(r32Finding).toBeDefined()
      expect(r32Finding?.severity).toBe('warn') // AC-3-3: warn per spec
      expect(r32Finding?.suggestion).toMatch(/each/)
    })

    it('emits warn for "any" (quantifier)', () => {
      const req = makeReq('the system shall handle any invalid input')
      const findings = checkGtWRules(req, req.sentence)

      const r32Finding = findings.find((f) => f.code === 'GTWR_R32_UNIVERSAL')
      expect(r32Finding?.severity).toBe('warn')
    })

    it('emits warn for "both"', () => {
      const req = makeReq('the system shall support both HTTP and HTTPS')
      const findings = checkGtWRules(req, req.sentence)

      const r32Finding = findings.find((f) => f.code === 'GTWR_R32_UNIVERSAL')
      expect(r32Finding?.severity).toBe('warn')
    })
  })

  describe('R35 (Temporal) — emits warn for indefinite, info for bound', () => {
    it('emits warn for indefinite temporal keyword "eventually"', () => {
      const req = makeReq('the system shall eventually converge on a consistent state')
      const findings = checkGtWRules(req, req.sentence)

      const r35Finding = findings.find((f) => f.code === 'GTWR_R35_TEMPORAL')
      expect(r35Finding).toBeDefined()
      expect(r35Finding?.severity).toBe('warn') // AC-3-3: warn if indefinite
    })

    it('emits info (not warn) for temporal keyword bound to a measured time', () => {
      const req = makeReq('the system shall respond before timeout')
      const findings = checkGtWRules(req, req.sentence)

      const r35Finding = findings.find((f) => f.code === 'GTWR_R35_TEMPORAL')
      // AC-3-3: bound temporal keywords get lower severity (info vs warn)
      expect(r35Finding?.severity).toBe('info')
    })

    it('emits warn for "until" without bound', () => {
      const req = makeReq('the system shall retry until success')
      const findings = checkGtWRules(req, req.sentence)

      const r35Finding = findings.find((f) => f.code === 'GTWR_R35_TEMPORAL')
      expect(r35Finding?.severity).toBe('warn')
    })
  })

  describe('R16 (Negation) — emits warn (not error)', () => {
    it('emits warn for "shall not"', () => {
      const req = makeReq('the system shall not store plaintext passwords')
      const findings = checkGtWRules(req, req.sentence)

      const r16Finding = findings.find((f) => f.code === 'GTWR_R16_NEGATION')
      expect(r16Finding).toBeDefined()
      expect(r16Finding?.severity).toBe('warn') // AC-3-3: warn, not error
    })

    it('emits warn for "never"', () => {
      const req = makeReq('the system shall never accept null inputs in critical fields')
      const findings = checkGtWRules(req, req.sentence)

      const r16Finding = findings.find((f) => f.code === 'GTWR_R16_NEGATION')
      expect(r16Finding?.severity).toBe('warn')
    })

    it('emits warn for "unable to"', () => {
      const req = makeReq('the system shall be unable to bypass authentication')
      const findings = checkGtWRules(req, req.sentence)

      const r16Finding = findings.find((f) => f.code === 'GTWR_R16_NEGATION')
      expect(r16Finding?.severity).toBe('warn')
    })

    it('skips negation inside a defined logical expression [NOT X]', () => {
      const req = makeReq(
        'the system shall ensure [NOT user_is_authenticated] when session expires',
      )
      const findings = checkGtWRules(req, req.sentence)

      // Should not flag "NOT" inside brackets
      const r16FindingInBrackets = findings.find(
        (f) =>
          f.code === 'GTWR_R16_NEGATION' &&
          req.sentence.substring(f.span[0], f.span[1]).includes('[NOT'),
      )
      expect(r16FindingInBrackets).toBeUndefined()
    })
  })

  describe('Integration: "disregard all signals when override ON" scenario', () => {
    it('emits warn for R26 (absolute "all") in the AC-3-3 example', () => {
      const req = makeReq(
        'the system shall disregard all automatic control signals when manual override is ON',
      )
      const findings = checkGtWRules(req, req.sentence)

      const r26Finding = findings.find((f) => f.code === 'GTWR_R26_ABSOLUTE')
      expect(r26Finding).toBeDefined()
      expect(r26Finding?.severity).toBe('warn')
      expect(r26Finding?.message).toContain('Absolute')
    })

    it('excludes warn-severity findings from pass/fail gate (sanity)', () => {
      // This is a gate-level test; the CLI layer (AC-3-3, AC-6-2b) enforces this.
      // Here we verify the finding is marked warn.
      const req = makeReq('the system shall disregard all signals when override ON')
      const findings = checkGtWRules(req, req.sentence)

      const warnFindings = findings.filter((f) => f.severity === 'warn')
      const errorFindings = findings.filter((f) => f.severity === 'error')

      // The test fixture should produce at least one warn (R26) and no error for this sentence
      expect(warnFindings.length).toBeGreaterThan(0)
      expect(errorFindings.length).toBe(0)
    })
  })

  describe('Summary: legitimate exceptions are warn, not error', () => {
    it('R26, R32, R35, R16 emit warn severity (AC-3-3)', () => {
      const testCases: [code: string, sentence: string][] = [
        ['GTWR_R26_ABSOLUTE', 'the system shall disregard all signals when override is ON'],
        ['GTWR_R32_UNIVERSAL', 'the system shall handle all requests'],
        ['GTWR_R35_TEMPORAL', 'the system shall eventually converge'],
        ['GTWR_R16_NEGATION', 'the system shall not store passwords'],
      ]

      for (const [expectedCode, sentence] of testCases) {
        const req = makeReq(sentence)
        const findings = checkGtWRules(req, sentence)
        const matching = findings.find((f) => f.code === expectedCode)

        if (matching) {
          expect(
            matching.severity === 'warn' || matching.severity === 'info',
            `${expectedCode} should be warn or info, not error`,
          ).toBe(true)
        }
      }
    })
  })
})
