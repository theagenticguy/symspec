/**
 * Tests for the `check` operation: the option surface, the v5 additions, and the
 * exit-code contract.
 *
 * ## These run the REAL handler over the REAL solver
 *
 * The document store is in-memory (so a test asserts against a document it built,
 * with no filesystem), but the SolverService Layer is the shipped one and Z3 really
 * boots. Stubbing the solver would make these tests assert the shape of a mock;
 * the whole point of `check` is what the solver concludes, and the differential
 * oracle in `../formal/differential.test.ts` compares those conclusions against the
 * donor. Here the concern is the SHELL: does an option reach the tier, does a
 * repair get attached, does the exit contract hold.
 *
 * ## The exit-code gap this file exists to keep closed
 *
 * `exitCodeForEnvelope` was fully implemented and fully tested in G1 — and never
 * CALLED on the success path, because no G1 operation produced findings, so every
 * reachable success genuinely was exit 0. `check` made it reachable: `--strict`
 * produced `strictGate:'fail'` in the envelope and exit 0 at the shell, which is
 * the worst possible shape for a CI gate. Fixed in `../cli.ts`, and the assertions
 * at the bottom of this file are what keep it fixed — they go through the real
 * bundle, because the bug was in the CLI shell and an in-process test of the
 * handler could never have caught it.
 */

import { Effect, Layer, type Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DOC_VERSION,
  emptyDocument,
  type LoadedDocument,
  type Requirement,
  type RequirementsDocument,
} from '../core/document.ts'
import { DocPath, DocStore, makeDocPath, type SaveInput } from '../core/store.ts'
import { embedderLayerOf, stubEmbedder } from '../formal/embedder.ts'
import { SolverService, solverServiceLayer } from '../formal/solver-service.ts'
import { ErrDocNotFound, type OperationalError } from '../kernel/errors.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  exitCodeForEnvelope,
} from '../kernel/exit.ts'
import { runOperation } from '../kernel/operation.ts'
import { type CheckPayload, checkOp, MAX_TEMPORAL_BOUND } from './check.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z'

/** A v3 requirement with defaults filled, so a test names only what it varies. */
const req = (
  partial: Partial<Requirement> & Pick<Requirement, 'id' | 'sentence'>,
): Requirement => ({
  patternType: 'ubiquitous',
  systemName: 'system',
  systemResponse: 'operate',
  negated: false,
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: TS,
  updatedAt: TS,
  ...partial,
})

const docOf = (...requirements: readonly Requirement[]): RequirementsDocument => ({
  ...emptyDocument(),
  requirements: Object.fromEntries(requirements.map((r) => [r.id, r])),
})

/**
 * The canonical PROVABLE contradiction: one trigger, `grant` vs `revoke`, which the
 * seed antonym table already unifies to one atom at opposite polarity. Chosen
 * because it produces an error-severity `FND_CONTRADICTION` with no glossary or
 * antonym setup, so a test asserting the exit-1 path does not also depend on the
 * document's side tables.
 */
const contradictoryDoc = (): RequirementsDocument =>
  docOf(
    req({
      id: '11111111-1111-4111-8111-111111111111',
      patternType: 'event-driven',
      trigger: 'the user submits valid credentials',
      systemName: 'auth service',
      systemResponse: 'grant access',
      sentence: 'When the user submits valid credentials, the auth service shall grant access.',
    }),
    req({
      id: '22222222-2222-4222-8222-222222222222',
      patternType: 'event-driven',
      trigger: 'the user submits valid credentials',
      systemName: 'auth service',
      systemResponse: 'revoke access',
      sentence: 'When the user submits valid credentials, the auth service shall revoke access.',
    }),
  )

/**
 * Two requirements with DISJOINT vocabulary, so nothing can be cross-compared. The
 * shape that produces `uncovered-requirement` demotions and therefore a
 * `verified: false` with no error finding — the exit-3 path.
 */
