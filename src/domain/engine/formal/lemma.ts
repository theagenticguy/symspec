/**
 * Closed, vendored English verb de-inflection for the LEADING RESPONSE VERB
 * (and establish-verb heads) only — never the remainder of a slot.
 *
 * ## Why vendored, not a dependency
 *
 * The atomization contract demands bit-identical output forever given the same
 * input (AC-4-2a purity). The candidate lemmatizer libraries were evaluated
 * (2026-07) and rejected for this path:
 *   - `wink-lemmatizer` is correct but frozen-CJS with a 13 MB WordNet lexicon
 *     dependency and no types, and it silently mangles nothing we need that the
 *     closed rules below don't already cover;
 *   - `compromise` returns empty strings for bare irregulars (POS-gated);
 *   - `en-inflectors`/`lemmatizer` are abandoned (2017) with verified bugs.
 * English irregular verbs are a CLOSED CLASS, so a vendored table + a closed
 * third-person-singular rule is strictly more auditable: the whole judgment
 * surface is this file, reviewed like the antonym seed table, and a change to
 * it is a documented contract edit — never silent upstream drift.
 *
 * ## Scope
 *
 * `deInflectHead` maps ONE lowercase token to its base verb form:
 *   1. irregular lookup ({@link IRREGULAR_VERB_LEMMAS}: kept→keep, held→hold,
 *      went→go, shut→shut …) — WordNet `verb.exc`-derived, curated to verbs
 *      plausible as an EARS response head;
 *   2. else the closed 3sg rules: `-ies→-y` (denies→deny), `-sses/-shes/-ches/
 *      -xes/-zzes/-oes → strip -es` (passes→pass, buzzes→buzz, goes→go), else
 *      strip a final `-s` when the token is ≥4 chars and does not end
 *      `-ss`/`-us`/`-is` (protects pass/status/basis). A single-`z` stem is a
 *      `-ze` verb taking plain `-s` (energizes→energize), not a sibilant.
 * A token neither rule matches is returned unchanged (OOV technical verbs like
 * "memoizes" fall through to the 3sg rule; unknown pasts stay themselves).
 * Idempotent on base forms: deInflectHead('open') === 'open'.
 */

/**
 * Irregular verb form → base form. Derived from WordNet's `verb.exc` exception
 * table, curated to forms that can plausibly lead an EARS system response or a
 * state-establishment phrase. Past and past-participle forms map to the base;
 * forms identical to their base (cut/put/set/shut…) are listed for documentation
 * value only where the mapping is non-identity. Frozen at module load.
 */
