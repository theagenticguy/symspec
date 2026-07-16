/**
 * `--field <paths>` jq-style projection (parseFieldPaths + projectFields).
 * A pure OUTPUT projection: reduce an envelope object to just the requested
 * dotted paths, nesting the result to mirror those paths, omitting misses.
 */

import { describe, expect, it } from 'vitest'
import { parseFieldPaths, projectFields } from '../field.js'

const envelope = {
  apiVersion: 1,
  type: 'check',
  data: {
    verified: false,
    coverage: {
      excluded: 2,
      demotions: [{ reason: 'uncovered-requirement', requirementIds: ['R1'] }],
    },
    findings: [{ code: 'FND_CONTRADICTION' }, { code: 'FND_ORPHAN' }],
  },
}

describe('parseFieldPaths', () => {
  it('splits comma-separated paths and trims whitespace', () => {
    expect(parseFieldPaths('data.verified, data.coverage.excluded')).toEqual([
      'data.verified',
      'data.coverage.excluded',
    ])
  })

  it('drops empty segments from trailing/duplicate commas', () => {
    expect(parseFieldPaths('data.verified,,')).toEqual(['data.verified'])
  })
})

describe('projectFields', () => {
  it('projects a single top-level nested field', () => {
    expect(projectFields(envelope, ['data.verified'])).toEqual({ data: { verified: false } })
  })

  it('projects a deeper nested field', () => {
    expect(projectFields(envelope, ['data.coverage.excluded'])).toEqual({
      data: { coverage: { excluded: 2 } },
    })
  })

  it('merges multiple paths into one nested object', () => {
    expect(projectFields(envelope, ['data.verified', 'data.coverage.excluded'])).toEqual({
      data: { verified: false, coverage: { excluded: 2 } },
    })
  })

  it('omits an unresolved path rather than emitting null', () => {
    expect(projectFields(envelope, ['data.nope'])).toEqual({})
    // A missing path alongside a present one keeps only the present one.
    expect(projectFields(envelope, ['data.verified', 'data.nope.deep'])).toEqual({
      data: { verified: false },
    })
  })

  it('indexes into arrays by numeric segment', () => {
    expect(projectFields(envelope, ['data.findings.0.code'])).toEqual({
      data: { findings: { '0': { code: 'FND_CONTRADICTION' } } },
    })
    // Out-of-range index ⇒ omitted.
    expect(projectFields(envelope, ['data.findings.9.code'])).toEqual({})
  })

  it('returns {} when no path resolves (truthful nothing-matched, never throws)', () => {
    expect(projectFields(envelope, ['nope', 'also.nope'])).toEqual({})
  })
})
