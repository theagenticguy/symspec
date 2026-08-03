/**
 * `check` — the formal conflict detector, and the reason symspec exists.
 *
 * ## What this operation is, structurally
 *
 * A thin Effect shell over the TRANSPLANTED donor pipeline
 * (`../donor/pipeline/check.ts`, byte-identical to the donor's), plus two
 * v5 additions the donor's report shape did not carry. The pipeline itself is
 * untouched on purpose: the differential oracle (`../formal/differential.test.ts`)
 * runs the donor's `runCheck` and this operation over the same documents and
 * requires byte-identical `findings` / `demotions` / `verified`. Any behavioral
 * edit inside the tier would be a wave-gate failure, so this file adds only at the
 * boundary.
 *
 * The shell's four jobs:
 *
 * 1. Project the v3 document onto the v2 view the tier reads (`../formal/compat.ts`
 *    — one function, one crossing).
 * 2. Run `runCheck` THROUGH the `SolverService` Layer, so every solver call rides
 *    the Layer-owned WASM instance and the process can exit cleanly.
 * 3. Add the two v5 fields: `repair` on every demotion (AC-A-1) and
 *    `data.progress` (AC-A-2).
 * 4. Validate the option surface up front, with the donor's exact usage errors.
 *
 * ## Why the whole run is ONE Effect.promise and not per-tier Effects
 *
 * `runCheck` is a plain `async` function that internally calls seven solver tiers.
 * Effect-izing its interior would mean editing the transplanted file — the one
 * thing the oracle forbids. So the whole run is wrapped once, and the interruption
 * discipline is satisfied differently but soundly:
 *
 * - the Layer OWNS the module, so the process can always be brought to a clean
 *   exit by closing the scope;
 * - the tiers' own `--timeout-ms` (per-solver `solver.set('timeout', …)`) and
 *   `--solver-budget-ms` (whole-run deadline, consulted between tiers) are the
 *   in-band bounds, and they are the donor's, unchanged;
 * - `SolverService.solve` / `interruptibleSolve` remains the sanctioned primitive
 *   for anything the greenfield writes NEW against Z3 — which in G2a is the guard
 *   test, and in G4 will be the Spacer reachability tier.
 *
 * The honest limit, stated rather than papered over: interrupting THIS operation
 * mid-`runCheck` (an outer `Effect.timeout`, a SIGINT) abandons whatever query is
 * in flight, which wedges the module for the rest of the process. That is
 * acceptable here and only here, because `check` is the last thing a CLI process
 * does before emitting its envelope and exiting — there is no "rest of the
 * process" to protect. It would NOT be acceptable in a long-lived server, and
 * {@link CHECK_IS_TERMINAL} records that so a future server surface has to
 * confront it.
 *
 * ## The temporal bound's cap is a MEASUREMENT, not a taste
 *
 * `--temporal-bound` is capped at 200 and the cap is enforced here with the
 * donor's exact rationale, because the encode phase is NOT interruptible by either
 * budget knob: `--timeout-ms` is a per-solver setting and the cost is paid building
 * the term graph before any solver sees it, while `--solver-budget-ms` is consulted
 * only BEFORE the tier starts (temporal is one whole-spec unit of work). So a large
 * bound is a denial of service with no abort. Donor measurements, carried verbatim
 * because they are the justification: 100 requirements at k=200 → 13.5s / 2.0 GB;
 * at k=300 → 55s / 4.0 GB, which is Node's default heap limit — the process aborts
 * with no envelope at all. 200 is the last bound with headroom under that cliff.
 */

import { Effect, Schema } from 'effect'
import type { DocumentDiagnostic } from '../core/document.ts'
import { DocPath, DocStore } from '../core/store.ts'
import type {
  CheckFinding,
  CheckOptions,
  CheckReport,
  CheckSeverity,
  CoverageDemotion,
} from '../donor/pipeline/check.ts'
import { filterReport, runCheck } from '../donor/pipeline/check.ts'
import type { Exclusion } from '../donor/pipeline/gate.ts'
import { toDonorDoc } from '../formal/compat.ts'
import { repairForDemotion } from '../formal/repair.ts'
import { SolverService } from '../formal/solver-service.ts'
import { ok, type Repair } from '../kernel/envelope.ts'
import { ErrSolverInconclusive, ErrUsage } from '../kernel/errors.ts'
import { defineOperation } from '../kernel/operation.ts'

