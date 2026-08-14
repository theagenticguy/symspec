/**
 * ERR_* catalog tests, including the APPEND-ONLY guard.
 *
 * The codes are the API agents switch on, so the catalog's stability is a
 * stronger contract than any single behavior in this package: an agent with a
 * `case 'ERR_SOLVER_MISSING':` branch breaks silently if that code is renamed.
 * The snapshot below is the executable form of the append-only rule.
 */

import { Effect, Runtime } from 'effect'
import { describe, expect, it } from 'vitest'
import { isErrorEnvelope } from './envelope.ts'
import {
  descriptionOf,
  ERR_CLASSES,
  ERR_CODES,
  ErrDocParse,
  ErrIo,
  ErrNotFound,
  ErrParseCompound,
  ErrSchemaVersion,
  ErrSolverMissing,
  ErrUsage,
  errCodeCatalog,
  explainCode,
  nearestCodes,
  type OperationalError,
  tagOf,
  toErrorEnvelope,
} from './errors.ts'
import { EXIT_OPERATIONAL_ERROR, exitCodeForEnvelope } from './exit.ts'

/**
 * The shipped, append-only ERR_* order — transplanted from v4's
 * `src/core/__tests__/codes.test.ts` snapshot and extended with the two codes
 * v4 appended after that test was written (`ERR_EMBED_MODEL_MISSING`,
 * `ERR_DUPLICATE_KEY`), which is exactly the append the guard is designed to
 * permit.
 *
 * A new code may only be APPENDED to the end of this list, as a deliberate edit.
 * Removing, renaming, or reordering a member fails the guard below.
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
  'ERR_EMBED_MODEL_MISSING',
  'ERR_DUPLICATE_KEY',
] as const

describe('append-only ERR_* catalog', () => {
  it('holds all 21 donor codes', () => {
    expect(ERR_CODES).toHaveLength(21)
    expect(ERR_CODES_SNAPSHOT).toHaveLength(21)
  })

  it('keeps every shipped code at its original index', () => {
    for (const [i, code] of ERR_CODES_SNAPSHOT.entries()) {
      expect(ERR_CODES[i], `code at index ${i} changed`).toBe(code)
    }
  })

  it('may only GROW in length — a shorter list means a code was removed', () => {
    expect(ERR_CODES.length).toBeGreaterThanOrEqual(ERR_CODES_SNAPSHOT.length)
  })

  it('matches the snapshot as a PREFIX — appends allowed, reorders are not', () => {
    expect(ERR_CODES.slice(0, ERR_CODES_SNAPSHOT.length)).toEqual([...ERR_CODES_SNAPSHOT])
  })

  it('has no duplicate codes', () => {
    expect(new Set(ERR_CODES).size).toBe(ERR_CODES.length)
  })

  /**
   * The guard must be able to FAIL, or it is vacuously green. Rather than
   * mutating the real catalog, re-run the guard's own logic against a
   * deliberately corrupted list and assert each violation class is caught.
   */
  describe('the guard fires (negative controls)', () => {
    const prefixMatches = (actual: readonly string[]): boolean =>
      actual.length >= ERR_CODES_SNAPSHOT.length &&
      ERR_CODES_SNAPSHOT.every((code, i) => actual[i] === code)

    it('passes on the real catalog', () => {
      expect(prefixMatches(ERR_CODES)).toBe(true)
    })

    it('passes on an APPEND (the one permitted change)', () => {
      expect(prefixMatches([...ERR_CODES, 'ERR_SOMETHING_NEW'])).toBe(true)
    })

    it('FAILS on a removal', () => {
      expect(prefixMatches(ERR_CODES.slice(0, -1))).toBe(false)
    })

    it('FAILS on a rename', () => {
      const renamed = [...ERR_CODES]
      renamed[4] = 'ERR_IO_RENAMED'
      expect(prefixMatches(renamed)).toBe(false)
    })

    it('FAILS on a reorder', () => {
      const reordered = [...ERR_CODES]
      const [first, second] = [reordered[0] as string, reordered[1] as string]
      reordered[0] = second
      reordered[1] = first
      expect(prefixMatches(reordered)).toBe(false)
    })

    it('FAILS on a prepend (which shifts every index)', () => {
      expect(prefixMatches(['ERR_PREPENDED', ...ERR_CODES])).toBe(false)
    })
  })
})

describe('the tag IS the code', () => {
  it('derives ERR_CODES from the classes, so the two cannot disagree', () => {
    expect(ERR_CLASSES).toHaveLength(ERR_CODES.length)
    expect(ERR_CLASSES.map((cls) => tagOf(cls))).toEqual([...ERR_CODES])
  })

  it('gives an INSTANCE the same _tag the class annotation reports', () => {
    const e = new ErrIo({ error: 'disk full', suggestions: [] })
    expect(e._tag).toBe('ERR_IO')
    expect(e._tag).toBe(tagOf(ErrIo))
  })

  it('names every code ERR_*', () => {
    for (const code of ERR_CODES) expect(code).toMatch(/^ERR_[A-Z0-9_]+$/)
  })
})

