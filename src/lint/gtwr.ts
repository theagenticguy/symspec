/**
 * INCOSE Guide to Writing Requirements (GtWR) v4 lint rules
 * ~24 T1 (regex/lexicon) checkable rules, each with stable GTWR_Rn code,
 * severity, span, and suggestions.
 *
 * Severity legend:
 * - error: blocking surface check (feeds AC-3-7 pipeline exclusion)
 * - warn: rule has legitimate exceptions (AC-3-3) and is excluded from pass/fail gate
 * - info: low-confidence or advisory
 *
 * Cite: research-ears-incose.md §2 (~24 rules checkability rollup)
 */

import type { Requirement } from '../core/schema'
import { KW } from '../parse/tier1'

export interface GtWRFinding {
  /** Stable code: GTWR_R<n>_<slug> */
  code: string
  /** error | warn | info */
  severity: 'error' | 'warn' | 'info'
  /** Character span in the text [start, end) */
  span: [start: number, end: number]
  /** Human-readable message */
  message: string
  /** Mechanical rewrite suggestion, if defined */
  suggestion?: string
  /**
   * Owning requirement id, for SET-LEVEL findings (R40 decimal-format
   * consistency) produced by {@link checkGtWRulesSet} where the span alone
   * cannot say WHICH requirement in the set the finding belongs to.
   * Per-statement findings from {@link checkGtWRules} omit this key
   * (exactOptionalPropertyTypes: never assigned `undefined`).
   */
  requirementId?: string
}

/**
 * EARS master template (R1 pattern-compliance). Case-insensitive; mirrors the
 * regex-first grammar in research-ears-incose.md §1.3: optional leading
 * `Where`/`While`/`When|If … [then]` clauses in fixed order, then the
 * mandatory main clause `the <system> shall <response>`. A statement that
 * does NOT match any EARS pattern trips R1 (Appendix B: error severity).
 *
 * The leading-keyword alternations are built from the parser's own {@link KW}
 * vocabulary so R1 and the Tier-1 parser agree on what EARS is — including the
 * event synonyms ("Upon receipt of …", "Once …", "After …") the parser rates
 * high-confidence event-driven. Sharing one vocabulary is load-bearing: a
 * parse/lint disagreement on what counts as EARS would wrongly exclude valid
 * statements from the AC-3-7 gate. The article before `<system>` is optional
 * and admits `the`/`a`/`an`, mirroring the parser's `MAIN` article stripping.
 */
const EARS_MASTER = new RegExp(
  String.raw`^(?:${KW.where}\s+.+?,\s*)?(?:${KW.while}\s+.+?,\s*)?` +
    String.raw`(?:(?:${KW.when}|${KW.if})\s+.+?,\s*(?:then\s+)?)?` +
    String.raw`(?:(?:the|an|a)\s+)?.+?\s+shall\s+.+$`,
  'i',
)

// Helper: execute regex matches using Array.from to avoid assignment-in-expression
// biome lint issue. Returns array of all matches.
function getMatches(sentence: string, pattern: RegExp): RegExpExecArray[] {
  return Array.from(sentence.matchAll(pattern))
}

/**
 * Does a lexicon entry's MATCHED TEXT end in a word character — i.e. is the
 * entry `\b`-terminable?
 *
 * The question is about the text the entry matches, NOT about the last character
 * of its regex source, and the two differ in exactly the two ways this repo's
 * lexicons exercise:
 *   - an escaped literal (`etc\.`, `approx\.`) whose source ends in `.` after a
 *     backslash — the matched text ends in `.`, a NON-word character;
 *   - a negative lookahead (`min(?!imum)`, `max(?!imum)`) whose source ends in
 *     `)` — the matched text ends in `n`, a WORD character. Getting this one
 *     wrong is the trap: a naive "last source character is non-word" test would
 *     strip `min`'s trailing `\b` and make it fire inside "minute"/"minor".
 * So strip a trailing zero-width assertion, unescape, then inspect the tail.
 */
function isWordBoundaryTerminable(source: string): boolean {
  const literal = source.replace(/\(\?[!=][^)]*\)$/, '').replace(/\\(.)/g, '$1')
  return /\w/.test(literal.at(-1) ?? '')
}

/**
 * Compile a phrase lexicon (an array of regex-source alternatives) into one
 * case-insensitive `/gi` scanner, splitting the alternation so a trailing `\b`
 * is emitted ONLY on the branch where it can actually match.
 *
 * This is the same shape — and the same fix — as the R6 bare-number pattern
 * documented at {@link R6_BARE_NUMBER}: "the word-token branch keeps its
 * trailing `\b`; the symbol/multiword branches do not". A single
 * `` `\b(${entries.join('|')})\b` `` makes every entry that MATCHES a trailing
 * non-word character (`etc.`, `approx.`, `temp.`, `ref.`, `std.`, `alt.`)
 * unreachable dead code, because `\b` demands a word/non-word transition and
 * `.` is already non-word. R6 hit this with `%`; R9 and R38 hit it with `.`.
 *
 * The non-terminable branch is emitted FIRST so the alternation prefers the
 * LONGER spelling whenever a lexicon holds both a bare word and its dotted form
 * (a hypothetical `spec` + `spec\.`): word-first would match `spec` inside
 * `spec.` — there IS a boundary between `c` and `.` — and report a span one
 * character short of the offending text. Same "longer spellings first"
 * convention as {@link R6_RECOGNIZED_UNITS}.
 *
 * The LEADING `\b` is shared by both branches and always valid: every entry in
 * both lexicons begins with a word character.
 */