// ---------------------------------------------------------------------------
// The two bounds that are policy, stated as values
// ---------------------------------------------------------------------------

/**
 * The maximum legal `--temporal-bound`. See the module header for the measurements
 * this number comes from; the short version is that k=300 hits Node's heap limit
 * and aborts with no envelope, and no knob can interrupt the encode phase that
 * gets there.
 */
export const MAX_TEMPORAL_BOUND = 200

/**
 * `check` is the TERMINAL operation of a CLI process, and that is what makes
 * wrapping `runCheck` in a single `Effect.promise` sound.
 *
 * A `false` here would mean the process outlives the check — a server, a watch
 * mode, a batch runner — and then an interrupted `runCheck` would leave the WASM
 * module wedged for every subsequent request. The fix at that point is to route
 * each tier through `SolverService.solve`, which requires Effect-izing the
 * transplanted pipeline and therefore retiring the byte-identity oracle. Recorded
 * as a value so that trade is a deliberate decision rather than a surprise.
 */
export const CHECK_IS_TERMINAL = true

// ---------------------------------------------------------------------------
// The v5 report additions
// ---------------------------------------------------------------------------

/**
 * A demotion with its runnable remedy attached (spec AC-A-1).
 *
 * `repair` is OPTIONAL, and the absence is meaningful rather than an omission: an
 * `uncovered-requirement` demotion discharges through a human rewrite, and there
 * is no command that performs one. Emitting an empty `{ops:[],commands:[]}` would
 * tell an agent "there is a repair, it is nothing"; omitting the key says "no
 * mechanical fix exists, read `action`". See `../formal/repair.ts`.
 */
export interface RepairableDemotion extends CoverageDemotion {
  readonly repair?: Repair
}

/**
 * The GRADIENT an agent iterates against (spec AC-A-2).
 *
 * `verified: false` is a work list, not a verdict, and an agent applying repairs
 * needs to know whether it is converging. Three numbers, chosen because each falls
 * for a different reason and together they cover every discharge path:
 *
 * - `demotions` — how many reasons `verified` is still false. Falls when a demotion
 *   is discharged (a committed glossary/antonym link, a reviewed waiver, a rewrite).
 * - `openFindings` — how many error-severity findings remain. Falls when a real
 *   conflict is fixed. Deliberately error-only: warn/info findings are outside the
 *   pass/fail gate, so counting them would make the gradient move on changes that
 *   do not affect the outcome.
 * - `atomsUncompared` — how many atoms have no cross-requirement partner. Falls
 *   when vocabulary is aligned, which is the lever behind most
 *   `uncovered-requirement` demotions and the one an agent can act on without
 *   understanding the domain.
 *
 * All three reaching zero is exactly the fixed point: no demotions means
 * `verified` is true, no error findings means exit 0, no uncompared atoms means the
 * formal tier saw the whole document.
 */
export interface CheckProgress {
  /** Open demotion count — `verified` is true exactly when this is 0. */
  readonly demotions: number
  /** Error-severity findings remaining. Excludes warn/info by design. */
  readonly openFindings: number
  /** Atoms owned by exactly one requirement, so never cross-compared. */
  readonly atomsUncompared: number
}

/**
 * The `check` payload: the donor's report shape, plus the two v5 additions.
 *
 * Every donor field keeps its name and meaning — `findings`, `excluded`,
 * `pairsChecked`, `waived`, `counts`, `residualRisk`, `coverage`, `verified`,
 * `strictGate`. That is agent API, not legacy, and the differential oracle asserts
 * it byte-for-byte. `progress` and the `repair` inside `coverage.demotions[]` are
 * ADDITIVE, which is why the oracle can exclude exactly those two and still be a
 * strict comparison of everything else.
 */
export interface CheckPayload extends Omit<CheckReport, 'coverage'> {
  readonly coverage: Omit<CheckReport['coverage'], 'demotions'> & {
    readonly demotions: readonly RepairableDemotion[]
  }
  /** The v5 iteration gradient (AC-A-2). */
  readonly progress: CheckProgress
  /** The resolved document path, so an agent can quote it in a follow-up. */
  readonly path: string
  /** The load's info-grade disclosures (V27 channel), surfaced on every read. */
  readonly diagnostics: readonly DocumentDiagnostic[]
}

// ---------------------------------------------------------------------------
// Input schema — the G2a option subset
// ---------------------------------------------------------------------------