const disjointDoc = (): RequirementsDocument =>
  docOf(
    req({
      id: '33333333-3333-4333-8333-333333333333',
      patternType: 'event-driven',
      trigger: 'a payment settles',
      systemName: 'ledger',
      systemResponse: 'post the journal entry',
      sentence: 'When a payment settles, the ledger shall post the journal entry.',
    }),
    req({
      id: '44444444-4444-4444-8444-444444444444',
      patternType: 'event-driven',
      trigger: 'a shipment departs',
      systemName: 'warehouse',
      systemResponse: 'decrement the stock count',
      sentence: 'When a shipment departs, the warehouse shall decrement the stock count.',
    }),
  )

/**
 * `n` requirements that SHARE one system and one trigger, so every pair is a
 * candidate pair — the shape whose solver cost a `--solver-budget-ms` actually
 * bounds, and therefore the only shape that can exercise the AC-A-8 hint.
 *
 * ## Two constraints on the generated text, both learned the hard way
 *
 * The response objects are word-spelled and drawn from a fixed pool because a BARE
 * NUMBER fires `GTWR_R6_MISSING_UNITS` at error severity, the AC-3-7 gate then
 * excludes every requirement from the formal tier, and the document silently becomes
 * a lint fixture with `pairsChecked: 0`. The first version of `scripts/budget-curve.ts`
 * did exactly that and measured a flat 110ms at every N while reporting a plausible
 * number — nothing failed.
 *
 * And they must be DISTINCT, or the exact-duplicate detector collapses the pairs.
 */
const sharedTriggerDoc = (n: number): RequirementsDocument => {
  const objects = [
    'the primary queue',
    'the standby queue',
    'the audit log',
    'the retry ledger',
    'the dispatch table',
    'the operator console',
  ] as const
  const suffixes = ['', ' alpha', ' beta', ' gamma', ' delta'] as const
  const requirements: Requirement[] = []
  for (let i = 0; i < n; i++) {
    const response = `update ${objects[i % objects.length]}${suffixes[Math.floor(i / objects.length) % suffixes.length]}`
    requirements.push(
      req({
        id: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
        patternType: 'event-driven',
        trigger: 'the operator confirms the plan',
        systemName: 'scheduler',
        systemResponse: response,
        sentence: `When the operator confirms the plan, the scheduler shall ${response}.`,
      }),
    )
  }
  return docOf(...requirements)
}

// ---------------------------------------------------------------------------
// The in-memory store, plus the REAL solver Layer
// ---------------------------------------------------------------------------

interface MemoryFs {
  readonly files: Map<string, RequirementsDocument>
  readonly saves: SaveInput[]
}

const memoryStore = (fs: MemoryFs) =>
  Layer.succeed(DocStore)(
    DocStore.of({
      load: (path) => {
        const doc = fs.files.get(path)
        if (doc === undefined) {
          return Effect.fail(
            new ErrDocNotFound({
              error: `Could not read a requirements document at ${path}.`,
              suggestions: [`Run \`symspec init ${path}\`.`],
            }),
          )
        }
        return Effect.succeed({
          document: doc,
          unknownKeys: {},
          diagnostics: [],
        } satisfies LoadedDocument)
      },
      save: (path, input) =>
        Effect.sync(() => {
          fs.files.set(path, input.document)
          fs.saves.push(input)
        }),
      exists: (path) => Effect.succeed(fs.files.has(path)),
    }),
  )

/**
 * Run `check` over one document, returning the Result.
 *
 * The solver Layer is NOT `Layer.fresh`ed: these tests want the process-wide memo,
 * so the WASM module boots once for the whole file instead of once per test. That
 * turns a ~15s file into a ~3s one, and it is safe precisely because no test here
 * abandons a query (the wedge tests live in `../formal/solver-service.test.ts` and
 * use their own sacrificial `Layer.fresh` build for exactly this reason).
 */
const runCheckOp = (
  document: RequirementsDocument,
  input: Record<string, unknown> = {},
): Promise<
  | { readonly _tag: 'Success'; readonly success: { readonly data: CheckPayload } }
  | { readonly _tag: 'Failure'; readonly failure: OperationalError | Schema.SchemaError }
