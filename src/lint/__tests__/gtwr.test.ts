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
import {
  checkGtWRules,
  checkGtWRulesSet,
  type GtWRFinding,
  R9_OPEN_ENDED_PHRASES,
  R38_ABBREVIATIONS,
} from '../gtwr'

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

describe('GtWR lexicon reachability — EVERY entry of R9 and R38 must be able to fire', () => {
  // WHY THIS EXISTS (T-AC-1-6). Both lexicons used to compile as
  // `\b(<entry>|<entry>|…)\b`. A trailing `\b` after an entry whose match ends
  // in `.` can NEVER hold (`.` is already a non-word character), so `etc.`,
  // `approx.`, `temp.`, `ref.`, `std.` and `alt.` were unreachable DEAD CODE —
  // six lexicon entries that could not produce a finding, including `etc.`, the
  // canonical INCOSE GtWR R9 exemplar named in R9's own finding description.
  //
  // Fixing the instance is not enough; this table is the mechanism that stops
  // the CLASS. The fixture keys are checked for exact set-equality against the
  // exported lexicons, so adding a lexicon entry without a fixture fails here,
  // and a compilation change that makes any existing entry unmatchable fails
  // here too — instead of silently shipping a rule that never fires.
  //
  // `matched` pins the SPAN as well as the firing: a dotted entry must report a
  // span covering the whole offending token INCLUDING its period.
  interface EntryFixture {
    /** Sentence containing the entry. */
    readonly sentence: string
    /** The exact substring the finding's span must cover. */
    readonly matched: string
  }

  const R9_FIXTURES: Readonly<Record<string, EntryFixture>> = {
    'including but not limited to': {
      sentence: 'the system shall support formats including but not limited to JSON',
      matched: 'including but not limited to',
    },
    'such as but not limited to': {
      sentence: 'the system shall support formats such as but not limited to JSON',
      matched: 'such as but not limited to',
    },
    // The regression fixture: sentence-final dotted entry.
    'etc\\.': {
      sentence: 'The system shall log errors, warnings, etc.',
      matched: 'etc.',
    },
    'et cetera': {
      sentence: 'the system shall log errors, warnings, et cetera',
      matched: 'et cetera',
    },
    'and so on': {
      sentence: 'the system shall log errors, warnings and so on',
      matched: 'and so on',
    },
    'and so forth': {
      sentence: 'the system shall log errors, warnings and so forth',
      matched: 'and so forth',
    },
    like: {
      sentence: 'the system shall accept formats like JSON',
      matched: 'like',
    },
    'for example': {
      sentence: 'the system shall accept a payload, for example JSON',
      matched: 'for example',
    },
  }

  const R38_FIXTURES: Readonly<Record<string, EntryFixture>> = {
    'approx\\.': {
      sentence: 'The system shall record approx. 50 events.',
      matched: 'approx.',
    },
    info: { sentence: 'the system shall display the info panel', matched: 'info' },
    spec: { sentence: 'the system shall load the spec file', matched: 'spec' },
    // The bare-word control: this entry always worked and must keep working.
    config: { sentence: 'the system shall load the config', matched: 'config' },
    op: { sentence: 'the system shall queue the op record', matched: 'op' },
    'min(?!imum)': { sentence: 'the system shall clamp to the min value', matched: 'min' },
    'max(?!imum)': { sentence: 'the system shall clamp to the max value', matched: 'max' },
    'temp\\.': { sentence: 'the system shall log the temp. reading', matched: 'temp.' },
    'ref\\.': { sentence: 'the system shall resolve the ref. table', matched: 'ref.' },
    'std\\.': { sentence: 'the system shall apply the std. profile', matched: 'std.' },
    'alt\\.': { sentence: 'the system shall use the alt. route', matched: 'alt.' },
  }

  const LEXICONS: ReadonlyArray<
    [
      label: string,
      code: string,
      severity: GtWRFinding['severity'],
      entries: readonly string[],
      fixtures: Readonly<Record<string, EntryFixture>>,
    ]
  > = [
    ['R9', 'GTWR_R9_OPEN_ENDED', 'error', R9_OPEN_ENDED_PHRASES, R9_FIXTURES],
    ['R38', 'GTWR_R38_ABBREVIATION', 'warn', R38_ABBREVIATIONS, R38_FIXTURES],
  ]

  for (const [label, code, severity, entries, fixtures] of LEXICONS) {
    // Set-equality both ways: no entry without a fixture (an unproven entry
    // could be dead), and no fixture for an entry that no longer exists.
    it(`${label}: every lexicon entry has a fixture and vice versa`, () => {
      expect([...entries].sort()).toEqual(Object.keys(fixtures).sort())
    })

    for (const entry of entries) {
      it(`${label} entry "${entry}" is reachable — ${code} fires with a span over the entry`, () => {
        const fixture = fixtures[entry]
        expect(fixture, `no fixture for ${label} entry "${entry}"`).toBeDefined()
        if (!fixture) return
        const { sentence, matched } = fixture

        const findings = checkGtWRules(makeReq(sentence), sentence)
        const finding = findings.find((f) => f.code === code)

        expect(finding, `${code} not produced for "${entry}" in: "${sentence}"`).toBeDefined()
        if (!finding) return
        expect(finding.severity).toBe(severity)
        assertSpanValid(finding, sentence)
        // The span must cover the whole offending token — for a dotted entry
        // that INCLUDES the trailing period.
        expect(sentence.slice(finding.span[0], finding.span[1]).toLowerCase()).toBe(
          matched.toLowerCase(),
        )
      })
    }
  }

  // Making dotted entries matchable must not broaden the rules elsewhere.
  //
  // The specific trap: the fix classifies entries by whether their MATCHED TEXT
  // ends in a word character. A tempting-but-wrong classifier looks at the last
  // character of the regex SOURCE instead — under which `min(?!imum)` ends in
  // `)`, gets sorted into the no-trailing-`\b` branch, and starts matching
  // inside "minutes"/"minor". "minimum"/"maximum" alone do NOT catch that (the
  // lookahead still suppresses them), so the word-INFIX cases below are the
  // ones that make the guard bite. Verified: this test fails on that classifier.
  const R38_MUST_NOT_FIRE: ReadonlyArray<string> = [
    // the lookahead's own job
    'the system shall enforce the minimum threshold',
    'the system shall enforce the maximum threshold',
    // the trailing-`\b` job: an abbreviation entry must not match a word INFIX
    'the system shall wait 5 minutes',
    'the system shall log a minor event',
    'the system shall record the maximal value',
    'the system shall inform the operator',
    'the system shall open the specimen record',
    'the system shall confirm the configuration baseline',
  ]

  for (const sentence of R38_MUST_NOT_FIRE) {
    it(`R38 does NOT fire on: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      const r38 = findings.find((f) => f.code === 'GTWR_R38_ABBREVIATION')
      expect(
        r38,
        r38 ? `R38 wrongly matched "${sentence.slice(r38.span[0], r38.span[1])}"` : '',
      ).toBeUndefined()
    })
  }

  it('R9 does NOT fire on a word merely CONTAINING a lexicon entry', () => {
    // Same trailing-`\b` invariant on the R9 side: "like" must not match inside
    // "likely", nor "and so on" inside a longer run-on.
    for (const sentence of [
      'the system shall reject a likely duplicate',
      'the system shall record the likeness score',
    ]) {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      const r9 = findings.find((f) => f.code === 'GTWR_R9_OPEN_ENDED')
      expect(
        r9,
        r9 ? `R9 wrongly matched "${sentence.slice(r9.span[0], r9.span[1])}"` : '',
      ).toBeUndefined()
    }
  })

  it('a word ending in a period at a sentence boundary does not trip any lexicon rule', () => {
    // The dotted branch drops its trailing `\b`; a plain word followed by the
    // sentence-final period must still produce nothing.
    const sentence = 'The system shall log the request.'
    const findings = checkGtWRules(makeReq(sentence), sentence)
    expect(findings, JSON.stringify(findings)).toEqual([])
  })

  it('R9 fires on a mid-sentence "etc.," as well as a sentence-final "etc."', () => {
    const sentence = 'The system shall log errors, warnings, etc., before exiting'
    const findings = checkGtWRules(makeReq(sentence), sentence)
    const r9 = findings.filter((f) => f.code === 'GTWR_R9_OPEN_ENDED')
    expect(r9).toHaveLength(1)
    const finding = r9[0]!
    expect(sentence.slice(finding.span[0], finding.span[1])).toBe('etc.')
  })
})

describe('GtWR bare-number rules — standard-identifier allowlist', () => {
  // A number that is part of a standard's NAME ("RFC 9457", "HTTP 401") is an
  // identifier, not a units-less quantity, so R6 (missing-units) and R33
  // (missing-tolerance) must NOT fire on it. Includes the hyphenated
  // "RFC-9457" form authors explicitly hit.
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

describe('GtWR R6 — broadened recognized-unit whitelist (issue #2)', () => {
  // Each spelling is a legitimate unit R6 must NOT error-flag. Grouped like the
  // R6_RECOGNIZED_UNITS / R6_MULTIWORD_UNITS / R6_SYMBOL_UNITS lists in gtwr.ts.
  const RECOGNIZED_UNIT_SENTENCES: ReadonlyArray<string> = [
    // mass
    'the pump shall dose 5 mg',
    'the pump shall dose 250 milligrams',
    'the loader shall lift 5 kg',
    'the loader shall lift 5 kilograms',
    'the scale shall weigh 5 g',
    'the scale shall weigh 5 grams',
    // volume
    'the tank shall hold 250 mL',
    'the tank shall hold 250 ml',
    'the tank shall hold 2 L',
    'the tank shall hold 2 liters',
    'the tank shall hold 2 litres',
    'the tank shall hold 250 milliliters',
    // electrical
    'the source shall emit 5 V',
    'the source shall emit 5 volts',
    'the source shall emit 50 mV',
    'the source shall emit 50 millivolts',
    'the source shall draw 2 A',
    'the source shall draw 2 amps',
    // data rate
    'the link shall sustain 3 Mbps',
    'the link shall sustain 3 Gbps',
    'the link shall sustain 300 kbps',
    'the link shall sustain 300 bps',
    // distance
    'the rover shall travel 5 miles',
    'the rover shall travel 5 feet',
    'the rover shall travel 5 ft',
    'the rover shall travel 5 meters',
    'the rover shall travel 5 metres',
    'the rover shall travel 5 km',
    'the rover shall travel 5 cm',
    'the rover shall travel 5 mm',
    // calendar
    'the license shall expire in 3 weeks',
    'the license shall expire in 6 months',
    'the license shall expire in 2 years',
    'the license shall expire in 1 day',
    // multiword temperature + currency
    'the oven shall reach 20 degrees celsius',
    'the oven shall reach 400 degrees fahrenheit',
    'the meter shall charge 5 US dollars',
    'the meter shall charge 5 dollars',
    'the meter shall charge 5 USD',
    // percent symbol (regression: the old inline regex wrongly tripped on "50%")
    'the cache shall retain 50%',
    // decimal followed by a unit — must not backtrack-flag the integer part
    'the api shall respond within 2.0 seconds',
    'the loader shall lift 2.5 kg',
  ]

  for (const sentence of RECOGNIZED_UNIT_SENTENCES) {
    it(`R6 does NOT fire on a recognized unit: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      expect(findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')).toBeUndefined()
    })
  }

  // REGRESSION: broadening the whitelist must not stop R6 catching genuinely
  // units-less quantities. A bare integer (even followed by a count noun) and a
  // clause-final bare number stay findings — this is the deliberate choice NOT
  // to add a following-noun escape (see gtwr.ts): existing fixtures depend on
  // "42 records" / "128 blocks" tripping R6, and a plain count is exactly the
  // "did you mean records-per-second?" case R6 exists to question.
  const STILL_FLAGGED: ReadonlyArray<string> = [
    'the system shall store 42 records',
    'the buffer shall retain 128 blocks',
    'the fusion stage shall combine with k of 60',
    'the api shall respond in 200',
    'the api shall respond within 1.5',
  ]

  for (const sentence of STILL_FLAGGED) {
    it(`R6 STILL fires on a units-less quantity: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      const r6 = findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')
      expect(r6, `R6 should fire on "${sentence}"`).toBeDefined()
      if (!r6) return
      expect(r6.severity).toBe('error')
      assertSpanValid(r6, sentence)
    })
  }
})

describe('GtWR R6 — dimensionless ratio/probability escape ([0,1] decimals)', () => {
  // A decimal in [0,1] is a score/probability/cosine-threshold/fusion-constant,
  // not a quantity missing a unit — it must NOT trip R6 (issue #2: authors
  // degraded "score >= 0.7" to dodge a spurious error).
  const DIMENSIONLESS: ReadonlyArray<string> = [
    'the ranker shall keep results scoring above 0.3',
    'the matcher shall merge pairs above 0.7',
    'the matcher shall accept a cosine of 0.95',
    'the gain shall settle at 1.0',
    'the filter shall drop below 0.0',
  ]

  for (const sentence of DIMENSIONLESS) {
    it(`R6 does NOT fire on a [0,1] ratio: "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      expect(findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')).toBeUndefined()
    })
  }

  // A decimal ABOVE 1 is not dimensionless-by-convention, and a bare INTEGER is
  // never a ratio — both stay findings so the escape cannot be abused.
  const NOT_A_RATIO: ReadonlyArray<string> = [
    'the api shall respond within 1.5', // decimal > 1 (dropped its unit)
    'the api shall respond within 2.5', // decimal > 1
    'the fusion stage shall use a constant of 60', // bare integer
  ]

  for (const sentence of NOT_A_RATIO) {
    it(`R6 STILL fires (not a [0,1] ratio): "${sentence}"`, () => {
      const findings = checkGtWRules(makeReq(sentence), sentence)
      expect(findings.find((f) => f.code === 'GTWR_R6_MISSING_UNITS')).toBeDefined()
    })
  }
})
