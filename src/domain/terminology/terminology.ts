/**
 * THE TERMINOLOGY TIER — set-level vocabulary consistency, propose-only.
 *
 * ## What this tier answers
 *
 * Every other tier asks whether the document's LOGIC holds. This one asks whether its
 * WORDS mean what the atoms assume. Two questions, two codes, both `info` and both
 * non-demoting (`./terminology-codes.ts` argues why at length):
 *
 * - `FND_TERM_INCONSISTENT` — one committed vocabulary entry is being applied in two
 *   requirements whose surrounding text is unrelated. The DUAL of the synonym bridge:
 *   `FND_SIMILAR_SEMANTIC` proposes ADDING an entry because two phrasings look like one
 *   meaning; this questions an existing entry because one phrasing may be two meanings.
 * - `FND_ACRONYM_UNDEFINED` — an acronym in the text is in neither committed table. The
 *   document-level check `GTWR_R37_ACRONYM` describes but cannot run, since R37's whole
 *   scope is one sentence.
 *
 * ## Why the candidate set is the COMMITTED vocabulary, not every repeated word
 *
 * This is the narrowing most worth arguing with, so it is stated rather than left to be
 * inferred from the code.
 *
 * A committed `terms` entry rewrites EVERY body containing the noun — that is the whole
 * point of the table and also its named hazard, blast radius. So if the two concepts it
 * fuses are actually different, the merge fails in the MASKING direction: two requirements
 * land on one atom and the tool reports agreement it never proved. That is the case where
 * the stakes are highest, and it is also the case where the author has already declared
 * the phrase to be vocabulary — so no guessing is needed about what a term is.
 *
 * Mining every repeated word instead would need a function-word lexicon. Without one,
 * `the` occurs in every requirement and would be the first term proposed for a split;
 * with one, the tier acquires a hand-maintained list in the only place it has no business
 * having one, and `lexicon-entries-need-per-entry-reachability-tests` prices that. The
 * broader mining pass is a later increment. Until then {@link TerminologyReport.keysExamined}
 * makes the narrowing legible: a document with empty tables reports zero keys examined
 * rather than reporting silence.
 *
 * ## Why the comparison is over PARSED SLOTS
 *
 * Measured against the pinned model on 28 hand-labelled pairs, comparing whole EARS
 * sentences barely separates drift from honest reuse — because `the system shall` is a
 * constant in every requirement and pulls every pair up. Two requirements sharing NO term
 * at all score 0.6800 as sentences. Joining the parsed `trigger` / `preCondition` /
 * `systemResponse` removes that constant with no lexicon at all, since the document
 * already stores them separately, and cuts the drift/honest-reuse overlap from 0.0977 to
 * 0.0342. See {@link DEFAULT_TERM_COHERENCE_FLOOR} for the bands.
 *
 * ## Propose-only, structurally
 *
 * Cosine reaches a message and nothing else. This module has no solver contact, returns
 * no demotion, and every finding it can produce is `info` — so `exitCodeForEnvelope`
 * ignores it and `data.verified` cannot move. `app/operations/check.ts` splices the result
 * AFTER the engine has computed its coverage disclaimers, which is what keeps
 * `FND_NO_PAIRS_CHECKED` from being suppressed by a finding that compared no requirement
 * pair for consistency.
 */

import { normalize } from '../engine/formal/atomize.ts'
import { cosine, type Embedder } from '../engine/formal/embed.ts'
import { ACRONYM_PATTERN, COMMON_ACRONYMS } from '../engine/lint/gtwr.ts'
import type { RequirementsDocument } from '../requirements/document.ts'
import { TERMINOLOGY_FND_CODES, type TerminologyFndCode } from './terminology-codes.ts'

