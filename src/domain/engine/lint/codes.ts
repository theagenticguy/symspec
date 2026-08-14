/**
 * `GTWR_*` rule codes — the closed, append-only catalog for INCOSE Guide to Writing
 * Requirements lint findings.
 *
 * ## Why this file is EDITED rather than copied verbatim
 *
 * The same reason as `../formal/codes.ts`: v4 declares this as a `z.enum`
 * plus a parallel `GtwrCodeMeta` of `z.literal(code).describe(text)`, bound by
 * `satisfies Record<GtwrCode, …>`. The greenfield does not ship Zod (spec: "Zod
 * (greenfield is Effect Schema native; no bridge needed)"), so the enum is a `const`
 * tuple and the meta corpus is a plain record — the same two artifacts, the same
 * `satisfies` bound, no schema library.
 *
 * The descriptions below were EXTRACTED PROGRAMMATICALLY from the live v4's
 * described literals, not retyped. That is not laziness: these 24 strings are the
 * agent-facing meaning of a quarter of the code vocabulary, the spec's standing
 * constraint is that all 75 codes survive "with meanings intact", and a typo in one
 * is invisible in review. They were diffed byte-for-byte against live v4 at
 * transplant time, which was only a meaningful check because both sides were READ
 * rather than one being transcribed.
 *
 * ## Severity is PER-FINDING, not per-code
 *
 * Deliberately absent here. `gtwr.ts` decides severity at emission time, because the
 * legitimate-exception rules (R26/R32/R35/R16) downgrade to `warn`/`info`
 * CONTEXTUALLY and a per-code severity table could not express that. The distinction
 * is load-bearing rather than cosmetic: only `error`-severity findings are blocking,
 * and a blocking finding EXCLUDES its requirement from the formal tier — so
 * hard-coding a severity here would silently change which requirements the solver
 * ever reasons about.
 *
 * ## Append-only
 *
 * Never renumber, rename, or remove a shipped code. New codes append to the END of
 * {@link GTWR_CODES}. The numbering gaps (R1, R2, R5-R10, R15-R21, R24, R26, ...)
 * are INCOSE's own rule numbers, not omissions — the catalog covers the ~24 rules
 * that are T1-checkable by regex/lexicon, and the missing numbers are rules that
 * need semantics no regex has.
 */

/**
 * The GTWR rule codes, in v4's append-only order. Grouped by concern, exactly
 * as v4 groups them.
 */
export const GTWR_CODES = [
  // Surface pattern / cardinality
  'GTWR_R1_PATTERN',
  // Voice, grammar, style
  'GTWR_R2_PASSIVE',
  'GTWR_R5_INDEFINITE_ARTICLE',
  'GTWR_R6_MISSING_UNITS',
  'GTWR_R7_VAGUE',
  'GTWR_R8_ESCAPE',
  'GTWR_R9_OPEN_ENDED',
  'GTWR_R10_SUPERFLUOUS_INFINITIVE',
  // Logical / negation / clarity
  'GTWR_R15_LOGICAL_EXPR',
  'GTWR_R16_NEGATION',
  'GTWR_R17_OBLIQUE',
  'GTWR_R18_MULTIPLE_SHALL',
  'GTWR_R19_COMBINATOR',
  'GTWR_R20_PURPOSE',
  'GTWR_R21_PARENTHESES',
  // Completeness / reference
  'GTWR_R24_PRONOUN',
  // Realism / constraints
  'GTWR_R26_ABSOLUTE',
  'GTWR_R32_UNIVERSAL',
  'GTWR_R33_MISSING_TOLERANCE',
  'GTWR_R34_IMMEASURABLE',
  'GTWR_R35_TEMPORAL',
  // Consistency
  'GTWR_R37_ACRONYM',
  'GTWR_R38_ABBREVIATION',
  'GTWR_R40_DECIMAL_FORMAT',
] as const

/** One GTWR rule code. */
export type GtwrCode = (typeof GTWR_CODES)[number]

/** One catalog row: the stable code and its single-sourced description. */
export interface GtwrCodeEntry {
  readonly code: GtwrCode
  readonly description: string
}

/**
 * The per-code description corpus the manifest reads to build its GTWR table.
 *
 * `satisfies Record<GtwrCode, GtwrCodeEntry>` is v4's bound, carried over: it
 * forces this corpus and {@link GTWR_CODES} to cover EXACTLY the same codes at
 * compile time, so a code added to one and forgotten in the other does not compile.
 * Each entry restates its own `code` so a lookup-then-emit path cannot report a
 * different code than it looked up (asserted, since a plain record can get it wrong
 * where v4's `z.literal(code)` made it structural).
 */