const lines = (...xs: readonly string[]): string => xs.join('\n')

/** An optional integer flag with a schema-visible default. */
const intFlag = (value: number, description: string) =>
  Schema.withDecodingDefaultKey<Schema.Int>(Effect.succeed(value))(
    Schema.Int.annotate({ default: value, description }),
  )

/** An optional boolean flag with a schema-visible default. */
const boolFlag = (description: string) =>
  Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
    Schema.Boolean.annotate({ default: false, description }),
  )

/**
 * The G2a option surface. Deliberately a SUBSET of the donor's `check` flags —
 * `--emit-smt2`, `--solver z3-bin|cvc5`, `--solver-path`, `--semantic-threshold`,
 * and `--similarity-threshold` are G2b/G3 — and every included flag keeps the
 * donor's exact name, meaning, and default.
 *
 * `--temporal-bound` has no `--temporal` companion here, on purpose: the donor
 * needed both because commander cannot express "a bound implies the tier", and the
 * result is a flag that silently does nothing without its partner. A single
 * `--temporal-bound` whose DEFAULT is 0 (meaning off) is the same capability with
 * one fewer way to get it wrong. Supplying a bound IS opting in.
 */
const CheckInput = Schema.Struct({
  file: Schema.withDecodingDefaultKey<Schema.optionalKey<Schema.NullOr<Schema.String>>>(
    Effect.succeed(null),
  )(
    Schema.optionalKey(
      Schema.NullOr(Schema.String).annotate({
        default: null,
        description: lines(
          'Path to the requirements document to check.',
          'Resolution precedence, in order: the supplied path, then the SYMSPEC_DOC environment',
          'variable, then the ./requirements.json default.',
        ),
      }),
    ),
  ),
  timeoutMs: intFlag(
    2000,
    lines(
      'Per-solver timeout in milliseconds, applied to EVERY solver every tier constructs',
      '(contradiction, subsumption, vacuity, incomplete, numeric, temporal, needs-review).',
      'A solver that hits it returns `unknown`, which each tier handles conservatively — so this',
      'can only WITHHOLD a finding, never manufacture one.',
      'Note: it does NOT bound the temporal tier`s ENCODE phase; see --temporal-bound.',
    ),
  ),
  solverBudgetMs: intFlag(
    0,
    lines(
      'Whole-run wall-clock solver budget in milliseconds, spanning every solver tier. 0 means',
      'unbounded (the default), which is the donor behavior when the flag is absent.',
      'A tier that stops early records a truncation, which becomes a `solver-budget-exhausted`',
      'demotion — so a truncated run can NEVER report verified: true. The budget starts at the',
      'first solver contact, not at document load, so no solver knob governs parse/lint time.',
    ),
  ),
  temporalBound: intFlag(
    0,
    lines(
      'Trace bound k for the OPT-IN bounded LTL→SMT temporal tier. 0 (the default) means the tier',
      'does not run; any value from 1 to 200 enables it — supplying a bound IS opting in.',
      'The tier maps EARS requirements to LTL (Dwyer/FRET) and proves temporal-ordering',
      'contradictions (FND_TEMPORAL_CONTRADICTION). Sound-for-UNSAT: a `sat` result at the bound',
      'is NOT a consistency certificate.',
      'CAPPED AT 200, from measurement: the lowering is O(k²)–O(k³) and the expensive half is',
      'ENCODING, which neither --timeout-ms (a per-solver setting) nor --solver-budget-ms (checked',
      'only before the tier starts) can interrupt. Measured: 100 requirements at k=200 takes 13.5s',
      'and 2.0 GB; at k=300 it takes 55s and 4.0 GB — Node`s heap limit, where the process aborts',
      'with no envelope at all. 200 is 20x the default trace length and the last bound with real',
      'headroom under that cliff.',
    ),
  ),
  strict: boolFlag(
    lines(
      'Gate: fail with exit 3 when data.verified is false — any uncovered requirement, any',
      'untriaged opposition candidate, or no decide-tier comparison at all.',
      'Off by default so the base contract is unchanged: an agent must OPT IN to',
      '"I could not verify this is a build failure". coverage.demotions[] lists every reason with',
      'the exact discharging ops and commands, so a tripped gate is a work list, not a dead end.',
    ),
  ),
  // NULLABLE, not a negative sentinel, and the reason is a hard CLI limitation
  // discovered end-to-end: `--fail-on-unmatched -1` does not parse as "the value
  // -1". The CLI reads a leading `-` as the start of the NEXT flag, so the
  // invocation degrades to a help dump — which means a negative disabled-sentinel
  // is UNREACHABLE from the command line no matter what the schema says.
  //
  // 0 cannot be the sentinel either: it is the most useful threshold there is
  // ("fail on ANY unmatched atom"), and a count-valued gate has no other natural
  // out-of-band number. So absence is modelled as absence — `null` — the same
  // convention the doc-path field uses, and it is expressible: omitting the flag IS
  // disabling the gate.
  //
  // NOT wrapped in `Schema.optionalKey`. `withDecodingDefaultKey` ALREADY makes the
  // key optional on the ENCODED side (its declared result is
  // `decodeTo<S, optionalKey<toEncoded<S>>>`); adding an explicit `optionalKey`
  // makes it optional on the TYPE side too, so the decoded value types
  // `failOnUnmatched?: number | null | undefined` even though decoding ALWAYS
  // materializes it — forcing a needless `!= null` at every read and stopping the
  // compiler from catching a genuinely missing field. Optional in `Encoded`,
  // required in `Type`, is exactly what a default expresses.
  failOnUnmatched: Schema.withDecodingDefaultKey<Schema.NullOr<Schema.Int>>(Effect.succeed(null))(
    Schema.NullOr(Schema.Int).annotate({
      default: null,
      description: lines(
        'Gate: fail with exit 3 when more than <n> atoms went uncompared',
        '(residualRisk.unmatchedAtoms). OMIT the flag to disable the gate (the default);',
        'pass 0 to fail on ANY unmatched atom.',
        'An unmatched atom is owned by exactly one requirement, so it can never form a candidate',
        'pair — a high count means broad coverage holes.',
        'Independent of --strict: either gate tripping fails the run.',
      ),
    }),
  ),
  // NOTE the `readonly` in the type argument. `Schema.Literals([...])` infers its
  // `literals` tuple as READONLY, and `Literals<readonly [...]>` is not assignable
  // to `Literals<[...]>` (the tuple is invariant), so spelling the type argument
  // without `readonly` is a TS2345 at the `withDecodingDefaultKey` call — not at
  // the `Literals` call, which is what makes it read as a mystery.
  minSeverity: Schema.withDecodingDefaultKey<Schema.Literals<readonly ['error', 'warn', 'info']>>(
    Effect.succeed('info'),
  )(
    Schema.Literals(['error', 'warn', 'info']).annotate({
      default: 'info',
      description: lines(
        'Output filter: drop findings below this severity. `error` keeps only error-severity;',
        '`warn` keeps error+warn; `info` (the default) keeps everything.',
        'SAFE for the exit gate by construction — `error` is the top of the order, so this can',
        'never remove the finding the gate keys on. `counts` continues to reflect the FULL',
        'post-waiver set, so a filtered view still says how much it hid.',
      ),
    }),
  ),
  findingsOnly: boolFlag(
    lines(
      'Output filter: return only findings[] (plus the counts/waived tallies), dropping the',
      'heavier `excluded` table. The findings themselves — and therefore the exit code — are',
      'untouched.',
    ),
  ),
})

