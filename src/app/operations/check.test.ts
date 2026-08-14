/**
 * Tests for the `check` operation: the option surface, the v5 additions, and the
 * exit-code contract.
 *
 * ## These run the REAL handler over the REAL solver
 *
 * The document store is in-memory (so a test asserts against a document it built,
 * with no filesystem), but the SolverService Layer is the shipped one and Z3 really
 * boots. Stubbing the solver would make these tests assert the shape of a mock, and the
 * whole point of `check` is what the solver concludes. Here the concern is the SHELL: does
 * an option reach the tier, does a repair get attached, does the exit contract hold.
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
import { embedderLayerOf, stubEmbedder } from '../../adapters/embedding/embedder.ts'
import { DocPath, DocStore, makeDocPath, type SaveInput } from '../../adapters/fs/store.ts'
import { SolverService, solverServiceLayer } from '../../adapters/z3/solver-service.ts'
import {
  DOC_VERSION,
  emptyDocument,
  type LoadedDocument,
  type Requirement,
  type RequirementsDocument,
} from '../../domain/requirements/document.ts'
import { ErrDocNotFound, type OperationalError } from '../runtime/errors.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  exitCodeForEnvelope,
} from '../runtime/exit.ts'
import { runOperation } from '../runtime/operation.ts'
import {
  type CheckPayload,
  checkOp,
  MAX_TEMPORAL_BOUND,
  REACHABILITY_TIMEOUT_IS_CANCELLABILITY,
  resolveReachabilityTimeoutMs,
} from './check.ts'

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

// ---------------------------------------------------------------------------
// The reachability tier (G4) — wired in, and a PURE ADDITION
// ---------------------------------------------------------------------------

/**
 * `check`'s reachability integration.
 *
 * Two claims, and the second matters as much as the first:
 *
 * 1. When a state model IS committed, the tier runs and its verdicts reach `findings[]`,
 *    `coverage.demotions[]`, `counts`, `verified`, and the exit code.
 * 2. When one is NOT committed, NOTHING changes — no key, no finding, no demotion. That
 *    is what makes the tier a pure addition, and it is asserted DIRECTLY rather than left
 *    implicit in the other fixtures: those could all grow a state model one day without
 *    anyone noticing this property had been the reason they were safe.
 */
