/**
 * `ParseResult` discriminated-union tests (AC-2-8).
 *
 * Verifies the three verification clauses of AC-2-8:
 *   1. Each `outcome` variant validates against the `ParseResult` Zod schema.
 *   2. A successful result's `slots` are accepted by `CreateRequirementAttrsSchema`.
 *   3. A no-modal bullet yields `skipped`, not an error.
 */

import { describe, expect, it, vi } from 'vitest'
import { CreateRequirementAttrsSchema } from '../../core/schema.js'
import {
  fromTier3,
  fromTierOk,
  ParseErrorResultSchema,
  ParseOkResultSchema,
  ParseResultSchema,
  ParseSkippedResultSchema,
  ProposedSplitSchema,
  parseLine,
  resolveParseResult,
} from '../result.js'
import type { WinkAnalyzer, WinkToken } from '../tier2.js'
import { runTier2 } from '../tier2.js'
import { makeTier3EnvelopeFromNotes } from '../tier3.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal fake analyzer: bare NN tokens, no modal — Tier 2 always misses. */
const makeNoModalAnalyzer = (): WinkAnalyzer => (text: string) =>
  text.split(/\s+/).map(
    (value): WinkToken => ({
      value,
      pos: 'NN',
      lemma: value.toLowerCase(),
      negationFlag: false,
    }),
  )

/** Inject the fake analyzer so no wink-nlp model is ever required. */
const noModalOpts = () => ({ load: async () => makeNoModalAnalyzer() })

// ---------------------------------------------------------------------------
// 1. Each outcome variant validates against the ParseResult Zod schema
// ---------------------------------------------------------------------------

