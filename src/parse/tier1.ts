/**
 * Tier-1 regex cascade classifier (AC-2-1).
 *
 * A zero-dependency parser that classifies requirement-shaped prose into EARS
 * slots by leading keyword, through the ordered cascade validated in
 * research-nlparse.md §1.4 / §1.7:
 *
 *   complex → unwanted (if…then) → event (when) → state (while)
 *           → optional (where) → ubiquitous
 *
 * Order is load-bearing (research §1.4):
 *   - `complex` (While…, when…) MUST precede `state`, which would otherwise
 *     greedily swallow the whole sentence.
 *   - `if…then` MUST precede `when`, since bare-`if` sentences fall through to a
 *     secondary conditional pattern.
 *
 * The single biggest accuracy lever (research §1.1, §1.4): every rung is
 * considered *matched* only when its main clause `<system> shall <response>`
 * parses via {@link MAIN}. A keyword match whose main clause does not parse is
 * not a partial success — it falls through to the next rung. This prevents
 * "While in Rome…" prose from being misclassified as state-driven.
 *
 * Module scope: this file bundles cascade + MAIN + escalation predicates.
 * Preprocessing (AC-2-5) lives in preprocess.ts. Later tasks (T-AC-2-3 modal
 * normalization, T-AC-2-4 negation, T-AC-2-6 Tier-2) extract and harden
 * individual pieces into their own modules and delegate back to this cascade.
 */

import type { EarsPattern } from '../core/schema.js'
import { preprocess } from './preprocess.js'

export type Confidence = 'high' | 'medium' | 'low'

/** EARS slots extracted by the Tier-1 cascade. Optional slots are omitted (not `undefined`) when absent. */
export interface Tier1Slots {
  patternType: EarsPattern
  systemName: string
  systemResponse: string
  preCondition?: string
  trigger?: string
}

/** A confident-enough Tier-1 parse. */
export interface Tier1Ok {
  ok: true
  pattern: EarsPattern
  slots: Tier1Slots
  /** True when the modal carried an explicit negator; `systemResponse` holds the positive atom. */
  negated: boolean
  confidence: Confidence
  tier: 1
  /** Provenance notes (e.g. `nonstandard-modal`, `weak-subject`, `if-without-then`). */
  notes: string[]
}

/** Tier-1 could not produce a trustworthy parse; the caller should escalate to Tier 2/3. */
export interface Tier1Miss {
  ok: false
  escalate: true
  /** Reasons the match was rejected — feed the Tier-2 decision (research §1.8). */
  notes: string[]
}

export type Tier1Result = Tier1Ok | Tier1Miss

// ---------------------------------------------------------------------------
// Keyword alternations — the vocabulary layer (research §1.2)
// ---------------------------------------------------------------------------

export const KW = {
  // state-driven (While) + synonyms
  while: String.raw`(?:while|whilst|as\s+long\s+as|during(?:\s+the\s+time)?(?:\s+that)?)`,
  // event-driven (When) + synonyms
  when: String.raw`(?:when(?:ever)?|upon|once|after|as\s+soon\s+as|on\s+receipt\s+of|in\s+the\s+event\s+that)`,
  // optional-feature (Where) + common installation phrasings
  where: String.raw`(?:where|in\s+installations?\s+where|for\s+configurations?\s+where)`,
  // unwanted-behavior (If…then)
  if: 'if',
  // modal verbs accepted in the main clause; non-`shall` modals downgrade confidence
  modal: '(?:shall|must|will|should)',
} as const

/** Person-word subjects signal a user-story shape needing Tier-2 repair (research §1.8). */
const PERSON_WORDS = /^(?:users?|customers?|operators?|admins?|administrators?)$/i

/** Any EARS keyword appearing inside an extracted `system` group signals clause pollution. */
const ANY_KEYWORD =
  /\b(?:while|whilst|when|whenever|upon|once|after|where|if|as\s+long\s+as|as\s+soon\s+as|in\s+the\s+event\s+that|on\s+receipt\s+of)\b/i

/**
 * A modal verb anywhere in the line. Used to distinguish a TRUNCATED requirement
 * ("The system shall" — modal present but no response) from genuine no-modal
 * prose, so the former errors instead of being silently skipped as prose
 * (validate-parse-lint.md finding P35).
 */
const MODAL_ANYWHERE = new RegExp(String.raw`\b${KW.modal}\b`, 'i')

// ---------------------------------------------------------------------------
// The MAIN-clause regex — system + modal + negation + response (research §1.3)
// ---------------------------------------------------------------------------

