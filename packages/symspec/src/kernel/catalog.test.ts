/**
 * The unified catalog: all 80 codes reachable, every derived field honest.
 *
 * ## What this file is actually guarding
 *
 * The catalog derives `severity`, `meaning`, `suggestions`, `example`, and
 * `commands` by PARSING the description strings the manifest publishes. That is the
 * right design — one corpus, no second table to drift — and it has exactly one
 * failure mode: a parser that silently matches nothing yields a plausible-looking
 * `null` severity or a missing example, and no test notices.
 *
 * So the assertions here are COUNTS and TOTALITY, not spot checks: all 30 `FND_*`
 * severities parse (not "some do"), the example extractor finds exactly the 11 codes
 * that carry one (not "at least one"), and every one of the 80 resolves through
 * `lookupCode`. A regex that stops matching fails a count; a regex that starts
 * over-matching fails it too.
 */

import { describe, expect, it } from 'vitest'
import { FND_CODES, FndCodeMeta } from '../donor/formal/codes.ts'
import { GTWR_CODES, GtwrCodeMeta } from '../donor/lint/codes.ts'
import { REACHABILITY_FND_CODES, ReachabilityFndCodeMeta } from '../formal/reachability-codes.ts'
import {
  allCodeStrings,
  allCodes,
  type CodeEntry,
  catalogCounts,
  GTWR_SEVERITY_NOTE,
  lookupCode,
  nearestCodesAll,
} from './catalog.ts'
import { descriptionOf, ERR_CLASSES, tagOf } from './errors.ts'

// ---------------------------------------------------------------------------
// Coverage: all 80, in family order
// ---------------------------------------------------------------------------

