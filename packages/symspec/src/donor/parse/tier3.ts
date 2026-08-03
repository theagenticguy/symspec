/**
 * Tier-3: structured error envelope for parse failures (AC-2-7).
 *
 * When neither Tier 1 nor Tier 2 produces a full-slot parse, the parse ladder
 * terminates at Tier 3 — the "agent punt" rung. Rather than returning a
 * low-confidence guess or throwing an unhandled error, symspec returns a typed
 * error envelope carrying:
 *
 *   - A stable `ERR_PARSE_*` code identifying the failure class.
 *   - The partial slots recovered by Tier 1 or Tier 2 (if any), so the
 *     calling agent has the furthest-we-got slot skeleton without having to
 *     re-parse.
 *   - Mechanical rewrite suggestions — concrete, one-shot fixes the agent can
 *     apply in a single turn (prepend "the system shall …", split at "and/or",
 *     etc.).
 *
 * ## Code assignment heuristic
 *
 * The four `ERR_PARSE_*` codes map to disjoint failure classes:
 *
 *   - `ERR_PARSE_NO_MODAL` — no `shall`/modal verb found. This fires when
 *     Tier 1 produced `no-main-clause` or `empty` and Tier 2 confirmed
 *     `no-modal-clause`. The sentence is simply not a requirement.
 *
 *   - `ERR_PARSE_NOT_A_REQUIREMENT` — the sentence has no obligation at all
 *     (e.g. "Fast response times are important"). Fired when the only note from
 *     both tiers is a structural miss with no EARS vocabulary whatsoever.
 *
 *   - `ERR_PARSE_COMPOUND` — a top-level `and`/`or` conjunction was detected
 *     (`compound-conjunction` escalation trigger). The sentence is two or more
 *     requirements merged into one. Per the resolved open question, v2 emits
 *     this as an error-only code (no `--split` flag in v2).
 *
 *   - `ERR_PARSE_AMBIGUOUS_CLAUSES` — all other failure modes: nested clause
 *     keywords, over-long sentences, passive main clauses without a recoverable
 *     agent, or a Tier-2 miss that was not purely modal-free. Clause boundaries
 *     could not be unambiguously resolved.
 *
 * Code priority when multiple notes fire: COMPOUND > NO_MODAL > NOT_A_REQUIREMENT >
 * AMBIGUOUS_CLAUSES. COMPOUND overrides because splitting is always the first
 * actionable fix; NO_MODAL is more informative than a general ambiguity; NOT_A_REQUIREMENT
 * is reserved for sentences that lack *any* obligation vocabulary.
 *
 * ## Design contract for Wave 6 (AC-6-2)
 *
 * `Tier3Envelope` is the Tier-3 layer's internal return type. The CLI layer
 * (Wave 6, AC-6-2) wraps it into the full `{apiVersion, type:'error', …}` outer
 * envelope. This module stays pure and CLI-agnostic so it can be unit-tested
 * without any CLI or envelope infrastructure.
 *
 * ## Cite
 *
 * research-nlparse.md §5, §6 (Tier-3 agent punt + mechanical-rewrite suggestion
 * patterns); AC-2-7 (ERR_PARSE_* stable codes + partial + suggestions shape);
 * Appendix A (normative ERR_* table); resolved open question (ERR_PARSE_COMPOUND
 * is error-only, no --split flag in v2).
 */

import type { EarsPattern } from '../core/schema.ts'
import type { EscalationTrigger, ProposedSplit, Tier2Outcome } from './tier2.ts'

// ---------------------------------------------------------------------------
// ERR_PARSE_* code subset (strict sub-type of ErrCode for parse failures)
// ---------------------------------------------------------------------------

/** The four stable `ERR_PARSE_*` codes AC-2-7 defines. */
export const PARSE_ERROR_CODES = [
  'ERR_PARSE_NO_MODAL',
  'ERR_PARSE_AMBIGUOUS_CLAUSES',
  'ERR_PARSE_COMPOUND',
  'ERR_PARSE_NOT_A_REQUIREMENT',
] as const