/**
 * Lazy `(?<system>.+?)` + anchored modal makes the modal verb the pivot:
 * everything left of the first modal is the system, everything right is the
 * response. `(?:the|an|a\s+)?` strips a leading article — definite (`the`) or
 * indefinite (`a`/`an`) — to match symspec's article-free `systemName`
 * convention (validate-parse-lint.md finding P22: `a virus scan` → `virus
 * scan`). The `neg` group captures an explicit negator so the formal tier
 * receives `¬R` rather than a string containing "not".
 */
export const MAIN = new RegExp(
  String.raw`^(?:(?:the|an|a)\s+)?(?<system>.+?)\s+(?<modal>${KW.modal})\s+` +
    String.raw`(?<neg>not\s+|never\s+|not\s+be\s+able\s+to\s+)?(?<response>.+)$`,
  'i',
)

// ---------------------------------------------------------------------------
// The pattern cascade (research §1.4)
// ---------------------------------------------------------------------------

const P = {
  // While <pre>, when|if <trigger>, [then] <main>  → complex (pre + trigger)
  complex: new RegExp(
    String.raw`^${KW.while}\s+(?<pre>.+?),\s*(?:${KW.when}|${KW.if})\s+(?<trigger>.+?),\s*(?:then\s+)?(?<main>.+)$`,
    'i',
  ),
  // If <trigger>[,] then <main>                    → unwanted-behavior
  unwanted: new RegExp(String.raw`^${KW.if}\s+(?<trigger>.+?),?\s*then\s+(?<main>.+)$`, 'i'),
  // If <trigger>, <main>  (no "then")              → unwanted-behavior, medium
  unwantedNoThen: new RegExp(
    String.raw`^${KW.if}\s+(?<trigger>.+?),\s*(?<main>(?:the\s+)?\S.*?\s${KW.modal}\s.+)$`,
    'i',
  ),
  // When <trigger>, <main>                         → event-driven
  event: new RegExp(String.raw`^${KW.when}\s+(?<trigger>.+?),\s*(?<main>.+)$`, 'i'),
  // When <trigger> <main>  (missing comma)         → event-driven, medium
  eventNoComma: new RegExp(
    String.raw`^${KW.when}\s+(?<trigger>.+?)\s+(?<main>(?:the\s+)\S.*?\s${KW.modal}\s.+)$`,
    'i',
  ),
  // While <pre>, <main>                            → state-driven
  state: new RegExp(String.raw`^${KW.while}\s+(?<pre>.+?),\s*(?<main>.+)$`, 'i'),
  // Where <pre>, <main>                            → optional-feature
  optional: new RegExp(String.raw`^${KW.where}\s+(?<pre>.+?),\s*(?<main>.+)$`, 'i'),
} as const

/** One rung of the cascade. `complex` is a synthetic label that maps onto `event-driven`. */
interface Rung {
  label: EarsPattern | 'complex'
  re: RegExp
  confidence: Confidence
  /** Emitted onto the result when this rung matched. */
  note?: string
}

const ORDER: Rung[] = [
  { label: 'complex', re: P.complex, confidence: 'high' },
  { label: 'unwanted-behavior', re: P.unwanted, confidence: 'high' },
  {
    label: 'unwanted-behavior',
    re: P.unwantedNoThen,
    confidence: 'medium',
    note: 'if-without-then',
  },
  { label: 'event-driven', re: P.event, confidence: 'high' },
  { label: 'event-driven', re: P.eventNoComma, confidence: 'medium', note: 'missing-comma' },
  { label: 'state-driven', re: P.state, confidence: 'high' },
  { label: 'optional-feature', re: P.optional, confidence: 'high' },
]

// ---------------------------------------------------------------------------
// Preprocessing (AC-2-5) — exported from preprocess.ts, re-exported here
// for backward compatibility during the migration.
// ---------------------------------------------------------------------------

export { preprocess } from './preprocess.js'

// ---------------------------------------------------------------------------
// Escalation predicates (research §1.8)
// ---------------------------------------------------------------------------

const HARD_ESCALATION = 'system-clause-pollution'

/**
 * Tier-1 → Tier-2 escalation triggers evaluated over a parsed system group
 * (research §1.8). Returns the notes that fired. A "hard" trigger
 * ({@link HARD_ESCALATION}) means the parse is untrustworthy and Tier-1 should
 * emit a miss rather than a confident slot set; softer triggers annotate an
 * otherwise-usable low-confidence parse. Exported so the Tier-2 driver
 * (T-AC-2-6) reuses the same predicate.
 */
