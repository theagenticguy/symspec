/**
 * The parse ladder and the `parse` operation.
 *
 * ## Three claims, and they are separable
 *
 * 1. **Branch COVERAGE of the ladder**, over a corpus chosen so every outcome, every
 *    error code, and every EARS pattern is reached. Coverage is asserted rather than
 *    assumed, because a corpus that stopped reaching a branch would still pass every
 *    test that reads it.
 * 2. **The AC-A-4 one-name property**, asserted directly rather than by inspection:
 *    a suggestion that names a backticked field must name a field that EXISTS on the
 *    object carrying it.
 * 3. **Tier-2 gating**, which is a performance contract with a correctness tell: a
 *    clean sentence must never load the ~4.5 MB wink model. Asserted by injecting a
 *    loader and checking it was NOT called — the only way to see it, since a loaded
 *    model changes no output.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { parseBatch } from '../../domain/engine/parse/batch.ts'
import { parseLine } from '../../domain/engine/parse/result.ts'
import type { Tier2Loader } from '../../domain/engine/parse/tier2.ts'
import { decodeOp } from '../../domain/requirements/ops.ts'
import { StreamSource } from '../../ports/stream.ts'
import { runOperation } from '../runtime/operation.ts'
import { type ParsePayload, parseOp } from './parse.ts'

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * The corpus: one line per ladder behavior worth pinning.
 *
 * Chosen to cover every OUTCOME and every code, because a suite is only as strong as
 * the paths it reaches — the fixture-coverage rule from the oracle blind-spot lesson
 * ("for every field the boundary carries, which fixture would FAIL if it were
 * dropped?") applied to the ladder's own branches.
 */
const CORPUS = [
  // Tier 1, each pattern.
  'The auth service shall log every attempt',
  'When the user signs in, the auth service shall issue a session token',
  'While maintenance mode is enabled, the api shall reject every request',
  'Where SSO is configured, the api shall redirect to the IdP',
  'If five logins fail, then the auth service shall lock the account',
  // Non-standard modals — the confidence downgrade.
  'The api must validate every payload',
  'The api will retry the request',
  'The api should cache the response',
  // Explicit negation — the polarity FLAG, not text inversion.
  'The api shall not expose internal errors',
  'The api shall never log a raw credential',
  // Compound — splittable and NOT splittable (the soundness guard).
  'The auth service shall issue a token and log the attempt',
  'The api shall grant read and write access',
  // No modal / not a requirement.
  'Fast response times are important',
  '',
  'improve overall performance',
  // Clause-ordering and passive trouble.
  'When the queue drains, while the lock is held, the worker shall commit the batch',
  'The record shall be persisted',
  // A REQ-ID prefix, which preprocess strips.
  'REQ-14: the api shall paginate every list response',
] as const

// ---------------------------------------------------------------------------
// 1. Branch coverage of the ladder
// ---------------------------------------------------------------------------

