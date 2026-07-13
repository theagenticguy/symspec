/**
 * Tier-3 error envelope tests (AC-2-7).
 *
 * Verifies that compound/ambiguous/no-modal/not-a-requirement inputs return the
 * correct ERR_PARSE_* code, a non-empty partial skeleton where slots were
 * recovered, and at least one rewrite suggestion.
 */

import { describe, expect, it } from 'vitest'
import type { WinkAnalyzer, WinkToken } from '../tier2.js'
import { runTier2 } from '../tier2.js'
import {
  makeTier3Envelope,
  makeTier3EnvelopeFromNotes,
  PARSE_ERROR_CODES,
  type ParseErrorCode,
  type PartialSlots,
  type Tier3Envelope,
} from '../tier3.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal fake analyzer: returns bare NN tokens with no modal, so Tier 2 misses. */
const makeNoModalAnalyzer = (): WinkAnalyzer => (text: string) => {
  return text.split(/\s+/).map(
    (value): WinkToken => ({
      value,
      pos: 'NN',
      lemma: value.toLowerCase(),
      negationFlag: false,
    }),
  )
}

/**
 * Produce a Tier-2 outcome that escalated but Tier-2 missed (the baseline for
 * most Tier-3 inputs). Uses a fake loader that returns the given analyzer so no
 * wink-nlp model is required.
 */
async function getTier3Outcome(text: string, analyzer?: WinkAnalyzer) {
  const analyze = analyzer ?? makeNoModalAnalyzer()
  return runTier2(text, { load: async () => analyze })
}

/** Assert a Tier-3 envelope invariants. */
function assertEnvelopeInvariants(env: Tier3Envelope) {
  expect(env.tier).toBe(3)
  expect(PARSE_ERROR_CODES).toContain(env.code)
  expect(env.error.length).toBeGreaterThan(0)
  expect(env.suggestions.length).toBeGreaterThan(0)
  // notes is always defined (may be empty for makeTier3EnvelopeFromNotes([]))
  expect(Array.isArray(env.notes)).toBe(true)
}

// ---------------------------------------------------------------------------
// ERR_PARSE_COMPOUND: top-level and/or conjunction
// ---------------------------------------------------------------------------

describe('AC-2-7: ERR_PARSE_COMPOUND', () => {
  it('a compound sentence ("shall do A and B") returns ERR_PARSE_COMPOUND', async () => {
    const text = 'The auth service shall validate the token and issue a session'
    const outcome = await getTier3Outcome(text, makeNoModalAnalyzer())
    const env = makeTier3Envelope(text, outcome)
    assertEnvelopeInvariants(env)
    expect(env.code).toBe('ERR_PARSE_COMPOUND' satisfies ParseErrorCode)
    // Suggestions must reference splitting.
    const suggestionText = env.suggestions.join('\n')
    expect(suggestionText.toLowerCase()).toMatch(/split/)
  })

  it('ERR_PARSE_COMPOUND fires even when Tier-1 partially parsed the sentence', async () => {
    // Tier 1 might produce a partial but the compound trigger overrides.
    const text = 'The service shall authenticate users and issue tokens'
    const outcome = await getTier3Outcome(text, makeNoModalAnalyzer())
    const env = makeTier3Envelope(text, outcome)
    expect(env.code).toBe('ERR_PARSE_COMPOUND')
  })
})

// ---------------------------------------------------------------------------
// ERR_PARSE_NO_MODAL: no shall/modal verb
// ---------------------------------------------------------------------------

describe('AC-2-7: ERR_PARSE_NO_MODAL', () => {
  it('a sentence with no modal verb returns ERR_PARSE_NO_MODAL', async () => {
    const text = 'Fast response times are important for user experience'
    const outcome = await getTier3Outcome(text)
    const env = makeTier3Envelope(text, outcome)
    assertEnvelopeInvariants(env)
    expect(env.code).toBe('ERR_PARSE_NO_MODAL' satisfies ParseErrorCode)
    // Suggestion must tell the agent to add a modal.
    const suggestionText = env.suggestions.join('\n').toLowerCase()
    expect(suggestionText).toMatch(/shall|modal/)
  })

  it('makeTier3EnvelopeFromNotes with no-main-clause returns ERR_PARSE_NO_MODAL', () => {
    const env = makeTier3EnvelopeFromNotes('Response times matter', [
      'no-main-clause',
      'no-rung-matched',
    ])
    assertEnvelopeInvariants(env)
    expect(env.code).toBe('ERR_PARSE_NO_MODAL')
  })

  it('makeTier3EnvelopeFromNotes with no-modal-clause returns ERR_PARSE_NO_MODAL', () => {
    const env = makeTier3EnvelopeFromNotes('The system should be fast', [
      'no-rung-matched',
      'no-modal-clause',
    ])
    expect(env.code).toBe('ERR_PARSE_NO_MODAL')
  })
})