export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Partial slots (best-effort, never undefined-valued fields)
// ---------------------------------------------------------------------------

/**
 * Slot skeleton recovered from a failed parse. Carries whatever slots either
 * Tier 1 or Tier 2 managed to extract before failing, so the calling agent has
 * the furthest-we-got skeleton rather than starting from scratch.
 *
 * All fields are optional (conditional-spread, never assigned `undefined`) and
 * are absent — not `null` — when unrecovered, per `exactOptionalPropertyTypes`.
 */
export interface PartialSlots {
  patternType?: EarsPattern
  systemName?: string
  systemResponse?: string
  preCondition?: string
  trigger?: string
}

// ---------------------------------------------------------------------------
// Tier-3 envelope
// ---------------------------------------------------------------------------

/**
 * The Tier-3 error envelope: what the parse ladder returns when neither Tier 1
 * nor Tier 2 produced a full-slot parse (AC-2-7).
 *
 * Wave 6 (AC-6-2) wraps this into the outer `{apiVersion, type:'error', …}`
 * CLI envelope; this internal type stays CLI-agnostic.
 */
export interface Tier3Envelope {
  /** Always `3` — the rung that produced this result. */
  readonly tier: 3
  /** Stable ERR_PARSE_* code identifying the failure class. */
  readonly code: ParseErrorCode
  /** Human-readable description of why parsing failed. */
  readonly error: string
  /** Partial slots recovered by earlier tiers (absent when nothing was salvaged). */
  readonly partial?: PartialSlots
  /**
   * Mechanical rewrite suggestions — concrete, one-shot sentence templates the
   * calling agent can apply in a single turn. Never empty (at least one
   * suggestion is always provided).
   */
  readonly suggestions: readonly string[]
  /**
   * The raw notes from both tiers, forwarded so the caller can derive further
   * diagnostics if needed.
   */
  readonly notes: readonly string[]
  /**
   * For `ERR_PARSE_COMPOUND` only: the confidently-split single requirements the
   * compound splitter recovered (≥2 halves that each re-parse cleanly), so an
   * agent gets machine-actionable ops rather than only a prose "split it"
   * suggestion. Absent (not `undefined`) when the split was not confident or the
   * code is not COMPOUND, per `exactOptionalPropertyTypes`. Generic slot shape —
   * the CLI layer maps these to ready-to-apply `add` ops.
   */
  readonly proposedSplits?: readonly ProposedSplit[]
}

// ---------------------------------------------------------------------------
// Suggestion builders (mechanical rewrites per code)
// ---------------------------------------------------------------------------

function suggestionsFor(code: ParseErrorCode, partial: PartialSlots): readonly string[] {
  switch (code) {
    case 'ERR_PARSE_NO_MODAL':
      return [
        partial.systemName
          ? `Prepend a modal: "the ${partial.systemName} shall <response>."`
          : 'Prepend a modal: "the <system> shall <response>."',
        'Make sure the sentence contains "shall", "must", "will", or "should".',
      ]

    case 'ERR_PARSE_NOT_A_REQUIREMENT':
      return [
        'Rewrite as a requirement: "the <system> shall <response>."',
        'If this is a goal rather than a requirement, consider dropping it or reformulating as "the <system> shall <achieve the goal>."',
      ]

    case 'ERR_PARSE_COMPOUND':
      return [
        'Split into separate requirements at each "and" or "or" conjunction.',
        'Each requirement must contain exactly one "shall" clause (one system, one response).',
        'When the split is unambiguous, `proposedOps` carries the ready-to-apply `add` ops — pipe them straight into `symspec apply`.',
        partial.systemName
          ? `Example split: "the ${partial.systemName} shall <first response>." / "the ${partial.systemName} shall <second response>."`
          : 'Example: "the <system> shall <first response>." / "the <system> shall <second response>."',
      ]

    case 'ERR_PARSE_AMBIGUOUS_CLAUSES':
      return [
        'Reorder clauses to match the canonical EARS structure: "[While <pre>,] [When <trigger>,] the <system> shall <response>."',
        'Separate the precondition (While/Where …) from the trigger (When/If … then) — avoid nesting one inside the other.',
        'If the sentence is passive ("shall be <done>"), rewrite in active voice: "the <system> shall <do>."',
      ]
  }
}

