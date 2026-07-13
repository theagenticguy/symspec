import { describe, expect, it, vi } from 'vitest'
import {
  defaultTier2Loader,
  escalationTriggers,
  MAX_TIER1_TOKENS,
  repairWithWink,
  runTier2,
  splitCompound,
  type WinkAnalyzer,
  type WinkToken,
} from '../tier2.js'

// ---------------------------------------------------------------------------
// A tiny hand-rolled POS tagger standing in for the wink-nlp analyzer. Lets the
// gating + repair logic be tested without loading the ~4.5 MB model on every
// run. It emits the SAME tagset the real `wink-eng-lite-web-model` emits —
// Universal POS (UPOS), NOT Penn-Treebank — so the fake encodes the true
// contract. (validate-parse-lint.md finding 4: the old fake emitted PTB
// `MD`/`DT`/`NN`, masking a production tagset mismatch that made every real
// Tier-2 repair silently fail. An integration test below loads the real model.)
// ---------------------------------------------------------------------------

const MODALS = new Set(['shall', 'must', 'will', 'should'])
// UPOS: `the`/`a`/`an` are DET; possessive determiners (`their`, `its`, …) are PRON.
const DETERMINERS = new Set(['the', 'a', 'an', 'their', 'its', 'his', 'her'])
const KEYWORDS = new Set([
  'while',
  'when',
  'whenever',
  'where',
  'if',
  'upon',
  'once',
  'after',
  'then',
])
const VERBS = new Set(['be', 'is', 'are', 'been', 'was', 'were', 'reset', 'halt', 'store', 'do'])
const PREPOSITIONS = new Set(['on', 'in', 'at', 'for', 'of', 'to', 'by', 'with'])
const NEGATORS = new Set(['not', 'never'])

// A deliberately small UPOS tagger that models the signal the real model
// provides: verbs (VERB/AUX) and adpositions (ADP) terminate a subject noun
// chunk, which is what lets Tier-2 repair find clause boundaries. Modals are
// AUX (as in the real model), but Tier-2 pivots on lemma membership, not the
// tag. Everything else defaults to a noun (NOUN).
function fakeTag(word: string): string {
  const w = word.toLowerCase()
  if (MODALS.has(w)) return 'AUX'
  if (DETERMINERS.has(w)) return w === 'the' || w === 'a' || w === 'an' ? 'DET' : 'PRON'
  if (word === ',') return 'PUNCT'
  if (KEYWORDS.has(w)) return 'SCONJ'
  if (NEGATORS.has(w)) return 'PART'
  if (VERBS.has(w)) return 'VERB'
  if (PREPOSITIONS.has(w)) return 'ADP'
  return 'NOUN'
}

/** Split on whitespace, peeling trailing commas into their own token. */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const m = /^(.*?)(,)?$/.exec(raw)
    if (m?.[1]) out.push(m[1])
    if (m?.[2]) out.push(m[2])
  }
  return out
}

/** Build a fake {@link WinkAnalyzer} that also records how many times it ran. */
function makeFakeAnalyzer(): { analyze: WinkAnalyzer; calls: () => number } {
  let calls = 0
  const analyze: WinkAnalyzer = (text) => {
    calls++
    const words = tokenize(text)
    return words.map((value, i): WinkToken => {
      const lower = value.toLowerCase()
      // Mark the token immediately after a negator as negation-flagged, mirroring
      // wink's per-token negationFlag propagation.
      const prev = words[i - 1]?.toLowerCase()
      return {
        value,
        pos: fakeTag(value),
        lemma: lower,
        negationFlag: prev != null && NEGATORS.has(prev),
      }
    })
  }
  return { analyze, calls: () => calls }
}