function compileLexicon(entries: readonly string[]): RegExp {
  const bareTailed = entries.filter((e) => !isWordBoundaryTerminable(e))
  const wordTailed = entries.filter((e) => isWordBoundaryTerminable(e))
  const branches = [
    ...(bareTailed.length > 0 ? [`(?:${bareTailed.join('|')})`] : []),
    ...(wordTailed.length > 0 ? [`(?:${wordTailed.join('|')})\\b`] : []),
  ]
  return new RegExp(`\\b(${branches.join('|')})`, 'gi')
}

/**
 * Standard-identifier allowlist for the bare-number rules (R6 missing-units,
 * R33 missing-tolerance). A digit run that is part of a standard's NAME — "RFC
 * 9457", "HTTP 401", "ISO 8601", "IEEE 754" — is an identifier, not a bare
 * quantity that forgot its unit, so it must NOT trip those rules (real field
 * report: users were degrading good prose to dodge the false positive).
 *
 * The token list covers the four reported cases (RFC/HTTP/ISO/IEEE) plus their
 * obvious close cousins (standards-body / encoding prefixes that are likewise
 * followed by a bare number: ANSI, NIST, FIPS, ECMA, ITU, UTF as in "UTF 8").
 * Kept deliberately tight — a genuine bare quantity like "store 42 records"
 * has no such preceding token and is still flagged.
 *
 * The lookbehind is done on the text slice BEFORE the number (the standard name
 * PRECEDES the digits). `[-\s]*$` after the token accepts both the spaced
 * ("RFC 9457") and hyphenated ("RFC-9457") forms authors hit: for
 * "RFC-9457" the bare-number regex's `\b` starts after the hyphen, so the slice
 * ends with "RFC-" and the trailing `[-\s]*` matches the hyphen.
 */
const STANDARD_ID_BEFORE = /\b(RFC|HTTP|ISO|IEEE|ANSI|NIST|FIPS|ECMA|ITU|UTF)[-\s]*$/i

function isStandardIdentifierNumber(sentence: string, matchIndex: number): boolean {
  return STANDARD_ID_BEFORE.test(sentence.slice(0, matchIndex))
}

/**
 * The unit spellings R6 (missing-units) accepts immediately after a bare number,
 * so `"5 kg"`, `"200 ms"`, or `"3 Mbps"` do NOT trip the rule. This is the
 * lint-tier recognized-unit whitelist — a SEPARATE list from the arithmetic
 * conflict tier's `DIMENSIONS` (src/formal/numeric.ts): R6 only asks "does a
 * unit token follow this number?", while the numeric tier normalizes spellings
 * to a shared base for comparison, so the two lists have different jobs and
 * membership. Exported so the manifest can surface it (see the
 * `TODO(coordination)` in src/cli/manifest.ts) and the two whitelists can be
 * reconciled in one place.
 *
 * GitHub issue #2 flagged legitimate units R6 was
 * error-flagging: mass, volume, electrical, data-rate, distance, and calendar
 * units were all absent. The list below is grouped by dimension and kept
 * deliberately CONSERVATIVE — only closed, well-known unit spellings, never an
 * open "any trailing word" rule (that would gut R6's purpose of catching a
 * genuinely units-less quantity like "respond in 200").
 *
 * Order matters inside the alternation: LONGER spellings precede the shorter
 * ones they contain (e.g. `milliseconds` before `ms`, `kilograms` before `kg`,
 * `millivolts` before `mV`/`V`) so the regex prefers the full word — otherwise a
 * shorter alternative could match a prefix and leave a dangling suffix. The
 * whole alternation is matched case-insensitively with a trailing word boundary,
 * so `"5 Volts"` and `"5 volts"` both pass.
 */
export const R6_RECOGNIZED_UNITS: readonly string[] = [
  // time — sub-second through days (singular + plural)
  'milliseconds',
  'millisecond',
  'ms',
  'seconds',
  'second',
  'minutes',
  'minute',
  'hours',
  'hour',
  'days',
  'day',
  's',
  'Hz',
  // calendar — week/month/year (singular + plural)
  'weeks',
  'week',
  'months',
  'month',
  'years',
  'year',
  // mass
  'milligrams',
  'milligram',
  'kilograms',
  'kilogram',
  'grams',
  'gram',
  'mg',
  'kg',
  'g',
  // volume
  'milliliters',
  'milliliter',
  'millilitres',
  'millilitre',
  'liters',
  'liter',
  'litres',
  'litre',
  'mL',
  'ml',
  'L',
  // electrical
  'millivolts',
  'millivolt',
  'volts',
  'volt',
  'amps',
  'amp',
  'mV',
  'V',
  'A',
  // data size / rate — longest first so "Mbps"/"Gbps" beat "bps"
  'Gbps',
  'Mbps',
  'kbps',
  'bps',
  // distance
  'kilometers',
  'kilometer',
  'kilometres',
  'kilometre',
  'meters',
  'meter',
  'metres',
  'metre',
  'miles',
  'mile',
  'feet',
  'ft',
  'km/h',
  'km',
  'cm',
  'mm',
  'm',
  // ratios / counts spelled out
  'percent',
  'units',
  'attempts',
  'times',
  'iterations',
]

/**
 * A multiword unit phrase R6 accepts after a bare number — one whose first token
 * is not itself a self-contained unit, so it cannot live in
 * {@link R6_RECOGNIZED_UNITS} (that list feeds a single-token lookahead). The
 * lookahead below admits an OPTIONAL second word ONLY for these fixed phrases:
 *   - `degrees celsius` / `degrees fahrenheit` — spelled-out temperature;
 *   - `US dollars` / `US dollar` — currency phrased with a country prefix.
 * Kept as an explicit closed set (never "digit + any two words") so R6 stays
 * conservative: an arbitrary trailing phrase must not sneak a units-less number
 * past the rule.
 */
const R6_MULTIWORD_UNITS: readonly string[] = [
  'degrees\\s+celsius',
  'degrees\\s+fahrenheit',
  'US\\s+dollars?',
]