// ---------------------------------------------------------------------------
// Failure-class heuristic
// ---------------------------------------------------------------------------

/**
 * Collect all notes across both tiers into a flat set for code assignment.
 * Returns a `{ notes, partial }` pair derived from a `Tier2Outcome`.
 */
function extractFromOutcome(outcome: Tier2Outcome): {
  allNotes: Set<string>
  triggers: Set<EscalationTrigger>
  partial: PartialSlots
  proposedSplits: readonly ProposedSplit[]
} {
  const allNotes = new Set<string>()
  const triggers = new Set<EscalationTrigger>()
  const partial: PartialSlots = {}

  // Accumulate Tier-1 notes.
  for (const n of outcome.tier1.notes) allNotes.add(n)

  // Accumulate Tier-2 notes and escalation triggers.
  for (const t of outcome.triggers) {
    allNotes.add(t)
    triggers.add(t)
  }
  if (outcome.tier2) {
    for (const n of outcome.tier2.notes) allNotes.add(n)
  }

  // Harvest best-effort partial slots from Tier 1 (if it produced one) or
  // from the Tier-2 repair (if it produced one).
  if (outcome.tier1.ok) {
    partial.patternType = outcome.tier1.slots.patternType
    partial.systemName = outcome.tier1.slots.systemName
    partial.systemResponse = outcome.tier1.slots.systemResponse
    if (outcome.tier1.slots.preCondition !== undefined)
      partial.preCondition = outcome.tier1.slots.preCondition
    if (outcome.tier1.slots.trigger !== undefined) partial.trigger = outcome.tier1.slots.trigger
  } else if (outcome.tier2?.ok) {
    partial.patternType = outcome.tier2.slots.patternType
    partial.systemName = outcome.tier2.slots.systemName
    partial.systemResponse = outcome.tier2.slots.systemResponse
    if (outcome.tier2.slots.preCondition !== undefined)
      partial.preCondition = outcome.tier2.slots.preCondition
    if (outcome.tier2.slots.trigger !== undefined) partial.trigger = outcome.tier2.slots.trigger
  }

  return { allNotes, triggers, partial, proposedSplits: outcome.proposedSplits ?? [] }
}

/**
 * Assign an `ERR_PARSE_*` code from the aggregated notes and triggers.
 *
 * Priority: COMPOUND > NO_MODAL > NOT_A_REQUIREMENT > AMBIGUOUS_CLAUSES.
 */
function assignCode(allNotes: Set<string>, triggers: Set<EscalationTrigger>): ParseErrorCode {
  // Compound conjunction is the most actionable split target.
  if (triggers.has('compound-conjunction')) return 'ERR_PARSE_COMPOUND'

  // Modal-free: no "shall" at all.
  if (allNotes.has('no-modal-clause') || allNotes.has('no-main-clause')) {
    // A sentence that lacks any EARS vocabulary AND any modal is simply not a
    // requirement (e.g. "Fast response times are important").
    if (allNotes.has('empty')) return 'ERR_PARSE_NOT_A_REQUIREMENT'
    return 'ERR_PARSE_NO_MODAL'
  }

  // A Tier-1 miss due to empty input is definitely not a requirement.
  if (allNotes.has('empty')) return 'ERR_PARSE_NOT_A_REQUIREMENT'

  // Tier-2 could not recover modal (ran but found no MD token).
  if (allNotes.has('no-modal-clause')) return 'ERR_PARSE_NO_MODAL'

  // Everything else: nested clauses, passive voice, over-long, system pollution.
  return 'ERR_PARSE_AMBIGUOUS_CLAUSES'
}

// ---------------------------------------------------------------------------
// Error message builders per code
// ---------------------------------------------------------------------------