export const GtwrCodeMeta = {
  GTWR_R1_PATTERN: {
    code: 'GTWR_R1_PATTERN',
    description: 'Statement does not match any EARS pattern (INCOSE R1).',
  },
  GTWR_R2_PASSIVE: {
    code: 'GTWR_R2_PASSIVE',
    description: '`shall be <participle>` passive voice hides the responsible agent (R2).',
  },
  GTWR_R5_INDEFINITE_ARTICLE: {
    code: 'GTWR_R5_INDEFINITE_ARTICLE',
    description: 'Indefinite article "a/an" where a definite "the" is expected (R5).',
  },
  GTWR_R6_MISSING_UNITS: {
    code: 'GTWR_R6_MISSING_UNITS',
    description: 'A bare number with no unit of measure (R6).',
  },
  GTWR_R7_VAGUE: {
    code: 'GTWR_R7_VAGUE',
    description: 'A vague term from the weasel lexicon (R7).',
  },
  GTWR_R8_ESCAPE: {
    code: 'GTWR_R8_ESCAPE',
    description: 'An escape clause such as "where possible" / "if necessary" (R8).',
  },
  GTWR_R9_OPEN_ENDED: {
    code: 'GTWR_R9_OPEN_ENDED',
    description: 'An open-ended clause such as "including but not limited to" / "etc." (R9).',
  },
  GTWR_R10_SUPERFLUOUS_INFINITIVE: {
    code: 'GTWR_R10_SUPERFLUOUS_INFINITIVE',
    description: 'A superfluous infinitive such as "be able to" / "be capable of" (R10).',
  },
  GTWR_R15_LOGICAL_EXPR: {
    code: 'GTWR_R15_LOGICAL_EXPR',
    description: 'Use of an undefined logical-expression convention (R15).',
  },
  GTWR_R16_NEGATION: {
    code: 'GTWR_R16_NEGATION',
    description: 'Use of "not"/"never" outside a defined logical expression (R16).',
  },
  GTWR_R17_OBLIQUE: {
    code: 'GTWR_R17_OBLIQUE',
    description: 'An oblique "/" outside units or fractions (e.g. "and/or") (R17).',
  },
  GTWR_R18_MULTIPLE_SHALL: {
    code: 'GTWR_R18_MULTIPLE_SHALL',
    description: 'More than one `shall` — multiple thoughts in one statement (R18).',
  },
  GTWR_R19_COMBINATOR: {
    code: 'GTWR_R19_COMBINATOR',
    description: 'A clause combinator in the response slot (R19).',
  },
  GTWR_R20_PURPOSE: {
    code: 'GTWR_R20_PURPOSE',
    description: 'A purpose phrase such as "in order to" / "so that" (R20).',
  },
  GTWR_R21_PARENTHESES: {
    code: 'GTWR_R21_PARENTHESES',
    description: 'Parenthetical subordinate text (R21).',
  },
  GTWR_R24_PRONOUN: {
    code: 'GTWR_R24_PRONOUN',
    description: 'A personal or indefinite pronoun with an unclear referent (R24).',
  },
  GTWR_R26_ABSOLUTE: {
    code: 'GTWR_R26_ABSOLUTE',
    description: 'An unachievable absolute such as "100%" / "always" / "never" (R26).',
  },
  GTWR_R32_UNIVERSAL: {
    code: 'GTWR_R32_UNIVERSAL',
    description: '"all/any/both" where "each" is intended (R32).',
  },
  GTWR_R33_MISSING_TOLERANCE: {
    code: 'GTWR_R33_MISSING_TOLERANCE',
    description: 'A quantity with no range or tolerance (R33).',
  },
  GTWR_R34_IMMEASURABLE: {
    code: 'GTWR_R34_IMMEASURABLE',
    description: 'An immeasurable performance term such as "fast" / "robust" (R34).',
  },
  GTWR_R35_TEMPORAL: {
    code: 'GTWR_R35_TEMPORAL',
    description: 'An indefinite temporal keyword such as "eventually" / "until" (R35).',
  },
  GTWR_R37_ACRONYM: {
    code: 'GTWR_R37_ACRONYM',
    description: 'An undefined or inconsistently used acronym (R37).',
  },
  GTWR_R38_ABBREVIATION: {
    code: 'GTWR_R38_ABBREVIATION',
    description: 'A non-unit abbreviation (R38).',
  },
  GTWR_R40_DECIMAL_FORMAT: {
    code: 'GTWR_R40_DECIMAL_FORMAT',
    description: 'Inconsistent decimal precision across the requirement set (R40).',
  },
} as const satisfies Record<GtwrCode, GtwrCodeEntry>
