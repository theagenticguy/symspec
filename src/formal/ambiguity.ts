/**
 * Deterministic ambiguity-detection core (v3.1 — AC-31-1, AC-31-2, AC-31-3,
 * AC-31-5).
 *
 * This module is the mechanically-deterministic half of the always-on
 * `Ambiguity` finding family the v3 spec introduces. It is PURE and
 * SYNCHRONOUS: no solver, no model, no async, no I/O. Given the same
 * requirements it recomputes bit-identical findings, so the verdict-eligible
 * subset (only the mechanical `and…or` coordination case, AC-31-2) can safely
 * enter the byte-reproducibility contract; everything else is `info` and merely
 * PROPOSES a next action (surface for human/LLM review), never decides a
 * verdict. This mirrors the v2 "propose/decide determinism split" governing
 * invariant at the top of the spec.
 *
 * The design is grounded in the ambiguity-detection literature the spec cites:
 *
 *   - Berry & Kamsties taxonomy — lexical (vague/weasel), scope/quantifier,
 *     referential/anaphoric, and pragmatic/contextual ambiguity are distinct
 *     classes; the first three admit deterministic detection, the fourth does
 *     not (hence AC-31-5's structured punt).
 *   - SREE / Gleich recall-first stance — a lexical linter that fires too
 *     often trains authors to ignore it. The vague lexicon here is kept SHORT
 *     and HIGH-PRECISION for exactly that reason (AC-31-1).
 *   - Ezzini anaphora detection — referential ambiguity detection is
 *     recall-first: we FLAG a pronoun / bare definite NP that has ≥2 candidate
 *     antecedents in scope and list the candidates; we never try to RESOLVE it
 *     (AC-31-3).
 *
 * The `code` string literals below are exactly the values the orchestrator
 * appends to `FndCodeSchema` (`src/formal/codes.ts`); this module does not
 * touch that enum — wiring is the orchestrator's job (AC-31-6).
 */

import type { ReqView } from '../solvers/types.js'

/**
 * The four deterministic-ambiguity finding codes this module emits. Exactly the
 * strings the orchestrator appends to the closed `FndCodeSchema` enum (AC-31-6).
 */
export type AmbiguityCode =
  | 'FND_AMBIGUOUS_VAGUE'
  | 'FND_AMBIGUOUS_QUANTIFIER'
  | 'FND_AMBIGUOUS_REFERENCE'
  | 'FND_AMBIGUITY_NEEDS_JUDGMENT'

/**
 * Severity an ambiguity finding can carry. Only the mechanical un-parenthesized
 * `and…or` coordination case is `warn` (verdict-eligible per AC-31-2); every
 * other category is `info` (propose-only).
 */
export type AmbiguitySeverity = 'info' | 'warn'

/** Which deterministic scope/quantifier pattern an `FND_AMBIGUOUS_QUANTIFIER` finding matched (AC-31-2). */
export type QuantifierPattern = 'and-or-coordination' | 'leading-universal' | 'bare-plural-subject'

/**
 * Structured, JSON-serializable evidence attached to an ambiguity finding. Every
 * field is optional and category-specific; per `exactOptionalPropertyTypes`, a
 * key is OMITTED (never assigned `undefined`) when it does not apply:
 *
 *   - `phrase`     — the offending vague/weasel phrase (`FND_AMBIGUOUS_VAGUE`).
 *   - `pattern`    — which quantifier/scope pattern fired (`FND_AMBIGUOUS_QUANTIFIER`).
 *   - `reference`  — the pronoun / bare definite NP that is under-specified
 *                    (`FND_AMBIGUOUS_REFERENCE`).
 *   - `candidates` — the distinct in-scope antecedents a reference could bind to
 *                    (`FND_AMBIGUOUS_REFERENCE`); recall-first, unresolved.
 */
export interface AmbiguityEvidence {
  readonly phrase?: string
  readonly pattern?: QuantifierPattern
  readonly reference?: string
  readonly candidates?: readonly string[]
}