// ---------------------------------------------------------------------------
// Option validation — the donor's usage errors, exactly
// ---------------------------------------------------------------------------

/**
 * Validate the numeric knobs before any work starts, so a typo is a clean
 * `ERR_USAGE` rather than a silently-disabled gate or an unbounded run.
 *
 * The donor validated these in its commander action for the same reason; the
 * messages are carried over with the same substance. The one addition is `repair`
 * on each: the corrected invocation is a command an agent can run verbatim, which
 * is the AC-A-9 discipline applied to usage errors too.
 */
const validate = (input: typeof CheckInput.Type, path: string): Effect.Effect<void, ErrUsage> => {
  const usage = (error: string, corrected: string) =>
    Effect.fail(
      new ErrUsage({
        error,
        suggestions: [`Usage: ${corrected}`],
        repair: { ops: [], commands: [corrected] },
      }),
    )

  if (input.timeoutMs < 1) {
    return usage(
      `--timeout-ms expects a positive integer, got ${input.timeoutMs}.`,
      `symspec check ${path} --timeout-ms 2000`,
    )
  }
  if (input.solverBudgetMs < 0) {
    return usage(
      `--solver-budget-ms expects a non-negative integer (0 means unbounded), got ${input.solverBudgetMs}.`,
      `symspec check ${path} --solver-budget-ms 0`,
    )
  }
  if (input.failOnUnmatched !== null && input.failOnUnmatched < 0) {
    return usage(
      `--fail-on-unmatched expects a non-negative integer (omit the flag to disable the gate), got ${input.failOnUnmatched}.`,
      `symspec check ${path} --fail-on-unmatched 0`,
    )
  }
  if (input.temporalBound < 0) {
    return usage(
      `--temporal-bound expects an integer >= 1 to enable the tier, or 0 to disable it, got ${input.temporalBound}.`,
      `symspec check ${path} --temporal-bound <1..${MAX_TEMPORAL_BOUND}>`,
    )
  }
  if (input.temporalBound > MAX_TEMPORAL_BOUND) {
    // The donor's rationale, verbatim in substance: this is the one usage error
    // whose MESSAGE is the justification, because a bare "max is 200" invites the
    // reader to assume the cap is arbitrary and route around it.
    return usage(
      `--temporal-bound ${input.temporalBound} exceeds the maximum of ${MAX_TEMPORAL_BOUND}. The bounded ` +
        'LTL→SMT encoding is O(k²)–O(k³) in the bound, and the encode phase is not interruptible by ' +
        '--timeout-ms (a per-solver timeout) or --solver-budget-ms (checked only before the tier ' +
        'starts), so a larger bound is a denial of service with no way to abort it. Measured: 100 ' +
        'requirements at k=200 takes 13.5s and 2.0 GB; at k=300 it takes 55s and 4.0 GB, which is ' +
        "Node's heap limit — the process aborts with no envelope at all.",
      `symspec check ${path} --temporal-bound <1..${MAX_TEMPORAL_BOUND}>`,
    )
  }
  return Effect.void
}

