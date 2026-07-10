import { describe, expect, it } from 'vitest'
import { buildCodeCatalog } from '../../core/codes.js'
import { GtwrCodeMeta, GtwrCodes } from '../codes.js'

/**
 * AC-6-3 — the GTWR_* enum is one of the three single-source code catalogs.
 * It must be append-only, and every code must carry a single-sourced
 * `.describe()` the manifest derives its GTWR table from. (Fixture-level
 * reachability — that every code is produced by a real emitter — is asserted
 * in gtwr.test.ts against the rule engine.)
 */

/**
 * Append-only snapshot (AC-6-3). Frozen shipped GTWR_* order. Appends allowed
 * at the tail; removals/renames/reorders fail the guard.
 */
const GTWR_CODES_SNAPSHOT = [
  'GTWR_R1_PATTERN',
  'GTWR_R2_PASSIVE',
  'GTWR_R5_INDEFINITE_ARTICLE',
  'GTWR_R6_MISSING_UNITS',
  'GTWR_R7_VAGUE',
  'GTWR_R8_ESCAPE',
  'GTWR_R9_OPEN_ENDED',
  'GTWR_R10_SUPERFLUOUS_INFINITIVE',
  'GTWR_R15_LOGICAL_EXPR',
  'GTWR_R16_NEGATION',
  'GTWR_R17_OBLIQUE',
  'GTWR_R18_MULTIPLE_SHALL',
  'GTWR_R19_COMBINATOR',
  'GTWR_R20_PURPOSE',
  'GTWR_R21_PARENTHESES',
  'GTWR_R24_PRONOUN',
  'GTWR_R26_ABSOLUTE',
  'GTWR_R32_UNIVERSAL',
  'GTWR_R33_MISSING_TOLERANCE',
  'GTWR_R34_IMMEASURABLE',
  'GTWR_R35_TEMPORAL',
  'GTWR_R37_ACRONYM',
  'GTWR_R38_ABBREVIATION',
  'GTWR_R40_DECIMAL_FORMAT',
] as const

describe('GtwrCodeSchema (AC-6-3 — append-only GTWR_* catalog)', () => {
  it('is append-only: no existing code was removed, renamed, or reordered', () => {
    expect(GtwrCodes.slice(0, GTWR_CODES_SNAPSHOT.length)).toEqual([...GTWR_CODES_SNAPSHOT])
    expect(GtwrCodes.length).toBeGreaterThanOrEqual(GTWR_CODES_SNAPSHOT.length)
  })

  it('every enum member has a matching described literal in GtwrCodeMeta', () => {
    for (const code of GtwrCodes) {
      const meta = GtwrCodeMeta[code]
      expect(meta, `GtwrCodeMeta is missing ${code}`).toBeDefined()
      expect(meta.value).toBe(code)
      expect((meta.description ?? '').length).toBeGreaterThan(0)
    }
  })

  it('GtwrCodeMeta describes exactly the enum members — no extras', () => {
    expect(Object.keys(GtwrCodeMeta).sort()).toEqual([...GtwrCodes].sort())
  })

  it('buildCodeCatalog reads live .describe() text (single-source for the manifest)', () => {
    const cat = buildCodeCatalog(GtwrCodes, GtwrCodeMeta)
    expect(cat.map((r) => r.code)).toEqual([...GtwrCodes])
    for (const row of cat) {
      expect(row.description).toBe(GtwrCodeMeta[row.code].description)
    }
  })
})