export function systemEscalationNotes(system: string): string[] {
  const notes: string[] = []
  const tokens = system.trim().split(/\s+/).filter(Boolean)
  if (system.includes(',') || ANY_KEYWORD.test(system) || tokens.length > 6) {
    notes.push(HARD_ESCALATION)
  }
  if (tokens.length === 1 && PERSON_WORDS.test(tokens[0]!)) {
    notes.push('weak-subject')
  }
  return notes
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const downgrade = (c: Confidence, floor: Confidence): Confidence => {
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }
  return rank[floor] < rank[c] ? floor : c
}

/** Parse a MAIN clause into slots, or return null when the mandatory `<system> shall <response>` gate fails. */
interface MainParse {
  systemName: string
  systemResponse: string
  negated: boolean
  modal: string
}

function parseMain(main: string): MainParse | null {
  const m = MAIN.exec(main.trim())
  if (!m?.groups) return null
  const { system, modal, neg, response } = m.groups
  if (!system || !modal || !response) return null
  return {
    systemName: system.trim(),
    systemResponse: response.trim(),
    negated: neg != null,
    modal: modal.toLowerCase(),
  }
}

/**
 * Classify a single already-line-split input through the Tier-1 cascade.
 * Runs {@link preprocess} first. Returns a confident/low-confidence parse
 * ({@link Tier1Ok}) or a miss ({@link Tier1Miss}) that the caller escalates.
 */
export function classifyTier1(input: string): Tier1Result {
  const text = preprocess(input)
  if (text === '') return { ok: false, escalate: true, notes: ['empty'] }

  for (const rung of ORDER) {
    const m = rung.re.exec(text)
    if (!m?.groups?.main) continue
    const main = parseMain(m.groups.main)
    if (!main) continue // main-clause gate failed → fall through (research §1.4)

    const built = buildResult({
      label: rung.label,
      confidence: rung.confidence,
      main,
      ...(m.groups.pre != null ? { pre: m.groups.pre } : {}),
      ...(m.groups.trigger != null ? { trigger: m.groups.trigger } : {}),
      ...(rung.note != null ? { rungNote: rung.note } : {}),
    })
    if (built) return built
  }

  // No cascade rung matched — try the bare main clause → ubiquitous.
  const main = parseMain(text)
  if (main) {
    const built = buildResult({ label: 'ubiquitous', confidence: 'high', main })
    if (built) return built
    return { ok: false, escalate: true, notes: [HARD_ESCALATION] }
  }

  // No parseable main clause. Distinguish two cases (validate-parse-lint.md
  // finding P35): a line with a modal but no response ("The system shall") is a
  // TRUNCATED requirement an agent wrote — it must surface as an error, not be
  // silently dropped as prose. A line with no modal at all ("While in Rome, do
  // as the Romans do") is genuine prose → `no-main-clause` (Tier 3 →
  // ERR_PARSE_NO_MODAL → skipped).
  if (MODAL_ANYWHERE.test(text)) {
    return { ok: false, escalate: true, notes: ['modal-without-response'] }
  }

  // No modal main clause at all — not a requirement / needs Tier 2/3.
  return { ok: false, escalate: true, notes: ['no-main-clause'] }
}

function buildResult(args: {
  label: EarsPattern | 'complex'
  confidence: Confidence
  main: MainParse
  pre?: string
  trigger?: string
  rungNote?: string
}): Tier1Result {
  const { label, main, pre, trigger, rungNote } = args
  const escalation = systemEscalationNotes(main.systemName)
  if (escalation.includes(HARD_ESCALATION)) {
    return { ok: false, escalate: true, notes: escalation }
  }

  const notes: string[] = []
  if (rungNote) notes.push(rungNote)
  notes.push(...escalation)

  let confidence = args.confidence
  if (main.modal !== 'shall') {
    notes.push('nonstandard-modal')
    confidence = downgrade(confidence, 'medium')
  }
  if (escalation.includes('weak-subject')) {
    confidence = downgrade(confidence, 'low')
  }

  // `complex` (While P, when T, …) maps to event-driven carrying both slots.
  const patternType: EarsPattern = label === 'complex' ? 'event-driven' : label

  const slots: Tier1Slots = {
    patternType,
    systemName: main.systemName,
    systemResponse: main.systemResponse,
  }
  const preClean = pre?.trim()
  const triggerClean = trigger?.trim()
  if (preClean) slots.preCondition = preClean
  if (triggerClean) slots.trigger = triggerClean

  return {
    ok: true,
    pattern: patternType,
    slots,
    negated: main.negated,
    confidence,
    tier: 1,
    notes,
  }
}