function messageFor(code: ParseErrorCode, text: string): string {
  switch (code) {
    case 'ERR_PARSE_NO_MODAL':
      return `No modal verb ("shall", "must", "will", "should") found in: "${text}"`
    case 'ERR_PARSE_NOT_A_REQUIREMENT':
      return `Input does not appear to be a requirement (no obligation language): "${text}"`
    case 'ERR_PARSE_COMPOUND':
      return `Compound requirement with top-level "and"/"or" conjunction: "${text}"`
    case 'ERR_PARSE_AMBIGUOUS_CLAUSES':
      return `Clause boundaries could not be unambiguously resolved: "${text}"`
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a Tier-3 error envelope from a completed `Tier2Outcome`.
 *
 * Call this only when {@link outcome} represents a genuine failure — i.e., when
 * the outcome did NOT produce a usable parse (`!outcome.tier1.ok && (!outcome.tier2 || !outcome.tier2.ok)`).
 * Calling it on a successful outcome is technically safe (it will still emit an
 * envelope from the escalation triggers / notes), but semantically wrong.
 *
 * @param text  The original input text, used for human-readable error messages.
 * @param outcome  The Tier-2 outcome carrying Tier-1 + Tier-2 notes.
 *
 * @example
 * const outcome = await runTier2('Fast response times are important')
 * if (!outcome.tier1.ok && !outcome.tier2?.ok) {
 *   const envelope = makeTier3Envelope('Fast response times are important', outcome)
 *   // → { tier:3, code:'ERR_PARSE_NO_MODAL', partial:{}, suggestions:[…], notes:[…] }
 * }
 */
export function makeTier3Envelope(text: string, outcome: Tier2Outcome): Tier3Envelope {
  const { allNotes, triggers, partial, proposedSplits } = extractFromOutcome(outcome)
  const code = assignCode(allNotes, triggers)
  const hasPartial = Object.keys(partial).length > 0
  // proposedSplits are meaningful only for the COMPOUND code, and only when the
  // splitter cleared its confidence guard (≥2 clean halves).
  const hasSplits = code === 'ERR_PARSE_COMPOUND' && proposedSplits.length > 0
  return {
    tier: 3,
    code,
    error: messageFor(code, text),
    ...(hasPartial ? { partial } : {}),
    suggestions: suggestionsFor(code, partial),
    notes: [...allNotes],
    ...(hasSplits ? { proposedSplits } : {}),
  }
}

/**
 * Build a Tier-3 envelope from scratch, from just the notes produced by both
 * tiers and an optional partial-slots skeleton. This overload is for callers
 * who have already decomposed the outcome into individual pieces (e.g. an
 * integration that calls Tier 1 and Tier 2 separately).
 *
 * @param text         The original input text.
 * @param allNotesList All escalation triggers + tier-1 notes + tier-2 notes combined.
 * @param partial      Best-effort slot skeleton, omit when nothing was recovered.
 */
export function makeTier3EnvelopeFromNotes(
  text: string,
  allNotesList: readonly string[],
  partial?: PartialSlots,
): Tier3Envelope {
  const allNotes = new Set(allNotesList)
  const triggers = new Set<EscalationTrigger>()
  // Recover any escalation triggers from the combined notes.
  for (const n of allNotesList) {
    if (
      n === 'compound-conjunction' ||
      n === 'no-rung-matched' ||
      n === 'weak-subject' ||
      n === 'passive-main-clause' ||
      n === 'nested-clause-keyword' ||
      n === 'long-sentence'
    ) {
      triggers.add(n as EscalationTrigger)
    }
  }
  const code = assignCode(allNotes, triggers)
  const safePartial: PartialSlots = partial ?? {}
  const hasPartial = Object.keys(safePartial).length > 0
  return {
    tier: 3,
    code,
    error: messageFor(code, text),
    ...(hasPartial ? { partial: safePartial } : {}),
    suggestions: suggestionsFor(code, safePartial),
    notes: [...allNotes],
  }
}