/**
 * Single-token currency/temperature spellings that follow the number directly
 * (no leading "degrees"/"US"): `"5 dollars"`, `"5 USD"`, `"20 °C"`. Symbols
 * (`%`, `°C`, `°F`) are non-word characters, so they need their own alternation
 * outside the `\b`-terminated word list.
 */
const R6_SYMBOL_UNITS: readonly string[] = ['%', '°C', '°F', 'dollars', 'dollar', 'USD']

/**
 * The compiled R6 bare-number pattern. A digit run is a FINDING unless it is
 * immediately followed (allowing intervening spaces) by a recognized unit —
 * either a word-boundary-terminated token from {@link R6_RECOGNIZED_UNITS}, one
 * of the fixed multiword phrases in {@link R6_MULTIWORD_UNITS}, or a symbol from
 * {@link R6_SYMBOL_UNITS}. Built once at module load from the named lists so the
 * behavior stays sourced from the whitelist (not a hand-maintained inline
 * alternation), which is what lets the manifest surface the same list.
 *
 * The word-token branch keeps its trailing `\b`; the symbol/multiword branches
 * do not (a `%` or `°C` is not `\b`-terminable). Fixes a latent bug in the old
 * inline pattern where the trailing `\b` after `%` never matched, so `"50%"`
 * wrongly tripped R6.
 *
 * The leading `(?!\.\d)` after the digit run kills a subtle backtracking bug: on
 * `"2.5 kg"` the engine first matches the full `"2.5"`, sees the recognized unit,
 * fails the unit lookahead, then BACKTRACKS the optional fractional group to
 * match just `"2"` — which, followed by `".5"`, would spuriously fire. Forbidding
 * a match that is immediately followed by `.<digit>` means the integer part of a
 * decimal is never flagged on its own (this also cleaned up the pre-existing
 * `"2.0 seconds"` → `"2"` false positive in the prior inline pattern).
 */
const R6_UNIT_LOOKAHEAD =
  `(?:${R6_RECOGNIZED_UNITS.join('|')})\\b` +
  `|(?:${R6_MULTIWORD_UNITS.join('|')})` +
  `|(?:${R6_SYMBOL_UNITS.join('|')})`
const R6_BARE_NUMBER = new RegExp(
  String.raw`\b(\d+(?:\.\d+)?)\b(?!\.\d)(?!\s*(?:${R6_UNIT_LOOKAHEAD}))`,
  'gi',
)

/**
 * A bare decimal in the closed interval [0, 1] (e.g. `0.3`, `0.7`, `1.0`,
 * `0.95`) is a legitimately DIMENSIONLESS quantity — a probability, a score, a
 * cosine/similarity threshold, or a fusion constant (RRF-style) — so it must NOT
 * trip R6. Issue #2: authors were degrading `"score ≥ 0.7"` to
 * dodge a spurious missing-units error. This escape is deliberately narrow:
 *   - it fires ONLY for a decimal WITH a fractional part (must contain a `.`),
 *     so a bare integer like `"60"` (RRF k, account counts) is still flagged —
 *     an integer with no unit noun is the class R6 exists to catch;
 *   - the value must be ≤ 1.0, so `"1.5 seconds"` written as bare `"1.5"` still
 *     trips (it is a dimensioned quantity that dropped its unit).
 * A decimal strictly above 1 is NOT dimensionless-by-convention, so it stays a
 * finding.
 */