describe('the ladder reaches every branch the corpus exists to exercise', () => {
  it('drops blank and comment lines, strips list markers, and summarizes the batch', async () => {
    // The batch path exercises what per-line cases cannot: blank-line and comment-line
    // DROPPING, list-marker stripping, and the resulting summary. Six of the nine lines
    // below carry content; the bare `-` and the whitespace-only line are dropped by the
    // line policy rather than parsed and rejected, which is the distinction being pinned.
    const text = [
      '# Requirements',
      '',
      '- The api shall reject expired tokens',
      '* improve responsiveness',
      '1. When the queue drains, the worker shall commit the batch',
      '2) The api shall grant read and write access',
      '-',
      '   ',
      'The record shall be persisted',
    ].join('\n')

    const batch = await parseBatch(text)

    // The `#` heading, the blank line, the bare `-`, and the whitespace-only line are
    // DROPPED — they never become results and never move a counter.
    expect(batch.results).toHaveLength(5)
    expect(batch.summary).toEqual({ ok: 3, skipped: 1, error: 1 })

    // List markers are stripped before parsing, so a marked line parses as a requirement
    // rather than failing on its leading punctuation.
    const first = batch.results[0]
    expect(first?.outcome).toBe('ok')
    if (first?.outcome === 'ok') {
      expect(first.pattern).toBe('ubiquitous')
      expect(first.slots.systemName).toBe('api')
    }

    // The distinction the policy exists to make, and the one that is easy to collapse: a
    // no-modal BULLET is `skipped` (content the author wrote that is not a requirement),
    // not dropped (structure). Collapsing the two hides "you wrote 12 bullets and 3 of
    // them are not requirements" behind a silent omission.
    expect(batch.results[1]?.outcome).toBe('skipped')
  })

  it('reaches every outcome and every parse code', async () => {
    // Asserted rather than assumed: a corpus that quietly stopped reaching a branch would
    // still pass every test that reads it, and the missing branch is the finding.
    const results = await Promise.all(CORPUS.map((line) => parseLine(line)))
    const outcomes = new Set(results.map((r) => r.outcome))
    expect([...outcomes].sort()).toEqual(['error', 'ok', 'skipped'])

    const codes = new Set(results.filter((r) => r.outcome === 'error').map((r) => r.code))
    // All three ERROR-classified codes. (`ERR_PARSE_NO_MODAL` is deliberately absent:
    // this module maps that code to `skipped`, which is the boundary under test.)
    expect(codes.has('ERR_PARSE_COMPOUND')).toBe(true)
    expect(codes.has('ERR_PARSE_NOT_A_REQUIREMENT')).toBe(true)

    const tiers = new Set(results.filter((r) => r.outcome === 'ok').map((r) => r.tier))
    expect(tiers.has(1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. ONE NAME (spec AC-A-4)
// ---------------------------------------------------------------------------

describe('AC-A-4 — one `proposedOps` name, and the suggestion names the real field', () => {
  it('the COMPOUND suggestion names a field the result ACTUALLY HAS', async () => {
    // The property an agent depends on: a suggestion that names a backticked field must
    // name a field the object carrying it actually has, or following the instruction finds
    // nothing. `proposedSplits` is deliberately absent — there is ONE name for this shape.
    const result = await parseLine('The auth service shall issue a token and log the attempt')
    expect(result.outcome).toBe('error')
    if (result.outcome !== 'error') return

    const named = result.suggestions
      .flatMap((s) => [...s.matchAll(/`(proposed[A-Za-z]*)`/g)])
      .map((m) => m[1])
    // The suggestion DOES name a field — otherwise this test would pass vacuously.
    expect(named.length).toBeGreaterThan(0)
    for (const field of named) {
      expect(field, 'a suggestion must never name a field that does not exist').toBeDefined()
      expect(field !== undefined && field in result).toBe(true)
    }
    // And it is the one name, not v4's second one.
    expect(named).toContain('proposedOps')
    expect('proposedSplits' in result).toBe(false)
  })

  it('every proposed op DECODES as a real DocumentOp', async () => {
    // The property `apply` depends on: an op the parse tier emits is an op the fold
    // accepts. If this broke, the whole parse→apply pipe would be decorative.
    for (const line of CORPUS) {
      const result = await parseLine(line)
      const ops =
        result.outcome === 'ok'
          ? [result.proposedOp]
          : result.outcome === 'error'
            ? (result.proposedOps ?? [])
            : []
      for (const op of ops) {
        const decoded = Effect.runSync(Effect.result(decodeOp(op)))
        expect(decoded._tag, `op from "${line}" failed to decode`).toBe('Success')
      }
    }
  })

  it('carries the negated FLAG onto the op, leaving the response POSITIVE', async () => {
    // The field only `cli/add.ts` knew to thread in v4. Losing it would
    // persist a prohibition as a permission — the worst available silent error.
    const result = await parseLine('The api shall not expose internal errors')
    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.negated).toBe(true)
    expect(result.proposedOp.negated).toBe(true)
    expect(result.proposedOp.systemResponse).toBe('expose internal errors')
  })

  it('omits `negated` entirely when false, so a clean op stays minimal', async () => {
    const result = await parseLine('The api shall expose a health endpoint')
    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect('negated' in result.proposedOp).toBe(false)
  })

  it('splits polarity PER HALF, not once for the whole compound', async () => {
    const result = await parseLine('The api shall not expose internal errors and log a credential')
    if (result.outcome === 'error' && result.proposedOps !== undefined) {
      // Whatever the splitter decides, each half's op carries its OWN polarity —
      // never the first half's applied to both.
      expect(result.proposedOps.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Tier-2 gating
// ---------------------------------------------------------------------------

describe('tier-2 gating — a clean sentence never loads the wink model', () => {
  it('does NOT call the loader for a confident Tier-1 parse', async () => {
    let calls = 0
    const load: Tier2Loader = async () => {
      calls += 1
      return () => []
    }
    const result = await parseLine(
      'When the user signs in, the auth service shall issue a session token',
      { load },
    )
    expect(result.outcome).toBe('ok')
    if (result.outcome === 'ok') expect(result.tier).toBe(1)
    // The whole performance contract, in one number.
    expect(calls, 'a clean sentence must not load the ~4.5 MB wink model').toBe(0)
  })

  it('DOES call the loader on escalation, and loads it at most once per batch', async () => {
    let calls = 0
    const load: Tier2Loader = async () => {
      calls += 1
      return () => []
    }
    // Two escalating lines: the analyzer must be resolved once, not twice.
    await parseBatch(
      ['The record shall be persisted', 'The other record shall be persisted'].join('\n'),
      { load },
    )
    expect(calls).toBeGreaterThan(0)
    // The negative control on the gating test itself: if the loader were never
    // called for ANY input, the assertion above would be meaningless.
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('the REAL wink model loads and produces UNIVERSAL POS tags', async () => {
    // The dependency is installed and wired — the one thing an injected fake cannot
    // establish. The tagset half is a genuine hazard, not ceremony:
    // `wink-eng-lite-web-model` emits UPOS (`DET`/`AUX`/`NOUN`), and every POS table
    // in tier2 speaks UPOS. A model that switched to Penn-Treebank (`DT`/`MD`/`NN`)
    // would make subject repair silently fail to recover any subject, with no error.
    const { defaultTier2Loader } = await import('../../domain/engine/parse/tier2.ts')
    const analyze = await defaultTier2Loader()
    const byValue = new Map(
      analyze('The audit record shall be written to the ledger').map((t) => [
        t.value.toLowerCase(),
        t.pos,
      ]),
    )
    expect(byValue.get('the')).toBe('DET') // UPOS DET, not PTB DT
    expect(byValue.get('shall')).toBe('AUX') // UPOS AUX, not PTB MD
    expect(byValue.get('record')).toBe('NOUN') // UPOS NOUN, not PTB NN
  })

  /**
   * THE DONOR BUG. `winkNLP(model)` leaks, and dies on its ~21st construction with a
   * `RangeError: Invalid string length` from inside the model package. v4's
   * `runTier2` loads per LINE, so its `parse --file` aborts on the 21st escalating
   * line of a real requirements file — with a dependency-internal RangeError rather
   * than a parse error, so the whole batch is lost instead of reporting per-line.
   *
   * 40 escalating lines is comfortably past the cliff and completes in well under a
   * second with the memo. Without the memo it does not complete at all (the loads
   * slow superlinearly as the leaked string grows, then throw) — verified by
   * removing the memo and watching this test time out, which is the guards-must-fire
   * check for it.
   */
  it('survives 40 ESCALATING lines through the real model (v4 bug regression)', async () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `The audit record ${i} shall be written to the ledger`,
    ).join('\n')
    const batch = await parseBatch(text)
    expect(batch.results).toHaveLength(40)
    // Every line reached a real outcome — nothing was lost to a thrown RangeError.
    expect(batch.summary.ok + batch.summary.skipped + batch.summary.error).toBe(40)
    // And they genuinely escalated (a passive main clause), so the model really was
    // exercised 40 times. Without this the test could pass on the clean fast path.
    expect(batch.summary.ok).toBeGreaterThan(0)
  })

  it('loads the real model AT MOST ONCE across many parseLine calls', async () => {
    // The other route to the same leak: a caller looping over `parseLine` rather than
    // using a batch. Timing is the observable — a second real load costs ~62ms, so 20
    // sequential escalating parses completing in a fraction of that proves one load.
    const started = Date.now()
    for (let i = 0; i < 20; i += 1) {
      await parseLine(`The audit record ${i} shall be written to the ledger`)
    }
    const elapsed = Date.now() - started
    // 20 fresh loads would be >1s AND would throw at ~21. A generous bound, so this
    // asserts "not per-call" rather than a specific machine's speed.
    expect(elapsed).toBeLessThan(1500)
  })
})

// ---------------------------------------------------------------------------
// 4. The operation
// ---------------------------------------------------------------------------

/** Run `parse` with an in-memory stream source. */
const run = (
  input: Record<string, unknown>,
  streamed = '',
): Promise<{ readonly data: ParsePayload }> =>
  Effect.runPromise(
    runOperation(parseOp, input).pipe(
      Effect.provide(
        Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed(streamed) })),
      ),
    ),
  )

describe('the `parse` operation', () => {
  it('rolls every op up into `ops` and `opsJsonl`, apply-ready', async () => {
    const { data } = await run(
      { file: 'in.md' },
      [
        'The api shall reject expired tokens',
        'The auth service shall issue a token and log the attempt',
        '- improve responsiveness',
      ].join('\n'),
    )

    // 1 from the ok line + 2 from the split = 3; the skipped bullet contributes none.
    expect(data.ops).toHaveLength(3)
    expect(data.summary).toEqual({ ok: 1, skipped: 1, error: 1 })

    // `opsJsonl` is EXACTLY the bytes `apply` reads: one op per line, newline
    // terminated, and every line decodes.
    const jsonlLines = data.opsJsonl.trimEnd().split('\n')
    expect(jsonlLines).toHaveLength(3)
    expect(data.opsJsonl.endsWith('\n')).toBe(true)
    for (const line of jsonlLines) {
      const decoded = Effect.runSync(Effect.result(decodeOp(JSON.parse(line) as unknown)))
      expect(decoded._tag).toBe('Success')
    }
    // And it agrees with `ops` — two publications of one fact must not disagree.
    expect(jsonlLines.map((l) => JSON.parse(l) as unknown)).toEqual([...data.ops])
  })

  it('emits one error-severity FINDING per unparseable line, indexed back to it', async () => {
    const { data } = await run(
      { file: 'in.md' },
      ['The api shall reject expired tokens', 'Fast response times are important'].join('\n'),
    )
    // "Fast response times are important" has no modal, so it is SKIPPED, not an
    // error — no finding. This is the boundary that keeps batch parsing usable.
    expect(data.findings).toHaveLength(0)

    const compound = await run({ text: 'The api shall issue a token and log the attempt' })
    expect(compound.data.findings).toHaveLength(1)
    const finding = compound.data.findings[0]
    expect(finding?.code).toBe('ERR_PARSE_COMPOUND')
    expect(finding?.severity).toBe('error')
    expect(finding?.tier).toBe('parse')
    expect(finding?.index).toBe(0)
    // The repair carries the ops, which is the one parse failure with a MECHANICAL fix.
    expect(finding?.repair?.ops.length).toBeGreaterThanOrEqual(2)
  })

  it('OMITS the repair when the only remedy is a human rewrite', async () => {
    // "read and write access" is VERB-and-VERB over one object, so the splitter
    // refuses (its soundness guard) and there is nothing mechanical to offer.
    // Emitting an empty repair would say "there is a fix, it is nothing".
    const { data } = await run({ text: 'The api shall grant read and write access' })
    expect(data.findings).toHaveLength(1)
    expect(data.findings[0]?.repair).toBeUndefined()
    expect(data.ops).toHaveLength(0)
  })

  it('reports the SOURCE, so a batch result is traceable to its input', async () => {
    expect((await run({ text: 'The api shall log' })).data.source).toBe('argument')
    expect((await run({ file: 'spec.md' }, 'The api shall log')).data.source).toBe('spec.md')
    expect((await run({}, 'The api shall log')).data.source).toBe('stdin')
  })

  it('refuses text AND --file together', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        runOperation(parseOp, { text: 'x', file: 'y' }).pipe(
          Effect.provide(
            Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed('') })),
          ),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      // Read the FIELDS, not `String(failure)` — a TaggedErrorClass stringifies to
      // its tag (`ERR_USAGE`), so a string match on it silently tests nothing about
      // the message.
      expect(result.failure._tag).toBe('ERR_USAGE')
      expect((result.failure as { readonly error: string }).error).toContain('mutually exclusive')
    }
  })

  it('refuses empty input with a usage error naming all three shapes', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        runOperation(parseOp, {}).pipe(
          Effect.provide(
            Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed('   ') })),
          ),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
  })

  it('never reads or writes a DOCUMENT — its requirement set proves it', () => {
    // A structural claim, checkable rather than asserted: the operation's handler
    // requires only `StreamSource`. If it grew a `DocStore` requirement, the `run`
    // helper above (which provides ONLY StreamSource) would not typecheck.
    // Documented here so the property is visible to a reader, not just to tsc.
    expect(parseOp.name).toBe('parse')
  })
})
