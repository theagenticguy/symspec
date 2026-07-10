import { describe, expect, it } from 'vitest'
import { failure, success } from '../envelope.js'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_OPERATIONAL_ERROR,
  exitCodeForEnvelope,
  hasErrorSeverityFinding,
} from '../exit.js'

/**
 * AC-6-2b: the `check` exit-code contract.
 *   - clean spec → exit 0 (envelope still on stdout);
 *   - spec with an error-severity finding → exit 1, findings envelope on stdout;
 *   - a missing document → exit 2 with an ERR_DOC_NOT_FOUND envelope;
 *   - warn/info-only findings → exit 0.
 * Output flags (`--json`/`--dense`/`--pretty`) never change the exit code.
 */

const errorFinding = (code: string) => ({ code, severity: 'error' as const, message: 'x' })
const warnFinding = (code: string) => ({ code, severity: 'warn' as const, message: 'x' })
const infoFinding = (code: string) => ({ code, severity: 'info' as const, message: 'x' })

describe('exitCodeForEnvelope — clean run (AC-6-2b)', () => {
  it('a completed pipeline with no findings exits 0', () => {
    const env = success('check', { findings: [] })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_CLEAN)
    expect(EXIT_CLEAN).toBe(0)
  })

  it('a success envelope whose data omits findings entirely exits 0', () => {
    const env = success('show', { id: 'REQ-1' })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_CLEAN)
  })
})

describe('exitCodeForEnvelope — findings-failure (AC-6-2b)', () => {
  it('an error-severity finding exits 1 while the success envelope stays on stdout', () => {
    const env = success('check', {
      findings: [warnFinding('GTWR_R7_VAGUE'), errorFinding('GTWR_R1_PATTERN')],
    })
    // Exit 1 (findings-failure)...
    expect(exitCodeForEnvelope(env)).toBe(EXIT_FINDINGS_FAILURE)
    expect(EXIT_FINDINGS_FAILURE).toBe(1)
    // ...but the envelope is STILL a valid success envelope (findings are the data).
    expect(env.type).toBe('check')
    expect(env.type).not.toBe('error')
  })

  it('a single error-severity finding among many is enough to fail', () => {
    const env = success('check', {
      findings: [
        infoFinding('FND_INCOMPLETE'),
        warnFinding('GTWR_R7_VAGUE'),
        errorFinding('GTWR_R1_PATTERN'),
      ],
    })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_FINDINGS_FAILURE)
  })
})

describe('exitCodeForEnvelope — warn/info-only is clean (AC-3-3 / AC-6-2b)', () => {
  it('warn-only findings exit 0', () => {
    const env = success('check', { findings: [warnFinding('GTWR_R26_ABSOLUTE')] })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_CLEAN)
  })

  it('info-only findings exit 0', () => {
    const env = success('check', { findings: [infoFinding('FND_SIMILAR_UNUNIFIED')] })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_CLEAN)
  })

  it('mixed warn + info (no error) findings exit 0', () => {
    const env = success('check', {
      findings: [warnFinding('GTWR_R26_ABSOLUTE'), infoFinding('FND_NEEDS_REVIEW')],
    })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_CLEAN)
  })
})

describe('exitCodeForEnvelope — operational ERR_* failure (AC-6-2b)', () => {
  it('a missing document exits 2 with an ERR_DOC_NOT_FOUND error envelope', () => {
    const env = failure({
      error: 'no such document: spec.symspec.json',
      code: 'ERR_DOC_NOT_FOUND',
      suggestions: ['create it with `symspec init`'],
    })
    expect(exitCodeForEnvelope(env)).toBe(EXIT_OPERATIONAL_ERROR)
    expect(EXIT_OPERATIONAL_ERROR).toBe(2)
    expect(env.type).toBe('error')
    expect(env.code).toBe('ERR_DOC_NOT_FOUND')
  })

  it('every ERR_* class of failure exits 2, distinct from a findings-failure', () => {
    for (const code of ['ERR_USAGE', 'ERR_IO', 'ERR_DOC_PARSE', 'ERR_SOLVER_MISSING'] as const) {
      expect(exitCodeForEnvelope(failure({ error: 'x', code }))).toBe(EXIT_OPERATIONAL_ERROR)
    }
  })

  it('operational error (2) is distinct from findings-failure (1)', () => {
    const opErr = exitCodeForEnvelope(failure({ error: 'x', code: 'ERR_IO' }))
    const findingsErr = exitCodeForEnvelope(
      success('check', { findings: [errorFinding('GTWR_R1_PATTERN')] }),
    )
    expect(opErr).not.toBe(findingsErr)
    expect(opErr).toBe(2)
    expect(findingsErr).toBe(1)
  })
})

describe('exitCodeForEnvelope — the three codes are distinct (AC-6-2b)', () => {
  it('0, 1, 2 are pairwise distinct', () => {
    expect(new Set([EXIT_CLEAN, EXIT_FINDINGS_FAILURE, EXIT_OPERATIONAL_ERROR]).size).toBe(3)
  })
})

describe('hasErrorSeverityFinding predicate', () => {
  it('is true only when an error-severity finding is present', () => {
    expect(hasErrorSeverityFinding({ findings: [errorFinding('X')] })).toBe(true)
    expect(hasErrorSeverityFinding({ findings: [warnFinding('X')] })).toBe(false)
    expect(hasErrorSeverityFinding({ findings: [infoFinding('X')] })).toBe(false)
    expect(hasErrorSeverityFinding({ findings: [] })).toBe(false)
  })

  it('is defensive against a non-object / missing / non-array payload', () => {
    expect(hasErrorSeverityFinding(undefined)).toBe(false)
    expect(hasErrorSeverityFinding(null)).toBe(false)
    expect(hasErrorSeverityFinding('nope')).toBe(false)
    expect(hasErrorSeverityFinding({})).toBe(false)
    expect(hasErrorSeverityFinding({ findings: 'not-an-array' })).toBe(false)
    expect(hasErrorSeverityFinding({ findings: [null, 42, 'x'] })).toBe(false)
  })
})
