/**
 * THE ATOM KEY — direct coverage of the function every verdict rests on.
 *
 * ## Why this file exists now
 *
 * `atomize.ts`'s own header says it is "the tier whose behavior is pinned by
 * `atomize.test.ts`". That file did not exist. Until the term table landed, the whole
 * formal directory had exactly one test (`lemma.test.ts`), and atomization was covered only
 * indirectly — through the propose tier, the fabrication corpus, and one verbatim atom name
 * asserted against the README. Adding a rewrite rule to the decide key without adding direct
 * coverage would have inherited that gap instead of paying it down.
 *
 * The subject here is the TERM substitution specifically. The three older rewrites (glossary,
 * copula, antonym) keep their existing indirect coverage; what is new is a rule that edits a
 * body from the inside, and every clause of it is asserted separately below.
 */

import { describe, expect, it } from 'vitest'
import { ANTONYM_INDEX } from './antonyms.ts'
import { atomize, glossaryIndex, normalize, termIndex } from './atomize.ts'
import { ESTABLISH_VERBS } from './guard-implication.ts'

/** The body of a `resp` atom, which is what the solver compares. */
const respBody = (text: string, terms?: ReadonlyMap<string, readonly string[]>): string =>
  atomize({
    kind: 'resp',
    text,
    systemName: 'auth service',
    ...(terms !== undefined ? { terms } : {}),
  }).ref.body

const preBody = (text: string, terms?: ReadonlyMap<string, readonly string[]>): string =>
  atomize({
    kind: 'pre',
    text,
    systemName: 'auth service',
    ...(terms !== undefined ? { terms } : {}),
  }).ref.body

const TERMS = termIndex([{ canonical: 'session token', aliases: ['login credential'] }])

describe('a committed term is substituted INSIDE the body', () => {
  it('aligns the noun while leaving the verb alone', () => {
    // The compositional payoff: ONE entry, and every phrasing containing the noun follows.
    expect(respBody('issue a login credential', TERMS)).toBe('issue_a_session_token')
    expect(respBody('revoke a login credential', TERMS)).toContain('session_token')
  })

  it('applies to EVERY slot kind, because a noun is a noun in a trigger too', () => {
    expect(preBody('the login credential is valid', TERMS)).toContain('session_token')
  })

  it('is INERT when the table is empty — the whole reproducibility claim', () => {
    // The tier must be a function of (document, tables, model). An empty table has to leave
    // the key byte-identical, or committing nothing would still change a verdict.
    const empty = termIndex([])
    for (const text of [
      'issue a login credential',
      'grant access',
      'the session is authenticated',
      'opens the valve',
    ]) {
      expect(respBody(text, empty), text).toBe(respBody(text))
      expect(preBody(text, empty), text).toBe(preBody(text))
    }
  })
})

