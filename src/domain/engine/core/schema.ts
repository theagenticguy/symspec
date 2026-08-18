/**
 * v4's `src/core/schema.ts`, reduced to the TYPES the transplanted check
 * path actually consumes — and nothing else.
 *
 * ## Why this file is REWRITTEN rather than copied verbatim
 *
 * It is one of exactly four files v4 this transplant materially edits (the
 * others: `core/doc.ts`, `formal/codes.ts`, `formal/backend.ts`). v4
 * original is 721 lines of Zod: ~40 `.describe()`-annotated atomic field schemas,
 * the composed `RequirementSchema` / `RequirementsDocSchema` load-time validators,
 * the discriminated-union `ChangeSchema`, and the per-tool input shapes. The
 * greenfield is Effect Schema native and the spec explicitly does not port Zod
 * ("Zod (greenfield is Effect Schema native; no bridge needed)" — transplant
 * manifest, Explicitly NOT ported).
 *
 * Measured, the whole check-path closure imports exactly THREE names from this
 * module: `EarsPattern` (encode.ts, temporal-patterns.ts, parse/tier1.ts),
 * `Requirement` (solvers/types.ts, lint/gtwr.ts, pipeline/gate.ts,
 * pipeline/check.ts), and `Waiver` (pipeline/gate.ts, pipeline/check.ts). All
 * three are pure TYPES. So the honest port is the types, structurally identical
 * to what v4's Zod schemas infer, with the validators dropped: v3
 * documents are validated by `../../../core/document.ts` (Effect Schema) before
 * anything here is reached, and re-validating with a second schema library would
 * be two sources of truth for one contract.
 *
 * The type shapes below are transcribed from v4's `z.infer` results, not
 * re-derived, so `Requirement` here and `Requirement` there are the same
 * structural type — which is what lets the differential oracle hand ONE document
 * object to both pipelines.
 *
 * ## `RequirementsDoc` is still the v2 shape, deliberately
 *
 * The transplanted `pipeline/check.ts` reads `doc.requirements` / `doc.glossary`
 * / `doc.antonyms` / `doc.waivers`, and v4's `schemaVersion` tag rides
 * along unused. Keeping the v2 shape here means the transplanted pipeline is
 * BYTE-IDENTICAL to v4's, and the v3→v2-view projection happens once, at
 * the boundary, in `../../compat.ts`. Translating inside the tier would have put
 * a conversion in 40 files instead of 1.
 */

// ---------------------------------------------------------------------------
// Enum constants — verbatim values from v4
// ---------------------------------------------------------------------------

export const EARS_PATTERNS = [
  'ubiquitous',
  'event-driven',
  'state-driven',
  'optional-feature',
  'unwanted-behavior',
] as const
export type EarsPattern = (typeof EARS_PATTERNS)[number]

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type Priority = (typeof PRIORITIES)[number]

export const STATUSES = ['draft', 'approved', 'implemented', 'verified'] as const
export type Status = (typeof STATUSES)[number]

export const VERIFICATION_METHODS = ['test', 'inspection', 'analysis', 'demonstration'] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

export const RELATIONS = ['derives', 'satisfies', 'verifies', 'refines'] as const
export type Relation = (typeof RELATIONS)[number]

// ---------------------------------------------------------------------------
// The requirement — structurally identical to v4's `z.infer<typeof
// RequirementSchema>`
// ---------------------------------------------------------------------------

/**
 * One EARS requirement node, as the transplanted tier sees it.
 *
 * Optional fields are `?: T | undefined` (NOT bare `?: T`) because that is what
 * `z.infer` produces for a `.optional()` field, and the tier reads them with
 * `!== undefined` guards throughout. Narrowing them to exact-optional here would
 * make the v3→v2 projection in `../../compat.ts` unable to pass a value it
 * legitimately has.
 */
export interface Requirement {
  id: string
  key?: string | undefined
  patternType: EarsPattern
  preCondition?: string | undefined
  trigger?: string | undefined
  systemName: string
  systemResponse: string
  negated: boolean
  sentence: string
  priority: Priority
  status: Status
  verificationMethod?: VerificationMethod | undefined
  verificationNote?: string | undefined
  derives: string[]
  satisfies: string[]
  verifies: string[]
  refines: string[]
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// The renderer, re-exported exactly as v4 does
// ---------------------------------------------------------------------------

export { renderSentence } from './render.ts'

// ---------------------------------------------------------------------------
// Analysis findings — verbatim from v4
// ---------------------------------------------------------------------------

export type Finding =
  | {
      kind: 'DanglingReference'
      from: string
      relation: Relation
      to: string
      message: string
    }
  | {
      kind: 'MissingTrigger'
      id: string
      patternType: EarsPattern
      message: string
    }
  | {
      kind: 'MissingPreCondition'
      id: string
      patternType: EarsPattern
      message: string
    }
  | {
      kind: 'CycleDetected'
      nodes: string[]
      relation: Relation
      message: string
    }
  | { kind: 'OrphanRequirement'; id: string; message: string }
  | { kind: 'LeafUnverifiable'; id: string; message: string }

// ---------------------------------------------------------------------------
// The side tables and the document shape — verbatim from v4
// ---------------------------------------------------------------------------

/** One committed synonym group. */
export type GlossaryEntry = {
  canonical: string
  aliases: string[]
}

/** One committed antonym pair. */
export type AntonymPair = {
  a: string
  b: string
}

/**
 * One committed noun-phrase term — substituted INSIDE a slot body, unlike a glossary entry
 * which replaces a whole body.
 */
export type TermEntry = {
  canonical: string
  aliases: string[]
}

/** One reviewed finding waiver. */
export type Waiver = {
  code: string
  requirementId?: string | undefined
  reason: string
}

/**
 * The document shape the transplanted tier reads. The v2 shape on purpose: the
 * v3→v2 projection happens once, at the boundary (`../../compat.ts`), so nothing
 * inside the tier changed and the differential oracle compares two pipelines
 * consuming the same value.
 */
export type RequirementsDoc = {
  schemaVersion: number
  requirements: Record<string, Requirement>
  glossary: GlossaryEntry[]
  waivers: Waiver[]
  antonyms: AntonymPair[]
  /**
   * Optional for the same reason the tier reads `doc.waivers ?? []`: a hand-built fixture
   * predating the table stays valid, and an absent table is exactly an empty one.
   */
  terms?: TermEntry[] | undefined
}

export const SCHEMA_VERSION = 2
