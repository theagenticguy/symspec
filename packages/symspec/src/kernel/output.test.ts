/**
 * Tests for the output post-processors.
 *
 * The claim that actually matters is the NEGATIVE one: no output flag can change
 * an exit code. It is asserted two ways — in-process, by computing
 * `exitCodeForEnvelope` across every flag combination, and (in `cli.test.ts`)
 * end-to-end against the shipped bundle, because an in-process check would pass
 * even if the CLI wiring rendered before computing the code.
 *
 * Everything else here pins the shape of each mode: what `--field` does with an
 * unresolved path (omits it), what `--dense` elides (evidence, unless kept), and
 * what `--pretty` guarantees (that it is NOT parseable as JSON, so a script that
 * passes it by accident fails loudly instead of reading prose as data).
 */

import { describe, expect, it } from 'vitest'
import { API_VERSION, type Envelope, failure, ok } from './envelope.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_OPERATIONAL_ERROR,
  exitCodeForEnvelope,
} from './exit.ts'
import {
  densifyValue,
  ELIDED_KEY,
  minifyJson,
  type OutputFlags,
  parseFieldPaths,
  projectFields,
  renderOutput,
  renderProse,
} from './output.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const success = ok('report', {
  verified: false,
  findings: [
    { code: 'FND_CONTRADICTION', severity: 'error', evidence: { atomTable: ['a', 'b'] } },
    { code: 'GTWR_R6_MISSING_UNITS', severity: 'warn' },
  ],
  counts: { error: 1, warn: 1 },
})

const errorEnvelope = failure({
  error: 'Unknown code: ERR_BOGUS',
  code: 'ERR_NOT_FOUND',
  suggestions: ['Did you mean ERR_NOT_FOUND?', 'Run `symspec manifest`.'],
  repair: { ops: [{ op: 'add', key: 'G1' }], commands: ['symspec explain --code ERR_NOT_FOUND'] },
})