describe('the substitution rule, clause by clause', () => {
  it('matches WHOLE tokens — a term never rewrites part of a word', () => {
    // The clause that separates a committed table from the lenient-normalization trap. If
    // matching were on the joined string, `token` would rewrite `tokenizer` and the decide key
    // would start unifying genuinely distinct nouns.
    const terms = termIndex([{ canonical: 'shard', aliases: ['token'] }])
    expect(respBody('restart the tokenizer', terms)).toBe('restart_the_tokenizer')
    expect(respBody('restart the token', terms)).toBe('restart_the_shard')
  })

  it('takes the LONGEST alias at each position, so a specific entry is never shadowed', () => {
    // The two aliases must overlap at the SAME start position, or the rule is untested: a short
    // alias sitting AFTER a long one is consumed by it regardless of probe order, which is how
    // the first version of this test passed under a shortest-first sabotage.
    const terms = termIndex([
      { canonical: 'shard', aliases: ['token'] },
      { canonical: 'vault record', aliases: ['token vault'] },
    ])
    // Both `token` and `token vault` match at position 2. The longer one wins.
    expect(respBody('issue a token vault', terms)).toBe('issue_a_vault_record')
  })

  it('does NOT chain — one pass, so `a→b` plus `b→c` stops at b', () => {
    // One hop, the same rule `glossaryIndex` follows. Chaining would make the atom depend on
    // how many passes a reader assumed, which is not a property a decide key may have.
    const terms = termIndex([
      { canonical: 'session token', aliases: ['login credential'] },
      { canonical: 'vault record', aliases: ['session token'] },
    ])
    expect(respBody('issue a login credential', terms)).toBe('issue_a_session_token')
  })

  it('is order-independent — the same table built either way gives the same atom', () => {
    const forward = termIndex([
      { canonical: 'shard', aliases: ['token'] },
      { canonical: 'vault record', aliases: ['session token'] },
    ])
    const reversed = termIndex([
      { canonical: 'vault record', aliases: ['session token'] },
      { canonical: 'shard', aliases: ['token'] },
    ])
    expect(respBody('issue a session token', forward)).toBe(
      respBody('issue a session token', reversed),
    )
  })

  it('runs AFTER the whole-body glossary lookup', () => {
    // A committed glossary entry is keyed on the AUTHOR'S wording. If terms ran first, that key
    // would have to be written in canonical-term space — which no author does — and every
    // committed entry would silently stop matching.
    const glossary = glossaryIndex([
      { canonical: 'mint an access token', aliases: ['issue a login credential'] },
    ])
    const body = atomize({
      kind: 'resp',
      text: 'issue a login credential',
      systemName: 'auth service',
      glossary,
      terms: TERMS,
    }).ref.body
    // The glossary won on the whole body; the term then had nothing left to match.
    expect(body).toBe('mint_an_access_token')
  })

  it('runs BEFORE the copula strip, so guard entries share one key space', () => {
    // The alias must SPAN the copula token, or the rule is untested: a term either side of the
    // copula produces the same body in both orders, which is how the first version of this test
    // survived a sabotage that moved the substitution after the strip.
    //
    // Guard clauses are where this bites in practice — they are state clauses, so their natural
    // phrasing contains "is". A term keyed on that phrasing must match the same pre-strip body
    // the committed glossary is keyed on.
    const terms = termIndex([{ canonical: 'vault sealed', aliases: ['chamber is sealed'] }])
    expect(preBody('the chamber is sealed', terms)).toBe('vault_sealed')
  })
})

describe('the resolved term index', () => {
  it('is keyed on the normalized alias and valued as canonical TOKENS', () => {
    // Snapshotted the way `antonyms.ts` pins its class→canonical map: an edit that silently
    // re-keys the table fails here rather than in a verdict.
    const index = termIndex([
      { canonical: 'Session Token.', aliases: ['login credential', 'The access token'] },
    ])
    expect([...index.entries()].sort()).toEqual([
      ['access_token', ['session', 'token']],
      ['login_credential', ['session', 'token']],
    ])
  })

  it('drops an entry that normalizes away, rather than storing a key matching everywhere', () => {
    const index = termIndex([
      { canonical: '!!!', aliases: ['ignored'] },
      { canonical: 'session token', aliases: ['...'] },
    ])
    expect([...index.keys()]).toEqual([])
  })
})

describe('the invariant that keeps a committed term from inverting a state bridge', () => {
  /**
   * `guard-implication` recognises a state-establishing response by parsing the RAW text
   * against `ESTABLISH_VERBS`, while the bridge's polarity comes from the full `atomize` —
   * which sees the antonym rewrite. If the two lexicons overlapped, one verb could be read as
   * a bridge AND flip polarity, desyncing the sign of a guard the solver then asserts.
   *
   * The disjointness is what makes that unreachable, and it was prose-only until now: the file
   * the original lesson names as its test does not exist in this repo. `applyTerm` refuses a
   * term containing a member of EITHER set, so this assertion is also the premise that refusal
   * relies on.
   */
  it('ESTABLISH_VERBS and the antonym heads are disjoint', () => {
    const overlap = [...ESTABLISH_VERBS].filter((verb) => ANTONYM_INDEX.has(verb))
    expect(overlap, 'a verb in both lexicons can be read as a bridge AND flip polarity').toEqual([])
  })

  it('both lexicons are non-empty, so the disjointness is not vacuous', () => {
    expect(ESTABLISH_VERBS.size).toBeGreaterThan(10)
    expect(ANTONYM_INDEX.size).toBeGreaterThan(10)
  })

  it('every lexicon member is a single normalized token, which is what makes the refusal total', () => {
    // `applyTerm` checks token by token. A multi-token member would slip past that check, so
    // this pins the shape the refusal assumes.
    for (const verb of [...ESTABLISH_VERBS]) {
      expect(normalize(verb), `${verb} is not a single token`).toBe(verb)
    }
  })
})