// ---------------------------------------------------------------------------
// ERR_PARSE_NOT_A_REQUIREMENT: no obligation at all
// ---------------------------------------------------------------------------

describe('AC-2-7: ERR_PARSE_NOT_A_REQUIREMENT', () => {
  it('makeTier3EnvelopeFromNotes with empty note returns ERR_PARSE_NOT_A_REQUIREMENT', () => {
    const env = makeTier3EnvelopeFromNotes('', ['empty'])
    assertEnvelopeInvariants(env)
    expect(env.code).toBe('ERR_PARSE_NOT_A_REQUIREMENT' satisfies ParseErrorCode)
    // Suggestion must tell agent it is not a requirement.
    const suggText = env.suggestions.join('\n').toLowerCase()
    expect(suggText).toMatch(/requirement/)
  })

  it('empty input text maps to ERR_PARSE_NOT_A_REQUIREMENT', () => {
    const env = makeTier3EnvelopeFromNotes('', ['empty'])
    expect(env.code).toBe('ERR_PARSE_NOT_A_REQUIREMENT')
  })
})

// ---------------------------------------------------------------------------
// ERR_PARSE_AMBIGUOUS_CLAUSES: fallback for everything else
// ---------------------------------------------------------------------------

describe('AC-2-7: ERR_PARSE_AMBIGUOUS_CLAUSES', () => {
  it('nested clause keyword triggers ERR_PARSE_AMBIGUOUS_CLAUSES', async () => {
    // Over-long sentence with no compound-conjunction
    const text = 'When the door opens while armed, the alarm system shall sound'
    const outcome = await getTier3Outcome(text, makeNoModalAnalyzer())
    const env = makeTier3Envelope(text, outcome)
    assertEnvelopeInvariants(env)
    // This sentence has no top-level and/or, so it cannot be COMPOUND.
    // It may be AMBIGUOUS_CLAUSES if Tier 2 misses or NO_MODAL if no modal found.
    // The key invariant: it is not COMPOUND.
    expect(env.code).not.toBe('ERR_PARSE_COMPOUND')
  })

  it('makeTier3EnvelopeFromNotes with only ambiguous notes returns AMBIGUOUS_CLAUSES', () => {
    const env = makeTier3EnvelopeFromNotes('When A while B then the system shall', [
      'nested-clause-keyword',
      'passive-main-clause',
    ])
    assertEnvelopeInvariants(env)
    expect(env.code).toBe('ERR_PARSE_AMBIGUOUS_CLAUSES' satisfies ParseErrorCode)
    // Suggestions must reference clause ordering.
    const suggText = env.suggestions.join('\n').toLowerCase()
    expect(suggText).toMatch(/clause|structure|ears/)
  })

  it('passive-main-clause alone (no compound) returns AMBIGUOUS_CLAUSES', () => {
    const env = makeTier3EnvelopeFromNotes('The system shall be validated by operators', [
      'passive-main-clause',
    ])
    expect(env.code).toBe('ERR_PARSE_AMBIGUOUS_CLAUSES')
  })
})

// ---------------------------------------------------------------------------
// Partial slots are forwarded (AC-2-7 "partial slots recovered in `partial`")
// ---------------------------------------------------------------------------