describe('descriptions are single-sourced and verbatim', () => {
  it('gives every code a non-blank description', () => {
    for (const cls of ERR_CLASSES) {
      const d = descriptionOf(cls)
      expect(d.length, `${tagOf(cls)} has a blank description`).toBeGreaterThan(0)
      expect(d.trim()).toBe(d)
    }
  })

  it('carries a Suggestion: clause on every code', () => {
    for (const cls of ERR_CLASSES) {
      expect(descriptionOf(cls), `${tagOf(cls)} lacks a Suggestion:`).toContain('Suggestion:')
    }
  })

  it('preserves the donor text verbatim for a sampled spread of codes', () => {
    // Spot-checks across the catalog's groups. The full 21-code equality was
    // verified against the donor's live `ErrCodeMeta` at transplant time; these
    // pin the exact strings so an edit here is deliberate.
    expect(descriptionOf(ErrUsage)).toBe(
      'Invalid or missing CLI arguments. Suggestion: consult the command usage string.',
    )
    expect(descriptionOf(ErrNotFound)).toBe(
      'The referenced requirement id is not present. Suggestion: list existing ids with `symspec list`.',
    )
    expect(descriptionOf(ErrParseCompound)).toBe(
      'A compound requirement (top-level and/or) was detected. Suggestion: split at "and"/"or" into separate requirements.',
    )
    expect(descriptionOf(ErrSolverMissing)).toBe(
      'A binary solver backend was requested but none was found by the discovery order. Suggestion: install one with `mise use github:Z3Prover/z3@z3-4.16.0`.',
    )
  })

  it('keeps the donor v2 clean-slate scope: no migration residue', () => {
    for (const cls of ERR_CLASSES) {
      expect(descriptionOf(cls)).not.toMatch(/migrate|legacy|automerge/i)
    }
  })

  it('still points the doc-load and schema-version paths at re-creation', () => {
    expect(descriptionOf(ErrDocParse)).toMatch(/symspec init/)
    expect(descriptionOf(ErrSchemaVersion)).toMatch(/symspec init/)
  })

  it('throws — rather than yielding a blank row — when a description is missing', () => {
    // A code that forgot its description must be a hard failure, since a blank
    // manifest row is precisely the silent drift this kernel exists to kill.
    expect(() => descriptionOf({ ast: { annotations: {} } })).toThrow(/description/)
    expect(() => descriptionOf({ ast: { annotations: undefined } })).toThrow()
    expect(() => descriptionOf({ ast: { annotations: { description: '' } } })).toThrow()
    expect(() => tagOf({ ast: { annotations: {} } })).toThrow(/identifier/)
  })
})

describe('errCodeCatalog()', () => {
  it('has one row per class, in shipped order', () => {
    const cat = errCodeCatalog()
    expect(cat.map((r) => r.code)).toEqual([...ERR_CODES])
  })

  it('reads every row description off the class, never a parallel list', () => {
    for (const row of errCodeCatalog()) {
      const cls = ERR_CLASSES.find((c) => tagOf(c) === row.code)
      expect(cls).toBeDefined()
      expect(row.description).toBe(descriptionOf(cls as Parameters<typeof descriptionOf>[0]))
    }
  })
})

describe('explainCode()', () => {
  it('splits the single description into meaning and suggestions', () => {
    const x = explainCode('ERR_USAGE')
    expect(x?.code).toBe('ERR_USAGE')
    expect(x?.meaning).toBe('Invalid or missing CLI arguments.')
    expect(x?.suggestions).toEqual(['consult the command usage string.'])
  })

  it('keeps the full verbatim text alongside the split', () => {
    const x = explainCode('ERR_IO')
    expect(x?.description).toBe(descriptionOf(ErrIo))
    expect(x?.description).toContain(x?.meaning as string)
  })

  it('resolves every code in the catalog with a non-empty meaning', () => {
    for (const code of ERR_CODES) {
      const x = explainCode(code)
      expect(x, `${code} did not resolve`).toBeDefined()
      expect((x as { meaning: string }).meaning.length).toBeGreaterThan(0)
      expect((x as { suggestions: readonly string[] }).suggestions.length).toBeGreaterThan(0)
    }
  })

  it('returns undefined for an unknown code — the caller decides the failure', () => {
    expect(explainCode('ERR_NOPE')).toBeUndefined()
    expect(explainCode('')).toBeUndefined()
    expect(explainCode('err_io')).toBeUndefined()
  })
})

