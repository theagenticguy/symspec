/**
 * Tier-2 wink-nlp clause repair, lazily imported on escalation (AC-2-6).
 *
 * The parse ladder's fast path is Tier 1 (`tier1.ts`), a zero-dependency regex
 * cascade. This module is the second rung: a POS-driven clause/subject repair
 * that runs ONLY when a Tier-1 escalation trigger fires (research-nlparse.md
 * §1.8, §2). The load-bearing contract this task encodes is the *gating*:
 *
 *   - A CLEAN sentence — one Tier 1 parses confidently with no escalation
 *     trigger — MUST NEVER cause wink-nlp (a ~4.5 MB model) to load. The fast
 *     path stays dependency-free at runtime.
 *   - An ESCALATION-CLASS sentence lazily imports wink-nlp and attempts repair,
 *     loading the model only on escalation.
 *
 * Lazy import + injectable loader. The wink-nlp packages (`wink-nlp` and
 * `wink-eng-lite-web-model`) are added to `dependencies` by a later wave
 * (AC-7-7); this module MUST NOT statically import them. {@link defaultTier2Loader}
 * imports them through non-literal specifiers, so the packages are resolved
 * strictly at runtime, only when the loader is actually invoked — which never
 * happens for clean input. The loader is injectable ({@link Tier2Options.load})
 * so the gating and repair logic are unit-testable without the model installed:
 * tests pass a fake {@link WinkAnalyzer} and assert whether it was called.
 *
 * Scope boundary. This module owns the Tier-2 rung in isolation, matching the
 * established pattern from `negation.ts`/`normalize.ts`/`preprocess.ts`: it does
 * not rewire `tier1.ts`'s cascade and it does not assemble the final
 * `ParseResult`/Tier-3 envelope (T-AC-2-7 / T-AC-2-8). It reuses the hardened
 * pieces those sibling tasks extracted — {@link extractNegation} for the
 * polarity flag and {@link normalizeModal}/{@link normalizeEventKeyword} for
 * canonicalization — rather than reimplementing them.
 *
 * Purity note. {@link escalationTriggers} and {@link repairWithWink} are pure
 * (deterministic in their inputs, no I/O); only {@link defaultTier2Loader}
 * performs the lazy dynamic import.
 */

import type { EarsPattern } from '../core/schema.ts'
import { extractNegation } from './negation.ts'
import { normalizeEventKeyword } from './normalize.ts'
import { preprocess } from './preprocess.ts'
import type { Confidence, Tier1Result, Tier1Slots } from './tier1.ts'
import { classifyTier1, KW, systemEscalationNotes } from './tier1.ts'

// ---------------------------------------------------------------------------
// The wink-nlp adapter surface (the only shape this module depends on)
// ---------------------------------------------------------------------------

/**
 * One analyzed token, reduced to the four wink-nlp annotations Tier-2 repair
 * consumes (research-nlparse.md §2): the surface `value`, the Universal POS
 * (UPOS) `pos` tag, the `lemma`, and the per-token `negationFlag`. The full wink
 * `its` fluent API is hidden inside {@link defaultTier2Loader}; the repair logic
 * and its tests speak only this flat, easily-faked shape.
 *
 * IMPORTANT — tagset: the real `wink-eng-lite-web-model` emits **Universal POS**
 * tags (`DET`, `NOUN`, `PROPN`, `AUX`, `VERB`, `ADJ`, `PRON`, `ADP`, `NUM`,
 * `PART`, `ADV`, `SCONJ`, `PUNCT`…), NOT Penn-Treebank (`DT`/`NN`/`MD`…). This
 * was verified empirically against the installed model (validate-parse-lint.md
 * finding 4). All POS tables in this module — and every test fake — MUST speak
 * UPOS or repair silently fails to recover subjects.
 */
export interface WinkToken {
  /** Surface form of the token (`its.value`). */
  value: string
  /** Universal POS (UPOS) tag, e.g. `AUX` (modal), `NOUN`, `PROPN`, `DET` (`its.pos`). */
  pos: string
  /** Lemma / base form (`its.lemma`). */
  lemma: string
  /** True when wink's negation stage flagged this token (`its.negationFlag`). */
  negationFlag: boolean
}

/** Analyze a sentence into flat {@link WinkToken}s. The unit of repair input. */
export type WinkAnalyzer = (text: string) => WinkToken[]