/**
 * Translate the validated input into the donor's `CheckOptions`.
 *
 * Every absent option is an ABSENT KEY, never `undefined`. That is not just
 * `exactOptionalPropertyTypes` hygiene here — the donor branches on
 * `options.temporal !== undefined` and `options.solverBudgetMs !== undefined`, so
 * `{temporal: undefined}` and `{}` mean the same thing to the tier but the sentinel
 * translation must be explicit or a `0` bound would enable the tier with k=0.
 */
const toCheckOptions = (input: typeof CheckInput.Type): CheckOptions => ({
  timeoutMs: input.timeoutMs,
  // 0 is the "unbounded" sentinel; the donor expresses unbounded as an absent key.
  ...(input.solverBudgetMs > 0 ? { solverBudgetMs: input.solverBudgetMs } : {}),
  // A bound of 0 means the tier is off; any positive bound enables it.
  ...(input.temporalBound > 0 ? { temporal: { bound: input.temporalBound } } : {}),
  ...(input.strict ? { strict: true } : {}),
  // `null` disables the gate; 0 is a MEANINGFUL threshold (fail on ANY unmatched
  // atom), so the guard is on nullness — NOT on `> 0`, which would silently turn
  // the strictest legal setting into no gate at all.
  ...(input.failOnUnmatched !== null ? { failOnUnmatched: input.failOnUnmatched } : {}),
})

// ---------------------------------------------------------------------------
// The v5 additions, computed from the finished report
// ---------------------------------------------------------------------------

/**
 * Count atoms with no cross-requirement partner.
 *
 * Read off the report's own `residualRisk.unmatchedAtoms` rather than recomputed:
 * the pipeline tallied it from the SAME encoded roster the formal tier built, and a
 * second computation here would be a second source of truth for one number — able
 * to disagree with the field published next to it.
 */
const atomsUncompared = (report: CheckReport): number => report.residualRisk.unmatchedAtoms

/** Build the AC-A-2 gradient from the finished report. */
const progressOf = (report: CheckReport): CheckProgress => ({
  demotions: report.coverage.demotions.length,
  openFindings: report.counts.error,
  atomsUncompared: atomsUncompared(report),
})

/**
 * Attach a runnable `repair` to every demotion (AC-A-1).
 *
 * The repairs are computed from the UNFILTERED report's findings, even when
 * `--min-severity` hid some: a demotion's repair depends on the finding that
 * RAISED it, and an output filter is a presentation choice that must not change
 * what remedy is offered. Getting this backwards would make `--min-severity error`
 * silently strip the repairs off every info-tier demotion — the exact demotions an
 * agent most needs a command for.
 */
