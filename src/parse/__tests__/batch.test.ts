/**
 * Batch parse tests (AC-2-9).
 *
 * The headline verification clause: a multi-line input with one ok, one
 * no-modal bullet, and one compound line yields `results` of length 3 with
 * outcomes ok/skipped/error and a matching `{ ok, skipped, error }` summary.
 * Additional cases pin the line policy (blank/comment drop, list-marker strip),
 * input-order preservation, schema validity, and the single-string one-element
 * case.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BatchParseResultSchema,
  candidateLines,
  parseBatch,
  stripListMarker,
  summarize,
} from '../batch.js'
import type { ParseResult } from '../result.js'
import type { WinkAnalyzer, WinkToken } from '../tier2.js'

// A minimal fake analyzer (bare NN tokens, no modal) so no wink-nlp model is
// ever required and the Tier-2 escalation path never touches the filesystem.
const makeNoModalAnalyzer = (): WinkAnalyzer => (text: string) =>
  text.split(/\s+/).map(
    (value): WinkToken => ({
      value,
      pos: 'NN',
      lemma: value.toLowerCase(),
      negationFlag: false,
    }),
  )

const noModalOpts = () => ({ load: async () => makeNoModalAnalyzer() })

// ---------------------------------------------------------------------------
// Headline: 3-line input → results[3] ok/skipped/error + matching summary
// ---------------------------------------------------------------------------

describe('AC-2-9: batch parse yields per-line results and a matching summary', () => {
  it('a 3-line input produces one ok, one skipped, one error with matching counts', async () => {
    const input = [
      'The auth service shall issue a session token', // ok
      '- improve overall responsiveness of the dashboard', // skipped (no-modal bullet)
      'The auth service shall validate the token and issue a session', // error (compound)
    ].join('\n')

    const { results, summary } = await parseBatch(input, noModalOpts())

    expect(results).toHaveLength(3)
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'skipped', 'error'])
    expect(summary).toEqual({ ok: 1, skipped: 1, error: 1 })

    const [ok, skipped, error] = results as [ParseResult, ParseResult, ParseResult]
    if (ok.outcome === 'ok') expect(ok.pattern).toBe('ubiquitous')
    if (skipped.outcome === 'skipped') {
      expect(skipped.reason).toBe('no-modal')
      // The list marker is stripped before parsing; skipped.text is the parsed line.
      expect(skipped.text).toBe('improve overall responsiveness of the dashboard')
    }
    if (error.outcome === 'error') expect(error.code).toBe('ERR_PARSE_COMPOUND')
  })

  it('the whole payload validates against BatchParseResultSchema', async () => {
    const input = 'The API shall reject expired tokens\n- notes only\nThe API shall log and audit'
    const payload = await parseBatch(input, noModalOpts())
    expect(BatchParseResultSchema.safeParse(payload).success).toBe(true)
  })

  it('summary always sums to results.length', async () => {
    const input = [
      'The gateway shall retry failed requests',
      'Fast response times are important',
      'The gateway shall cache and revalidate responses',
      '',
      '# a heading comment',
      'When the order ships, the system shall send a receipt',
    ].join('\n')
    const { results, summary } = await parseBatch(input, noModalOpts())
    expect(summary.ok + summary.skipped + summary.error).toBe(results.length)
  })
})

// ---------------------------------------------------------------------------
// Line policy: blank + comment lines dropped, list markers stripped
// ---------------------------------------------------------------------------

describe('AC-2-9: line policy (blank/comment drop, list-marker strip)', () => {
  it('blank and comment lines are dropped entirely (never a result, never counted)', async () => {
    const input = [
      '',
      '# requirements.md',
      '   ', // whitespace-only
      'The auth service shall issue a token',
      '  # indented comment',
      '',
    ].join('\n')
    const { results, summary } = await parseBatch(input, noModalOpts())
    expect(results).toHaveLength(1)
    expect(summary).toEqual({ ok: 1, skipped: 0, error: 0 })
  })

  it('candidateLines strips unordered and ordered markers and drops structure', () => {
    const input = [
      '- bullet one',
      '* bullet two',
      '+ bullet three',
      '1. first',
      '2) second',
      '',
      '#c',
    ].join('\n')
    expect(candidateLines(input)).toEqual([
      'bullet one',
      'bullet two',
      'bullet three',
      'first',
      'second',
    ])
  })

  it('stripListMarker leaves a bare requirement ID (no trailing space) intact', () => {
    // "3.1.4)" has no following space, so it is NOT a list marker — the ladder's
    // preprocess owns REQ-ID stripping, not the batch splitter.
    expect(stripListMarker('3.1.4) The system shall boot')).toBe('3.1.4) The system shall boot')
    expect(stripListMarker('- 3.1.4) The system shall boot')).toBe('3.1.4) The system shall boot')
  })

  it('a line that is only a marker collapses to blank and is dropped', async () => {
    const { results } = await parseBatch('-\nThe system shall boot', noModalOpts())
    expect(results).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Ordering, single-string case, purity helpers
// ---------------------------------------------------------------------------

describe('AC-2-9: ordering and the single-string one-element case', () => {
  it('results preserve input line order', async () => {
    const input = [
      'Fast response times are important', // skipped
      'The auth service shall issue a token', // ok
      'The auth service shall a and b', // error (compound)
    ].join('\n')
    const { results } = await parseBatch(input, noModalOpts())
    expect(results.map((r) => r.outcome)).toEqual(['skipped', 'ok', 'error'])
  })

  it('a single requirement line is the one-element case of the contract', async () => {
    const { results, summary } = await parseBatch(
      'The auth service shall issue a session token',
      noModalOpts(),
    )
    expect(results).toHaveLength(1)
    expect(summary).toEqual({ ok: 1, skipped: 0, error: 0 })
  })

  it('empty / whitespace-only input yields an empty batch', async () => {
    const { results, summary } = await parseBatch('\n  \n\n', noModalOpts())
    expect(results).toHaveLength(0)
    expect(summary).toEqual({ ok: 0, skipped: 0, error: 0 })
  })

  it('summarize tallies a hand-built result list by outcome', () => {
    const results: ParseResult[] = [
      { outcome: 'skipped', reason: 'no-modal', text: 'a' },
      { outcome: 'skipped', reason: 'no-modal', text: 'b' },
      {
        outcome: 'error',
        code: 'ERR_PARSE_COMPOUND',
        error: 'compound',
        suggestions: ['split it'],
      },
    ]
    expect(summarize(results)).toEqual({ ok: 0, skipped: 2, error: 1 })
  })

  it('a clean batch never invokes the Tier-2 loader (AC-2-6 gate preserved)', async () => {
    const load = vi.fn<() => Promise<WinkAnalyzer>>()
    const { summary } = await parseBatch(
      'The auth service shall issue a token\nThe gateway shall retry failed requests',
      { load },
    )
    expect(load).not.toHaveBeenCalled()
    expect(summary).toEqual({ ok: 2, skipped: 0, error: 0 })
  })
})