/** Lazily produce a {@link WinkAnalyzer}. Resolves the model exactly once, on first escalation. */
export type Tier2Loader = () => Promise<WinkAnalyzer>

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A Tier-2 clause-repair success. Mirrors `Tier1Ok` but stamped `tier: 2`. */
export interface Tier2Ok {
  ok: true
  pattern: EarsPattern
  slots: Tier1Slots
  /** True when the modal carried explicit negation; `systemResponse` is the positive atom. */
  negated: boolean
  confidence: Confidence
  tier: 2
  /** Provenance notes: escalation triggers plus repair notes (e.g. `subject-repaired`). */
  notes: string[]
}

/** Tier-2 could not repair the clause; the caller escalates to the Tier-3 envelope (T-AC-2-7). */
export interface Tier2Miss {
  ok: false
  escalate: true
  tier: 2
  notes: string[]
}

export type Tier2Result = Tier2Ok | Tier2Miss

/**
 * One confidently-recovered single requirement proposed from a COMPOUND input
 * (the two halves of "the <system> shall <A> and <B>"). Generic slot shape —
 * this carries NO CLI op vocabulary, so `src/parse/` stays CLI-agnostic; the CLI
 * layer (`cli/add.ts`) maps each `ProposedSplit` to a ready-to-apply `add` op.
 * `negated` is per-half so "shall not <A> and <B>" splits its polarity correctly.
 */
export interface ProposedSplit {
  patternType: EarsPattern
  systemName: string
  systemResponse: string
  preCondition?: string
  trigger?: string
  negated: boolean
}

/**
 * Outcome of {@link runTier2}. Always carries the Tier-1 result and the fired
 * escalation triggers; carries a `tier2` result ONLY when escalation warranted
 * it and the model loaded. `escalated: false` means the loader was never
 * invoked (the clean fast path).
 */
export interface Tier2Outcome {
  /** Whether any escalation trigger fired (i.e. whether Tier 2 was attempted). */
  escalated: boolean
  /** The escalation triggers that fired (empty when `escalated` is false). */
  triggers: EscalationTrigger[]
  /** The Tier-1 result — always present, so a non-escalating caller can use it directly. */
  tier1: Tier1Result
  /**
   * The Tier-2 repair result, present only when `escalated` is true and the
   * loader ran (omitted, not `undefined`, on the clean path —
   * exactOptionalPropertyTypes).
   */
  tier2?: Tier2Result
  /**
   * Confidently-split single requirements recovered from a COMPOUND input
   * (`compound-conjunction` trigger). Present ONLY when the splitter cleared its
   * soundness guard and produced ≥2 halves that each re-parse to a valid single
   * requirement; omitted (not `undefined`) otherwise, so an ambiguous compound
   * carries no bogus proposal. Populated by {@link splitCompound}.
   */
  proposedSplits?: readonly ProposedSplit[]
}

/** Options for {@link runTier2}. */
export interface Tier2Options {
  /**
   * Loader for the wink-nlp analyzer. Defaults to {@link defaultTier2Loader}
   * (the real lazy dynamic import). Injectable so tests exercise gating/repair
   * with a fake analyzer and assert whether the loader was called.
   */
  load?: Tier2Loader
  /**
   * A precomputed Tier-1 result, to avoid re-running {@link classifyTier1}
   * when the caller already has one (e.g. the ladder orchestrator).
   */
  tier1?: Tier1Result
}

// ---------------------------------------------------------------------------
// Escalation triggers (AC-2-6, research-nlparse.md §1.8)
// ---------------------------------------------------------------------------

/**
 * The named escalation triggers AC-2-6 enumerates. Union of the Tier-1 miss
 * conditions (no rung matched / system-clause pollution, both surfacing as a
 * Tier-1 miss) and the soft signals that ride on an otherwise-usable Tier-1
 * parse (weak subject, passive main clause, nested clause keyword) plus the
 * whole-sentence shape checks (over-long, top-level conjunction).
 */