const withRepairs = (
  demotions: readonly CoverageDemotion[],
  findings: readonly CheckFinding[],
  excluded: readonly Exclusion[],
  input: typeof CheckInput.Type,
  path: string,
): readonly RepairableDemotion[] => {
  const exclusionsById = new Map(excluded.map((e) => [e.id, e]))
  return demotions.map((demotion) => {
    const repair = repairForDemotion(demotion, {
      exclusionsById,
      findings,
      docPath: path,
      ...(input.solverBudgetMs > 0 ? { solverBudgetMs: input.solverBudgetMs } : {}),
    })
    // An empty repair is OMITTED, not emitted as two empty arrays — the same rule
    // the error envelope follows, and for the same reason: "there is a repair, it is
    // nothing" is a worse signal than "no mechanical fix exists".
    const hasRepair = repair.ops.length > 0 || repair.commands.length > 0
    return hasRepair ? { ...demotion, repair } : demotion
  })
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * `check` — run every tier and report findings, coverage, and the verdict.
 *
 * Exit codes come from the kernel's contract, computed from the ENVELOPE rather
 * than returned by this handler: an error-severity finding in `data.findings` maps
 * to 1, a tripped `data.strictGate` with no error finding maps to 3, and a clean
 * run maps to 0. That is the donor's semantics exactly, and it lands for free
 * because `exitCodeForEnvelope` already reads both fields structurally.
 */
export const checkOp = defineOperation({
  name: 'check',
  summary:
    'Check a requirements document for contradictions, subsumption, vacuity, and coverage gaps',
  type: 'check',
  input: CheckInput,
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)

      yield* validate(input, path)

      const loaded = yield* store.load(path)

      // Yielding `boot` is what actually starts the WASM module, and it happens
      // HERE — after validation and after the document loaded — so a usage error or
      // a missing document never pays the ~200-1000ms init. This is also the call
      // that primes the transplanted tier's memo, which is why `runCheck` below can
      // reach Z3 through the donor's unchanged `getContext` with the Layer-owned
      // instance. Not merely reaching the service: a provided Layer is BUILT
      // eagerly on beta.102 (probed), so reaching it proves nothing; yielding the
      // cached boot is the operative step.
      yield* (yield* SolverService).boot
      const donorDoc = toDonorDoc(loaded.document)

      const full = yield* Effect.tryPromise({
        try: () => runCheck(donorDoc, toCheckOptions(input)),
        catch: (cause) =>
          // The tier's own typed failures (a `SolverBudgetExceededError` escaping
          // `findNeedsReview` to a direct caller) and any genuine defect both land
          // here. `ERR_SOLVER_INCONCLUSIVE` is the donor's catch-all code for a
          // check that could not complete, and it is the honest one: the run
          // reached no verdict, which is different from both "the spec is bad" and
          // "the tool is misconfigured".
          new ErrSolverInconclusive({
            error: `The check did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
            suggestions: [
              'Raise --solver-budget-ms, or lower --timeout-ms so individual solvers give up sooner.',
              'If --temporal-bound is set, lower it — the temporal encoding is superlinear in the bound.',
              `Run \`symspec list ${path}\` to see how large the document is.`,
            ],
            repair: {
              ops: [],
              commands: [`symspec check ${path} --solver-budget-ms 30000`],
            },
          }),
      })

      // Output shaping is applied AFTER the repairs are computed from the full
      // report, so a filter cannot strip a remedy. Presentation only: it never
      // touches `counts`, so the exit code is identical filtered or not.
      const shaped =
        input.minSeverity !== 'info' || input.findingsOnly
          ? filterReport(full, {
              minSeverity: input.minSeverity satisfies CheckSeverity,
              ...(input.findingsOnly ? { findingsOnly: true } : {}),
            })
          : full

      const payload: CheckPayload = {
        ...shaped,
        coverage: {
          ...shaped.coverage,
          demotions: withRepairs(
            full.coverage.demotions,
            full.findings,
            full.excluded,
            input,
            path,
          ),
        },
        progress: progressOf(full),
        path,
        diagnostics: loaded.diagnostics,
      }

      return ok('check', payload)
    }),
})