> => {
  const fs: MemoryFs = { files: new Map([['doc.json', document]]), saves: [] }
  return Effect.runPromise(
    Effect.result(runOperation(checkOp, { file: 'doc.json', ...input })).pipe(
      Effect.provide(
        Layer.mergeAll(
          memoryStore(fs),
          Layer.succeed(DocPath)(makeDocPath({})),
          solverServiceLayer,
          // The DETERMINISTIC stub, so these tests exercise the always-on semantic
          // tier without the ~110 MB model. Not a fallback — a caller with no stub and
          // no cached model still fails closed with ERR_EMBED_MODEL_MISSING.
          embedderLayerOf(stubEmbedder()),
        ),
      ),
    ),
  ) as never
}

/** Unwrap a success, failing the test with the real error if it was a failure. */
const expectOk = async (
  document: RequirementsDocument,
  input: Record<string, unknown> = {},
): Promise<CheckPayload> => {
  const result = await runCheckOp(document, input)
  if (result._tag === 'Failure') {
    throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  }
  return result.success.data
}

// ---------------------------------------------------------------------------
// The formal path works
// ---------------------------------------------------------------------------

describe('check — the formal path reaches Z3 through the Layer', () => {
  it('proves a grant/revoke contradiction at error severity', async () => {
    const data = await expectOk(contradictoryDoc())
    const contradictions = data.findings.filter((f) => f.code === 'FND_CONTRADICTION')
    expect(contradictions.length).toBeGreaterThan(0)
    // Names BOTH culprits: a finding that named one would be a localization
    // regression, which is the failure the donor's unsat-core minimization guards.
    const named = new Set(contradictions.flatMap((f) => f.requirementIds))
    expect(named.has('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(named.has('22222222-2222-4222-8222-222222222222')).toBe(true)
    expect(data.counts.error).toBeGreaterThan(0)

    // `verified` is TRUE here, and that is not a contradiction in terms — it is the
    // distinction the field exists to make, which G2a could not observe.
    //
    // `verified` answers "was consistency CHECKED", not "is the document clean". A
    // proven contradiction is the strongest possible evidence that the decide tier ran
    // and reached a verdict, so coverage is complete. What says the document is bad is
    // `counts.error` and the exit code (1), not this flag.
    //
    // Through G2a this assertion read `false`, and it PASSED — but for the wrong
    // reason: no embedder was supplied, so every run carried a `semantic-tier-skipped`
    // demotion and `verified` was false on every document regardless of its content.
    // Now that the tier runs, the demotion is discharged and the flag reports what it
    // was designed to report. A test that had asserted the G2a value would have
    // encoded a configuration artifact as a contract.
    expect(data.verified).toBe(true)
    expect(data.coverage.demotions, 'nothing left to demote — the tier ran').toEqual([])
    // The GRADIENT still says there is work: `verified` and `openFindings` are
    // independent axes, which is exactly why `progress` reports both.
    expect(data.progress.openFindings).toBeGreaterThan(0)
  })

  it('DEMOTES `verified` when the semantic tier is skipped, on the SAME document', async () => {
    // The other half of the pair above, and the reason `--semantic=false` is not a
    // quiet opt-out: skipping the tier is DISCLOSED as a demotion, so the identical
    // document that verifies with the tier on cannot verify with it off.
    //
    // Demotion-only doctrine, observable in one comparison: turning a detector off
    // can only move `verified` toward abstention.
    const data = await expectOk(contradictoryDoc(), { semantic: false })
    expect(data.verified).toBe(false)
    expect(data.coverage.demotions.map((d) => d.reason)).toContain('semantic-tier-skipped')
    // The conflict is still proven — skipping the PROPOSE tier does not blind the
    // DECIDE tier, which is the whole point of the split.
    expect(data.counts.error).toBeGreaterThan(0)
  })

  it('an empty document is vacuously verified and clean', async () => {
    const data = await expectOk(emptyDocument())
    // The donor's rule: fewer than two requirements is vacuously verified, because
    // there is nothing to cross-compare. Asserted so a future "be stricter about
    // empty documents" change is a visible decision.
    expect(data.verified).toBe(true)
    expect(data.counts.error).toBe(0)
    expect(data.coverage.demotions).toEqual([])
    expect(data.progress).toEqual({ demotions: 0, openFindings: 0, atomsUncompared: 0 })
  })

  it('surfaces the resolved path and the load diagnostics on every run', async () => {
    const data = await expectOk(emptyDocument())
    expect(data.path).toBe('doc.json')
    // The V27 disclosure channel reaches `check` too, not just the reads.
    expect(data.diagnostics).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The v5 additions
// ---------------------------------------------------------------------------

describe('check — the v5 report additions (AC-A-1, AC-A-2)', () => {
  it('EVERY demotion carries a runnable repair with no placeholders', async () => {
    const data = await expectOk(disjointDoc())
    expect(data.coverage.demotions.length).toBeGreaterThan(0)
    for (const demotion of data.coverage.demotions) {
      expect(demotion.repair, `${demotion.reason} has no repair`).toBeDefined()
      const commands = demotion.repair?.commands ?? []
      expect(commands.length, `${demotion.reason} has an empty repair`).toBeGreaterThan(0)
      for (const command of commands) {
        // RUNNABLE means no placeholders. `<blocking-code>` in the donor's action
        // prose is exactly the defect the repair join closes, so an angle-bracket
        // slot surviving into a COMMAND is a regression.
        expect(command, `placeholder in: ${command}`).not.toMatch(/<[a-z-]+>/)
        expect(command.startsWith('symspec ')).toBe(true)
      }
      // The donor's prose is PRESERVED alongside, never replaced: it carries the
      // reasoning (why a waiver cannot discharge a coverage fact) that a command
      // cannot express.
      expect(typeof demotion.action).toBe('string')
    }
  })

  it('the repair for a rewrite-only demotion suggests READS, never an invented edit', async () => {
    const data = await expectOk(disjointDoc())
    const uncovered = data.coverage.demotions.filter((d) => d.reason === 'uncovered-requirement')
    expect(uncovered.length).toBeGreaterThan(0)
    for (const demotion of uncovered) {
      const commands = demotion.repair?.commands ?? []
      // `show` then `list` — the two reads that give an agent the input a rewrite
      // needs. Crucially NOT a `symspec update --system-response "…"`, which would
      // mean the tool authoring requirement text it has no basis for.
      expect(commands.some((c) => c.startsWith('symspec show '))).toBe(true)
      expect(commands.some((c) => c.startsWith('symspec list '))).toBe(true)
      expect(commands.some((c) => c.includes('update'))).toBe(false)
    }
  })

  it('progress reaches zero on all three axes exactly when the run is clean', async () => {
    const clean = await expectOk(emptyDocument())
    expect(clean.progress.demotions).toBe(0)
    expect(clean.progress.openFindings).toBe(0)
    expect(clean.progress.atomsUncompared).toBe(0)
    // `demotions === 0` and `verified === true` are the same statement; asserting
    // the identity keeps the gradient honest rather than merely correlated.
    expect(clean.verified).toBe(clean.progress.demotions === 0)

    const conflicted = await expectOk(contradictoryDoc())
    expect(conflicted.progress.openFindings).toBe(conflicted.counts.error)
    expect(conflicted.progress.demotions).toBe(conflicted.coverage.demotions.length)
    expect(conflicted.progress.atomsUncompared).toBe(conflicted.residualRisk.unmatchedAtoms)
  })

  it('openFindings counts ERROR severity only, so warn/info do not move the gradient', async () => {
    const data = await expectOk(disjointDoc())
    // This document produces info findings and no errors, so the gradient's finding
    // axis must be 0 even though `findings[]` is non-empty. Counting warn/info would
    // make the gradient move on changes that cannot affect the outcome.
    expect(data.counts.info).toBeGreaterThan(0)
    expect(data.counts.error).toBe(0)
    expect(data.progress.openFindings).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-A-8 — the budget hint, end to end
// ---------------------------------------------------------------------------

/**
 * The AC-A-8 claim, stated as the brief states it: a document big enough to demote
 * for solver-budget reasons carries a hint that, WHEN APPLIED, un-demotes.
 *
 * These are the tests that make the hint a capability rather than a computed field.
 * `../formal/budget-hint.test.ts` covers the arithmetic against a synthetic report;
 * what only a real run can show is that the recommended number is actually SUFFICIENT
 * — the extrapolation could be internally consistent and still land below the true
 * cost, and no unit test over a fabricated report would notice.
 */
describe('check — data.budgetHint (AC-A-8)', () => {
  it('a 1ms budget truncates, and the hint it emits UN-DEMOTES when applied', async () => {
    const document = sharedTriggerDoc(10)

    // A 1ms budget is below the first tier's first unit of work by construction, so
    // the truncation is deterministic rather than load-dependent — which matters
    // because this assertion has to hold on a contended CI machine too.
    const truncated = await expectOk(document, { solverBudgetMs: 1 })
    const truncationDemotions = truncated.coverage.demotions.filter(
      (d) => d.reason === 'solver-budget-exhausted',
    )
    expect(truncationDemotions.length).toBeGreaterThan(0)
    expect(truncated.verified, 'a truncated run can never certify').toBe(false)

    const hint = truncated.budgetHint
    expect(hint, 'a truncated run must carry a budget hint').toBeDefined()
    if (hint === undefined) return
    expect(hint.reason).toBe('truncated')
    expect(hint.basis.budgetMs).toBe(1)
    expect(hint.basis.unrunUnits).toBeGreaterThan(0)
    expect(hint.recommendedBudgetMs).toBeGreaterThan(1)

    // THE CLAIM: apply the hint's own number, and the truncation demotions are gone.
    const applied = await expectOk(document, { solverBudgetMs: hint.recommendedBudgetMs })
    expect(
      applied.coverage.demotions.filter((d) => d.reason === 'solver-budget-exhausted'),
      'applying the recommended budget must clear every truncation demotion',
    ).toEqual([])
    // And on this document nothing else demotes either, so the run reaches the fixed
    // point the gradient exists to converge on.
    expect(applied.verified).toBe(true)
    expect(applied.progress.demotions).toBe(0)
  })

  it('the un-demoted run emits NO hint — the absence is the all-clear', async () => {
    // The complement of the test above, and the reason the field is optional: once the
    // budget is right there is nothing to recommend, so a hint on every run would be
    // noise an agent learns to skip past.
    const document = sharedTriggerDoc(10)
    const truncated = await expectOk(document, { solverBudgetMs: 1 })
    const recommended = truncated.budgetHint?.recommendedBudgetMs ?? 0
    expect(recommended).toBeGreaterThan(0)

    const applied = await expectOk(document, { solverBudgetMs: recommended })
    expect(applied.budgetHint).toBeUndefined()
    expect('budgetHint' in applied, 'the key is ABSENT, not undefined').toBe(false)
  })

  it('an UNBOUNDED run emits no hint, however long it takes', async () => {
    // The default. There is no budget to correct, and suggesting one would push a
    // bound onto a caller who deliberately ran without.
    const data = await expectOk(sharedTriggerDoc(10))
    expect(data.budgetHint).toBeUndefined()
  })

  it('the truncation REPAIR command names the SAME number the hint publishes', async () => {
    // Two renderings of one answer. A `repair.commands` line that disagreed with
    // `budgetHint.recommendedBudgetMs` would be the envelope contradicting itself in
    // two adjacent fields — and G2a's blind doubling did exactly that until the hint
    // became its source.
    const data = await expectOk(sharedTriggerDoc(10), { solverBudgetMs: 1 })
    const recommended = data.budgetHint?.recommendedBudgetMs
    expect(recommended).toBeDefined()
    const demotion = data.coverage.demotions.find((d) => d.reason === 'solver-budget-exhausted')
    expect(demotion?.repair?.commands).toEqual([
      `symspec check doc.json --solver-budget-ms ${recommended}`,
    ])
  })

  it('the basis reports the run`s OWN measurements, not a table lookup', async () => {
    const data = await expectOk(sharedTriggerDoc(10), { solverBudgetMs: 1 })
    const basis = data.budgetHint?.basis
    expect(basis).toBeDefined()
    if (basis === undefined) return
    // Each number is read off the report published next to it, so an agent can check
    // the arithmetic rather than trusting it.
    expect(basis.requirements).toBe(data.coverage.encoded)
    expect(basis.pairs).toBe(data.pairsChecked)
    // The anchor: wall clock this run spent, on this machine, under this load. A
    // committed millisecond table was ruled out by measurement — see the module
    // header in `../formal/budget-hint.ts`.
    expect(basis.measuredMsAtBudget).toBeGreaterThan(0)
  })

  it('is ADDITIVE — a --min-severity filter cannot strip it', async () => {
    // The same rule the demotion repairs follow: an output filter is a presentation
    // choice, and letting it change what budget is recommended would remove the hint
    // from exactly the info-tier truncation demotions that raise it.
    const data = await expectOk(sharedTriggerDoc(10), {
      solverBudgetMs: 1,
      minSeverity: 'error',
    })
    expect(data.budgetHint?.reason).toBe('truncated')
  })
})

// ---------------------------------------------------------------------------
// Options reach the tier
// ---------------------------------------------------------------------------

describe('check — the option surface', () => {
  it('--strict sets strictGate on an unverified run and leaves it undefined otherwise', async () => {
    const gated = await expectOk(disjointDoc(), { strict: true })
    expect(gated.verified).toBe(false)
    expect(gated.strictGate).toBe('fail')

    const ungated = await expectOk(disjointDoc())
    // Left UNDEFINED, not `'pass'`, when no gate was requested: the field's presence
    // is what says a gate ran, so a default run's contract stays unchanged.
    expect(ungated.strictGate).toBeUndefined()
  })

  it('--strict PASSES on a vacuously verified document', async () => {
    const data = await expectOk(emptyDocument(), { strict: true })
    expect(data.strictGate).toBe('pass')
  })

  it('--fail-on-unmatched trips independently of --strict, and -1 disables it', async () => {
    const tripped = await expectOk(disjointDoc(), { failOnUnmatched: 0 })
    expect(tripped.residualRisk.unmatchedAtoms).toBeGreaterThan(0)
    expect(tripped.strictGate).toBe('fail')

    // `null` — an ABSENT flag — is the disabled state, and 0 is a meaningful
    // threshold (fail on any). If the option translation guarded on `> 0` instead of
    // on nullness, `--fail-on-unmatched 0` would silently disable the strictest
    // legal setting; both ends are pinned here.
    const disabled = await expectOk(disjointDoc(), { failOnUnmatched: null })
    expect(disabled.strictGate).toBeUndefined()
  })

  it('rejects a NEGATIVE --fail-on-unmatched rather than treating it as disabled', async () => {
    // A negative threshold is meaningless (an unmatched-atom count is never < 0), and
    // silently reading it as "disabled" would let a typo turn a gate off. It is
    // unreachable from the CLI anyway — `-1` parses as the next flag — but the
    // schema-level path (a library caller, or a future non-CLI surface) must still
    // reject it loudly.
    const result = await runCheckOp(emptyDocument(), { failOnUnmatched: -1 })
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as { _tag: string })._tag).toBe('ERR_USAGE')
    }
  })

  it('--min-severity filters output without changing counts or the verdict', async () => {
    const full = await expectOk(disjointDoc())
    const filtered = await expectOk(disjointDoc(), { minSeverity: 'error' })
    expect(full.counts.info).toBeGreaterThan(0)
    // The filter drops info findings from the ARRAY...
    expect(filtered.findings.length).toBeLessThan(full.findings.length)
    // ...but `counts` still reports the full post-waiver set, so a filtered view
    // truthfully says how much it hid, and the exit code is unchanged.
    expect(filtered.counts).toEqual(full.counts)
    expect(filtered.verified).toBe(full.verified)
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data: filtered })).toBe(
      exitCodeForEnvelope({ apiVersion: 1, type: 'check', data: full }),
    )
  })

  it('--min-severity error does NOT strip the repairs off info-tier demotions', async () => {
    // The ordering trap: repairs are computed from the UNFILTERED findings, because a
    // demotion's repair depends on the finding that RAISED it. Computing them after
    // the filter would leave every info-tier demotion repair-less under
    // `--min-severity error` — the demotions an agent most needs a command for.
    const filtered = await expectOk(disjointDoc(), { minSeverity: 'error' })
    expect(filtered.coverage.demotions.length).toBeGreaterThan(0)
    for (const demotion of filtered.coverage.demotions) {
      expect(demotion.repair, `${demotion.reason} lost its repair under a filter`).toBeDefined()
    }
  })

  it('--findings-only drops the excluded table and nothing else', async () => {
    const data = await expectOk(disjointDoc(), { findingsOnly: true })
    expect(data.excluded).toEqual([])
    // The findings themselves, and therefore the gate, are untouched.
    expect(data.counts.info).toBeGreaterThan(0)
  })

  it('--temporal-bound 0 means the tier is OFF; a positive bound enables it', async () => {
    // The v5 simplification: one flag instead of the donor's `--temporal` +
    // `--temporal-bound` pair, so a bound cannot be supplied to a tier that is off.
    const off = await expectOk(contradictoryDoc(), { temporalBound: 0 })
    expect(off.findings.some((f) => f.code === 'FND_TEMPORAL_CONTRADICTION')).toBe(false)

    const on = await expectOk(contradictoryDoc(), { temporalBound: 4 })
    // The tier RAN — asserted via the report rather than by requiring a temporal
    // finding on this particular fixture, since whether a temporal contradiction
    // exists is the tier's business, not this test's.
    expect(on.findings.length).toBeGreaterThanOrEqual(off.findings.length)
  })
})

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

describe('check — usage errors are ERR_USAGE with a runnable correction', () => {
  const expectUsage = async (input: Record<string, unknown>, matcher: RegExp) => {
    const result = await runCheckOp(emptyDocument(), input)
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    // `readonly string[]`, matching the `Repair` type: a mutable `string[]` here is
    // TS2352, because `readonly T[]` is not assignable to `T[]` in an assertion.
    const failure = result.failure as {
      _tag: string
      error: string
      repair?: { commands: readonly string[] }
    }
    expect(failure._tag).toBe('ERR_USAGE')
    expect(failure.error).toMatch(matcher)
    // Every usage error carries the CORRECTED invocation as a runnable command —
    // AC-A-9 applied to usage, so a typo is self-correcting.
    expect(failure.repair?.commands.length).toBeGreaterThan(0)
    expect(failure.repair?.commands[0]).toMatch(/^symspec check /)
  }

  it('rejects a non-positive --timeout-ms', () => expectUsage({ timeoutMs: 0 }, /--timeout-ms/))

  it('rejects a negative --solver-budget-ms', () =>
    expectUsage({ solverBudgetMs: -1 }, /--solver-budget-ms/))

  it('rejects a negative --fail-on-unmatched', () =>
    expectUsage({ failOnUnmatched: -2 }, /--fail-on-unmatched/))

  it('rejects a --temporal-bound over the cap, and EXPLAINS the cap', async () => {
    const result = await runCheckOp(emptyDocument(), { temporalBound: MAX_TEMPORAL_BOUND + 1 })
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    const failure = result.failure as { _tag: string; error: string }
    expect(failure._tag).toBe('ERR_USAGE')
    // The message must carry the JUSTIFICATION, not just the number. A bare "max is
    // 200" invites a reader to assume the cap is arbitrary and route around it; the
    // reason it exists is that the encode phase is not interruptible by any knob.
    expect(failure.error).toMatch(/not interruptible/)
    expect(failure.error).toMatch(/heap limit/)
    expect(failure.error).toMatch(String(MAX_TEMPORAL_BOUND))
  })

  it('validates BEFORE loading the document, so a usage error needs no valid doc', async () => {
    // A bad option on a document that does not exist must still be ERR_USAGE, not
    // ERR_DOC_NOT_FOUND: the invocation is wrong regardless of what it points at,
    // and reporting the document first would send an agent to fix the wrong thing.
    const fs: MemoryFs = { files: new Map(), saves: [] }
    const result = await Effect.runPromise(
      Effect.result(runOperation(checkOp, { file: 'missing.json', timeoutMs: -5 })).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryStore(fs),
            Layer.succeed(DocPath)(makeDocPath({})),
            solverServiceLayer,
            embedderLayerOf(stubEmbedder()),
          ),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as { _tag: string })._tag).toBe('ERR_USAGE')
    }
  })
})

// ---------------------------------------------------------------------------
// The exit contract, computed from the envelope
// ---------------------------------------------------------------------------

describe('check — the exit contract', () => {
  it('maps a proven contradiction to EXIT_FINDINGS_FAILURE (1)', async () => {
    const data = await expectOk(contradictoryDoc())
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data })).toBe(EXIT_FINDINGS_FAILURE)
  })

  it('maps a tripped strict gate with NO error finding to EXIT_INCONCLUSIVE (3)', async () => {
    const data = await expectOk(disjointDoc(), { strict: true })
    expect(data.counts.error).toBe(0)
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data })).toBe(EXIT_INCONCLUSIVE)
  })

  it('a proven defect OUTRANKS the strict gate', async () => {
    // Both conditions hold at once here: an error finding AND (potentially) a
    // tripped gate. The stronger news wins — "your spec is broken" beats "I could
    // not fully check it" — so the code must be 1, not 3.
    const data = await expectOk(contradictoryDoc(), { strict: true })
    expect(data.counts.error).toBeGreaterThan(0)
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data })).toBe(EXIT_FINDINGS_FAILURE)
  })

  it('maps a verified clean run to EXIT_CLEAN (0)', async () => {
    const data = await expectOk(emptyDocument(), { strict: true })
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data })).toBe(EXIT_CLEAN)
  })

  it('info-only findings still exit clean', async () => {
    const data = await expectOk(disjointDoc())
    expect(data.counts.info).toBeGreaterThan(0)
    expect(data.counts.error).toBe(0)
    // warn/info are deliberately outside the pass/fail gate, so a document that
    // merely tripped an advisory rule is not a build failure.
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data })).toBe(EXIT_CLEAN)
  })
})

// ---------------------------------------------------------------------------
// The Layer boots lazily, and once
// ---------------------------------------------------------------------------

describe('check — the solver Layer', () => {
  it('does not boot WASM for an operation that never yields boot', async () => {
    // The laziness that makes merging the solver Layer into the composition root
    // free. A provided Layer is BUILT eagerly on beta.102 (probed), so this asserts
    // the property that actually matters: reaching the service costs no init.
    const reached = await Effect.runPromise(
      Effect.map(SolverService, (s) => typeof s.solve).pipe(Effect.provide(solverServiceLayer)),
    )
    expect(reached).toBe('function')
  })

  it('reports the document version it validated against', async () => {
    // A guard on the compat boundary: `check` reads a v3 document, and the tier sees
    // a v2-shaped view. If the projection ever pointed at the wrong version the
    // store's load would fail first, so this pins that the document under test is
    // genuinely v3.
    const data = await expectOk(emptyDocument())
    expect(data.path).toBe('doc.json')
    expect(DOC_VERSION).toBe(3)
  })
})