/**
 * The cosine below which one committed entry's two most distant sites are reported as
 * possible homonym drift.
 *
 * MEASURED, not chosen — against the pinned `Xenova/bge-base-en-v1.5` int8 build (CLS
 * pooling, L2-normalized, no instruction prefix), over 28 hand-labelled requirement pairs
 * comparing parsed slots:
 *
 * | population                                             | band            |
 * | ------------------------------------------------------ | --------------- |
 * | one spelling, two meanings (12 pairs)                   | 0.4785 .. 0.6801 |
 * | one meaning, two requirements (16 pairs)                | 0.6458 .. 0.8665 |
 * | sharing no term at all, for reference (3 pairs)         | 0.5032 .. 0.6538 |
 *
 * At 0.62 that is 9 of 12 genuine homonyms caught and 0 of 16 honest reuses split. The
 * three misses are `seal` 0.6507, `monitor` 0.6796 and `port` 0.6801, named here because a
 * recall figure without its misses is not a measurement. 0.64 catches exactly the same
 * nine while leaving only 0.0058 of margin under the honest-reuse minimum; 0.62 leaves
 * 0.0258 for the same recall, so 0.62 is strictly better.
 *
 * ## PRECISION-favoring, which inverts the sibling rule, on purpose
 *
 * `propose-only-threshold-favor-recall-measure-it` sets the opposite posture for
 * `DEFAULT_SEMANTIC_THRESHOLD`, and the inversion needs its reason stated or it reads as
 * an inconsistency. There, a missed paraphrase hides a real CONFLICT behind two distinct
 * atoms — the expensive failure for a consistency checker — so recall wins. Here a miss
 * hides a wording suggestion that gates nothing, while a false positive is pure noise on a
 * signal an author can only act on by reading two requirements. Noise is what teaches an
 * author to ignore a tier, so it is the expensive failure in this direction. The asymmetry
 * flipped, so the cut flips.
 *
 * NOT derived from and NOT aliased to `DEFAULT_SEMANTIC_THRESHOLD` (0.72, recall-favoring
 * paraphrase detection) or `DEFAULT_OPPOSITION_COSINE_FLOOR` (0.5). Three different
 * judgments; a value shared by coincidence must not become a constant shared by reference.
 */
export const DEFAULT_TERM_COHERENCE_FLOOR = 0.62

/** One terminology finding, in the shape `app/operations/check.ts` splices. */
export interface TerminologyFinding {
  readonly code: TerminologyFndCode
  /** Always `info`. The type says so, so a future `error` needs a deliberate widening. */
  readonly severity: 'info'
  /** The requirements the finding spans, sorted, so the message and the ids agree. */
  readonly requirementIds: readonly string[]
  readonly message: string
  readonly suggestion: string
}

/**
 * What the tier found AND what it examined.
 *
 * The counters exist because "no drift found" and "the tier had nothing to look at" are
 * different facts with different remedies, and silence renders them identically — the same
 * reason `FND_NO_PAIRS_CHECKED` exists. A document with empty tables reports
 * `keysExamined: 0`, which tells a reader to commit vocabulary rather than to relax.
 */
export interface TerminologyReport {
  readonly findings: readonly TerminologyFinding[]
  /** Committed keys that occur in two or more requirements of one system. */
  readonly keysExamined: number
  /** Requirement pairs whose slot texts were compared by cosine. */
  readonly pairsCompared: number
  /** Distinct acronyms found in the document text, common ones excluded. */
  readonly acronymsExamined: number
}

/** Options, threaded from `CheckInput` so the floor is overridable but never guessed. */
export interface TerminologyOptions {
  readonly floor?: number
}

/** One occurrence of a committed key inside one requirement. */
interface Site {
  readonly requirementId: string
  readonly slotText: string
}

/** One committed key, with the author's spelling preserved for the message. */
interface CommittedKey {
  /** The author's phrase, verbatim — never a normalized body. */
  readonly phrase: string
  /** `normalize`d token list, for containment testing against a slot body. */
  readonly tokens: readonly string[]
  /** Which table committed it, which decides the remedy command. */
  readonly table: 'terms' | 'glossary'
}

/**
 * The slot text one requirement contributes.
 *
 * The parsed slots joined in a fixed order, which is what removes the EARS boilerplate
 * without a lexicon (see the module header). `sentence` is deliberately NOT used: it is
 * the rendered form and carries the constant this framing exists to drop.
 */
const slotTextOf = (r: {
  readonly trigger?: string | undefined
  readonly preCondition?: string | undefined
  readonly systemResponse: string
}): string =>
  [r.trigger, r.preCondition, r.systemResponse]
    .filter((s): s is string => s !== undefined && s.trim() !== '')
    .join(' ')