/** Every combination of the four output flags — 2^3 booleans x field on/off. */
const allFlagCombinations = (): readonly OutputFlags[] => {
  const out: OutputFlags[] = []
  for (const pretty of [false, true]) {
    for (const dense of [false, true]) {
      for (const evidence of [false, true]) {
        for (const field of [null, 'data.verified', 'nope.nothing']) {
          out.push({ pretty, dense, evidence, field })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// THE INVARIANT: output flags never change the exit code
// ---------------------------------------------------------------------------

describe('output flags NEVER change the exit code', () => {
  const cases: readonly (readonly [string, Envelope, number])[] = [
    ['a clean success', ok('version', { version: '1' }), EXIT_CLEAN],
    ['a success with an error finding', success, EXIT_FINDINGS_FAILURE],
    ['an error envelope', errorEnvelope, EXIT_OPERATIONAL_ERROR],
  ]

  for (const [label, env, expected] of cases) {
    it(`holds for ${label} across all ${allFlagCombinations().length} flag combinations`, () => {
      for (const flags of allFlagCombinations()) {
        // The rendering runs, and the code is computed from the ENVELOPE. The
        // structural reason this cannot fail: `exitCodeForEnvelope` is not given
        // the flags, so there is no channel for them to reach it.
        renderOutput(env, flags)
        expect(exitCodeForEnvelope(env), JSON.stringify(flags)).toBe(expected)
      }
    })
  }

  it('renders SOMETHING non-empty in every combination — no flag silences output', () => {
    for (const [, env] of cases) {
      for (const flags of allFlagCombinations()) {
        expect(renderOutput(env, flags).length, JSON.stringify(flags)).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The default: JSON, no flag required
// ---------------------------------------------------------------------------

describe('JSON is the zero-flag default', () => {
  it('emits one line of parseable JSON with no flags at all', () => {
    const out = renderOutput(success)
    expect(out.split('\n')).toHaveLength(1)
    expect(JSON.parse(out)).toEqual(success)
  })

  it('emits the same bytes for {} and for all-false flags', () => {
    expect(renderOutput(success)).toBe(
      renderOutput(success, { pretty: false, dense: false, evidence: false, field: null }),
    )
  })

  it('preserves the envelope byte-for-byte — the default is not a projection', () => {
    expect(JSON.parse(renderOutput(errorEnvelope))).toEqual(errorEnvelope)
  })
})

// ---------------------------------------------------------------------------
// --field
// ---------------------------------------------------------------------------

describe('--field: dotted-path projection', () => {
  it('parses comma-separated paths, dropping blanks', () => {
    expect(parseFieldPaths('data.a, data.b ,, data.c')).toEqual(['data.a', 'data.b', 'data.c'])
    expect(parseFieldPaths('  ')).toEqual([])
  })

  it('NESTS the result to mirror the requested path', () => {
    // Nesting (not flattening) is what makes the projection self-describing and
    // lets overlapping paths merge instead of colliding on a leaf name.
    expect(projectFields(success, ['data.verified'])).toEqual({ data: { verified: false } })
  })

  it('merges multiple overlapping paths into one object', () => {
    expect(projectFields(success, ['data.verified', 'data.counts.error'])).toEqual({
      data: { verified: false, counts: { error: 1 } },
    })
  })

  it('indexes into an array with a numeric segment', () => {
    expect(projectFields(success, ['data.findings.0.code'])).toEqual({
      data: { findings: { '0': { code: 'FND_CONTRADICTION' } } },
    })
  })

  it('OMITS an unresolved path rather than emitting null', () => {
    expect(projectFields(success, ['data.nope'])).toEqual({})
    expect(projectFields(success, ['data.findings.99.code'])).toEqual({})
    expect(projectFields(success, ['data.verified.deeper'])).toEqual({})
  })

  it('returns {} when nothing resolves — a truthful "no match", not an error', () => {
    expect(() => projectFields(success, ['a.b.c'])).not.toThrow()
    expect(projectFields(success, ['a.b.c'])).toEqual({})
  })

  it('keeps a resolved path when a SIBLING path does not resolve', () => {
    expect(projectFields(success, ['data.verified', 'data.nope'])).toEqual({
      data: { verified: false },
    })
  })

  it('projects the whole envelope header too, not just data', () => {
    expect(projectFields(success, ['type', 'apiVersion'])).toEqual({
      type: 'report',
      apiVersion: API_VERSION,
    })
  })

  it('renders as JSON even under --pretty — a projection feeds a consumer', () => {
    const out = renderOutput(success, { pretty: true, field: 'data.verified' })
    expect(JSON.parse(out)).toEqual({ data: { verified: false } })
  })

  it('composes with --dense: project first, then minify and elide', () => {
    const out = renderOutput(success, { dense: true, field: 'data.findings.0' })
    const parsed = JSON.parse(out) as { data: { findings: Record<string, object> } }
    expect(parsed.data.findings['0']).not.toHaveProperty(ELIDED_KEY)
    expect(parsed.data.findings['0']).toMatchObject({ code: 'FND_CONTRADICTION' })
  })

  it('a blank --field value is ignored, not treated as a projection of nothing', () => {
    expect(renderOutput(success, { field: '   ' })).toBe(renderOutput(success))
  })

  it('never mutates its input', () => {
    const before = JSON.stringify(success)
    projectFields(success, ['data.verified', 'data.findings.0.code'])
    expect(JSON.stringify(success)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// --dense
// ---------------------------------------------------------------------------

describe('--dense: minify + elide evidence', () => {
  it('minifies — no pretty-print whitespace', () => {
    const out = renderOutput(success, { dense: true })
    expect(out).not.toContain('\n')
    expect(out).not.toContain('  ')
  })

  it('elides `evidence` wherever it appears', () => {
    const out = renderOutput(success, { dense: true })
    expect(out).not.toContain(ELIDED_KEY)
    expect(out).not.toContain('atomTable')
  })

  it('KEEPS evidence when --evidence is passed', () => {
    const out = renderOutput(success, { dense: true, evidence: true })
    expect(out).toContain('atomTable')
  })

  it('elides evidence at ANY depth, not just the top level', () => {
    const deep = ok('x', { a: { b: { c: [{ evidence: 'heavy', code: 'K' }] } } })
    const out = renderOutput(deep, { dense: true })
    expect(out).not.toContain('heavy')
    expect(out).toContain('"code":"K"')
  })

  it('drops nulls — a canonical envelope has none, so this is information-preserving', () => {
    expect(densifyValue({ a: 1, b: null, c: { d: null, e: 2 } }, false)).toEqual({
      a: 1,
      c: { e: 2 },
    })
  })

  it('never abbreviates a field NAME — dense is one format, not a second dialect', () => {
    const dense = JSON.parse(renderOutput(success, { dense: true, evidence: true })) as Envelope
    expect(dense).toEqual(success)
  })

  it('is still a parseable envelope an agent can switch on', () => {
    const parsed = JSON.parse(renderOutput(errorEnvelope, { dense: true })) as {
      type: string
      code: string
    }
    expect(parsed.type).toBe('error')
    expect(parsed.code).toBe('ERR_NOT_FOUND')
  })

  it('preserves array element order', () => {
    expect(densifyValue([3, 1, 2], false)).toEqual([3, 1, 2])
  })

  it('leaves scalars alone', () => {
    for (const v of [1, 'x', true, false, 0, '']) expect(densifyValue(v, false)).toBe(v)
  })

  it('minifyJson matches JSON.stringify with no indent', () => {
    expect(minifyJson({ a: [1, 2] })).toBe('{"a":[1,2]}')
  })

  it('the guard FIRES: without eliding, evidence IS present', () => {
    // Negative control for the elision assertions above.
    expect(renderOutput(success, { dense: true, evidence: true })).toContain(ELIDED_KEY)
  })
})

// ---------------------------------------------------------------------------
// --pretty
// ---------------------------------------------------------------------------

describe('--pretty: prose that is deliberately NOT JSON', () => {
  it('is not parseable as JSON — a script that passes it by mistake fails loudly', () => {
    // The feature: silently reading prose as data would be a much worse failure
    // than a JSON parse error.
    expect(() => JSON.parse(renderOutput(success, { pretty: true }))).toThrow()
  })

  it('leads a success with the type and apiVersion', () => {
    expect(renderOutput(ok('version', { version: '1' }), { pretty: true })).toContain(
      `version (apiVersion ${API_VERSION})`,
    )
  })

  it('leads a failure with the CODE and the message', () => {
    expect(renderProse(errorEnvelope).split('\n')[0]).toBe(
      'Error [ERR_NOT_FOUND]: Unknown code: ERR_BOGUS',
    )
  })

  it('renders every suggestion as a bullet', () => {
    const out = renderProse(errorEnvelope)
    for (const s of errorEnvelope.suggestions ?? []) expect(out).toContain(`- ${s}`)
  })

  it('renders the repair commands and op records', () => {
    const out = renderProse(errorEnvelope)
    expect(out).toContain('symspec explain --code ERR_NOT_FOUND')
    expect(out).toContain('{"op":"add","key":"G1"}')
  })

  it('omits repair sections entirely when there is no repair', () => {
    const bare = failure({ error: 'x', code: 'ERR_IO' })
    expect(renderProse(bare)).not.toContain('Repair')
  })

  it('spells out (none) and (empty) rather than leaving a blank line', () => {
    // A blank line in a human report is ambiguous between "no value" and "a bug".
    const env = ok('x', { nothing: null, emptyList: [], emptyObj: {} })
    const out = renderProse(env)
    expect(out).toContain('(none)')
    expect(out).toContain('(empty)')
  })

  it('indents nested structures', () => {
    const out = renderProse(ok('x', { outer: { inner: 1 } }))
    expect(out).toContain('outer:')
    expect(out).toContain('    inner: 1')
  })

  it('renders strings unquoted — quoting is JSON`s job, not prose`s', () => {
    expect(renderProse(ok('x', { name: 'auth service' }))).toContain('name: auth service')
  })

  it('DENSE wins when both --dense and --pretty are passed', () => {
    // A machine consumer misreading prose is a harder failure than a human
    // squinting at minified JSON, so the machine mode takes precedence.
    const out = renderOutput(success, { dense: true, pretty: true })
    expect(() => JSON.parse(out)).not.toThrow()
  })
})