function isDimensionlessRatio(numText: string): boolean {
  if (!numText.includes('.')) return false
  const value = Number.parseFloat(numText)
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Check a single requirement's systemResponse field against GTWR rules.
 * Runs the ~24 T1 lexicon checks on the rendered sentence.
 *
 * @param requirement - requirement to check
 * @param sentence - the full rendered EARS sentence (or systemResponse slot alone)
 * @returns array of findings ([] if clean)
 */
export function checkGtWRules(requirement: Requirement, sentence: string): GtWRFinding[] {
  const findings: GtWRFinding[] = []

  // R1 — Pattern compliance: statement must match one of the EARS patterns
  checkR1Pattern(sentence, findings)

  // R2 — Passive voice (shall be <participle>)
  checkR2Passive(sentence, findings)

  // R5 — Indefinite article ("a"/"an" where "the" expected)
  checkR5IndefiniteArticle(sentence, findings)

  // R6 — Missing units (bare number)
  checkR6MissingUnits(sentence, findings)

  // R7 — Vague terms (weasel lexicon, from AC-3-1)
  checkR7Vague(sentence, findings)

  // R8 — Escape clauses ("where possible", "if necessary")
  checkR8EscapeClause(sentence, findings)

  // R9 — Open-ended ("including but not limited to", "etc.")
  checkR9OpenEnded(sentence, findings)

  // R10 — Superfluous infinitives ("be able to", "be capable of")
  checkR10SuperfluousInfinitive(sentence, findings)

  // R15 — Logical expressions (undefined convention; lowercase "and"/"or" in conditions)
  checkR15LogicalExpr(sentence, findings)

  // R16 — Use of "not"/"never" (with exceptions for defined logical expressions)
  checkR16Negation(sentence, findings)

  // R17 — Oblique "/" (except units/fractions)
  checkR17Oblique(sentence, findings)

  // R18 — Multiple shall (>1 in single sentence)
  checkR18MultipleShal(sentence, findings)

  // R19 — Combinators in response clause
  checkR19Combinator(sentence, findings)

  // R20 — Purpose phrases ("in order to", "so that")
  checkR20PurposePhrase(sentence, findings)

  // R21 — Parentheses with subordinate text
  checkR21Parentheses(sentence, findings)

  // R24 — Personal/indefinite pronouns
  checkR24Pronoun(sentence, findings)

  // R26 — Absolutes (warn if legitimate context, error otherwise) [AC-3-3]
  checkR26Absolutes(sentence, findings, requirement)

  // R32 — Universal quantifiers: "all"/"any"/"both" instead of "each"
  checkR32Universal(sentence, findings)

  // R33 — Missing tolerance/range
  checkR33MissingTolerance(sentence, findings)

  // R34 — Immeasurable performance term
  checkR34Immeasurable(sentence, findings)

  // R35 — Indefinite temporal keywords [AC-3-3 exceptions]
  checkR35Temporal(sentence, findings)

  // R37 — Acronym consistency
  checkR37Acronym(sentence, findings)

  // R38 — Non-unit abbreviations
  checkR38Abbreviation(sentence, findings)

  // R40 — Decimal format consistency is set-level; produced by
  // checkGtWRulesSet over the whole spec, not per-statement here.

  return findings
}

// ============================================================================
// R1 — EARS pattern compliance (research-ears-incose.md §2 R1, §1.3)
// ============================================================================

function checkR1Pattern(sentence: string, findings: GtWRFinding[]): void {
  // R1 is "the EARS parser IS the check": a statement that conforms to no
  // EARS pattern is flagged. The master template requires the mandatory
  // `the <system> shall <response>` main clause; prose with no `shall`
  // obligation (e.g. "Fast response times are important") does not match.
  const trimmed = sentence.trim()
  if (trimmed.length > 0 && !EARS_MASTER.test(trimmed)) {
    findings.push({
      code: 'GTWR_R1_PATTERN',
      severity: 'error',
      span: [0, sentence.length],
      message:
        'Statement does not match any EARS pattern; write "[While <state>,] [When <trigger>,] the <system> shall <response>"',
      suggestion: 'the <system> shall <response>',
    })
  }
}

// ============================================================================
// R2 — Passive voice check
// ============================================================================

function checkR2Passive(sentence: string, findings: GtWRFinding[]): void {
  // Pattern: "shall be <past-participle>" (e.g. "shall be designed", "shall be stored")
  // High-confidence regex: `shall be <verb-ed>`
  const passiveMatch = sentence.match(/\bshall\s+be\s+([a-z]+ed)\b/i)
  if (passiveMatch?.[0] && passiveMatch[1]) {
    const matched = passiveMatch[0]
    const verb = passiveMatch[1]
    const idx = sentence.indexOf(matched)
    findings.push({
      code: 'GTWR_R2_PASSIVE',
      severity: 'warn',
      span: [idx, idx + matched.length],
      message: `Passive voice: "shall be ${verb}"; use active form "shall ${verb.slice(0, -2) || verb}"`,
      suggestion: `shall ${verb.slice(0, -2)}`,
    })
  }
}

// ============================================================================
// R5 — Indefinite article check
// ============================================================================

function checkR5IndefiniteArticle(sentence: string, findings: GtWRFinding[]): void {
  // Heuristic: "a/an" typically should be "the" in requirements
  // Low confidence; check for "a" or "an" followed by noun
  const matches = Array.from(sentence.matchAll(/\b(a|an)\s+([a-z][a-z0-9_-]*)/gi))
  for (const match of matches) {
    const [matched] = match
    // Skip common cases: "as a", "an error", "an event" (contextual; low precision)
    // For now, flag all but provide low confidence
    const idx = sentence.indexOf(matched)
    if (idx >= 0) {
      findings.push({
        code: 'GTWR_R5_INDEFINITE_ARTICLE',
        severity: 'warn',
        span: [idx, idx + matched.length],
        message: `Indefinite article: "${matched}"; use "the" for definiteness in requirements`,
      })
    }
  }
}

// ============================================================================
// R6 — Bare number check
// ============================================================================

function checkR6MissingUnits(sentence: string, findings: GtWRFinding[]): void {
  // A bare number (digit run) is a finding unless it is immediately followed by
  // a recognized unit — the whitelist lives in the exported R6_RECOGNIZED_UNITS
  // / R6_MULTIWORD_UNITS / R6_SYMBOL_UNITS lists compiled into R6_BARE_NUMBER
  // above, so a legitimate "5 kg" / "200 ms" / "20 degrees celsius" / "50%"
  // does not error. `lastIndex` is reset because R6_BARE_NUMBER is a
  // module-level /g regex shared across calls.
  R6_BARE_NUMBER.lastIndex = 0
  const matches = getMatches(sentence, R6_BARE_NUMBER)
  for (const match of matches) {
    // Skip numbers that are part of a standard's name (e.g. "RFC 9457",
    // "HTTP 401") — those are identifiers, not units-less quantities.
    if (isStandardIdentifierNumber(sentence, match.index)) continue
    const [matched, num] = match
    // Dimensionless ratio/probability/threshold escape: a decimal in [0,1] is a
    // score/cosine/fusion-constant, not a quantity missing a unit. Integers and
    // decimals >1 stay flagged (see isDimensionlessRatio).
    if (num !== undefined && isDimensionlessRatio(num)) continue
    findings.push({
      code: 'GTWR_R6_MISSING_UNITS',
      severity: 'error',
      span: [match.index, match.index + matched.length],
      message: `Bare number "${num}" with no unit; specify unit (e.g., "${num} seconds")`,
      suggestion: `${num} <unit>`,
    })
  }
}

// ============================================================================
// R7 — Vague terms (weasel lexicon)
// ============================================================================

function checkR7Vague(sentence: string, findings: GtWRFinding[]): void {
  // Lexicon from AC-3-1: weasel words indicating vagueness
  const weaselWords = [
    'adequate',
    'appropriate',
    'as needed',
    'critical',
    'efficient',
    'fast',
    'flexible',
    'good',
    'important',
    'intuitive',
    'manageable',
    'minimal',
    'more or less',
    'near',
    'nearly',
    'optimize',
    'optimal',
    'practical',
    'prompt',
    'quick',
    'rapid',
    'reliable',
    'robust',
    'scalable',
    'seamless',
    'simple',
    'smooth',
    'sufficient',
    'superior',
    'timely',
    'typical',
    'user-friendly',
    'value-added',
  ]
  const pattern = new RegExp(`\\b(${weaselWords.join('|')})\\b`, 'gi')
  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R7_VAGUE',
      severity: 'error',
      span: [match.index, match.index + match[0]!.length],
      message: `Vague term: "${match[0]}"; use measurable/specific phrasing`,
      suggestion: `Replace with measurable term (e.g., "within 2 seconds" for "fast")`,
    })
  }
}

