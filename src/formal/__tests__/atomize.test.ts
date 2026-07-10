import { describe, expect, it } from 'vitest'
import { ANTONYM_INDEX, buildAntonymIndex, SEED_ANTONYM_PAIRS } from '../antonyms.js'
import { type AtomizeArgs, atomize, glossaryIndex, normalize } from '../atomize.js'

const resp = (text: string, systemName: string, negated = false): AtomizeArgs => ({
  kind: 'resp',
  text,
  systemName,
  negated,
})

describe('normalize — conservative near-exact pipeline (AC-4-2a)', () => {
  it('lowercases', () => {
    expect(normalize('Issue A Session Token')).toBe('issue_a_session_token')
  })

  it('strips a single LEADING article (a/an/the) but keeps internal articles', () => {
    expect(normalize('the auth service')).toBe('auth_service')
    expect(normalize('a session token')).toBe('session_token')
    expect(normalize('an order')).toBe('order')
    // internal article preserved — only the LEADING one is stripped
    expect(normalize('issue a session token')).toBe('issue_a_session_token')
  })

  it('strips punctuation', () => {
    expect(normalize('reject all, incoming login-attempts!')).toBe(
      'reject_all_incoming_login_attempts',
    )
    expect(normalize('lock the account (for 15 minutes).')).toBe('lock_the_account_for_15_minutes')
  })

  it('collapses whitespace', () => {
    expect(normalize('issue   a\t\nsession    token')).toBe('issue_a_session_token')
    expect(normalize('  leading and trailing  ')).toBe('leading_and_trailing')
  })

  it('underscore-joins and treats input underscores idempotently', () => {
    expect(normalize('auth_service')).toBe('auth_service')
    expect(normalize('auth__service')).toBe('auth_service')
  })

  it('does NOT stem or lemmatize — "issues" and "issue" stay distinct', () => {
    expect(normalize('issues')).not.toBe(normalize('issue'))
    expect(normalize('issues')).toBe('issues')
    expect(normalize('issue')).toBe('issue')
  })

  it('does NOT strip stopwords beyond the leading article', () => {
    // "all", "for", "of" survive — only a leading a/an/the is removed
    expect(normalize('lock all of the accounts')).toBe('lock_all_of_the_accounts')
  })
})

describe('atomize — purity and determinism (AC-4-2a)', () => {
  it('is deterministic: same input yields byte-identical output', () => {
    const args = resp('issue a session token', 'auth service')
    expect(atomize(args)).toEqual(atomize(args))
    expect(atomize(args).name).toBe(atomize({ ...args }).name)
  })

  it('does not mutate its arguments', () => {
    const args = resp('Issue A Session Token', 'The Auth Service', false)
    const snapshot = JSON.stringify(args)
    atomize(args)
    expect(JSON.stringify(args)).toBe(snapshot)
  })

  it('scopes every atom by kind', () => {
    expect(atomize({ kind: 'trig', text: 'user logs in', systemName: 'auth' }).name).toBe(
      'sys__auth__trig__user_logs_in',
    )
    expect(atomize({ kind: 'pre', text: 'maintenance is on', systemName: 'auth' }).name).toBe(
      'sys__auth__pre__maintenance_is_on',
    )
    expect(atomize(resp('log the attempt', 'auth')).name).toBe('sys__auth__resp__log_the_attempt')
  })
})

describe('atomize — per-systemName scoping (AC-4-2a)', () => {
  it('gives identical response text under two different systems DISTINCT atoms', () => {
    const a = atomize(resp('issue a session token', 'auth service'))
    const b = atomize(resp('issue a session token', 'billing service'))
    expect(a.name).not.toBe(b.name)
    expect(a.name).toBe('sys__auth_service__resp__issue_a_session_token')
    expect(b.name).toBe('sys__billing_service__resp__issue_a_session_token')
  })

  it('unifies identical response text under the same system (after article/case normalization)', () => {
    const a = atomize(resp('Issue a session token', 'the auth service'))
    const b = atomize(resp('issue a session token', 'auth service'))
    expect(a.name).toBe(b.name)
  })
})

describe('atomize — negation on the same atom (AC-2-4 → AC-4-2a)', () => {
  it('"shall not X" and "shall X" produce the SAME atom with opposite polarity', () => {
    const pos = atomize(resp('store plaintext', 'auth service', false))
    const neg = atomize(resp('store plaintext', 'auth service', true))
    expect(neg.name).toBe(pos.name) // same atom
    expect(pos.negated).toBe(false)
    expect(neg.negated).toBe(true) // opposite polarity
  })

  it('defaults polarity to positive when negated is omitted', () => {
    expect(atomize({ kind: 'resp', text: 'store plaintext', systemName: 'auth' }).negated).toBe(
      false,
    )
  })
})