/** Does `haystack` contain `needle` as a CONTIGUOUS token run? */
const containsTokens = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/**
 * Every committed key, deduplicated on its normalized token form.
 *
 * A phrase can be committed twice — as a `terms` canonical and a `glossary` alias — and
 * reporting it twice would name one hazard as two. First writer wins in table order, so
 * the result is a function of the document and not of iteration luck.
 */
const committedKeysOf = (document: RequirementsDocument): readonly CommittedKey[] => {
  const byKey = new Map<string, CommittedKey>()
  const add = (phrase: string, table: 'terms' | 'glossary'): void => {
    const body = normalize(phrase)
    if (body === '') return
    if (byKey.has(body)) return
    byKey.set(body, { phrase, tokens: body.split('_'), table })
  }
  for (const entry of document.terms) {
    add(entry.canonical, 'terms')
    for (const alias of entry.aliases) add(alias, 'terms')
  }
  for (const entry of document.glossary) {
    add(entry.canonical, 'glossary')
    for (const alias of entry.aliases) add(alias, 'glossary')
  }
  return [...byKey.values()].sort((a, b) => a.phrase.localeCompare(b.phrase))
}

/**
 * The remedy commands for splitting an entry, by the table that owns it.
 *
 * `--remove` rather than `unterm` / `unglossary`. Those two are OP-STREAM verbs — valid inside
 * a JSONL plan an agent pipes into `apply`, and NOT commands the CLI accepts. A message a human
 * copies out of `--pretty` has to name the CLI form, and `advice/repair.test.ts` enforces it by
 * resolving every backticked `symspec …` in the catalog against the real program.
 */
const splitCommandsFor = (key: CommittedKey): string =>
  key.table === 'terms'
    ? `\`symspec term "<canonical>" "${key.phrase}" --remove\`, then two \`symspec term\` commands naming the two concepts separately`
    : `\`symspec glossary "<canonical>" "${key.phrase}" --remove\`, then two \`symspec glossary\` commands naming the two concepts separately`

/**
 * Run the terminology tier.
 *
 * Pure apart from the embedder call, and deterministic: the texts are embedded in one
 * batch over a sorted, deduplicated list, the keys are sorted by the author's phrase, and
 * the weakest pair is broken by requirement id so a tie has exactly one answer. No solver
 * contact, no demotion, `info` only.
 */
