/**
 * Exit-code contract tests: `exitCodeForEnvelope` is a PURE, TOTAL function of
 * the envelope's semantics.
 *
 * G1 ships no finding-producing operation, so codes `1` and `3` are unreachable
 * from the CLI today. They are tested in full anyway — the mapping is the
 * contract `check` (G2) plugs into, and a gate invented alongside the detector
 * that needs it is a gate nobody reviewed.
 */

import { describe, expect, it } from 'vitest'
import {
  EXIT_CLEAN,
  EXIT_CODES,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  EXIT_OPERATIONAL_ERROR,
} from '../../ports/exit.ts'
import { failure, ok } from './envelope.ts'
import { exitCodeForEnvelope, hasErrorSeverityFinding, hasFailedStrictGate } from './exit.ts'

const finding = (severity: string) => ({ code: 'FND_X', severity })

describe('the four exit codes', () => {
  it('are 0 / 1 / 2 / 3 — v4 contract, unchanged', () => {
    expect(EXIT_CLEAN).toBe(0)
    expect(EXIT_FINDINGS_FAILURE).toBe(1)
    expect(EXIT_OPERATIONAL_ERROR).toBe(2)
    expect(EXIT_INCONCLUSIVE).toBe(3)
  })

  it('EXIT_CODES lists them all in ascending order', () => {
    expect(EXIT_CODES).toEqual([0, 1, 2, 3])
  })
})

describe('exitCodeForEnvelope() — 2: operational failure', () => {
  it('maps any error envelope to 2', () => {
    expect(exitCodeForEnvelope(failure({ error: 'e', code: 'ERR_IO' }))).toBe(2)
    expect(exitCodeForEnvelope(failure({ error: 'e', code: 'ERR_NOT_FOUND' }))).toBe(2)
  })

  it('maps to 2 regardless of what the error carries', () => {
    const env = failure({
      error: 'e',
      code: 'ERR_PARSE_COMPOUND',
      suggestions: ['split it'],
      partial: { systemName: 's' },
      repair: { ops: [{ op: 'add' }], commands: ['symspec apply'] },
    })
    expect(exitCodeForEnvelope(env)).toBe(2)
  })
})

describe('exitCodeForEnvelope() — 0: clean', () => {
  it('maps a success with no findings to 0', () => {
    expect(exitCodeForEnvelope(ok('manifest', { operations: [] }))).toBe(0)
  })

  it('maps a success with an EMPTY findings array to 0', () => {
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [] }))).toBe(0)
  })

  it('maps warn/info-only findings to 0 — those are deliberately not gated', () => {
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [finding('warn')] }))).toBe(0)
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [finding('info')] }))).toBe(0)
    expect(
      exitCodeForEnvelope(
        ok('checkReport', { findings: [finding('warn'), finding('info'), finding('warn')] }),
      ),
    ).toBe(0)
  })

  it('maps a non-object / findings-less payload to 0 rather than throwing', () => {
    expect(exitCodeForEnvelope(ok('version', null))).toBe(0)
    expect(exitCodeForEnvelope(ok('version', '1.0.0'))).toBe(0)
    expect(exitCodeForEnvelope(ok('version', 42))).toBe(0)
    expect(exitCodeForEnvelope(ok('version', undefined))).toBe(0)
    // `findings` present but not an array ⇒ read defensively, no findings.
    expect(exitCodeForEnvelope(ok('checkReport', { findings: 'nope' }))).toBe(0)
  })
})

describe('exitCodeForEnvelope() — 1: findings failure', () => {
  it('maps a single error-severity finding to 1', () => {
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [finding('error')] }))).toBe(1)
  })

  it('maps a mixed set containing one error-severity finding to 1', () => {
    expect(
      exitCodeForEnvelope(
        ok('checkReport', { findings: [finding('info'), finding('error'), finding('warn')] }),
      ),
    ).toBe(1)
  })

  it('still emits a SUCCESS envelope shape — 1 is a gate signal, not a crash', () => {
    const env = ok('checkReport', { findings: [finding('error')] })
    expect(env.type).toBe('checkReport')
    expect(exitCodeForEnvelope(env)).toBe(1)
  })
})