/**
 * One deterministic ambiguity finding. Mirrors the shared finding shape the
 * other tiers use (`{ code, severity, requirementIds, message, span?, evidence? }`):
 * `span` is a `[start, end)` character range into the requirement `sentence`
 * (present for the located lexical/quantifier/reference categories; absent for
 * the whole-requirement `FND_AMBIGUITY_NEEDS_JUDGMENT` marker).
 */
export interface AmbiguityFinding {
  readonly code: AmbiguityCode
  readonly severity: AmbiguitySeverity
  readonly requirementIds: string[]
  readonly message: string
  readonly span?: [number, number]
  readonly evidence?: AmbiguityEvidence
}

// ---------------------------------------------------------------------------
// AC-31-1 — lexical vague/weasel scan (info)
// ---------------------------------------------------------------------------

/**
 * A SHORT, HIGH-PRECISION vague/weasel lexicon (AC-31-1). Kept deliberately
 * small — curated from the INCOSE Guide for Writing Requirements / ISO 29148
 * ambiguity lists, pared to terms that are almost never used precisely — so the
 * linter does not fire so often that authors learn to ignore it (SREE/Gleich
 * false-positive-fatigue lesson). Matched case-insensitively with word
 * boundaries; multi-word entries are matched as contiguous phrases.
 */
const VAGUE_LEXICON = [
  'fast',
  'user-friendly',
  'adequate',
  'efficient',
  'as appropriate',
  'etc',
  'and so on',
  'reasonable',
  'timely',
  'robust',
  'flexible',
  'approximately',
  'minimal',
  'seamless',
] as const

const isWordChar = (c: string): boolean => /[a-z0-9]/.test(c)

/**
 * Find every word-boundary-delimited occurrence of a phrase from `phrases` in
 * `text`, returning the phrase and its `[start, end)` char span. Deterministic:
 * phrases are scanned in list order, occurrences in left-to-right order.
 */
function findPhraseSpans(
  text: string,
  phrases: readonly string[],
): { phrase: string; start: number; end: number }[] {
  const hits: { phrase: string; start: number; end: number }[] = []
  const lower = text.toLowerCase()
  for (const phrase of phrases) {
    let from = 0
    while (true) {
      const idx = lower.indexOf(phrase, from)
      if (idx < 0) break
      const before = idx === 0 ? ' ' : (lower[idx - 1] ?? ' ')
      const afterIdx = idx + phrase.length
      const after = afterIdx >= lower.length ? ' ' : (lower[afterIdx] ?? ' ')
      if (!isWordChar(before) && !isWordChar(after)) {
        hits.push({ phrase, start: idx, end: afterIdx })
      }
      from = idx + phrase.length
    }
  }
  return hits
}

/**
 * AC-31-1 — emit one `FND_AMBIGUOUS_VAGUE` (info) per DISTINCT vague phrase in a
 * requirement's `sentence`, carrying the offending phrase + char span as
 * evidence. Deduplicated by phrase (first occurrence's span wins) so a term
 * repeated in one sentence is reported once, not once per token.
 */
