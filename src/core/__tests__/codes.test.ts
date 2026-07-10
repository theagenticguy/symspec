import { describe, expect, it } from 'vitest'
import { buildCodeCatalog, ErrCodeMeta, ErrCodeSchema, ErrCodes, errCodeCatalog } from '../codes.js'

/**
 * AC-6-3 — the ERR_* enum is one of the three single-source code catalogs. It
 * must be append-only (never renumber/remove), every code must carry a
 * single-sourced `.describe()`, and (per the v2 scope change) the doc-load and
 * schema-version paths point the caller at re-creation via `symspec init`.
 */

/**
 * Append-only snapshot (AC-6-3). This frozen list is the shipped ERR_* order.
 * The guard below fails if any member is REMOVED or RENAMED — a new code may
 * only be APPENDED to the end (which is a deliberate edit to this list). Keep
 * additions at the tail.
 */
const ERR_CODES_SNAPSHOT = [
  'ERR_USAGE',
  'ERR_DOC_NOT_FOUND',
  'ERR_DOC_PARSE',
  'ERR_SCHEMA_VERSION',
  'ERR_IO',
  'ERR_DUPLICATE_ID',
  'ERR_NOT_FOUND',
  'ERR_INVALID_RELATION',
  'ERR_INVALID_ATTR',
  'ERR_NULL_REQUIRED',
  'ERR_PARSE_NO_MODAL',
  'ERR_PARSE_AMBIGUOUS_CLAUSES',
  'ERR_PARSE_COMPOUND',
  'ERR_PARSE_NOT_A_REQUIREMENT',
  'ERR_SOLVER_MISSING',
  'ERR_SOLVER_TIMEOUT',
  'ERR_SOLVER_INCONCLUSIVE',
  'ERR_LEAN_TOOLCHAIN_MISSING',
  'ERR_DOC_EXISTS',
] as const

describe('ErrCodeSchema (AC-6-3 — append-only ERR_* catalog)', () => {
  it('is append-only: no existing code was removed or renamed', () => {
    // Every shipped code still present, in its original position.
    for (const [i, code] of ERR_CODES_SNAPSHOT.entries()) {
      expect(ErrCodes[i]).toBe(code)
    }
    // Length may only grow (append). If this fails because you removed a code,
    // that is the violation the guard exists to catch.
    expect(ErrCodes.length).toBeGreaterThanOrEqual(ERR_CODES_SNAPSHOT.length)
    // The prefix must match exactly — appends are allowed, reorders are not.
    expect(ErrCodes.slice(0, ERR_CODES_SNAPSHOT.length)).toEqual([...ERR_CODES_SNAPSHOT])
  })

  it('every enum member has a matching described literal in ErrCodeMeta', () => {
    for (const code of ErrCodes) {
      const meta = ErrCodeMeta[code]
      expect(meta, `ErrCodeMeta is missing ${code}`).toBeDefined()
      expect(meta.value).toBe(code)
      expect(typeof meta.description).toBe('string')
      expect((meta.description ?? '').length).toBeGreaterThan(0)
    }
  })

  it('ErrCodeMeta describes exactly the enum members — no extras', () => {
    expect(Object.keys(ErrCodeMeta).sort()).toEqual([...ErrCodes].sort())
  })

  it('no ERR_* description carries v1/migration residue (v2 clean-slate scope)', () => {
    for (const code of ErrCodes) {
      expect(ErrCodeMeta[code].description ?? '').not.toMatch(/migrate|legacy|automerge/i)
    }
    // The doc-load / schema-version paths instead point at init + re-add.
    expect(ErrCodeMeta.ERR_DOC_PARSE.description).toMatch(/symspec init/)
    expect(ErrCodeMeta.ERR_SCHEMA_VERSION.description).toMatch(/symspec init/)
  })

  it('errCodeCatalog() derives every row from the enum + its .describe() corpus', () => {
    const cat = errCodeCatalog()
    expect(cat.map((r) => r.code)).toEqual([...ErrCodes])
    for (const row of cat) {
      expect(row.description).toBe(ErrCodeMeta[row.code].description)
    }
  })

  it('buildCodeCatalog reads live .describe() text — a mutated describe changes the row', () => {
    // Prove the catalog is DERIVED from `.describe()`, not a hand-copied string:
    // feed a clone of the corpus with one description changed and observe the
    // output row change. (This is the mechanism the manifest relies on.)
    const mutated = {
      ...ErrCodeMeta,
      ERR_USAGE: ErrCodeSchema.options.includes('ERR_USAGE')
        ? ErrCodeMeta.ERR_USAGE.describe('MUTATED-FOR-TEST')
        : ErrCodeMeta.ERR_USAGE,
    }
    const row = buildCodeCatalog(ErrCodes, mutated).find((r) => r.code === 'ERR_USAGE')
    expect(row?.description).toBe('MUTATED-FOR-TEST')
  })
})