export const IRREGULAR_VERB_LEMMAS: ReadonlyMap<string, string> = new Map([
  ['arose', 'arise'],
  ['arisen', 'arise'],
  ['awoke', 'awake'],
  ['awoken', 'awake'],
  ['bore', 'bear'],
  ['borne', 'bear'],
  ['became', 'become'],
  ['began', 'begin'],
  ['begun', 'begin'],
  ['bent', 'bend'],
  ['bound', 'bind'],
  ['blew', 'blow'],
  ['blown', 'blow'],
  ['broke', 'break'],
  ['broken', 'break'],
  ['brought', 'bring'],
  ['built', 'build'],
  ['bought', 'buy'],
  ['caught', 'catch'],
  ['chose', 'choose'],
  ['chosen', 'choose'],
  ['came', 'come'],
  ['dealt', 'deal'],
  ['did', 'do'],
  ['done', 'do'],
  ['drew', 'draw'],
  ['drawn', 'draw'],
  ['drove', 'drive'],
  ['driven', 'drive'],
  ['fed', 'feed'],
  ['fell', 'fall'],
  ['fallen', 'fall'],
  ['felt', 'feel'],
  ['flew', 'fly'],
  ['flown', 'fly'],
  ['forbade', 'forbid'],
  ['forbidden', 'forbid'],
  ['forgot', 'forget'],
  ['forgotten', 'forget'],
  ['froze', 'freeze'],
  ['frozen', 'freeze'],
  ['gave', 'give'],
  ['given', 'give'],
  ['went', 'go'],
  ['gone', 'go'],
  ['grew', 'grow'],
  ['grown', 'grow'],
  ['hung', 'hang'],
  ['had', 'have'],
  ['heard', 'hear'],
  ['held', 'hold'],
  ['kept', 'keep'],
  ['knew', 'know'],
  ['known', 'know'],
  ['laid', 'lay'],
  ['led', 'lead'],
  ['left', 'leave'],
  ['lent', 'lend'],
  ['lost', 'lose'],
  ['made', 'make'],
  ['meant', 'mean'],
  ['met', 'meet'],
  ['paid', 'pay'],
  ['ran', 'run'],
  ['rang', 'ring'],
  ['rung', 'ring'],
  ['rose', 'rise'],
  ['risen', 'rise'],
  ['said', 'say'],
  ['saw', 'see'],
  ['seen', 'see'],
  ['sold', 'sell'],
  ['sent', 'send'],
  ['shook', 'shake'],
  ['shaken', 'shake'],
  ['shone', 'shine'],
  ['shot', 'shoot'],
  ['showed', 'show'],
  ['shown', 'show'],
  ['shrank', 'shrink'],
  ['shrunk', 'shrink'],
  ['sang', 'sing'],
  ['sung', 'sing'],
  ['sank', 'sink'],
  ['sunk', 'sink'],
  ['sat', 'sit'],
  ['slid', 'slide'],
  ['spoke', 'speak'],
  ['spoken', 'speak'],
  ['spent', 'spend'],
  ['spun', 'spin'],
  ['stood', 'stand'],
  ['stole', 'steal'],
  ['stolen', 'steal'],
  ['stuck', 'stick'],
  ['struck', 'strike'],
  ['swept', 'sweep'],
  ['swung', 'swing'],
  ['took', 'take'],
  ['taken', 'take'],
  ['taught', 'teach'],
  ['tore', 'tear'],
  ['torn', 'tear'],
  ['told', 'tell'],
  ['thought', 'think'],
  ['threw', 'throw'],
  ['thrown', 'throw'],
  ['understood', 'understand'],
  ['undid', 'undo'],
  ['undone', 'undo'],
  ['withdrew', 'withdraw'],
  ['withdrawn', 'withdraw'],
  ['withheld', 'withhold'],
  ['woke', 'wake'],
  ['woken', 'wake'],
  ['wore', 'wear'],
  ['worn', 'wear'],
  ['wound', 'wind'],
  ['wrote', 'write'],
  ['written', 'write'],
  ['fled', 'flee'],
  ['forbore', 'forbear'],
  ['overrode', 'override'],
  ['overridden', 'override'],
  ['rebuilt', 'rebuild'],
  ['reran', 'rerun'],
  ['resent', 'resend'],
  ['retook', 'retake'],
  ['retaken', 'retake'],
  ['rewrote', 'rewrite'],
  ['rewritten', 'rewrite'],
  ['unbound', 'unbind'],
  ['unwound', 'unwind'],
  ['upheld', 'uphold'],
])

/**
 * De-inflect a lowercase verb token to its base form — irregular table first,
 * then the closed third-person-singular rules. Pure, total, idempotent on base
 * forms; tokens no rule matches are returned unchanged. Applied ONLY to the
 * leading verb token of a response (and multiword antonym / establish-verb
 * heads) — never to the remainder, so this is not stemming.
 */
export function deInflectHead(head: string): string {
  const irregular = IRREGULAR_VERB_LEMMAS.get(head)
  if (irregular !== undefined) return irregular
  if (head.length >= 4 && head.endsWith('ies')) return `${head.slice(0, -3)}y`
  // A single `z` is NOT in the sibilant set: a `-ze` verb takes plain `-s`
  // (energizes = energize + s), so only a doubled z (buzzes) strips `-es` —
  // otherwise every `-ze` head mangles to `-z` and misses both the seed
  // antonym table and the negating-prefix comparison keyed on its base form.
  if (/(?:ss|sh|ch|x|zz|o)es$/.test(head)) return head.slice(0, -2)
  if (head.length >= 4 && head.endsWith('s') && !/(?:ss|us|is)$/.test(head)) {
    return head.slice(0, -1)
  }
  return head
}
