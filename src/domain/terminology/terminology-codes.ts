/**
 * THE TERMINOLOGY FINDING CODES — greenfield-owned.
 *
 * ## Why these are not in `engine/formal/codes.ts`
 *
 * Codes live with the tier that emits them, the same split by PROVENANCE that
 * `../reachability/reachability-codes.ts` records: the engine's catalog is closed over
 * what the engine's pipeline fires, and this tier is greenfield. `app/runtime/catalog.ts`
 * unions them so `explain` and the manifest see one flat vocabulary, and an agent cannot
 * tell which file the bytes live in.
 *
 * ## Append-only, and the ordering rule
 *
 * Never renumber, never rename, never remove. New codes go at the END of
 * {@link TERMINOLOGY_FND_CODES}. The count is pinned in `catalog.test.ts`, so growing the
 * vocabulary is a visible edit in review.
 *
 * ## Why exactly two, and why both are `info` and NON-DEMOTING
 *
 * Both answer a question about the document's VOCABULARY rather than about its logic, and
 * each has a different remedy — which is the test for whether a code deserves to exist.
 *
 * - `FND_TERM_INCONSISTENT` — **info**. A committed table entry is rewriting bodies in two
 *   requirements whose contexts are unrelated, so that one entry may be fusing two
 *   concepts into one atom. The remedy is to split the entry or to leave it.
 * - `FND_ACRONYM_UNDEFINED` — **info**. The document uses an acronym that appears in
 *   neither committed table. The remedy is to define it.
 *
 * Neither pushes a coverage demotion, and that is a deliberate exception to the
 * DEMOTION-ONLY doctrine rather than an oversight, so it is worth stating why. The
 * doctrine (`.erpaval/solutions/architecture/verified-is-decide-tier-not-any-comparison.md`)
 * says a propose-only finding may DEMOTE `verified` but never promote it — it grants
 * permission, it does not compel. A demotion is a claim that the tool could not check
 * something, and it carries an obligation: `check --strict` exits 3 until the author
 * discharges it. Neither of these findings is a coverage gap. The solver checked
 * everything it was going to check; what these say is that the author's WORDS may not mean
 * what the atoms assume. Turning that into a gate would make a wording opinion block a
 * build, and an author who cannot discharge it honestly will waive it — which costs the
 * signal its meaning.
 *
 * The consequence is that these two codes are the only `FND_*` codes whose presence
 * changes nothing an exit code can observe. `severity: 'info'` already guarantees
 * `exitCodeForEnvelope` ignores them; the absence of a demotion is what keeps
 * `data.verified` and `strictGate` unmoved.
 */

/**
 * The terminology finding codes, in append-only order.
 *
 * Not prefixed with a shared family stem, unlike `FND_REACHABILITY_*`, because these two
 * name unrelated properties and a common prefix would make `nearestCodesAll` rank a
 * misspelling of one against the other. `FND_TERM_INCONSISTENT` is the name AC-31-4 gave
 * it three increments before it was built, kept verbatim so the spec still reads true.
 */
export const TERMINOLOGY_FND_CODES = ['FND_TERM_INCONSISTENT', 'FND_ACRONYM_UNDEFINED'] as const

export type TerminologyFndCode = (typeof TERMINOLOGY_FND_CODES)[number]

/**
 * The description corpus.
 *
 * In the `FND_*` shape so `app/runtime/catalog.ts` parses these with the SAME parsers it
 * uses on every other family: a leading `<severity> — ` prefix (em dash, U+2014 — a
 * hyphen matches nothing, so `FND_SEVERITY_PREFIX` would report `severity: null`), and a
 * trailing `Suggestion:` clause where there is a remedy. The format is load-bearing, which
 * is why these read formulaically.
 */
export const TerminologyFndCodeMeta: Record<
  TerminologyFndCode,
  { readonly code: TerminologyFndCode; readonly description: string }
> = {
  FND_TERM_INCONSISTENT: {
    code: 'FND_TERM_INCONSISTENT',
    description:
      'info — one COMMITTED vocabulary entry (a `terms` noun or a `glossary` phrase) is being ' +
      'applied in two requirements whose surrounding text is unrelated, which is what a single ' +
      'spelling used for two different things looks like. The DUAL of the synonym bridge: where ' +
      'FND_SIMILAR_SEMANTIC proposes ADDING an entry because two phrasings mean one thing, this ' +
      'questions an existing entry because one phrasing may mean two. It matters because the ' +
      'failure is in the masking direction — a term entry rewrites every body containing the ' +
      'noun, so if the two concepts differ, both requirements land on ONE atom and a genuine ' +
      'conflict between them can no longer be proven. Cosine PROPOSES this and nothing more: the ' +
      'finding is info-severity and pushes no coverage demotion, so it cannot move `verified`, ' +
      'the strict gate, or the exit code. Suggestion: read the two requirements the message names, ' +
      'then either split the entry into two narrower ones — drop the broad one with ' +
      '`symspec term --remove` (or `symspec glossary --remove`) and commit two specific ones — ' +
      'or leave it, because reusing one word across two unrelated concerns is legitimate and ' +
      'this tier cannot tell the difference, which is why it suggests rather than decides.',
  },
  FND_ACRONYM_UNDEFINED: {
    code: 'FND_ACRONYM_UNDEFINED',
    description:
      'info — an acronym appears in the document text but in neither committed table, so nothing ' +
      'records what it expands to. This is the DOCUMENT-LEVEL check that GTWR_R37_ACRONYM ' +
      'describes but cannot perform: R37 reads one statement at a time and has no table in scope, ' +
      'so it can only say that a statement carries an unexpanded acronym. The two are different ' +
      'claims and neither subsumes the other — R37 is per-statement style, which a glossary entry ' +
      'does not satisfy, while this is definition coverage, which a glossary entry does satisfy ' +
      'and therefore SILENCES. Suggestion: define each acronym the message names with ' +
      '`symspec glossary "<expansion>" "<acronym>"`, which both records the expansion and makes ' +
      'the two spellings canonicalize to one atom.',
  },
}