describe('AC-2-6: escalation gating — clean sentences never load wink-nlp', () => {
  it('a clean, confident Tier-1 sentence produces NO escalation triggers', () => {
    expect(escalationTriggers('The auth service shall issue a session token')).toEqual([])
  })

  it('runTier2 does NOT invoke the loader for a clean sentence', async () => {
    const load = vi.fn<() => Promise<WinkAnalyzer>>()
    const outcome = await runTier2('The auth service shall issue a session token', { load })
    expect(load).not.toHaveBeenCalled()
    expect(outcome.escalated).toBe(false)
    expect(outcome.triggers).toEqual([])
    expect(outcome.tier2).toBeUndefined()
    expect(outcome.tier1.ok).toBe(true)
  })

  it('several distinct clean sentences all skip the loader', async () => {
    const clean = [
      'The auth service shall log every authentication attempt in JSON',
      'When the user submits valid credentials, the auth service shall issue a token',
      'While maintenance mode is on, the auth service shall reject login attempts',
      'If five failed logins occur, then the auth service shall lock the account',
      'Where SSO is configured, the auth service shall redirect to the IdP',
    ]
    for (const sentence of clean) {
      const load = vi.fn<() => Promise<WinkAnalyzer>>()
      const outcome = await runTier2(sentence, { load })
      expect(load, `should not load for: ${sentence}`).not.toHaveBeenCalled()
      expect(outcome.escalated).toBe(false)
    }
  })
})

describe('AC-2-6: escalation-class sentences invoke Tier 2', () => {
  it('a Tier-1 miss (no rung matched) escalates and invokes the loader', async () => {
    const { analyze, calls } = makeFakeAnalyzer()
    const load = vi.fn(async () => analyze)
    // "Fast response times are important." — no modal main clause → Tier-1 miss.
    const outcome = await runTier2('Fast response times are important', { load })
    expect(outcome.escalated).toBe(true)
    expect(outcome.triggers).toContain('no-rung-matched')
    expect(load).toHaveBeenCalledTimes(1)
    expect(calls()).toBe(1)
  })

  it('a person-word subject (user-story shape) escalates on weak-subject', async () => {
    const triggers = escalationTriggers('Users should be able to reset their password')
    expect(triggers).toContain('weak-subject')
  })

  it('a passive main clause escalates on passive-main-clause', () => {
    const triggers = escalationTriggers('The database shall be backed up daily')
    expect(triggers).toContain('passive-main-clause')
  })

  it('a top-level conjunction escalates on compound-conjunction', () => {
    const triggers = escalationTriggers('The service shall validate the token and issue a session')
    expect(triggers).toContain('compound-conjunction')
  })

  it('an over-long sentence escalates on long-sentence', () => {
    const long = `The system shall ${Array.from({ length: MAX_TIER1_TOKENS + 5 }, () => 'x').join(' ')}`
    expect(escalationTriggers(long)).toContain('long-sentence')
  })

  it('a nested clause keyword in the trigger escalates on nested-clause-keyword', () => {
    // Comma-free "when … while …" leaves a second keyword inside the trigger slot.
    const triggers = escalationTriggers('When the door opens while armed, the alarm shall sound')
    expect(triggers).toContain('nested-clause-keyword')
  })
})

describe('AC-2-6: POS-driven clause repair (Tier 2)', () => {
  it('repairs a user-story-shaped sentence into a system-centric ubiquitous parse', async () => {
    const { analyze } = makeFakeAnalyzer()
    const outcome = await runTier2('Users should be able to reset their password', {
      load: async () => analyze,
    })
    expect(outcome.escalated).toBe(true)
    const t2 = outcome.tier2
    expect(t2?.ok).toBe(true)
    if (t2?.ok) {
      expect(t2.tier).toBe(2)
      expect(t2.slots.systemName).toBe('Users')
      expect(t2.slots.systemResponse).toMatch(/reset/)
      // nonstandard modal ("should") must be recorded.
      expect(t2.notes).toContain('nonstandard-modal')
      expect(t2.confidence).toBe('low')
    }
  })

  it('recovers a leading While clause into preCondition (state-driven)', () => {
    const { analyze } = makeFakeAnalyzer()
    const r = repairWithWink('While maintenance mode is on the widget shall halt', analyze, [
      'no-rung-matched',
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pattern).toBe('state-driven')
      expect(r.slots.preCondition).toBe('maintenance mode is on')
      expect(r.slots.systemName).toBe('widget')
      expect(r.slots.systemResponse).toBe('halt')
    }
  })

  it('extracts explicit negation to a polarity flag with a positive atom', () => {
    const { analyze } = makeFakeAnalyzer()
    const r = repairWithWink('The system shall not store plaintext passwords', analyze)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.negated).toBe(true)
      expect(r.slots.systemResponse).toBe('store plaintext passwords')
      expect(r.slots.systemResponse).not.toMatch(/\bnot\b/)
    }
  })

  it('misses (no throw) when there is no modal to pivot on', () => {
    const { analyze } = makeFakeAnalyzer()
    const r = repairWithWink('Fast response times are important', analyze)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.tier).toBe(2)
      expect(r.notes).toContain('no-modal-clause')
    }
  })

  it('misses when the modal has no recoverable subject to its left', () => {
    const { analyze } = makeFakeAnalyzer()
    const r = repairWithWink('shall do the thing', analyze)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.notes).toContain('no-subject-recovered')
  })
})