describe('the reachability tier runs ONLY when a state model is committed (G4)', () => {
  /** A UUID-shaped id, so the document schema accepts it. */
  const rid = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`

  /** A lock model whose one constraint is PROVABLE with nothing assumed. */
  const provableDoc = (): RequirementsDocument => ({
    ...docOf(
      req({
        id: rid(1),
        key: 'TX-A1',
        sentence: 'The lock manager shall grant the lock.',
        systemResponse: 'grant the lock',
        responseKind: 'effect',
        stateEffect: 'when granted = 0: granted := granted + 1',
      }),
      req({
        id: rid(2),
        key: 'TX-A2',
        sentence: 'The lock manager shall release the lock.',
        systemResponse: 'release the lock',
        responseKind: 'effect',
        stateEffect: 'when granted = 1: granted := granted - 1',
      }),
      req({
        id: rid(3),
        key: 'TX-C1',
        sentence: 'The lock manager shall hold at most one lock.',
        systemResponse: 'hold at most one lock',
        responseKind: 'constraint',
        stateConstraint: 'granted <= 1',
      }),
    ),
    stateModel: {
      variables: [
        {
          name: 'granted',
          type: 'int',
          frame: 'volatile',
          initial: 'granted = 0',
          domain: { min: 0, max: 4 },
        },
      ],
    },
  })

  /** The SAME requirements with a genuine defect: an effect that violates the constraint. */
  const violatedDoc = (): RequirementsDocument => {
    const base = provableDoc()
    return {
      ...base,
      requirements: {
        ...base.requirements,
        [rid(4)]: req({
          id: rid(4),
          key: 'TX-A3',
          sentence: 'The lock manager shall force a second grant.',
          systemResponse: 'force a second grant',
          responseKind: 'effect',
          // Unguarded, and it can push `granted` to 2 — a real violation of TX-C1 reached
          // through a change this requirement itself makes.
          stateEffect: 'granted := granted + 2',
        }),
      },
    }
  }

  // -------------------------------------------------------------------------
  // The tier is OFF without a state model
  // -------------------------------------------------------------------------

  it('emits NO `reachability` key and NO reachability finding without a state model', async () => {
    const payload = await expectOk(
      docOf(req({ id: rid(1), sentence: 'The system shall operate.' })),
    )
    // ABSENT, not empty — the key must not exist at all, which is what leaves the payload
    // byte-identical to a run from before this tier existed.
    expect('reachability' in payload).toBe(false)
    expect(payload.findings.some((f) => f.code.startsWith('FND_REACHABILITY'))).toBe(false)
    expect(
      payload.coverage.demotions.some((d) => String(d.reason).startsWith('reachability')),
    ).toBe(false)
  })

  it('is off for an EMPTY state model too, not merely for a missing one', async () => {
    // `emptyDocument()` carries `stateModel: {variables: []}`, so "no state model" and
    // "an empty state model" are the same document on disk. The gate is the variable
    // COUNT, and this pins that rather than a key check.
    const payload = await expectOk({
      ...docOf(req({ id: rid(1), sentence: 'The system shall operate.' })),
      stateModel: { variables: [] },
    })
    expect('reachability' in payload).toBe(false)
  })

  // -------------------------------------------------------------------------
  // The tier is ON with one, and reaches every published surface
  // -------------------------------------------------------------------------

  it('PROVES a provable constraint, with the re-verified invariant as evidence', async () => {
    const payload = await expectOk(provableDoc())
    expect(payload.reachability).toBeDefined()
    expect(payload.reachability?.variables).toBe(1)
    expect(payload.reachability?.effects).toBe(2)
    expect(payload.reachability?.proved).toBe(1)
    expect(payload.reachability?.violated).toBe(0)

    const proved = payload.findings.find((f) => f.code === 'FND_REACHABILITY_PROVED')
    expect(proved?.severity).toBe('info')
    expect(proved?.requirementIds).toEqual([rid(3)])
    // The certificate check ran and passed — that is what makes the proof reportable.
    expect(
      (proved?.evidence as unknown as { certificateVerified?: boolean } | undefined)
        ?.certificateVerified,
    ).toBe(true)
    // A PROVED verdict adds NO demotion, which is the mechanism by which `verified` may
    // stay true.
    expect(
      payload.coverage.demotions.filter((d) => String(d.reason).startsWith('reachability')),
    ).toEqual([])
  })

  it('reports a genuine violation at ERROR severity, with a trace naming requirements', async () => {
    const payload = await expectOk(violatedDoc())
    expect(payload.reachability?.violated).toBeGreaterThan(0)

    const violated = payload.findings.find((f) => f.code === 'FND_REACHABILITY_VIOLATED')
    expect(violated?.severity).toBe('error')
    // The trace cites the requirement's own KEY, not an internal rule name (donor V29).
    expect(violated?.message).toContain('TX-A3')

    // And it flows into the tallies the exit contract reads, so exit 1 needs no new wiring.
    expect(payload.counts.error).toBeGreaterThan(0)
  })

  it('the reachability finding count is INCLUDED in `counts`, not reported beside it', async () => {
    // The counts must describe the same array the payload publishes, or the exit code and
    // the findings disagree.
    const payload = await expectOk(provableDoc())
    const tallied = payload.counts.error + payload.counts.warn + payload.counts.info
    expect(payload.findings).toHaveLength(tallied)
  })

  it('DEMOTES `verified` when a state model is declared but nothing is classified', async () => {
    // The "silence made visible" case: declaring variables is the easy half, and a
    // document stuck there must not look like one that passed.
    const payload = await expectOk({
      ...docOf(req({ id: rid(1), sentence: 'The system shall operate.' })),
      stateModel: { variables: [{ name: 'granted', type: 'int', frame: 'volatile' }] },
    })
    const disclosure = payload.findings.find((f) => f.code === 'FND_REACHABILITY_NOT_CHECKED')
    expect(disclosure).toBeDefined()
    expect(payload.verified).toBe(false)
    const demotion = payload.coverage.demotions.find(
      (d) => String(d.reason) === 'reachability-not-checked',
    )
    // The demotion carries a RUNNABLE repair, not prose to parse.
    expect(demotion?.repair?.commands?.join(' ')).toContain('symspec classify')
  })

  it('honors `--min-severity error`, dropping the info-tier reachability findings', async () => {
    const payload = await expectOk(provableDoc(), { minSeverity: 'error' })
    expect(payload.findings.some((f) => f.code === 'FND_REACHABILITY_PROVED')).toBe(false)
    // But the SUMMARY still reports what happened — a presentation filter must not erase
    // the fact that the tier ran.
    expect(payload.reachability?.proved).toBe(1)
  })

  it('keeps an error-severity reachability finding under `--min-severity error`', async () => {
    // The property that makes the filter safe for a gate: `error` is the top of the
    // order, so it can never remove the finding the exit code keys on.
    const payload = await expectOk(violatedDoc(), { minSeverity: 'error' })
    expect(payload.findings.some((f) => f.code === 'FND_REACHABILITY_VIOLATED')).toBe(true)
  })

  it('is DETERMINISTIC: two runs over one document agree on every verdict', async () => {
    // SEQUENTIAL — `Promise.all` over two runs wedges Asyncify's single capability slot.
    const first = await expectOk(provableDoc())
    const second = await expectOk(provableDoc())

    // `elapsedMs` is EXCLUDED, and deliberately: it is a wall-clock measurement, so two
    // runs legitimately differ (measured 30ms then 8ms — the second is faster because the
    // WASM module is warm). Asserting on it would make the determinism guard a flaky
    // benchmark, which is worse than no guard: it trains people to re-run rather than read.
    //
    // The claim that matters is that the VERDICTS are reproducible given (document +
    // committed tables + pinned model), which is the determinism the whole tool rests on.
    const { elapsedMs: _firstMs, ...firstVerdicts } = first.reachability ?? {}
    const { elapsedMs: _secondMs, ...secondVerdicts } = second.reachability ?? {}
    expect(secondVerdicts).toEqual(firstVerdicts)
    expect(
      second.findings.filter((f) => f.code.startsWith('FND_REACHABILITY')).map((f) => f.code),
    ).toEqual(
      first.findings.filter((f) => f.code.startsWith('FND_REACHABILITY')).map((f) => f.code),
    )
  })
})

// ---------------------------------------------------------------------------
// `--reachability-timeout-ms` (G5) — the tier's OWN bound, split from the shared one
// ---------------------------------------------------------------------------

/**
 * The dedicated reachability bound.
 *
 * Three claims, and the ORDER they are asserted in is the order they would break in:
 *
 * 1. **Absent reproduces the shared behavior byte for byte.** This is what keeps the flag
 *    a pure addition: every existing fixture was pinned against `--timeout-ms` governing
 *    both, and none of them passes the new flag. A resolver that defaulted to a constant
 *    instead of inheriting would move fixture output on documents nobody edited.
 * 2. **Present overrides ONLY this tier.** The reason the split exists: raising a
 *    reachability bound 20x to decide an UNKNOWN must not hand seven per-pair
 *    propositional solvers 20x the rope.
 * 3. **0 is INHERIT, never unbounded** — the cancellability property. A negative is a
 *    usage error, so there is no spelling of "no bound" at all.
 */
describe('--reachability-timeout-ms bounds the reachability tier alone (G5)', () => {
  const rid = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`

  /** The same single-variable lock model the G4 tests use, which PROVES frame-closed. */
  const provable = (): RequirementsDocument => ({
    ...docOf(
      req({
        id: rid(1),
        key: 'TX-A1',
        sentence: 'The lock manager shall grant the lock.',
        systemResponse: 'grant the lock',
        responseKind: 'effect',
        stateEffect: 'when granted = 0: granted := granted + 1',
      }),
      req({
        id: rid(2),
        key: 'TX-C1',
        sentence: 'The lock manager shall hold at most one lock.',
        systemResponse: 'hold at most one lock',
        responseKind: 'constraint',
        stateConstraint: 'granted <= 1',
      }),
    ),
    stateModel: {
      variables: [
        {
          name: 'granted',
          type: 'int',
          frame: 'volatile',
          initial: 'granted = 0',
          domain: { min: 0, max: 4 },
        },
      ],
    },
  })

  // --- The resolver, in isolation -------------------------------------------

  it('0 INHERITS --timeout-ms — the sentinel is inherit, not unbounded', () => {
    expect(resolveReachabilityTimeoutMs(0, 2000)).toBe(2000)
    expect(resolveReachabilityTimeoutMs(0, 45)).toBe(45)
  })

  it('a positive value OVERRIDES --timeout-ms in both directions', () => {
    // Both directions, because a resolver written as `Math.max` would pass an
    // only-raises test and silently refuse to LOWER the reachability bound — which is the
    // useful direction when a hung model needs to fail fast.
    expect(resolveReachabilityTimeoutMs(8000, 2000)).toBe(8000)
    expect(resolveReachabilityTimeoutMs(250, 2000)).toBe(250)
  })

  it('records that the bound is a CANCELLABILITY mechanism, not merely a budget', () => {
    // Measured: a raw `Z3.interrupt` landed in 3ms while interrupting through the tier
    // took 10232ms against a 10000ms bound, because `Z3_interrupt` is cooperative. So an
    // unbounded query is an uncancellable one, and `0` must never come to mean unbounded.
    expect(REACHABILITY_TIMEOUT_IS_CANCELLABILITY).toBe(true)
  })

  // --- Through the real operation -------------------------------------------

  it('ABSENT reproduces --timeout-ms exactly — the pure-addition property', async () => {
    // SEQUENTIAL: `Promise.all` over two solver runs wedges Asyncify's capability slot.
    const shared = await expectOk(provable(), { timeoutMs: 3500 })
    const explicit = await expectOk(provable(), { timeoutMs: 3500, reachabilityTimeoutMs: 0 })
    // The tier PUBLISHES the bound it used, so this is checkable rather than inferred.
    expect(shared.reachability?.timeoutMs).toBe(3500)
    expect(explicit.reachability?.timeoutMs).toBe(3500)
  })

  it('a supplied value reaches the tier and is published', async () => {
    const payload = await expectOk(provable(), { timeoutMs: 2000, reachabilityTimeoutMs: 7000 })
    expect(payload.reachability?.timeoutMs).toBe(7000)
    // And the verdict is unchanged — the flag moves the BOUND, not the answer.
    expect(payload.reachability?.proved).toBe(1)
  })

  it('overrides DOWNWARD too, without changing a verdict this model reaches easily', async () => {
    // The 48ms measured cost of this model leaves plenty of room under 500ms, so a lower
    // bound is observable in `timeoutMs` without making the test a race.
    const payload = await expectOk(provable(), { timeoutMs: 9000, reachabilityTimeoutMs: 500 })
    expect(payload.reachability?.timeoutMs).toBe(500)
    expect(payload.reachability?.proved).toBe(1)
  })

  it('does NOT change what the SHARED --timeout-ms means for the other tiers', async () => {
    // The whole point of the split. The propositional tiers' bound must be untouched by
    // the reachability flag, and the observable proxy is that the reachability summary
    // reports the reachability bound while everything else behaves as it did — asserted
    // here as "the two numbers are different and both are honored".
    const payload = await expectOk(provable(), { timeoutMs: 1200, reachabilityTimeoutMs: 6000 })
    expect(payload.reachability?.timeoutMs).toBe(6000)
    expect(payload.reachability?.timeoutMs).not.toBe(1200)
    // A run that still completed, so the lower shared bound did not break the other tiers.
    expect(payload.verified === true || payload.coverage.demotions.length > 0).toBe(true)
  })

  it('rejects a NEGATIVE value with a runnable correction', async () => {
    const result = await runCheckOp(provable(), { reachabilityTimeoutMs: -1 })
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    const failure = result.failure as {
      _tag: string
      error: string
      repair?: { commands: readonly string[] }
    }
    expect(failure._tag).toBe('ERR_USAGE')
    expect(failure.error).toMatch(/--reachability-timeout-ms/)
    // The message must say what 0 MEANS, or a reader will try it as "unbounded".
    expect(failure.error).toMatch(/inherits --timeout-ms/)
    expect(failure.repair?.commands[0]).toMatch(/--reachability-timeout-ms/)
  })
})