export const runTerminology = async (
  document: RequirementsDocument,
  embedder: Embedder,
  options: TerminologyOptions = {},
): Promise<TerminologyReport> => {
  const floor = options.floor ?? DEFAULT_TERM_COHERENCE_FLOOR
  const findings: TerminologyFinding[] = []

  const requirements = Object.values(document.requirements)
    .map((r) => ({
      id: r.id,
      systemName: r.systemName,
      slotText: slotTextOf(r),
      sentence: r.sentence,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  // ---------------------------------------------------------------------------
  // FND_TERM_INCONSISTENT
  // ---------------------------------------------------------------------------

  const keys = committedKeysOf(document)

  // Sites per (system, key). Scoped by `systemName` for the reason every other semantic
  // comparison in this tool is: two systems may legitimately use one word for two things,
  // and their atoms never collide because the scope is in the atom name.
  const groups = new Map<string, { readonly key: CommittedKey; readonly sites: Site[] }>()
  for (const r of requirements) {
    const bodyTokens = normalize(r.slotText).split('_')
    for (const key of keys) {
      if (!containsTokens(bodyTokens, key.tokens)) continue
      const groupId = `${r.systemName}␟${key.phrase}`
      const group = groups.get(groupId) ?? { key, sites: [] }
      group.sites.push({ requirementId: r.id, slotText: r.slotText })
      groups.set(groupId, group)
    }
  }

  const live = [...groups.entries()]
    .filter(([, g]) => g.sites.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))

  // ONE embedder call over the deduplicated slot texts every live group needs. Sorted so
  // the batch is a function of the document; deduplicated so a requirement carrying three
  // committed keys is embedded once.
  const wanted = [...new Set(live.flatMap(([, g]) => g.sites.map((s) => s.slotText)))].sort()
  const vectors = new Map<string, Float32Array>()
  if (wanted.length > 0) {
    const embedded = await embedder(wanted)
    for (const [i, text] of wanted.entries()) {
      const vector = embedded[i]
      if (vector !== undefined) vectors.set(text, vector)
    }
  }

  let pairsCompared = 0
  for (const [, group] of live) {
    // The WEAKEST pair, with an explicit tiebreak. A `<=` comparison would silently let
    // the last tie win and nothing would pin which — so ties resolve on the id pair.
    let weakest: { a: Site; b: Site; cosine: number } | undefined
    for (let i = 0; i < group.sites.length; i++) {
      for (let j = i + 1; j < group.sites.length; j++) {
        const a = group.sites[i] as Site
        const b = group.sites[j] as Site
        const va = vectors.get(a.slotText)
        const vb = vectors.get(b.slotText)
        if (va === undefined || vb === undefined) continue
        pairsCompared++
        const score = cosine(va, vb)
        if (
          weakest === undefined ||
          score < weakest.cosine ||
          (score === weakest.cosine &&
            `${a.requirementId}${b.requirementId}`.localeCompare(
              `${weakest.a.requirementId}${weakest.b.requirementId}`,
            ) < 0)
        ) {
          weakest = { a, b, cosine: score }
        }
      }
    }
    if (weakest === undefined || weakest.cosine >= floor) continue

    const ids = [weakest.a.requirementId, weakest.b.requirementId].sort()
    findings.push({
      code: 'FND_TERM_INCONSISTENT',
      severity: 'info',
      requirementIds: ids,
      message:
        `The committed ${group.key.table} entry "${group.key.phrase}" applies in ${ids[0]} and ` +
        `${ids[1]}, whose surrounding text sits at cosine ${weakest.cosine.toFixed(2)} — below the ` +
        `${floor} coherence floor, so the two contexts are about as related as two requirements ` +
        `that share no vocabulary at all. If "${group.key.phrase}" means two different things ` +
        `here, this one entry fuses them into a single atom and a genuine conflict between the ` +
        `two can no longer be proven.`,
      suggestion:
        `Read both requirements. If they are two concepts, split the entry: ` +
        `${splitCommandsFor(group.key)}. If one word across two concerns is intended, leave it — ` +
        `cosine cannot tell those apart, which is why this is a suggestion and moves no verdict.`,
    })
  }

  // ---------------------------------------------------------------------------
  // FND_ACRONYM_UNDEFINED
  // ---------------------------------------------------------------------------

  /** Every token in either committed table, lowercased — what counts as "defined". */
  const definedTokens = new Set<string>()
  for (const key of keys) for (const token of key.tokens) definedTokens.add(token)

  const acronymSites = new Map<string, Set<string>>()
  for (const r of requirements) {
    // `sentence` here, not the slots: R37 reads the rendered form, and the two checks must
    // agree about which acronyms the document contains or they contradict each other about
    // one sentence.
    ACRONYM_PATTERN.lastIndex = 0
    for (const match of r.sentence.matchAll(ACRONYM_PATTERN)) {
      const acronym = match[0]
      if (COMMON_ACRONYMS.has(acronym)) continue
      const sites = acronymSites.get(acronym) ?? new Set<string>()
      sites.add(r.id)
      acronymSites.set(acronym, sites)
    }
  }

  for (const [acronym, sites] of [...acronymSites.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // `normalize` lowercases, so a committed "SLA" and a used "SLA" match here.
    if (definedTokens.has(acronym.toLowerCase())) continue
    const ids = [...sites].sort()
    findings.push({
      code: 'FND_ACRONYM_UNDEFINED',
      severity: 'info',
      requirementIds: ids,
      message:
        `The acronym "${acronym}" is used in ${ids.length === 1 ? '' : 'each of '}${ids.join(', ')} ` +
        `but appears in neither the glossary nor the terms table, so nothing records what it ` +
        `expands to.`,
      suggestion:
        `Define it with \`symspec glossary "<expansion>" "${acronym}"\`, which records the ` +
        `expansion and also makes the two spellings canonicalize to one atom.`,
    })
  }

  return {
    findings,
    keysExamined: live.length,
    pairsCompared,
    acronymsExamined: acronymSites.size,
  }
}

/** Re-exported so a consumer can assert the corpus and the emitter agree on the code set. */
export { TERMINOLOGY_FND_CODES }
