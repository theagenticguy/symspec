/**
 * `ParseResult` — the per-line discriminated union the parse ladder emits (AC-2-8).
 *
 * Every parse of a single input line resolves to exactly one of three outcomes,
 * discriminated on `outcome`:
 *
 *   - `{ outcome: 'ok', pattern, slots, negated, confidence, tier, notes }` —
 *     Tier 1 or Tier 2 produced a usable slot set. `slots` is guaranteed to be
 *     accepted by `CreateRequirementAttrsSchema` (the ok-slot schema below is
 *     literally a `.pick()` of it), so a successful parse feeds `add` directly.
 *
 *   - `{ outcome: 'skipped', reason: 'no-modal', text }` — the line is prose
 *     carrying no obligation (a bullet, heading, or rationale sentence with no
 *     `shall`/modal). Per research-nlparse.md §1.5/§6, such lines are IGNORED as
 *     prose and reported as `skipped` — distinct from a Tier-3 ERROR, so an
 *     agent batch-feeding a whole `requirements.md` is not spammed with errors
 *     for every non-requirement line.
 *
 *   - `{ outcome: 'error', code, error, partial?, suggestions }` — a Tier-3
 *     failure (AC-2-7): the line LOOKED like a requirement but could not be
 *     parsed (compound conjunction, ambiguous clauses, or degenerate input).
 *     Carries the stable `ERR_PARSE_*` code, the best-effort `partial` slot
 *     skeleton, and mechanical rewrite suggestions.
 *
 * ## The skipped/error boundary
 *
 * The Tier-3 layer (`tier3.ts`) classifies EVERY hard failure into an
 * `ERR_PARSE_*` code, including `ERR_PARSE_NO_MODAL`. This module is where the
 * AC-2-8 distinction is drawn: a Tier-3 envelope whose code is
 * `ERR_PARSE_NO_MODAL` becomes `outcome: 'skipped'` (the line simply is not a
 * requirement — no modal, no obligation), while every other code — including
 * `ERR_PARSE_NOT_A_REQUIREMENT` (degenerate/empty input) and the error-only
 * `ERR_PARSE_COMPOUND` — stays `outcome: 'error'`. The `ParseErrorResult`
 * schema still admits all four codes so callers that bypass the ladder (or a
 * future policy change) remain representable.
 *
 * ## Compound lines are errors, never low-confidence guesses
 *
 * A top-level `and`/`or` conjunction (`compound-conjunction` escalation
 * trigger) forces `outcome: 'error'` with `ERR_PARSE_COMPOUND` even when Tier 1
 * or Tier 2 nominally extracted slots — per AC-2-7's "rather than emitting a
 * low-confidence guess" and the resolved open question (ERR_PARSE_COMPOUND is
 * error-only in v2; the agent splits and re-submits). The recovered slots are
 * still surfaced in `partial` so the agent has the skeleton for the split.
 *
 * Scope boundary: this module owns the per-line union and the ladder driver
 * ({@link parseLine}). Batch input (`--file`/`--stdin`, bullet stripping,
 * `results[] + summary`) is AC-2-9 (`parse/batch.ts`); wrapping into the CLI
 * `{apiVersion, type, data}` envelope is AC-6-2 (`cli/envelope.ts`).
 *
 * Cite: AC-2-8 (union shape + slot-target alignment); AC-2-7 (error variant);
 * research-nlparse.md executive summary, §1.1 (ParseResult shape), §1.5/§6
 * (`skipped` = no-modal prose); orchestrator decision 5.
 */

import { z } from 'zod'
import { CreateRequirementAttrsSchema, EARS_PATTERNS } from '../core/schema.js'
import type { Confidence, Tier1Ok, Tier1Slots } from './tier1.js'
import type { ProposedSplit, Tier2Ok, Tier2Options, Tier2Outcome } from './tier2.js'
import { runTier2 } from './tier2.js'
import type { ParseErrorCode, Tier3Envelope } from './tier3.js'
import { makeTier3Envelope, PARSE_ERROR_CODES } from './tier3.js'

// ---------------------------------------------------------------------------
// Zod schemas — one per outcome, discriminated-union'd on `outcome`
// ---------------------------------------------------------------------------

/**
 * The EARS slots of a successful parse. Defined as a `.pick()` of
 * `CreateRequirementAttrsSchema` so "ok-slots feed the create schema directly"
 * (AC-2-8) holds BY CONSTRUCTION: anything this schema accepts, the create
 * schema accepts (the picked fields carry identical validators; the create
 * schema's remaining fields are all optional).
 */