describe('nearestCodes() — did-you-mean', () => {
  it('suggests same-family codes for a plausible typo', () => {
    expect(nearestCodes('ERR_PARSE_COMPOND')).toContain('ERR_PARSE_COMPOUND')
    expect(nearestCodes('ERR_SOLVER_MISSNG')).toContain('ERR_SOLVER_MISSING')
  })

  it('prefers the longest shared prefix', () => {
    // ERR_SCHEMA_VERSION shares a far longer prefix with this typo than any
    // other code, so it wins outright rather than by a tie-break.
    expect(nearestCodes('ERR_SCHEMA_VERSIO', 1)).toEqual(['ERR_SCHEMA_VERSION'])
  })

  it('breaks a prefix tie alphabetically, so the order is stable', () => {
    // Both ERR_DOC_* codes share the full 'ERR_DOC_' prefix and both overlap on
    // {ERR, DOC}, so neither signal separates them; the localeCompare tie-break
    // decides. Asserting the tie-break explicitly keeps the ordering a
    // documented property rather than an accident an agent might come to rely on.
    expect(nearestCodes('ERR_DOC_', 2)).toEqual(['ERR_DOC_EXISTS', 'ERR_DOC_NOT_FOUND'])
  })

  it('honours the limit', () => {
    expect(nearestCodes('ERR_PARSE_X', 2)).toHaveLength(2)
    expect(nearestCodes('ERR_', 5)).toHaveLength(5)
  })

  it('is deterministic across calls', () => {
    const a = nearestCodes('ERR_SOLVR')
    expect(nearestCodes('ERR_SOLVR')).toEqual(a)
    expect(nearestCodes('ERR_SOLVR')).toEqual(a)
  })

  it('returns an empty list when nothing is remotely close', () => {
    expect(nearestCodes('COMPLETELY_UNRELATED')).toEqual([])
  })
})

describe('toErrorEnvelope() — no structural sniffing', () => {
  it('copies _tag onto code and error/suggestions across', () => {
    const env = toErrorEnvelope(
      new ErrNotFound({ error: 'no such id', suggestions: ['symspec list'] }),
    )
    expect(env).toEqual({
      apiVersion: 1,
      type: 'error',
      error: 'no such id',
      code: 'ERR_NOT_FOUND',
      suggestions: ['symspec list'],
    })
  })

  it('produces a code from the closed catalog for EVERY class', () => {
    for (const cls of ERR_CLASSES) {
      const instance = new (
        cls as new (p: {
          error: string
          suggestions: readonly string[]
        }) => OperationalError
      )({ error: 'x', suggestions: [] })
      const env = toErrorEnvelope(instance)
      expect(isErrorEnvelope(env)).toBe(true)
      expect(ERR_CODES).toContain(env.code)
      expect(env.code).toBe(tagOf(cls))
    }
  })

  it('forwards partial only when present', () => {
    expect(toErrorEnvelope(new ErrIo({ error: 'e', suggestions: [] }))).not.toHaveProperty(
      'partial',
    )
    const withPartial = toErrorEnvelope(
      new ErrParseCompound({ error: 'e', suggestions: [], partial: { systemName: 'gw' } }),
    )
    expect(withPartial.partial).toEqual({ systemName: 'gw' })
  })

  it('forwards repair (AC-A-9) only when present', () => {
    expect(toErrorEnvelope(new ErrIo({ error: 'e', suggestions: [] }))).not.toHaveProperty('repair')
    const withRepair = toErrorEnvelope(
      new ErrParseCompound({
        error: 'e',
        suggestions: [],
        repair: { ops: [{ op: 'add' }], commands: ['symspec apply'] },
      }),
    )
    expect(withRepair.repair).toEqual({ ops: [{ op: 'add' }], commands: ['symspec apply'] })
  })
})

describe('runtime markers wire the exit code and suppress double reporting', () => {
  it('declares exit code 2 on every class', () => {
    for (const cls of ERR_CLASSES) {
      const instance = new (
        cls as new (p: {
          error: string
          suggestions: readonly string[]
        }) => OperationalError
      )({ error: 'x', suggestions: [] })
      expect(instance[Runtime.errorExitCode]).toBe(EXIT_OPERATIONAL_ERROR)
      expect(instance[Runtime.errorExitCode]).toBe(2)
    }
  })

  it('sets errorReported=false — the INVERTED marker meaning "do not log again"', () => {
    // `false` means "app code already reported this"; the default (`true`) makes
    // runMain print a duplicate pretty stack trace after the JSON envelope.
    for (const cls of ERR_CLASSES) {
      const instance = new (
        cls as new (p: {
          error: string
          suggestions: readonly string[]
        }) => OperationalError
      )({ error: 'x', suggestions: [] })
      expect(instance[Runtime.errorReported]).toBe(false)
    }
  })

  it('agrees with the envelope-derived exit code', () => {
    const env = toErrorEnvelope(new ErrSolverMissing({ error: 'no z3', suggestions: [] }))
    expect(exitCodeForEnvelope(env)).toBe(EXIT_OPERATIONAL_ERROR)
  })
})

describe('errors are yieldable Effect failures', () => {
  it('is a real Error subclass', () => {
    expect(new ErrIo({ error: 'e', suggestions: [] })).toBeInstanceOf(Error)
  })

  it('fails an Effect through the ERROR channel, not as a defect', async () => {
    const program = Effect.gen(function* () {
      return yield* new ErrNotFound({ error: 'missing', suggestions: ['try list'] })
    })
    const result = await Effect.runPromise(Effect.result(program))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('ERR_NOT_FOUND')
      expect(toErrorEnvelope(result.failure).code).toBe('ERR_NOT_FOUND')
    }
  })
})