describe('the unified catalog spans all three code families', () => {
  it('holds exactly 21 ERR_* / 35 FND_* / 24 GTWR_* = 80', () => {
    // 35 FND_*: the donor's frozen 30, plus G4's 5 `FND_REACHABILITY_*`. The two live in
    // different files because `donor/formal/codes.ts` is byte-identity-guarded against the
    // live donor, so appending there would break the transplant-fidelity check. They
    // report the same `family`, because an agent switches on a code and not on provenance.
    expect(catalogCounts()).toEqual({ ERR: 21, FND: 35, GTWR: 24, total: 80 })
  })

  it('resolves EVERY code in every catalog', () => {
    const codes = [
      ...ERR_CLASSES.map((c) => tagOf(c)),
      ...FND_CODES,
      ...REACHABILITY_FND_CODES,
      ...GTWR_CODES,
    ] as readonly string[]
    expect(codes).toHaveLength(80)
    for (const code of codes) {
      const entry = lookupCode(code)
      expect(entry, `${code} must resolve`).toBeDefined()
      expect(entry?.code).toBe(code)
      expect((entry?.description ?? '').length).toBeGreaterThan(0)
      expect((entry?.meaning ?? '').length).toBeGreaterThan(0)
    }
  })

  it('lists the families in order, each in its own append-only order', () => {
    const rows = allCodes()
    expect(rows.slice(0, 21).map((r) => r.family)).toEqual(Array(21).fill('ERR'))
    // 35 FND rows: the donor's 30 then G4's 5, both reporting `family: 'FND'`.
    expect(rows.slice(21, 56).map((r) => r.family)).toEqual(Array(35).fill('FND'))
    expect(rows.slice(56).map((r) => r.family)).toEqual(Array(24).fill('GTWR'))
    // The per-family order is the shipped append-only order, unreordered — and WITHIN the
    // FND family, provenance order: the frozen transplanted list, then the greenfield's.
    expect(rows.slice(21, 51).map((r) => r.code)).toEqual([...FND_CODES])
    expect(rows.slice(51, 56).map((r) => r.code)).toEqual([...REACHABILITY_FND_CODES])
    expect(rows.slice(56).map((r) => r.code)).toEqual([...GTWR_CODES])
  })

  it('publishes the description VERBATIM — the manifest`s own bytes', () => {
    // The whole single-source claim rests on this: `explain` and `manifest` must be
    // showing the same string, not two readings of one corpus.
    for (const cls of ERR_CLASSES) {
      expect(lookupCode(tagOf(cls))?.description).toBe(descriptionOf(cls))
    }
    for (const code of FND_CODES) {
      expect(lookupCode(code)?.description).toBe(FndCodeMeta[code].description)
    }
    for (const code of REACHABILITY_FND_CODES) {
      expect(lookupCode(code)?.description).toBe(ReachabilityFndCodeMeta[code].description)
    }
    for (const code of GTWR_CODES) {
      expect(lookupCode(code)?.description).toBe(GtwrCodeMeta[code].description)
    }
  })

  it('is case-sensitive — the codes are the wire vocabulary', () => {
    expect(lookupCode('err_io')).toBeUndefined()
    expect(lookupCode('fnd_contradiction')).toBeUndefined()
    expect(lookupCode('ERR_IO')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Severity: parsed for FND_*, honestly null elsewhere
// ---------------------------------------------------------------------------

describe('severity is derived, and null where it genuinely is not per-code', () => {
  /**
   * TOTALITY, not a sample. The `FND_*` severity comes from an em-dash-prefixed
   * corpus convention (`'error — …'`), and a parser that quietly stops matching
   * would report `null` for every code — which reads as "no severity" rather than
   * as a bug. Asserting all 30 parse is what makes the derivation trustworthy.
   */
  it('parses a severity for ALL 35 FND_* codes', () => {
    const fnd = allCodes().filter((r) => r.family === 'FND')
    expect(fnd).toHaveLength(35)
    for (const row of fnd) {
      expect(row.severity, `${row.code} severity must parse`).not.toBeNull()
      expect(['error', 'warn', 'info', 'warn/info']).toContain(row.severity)
    }
  })

  it('preserves the ONE genuinely dual severity rather than collapsing it', () => {
    // FND_AMBIGUOUS_QUANTIFIER really is warn-or-info depending on the pattern that
    // fired. Collapsing it to a single value would be a guess presented as a fact.
    expect(lookupCode('FND_AMBIGUOUS_QUANTIFIER')?.severity).toBe('warn/info')
    const dual = allCodes().filter((r) => r.severity === 'warn/info')
    expect(dual.map((r) => r.code)).toEqual(['FND_AMBIGUOUS_QUANTIFIER'])
  })

  it('reports the error-severity FND_* codes exactly', () => {
    // A pin on the blocking set, because "is this severity error" is the single most
    // consequential fact about a finding code: only error findings gate the exit code
    // and only an error lint finding excludes a requirement from the formal tier.
    const errors = allCodes()
      .filter((r) => r.family === 'FND' && r.severity === 'error')
      .map((r) => r.code)
    expect(errors).toEqual([
      'FND_DANGLING_REFERENCE',
      'FND_MISSING_TRIGGER',
      'FND_MISSING_PRECONDITION',
      'FND_CYCLE',
      'FND_EXACT_DUPLICATE',
      'FND_CONTRADICTION',
      'FND_CERTIFY_FAILED',
      'FND_NUMERIC_CONTRADICTION',
      'FND_TEMPORAL_CONTRADICTION',
      // G4. The ONLY error-severity code in the reachability family, and it earns that:
      // the violation survived BOTH the strict and the framed run (AC-2-5), so it is a
      // genuine defect rather than an artifact of assuming nothing about unwritten
      // variables. The other four reachability codes are info — they DEMOTE rather than
      // gate, because "I could not decide" must never fail a build the way a proof does.
      'FND_REACHABILITY_VIOLATED',
    ])
  })

  it('gives every ERR_* a null severity — an operational failure has an exit code', () => {
    for (const row of allCodes().filter((r) => r.family === 'ERR')) {
      expect(row.severity).toBeNull()
      expect(row.tier).toBeNull()
      // And no severityNote: the reason is structural (not a finding), not contextual.
      expect(row.severityNote).toBeUndefined()
    }
  })

  it('gives every GTWR_* a null severity WITH the contextual reason', () => {
    // The load-bearing honesty: a per-code GtWR severity table would be wrong for
    // R16/R26/R32/R35 precisely when an author most needs the truth.
    const gtwr = allCodes().filter((r) => r.family === 'GTWR')
    expect(gtwr).toHaveLength(24)
    for (const row of gtwr) {
      expect(row.severity).toBeNull()
      expect(row.severityNote).toBe(GTWR_SEVERITY_NOTE)
      expect(row.tier).toBe('lint')
    }
  })

  it('strips the severity prefix from `meaning` but not from `description`', () => {
    const row = lookupCode('FND_CONTRADICTION') as CodeEntry
    expect(row.description.startsWith('error — ')).toBe(true)
    expect(row.meaning.startsWith('error — ')).toBe(false)
    expect(row.meaning.startsWith('a context group is unsat')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tier: exhaustive, and the two counter-intuitive entries are pinned
// ---------------------------------------------------------------------------

describe('tier names the pipeline stage that emits the code', () => {
  it('assigns every FND_* code a real CheckTier', () => {
    for (const row of allCodes().filter((r) => r.family === 'FND')) {
      expect(['structural', 'lint', 'formal']).toContain(row.tier)
    }
  })

  /**
   * Both of these look wrong and are right, so both are pinned against a future
   * "correction" that would make the field lie:
   *
   * - the free-tier duplicate detector runs before symbolization (`check.ts:1160`
   *   tags it `lint`);
   * - `FND_EXCLUDED_FROM_FORMAL` is a GATE-phase disclosure about a requirement the
   *   solver never saw, so tagging it `formal` would imply the opposite of what the
   *   code means (`check.ts:1186` says so explicitly).
   */
  it('keeps the two counter-intuitive tier assignments', () => {
    expect(lookupCode('FND_EXACT_DUPLICATE')?.tier).toBe('lint')
    expect(lookupCode('FND_EXCLUDED_FROM_FORMAL')?.tier).toBe('structural')
  })

  it('puts the ambiguity family on the lint tier, where the default path runs it', () => {
    for (const code of [
      'FND_AMBIGUOUS_VAGUE',
      'FND_AMBIGUOUS_QUANTIFIER',
      'FND_AMBIGUOUS_REFERENCE',
      'FND_AMBIGUITY_NEEDS_JUDGMENT',
    ]) {
      expect(lookupCode(code)?.tier, code).toBe('lint')
    }
  })
})

// ---------------------------------------------------------------------------
// The derived projections: examples and commands
// ---------------------------------------------------------------------------

describe('worked examples are extracted where the corpus carries one', () => {
  /**
   * A COUNT, deliberately. The extractor handles two shapes (`(e.g. …)` and
   * `such as …`), verified exhaustive against all 80 descriptions by probe. Pinning
   * the count means a regex that stops matching fails here, and so does one that
   * starts over-matching — neither of which a "some code has an example" assertion
   * would catch.
   */
  it('finds an example for exactly the 11 codes that carry one', () => {
    const withExample = allCodes().filter((r) => r.example !== undefined)
    expect(withExample.map((r) => r.code)).toEqual([
      'FND_AMBIGUOUS_VAGUE',
      'FND_OPPOSITION_CANDIDATE',
      'FND_QUANTITY_ALIAS_CANDIDATE',
      'GTWR_R8_ESCAPE',
      'GTWR_R9_OPEN_ENDED',
      'GTWR_R10_SUPERFLUOUS_INFINITIVE',
      'GTWR_R17_OBLIQUE',
      'GTWR_R20_PURPOSE',
      'GTWR_R26_ABSOLUTE',
      'GTWR_R34_IMMEASURABLE',
      'GTWR_R35_TEMPORAL',
    ])
  })

  it('extracts the example CONTENT, not the marker', () => {
    expect(lookupCode('FND_OPPOSITION_CANDIDATE')?.example).toBe(
      '"open the valve" vs "shut the valve"',
    )
    expect(lookupCode('GTWR_R34_IMMEASURABLE')?.example).toBe('"fast" / "robust"')
    expect(lookupCode('GTWR_R17_OBLIQUE')?.example).toBe('"and/or"')
  })

  /**
   * The REGRESSION GUARD for the `etc.` trap the count above caught.
   *
   * R9's canonical INCOSE exemplar ends in a period, and the first `such as` regex
   * terminated on `[^.(]` — so this one entry silently produced no example while the
   * other ten worked. The same shape (an entry ending in `.` made unreachable by a
   * terminator that assumes it does not) already cost the donor six dead lexicon
   * entries, R9 among them. Pinned by CONTENT, so a terminator that truncates before
   * the trailing period fails here rather than passing the count.
   */
  it('keeps an example that ENDS in a period intact — the `etc.` trap', () => {
    expect(lookupCode('GTWR_R9_OPEN_ENDED')?.example).toBe(
      '"including but not limited to" / "etc."',
    )
  })

  it('stops the `such as` example before the (R<n>) citation, not inside it', () => {
    // The extractor anchors on the description's tail rather than on a character
    // class, so no example may carry the rule citation that terminates it.
    for (const row of allCodes()) {
      if (row.example === undefined) continue
      expect(/\(R\d+\)/.test(row.example), `${row.code} example leaked its citation`).toBe(false)
    }
  })

  it('OMITS the key rather than emitting an empty string when there is no example', () => {
    // Absent vs blank is a real distinction on the wire: an agent can tell "no
    // example exists for this code" from "the example is empty".
    const row = lookupCode('FND_CONTRADICTION') as CodeEntry
    expect('example' in row).toBe(false)
  })
})

describe('runnable commands are lifted out of the description text', () => {
  it('finds the discharging command on the propose-only candidates', () => {
    expect(lookupCode('FND_OPPOSITION_CANDIDATE')?.commands).toEqual([
      'symspec antonym add <verbA> <verbB>',
    ])
    expect(lookupCode('FND_SIMILAR_SEMANTIC')?.commands).toEqual(['symspec glossary'])
  })

  it('finds the migration pair on ERR_SCHEMA_VERSION', () => {
    const commands = lookupCode('ERR_SCHEMA_VERSION')?.commands ?? []
    expect(commands.length).toBeGreaterThanOrEqual(2)
    expect(commands.some((c) => c.startsWith('symspec init'))).toBe(true)
    expect(commands.some((c) => c.includes('apply'))).toBe(true)
  })

  it('reports an EMPTY command list where no command exists, rather than guessing', () => {
    // FND_CONTRADICTION's remedy is to change the document's meaning. There is no
    // command for that, and inventing one would be the tool authoring content.
    expect(lookupCode('FND_CONTRADICTION')?.commands).toEqual([])
    expect(lookupCode('ERR_USAGE')?.commands).toEqual([])
  })
})

describe('suggestions split at the corpus marker', () => {
  it('splits every ERR_* description that carries a Suggestion: clause', () => {
    const err = allCodes().filter((r) => r.family === 'ERR')
    // Every one of the 21 donor descriptions carries exactly one Suggestion: clause —
    // which is what let `explainCode` split one string into two fields with no second
    // corpus, and remains true after widening to three families.
    for (const row of err) {
      expect(row.suggestions.length, `${row.code}`).toBe(1)
      expect(row.meaning.includes('Suggestion:')).toBe(false)
    }
  })

  it('leaves suggestions empty for the codes whose text carries none', () => {
    expect(lookupCode('FND_CONTRADICTION')?.suggestions).toEqual([])
    expect(lookupCode('GTWR_R1_PATTERN')?.suggestions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Did-you-mean over 80, not 21
// ---------------------------------------------------------------------------

describe('nearestCodesAll ranks across all three families', () => {
  it('suggests the right GTWR_* rule for a misspelled lint code', () => {
    // The exact miss G1 could not answer: it ranked over 21 ERR_* codes and returned
    // ERR_* suggestions for a GTWR_* typo.
    expect(nearestCodesAll('GTWR_R7_VAGU')).toContain('GTWR_R7_VAGUE')
  })

  it('suggests the right FND_* code for a misspelled finding code', () => {
    expect(nearestCodesAll('FND_CONTRADICTON')).toContain('FND_CONTRADICTION')
    expect(nearestCodesAll('FND_VACUTY')).toContain('FND_VACUITY')
  })

  it('still answers the ERR_* misses G1 answered', () => {
    expect(nearestCodesAll('ERR_SOLVER_MISSNG')).toContain('ERR_SOLVER_MISSING')
    expect(nearestCodesAll('ERR_PARSE_COMPOND')).toContain('ERR_PARSE_COMPOUND')
  })

  /**
   * The property that makes widening the corpus from 21 to 80 SAFE rather than
   * noisy: the family prefix dominates the ranking, so a near-miss never crosses
   * families while something in the right family is close.
   */
  it('does not cross families when the right family has a close match', () => {
    for (const [typo, prefix] of [
      ['ERR_DOC_NOT_FOND', 'ERR_'],
      ['FND_ORPHN', 'FND_'],
      ['GTWR_R26_ABSOLUT', 'GTWR_'],
    ] as const) {
      const near = nearestCodesAll(typo)
      expect(near.length).toBeGreaterThan(0)
      for (const candidate of near)
        expect(candidate.startsWith(prefix), `${typo} → ${candidate}`).toBe(true)
    }
  })

  it('is deterministic across calls — these strings land in a diffable envelope', () => {
    const first = nearestCodesAll('FND_SIMILR')
    expect(nearestCodesAll('FND_SIMILR')).toEqual(first)
    expect(nearestCodesAll('FND_SIMILR')).toEqual(first)
  })

  it('returns nothing for a string with no shared prefix or token', () => {
    expect(nearestCodesAll('COMPLETELY_UNRELATED')).toEqual([])
  })

  it('honors the limit', () => {
    expect(nearestCodesAll('GTWR_R', 2)).toHaveLength(2)
    expect(nearestCodesAll('FND_', 5)).toHaveLength(5)
  })

  it('draws from all 80 code strings', () => {
    expect(allCodeStrings()).toHaveLength(80)
    expect(new Set(allCodeStrings()).size, 'no duplicate codes across families').toBe(80)
  })
})