export const ParseSlotsSchema = CreateRequirementAttrsSchema.pick({
  patternType: true,
  systemName: true,
  systemResponse: true,
  preCondition: true,
  trigger: true,
})

/** `confidence` enum shared with the Tier-1/Tier-2 result shapes. */
export const ConfidenceSchema = z.enum(['high', 'medium', 'low'])

/** Success: a Tier-1 or Tier-2 parse produced a usable slot set. */
export const ParseOkResultSchema = z.object({
  outcome: z.literal('ok'),
  pattern: z.enum(EARS_PATTERNS),
  slots: ParseSlotsSchema,
  negated: z.boolean(),
  confidence: ConfidenceSchema,
  tier: z.union([z.literal(1), z.literal(2)]),
  notes: z.array(z.string()),
})

/** Skipped: no-modal prose — a line carrying no obligation (not an error). */
export const ParseSkippedResultSchema = z.object({
  outcome: z.literal('skipped'),
  reason: z.literal('no-modal'),
  text: z.string(),
})

/**
 * Best-effort slot skeleton recovered on a Tier-3 failure. Mirrors
 * `tier3.ts`'s `PartialSlots` interface (every field optional, ABSENT — not
 * `null` — when unrecovered, per `exactOptionalPropertyTypes`). Declared here
 * rather than imported from `cli/envelope.ts` so `src/parse/` stays
 * CLI-agnostic.
 */
export const ParsePartialSlotsSchema = z.object({
  patternType: z.enum(EARS_PATTERNS).optional(),
  systemName: z.string().optional(),
  systemResponse: z.string().optional(),
  preCondition: z.string().optional(),
  trigger: z.string().optional(),
})

/**
 * A single confidently-split requirement proposed for a compound (`and`/`or`)
 * input. Generic slot shape (`.pick()` of the create attrs plus a `negated`
 * flag) — carries NO CLI op vocabulary, so `src/parse/` stays CLI-agnostic. The
 * CLI layer maps each proposal to a ready-to-apply `add` op.
 */
export const ProposedSplitSchema = ParseSlotsSchema.extend({
  negated: z.boolean(),
})

/** Error: a Tier-3 failure (AC-2-7) with stable code, partial, and rewrites. */
export const ParseErrorResultSchema = z.object({
  outcome: z.literal('error'),
  code: z.enum(PARSE_ERROR_CODES),
  error: z.string().min(1),
  partial: ParsePartialSlotsSchema.optional(),
  suggestions: z.array(z.string()).min(1),
  proposedSplits: z.array(ProposedSplitSchema).min(2).optional(),
})

/** The full AC-2-8 union, discriminated on `outcome`. */
export const ParseResultSchema = z.discriminatedUnion('outcome', [
  ParseOkResultSchema,
  ParseSkippedResultSchema,
  ParseErrorResultSchema,
])

// ---------------------------------------------------------------------------
// TypeScript shapes (hand-written, matching the sibling-module style)
// ---------------------------------------------------------------------------

/** A successful parse. `slots` satisfies `CreateRequirementAttrsSchema`. */
export interface ParseOkResult {
  readonly outcome: 'ok'
  readonly pattern: Tier1Slots['patternType']
  readonly slots: Tier1Slots
  /** True when the modal carried an explicit negator; `slots.systemResponse` is the positive atom. */
  readonly negated: boolean
  readonly confidence: Confidence
  /** Which ladder rung produced the parse (Tier 3 never succeeds). */
  readonly tier: 1 | 2
  /** Provenance notes (e.g. `nonstandard-modal`, `tier2-repaired-event`). */
  readonly notes: readonly string[]
}

/** No-modal prose, ignored as a non-requirement line — NOT an error. */
export interface ParseSkippedResult {
  readonly outcome: 'skipped'
  readonly reason: 'no-modal'
  /** The original input line (trimmed), so a batch caller can map it back. */
  readonly text: string
}