describe('AC-2-6: loader failure degrades to a Tier-2 miss (never throws)', () => {
  it('a loader that rejects yields escalated=true with a tier2 miss', async () => {
    const load = async (): Promise<WinkAnalyzer> => {
      throw new Error('model not installed')
    }
    const outcome = await runTier2('Fast response times are important', { load })
    expect(outcome.escalated).toBe(true)
    expect(outcome.tier2?.ok).toBe(false)
    if (outcome.tier2 && !outcome.tier2.ok) {
      expect(outcome.tier2.notes).toContain('tier2-load-failed')
    }
  })
})

describe('AC-2-6: the default loader is lazy (wink-nlp not statically imported)', () => {
  it('defaultTier2Loader is a function that is only invoked on escalation', () => {
    // We do not call it here (wink-nlp is added by AC-7-7 in a later wave, so the
    // package may be absent). Its mere existence as a lazy loader — never imported
    // at module top level — is the contract: importing this test module must not
    // require wink-nlp. That this file loaded at all proves the static-import-free
    // property.
    expect(typeof defaultTier2Loader).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Compound splitter (wishlist #6): propose the two split single requirements.
//
// A UPOS analyzer that additionally tags a small verb vocabulary as VERB and
// coordinators as CCONJ — the signal the splitter's soundness guard needs. A
// verb OPENING a clause after "and" (with a non-verb to its left) is a genuine
// clause boundary; a verb-and-verb pair sharing one object is not.
// ---------------------------------------------------------------------------
const SPLIT_VERBS = new Set([
  'validate',
  'issue',
  'log',
  'authenticate',
  'lock',
  'provide',
  'read',
  'write',
  'redirect',
])

function splitTag(word: string): string {
  const w = word.toLowerCase()
  if (w === 'and' || w === 'or') return 'CCONJ'
  if (SPLIT_VERBS.has(w)) return 'VERB'
  return fakeTag(word)
}

const splitAnalyzer: WinkAnalyzer = (text) =>
  tokenize(text).map((value): WinkToken => {
    const lower = value.toLowerCase()
    return { value, pos: splitTag(value), lemma: lower, negationFlag: false }
  })

describe('wishlist #6: splitCompound proposes the split requirements', () => {
  it('"shall <A> and <B>" splits into two single requirements sharing the subject', () => {
    const splits = splitCompound(
      'the auth service shall validate the token and issue a session',
      splitAnalyzer,
    )
    expect(splits).toHaveLength(2)
    expect(splits[0]).toMatchObject({
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'validate the token',
      negated: false,
    })
    expect(splits[1]).toMatchObject({
      systemName: 'auth service',
      systemResponse: 'issue a session',
    })
  })

  it('carries a shared leading trigger across both event-driven halves', () => {
    const splits = splitCompound(
      'when the user logs in, the auth service shall validate the token and issue a session',
      splitAnalyzer,
    )
    expect(splits).toHaveLength(2)
    for (const s of splits) {
      expect(s.patternType).toBe('event-driven')
      expect(s.trigger).toBe('the user logs in')
      expect(s.systemName).toBe('auth service')
    }
    expect(splits.map((s) => s.systemResponse)).toEqual(['validate the token', 'issue a session'])
  })

  it('does NOT split a shared-object coordination ("read and write access")', () => {
    // "provide read and write access": VERB `and` VERB sharing one object → the
    // guard must reject rather than propose two broken halves.
    expect(
      splitCompound('the database shall provide read and write access', splitAnalyzer),
    ).toEqual([])
  })

  it('does NOT split a coordinated noun phrase ("the request and the response")', () => {
    // "and" followed by a determiner is a coordinated NP, not a new clause.
    expect(
      splitCompound('the gateway shall log the request and the response', splitAnalyzer),
    ).toEqual([])
  })

  it('splits an explicit second modal ("shall <A> and shall <B>")', () => {
    const splits = splitCompound(
      'the auth service shall authenticate the user and shall log the attempt',
      splitAnalyzer,
    )
    expect(splits).toHaveLength(2)
    expect(splits.map((s) => s.systemResponse)).toEqual([
      'authenticate the user',
      'log the attempt',
    ])
  })

  it('returns [] when there is no modal to pivot on', () => {
    expect(splitCompound('fast responses and low latency', splitAnalyzer)).toEqual([])
  })

  it('is deterministic — identical tokens yield byte-identical splits', () => {
    const text = 'the auth service shall validate the token and issue a session'
    const a = splitCompound(text, splitAnalyzer)
    const b = splitCompound(text, splitAnalyzer)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('runTier2 attaches proposedSplits on a confident compound, omits it otherwise', async () => {
    const good = await runTier2('the auth service shall validate the token and issue a session', {
      load: async () => splitAnalyzer,
    })
    expect(good.proposedSplits).toBeDefined()
    expect(good.proposedSplits).toHaveLength(2)

    const shared = await runTier2('the database shall provide read and write access', {
      load: async () => splitAnalyzer,
    })
    // Still a compound trigger, but the splitter's guard rejected → no proposal.
    expect(shared.triggers).toContain('compound-conjunction')
    expect(shared.proposedSplits).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real-model contract test (validate-parse-lint.md finding 4).
//
// The unit tests above use a UPOS fake. This block loads the ACTUAL
// wink-eng-lite-web-model (an installed dependency) exactly once and asserts
// that the real analyzer emits Universal POS tags AND that repair recovers a
// subject through it. This is the guard that makes the production tagset
// mismatch impossible to reintroduce silently: if the model ever switched
// tagsets, or the POS tables drifted back to Penn-Treebank, these fail.
//
// Kept fast: one shared analyzer, two short sentences.
// ---------------------------------------------------------------------------
describe('AC-2-6: real wink-eng-lite-web-model integration (tagset + repair)', () => {
  it('the real analyzer emits Universal POS tags and repair recovers a subject', async () => {
    const analyze = await defaultTier2Loader()

    // (a) tagset contract: the real model emits UPOS, not Penn-Treebank.
    const tokens = analyze('The audit record shall be written to the ledger')
    const posByValue = new Map(tokens.map((t) => [t.value.toLowerCase(), t.pos]))
    expect(posByValue.get('the')).toBe('DET') // UPOS DET, not PTB DT
    expect(posByValue.get('shall')).toBe('AUX') // UPOS AUX, not PTB MD
    expect(posByValue.get('record')).toBe('NOUN') // UPOS NOUN, not PTB NN

    // (b) passive-agent recovery: subject is rebuilt through the real tags.
    const passive = repairWithWink('The audit record shall be written to the ledger', analyze, [
      'passive-main-clause',
    ])
    expect(passive.ok).toBe(true)
    if (passive.ok) {
      expect(passive.slots.systemName).toBe('audit record')
    }

    // (c) user-story subject repair through the real model.
    const userStory = repairWithWink('Users should be able to reset their password', analyze, [
      'weak-subject',
    ])
    expect(userStory.ok).toBe(true)
    if (userStory.ok) {
      expect(userStory.slots.systemName.toLowerCase()).toContain('user')
      expect(userStory.slots.systemResponse).toMatch(/reset/)
    }

    // (d) nested-clause repair recovers the main-clause subject + a leading event clause.
    const nested = repairWithWink(
      'When the user, while editing, saves the document, the editor shall persist all changes',
      analyze,
      ['nested-clause-keyword'],
    )
    expect(nested.ok).toBe(true)
    if (nested.ok) {
      expect(nested.slots.systemName).toBe('editor')
      expect(nested.slots.systemResponse).toMatch(/persist/)
    }

    // (e) compound split through the real model: a genuine two-clause compound
    // splits into two clean halves, while a shared-object coordination does not.
    const genuine = splitCompound(
      'the auth service shall validate the token and issue a session',
      analyze,
    )
    expect(genuine).toHaveLength(2)
    expect(genuine.map((s) => s.systemResponse)).toEqual(['validate the token', 'issue a session'])
    expect(
      splitCompound('the database shall provide read and write access to users', analyze),
    ).toEqual([])
  })
})