// ============================================================================
// R8 — Escape clauses
// ============================================================================

function checkR8EscapeClause(sentence: string, findings: GtWRFinding[]): void {
  const escapeWords = [
    'where possible',
    'if necessary',
    'as applicable',
    'when feasible',
    'if practical',
  ]
  const pattern = new RegExp(`\\b(${escapeWords.join('|')})\\b`, 'gi')
  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R8_ESCAPE',
      severity: 'error',
      span: [match.index, match.index + match[0]!.length],
      message: `Escape clause: "${match[0]}"; remove ambiguity with explicit conditions`,
    })
  }
}

// ============================================================================
// R9 — Open-ended phrases
// ============================================================================

/**
 * The R9 open-ended lexicon: phrases that leave a requirement's enumeration
 * unbounded, so no verification can ever be complete. Entries are regex SOURCE
 * (hence `etc\.`), compiled by {@link compileLexicon} — see that function for why
 * the dotted entry needs its own branch. `etc.` is the canonical GtWR R9
 * exemplar and is named in this rule's own finding description
 * (`src/lint/codes.ts`), so it MUST be reachable.
 *
 * Exported so the per-entry reachability test can assert a fixture for EVERY
 * entry, derived from this list rather than a hand-copied parallel one — the
 * mechanism that stops a future entry from silently becoming dead code.
 */
export const R9_OPEN_ENDED_PHRASES: readonly string[] = [
  'including but not limited to',
  'such as but not limited to',
  'etc\\.',
  'et cetera',
  'and so on',
  'and so forth',
  'like',
  'for example',
]

/** Compiled once at module load from {@link R9_OPEN_ENDED_PHRASES}. */
const R9_OPEN_ENDED = compileLexicon(R9_OPEN_ENDED_PHRASES)

function checkR9OpenEnded(sentence: string, findings: GtWRFinding[]): void {
  // `lastIndex` is reset because R9_OPEN_ENDED is a module-level /g regex shared
  // across calls (same discipline as R6_BARE_NUMBER).
  R9_OPEN_ENDED.lastIndex = 0
  const matches = getMatches(sentence, R9_OPEN_ENDED)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R9_OPEN_ENDED',
      severity: 'error',
      span: [match.index, match.index + match[0]!.length],
      message: `Open-ended phrase: "${match[0]}"; enumerate all cases explicitly`,
    })
  }
}

// ============================================================================
// R10 — Superfluous infinitives
// ============================================================================

function checkR10SuperfluousInfinitive(sentence: string, findings: GtWRFinding[]): void {
  const superfluousPattern = /\bshall\s+(be designed to|be able to|be capable of|be capable to)\b/gi
  const matches = getMatches(sentence, superfluousPattern)
  for (const match of matches) {
    const [matched, infinitive] = match
    findings.push({
      code: 'GTWR_R10_SUPERFLUOUS_INFINITIVE',
      severity: 'warn',
      span: [match.index, match.index + matched.length],
      message: `Superfluous infinitive: "shall ${infinitive}"; simplify to "shall <verb>"`,
      suggestion: `shall <action>`,
    })
  }
}

// ============================================================================
// R15 — Logical expressions (undefined convention)
// ============================================================================

function checkR15LogicalExpr(sentence: string, findings: GtWRFinding[]): void {
  // Check for lowercase "and"/"or" inside condition clauses (While/When/If)
  // High confidence if lowercase and not in a defined [X AND Y] convention
  const undefinedLogicalPattern = /\b(and|or)\b(?!\s*\[)/gi

  // Heuristic: if the sentence contains condition clauses and uses lowercase "and"/"or" with no brackets
  if (/\b(while|when|if|wherein|provided)\b/i.test(sentence)) {
    const matches = Array.from(sentence.matchAll(undefinedLogicalPattern))
    for (const match of matches) {
      findings.push({
        code: 'GTWR_R15_LOGICAL_EXPR',
        severity: 'warn',
        span: [match.index, match.index + match[0]!.length],
        message: `Undefined logical expression: lowercase "${match[0]}"; define convention (e.g., [X AND Y] or uppercase AND)`,
        suggestion: `Use [X AND Y] or [X OR Y] convention`,
      })
    }
  }
}

// ============================================================================
// R16 — Negation (shall not, never, not be able to)
// ============================================================================

function checkR16Negation(sentence: string, findings: GtWRFinding[]): void {
  // Pattern: "shall not", "never", "not be able to", "unable to", "no " (but not "no other")
  // Exception: negation inside a defined logical expression [NOT X] is allowed per R15
  // Heuristic: flag unless immediately preceded by [NOT

  const negationPattern = /(?<!\[)\b(not|never|shall not|unable to|no longer)\b/gi
  const matches = getMatches(sentence, negationPattern)
  for (const match of matches) {
    // Skip if inside [NOT ...]
    const beforeIndex = match.index - 1
    const isInsideLogicalExpr = beforeIndex >= 0 && sentence[beforeIndex] === '['
    if (!isInsideLogicalExpr) {
      findings.push({
        code: 'GTWR_R16_NEGATION',
        severity: 'warn', // AC-3-3: warn, not error (legitimate exceptions for logical expressions)
        span: [match.index, match.index + match[0]!.length],
        message: `Negation: "${match[0]}"; use inside a defined logical expression [NOT X] or express as positive obligation`,
      })
    }
  }
}

// ============================================================================
// R17 — Oblique "/" (except units, fractions)
// ============================================================================

function checkR17Oblique(sentence: string, findings: GtWRFinding[]): void {
  // Regex: "/" not inside units (km/h) or fractions (1/2)
  // Pattern: "/" surrounded by non-digits or non-unit-tokens
  const obliquePattern = /([a-z])\/(and|or)(?=\s)/gi
  const matches = getMatches(sentence, obliquePattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R17_OBLIQUE',
      severity: 'warn',
      span: [match.index + 1, match.index + 3], // the "/" itself
      message: `Oblique "/" for "and/or"; clarify: use AND or OR explicitly`,
    })
  }
}