/** A Tier-3 parse failure (AC-2-7), projected into the per-line union. */
export interface ParseErrorResult {
  readonly outcome: 'error'
  readonly code: ParseErrorCode
  /** Human-readable description of why parsing failed. */
  readonly error: string
  /** Best-effort slot skeleton — omitted (never `undefined`) when nothing was salvaged. */
  readonly partial?: {
    readonly patternType?: Tier1Slots['patternType']
    readonly systemName?: string
    readonly systemResponse?: string
    readonly preCondition?: string
    readonly trigger?: string
  }
  /** Mechanical rewrite suggestions — always at least one. */
  readonly suggestions: readonly string[]
  /**
   * For `ERR_PARSE_COMPOUND` only: the confidently-split single requirements the
   * compound splitter recovered (≥2 halves that each re-parse cleanly). Absent
   * when the split was not confident or the code is not COMPOUND. Generic slot
   * shape — the CLI layer maps these to ready-to-apply `add` ops.
   */
  readonly proposedSplits?: readonly ProposedSplit[]
}

export type ParseResult = ParseOkResult | ParseSkippedResult | ParseErrorResult

// ---------------------------------------------------------------------------
// Projections from the ladder's internal shapes
// ---------------------------------------------------------------------------

/** Lift a Tier-1 or Tier-2 success into the `ok` variant. */
export function fromTierOk(ok: Tier1Ok | Tier2Ok): ParseOkResult {
  return {
    outcome: 'ok',
    pattern: ok.pattern,
    slots: ok.slots,
    negated: ok.negated,
    confidence: ok.confidence,
    tier: ok.tier,
    notes: ok.notes,
  }
}

/**
 * Project a Tier-3 envelope into the union, drawing the AC-2-8 skipped/error
 * boundary: `ERR_PARSE_NO_MODAL` becomes `skipped` (no-modal prose is not an
 * error), every other code stays `error`.
 *
 * @param env  The Tier-3 envelope produced by `makeTier3Envelope`.
 * @param text The original input line, carried on the `skipped` variant.
 */
export function fromTier3(env: Tier3Envelope, text: string): ParseSkippedResult | ParseErrorResult {
  if (env.code === 'ERR_PARSE_NO_MODAL') {
    return { outcome: 'skipped', reason: 'no-modal', text: text.trim() }
  }
  return {
    outcome: 'error',
    code: env.code,
    error: env.error,
    ...(env.partial !== undefined ? { partial: env.partial } : {}),
    suggestions: env.suggestions,
    ...(env.proposedSplits !== undefined ? { proposedSplits: env.proposedSplits } : {}),
  }
}

/**
 * Resolve a completed `Tier2Outcome` into the final per-line `ParseResult`.
 * Pure: no I/O, deterministic in its inputs.
 *
 * Resolution order:
 *   1. A `compound-conjunction` trigger forces a Tier-3 `ERR_PARSE_COMPOUND`
 *      error even over a nominal Tier-1/Tier-2 ok (error-only in v2 — the
 *      recovered slots surface in `partial` for the split).
 *   2. Otherwise, prefer the Tier-2 repair when it succeeded, then a usable
 *      Tier-1 parse (soft triggers ride on it as downgraded confidence).
 *   3. Otherwise Tier 3, split into `skipped` (no-modal) or `error`.
 */
export function resolveParseResult(text: string, outcome: Tier2Outcome): ParseResult {
  const compound = outcome.triggers.includes('compound-conjunction')
  if (!compound) {
    if (outcome.tier2?.ok) return fromTierOk(outcome.tier2)
    if (outcome.tier1.ok) return fromTierOk(outcome.tier1)
  }
  return fromTier3(makeTier3Envelope(text, outcome), text)
}

// ---------------------------------------------------------------------------
// The ladder driver
// ---------------------------------------------------------------------------

/**
 * Parse one input line through the full Tier-1 → Tier-2 → Tier-3 ladder and
 * emit the AC-2-8 `ParseResult`. Tier 2 (and the wink-nlp model load) is
 * invoked only on escalation, per AC-2-6; `opts.load` lets tests and embedders
 * inject an analyzer.
 *
 * @example
 * await parseLine('When the user logs in, the auth service shall issue a token')
 * // → { outcome:'ok', pattern:'event-driven', slots:{…}, tier:1, … }
 *
 * @example
 * await parseLine('- improve overall performance')  // a no-modal bullet
 * // → { outcome:'skipped', reason:'no-modal', text:'- improve overall performance' }
 */
export async function parseLine(input: string, opts: Tier2Options = {}): Promise<ParseResult> {
  const outcome = await runTier2(input, opts)
  return resolveParseResult(input, outcome)
}