export const ESCALATION_TRIGGERS = [
  /** Tier 1 produced no confident parse (no rung matched, or system-clause pollution). */
  'no-rung-matched',
  /** Person-word subject (`user(s)`, `customer`, …) — user-story shape needing subject repair. */
  'weak-subject',
  /** Response begins with a passive auxiliary (`be`/`been`/`is`/`are` + participle) — needs agent recovery. */
  'passive-main-clause',
  /** A `preCondition`/`trigger` slot contains a second EARS keyword — nested clauses. */
  'nested-clause-keyword',
  /** Sentence exceeds 60 tokens — likely compound / multi-thought. */
  'long-sentence',
  /** A top-level `and`/`or` coordinator — likely a compound requirement to split. */
  'compound-conjunction',
] as const

export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number]

/** Max token count before a sentence is treated as over-long (research-nlparse.md §1.8). */
export const MAX_TIER1_TOKENS = 60

/** Any EARS keyword appearing inside an extracted `pre`/`trigger` group signals nested clauses. */
const NESTED_KEYWORD = new RegExp(`\\b(?:${KW.while}|${KW.when}|${KW.where}|${KW.if})\\b`, 'i')

/** A leading passive auxiliary in the response span (`be backed up`, `is enabled`). */
const PASSIVE_LEAD = /^(?:be|been|is|are)\s+\S+/i

/** A top-level coordinating conjunction (`… and …`, `… or …`, `and/or`). */
const TOP_LEVEL_CONJUNCTION = /\b(?:and|or)\b/i

/**
 * Decide which AC-2-6 escalation triggers fire for `input`. Pure and
 * deterministic. Accepts an optional precomputed Tier-1 result to avoid
 * re-classifying. An empty array means the input is a CLEAN sentence that the
 * fast path handled — Tier 2 (and the wink-nlp model load) must be skipped.
 *
 * @example
 * escalationTriggers('The auth service shall issue a session token')
 * // → []  (clean — never loads wink-nlp)
 *
 * @example
 * escalationTriggers('Users should be able to reset their password.')
 * // → ['weak-subject', 'passive-main-clause']  (user-story shape)
 */
export function escalationTriggers(
  input: string,
  tier1: Tier1Result = classifyTier1(input),
): EscalationTrigger[] {
  const triggers = new Set<EscalationTrigger>()
  const text = preprocess(input)
  const tokenCount = text.split(/\s+/).filter(Boolean).length

  // Whole-sentence shape checks — independent of the Tier-1 verdict.
  if (tokenCount > MAX_TIER1_TOKENS) triggers.add('long-sentence')
  if (TOP_LEVEL_CONJUNCTION.test(text)) triggers.add('compound-conjunction')

  if (!tier1.ok) {
    // A Tier-1 miss covers "no rung matched" AND system-clause pollution
    // (comma / embedded keyword / >6 tokens), which `tier1.ts` turns into a
    // miss rather than a garbage slot set.
    triggers.add('no-rung-matched')
    return [...triggers]
  }

  // Soft signals riding on a usable Tier-1 parse.
  if (
    tier1.notes.includes('weak-subject') ||
    systemEscalationNotes(tier1.slots.systemName).includes('weak-subject')
  ) {
    triggers.add('weak-subject')
  }
  if (PASSIVE_LEAD.test(tier1.slots.systemResponse)) {
    triggers.add('passive-main-clause')
  }
  const clauses = [tier1.slots.preCondition, tier1.slots.trigger].filter(
    (c): c is string => typeof c === 'string',
  )
  if (clauses.some((c) => NESTED_KEYWORD.test(c))) {
    triggers.add('nested-clause-keyword')
  }

  return [...triggers]
}

// ---------------------------------------------------------------------------
// The default lazy loader (the only impure part; never runs for clean input)
// ---------------------------------------------------------------------------

// Non-literal specifiers: keep these out of static module resolution so `tsc`
// and `knip` do not require the packages at type-check time (they are added to
// `dependencies` by AC-7-7) and so nothing loads until the loader is invoked.
const WINK_NLP_SPECIFIER = 'wink-nlp'
const WINK_MODEL_SPECIFIER = 'wink-eng-lite-web-model'

/** Minimal structural view of the wink-nlp surface {@link defaultTier2Loader} touches. */
interface WinkDocTokens {
  out(annotation: unknown): unknown[]
}
interface WinkDoc {
  tokens(): WinkDocTokens
}
interface WinkIts {
  value: unknown
  pos: unknown
  lemma: unknown
  negationFlag: unknown
}
interface WinkNlp {
  readDoc(text: string): WinkDoc
  its: WinkIts
}
type WinkFactory = (model: unknown) => WinkNlp