// ============================================================================
// R18 — Multiple shall in one sentence
// ============================================================================

function checkR18MultipleShal(sentence: string, findings: GtWRFinding[]): void {
  const shallMatches = Array.from(sentence.matchAll(/\bshall\b/gi))
  if (shallMatches.length > 1) {
    // Flag the second and subsequent "shall"
    for (let i = 1; i < shallMatches.length; i++) {
      const match = shallMatches[i]!
      findings.push({
        code: 'GTWR_R18_MULTIPLE_SHALL',
        severity: 'error',
        span: [match.index, match.index + 5],
        message: `Multiple shall: ${shallMatches.length} obligations in one sentence; split into separate requirements`,
      })
    }
  }
}

// ============================================================================
// R19 — Combinators in response
// ============================================================================

function checkR19Combinator(sentence: string, findings: GtWRFinding[]): void {
  // Combinators: "and", "or", "then", "unless", "but", "as well as", "however", "whereas", "otherwise"
  // High confidence: in response clause (after "shall")
  const combinators = [
    'and',
    'or',
    'then',
    'unless',
    'but',
    'as well as',
    'however',
    'whereas',
    'otherwise',
  ]
  const responseStart = sentence.indexOf('shall')
  if (responseStart >= 0) {
    const responseClause = sentence.substring(responseStart)
    const pattern = new RegExp(`\\b(${combinators.join('|')})\\b`, 'gi')
    const matches = getMatches(responseClause, pattern)
    for (const match of matches) {
      findings.push({
        code: 'GTWR_R19_COMBINATOR',
        severity: 'warn',
        span: [responseStart + match.index, responseStart + match.index + match[0]!.length],
        message: `Combinator in response: "${match[0]}"; suggest using R15 convention or splitting requirement`,
      })
    }
  }
}

// ============================================================================
// R20 — Purpose phrases
// ============================================================================

function checkR20PurposePhrase(sentence: string, findings: GtWRFinding[]): void {
  const purposePhrases = [
    'in order to',
    'so that',
    'thus allowing',
    'for the purpose of',
    'with the intent',
    'so as to',
  ]
  const pattern = new RegExp(`\\b(${purposePhrases.join('|')})\\b`, 'gi')
  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R20_PURPOSE',
      severity: 'warn',
      span: [match.index, match.index + match[0]!.length],
      message: `Purpose phrase: "${match[0]}"; move rationale to separate attribute`,
    })
  }
}

// ============================================================================
// R21 — Parentheses with subordinate text
// ============================================================================

function checkR21Parentheses(sentence: string, findings: GtWRFinding[]): void {
  // Regex: content in parens/brackets (but not unit annotations or logical expressions)
  const parenPattern = /\(([^)]+)\)/g
  const matches = getMatches(sentence, parenPattern)
  for (const match of matches) {
    const matched = match[0]
    const content = match[1]
    // Skip if it looks like a unit annotation (short, mostly alphanumeric)
    if (content && (content.length > 3 || /[a-z]\s[a-z]/i.test(content))) {
      findings.push({
        code: 'GTWR_R21_PARENTHESES',
        severity: 'warn',
        span: [match.index, match.index + matched.length],
        message: `Parenthetical subordinate text; elevate to main clause or separate requirement`,
      })
    }
  }
}

// ============================================================================
// R24 — Personal/indefinite pronouns
// ============================================================================

function checkR24Pronoun(sentence: string, findings: GtWRFinding[]): void {
  const pronouns = [
    'it',
    'they',
    'them',
    'this',
    'that',
    'these',
    'those',
    'its',
    'their',
    'he',
    'she',
    'we',
    'you',
    'one',
    'everyone',
    'anybody',
    'something',
    'anything',
  ]
  // Restrict to high-confidence positions: subject or clause-initial
  const pronounPattern = new RegExp(`\\b(${pronouns.join('|')})\\b`, 'gi')
  const matches = getMatches(sentence, pronounPattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R24_PRONOUN',
      severity: 'warn',
      span: [match.index, match.index + match[0]!.length],
      message: `Pronoun: "${match[0]}"; replace with explicit noun reference`,
    })
  }
}

// ============================================================================
// R26 — Absolutes (with AC-3-3 legitimate-exception handling)
// ============================================================================