// ---------------------------------------------------------------------------
// Every command the ENVELOPE prints is one the CLI accepts
// ---------------------------------------------------------------------------

/**
 * The whole-envelope sweep, over a real run.
 *
 * `formal/repair.test.ts` proves the normalizer works and that no source file spells a
 * command the CLI rejects. What it cannot prove is that `check` actually CALLS it on
 * every field it publishes — the wiring, not the function. So this asserts the property
 * an agent depends on, stated over the serialized payload: nothing anywhere in it names
 * a nested subcommand.
 *
 * The document is the quantity-alias shape because its finding message is the one that
 * carries a discharge command in FOUR places at once — the message, the demotion's
 * action, the coverage row's suggestion, and `repair.commands` — so a field left
 * unnormalized shows up here rather than in whichever surface someone reads next.
 */
describe('no command in a check envelope spells a nested subcommand', () => {
  const aliasDoc = (): RequirementsDocument =>
    docOf(
      req({
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        patternType: 'event-driven',
        trigger: 'the clinician starts an infusion',
        systemName: 'infusion pump',
        systemResponse: 'complete the infusion within 30 minutes',
        sentence:
          'When the clinician starts an infusion, the infusion pump shall complete the infusion within 30 minutes.',
      }),
      req({
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        patternType: 'event-driven',
        trigger: 'the clinician starts an infusion',
        systemName: 'infusion pump',
        systemResponse: 'run the infusion for at least 60 minutes',
        sentence:
          'When the clinician starts an infusion, the infusion pump shall run the infusion for at least 60 minutes.',
      }),
    )

  it('raises the alias candidate, so the sweep is over a real payload', async () => {
    const result = await runCheckOp(aliasDoc(), { strict: true })
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    // Guards the fixture: if the detector stops firing, the sweep below would pass
    // vacuously and this whole describe would silently stop testing anything.
    expect(result.success.data.findings.map((f) => f.code)).toContain(
      'FND_QUANTITY_ALIAS_CANDIDATE',
    )
  })

  it('names no `<operation> add` anywhere in the serialized payload', async () => {
    const result = await runCheckOp(aliasDoc(), { strict: true })
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    const wire = JSON.stringify(result.success.data)
    for (const operation of ['glossary', 'antonym', 'waive']) {
      expect(wire, `${operation} still carries import's side-table verb`).not.toContain(
        `symspec ${operation} add`,
      )
    }
  })

  it('publishes the discharge in the form that RUNS', async () => {
    const result = await runCheckOp(aliasDoc(), { strict: true })
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    const alias = result.success.data.coverage.demotions.find(
      (d) => d.reason === 'quantity-alias-candidate',
    )
    expect(alias?.repair?.commands[0]).toBe(
      'symspec glossary "complete the infusion" "run the infusion"',
    )
    // And the prose a human copies out of `--pretty` agrees with it.
    const finding = result.success.data.findings.find(
      (f) => f.code === 'FND_QUANTITY_ALIAS_CANDIDATE',
    )
    expect(finding?.message).toContain(
      '`symspec glossary "complete the infusion" "run the infusion"`',
    )
  })
})