describe('atomize — seed antonym table (AC-4-2a)', () => {
  it('"grant access" and "revoke access" unify to ONE atom with opposite polarity', () => {
    const grant = atomize(resp('grant access', 'auth service'))
    const revoke = atomize(resp('revoke access', 'auth service'))
    expect(grant.name).toBe(revoke.name) // one atom
    expect(grant.negated).toBe(false) // grant → canonical 'grant', positive
    expect(revoke.negated).toBe(true) // revoke → opposite polarity
  })

  it('unifies each shipped seed pair onto one atom with opposite polarity', () => {
    for (const [a, b] of SEED_ANTONYM_PAIRS) {
      const atomA = atomize(resp(`${a} the widget`, 'sys'))
      const atomB = atomize(resp(`${b} the widget`, 'sys'))
      expect(atomA.name, `${a} vs ${b} should share an atom`).toBe(atomB.name)
      expect(atomA.negated, `${a} vs ${b} should be opposite polarity`).not.toBe(atomB.negated)
    }
  })

  it('composes AC-2-4 negation with the antonym flip by XOR', () => {
    // "shall not revoke access" — negated response of the negative-polarity verb
    // → should equal plain "grant access" (¬¬grant = grant)
    const grant = atomize(resp('grant access', 'auth service', false))
    const notRevoke = atomize(resp('revoke access', 'auth service', true))
    expect(notRevoke.name).toBe(grant.name)
    expect(notRevoke.negated).toBe(grant.negated)
  })

  it('requires an identical object remainder — different objects do NOT unify', () => {
    const grantAccess = atomize(resp('grant access', 'auth service'))
    const revokePermission = atomize(resp('revoke permission', 'auth service'))
    expect(grantAccess.name).not.toBe(revokePermission.name)
  })

  it('only applies antonym unification to responses, not triggers or preconditions', () => {
    // "grant" appearing in a trigger/precondition is NOT rewritten to a canonical
    const trig = atomize({ kind: 'trig', text: 'grant access', systemName: 'auth' })
    expect(trig.name).toBe('sys__auth__trig__grant_access')
    expect(trig.negated).toBe(false)
  })

  it('leaves non-antonym responses untouched', () => {
    const a = atomize(resp('log the attempt', 'auth service'))
    expect(a.name).toBe('sys__auth_service__resp__log_the_attempt')
    expect(a.negated).toBe(false)
  })

  it('does NOT stem the verb before antonym lookup — "grants" is not "grant"', () => {
    const grants = atomize(resp('grants access', 'auth service'))
    // "grants" is not a table member, so no unification with the canonical
    expect(grants.name).toBe('sys__auth_service__resp__grants_access')
    expect(grants.negated).toBe(false)
  })
})

describe('antonym index — signed equivalence classes (shared members)', () => {
  it('ships exactly the 15 seed pairs', () => {
    expect(SEED_ANTONYM_PAIRS).toHaveLength(15)
  })

  it('collapses shared-member pairs (accept/reject/approve/decline) into one class', () => {
    // accept↔reject, approve↔reject, accept↔decline share members
    const accept = ANTONYM_INDEX.get('accept')
    const reject = ANTONYM_INDEX.get('reject')
    const approve = ANTONYM_INDEX.get('approve')
    const decline = ANTONYM_INDEX.get('decline')
    expect(accept).toBeDefined()
    // canonical is the lexicographically-smallest member of the class
    expect(accept?.canonical).toBe('accept')
    expect(reject?.canonical).toBe('accept')
    expect(approve?.canonical).toBe('accept')
    expect(decline?.canonical).toBe('accept')
    // accept & approve are positive; reject & decline are negative
    expect(accept?.negated).toBe(false)
    expect(approve?.negated).toBe(false)
    expect(reject?.negated).toBe(true)
    expect(decline?.negated).toBe(true)
  })

  it('unifies same-polarity near-synonyms sharing a class (accept/approve)', () => {
    const accept = atomize(resp('accept the request', 'sys'))
    const approve = atomize(resp('approve the request', 'sys'))
    expect(accept.name).toBe(approve.name)
    expect(accept.negated).toBe(approve.negated)
  })

  it('is pure/deterministic — rebuilding from the same pairs yields the same index', () => {
    const rebuilt = buildAntonymIndex(SEED_ANTONYM_PAIRS)
    for (const [verb, entry] of ANTONYM_INDEX) {
      expect(rebuilt.get(verb)).toEqual(entry)
    }
    expect(rebuilt.size).toBe(ANTONYM_INDEX.size)
  })

  it('throws on an inconsistent (odd) polarity cycle', () => {
    // a↔b, b↔c, a↔c forces a to be opposite to itself
    expect(() =>
      buildAntonymIndex([
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
      ]),
    ).toThrow(/[Ii]nconsistent/)
  })
})

describe('glossary canonicalization (AC-9-2)', () => {
  const gloss = glossaryIndex([
    { canonical: 'issue a session token', aliases: ['issue a login credential'] },
  ])

  it('collapses an aliased response to the canonical atom', () => {
    const canon = atomize(resp('issue a session token', 'auth service'))
    const alias = atomize({ ...resp('issue a login credential', 'auth service'), glossary: gloss })
    expect(alias.name).toBe(canon.name)
  })

  it('is a no-op when no glossary is supplied (parity)', () => {
    const withGloss = atomize({ ...resp('issue a session token', 'auth service'), glossary: gloss })
    const without = atomize(resp('issue a session token', 'auth service'))
    expect(withGloss.name).toBe(without.name)
  })

  it('leaves a non-aliased phrase untouched', () => {
    const other = atomize({ ...resp('delete the audit log', 'auth service'), glossary: gloss })
    const bare = atomize(resp('delete the audit log', 'auth service'))
    expect(other.name).toBe(bare.name)
  })

  it('preserves negation polarity through canonicalization', () => {
    const pos = atomize({ ...resp('issue a login credential', 'auth service'), glossary: gloss })
    const neg = atomize({
      ...resp('issue a login credential', 'auth service', true),
      glossary: gloss,
    })
    expect(neg.name).toBe(pos.name)
    expect(neg.negated).toBe(true)
    expect(pos.negated).toBe(false)
  })

  it('glossaryIndex normalizes both alias and canonical sides', () => {
    // Authored in natural phrasing (articles, caps) but keyed normalized.
    const idx = glossaryIndex([
      { canonical: 'Issue A Session Token', aliases: ['the login token'] },
    ])
    expect(idx.get('login_token')).toBe('issue_a_session_token')
  })
})