function checkR26Absolutes(
  sentence: string,
  findings: GtWRFinding[],
  _requirement: Requirement,
): void {
  // AC-3-3: absolutes have legitimate exceptions; mark as warn if context suggests exception
  // Heuristic: "disregard all signals when override ON" is legitimate
  // Pattern: "all" + "when" or "if" within the same sentence
  const absoluteWords = [
    '100%',
    'all',
    'every',
    'always',
    'never',
    'under all conditions',
    'at all times',
  ]
  const escapedWords = absoluteWords.map((w) => {
    // Escape special regex chars (%) and handle multi-word phrases
    return w.replace(/([%.+*?^${}()|[\]\\])/g, '\\$1').replace(/\s+/g, '\\s+')
  })
  // Word-boundary lookarounds (not \b: "100%" ends in a non-word char) so
  // "all" cannot match inside "shall" — see T-AC-3-7's gate over-exclusion bug.
  const pattern = new RegExp(`(?<!\\w)(${escapedWords.join('|')})(?!\\w)`, 'gi')

  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    // Check for legitimate exception context: conditional clause nearby
    const hasConditional = /\b(when|if|wherein|except)\b/i.test(sentence)
    const severity = hasConditional ? 'warn' : 'error' // AC-3-3

    findings.push({
      code: 'GTWR_R26_ABSOLUTE',
      severity,
      span: [match.index, match.index + match[0]!.length],
      message: `Absolute: "${match[0]}"; qualify with exceptions or constraints`,
      suggestion: `Use "each", "all except", "whenever" + conditions`,
    })
  }
}

// ============================================================================
// R32 — Universal quantifiers
// ============================================================================

function checkR32Universal(sentence: string, findings: GtWRFinding[]): void {
  // AC-3-3: universal quantifiers (all, any, both) have legitimate exceptions in EARS patterns
  // Recommend "each" instead, but warn if context suggests it's quantifying an object (legitimate)
  const quantifierPattern = /\b(all|any|both)\b/gi
  const matches = getMatches(sentence, quantifierPattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R32_UNIVERSAL',
      severity: 'warn', // AC-3-3: warn, not error
      span: [match.index, match.index + match[0]!.length],
      message: `Universal quantifier: "${match[0]}"; use "each" for clarity`,
      suggestion: `Replace "${match[0]}" with "each"`,
    })
  }
}

// ============================================================================
// R33 — Missing tolerance/range
// ============================================================================

function checkR33MissingTolerance(sentence: string, findings: GtWRFinding[]): void {
  // Heuristic: bare number without a range/tolerance marker
  // Pattern: digit(s) not followed by ±, "less than", "at least", "between", "within"
  const numberWithoutRangePattern =
    /\b(\d+(?:\.\d+)?)\s+(?!(?:±|to|less than|at least|between|within|from|through|exceeds|below|above|maximum|minimum|or greater|or fewer|percent|times)\b)/gi
  const matches = getMatches(sentence, numberWithoutRangePattern)
  for (const match of matches) {
    // Skip standard-identifier numbers (e.g. "ISO 8601", "IEEE 754"): they are
    // names, not quantities missing a tolerance. Mirrors the R6 guard.
    if (isStandardIdentifierNumber(sentence, match.index)) continue
    findings.push({
      code: 'GTWR_R33_MISSING_TOLERANCE',
      severity: 'warn',
      span: [match.index, match.index + match[0]!.length],
      message: `Quantity without range: "${match[0]}"; specify tolerance (e.g., ± or "at least")`,
    })
  }
}

// ============================================================================
// R34 — Immeasurable performance
// ============================================================================

function checkR34Immeasurable(sentence: string, findings: GtWRFinding[]): void {
  const immeasurableWords = [
    'prompt',
    'fast',
    'quick',
    'slow',
    'optimum',
    'robust',
    'reliable',
    'secure',
    'efficient',
    'sufficient',
    'user-friendly',
  ]
  const pattern = new RegExp(`\\b(${immeasurableWords.join('|')})\\b`, 'gi')
  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R34_IMMEASURABLE',
      severity: 'warn',
      span: [match.index, match.index + match[0]!.length],
      message: `Immeasurable performance term: "${match[0]}"; provide specific metric (e.g., "within 2 seconds")`,
    })
  }
}

// ============================================================================
// R35 — Indefinite temporal keywords [AC-3-3]
// ============================================================================

function checkR35Temporal(sentence: string, findings: GtWRFinding[]): void {
  // AC-3-3: indefinite temporal keywords have legitimate exceptions when bound to events/times
  // Pattern: "before X" where X is a measured event is ok; "before" alone is not
  const temporalKeywords = [
    'eventually',
    'until',
    'before',
    'after',
    'as',
    'once',
    'earliest',
    'latest',
    'instantaneous',
    'simultaneous',
    'at last',
  ]
  const pattern = new RegExp(`\\b(${temporalKeywords.join('|')})\\b`, 'gi')

  const matches = getMatches(sentence, pattern)
  for (const match of matches) {
    // Check if followed by a bound event/time (e.g., "before X", "after 5 seconds")
    // Bound context: "after 5 seconds", "before timeout", "after completion"
    const afterMatch = sentence.substring(
      match.index + match[0]!.length,
      match.index + match[0]!.length + 40,
    )
    // Pattern: followed by a number + time unit OR a named event (timeout, completion, receipt, event, etc)
    // Accept: "5 seconds", "completion", "timeout", "receipt", "event"
    const isBound =
      /\s+(\d+\s*(seconds?|ms|hours?|minutes?|days?|milliseconds?)\b)/i.test(afterMatch) ||
      /\s+(completion|receipt|timeout|event)\b/i.test(afterMatch)

    // AC-3-3: warn if truly indefinite; info if bound to a measured event/time
    const severity = isBound ? 'info' : 'warn'
    findings.push({
      code: 'GTWR_R35_TEMPORAL',
      severity,
      span: [match.index, match.index + match[0]!.length],
      message: `Indefinite temporal keyword: "${match[0]}"; bind to a measured event or time`,
      suggestion: `Use "before <event>", "after <date>", or "within <duration>"`,
    })
  }
}