/**
 * The real Tier-2 loader: lazily `import()`s wink-nlp and its English model
 * (both via non-literal specifiers, so they resolve strictly at call time),
 * builds one `nlp` instance, and returns a {@link WinkAnalyzer} that flattens a
 * document's tokens into {@link WinkToken}s. Invoked at most once per run and
 * ONLY on escalation, so the clean fast path never pays the model-load cost.
 */
export const defaultTier2Loader: Tier2Loader = async () => {
  const winkMod = (await import(WINK_NLP_SPECIFIER)) as { default: WinkFactory }
  const modelMod = (await import(WINK_MODEL_SPECIFIER)) as { default: unknown }
  const nlp = winkMod.default(modelMod.default)
  const { its } = nlp
  return (text: string): WinkToken[] => {
    const doc = nlp.readDoc(text)
    const tokens = doc.tokens()
    const values = tokens.out(its.value)
    const posTags = tokens.out(its.pos)
    const lemmas = tokens.out(its.lemma)
    const negFlags = tokens.out(its.negationFlag)
    return values.map((v, i) => ({
      value: String(v),
      pos: String(posTags[i] ?? ''),
      lemma: String(lemmas[i] ?? ''),
      negationFlag: Boolean(negFlags[i]),
    }))
  }
}

// ---------------------------------------------------------------------------
// POS-driven clause repair (research-nlparse.md §2)
// ---------------------------------------------------------------------------

const MODAL_LEMMAS: ReadonlySet<string> = new Set(['shall', 'must', 'will', 'should'])

/**
 * Universal POS (UPOS) tags that can appear inside a subject noun phrase (for
 * subject-chunk recovery). The real `wink-eng-lite-web-model` emits UPOS, so
 * these are `DET`/`NOUN`/`PROPN`/… — NOT Penn-Treebank `DT`/`NN`/… (see the
 * {@link WinkToken} tagset note; validate-parse-lint.md finding 4). `PRON`
 * covers possessive determiners (`their`, `its`) which UPOS tags as `PRON`.
 * A hyphen joining two nouns (`café-locator`) is handled separately in
 * {@link subjectChunkStart}, since UPOS tags a bare `-` as `PUNCT`.
 */
const NOUN_CHUNK_POS: ReadonlySet<string> = new Set(['DET', 'PRON', 'ADJ', 'NUM', 'NOUN', 'PROPN'])

/** Leading determiners/possessives (UPOS) stripped from a recovered subject to match `systemName` convention. */
const LEADING_DETERMINER_POS: ReadonlySet<string> = new Set(['DET', 'PRON'])

/**
 * A modal verb. The real model tags `shall`/`should`/`must`/`will` as UPOS
 * `AUX` — but so are `be`/`is`/`are`, so the tag alone is insufficient. We pivot
 * strictly on lemma/surface membership in {@link MODAL_LEMMAS}, which is
 * tagset-independent and cannot mistake a passive auxiliary for a modal.
 */
const isModal = (t: WinkToken): boolean =>
  MODAL_LEMMAS.has(t.value.toLowerCase()) || MODAL_LEMMAS.has(t.lemma.toLowerCase())