function detectVague(req: ReqView): AmbiguityFinding[] {
  const sentence = req.sentence ?? ''
  const hits = findPhraseSpans(sentence, VAGUE_LEXICON)
  const findings: AmbiguityFinding[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (seen.has(hit.phrase)) continue
    seen.add(hit.phrase)
    findings.push({
      code: 'FND_AMBIGUOUS_VAGUE',
      severity: 'info',
      requirementIds: [req.id],
      message: `${req.id}: vague/weasel term "${hit.phrase}" is not measurable; replace it with a concrete, testable criterion.`,
      span: [hit.start, hit.end],
      evidence: { phrase: hit.phrase },
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// AC-31-2 — quantifier / scope ambiguity (warn for the mechanical case, else info)
// ---------------------------------------------------------------------------

/**
 * The `and` / `or` coordinators, as word-boundary-delimited tokens. A sentence
 * that contains BOTH — un-parenthesized — is the classic scope ambiguity
 * where the reader cannot tell whether `X and Y or Z` parses as `(X and Y) or Z`
 * or `X and (Y or Z)`. Grouping the coordination with parentheses disambiguates
 * it, so the whole check is gated on the sentence containing no `(` (handled by
 * the caller).
 */
const AND_COORD = /\band\b/gi
const OR_COORD = /\bor\b/gi

/** Earliest match of `re` in `text`, or `undefined`. `re` must carry the global flag. */
function firstMatch(re: RegExp, text: string): { start: number; end: number } | undefined {
  re.lastIndex = 0
  const m = re.exec(text)
  return m === null ? undefined : { start: m.index, end: m.index + m[0].length }
}

/** Leading universal quantifier ("all"/"each"/"every") immediately followed by a determiner — ambiguous scope. */
const LEADING_UNIVERSAL =
  /\b(all|each|every)\s+(the|a|an|those|these|its|their|his|her|our|your|some|any)\b/i

/**
 * A subject that is a BARE plural (no determiner) governing `shall`, e.g.
 * "Users shall …" — leaves the quantity (all users? some users?) unspecified.
 * `(preceding word)?` is captured so we can reject the case where a determiner
 * ("the users", "these records") already scopes the plural.
 */
const BARE_PLURAL_SHALL = /(\b[\w-]+\s+)?\b([A-Za-z][\w-]*s)\s+shall\b/gi

/** Determiners / quantifiers that, when they precede a plural subject, make it NOT bare. */
const DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'each',
  'every',
  'all',
  'this',
  'that',
  'these',
  'those',
  'its',
  'their',
  'our',
  'your',
  'his',
  'her',
  'no',
  'any',
  'some',
])

/** Words ending in "s" that are not plural nouns — kept out of the bare-plural rule for precision. */
const NOT_PLURAL = new Set(['this', 'its', 'always', 'status', 'analysis', 'basis', 'as', 'is'])

function looksPlural(word: string): boolean {
  const w = word.toLowerCase()
  if (NOT_PLURAL.has(w)) return false
  if (w.length < 4) return false
  // Reject common non-plural "-s" endings (process, access, status, analysis).
  return !(w.endsWith('ss') || w.endsWith('us') || w.endsWith('is'))
}

/**
 * AC-31-2 — deterministic scope/quantifier ambiguity over a requirement's
 * `sentence`, emitting at most one finding per pattern:
 *
 *   (a) un-parenthesized `and…or` coordination → severity `warn`
 *       (verdict-eligible; the mechanical case the spec singles out). A sentence
 *       that GROUPS its coordination with parentheses is treated as disambiguated
 *       and NOT flagged.
 *   (b) leading universal ("all/each/every") + determiner → `info`.
 *   (c) bare plural subject of `shall` → `info`.
 */
function detectQuantifier(req: ReqView): AmbiguityFinding[] {
  const sentence = req.sentence ?? ''
  const findings: AmbiguityFinding[] = []

  // (a) and…or coordination — a sentence carrying BOTH `and` and `or` without
  // any grouping parens is scope-ambiguous. Span covers from the first
  // coordinator to the last, i.e. the ambiguous coordination region.
  if (!sentence.includes('(')) {
    const and = firstMatch(AND_COORD, sentence)
    const or = firstMatch(OR_COORD, sentence)
    if (and !== undefined && or !== undefined) {
      const start = Math.min(and.start, or.start)
      const end = Math.max(and.end, or.end)
      findings.push({
        code: 'FND_AMBIGUOUS_QUANTIFIER',
        severity: 'warn',
        requirementIds: [req.id],
        message: `${req.id}: un-parenthesized "and"/"or" coordination "${sentence.slice(start, end)}" is ambiguous; group it with parentheses to fix the intended scope.`,
        span: [start, end],
        evidence: { pattern: 'and-or-coordination' },
      })
    }
  }

  // (b) leading universal + determiner.
  const universal = LEADING_UNIVERSAL.exec(sentence)
  if (universal) {
    findings.push({
      code: 'FND_AMBIGUOUS_QUANTIFIER',
      severity: 'info',
      requirementIds: [req.id],
      message: `${req.id}: universal quantifier followed by a determiner ("${universal[0]}") has ambiguous scope; state whether the rule applies to every member individually or the set collectively.`,
      span: [universal.index, universal.index + universal[0].length],
      evidence: { pattern: 'leading-universal' },
    })
  }

  // (c) bare plural subject of `shall`.
  BARE_PLURAL_SHALL.lastIndex = 0
  let m: RegExpExecArray | null = BARE_PLURAL_SHALL.exec(sentence)
  while (m !== null) {
    const preceding = m[1]?.trim().toLowerCase()
    const subject = m[2]
    if (subject !== undefined && looksPlural(subject) && !DETERMINERS.has(preceding ?? '')) {
      const start = m.index + (m[1]?.length ?? 0)
      findings.push({
        code: 'FND_AMBIGUOUS_QUANTIFIER',
        severity: 'info',
        requirementIds: [req.id],
        message: `${req.id}: bare plural subject "${subject}" leaves the quantity unspecified; name the determiner (e.g. "each ${subject}", "all ${subject}").`,
        span: [start, start + subject.length],
        evidence: { pattern: 'bare-plural-subject' },
      })
      break // one bare-plural finding per requirement is enough (low-noise).
    }
    m = BARE_PLURAL_SHALL.exec(sentence)
  }

  return findings
}

// ---------------------------------------------------------------------------
// AC-31-3 — referential / anaphoric ambiguity (always info, recall-first)
// ---------------------------------------------------------------------------

/** Pronouns that, with ≥2 candidate antecedents in scope, are referentially ambiguous (AC-31-3). */
const PRONOUNS = /\b(it|this|they|them|that)\b/gi
/** Bare definite noun phrases that are ambiguous when >1 distinct system is in scope. */
const BARE_DEFINITE_NP = /\bthe\s+(system|service)\b/gi

/**
 * AC-31-3 — referential/anaphoric ambiguity. Recall-first per Ezzini: FLAG when
 * a pronoun ("it"/"this"/"they"/"them"/"that") or a bare definite NP
 * ("the system"/"the service") appears while ≥2 DISTINCT `systemName`s exist
 * across the document, and list those systems as the candidate antecedents in
 * evidence. Resolution is deliberately punted. Reports the EARLIEST such
 * reference in each requirement's `sentence` (one finding per requirement, so
 * the pass stays low-noise while still surfacing the ambiguity).
 *
 * `candidates` are the distinct in-scope antecedents (the ≥2 systems); passed in
 * pre-computed so the doc-level scope is calculated once, not per requirement.
 */
function detectReference(req: ReqView, candidates: readonly string[]): AmbiguityFinding[] {
  if (candidates.length < 2) return []
  const sentence = req.sentence ?? ''

  const hits: { phrase: string; start: number; end: number }[] = []
  PRONOUNS.lastIndex = 0
  let pm: RegExpExecArray | null = PRONOUNS.exec(sentence)
  while (pm !== null) {
    hits.push({ phrase: pm[0], start: pm.index, end: pm.index + pm[0].length })
    pm = PRONOUNS.exec(sentence)
  }
  BARE_DEFINITE_NP.lastIndex = 0
  let nm: RegExpExecArray | null = BARE_DEFINITE_NP.exec(sentence)
  while (nm !== null) {
    hits.push({ phrase: nm[0], start: nm.index, end: nm.index + nm[0].length })
    nm = BARE_DEFINITE_NP.exec(sentence)
  }
  if (hits.length === 0) return []

  // Deterministic pick: earliest span, tie-broken by phrase text.
  hits.sort((a, b) => a.start - b.start || a.phrase.localeCompare(b.phrase))
  const hit = hits[0]
  if (hit === undefined) return []

  return [
    {
      code: 'FND_AMBIGUOUS_REFERENCE',
      severity: 'info',
      requirementIds: [req.id],
      message: `${req.id}: reference "${hit.phrase}" has ${candidates.length} candidate antecedents in scope (${candidates.join(', ')}); name the intended one explicitly.`,
      span: [hit.start, hit.end],
      evidence: { reference: hit.phrase, candidates },
    },
  ]
}

// ---------------------------------------------------------------------------
// AC-31-5 — structured pragmatic/contextual punt (info, low-noise)
// ---------------------------------------------------------------------------

/**
 * A requirement is "long/complex" enough to be worth a pragmatic-review marker
 * when its sentence exceeds this word count. Pragmatic (contextual) ambiguity
 * is the Berry & Kamsties class that is NOT deterministically decidable, so we
 * keep this catch low-noise: it fires only on genuinely long requirements that
 * produced none of the deterministic findings above.
 */
const LONG_REQUIREMENT_WORD_COUNT = 25

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}

/**
 * AC-31-5 — replace the SILENT contextual-ambiguity punt with a STRUCTURED one.
 * Mirrors the `FND_NEEDS_REVIEW` pattern: an info-tier `FND_AMBIGUITY_NEEDS_JUDGMENT`
 * that names the requirement and states that pragmatic/contextual ambiguity was
 * not assessed deterministically, suggesting an LLM/agent review. Emitted ONLY
 * as a low-noise catch — for a long/complex requirement that triggered NONE of
 * the deterministic categories — so it never spams a document where the
 * deterministic tiers already have something to say.
 */
function needsJudgment(req: ReqView): AmbiguityFinding | undefined {
  const sentence = req.sentence ?? ''
  if (wordCount(sentence) <= LONG_REQUIREMENT_WORD_COUNT) return undefined
  return {
    code: 'FND_AMBIGUITY_NEEDS_JUDGMENT',
    severity: 'info',
    requirementIds: [req.id],
    message: `${req.id}: pragmatic/contextual ambiguity was not assessed deterministically for this long requirement; hand it to an LLM/agent review pass. This finding is informational and never enters the reproducibility contract.`,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Distinct `systemName`s across the document, sorted, for the reference-scope check (AC-31-3). */
function distinctSystems(reqs: readonly ReqView[]): string[] {
  const seen = new Set<string>()
  const systems: string[] = []
  for (const r of reqs) {
    const name = r.systemName?.trim()
    if (name === undefined || name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    systems.push(name)
  }
  return systems.sort((a, b) => a.localeCompare(b))
}

/**
 * Detect the deterministic ambiguity categories over a document's requirements
 * (v3.1: AC-31-1 vague, AC-31-2 quantifier/scope, AC-31-3 referential, AC-31-5
 * structured pragmatic punt).
 *
 * PURE and DETERMINISTIC: byte-reproducible given the same requirements — no
 * solver, no model, no async, no I/O. Findings are produced in a fixed order
 * (requirement order, then category order: vague → quantifier → reference),
 * with the per-requirement `FND_AMBIGUITY_NEEDS_JUDGMENT` marker appended only
 * when a long requirement produced none of the deterministic findings.
 */
export function detectAmbiguity(reqs: readonly ReqView[]): AmbiguityFinding[] {
  const systems = distinctSystems(reqs)
  const findings: AmbiguityFinding[] = []

  for (const req of reqs) {
    const perReq: AmbiguityFinding[] = [
      ...detectVague(req),
      ...detectQuantifier(req),
      ...detectReference(req, systems),
    ]
    if (perReq.length === 0) {
      const marker = needsJudgment(req)
      if (marker !== undefined) perReq.push(marker)
    }
    findings.push(...perReq)
  }

  return findings
}