// ============================================================================
// R37 — Acronym consistency
// ============================================================================

function checkR37Acronym(sentence: string, findings: GtWRFinding[]): void {
  // Regex: extract acronyms (2+ uppercase letters)
  // High confidence: acronym used without prior expansion
  // Heuristic (per-statement): flag any acronym; glossary check is document-level
  const acronymPattern = /\b([A-Z]{2,})\b/g
  const matches = getMatches(sentence, acronymPattern)
  for (const match of matches) {
    const acronym = match[0]!
    // Skip common acronyms (API, URL, etc.)
    const commonAcronyms = [
      'API',
      'URL',
      'HTTP',
      'REST',
      'JSON',
      'UUID',
      'SMS',
      'SSH',
      'TLS',
      'EOF',
    ]
    if (!commonAcronyms.includes(acronym)) {
      findings.push({
        code: 'GTWR_R37_ACRONYM',
        severity: 'warn',
        span: [match.index, match.index + acronym.length],
        message: `Acronym: "${acronym}"; ensure it is defined in the glossary`,
        suggestion: `Spell out or add to project glossary`,
      })
    }
  }
}

// ============================================================================
// R38 — Non-unit abbreviations
// ============================================================================

/**
 * The R38 non-unit-abbreviation lexicon. Entries are regex SOURCE, so it holds
 * both escaped-literal forms (`approx\.`) and negative-lookahead forms
 * (`min(?!imum)`, which must NOT fire on the fully spelled-out "minimum"), and is
 * compiled by {@link compileLexicon} — which keeps the lookahead entries'
 * trailing `\b` (their match ends in a word character) while dropping it for the
 * dotted ones (their match ends in `.`, where `\b` can never hold).
 *
 * Exported for the same per-entry reachability reason as
 * {@link R9_OPEN_ENDED_PHRASES}.
 */
export const R38_ABBREVIATIONS: readonly string[] = [
  'approx\\.',
  'info',
  'spec',
  'config',
  'op',
  'min(?!imum)',
  'max(?!imum)',
  'temp\\.',
  'ref\\.',
  'std\\.',
  'alt\\.',
]

/** Compiled once at module load from {@link R38_ABBREVIATIONS}. */
const R38_ABBREVIATION = compileLexicon(R38_ABBREVIATIONS)

function checkR38Abbreviation(sentence: string, findings: GtWRFinding[]): void {
  // `lastIndex` reset: module-level /g regex shared across calls.
  R38_ABBREVIATION.lastIndex = 0
  const matches = getMatches(sentence, R38_ABBREVIATION)
  for (const match of matches) {
    findings.push({
      code: 'GTWR_R38_ABBREVIATION',
      severity: 'warn',
      span: [match.index, match.index + match[0]!.length],
      message: `Non-unit abbreviation: "${match[0]}"; spell out`,
      suggestion: `Use full word`,
    })
  }
}

// ============================================================================
// R40 — Decimal format consistency (SET-LEVEL, AC-3-2 / Appendix B, info)
// ============================================================================

/** A decimal literal with its owning requirement id and character span. */
interface DecimalHit {
  requirementId: string
  value: string
  /** Number of fractional digits (0 for an integer literal). */
  precision: number
  span: [start: number, end: number]
}

/**
 * Set-level GtWR checks (AC-3-2) that cannot be decided from a single
 * statement. Currently only R40 (decimal-format consistency): if the set
 * mixes decimal literals of DIFFERENT fractional precision (e.g. "2.0" and
 * "2.00", or "1.5" alongside "1"), the later-precision literals are flagged
 * `info` so an agent can normalize the whole set.
 *
 * Each finding carries `requirementId` (the per-statement `checkGtWRules`
 * omits it) plus a `span` into that requirement's own sentence.
 *
 * @param requirements - the whole requirement set, each paired with the text scanned
 * @returns set-level findings ([] if the set uses a single consistent precision)
 */
export function checkGtWRulesSet(
  requirements: readonly { requirement: Requirement; sentence: string }[],
): GtWRFinding[] {
  const findings: GtWRFinding[] = []

  // Collect every DECIMAL literal (must contain a '.') across the set.
  const hits: DecimalHit[] = []
  const decimalPattern = /\b\d+\.\d+\b/g
  for (const { requirement, sentence } of requirements) {
    for (const match of getMatches(sentence, decimalPattern)) {
      const value = match[0]
      const dot = value.indexOf('.')
      hits.push({
        requirementId: requirement.id,
        value,
        precision: value.length - dot - 1,
        span: [match.index, match.index + value.length],
      })
    }
  }

  // Consistent (or fewer than two literals) ⇒ nothing to report.
  const precisions = new Set(hits.map((h) => h.precision))
  if (precisions.size < 2) return findings

  // The most common precision is treated as the set's convention; literals at
  // any other precision are flagged. Ties resolve to the smallest precision
  // (deterministic).
  const counts = new Map<number, number>()
  for (const h of hits) counts.set(h.precision, (counts.get(h.precision) ?? 0) + 1)
  let dominant = Number.POSITIVE_INFINITY
  let dominantCount = -1
  for (const [precision, count] of counts) {
    if (count > dominantCount || (count === dominantCount && precision < dominant)) {
      dominant = precision
      dominantCount = count
    }
  }

  for (const h of hits) {
    if (h.precision === dominant) continue
    findings.push({
      code: 'GTWR_R40_DECIMAL_FORMAT',
      severity: 'info',
      span: h.span,
      message: `Inconsistent decimal precision: "${h.value}" uses ${h.precision} fractional digit(s) where the set predominantly uses ${dominant}`,
      suggestion: `Normalize all quantities to ${dominant} fractional digit(s)`,
      requirementId: h.requirementId,
    })
  }

  return findings
}