/** Join token surface forms into slot text, collapsing the whitespace the join introduces. */
function joinTokens(tokens: WinkToken[]): string {
  return (
    tokens
      .map((t) => t.value)
      .join(' ')
      .replace(/\s+([.,;:)])/g, '$1')
      // Collapse spaces around an intra-word hyphen so `café - locator` (three
      // tokens the model splits on the hyphen) rejoins as `café-locator`.
      .replace(/\s*([-‑])\s*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** True for an intra-word hyphen (`café-locator`) that keeps a compound subject contiguous. */
const isCompoundHyphen = (t: WinkToken): boolean => t.value === '-' || t.value === '‑'

/** Start index (inclusive) of the contiguous subject noun chunk ending just left of `modalIdx`. */
function subjectChunkStart(tokens: WinkToken[], modalIdx: number): number {
  let start = modalIdx
  for (let i = modalIdx - 1; i >= 0; i--) {
    const tok = tokens[i]!
    if (NOUN_CHUNK_POS.has(tok.pos)) {
      start = i
      continue
    }
    // A hyphen joining two noun-chunk tokens (`café-locator`) stays in the chunk.
    const prev = tokens[i - 1]
    if (isCompoundHyphen(tok) && start === i + 1 && prev && NOUN_CHUNK_POS.has(prev.pos)) {
      start = i
      continue
    }
    break
  }
  return start
}

/** Classify the leading clause (keyword before the subject) into a pattern + slot. */
interface LeadingClause {
  patternType: EarsPattern
  slotKey: 'preCondition' | 'trigger'
  clauseText: string
  note: string
}

function classifyLeadingClause(leadText: string): LeadingClause | undefined {
  const trimmed = leadText.trim().replace(/^[,\s]+|[,\s]+$/g, '')
  if (trimmed === '') return undefined

  const whileLead = new RegExp(`^${KW.while}\\b\\s*(?<rest>.+)$`, 'i').exec(trimmed)
  if (whileLead?.groups?.rest) {
    return {
      patternType: 'state-driven',
      slotKey: 'preCondition',
      clauseText: whileLead.groups.rest.trim(),
      note: 'tier2-repaired-state',
    }
  }
  const whereLead = new RegExp(`^${KW.where}\\b\\s*(?<rest>.+)$`, 'i').exec(trimmed)
  if (whereLead?.groups?.rest) {
    return {
      patternType: 'optional-feature',
      slotKey: 'preCondition',
      clauseText: whereLead.groups.rest.trim(),
      note: 'tier2-repaired-optional',
    }
  }
  const ifLead = new RegExp(`^${KW.if}\\b\\s*(?<rest>.+)$`, 'i').exec(trimmed)
  if (ifLead?.groups?.rest) {
    // Drop an optional trailing "then" connector left in the clause span.
    const clause = ifLead.groups.rest.replace(/\s*,?\s*then\s*$/i, '').trim()
    return {
      patternType: 'unwanted-behavior',
      slotKey: 'trigger',
      clauseText: clause,
      note: 'tier2-repaired-unwanted',
    }
  }
  const event = normalizeEventKeyword(trimmed)
  if (event && event.rest !== '') {
    return {
      patternType: 'event-driven',
      slotKey: 'trigger',
      clauseText: event.rest.replace(/\s*,?\s*then\s*$/i, '').trim(),
      note: 'tier2-repaired-event',
    }
  }
  return undefined
}

/**
 * POS-driven clause repair over analyzed tokens (research-nlparse.md §2). Pivots
 * on the first modal to rebuild `systemName` (the noun chunk to its left, with
 * leading determiners stripped) and `systemResponse` (everything to its right,
 * with an explicit leading negator extracted to a polarity flag). Any leading
 * EARS keyword before the subject is recovered into `preCondition`/`trigger`.
 *
 * Returns a Tier-2 miss when no modal is present (no repairable main clause) or
 * when the modal has no recoverable subject to its left. Pure over its inputs.
 */
export function repairWithWink(
  input: string,
  analyze: WinkAnalyzer,
  triggers: readonly EscalationTrigger[] = [],
): Tier2Result {
  const text = preprocess(input)
  const tokens = analyze(text)
  const baseNotes: string[] = [...triggers]

  const modalIdx = tokens.findIndex(isModal)
  if (modalIdx < 0) {
    return { ok: false, escalate: true, tier: 2, notes: [...baseNotes, 'no-modal-clause'] }
  }

  const chunkStart = subjectChunkStart(tokens, modalIdx)
  let subjectTokens = tokens.slice(chunkStart, modalIdx)
  // Strip leading determiners to match symspec's article-free `systemName`.
  while (subjectTokens.length > 0 && LEADING_DETERMINER_POS.has(subjectTokens[0]!.pos)) {
    subjectTokens = subjectTokens.slice(1)
  }
  const systemName = joinTokens(subjectTokens)
  if (systemName === '') {
    return { ok: false, escalate: true, tier: 2, notes: [...baseNotes, 'no-subject-recovered'] }
  }

  const responseTokens = tokens.slice(modalIdx + 1)
  if (responseTokens.length === 0) {
    return { ok: false, escalate: true, tier: 2, notes: [...baseNotes, 'no-response-recovered'] }
  }
  const rawResponse = joinTokens(responseTokens)
  const neg = extractNegation(rawResponse)
  // Union of the modal-window negator and any wink negation flag in the response span.
  const negated = neg.negated || responseTokens.some((t) => t.negationFlag)
  const systemResponse = neg.response

  const notes = [...baseNotes]
  const repairNotes: string[] = []
  const modalToken = tokens[modalIdx]!
  if (modalToken.value.toLowerCase() !== 'shall') repairNotes.push('nonstandard-modal')

  // Recover a leading EARS clause (text before the subject noun chunk).
  const leadText = joinTokens(tokens.slice(0, chunkStart))
  const lead = classifyLeadingClause(leadText)

  const slots: Tier1Slots = {
    patternType: lead ? lead.patternType : 'ubiquitous',
    systemName,
    systemResponse,
  }
  if (lead) {
    if (lead.slotKey === 'preCondition') slots.preCondition = lead.clauseText
    else slots.trigger = lead.clauseText
    repairNotes.push(lead.note)
  }

  notes.push(...repairNotes)
  // Tier 2 is a repair tier: confident enough to use, never `high`. Any repair
  // note (or a soft escalation trigger) pins it to `low`.
  const confidence: Confidence = repairNotes.length > 0 || baseNotes.length > 0 ? 'low' : 'medium'

  return {
    ok: true,
    pattern: slots.patternType,
    slots,
    negated,
    confidence,
    tier: 2,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Compound splitter (proposes the two split requirements — feeds `proposedOps`)
// ---------------------------------------------------------------------------

/**
 * UPOS coordinating-conjunction tag (`and`, `or`, `and/or`), plus a surface
 * fallback so a fake analyzer that does not emit `CCONJ` still splits.
 */
const isCoordinator = (t: WinkToken): boolean =>
  t.pos === 'CCONJ' || t.value.toLowerCase() === 'and' || t.value.toLowerCase() === 'or'

/**
 * UPOS tags that open a fresh verb phrase to the RIGHT of a coordinator — the
 * signal that "… and <here> …" begins a SECOND response clause rather than
 * continuing the first. A modal (recognized by lemma via {@link isModal}) or a
 * bare `VERB` qualifies; a determiner / noun / adjective does NOT (that is a
 * coordinated object, e.g. "the request and the response").
 */
const opensResponseClause = (t: WinkToken): boolean => isModal(t) || t.pos === 'VERB'

/**
 * Split a COMPOUND requirement into its constituent single requirements, or
 * return an empty array when the split is not CONFIDENT (soundness guard).
 *
 * The detector ({@link escalationTriggers} `compound-conjunction`) is a naive
 * `\b(and|or)\b` regex and deliberately over-flags — that is a lint decision.
 * This splitter is strictly MORE conservative: it only proposes a split it can
 * prove sound, and otherwise proposes NOTHING (leaving the human-readable
 * suggestion as the only recovery). The guard has three gates:
 *
 *   1. **Structural** — POS-driven. Pivot on the first modal; only a coordinator
 *      that (a) sits to the right of the modal's response span and (b) is
 *      followed by a token that {@link opensResponseClause} (another modal or a
 *      `VERB`) and (c) is NOT preceded by a `VERB` counts as a clause boundary.
 *      This rejects "read and write access" (VERB `and` VERB → shared object)
 *      and "the request and the response" (DET after `and` → coordinated NP).
 *
 *   2. **Reconstruction** — each response fragment is recombined with the SHARED
 *      prefix (everything up to and including the modal: any leading
 *      trigger/precondition + "the <system> shall") into a full candidate
 *      requirement string. The shared subject/pattern/trigger carry across all
 *      halves — the common "shall X and Y" case.
 *
 *   3. **Re-parse** — every candidate is re-parsed through the zero-dependency
 *      {@link classifyTier1} cascade. A half is accepted ONLY if it re-parses to
 *      a confident single requirement (`ok`, and NOT itself compound). If ANY
 *      half fails to yield a clean single requirement, the whole split is
 *      rejected (return `[]`) — we never emit a half-baked op.
 *
 * Deterministic and pure over its inputs (same tokens → same splits, in order).
 */
export function splitCompound(input: string, analyze: WinkAnalyzer): ProposedSplit[] {
  const text = preprocess(input)
  const tokens = analyze(text)

  const modalIdx = tokens.findIndex(isModal)
  if (modalIdx < 0) return []

  // Clause-boundary coordinators strictly inside the response span. A boundary
  // needs a real token on each side, an opener to its right, and a non-verb to
  // its left (so coordinated verbs sharing one object do not split).
  const boundaries: number[] = []
  for (let i = modalIdx + 2; i < tokens.length - 1; i += 1) {
    const tok = tokens[i]!
    if (!isCoordinator(tok)) continue
    const prev = tokens[i - 1]!
    const next = tokens[i + 1]!
    if (prev.pos === 'VERB' && !isModal(next)) continue
    if (!opensResponseClause(next)) continue
    boundaries.push(i)
  }
  if (boundaries.length === 0) return []

  // The shared prefix is every token up to AND INCLUDING the modal ("When X, the
  // auth service shall"); each response fragment sits between consecutive
  // boundaries. A fragment that itself leads with a modal ("… and shall Y")
  // drops that redundant modal — the prefix already supplies one.
  const prefixTokens = tokens.slice(0, modalIdx + 1)
  const prefix = joinTokens(prefixTokens)

  const cutStarts = [modalIdx + 1, ...boundaries.map((b) => b + 1)]
  const cutEnds = [...boundaries, tokens.length]

  const proposals: ProposedSplit[] = []
  for (let h = 0; h < cutStarts.length; h += 1) {
    let fragTokens = tokens.slice(cutStarts[h]!, cutEnds[h]!)
    if (fragTokens.length > 0 && isModal(fragTokens[0]!)) fragTokens = fragTokens.slice(1)
    const fragment = joinTokens(fragTokens)
    if (fragment === '') return []

    // Re-parse the reconstructed candidate through the zero-dependency cascade.
    // A half is accepted ONLY when it re-parses to a confident single
    // requirement with a non-empty response; anything less means the split was
    // not sound and the whole proposal is dropped.
    const candidate = `${prefix} ${fragment}`.replace(/\s+/g, ' ').trim()
    const reparse = classifyTier1(candidate)
    if (!reparse.ok || reparse.slots.systemResponse.trim() === '') return []

    proposals.push({
      patternType: reparse.slots.patternType,
      systemName: reparse.slots.systemName,
      systemResponse: reparse.slots.systemResponse,
      negated: reparse.negated,
      ...(reparse.slots.preCondition !== undefined
        ? { preCondition: reparse.slots.preCondition }
        : {}),
      ...(reparse.slots.trigger !== undefined ? { trigger: reparse.slots.trigger } : {}),
    })
  }

  // A confident split needs at least two clean halves; one half means the
  // coordinator was not a genuine clause boundary after all.
  return proposals.length >= 2 ? proposals : []
}

// ---------------------------------------------------------------------------
// The gated driver
// ---------------------------------------------------------------------------

/**
 * Run the Tier-2 rung with correct escalation gating (AC-2-6).
 *
 * Computes the Tier-1 result and the escalation triggers. When NO trigger fires
 * the input is clean: this returns `{ escalated: false }` WITHOUT invoking the
 * loader — so wink-nlp is never imported for clean sentences. When a trigger
 * fires it lazily loads the analyzer (via `opts.load`, default the real dynamic
 * import) and returns the repair result under `tier2`. A loader failure yields a
 * Tier-2 miss (never throws), so the ladder can fall through to Tier 3.
 *
 * @example
 * // clean → loader never called
 * await runTier2('The auth service shall issue a session token')
 * // → { escalated: false, triggers: [], tier1: {ok:true,…} }
 */
export async function runTier2(input: string, opts: Tier2Options = {}): Promise<Tier2Outcome> {
  const tier1 = opts.tier1 ?? classifyTier1(input)
  const triggers = escalationTriggers(input, tier1)

  if (triggers.length === 0) {
    return { escalated: false, triggers, tier1 }
  }

  const load = opts.load ?? defaultTier2Loader
  let analyze: WinkAnalyzer
  try {
    analyze = await load()
  } catch {
    return {
      escalated: true,
      triggers,
      tier1,
      tier2: { ok: false, escalate: true, tier: 2, notes: [...triggers, 'tier2-load-failed'] },
    }
  }

  const tier2 = repairWithWink(input, analyze, triggers)
  // On a compound input the analyzer is already loaded, so attempt the split
  // here (its POS guard + re-parse decide whether a confident proposal exists).
  const proposedSplits = triggers.includes('compound-conjunction')
    ? splitCompound(input, analyze)
    : []
  return {
    escalated: true,
    triggers,
    tier1,
    tier2,
    ...(proposedSplits.length > 0 ? { proposedSplits } : {}),
  }
}