describe('exitCodeForEnvelope() — 3: inconclusive', () => {
  it('maps a tripped strict gate with no error finding to 3', () => {
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [], strictGate: 'fail' }))).toBe(3)
  })

  it('maps a tripped gate alongside warn/info findings to 3', () => {
    expect(
      exitCodeForEnvelope(ok('checkReport', { findings: [finding('warn')], strictGate: 'fail' })),
    ).toBe(3)
  })

  it('is NOT reachable when the gate was not requested (default run never returns 3)', () => {
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [] }))).toBe(0)
    expect(exitCodeForEnvelope(ok('checkReport', { findings: [], strictGate: 'pass' }))).toBe(0)
  })
})

describe('precedence: a proven defect OUTRANKS the strict gate', () => {
  it('maps error-finding + tripped gate to 1, not 3', () => {
    expect(
      exitCodeForEnvelope(ok('checkReport', { findings: [finding('error')], strictGate: 'fail' })),
    ).toBe(1)
  })

  it('orders the whole mapping 2 > 1 > 3 > 0', () => {
    // An error envelope wins outright.
    expect(exitCodeForEnvelope(failure({ error: 'e', code: 'ERR_IO' }))).toBe(2)
    // Then error findings, then the gate, then clean.
    expect(exitCodeForEnvelope(ok('c', { findings: [finding('error')], strictGate: 'fail' }))).toBe(
      1,
    )
    expect(exitCodeForEnvelope(ok('c', { findings: [finding('warn')], strictGate: 'fail' }))).toBe(
      3,
    )
    expect(exitCodeForEnvelope(ok('c', { findings: [finding('warn')] }))).toBe(0)
  })
})

describe('purity: rendering flags have no channel to the exit code', () => {
  it('returns the same code for the same semantics regardless of payload extras', () => {
    // `--dense`/`--pretty`/`--field` live outside the envelope, so the only way
    // to prove they cannot reach the code is that the function takes ONLY the
    // envelope. Adding presentational-looking keys changes nothing.
    const base = ok('checkReport', { findings: [finding('error')] })
    const withNoise = ok('checkReport', {
      findings: [finding('error')],
      dense: true,
      pretty: true,
      field: 'data.verified',
    })
    expect(exitCodeForEnvelope(withNoise)).toBe(exitCodeForEnvelope(base))
  })

  it('is deterministic across repeated calls (no hidden state)', () => {
    const env = ok('checkReport', { findings: [finding('error')] })
    expect([1, 2, 3].map(() => exitCodeForEnvelope(env))).toEqual([1, 1, 1])
  })
})

describe('predicates read defensively and never throw', () => {
  it('hasErrorSeverityFinding tolerates junk', () => {
    for (const junk of [null, undefined, 0, 'str', [], {}, { findings: null }, { findings: 7 }]) {
      expect(() => hasErrorSeverityFinding(junk)).not.toThrow()
      expect(hasErrorSeverityFinding(junk)).toBe(false)
    }
  })

  it('hasErrorSeverityFinding ignores non-object and severity-less findings', () => {
    expect(hasErrorSeverityFinding({ findings: [null, 'x', 3, {}] })).toBe(false)
    expect(hasErrorSeverityFinding({ findings: [{ severity: 'ERROR' }] })).toBe(false)
    expect(hasErrorSeverityFinding({ findings: [{ severity: 'error' }] })).toBe(true)
  })

  it('hasFailedStrictGate tolerates junk and only fires on exactly "fail"', () => {
    for (const junk of [null, undefined, 0, 'str', [], {}]) {
      expect(() => hasFailedStrictGate(junk)).not.toThrow()
      expect(hasFailedStrictGate(junk)).toBe(false)
    }
    expect(hasFailedStrictGate({ strictGate: 'fail' })).toBe(true)
    expect(hasFailedStrictGate({ strictGate: 'FAIL' })).toBe(false)
    expect(hasFailedStrictGate({ strictGate: true })).toBe(false)
  })
})
