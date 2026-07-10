/**
 * GTWR rule codes enumeration — stable, append-only codes for lint findings.
 *
 * Each code maps to a rule in research-ears-incose.md §2 and the gtwr.ts
 * implementation. Severity is captured per-finding (not per-code) so AC-3-3
 * legitimate exceptions can downgrade a code to `warn` contextually.
 *
 * ## Single-source `.describe()` corpus (AC-6-3)
 *
 * `GtwrCodeSchema` is the closed, append-only SET of rule codes. Alongside it,
 * {@link GtwrCodeMeta} carries a per-code `.describe()` (a described
 * `z.literal(code)`) whose text the manifest (AC-6-1) reads to build its GTWR
 * table — never a parallel hand-list, so editing a `.describe()` here is the
 * single edit that moves the manifest. The `satisfies Record<GtwrCode, …>`
 * bound makes the corpus and the enum cover EXACTLY the same codes at compile
 * time.
 *
 * ## Append-only (AC-6-3)
 *
 * Never renumber or remove a code once shipped; new codes append to the END.
 * A snapshot test guards this for GTWR_* alongside the ERR_* and FND_* catalogs.
 *
 * Cite: AC-6-3 (three exported enums); AC-3-2 (~24 rules); AC-3-3 (severity table)
 */

import { z } from 'zod'

/**
 * GTWR finding codes — INCOSE Guide to Writing Requirements v4 rules.
 * ~24 T1 (regex/lexicon) checkable rules.
 * Append-only; never renumber or remove.
 */
export const GtwrCodeSchema = z.enum([
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
])

export type GtwrCode = z.infer<typeof GtwrCodeSchema>

/** Convenience: export the inner type for Zod snapshot/reachability tests */
export const GtwrCodes = GtwrCodeSchema.options

/**
 * Per-code `.describe()` corpus for the GTWR_* catalog (AC-6-3). The manifest
 * reads `.description` off these described literals to build its GTWR table;
 * the `satisfies` bound forces the corpus to cover EXACTLY the enum members.
 */
export const GtwrCodeMeta = {
  GTWR_R1_PATTERN: z
    .literal('GTWR_R1_PATTERN')
    .describe('Statement does not match any EARS pattern (INCOSE R1).'),
  GTWR_R2_PASSIVE: z
    .literal('GTWR_R2_PASSIVE')
    .describe('`shall be <participle>` passive voice hides the responsible agent (R2).'),
  GTWR_R5_INDEFINITE_ARTICLE: z
    .literal('GTWR_R5_INDEFINITE_ARTICLE')
    .describe('Indefinite article "a/an" where a definite "the" is expected (R5).'),
  GTWR_R6_MISSING_UNITS: z
    .literal('GTWR_R6_MISSING_UNITS')
    .describe('A bare number with no unit of measure (R6).'),
  GTWR_R7_VAGUE: z.literal('GTWR_R7_VAGUE').describe('A vague term from the weasel lexicon (R7).'),
  GTWR_R8_ESCAPE: z
    .literal('GTWR_R8_ESCAPE')
    .describe('An escape clause such as "where possible" / "if necessary" (R8).'),
  GTWR_R9_OPEN_ENDED: z
    .literal('GTWR_R9_OPEN_ENDED')
    .describe('An open-ended clause such as "including but not limited to" / "etc." (R9).'),
  GTWR_R10_SUPERFLUOUS_INFINITIVE: z
    .literal('GTWR_R10_SUPERFLUOUS_INFINITIVE')
    .describe('A superfluous infinitive such as "be able to" / "be capable of" (R10).'),
  GTWR_R15_LOGICAL_EXPR: z
    .literal('GTWR_R15_LOGICAL_EXPR')
    .describe('Use of an undefined logical-expression convention (R15).'),
  GTWR_R16_NEGATION: z
    .literal('GTWR_R16_NEGATION')
    .describe('Use of "not"/"never" outside a defined logical expression (R16).'),
  GTWR_R17_OBLIQUE: z
    .literal('GTWR_R17_OBLIQUE')
    .describe('An oblique "/" outside units or fractions (e.g. "and/or") (R17).'),
  GTWR_R18_MULTIPLE_SHALL: z
    .literal('GTWR_R18_MULTIPLE_SHALL')
    .describe('More than one `shall` — multiple thoughts in one statement (R18).'),
  GTWR_R19_COMBINATOR: z
    .literal('GTWR_R19_COMBINATOR')
    .describe('A clause combinator in the response slot (R19).'),
  GTWR_R20_PURPOSE: z
    .literal('GTWR_R20_PURPOSE')
    .describe('A purpose phrase such as "in order to" / "so that" (R20).'),
  GTWR_R21_PARENTHESES: z
    .literal('GTWR_R21_PARENTHESES')
    .describe('Parenthetical subordinate text (R21).'),
  GTWR_R24_PRONOUN: z
    .literal('GTWR_R24_PRONOUN')
    .describe('A personal or indefinite pronoun with an unclear referent (R24).'),
  GTWR_R26_ABSOLUTE: z
    .literal('GTWR_R26_ABSOLUTE')
    .describe('An unachievable absolute such as "100%" / "always" / "never" (R26).'),
  GTWR_R32_UNIVERSAL: z
    .literal('GTWR_R32_UNIVERSAL')
    .describe('"all/any/both" where "each" is intended (R32).'),
  GTWR_R33_MISSING_TOLERANCE: z
    .literal('GTWR_R33_MISSING_TOLERANCE')
    .describe('A quantity with no range or tolerance (R33).'),
  GTWR_R34_IMMEASURABLE: z
    .literal('GTWR_R34_IMMEASURABLE')
    .describe('An immeasurable performance term such as "fast" / "robust" (R34).'),
  GTWR_R35_TEMPORAL: z
    .literal('GTWR_R35_TEMPORAL')
    .describe('An indefinite temporal keyword such as "eventually" / "until" (R35).'),
  GTWR_R37_ACRONYM: z
    .literal('GTWR_R37_ACRONYM')
    .describe('An undefined or inconsistently used acronym (R37).'),
  GTWR_R38_ABBREVIATION: z
    .literal('GTWR_R38_ABBREVIATION')
    .describe('A non-unit abbreviation (R38).'),
  GTWR_R40_DECIMAL_FORMAT: z
    .literal('GTWR_R40_DECIMAL_FORMAT')
    .describe('Inconsistent decimal precision across the requirement set (R40).'),
} satisfies Record<GtwrCode, z.ZodLiteral<GtwrCode>>