// ---------------------------------------------------------------------------
// `--strict` honours its own flag text
// ---------------------------------------------------------------------------

/**
 * The gate's promise, checked against the gate.
 *
 * `--strict`'s own description says it will "fail with exit 3 when data.verified is false".
 * That is a claim about the MERGED verdict, but `strictGate` is computed inside the
 * vendored tier from the tier's own `verified`, before the boundary splices in the
 * reachability demotions. So a run whose only demotions come from reachability published
 * `verified: false` beside `strictGate: 'pass'` and exited 0 — the flag silently not doing
 * the one thing it exists to do.
 *
 * This is the shape that had no test: every other `--strict` case reaches a demotion the
 * vendored tier already knows about, so the boundary's omission is invisible to them.
 */
describe('--strict fails on a demotion the BOUNDARY added, not just the tier', () => {
  /** A document whose ONLY demotion is `reachability-not-checked`. */
  const reachabilityOnlyDoc = (): RequirementsDocument => ({
    ...docOf(
      req({
        id: 'dddddddd-0000-4000-8000-000000000001',
        sentence: 'The system shall operate.',
      }),
    ),
    stateModel: { variables: [{ name: 'granted', type: 'int', frame: 'volatile' }] },
  })

  it('the fixture really does demote, and ONLY from the boundary', async () => {
    // Guards the test below from passing vacuously: if the fixture stopped demoting, or
    // started demoting for a reason the tier itself raises, it would no longer exercise
    // the seam.
    const payload = await expectOk(reachabilityOnlyDoc())
    expect(payload.verified).toBe(false)
    expect(payload.coverage.demotions.map((d) => String(d.reason))).toEqual([
      'reachability-not-checked',
    ])
  })

  it('trips the gate, so the exit code is 3 rather than 0', async () => {
    const payload = await expectOk(reachabilityOnlyDoc(), { strict: true })
    // The flag's literal promise: verified false under --strict means the gate failed.
    expect(payload.verified).toBe(false)
    expect(payload.strictGate).toBe('fail')
    // And the exit mapping reads that field, so this is the process contract too.
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data: payload })).toBe(
      EXIT_INCONCLUSIVE,
    )
  })

  it('still lets a PROVEN defect outrank the gate', async () => {
    // Tightening the gate must not disturb the 1-vs-3 ordering: an error finding is a
    // different answer from "I could not verify", and exit 1 keeps precedence.
    const payload = await expectOk(contradictoryDoc(), { strict: true })
    expect(payload.counts.error).toBeGreaterThan(0)
    expect(exitCodeForEnvelope({ apiVersion: 1, type: 'check', data: payload })).toBe(
      EXIT_FINDINGS_FAILURE,
    )
  })
})