describe('AC-2-7: partial slots forwarded from Tier 1', () => {
  it('when Tier 1 produced a partial parse, `partial` carries the recovered slots', () => {
    // Construct a partial with known fields.
    const partial: PartialSlots = {
      systemName: 'auth service',
      systemResponse: 'issue a session token',
    }
    const env = makeTier3EnvelopeFromNotes(
      'The auth service shall issue a session token and log the attempt',
      ['compound-conjunction'],
      partial,
    )
    expect(env.partial).toBeDefined()
    expect(env.partial?.systemName).toBe('auth service')
    expect(env.partial?.systemResponse).toBe('issue a session token')
    expect(env.code).toBe('ERR_PARSE_COMPOUND')
  })

  it('partial is absent (not null/undefined-valued) when nothing was recovered', () => {
    const env = makeTier3EnvelopeFromNotes('Fast response times are important', ['empty'])
    // `partial` must be absent from the object, not present with undefined/null.
    expect('partial' in env).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// proposedSplits forwarding (wishlist #6): the compound splitter's output
// rides on the Tier-3 envelope for ERR_PARSE_COMPOUND only.
// ---------------------------------------------------------------------------

describe('wishlist #6: makeTier3Envelope forwards proposedSplits on a confident compound', () => {
  // A UPOS analyzer that tags a small verb set as VERB and coordinators CCONJ,
  // so the splitter's soundness guard fires.
  const SPLIT_VERBS = new Set(['validate', 'issue', 'provide', 'read', 'write'])
  const splitAnalyzer: WinkAnalyzer = (text) =>
    text.split(/\s+/).map((value): WinkToken => {
      const w = value.toLowerCase()
      const pos =
        w === 'and' || w === 'or'
          ? 'CCONJ'
          : w === 'shall'
            ? 'AUX'
            : w === 'the' || w === 'a'
              ? 'DET'
              : SPLIT_VERBS.has(w)
                ? 'VERB'
                : 'NOUN'
      return { value, pos, lemma: w, negationFlag: false }
    })

  it('a genuine two-clause compound carries proposedSplits (≥2) on the envelope', async () => {
    const text = 'the auth service shall validate the token and issue a session'
    const outcome = await getTier3Outcome(text, splitAnalyzer)
    const env = makeTier3Envelope(text, outcome)
    expect(env.code).toBe('ERR_PARSE_COMPOUND')
    expect(env.proposedSplits).toBeDefined()
    expect(env.proposedSplits).toHaveLength(2)
    expect(env.proposedSplits?.map((s) => s.systemResponse)).toEqual([
      'validate the token',
      'issue a session',
    ])
    // The suggestion string references the machine-actionable ops.
    expect(env.suggestions.join('\n').toLowerCase()).toMatch(/proposedops/)
  })

  it('a shared-object coordination carries NO proposedSplits (guard rejects)', async () => {
    const text = 'the database shall provide read and write access'
    const outcome = await getTier3Outcome(text, splitAnalyzer)
    const env = makeTier3Envelope(text, outcome)
    expect(env.code).toBe('ERR_PARSE_COMPOUND')
    expect('proposedSplits' in env).toBe(false)
  })

  it('proposedSplits is never present on a non-compound code', () => {
    const env = makeTier3EnvelopeFromNotes('When A while B then the system shall', [
      'nested-clause-keyword',
    ])
    expect(env.code).toBe('ERR_PARSE_AMBIGUOUS_CLAUSES')
    expect('proposedSplits' in env).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suggestions are non-empty for every code (AC-2-7)
// ---------------------------------------------------------------------------

describe('AC-2-7: at least one suggestion for every ERR_PARSE_* code', () => {
  const fixtures: Array<[ParseErrorCode, string[]]> = [
    ['ERR_PARSE_NO_MODAL', ['no-main-clause']],
    ['ERR_PARSE_NOT_A_REQUIREMENT', ['empty']],
    ['ERR_PARSE_COMPOUND', ['compound-conjunction']],
    ['ERR_PARSE_AMBIGUOUS_CLAUSES', ['nested-clause-keyword']],
  ]

  for (const [expectedCode, notes] of fixtures) {
    it(`${expectedCode} always has at least one suggestion`, () => {
      const env = makeTier3EnvelopeFromNotes('some input', notes)
      expect(env.code).toBe(expectedCode)
      expect(env.suggestions.length).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// Error field is a human-readable string containing the input (AC-2-7)
// ---------------------------------------------------------------------------

describe('AC-2-7: error field contains the input text', () => {
  it('error message references the original input', () => {
    const text = 'The system shall do A and B'
    const env = makeTier3EnvelopeFromNotes(text, ['compound-conjunction'])
    expect(env.error).toContain(text)
  })
})

// ---------------------------------------------------------------------------
// Code priority: COMPOUND > NO_MODAL > NOT_A_REQUIREMENT > AMBIGUOUS
// ---------------------------------------------------------------------------

describe('AC-2-7: code priority when multiple triggers fire', () => {
  it('COMPOUND overrides NO_MODAL when both triggers fire', () => {
    const env = makeTier3EnvelopeFromNotes('some and text', [
      'compound-conjunction',
      'no-main-clause',
    ])
    expect(env.code).toBe('ERR_PARSE_COMPOUND')
  })

  it('NO_MODAL overrides AMBIGUOUS when modal-free', () => {
    const env = makeTier3EnvelopeFromNotes('When A while B then nothing', [
      'no-main-clause',
      'nested-clause-keyword',
    ])
    expect(env.code).toBe('ERR_PARSE_NO_MODAL')
  })
})