describe('AC-2-8: each outcome variant validates against ParseResultSchema', () => {
  it('ok — a clean Tier-1 sentence produces a schema-valid ok result', async () => {
    const result = await parseLine(
      'When the user submits valid credentials, the auth service shall issue a session token',
      noModalOpts(),
    )
    expect(result.outcome).toBe('ok')
    const parsed = ParseResultSchema.parse(result)
    expect(parsed.outcome).toBe('ok')
    expect(ParseOkResultSchema.safeParse(result).success).toBe(true)
    if (result.outcome === 'ok') {
      expect(result.pattern).toBe('event-driven')
      expect(result.tier).toBe(1)
      expect(result.confidence).toBe('high')
      expect(result.negated).toBe(false)
    }
  })

  it('skipped — a no-modal sentence produces a schema-valid skipped result', async () => {
    const result = await parseLine('Fast response times are important', noModalOpts())
    expect(result.outcome).toBe('skipped')
    const parsed = ParseResultSchema.parse(result)
    expect(parsed.outcome).toBe('skipped')
    expect(ParseSkippedResultSchema.safeParse(result).success).toBe(true)
    if (result.outcome === 'skipped') {
      expect(result.reason).toBe('no-modal')
      expect(result.text).toBe('Fast response times are important')
    }
  })

  it('error — a compound sentence produces a schema-valid error result', async () => {
    const result = await parseLine(
      'The auth service shall validate the token and issue a session',
      noModalOpts(),
    )
    expect(result.outcome).toBe('error')
    const parsed = ParseResultSchema.parse(result)
    expect(parsed.outcome).toBe('error')
    expect(ParseErrorResultSchema.safeParse(result).success).toBe(true)
    if (result.outcome === 'error') {
      expect(result.code).toBe('ERR_PARSE_COMPOUND')
      expect(result.suggestions.length).toBeGreaterThan(0)
      expect(result.error.length).toBeGreaterThan(0)
    }
  })

  it('the schema rejects an unknown outcome discriminant', () => {
    expect(ParseResultSchema.safeParse({ outcome: 'maybe' }).success).toBe(false)
  })

  it('the schema rejects an ok result missing mandatory slots', () => {
    expect(
      ParseResultSchema.safeParse({
        outcome: 'ok',
        pattern: 'ubiquitous',
        slots: { patternType: 'ubiquitous', systemName: 'auth service' }, // no systemResponse
        negated: false,
        confidence: 'high',
        tier: 1,
        notes: [],
      }).success,
    ).toBe(false)
  })

  it('the schema rejects tier 3 on an ok result (Tier 3 never succeeds)', () => {
    expect(
      ParseResultSchema.safeParse({
        outcome: 'ok',
        pattern: 'ubiquitous',
        slots: {
          patternType: 'ubiquitous',
          systemName: 'auth service',
          systemResponse: 'log attempts',
        },
        negated: false,
        confidence: 'high',
        tier: 3,
        notes: [],
      }).success,
    ).toBe(false)
  })

  it('the schema rejects an error result with an empty suggestions array', () => {
    expect(
      ParseResultSchema.safeParse({
        outcome: 'error',
        code: 'ERR_PARSE_COMPOUND',
        error: 'compound',
        suggestions: [],
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. ok-slots feed CreateRequirementAttrsSchema directly
// ---------------------------------------------------------------------------

describe('AC-2-8: successful slots are accepted by CreateRequirementAttrsSchema', () => {
  const fixtures = [
    'The auth service shall log every authentication attempt in JSON',
    'When the order is confirmed, the checkout pipeline shall emit a receipt event',
    'While maintenance mode is enabled, the auth service shall reject login attempts',
    'If five failed logins occur, then the auth service shall lock the account',
    'Where SSO is configured, the auth service shall redirect login to the IdP',
  ]

  for (const sentence of fixtures) {
    it(`accepts slots from: "${sentence.slice(0, 48)}…"`, async () => {
      const result = await parseLine(sentence, noModalOpts())
      expect(result.outcome).toBe('ok')
      if (result.outcome !== 'ok') return
      const created = CreateRequirementAttrsSchema.safeParse(result.slots)
      expect(created.success).toBe(true)
    })
  }

  it('a negated requirement keeps the positive atom in create-schema-valid slots', async () => {
    const result = await parseLine(
      'The auth service shall not store plaintext passwords',
      noModalOpts(),
    )
    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.negated).toBe(true)
    expect(result.slots.systemResponse).toBe('store plaintext passwords')
    expect(CreateRequirementAttrsSchema.safeParse(result.slots).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. A no-modal bullet yields skipped, not an error
// ---------------------------------------------------------------------------

describe('AC-2-8: no-modal prose is skipped, distinct from a Tier-3 error', () => {
  it('a no-modal bullet line yields skipped, not error', async () => {
    const bullet = '- improve overall responsiveness of the dashboard'
    const result = await parseLine(bullet, noModalOpts())
    expect(result.outcome).toBe('skipped')
    if (result.outcome !== 'skipped') return
    expect(result.reason).toBe('no-modal')
    expect(result.text).toBe(bullet)
    expect(ParseResultSchema.parse(result).outcome).toBe('skipped')
  })

  it('a heading-like prose line yields skipped', async () => {
    const result = await parseLine('Overview of the authentication subsystem', noModalOpts())
    expect(result.outcome).toBe('skipped')
  })

  it('an ambiguous-but-modal-bearing failure stays an error (not skipped)', () => {
    // Bypass the ladder: an AMBIGUOUS_CLAUSES Tier-3 envelope must project to error.
    const env = makeTier3EnvelopeFromNotes('While when if, the x shall y', [
      'nested-clause-keyword',
    ])
    expect(env.code).toBe('ERR_PARSE_AMBIGUOUS_CLAUSES')
    const result = fromTier3(env, 'While when if, the x shall y')
    expect(result.outcome).toBe('error')
  })

  it('degenerate empty input is NOT skipped — it is ERR_PARSE_NOT_A_REQUIREMENT', async () => {
    const result = await parseLine('   ', noModalOpts())
    expect(result.outcome).toBe('error')
    if (result.outcome !== 'error') return
    expect(result.code).toBe('ERR_PARSE_NOT_A_REQUIREMENT')
  })
})

// ---------------------------------------------------------------------------
// Compound lines: error-only, never a low-confidence ok (resolved open question)
// ---------------------------------------------------------------------------

describe('AC-2-8: compound-conjunction forces error even over a nominal parse', () => {
  it('a Tier-1-parseable compound sentence resolves to ERR_PARSE_COMPOUND with partial', async () => {
    const text = 'The service shall authenticate users and issue tokens'
    const result = await parseLine(text, noModalOpts())
    expect(result.outcome).toBe('error')
    if (result.outcome !== 'error') return
    expect(result.code).toBe('ERR_PARSE_COMPOUND')
    // Tier 1 parsed the sentence, so the recovered skeleton must surface in partial.
    expect(result.partial).toBeDefined()
    expect(result.partial?.systemName).toBe('service')
    expect(result.suggestions.join('\n').toLowerCase()).toMatch(/split/)
    expect(ParseResultSchema.parse(result).outcome).toBe('error')
  })

  it('the no-modal fake never proposes splits (guard needs VERB/CCONJ signal)', async () => {
    // With the bare-NN analyzer there is no VERB/CCONJ signal, so the splitter's
    // soundness guard produces nothing — a compound stays a plain error.
    const result = await parseLine(
      'The service shall authenticate users and issue tokens',
      noModalOpts(),
    )
    if (result.outcome !== 'error') throw new Error('expected error')
    expect(result.proposedSplits).toBeUndefined()
    expect(ParseErrorResultSchema.safeParse(result).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// wishlist #6: proposedSplits ride on the error result and re-parse cleanly
// ---------------------------------------------------------------------------

describe('wishlist #6: a confident compound carries create-schema-valid proposedSplits', () => {
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

  it('each proposed split is accepted by CreateRequirementAttrsSchema', async () => {
    const result = await parseLine(
      'the auth service shall validate the token and issue a session',
      {
        load: async () => splitAnalyzer,
      },
    )
    expect(result.outcome).toBe('error')
    if (result.outcome !== 'error') return
    expect(result.code).toBe('ERR_PARSE_COMPOUND')
    expect(result.proposedSplits).toBeDefined()
    expect(result.proposedSplits).toHaveLength(2)
    // The error result (with proposedSplits) still validates against the schema.
    expect(ParseErrorResultSchema.safeParse(result).success).toBe(true)
    // Every proposed split's slots satisfy the create-attrs schema — i.e. an
    // `add` op built from it would apply cleanly.
    for (const split of result.proposedSplits ?? []) {
      const { negated: _negated, ...slots } = split
      expect(CreateRequirementAttrsSchema.safeParse(slots).success).toBe(true)
    }
  })

  it('ProposedSplitSchema requires the negated flag and the core slots', () => {
    expect(
      ProposedSplitSchema.safeParse({
        patternType: 'ubiquitous',
        systemName: 'auth service',
        systemResponse: 'issue a session',
        negated: false,
      }).success,
    ).toBe(true)
    // Missing `negated` is rejected.
    expect(
      ProposedSplitSchema.safeParse({
        patternType: 'ubiquitous',
        systemName: 'auth service',
        systemResponse: 'issue a session',
      }).success,
    ).toBe(false)
  })

  it('the ParseErrorResultSchema rejects a single-element proposedSplits (needs ≥2)', () => {
    expect(
      ParseErrorResultSchema.safeParse({
        outcome: 'error',
        code: 'ERR_PARSE_COMPOUND',
        error: 'compound',
        suggestions: ['split it'],
        proposedSplits: [
          {
            patternType: 'ubiquitous',
            systemName: 'x',
            systemResponse: 'y',
            negated: false,
          },
        ],
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tier-2 path and the escalation gate
// ---------------------------------------------------------------------------

describe('AC-2-8: ladder integration', () => {
  it('a clean sentence never invokes the Tier-2 loader (AC-2-6 gate preserved)', async () => {
    const load = vi.fn<() => Promise<WinkAnalyzer>>()
    const result = await parseLine('The auth service shall issue a session token', { load })
    expect(load).not.toHaveBeenCalled()
    expect(result.outcome).toBe('ok')
    if (result.outcome === 'ok') expect(result.tier).toBe(1)
  })

  it('resolveParseResult prefers a Tier-2 repair over the Tier-1 miss it repaired', async () => {
    // Analyzer with just enough POS signal to repair a user-story-shaped subject.
    // Emits Universal POS (UPOS) — the tagset the real wink model produces
    // (validate-parse-lint.md finding 4): modals are AUX, `the` is DET, verbs
    // are VERB, everything else NOUN. Tier-2 pivots on modal lemma, not the tag.
    const analyze: WinkAnalyzer = (text) =>
      text.split(/\s+/).map((value): WinkToken => {
        const w = value.toLowerCase()
        const pos =
          w === 'shall' || w === 'should'
            ? 'AUX'
            : w === 'the'
              ? 'DET'
              : w === 'reset'
                ? 'VERB'
                : 'NOUN'
        return { value, pos, lemma: w, negationFlag: false }
      })
    // "weak-subject" soft trigger escalates; Tier 2 repairs the subject chunk.
    const text = 'Users should reset their password'
    const outcome = await runTier2(text, { load: async () => analyze })
    expect(outcome.escalated).toBe(true)
    const result = resolveParseResult(text, outcome)
    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.tier).toBe(2)
    expect(CreateRequirementAttrsSchema.safeParse(result.slots).success).toBe(true)
  })

  it('fromTierOk round-trips a Tier-1 ok through the schema', async () => {
    const outcome = await runTier2('The gateway shall retry failed requests', noModalOpts())
    expect(outcome.tier1.ok).toBe(true)
    if (!outcome.tier1.ok) return
    const result = fromTierOk(outcome.tier1)
    expect(ParseResultSchema.parse(result).outcome).toBe('ok')
  })
})
