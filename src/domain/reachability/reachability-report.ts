/**
 * PROJECTING A REACHABILITY RUN ONTO FINDINGS AND DEMOTIONS.
 *
 * The tier (`./reachability.ts`) answers questions about a state model. This module
 * turns those answers into the two things `check` publishes: `findings[]` entries an
 * agent branches on, and `coverage.demotions[]` entries that keep `verified` honest.
 *
 * Kept separate from the tier for a reason that is about testability rather than tidiness:
 * the tier needs a live WASM solver, and every rule in THIS file is a pure function of a
 * `ReachabilityReport`. So the wording of a demotion, the shape of a repair, and the
 * decision about what demotes can all be asserted without booting Z3 — which is what
 * makes it affordable to test them exhaustively.
 *
 * ## The demotion-only doctrine, applied
 *
 * This tier may DEMOTE `verified` and may never promote it. Concretely: a `PROVED`
 * verdict adds an info finding and NO demotion (it is the absence of a demotion that
 * lets `verified` stay true), while every other outcome — under-hypotheses, unknown,
 * not-checked — adds one. There is no path here that removes a demotion another tier
 * raised, and that asymmetry is what makes "silence is not a certificate" true of the
 * reachability tier too.
 *
 * ## Evidence names REQUIREMENTS, not internal rule names
 *
 * Every trace step and every hypothesis is rendered with the requirement's own stable
 * key where it has one (donor V29's groundwork). A trace that read
 * `sys__lock__resp__grant` would be technically complete and practically useless; one
 * that reads `init -> TX-A1 -> TX-A1 -> TX-C1` is a sentence about the author's own
 * document.
 */

import type { Repair } from '../../ports/repair.ts'
import type { DocumentOp } from '../requirements/ops.ts'
import type { ConstraintResult, ReachabilityReport } from './reachability.ts'
import type { ReachabilityFndCode } from './reachability-codes.ts'

/**
 * One finding this module produces.
 *
 * Structurally the donor's `CheckFinding` minus the `tier` field, which the caller
 * stamps: `check` owns the `CheckTier` union and this module must not widen it. The
 * `evidence` is deliberately a plain open record rather than the donor's `Evidence`
 * type — the donor's shape is an atom table plus an unsat core, and a reachability
 * invariant or trace is neither, so reusing it would mean either lying about the field's
 * meaning or editing a transplanted file.
 */
export interface ReachabilityFinding {
  readonly code: ReachabilityFndCode
  readonly severity: 'error' | 'warn' | 'info'
  readonly requirementIds: readonly string[]
  readonly message: string
  /** The reachability evidence: an invariant, a trace, or the hypotheses relied upon. */
  readonly evidence?: Readonly<Record<string, unknown>>
  /** The runnable remedy, where one exists. */
  readonly repair?: Repair
}

/** One demotion this module produces — the donor's `CoverageDemotion` shape plus the
 * v5 `repair`, so `check` can splice these into `coverage.demotions[]` directly. */
export interface ReachabilityDemotion {
  readonly reason: string
  readonly requirementIds: readonly string[]
  readonly action: string
  readonly repair?: Repair
}

/** The whole projection. */
export interface ReachabilityProjection {
  readonly findings: readonly ReachabilityFinding[]
  readonly demotions: readonly ReachabilityDemotion[]
}

/**
 * The demotion reasons this tier adds, as a closed list.
 *
 * Enumerated so `check`'s repair mapping can be exhaustive over them by test, the same
 * discipline `FOLD_ERROR_CODES` uses for the mutation fold. Prefixed `reachability-` so
 * they cannot collide with the donor's eight, which is a real risk: the donor's union is
 * a string literal type and a duplicate reason would silently merge two different
 * remedies under one name.
 */
export const REACHABILITY_DEMOTION_REASONS = [
  'reachability-not-checked',
  'reachability-frame-relied-upon',
  'reachability-budget-exhausted',
  'reachability-undecidable',
  // APPENDED at the HARDENING wave. Its own reason rather than reusing
  // `reachability-undecidable`, because the remedies are opposite: undecidable says "bound
  // the model", vacuous-initial says "the model admits NO states, fix the initial
  // predicate". Collapsing them would send an agent to add bounds to a document whose
  // bounds are already the problem.
  'reachability-vacuous-initial-state',
] as const

export type ReachabilityDemotionReason = (typeof REACHABILITY_DEMOTION_REASONS)[number]

/** Render a trace as an arrow-joined path, which is how a human reads a counterexample. */
const renderTrace = (result: ConstraintResult): string => {
  const steps = result.trace?.steps ?? []
  if (steps.length === 0) return '(the solver did not return a readable trace)'
  return steps.map((s) => s.rule).join(' -> ')
}

/**
 * The command that supplies what a not-checked run is missing.
 *
 * Built from the report rather than hardcoded, because the missing thing differs: a
 * document with no variables needs `state`, a document with variables but no constraints
 * needs `classify`. Naming the wrong one would send an agent to the wrong command with
 * full confidence — the failure mode the donor's `<blocking-code>` placeholder had.
 */
const notCheckedRepair = (report: ReachabilityReport, docPath: string): Repair => {
  if (report.variables === 0) {
    return {
      ops: [{ op: 'state', name: '<variable>', type: 'bool' } satisfies DocumentOp],
      commands: [`symspec state <variable> --type bool ${docPath}`, `symspec check ${docPath}`],
    }
  }
  return {
    ops: [
      {
        op: 'classify',
        ref: '<requirement>',
        kind: 'constraint',
        expression: '<predicate over declared variables>',
      } satisfies DocumentOp,
    ],
    commands: [
      `symspec list ${docPath}`,
      `symspec classify <requirement> --kind constraint --expression "<predicate>" ${docPath}`,
      `symspec check ${docPath}`,
    ],
  }
}

/**
 * Why the tier did not fully cover this document, as prose — or `undefined` when it did.
 *
 * ONE function with an ordered set of causes rather than a finding per cause, because
 * they are not independent: a document with no state model also has no constraints and
 * no transitions, and emitting three disclosures for one omission is noise that trains a
 * reader to skip them. The FIRST applicable cause is the actionable one.
 */
const notCheckedReason = (report: ReachabilityReport): string | undefined => {
  if (report.variables === 0) {
    return (
      'no state model is committed, so no unbounded reachability question was asked. `check` ' +
      'cannot tell whether a requirement can be violated over all reachable states until the ' +
      'state variables are declared and the responses that touch them are classified'
    )
  }
  if (report.results.length === 0) {
    return (
      `${report.variables} state variable(s) are declared but NO requirement carries a ` +
      'constraint, so there is no property to prove. The state model describes a state space ' +
      'nothing asserts anything about'
    )
  }
  if (report.emptyTransitionRelation) {
    return (
      'the state model admits NO transitions — no requirement is classified as an `effect` — so ' +
      'the only reachable state is the initial one. An invariant that holds there holds almost ' +
      'vacuously, and is not evidence about a running system'
    )
  }
  if (report.skipped.length > 0) {
    return `${report.skipped.length} classified requirement(s) could not be read: ${report.skipped
      .map((s) => `${s.label} — ${s.reason}`)
      .join('; ')}`
  }
  return undefined
}

/**
 * Project a finished run onto findings and demotions.
 *
 * `docPath` is threaded in only so every command is copy-pasteable as-is — the same
 * reason `RepairContext` carries it. Nothing here reads the filesystem.
 */
export const projectReachability = (
  report: ReachabilityReport,
  docPath: string,
): ReachabilityProjection => {
  const findings: ReachabilityFinding[] = []
  const demotions: ReachabilityDemotion[] = []

  // --- SANITY GATE #1, PROJECTED --------------------------------------------
  //
  // FIRST, and it REPLACES the per-constraint projection rather than joining it. On a
  // vacuous model the tier issued no query and every result is `UNKNOWN`, so running the
  // normal loop would emit N info-severity "the solver did not decide" findings whose
  // stated remedies (raise the budget / bound the domains) are both WRONG — the solver was
  // never asked, and the model admits no states. One error-severity finding naming the
  // actual contradiction, plus one demotion per constraint, is the honest projection.
  if (report.vacuousInitialState) {
    const ids = report.results.map((r) => r.requirementId)
    const quoted =
      report.initialPredicates.length > 0
        ? report.initialPredicates.join('; ')
        : '(the declared variable ranges alone are contradictory)'
    findings.push({
      code: 'FND_REACHABILITY_VACUOUS_INITIAL',
      // ERROR, and the one non-`VIOLATED` error in the family. It earns that because it
      // does not merely fail to prove — it MASKS proven violations: measured, adding a
      // contradictory initial predicate to a document with a real reachable violation
      // turned the error-severity finding into "PROVED with nothing assumed" and flipped
      // the exit code from 1 to 0. Reporting that at info severity would leave the exit
      // code lying in exactly the case that matters most.
      severity: 'error',
      requirementIds: ids,
      message:
        'The INITIAL STATE of this state model is UNSATISFIABLE, so the model has no initial ' +
        'state at all, NO state is reachable, and every constraint holds VACUOUSLY. Nothing is ' +
        `proven about anything. The predicates that cannot all hold at once: ${quoted}` +
        (report.initialPredicates.length > 0
          ? ' — conjoined with the declared variable ranges.'
          : '') +
        ' This is reported at ERROR severity rather than as a disclosure because a vacuous ' +
        'model MASKS proven defects: with a satisfiable initial predicate this same document ' +
        'may carry reachable violations, and the vacuous run reports them as proofs. Note the ' +
        'independent certificate check cannot catch this — an unsatisfiable initial state makes ' +
        'the inferred invariant `false`, which discharges all three obligations validly.',
      evidence: {
        vacuousInitialState: true,
        initialPredicates: [...report.initialPredicates],
        constraintsAffected: report.results.length,
      },
      repair: {
        // NO ops. Which predicate to change, and to what, is a statement about the
        // system's intended starting state — content this must not invent. The reads that
        // show the author the contradiction are offered instead, together with the two
        // commands that edit either half.
        ops: [],
        commands: [
          `symspec list ${docPath}`,
          `symspec state-initial "<satisfiable predicate>" ${docPath}`,
          `symspec state-initial --clear ${docPath}`,
        ],
      },
    })
    // ONE DEMOTION PER CONSTRAINT, not one for the run. `verified` is false either way,
    // but a demotion carries `requirementIds`, and an agent reading the work list needs to
    // see that EVERY constraint is affected rather than inferring it from a run-scoped
    // note. On a model with no constraints at all this yields none, which is right: the
    // coverage disclosure below then carries the run-scoped statement.
    for (const result of report.results) {
      demotions.push({
        reason: 'reachability-vacuous-initial-state' satisfies ReachabilityDemotionReason,
        requirementIds: [result.requirementId],
        action:
          `${result.label} was NOT checked: the model's initial state is unsatisfiable ` +
          `(${quoted}), so no state is reachable and any answer would be vacuous. Fix the ` +
          'contradiction, then re-run — the constraint may well be violable once the model ' +
          'admits states. Raising a budget or bounding the domains will NOT help; the bounds ' +
          'may themselves be the contradiction.',
        repair: {
          ops: [],
          commands: [`symspec list ${docPath}`, `symspec check ${docPath}`],
        },
      })
    }
  }

  for (const result of report.vacuousInitialState ? [] : report.results) {
    const ids = [result.requirementId]
    switch (result.verdict) {
      case 'VIOLATED': {
        findings.push({
          code: 'FND_REACHABILITY_VIOLATED',
          // THE one error-severity outcome, and it earned that: reachable in BOTH
          // configurations, so it is not an artifact of assuming nothing.
          severity: 'error',
          requirementIds: ids,
          message:
            `${result.label}: a reachable state VIOLATES this constraint. The solver reached it ` +
            `by firing: ${renderTrace(result)}. Proven over all reachable states with no bound. ` +
            'Every step of that trace is a change some requirement makes — the run that produced ' +
            'it pins every variable no effect writes — so this is a genuine defect in the ' +
            'described system rather than an artifact of assuming nothing.',
          evidence: {
            trace: (result.trace?.steps ?? []).map((s) => s.rule),
            strictRun: result.strict,
            ...(result.framed !== undefined ? { framedRun: result.framed } : {}),
          },
          // NO ops. The fix is a judgment about what the document should SAY — weaken the
          // constraint or change the effect that reaches the bad state — and synthesizing
          // either would be inventing requirements content. The reads that inform the
          // judgment are offered instead.
          repair: {
            ops: [],
            commands: [`symspec show ${result.label} ${docPath}`, `symspec list ${docPath}`],
          },
        })
        break
      }

      case 'PROVED': {
        const verified = result.invariant?.certificateVerified === true
        if (!verified) {
          // THE ANSWER DID NOT RE-VERIFY. Reported as UNKNOWN, not as a weaker proof:
          // an answer this tool could not independently check is an answer it has no
          // basis to state. See `reachability-codes.ts` for why there is no
          // "proved-but-unchecked" code.
          findings.push({
            code: 'FND_REACHABILITY_UNKNOWN',
            severity: 'info',
            requirementIds: ids,
            message:
              `${result.label}: the solver reported this constraint unreachable, but the answer ` +
              'did NOT independently re-verify ' +
              `(${result.invariant?.failedObligation ?? 'the certificate check did not complete'}). ` +
              'No proof is claimed. This is a tool-level failure rather than a document defect — ' +
              'the contract is never to report proven unless the proof re-checks.',
            evidence: {
              failedObligation: result.invariant?.failedObligation ?? 'unknown',
              certificateVerified: false,
            },
          })
          demotions.push({
            reason: 'reachability-undecidable' satisfies ReachabilityDemotionReason,
            requirementIds: ids,
            action:
              `The reachability answer for ${result.label} did not re-verify, so it is not treated ` +
              'as a proof. Re-run to confirm it reproduces; if it does, the encoding or the ' +
              'solver is at fault and the model should be simplified until the certificate checks.',
            repair: { ops: [], commands: [`symspec check ${docPath}`] },
          })
          break
        }
        findings.push({
          code: 'FND_REACHABILITY_PROVED',
          severity: 'info',
          requirementIds: ids,
          message:
            `${result.label}: PROVED — no reachable state violates this constraint, over all ` +
            'reachable states with no bound and with nothing assumed beyond what the document ' +
            'states (frame-closed). The inferred invariant re-verified against three independent ' +
            'plain-SMT obligations.',
          evidence: {
            invariant: result.invariant?.invariant ?? '',
            certificateVerified: true,
            frameClosed: true,
          },
        })
        // NO DEMOTION. The absence is the mechanism by which `verified` may stay true.
        break
      }

      case 'PROVED_UNDER_HYPOTHESES': {
        const hypotheses = result.hypotheses ?? []
        // The required wording shape from the AC-2-5 decision doc: state the proof, then
        // state what it does NOT entail, in the same breath (Kind2's rhetorical move,
        // shipped by SPARK/GNATprove in its assumptions report). Never "P is
        // unreachable" — the claim is about the requirement-sanctioned transition
        // relation, and the sentence has to carry that.
        const relied = hypotheses
          .map(
            (h) =>
              `${h.variable} (written by ${h.writers.length > 0 ? h.writers.join(', ') : 'NO requirement'})`,
          )
          .join('; ')
        findings.push({
          code: 'FND_REACHABILITY_UNDER_HYPOTHESES',
          severity: 'info',
          requirementIds: ids,
          message:
            `${result.label}: PROVED_UNDER_HYPOTHESES — no reachable state violates this ` +
            'constraint, ASSUMING these variables change only when a requirement changes ' +
            `them: ${relied}. THE DOCUMENT DOES NOT STATE THAT. With nothing assumed the ` +
            'constraint IS violable, so this is a proof about the requirement-sanctioned ' +
            'transition relation and not about the system as specified — `verified` is demoted ' +
            'accordingly. A variable written by NO requirement is the sharpest case: nothing in ' +
            'the document keeps it from changing.',
          evidence: {
            invariant: result.invariant?.invariant ?? '',
            certificateVerified: result.invariant?.certificateVerified === true,
            hypotheses: hypotheses.map((h) => ({ variable: h.variable, writers: h.writers })),
            strictRun: result.strict,
            framedRun: result.framed ?? 'unreachable',
          },
        })
        demotions.push({
          reason: 'reachability-frame-relied-upon' satisfies ReachabilityDemotionReason,
          requirementIds: ids,
          action:
            `The proof for ${result.label} depends on the declared frame: ${relied}. Discharge it ` +
            'either by adding the requirements that make those variables genuinely written only ' +
            'where intended, or by declaring them `volatile` and accepting the weaker (honest) ' +
            'claim that the constraint can be violated.',
          repair: {
            ops: hypotheses.map(
              (h) =>
                ({
                  op: 'state',
                  name: h.variable,
                  // A concrete, applicable op: RELEASE the frame. That is the one
                  // mechanical discharge — the other (author more requirements) is
                  // content this must not invent.
                  type: 'bool',
                  frame: 'volatile',
                }) satisfies DocumentOp,
            ),
            commands: [`symspec show ${result.label} ${docPath}`, `symspec check ${docPath}`],
          },
        })
        break
      }

      case 'UNKNOWN': {
        const budget = result.unknownReason === 'budget-exhausted'
        findings.push({
          code: 'FND_REACHABILITY_UNKNOWN',
          severity: 'info',
          requirementIds: ids,
          message:
            `${result.label}: the solver did not decide whether this constraint can be violated ` +
            `(${
              budget
                ? `the ${report.timeoutMs}ms budget was exhausted after ${result.elapsedMs}ms`
                : `it gave up after ${result.elapsedMs}ms, well inside the ${report.timeoutMs}ms budget`
            }). Nothing is claimed either way. ` +
            (budget
              ? 'Raising the budget may resolve it.'
              : 'Raising the budget will NOT help — the model needs bounding instead.'),
          evidence: {
            // The DERIVED reason, never the solver's own string: a timed-out Spacer query
            // reports `reason_unknown === "ok"`, which would read as success.
            unknownReason: result.unknownReason ?? 'undecidable',
            elapsedMs: result.elapsedMs,
            timeoutMs: report.timeoutMs,
          },
        })
        demotions.push({
          reason: (budget
            ? 'reachability-budget-exhausted'
            : 'reachability-undecidable') satisfies ReachabilityDemotionReason,
          requirementIds: ids,
          action: budget
            ? `The reachability query for ${result.label} hit the ${report.timeoutMs}ms per-query ` +
              `budget. Raise it: \`symspec check ${docPath} --reachability-timeout-ms ${report.timeoutMs * 4}\`. ` +
              'That flag bounds THIS tier only, so the seven per-pair solvers keep their own ' +
              '`--timeout-ms`.'
            : `The reachability query for ${result.label} was undecidable within its budget, and ` +
              'more time will not help. Bound the integer domains in the state model ' +
              '(`symspec state <name> --type int --min <n> --max <n>`) so the state space is finite.',
          repair: budget
            ? {
                ops: [],
                // NAMES THE TIER'S OWN FLAG, not the shared `--timeout-ms` (G5). A
                // reachability query is one whole-model fixedpoint search; raising the shared
                // knob 4x to decide it would also hand every propositional solver 4x the rope,
                // which is a different and unasked-for change to the run.
                //
                // The doubling-and-then-some the budget-hint module uses: a bound that
                // failed at N rarely succeeds at N+ε, and each retry pays the full
                // truncated cost.
                commands: [
                  `symspec check ${docPath} --reachability-timeout-ms ${report.timeoutMs * 4}`,
                ],
              }
            : {
                ops: [],
                commands: [`symspec show ${result.label} ${docPath}`],
              },
        })
        break
      }
    }
  }

  // --- THE COVERAGE DISCLOSURE ------------------------------------------------
  // Emitted LAST so it reads as a statement about the run as a whole rather than about
  // any one requirement, and emitted at all because a question never asked looks exactly
  // like a question answered cleanly.
  const gap = notCheckedReason(report)
  if (gap !== undefined) {
    const ids = report.results.map((r) => r.requirementId)
    findings.push({
      code: 'FND_REACHABILITY_NOT_CHECKED',
      severity: 'info',
      requirementIds: ids,
      message:
        `The unbounded reachability tier did not fully cover this document: ${gap}. ` +
        'This is a COVERAGE DISCLOSURE, not a defect — but `verified` cannot account for a ' +
        'question that was never asked.',
      evidence: {
        variables: report.variables,
        effects: report.effects,
        constraintsChecked: report.results.length,
        skipped: report.skipped.map((s) => ({ label: s.label, reason: s.reason })),
        emptyTransitionRelation: report.emptyTransitionRelation,
      },
      repair: notCheckedRepair(report, docPath),
    })
    demotions.push({
      reason: 'reachability-not-checked' satisfies ReachabilityDemotionReason,
      requirementIds: ids,
      action: `Reachability was not fully checked: ${gap}. ${
        report.variables === 0
          ? `Declare the state variables (\`symspec state <name> --type bool|int|enum ${docPath}\`), then classify the responses that touch them (\`symspec classify <ref> --kind constraint --expression "<predicate>" ${docPath}\`).`
          : `Classify the responses that touch the declared variables: \`symspec classify <ref> --kind constraint --expression "<predicate>" ${docPath}\`.`
      }`,
      repair: notCheckedRepair(report, docPath),
    })
  }

  // --- THE FRAME-DRIFT DISCLOSURE -------------------------------------------
  // A variable declared `stable` and written by NO requirement is the exact V16 shape.
  // Prove-twice already prevents the false PROVED, so this is a DISCLOSURE rather than an
  // error (Quint would hard-error; a variable nothing writes is legitimately a monitored
  // input, and refusing it would reject a valid model). It rides on the not-checked code
  // rather than getting its own, because the remedy is the same shape: correct the
  // declaration.
  if (report.frameDrift.length > 0) {
    findings.push({
      code: 'FND_REACHABILITY_NOT_CHECKED',
      severity: 'info',
      requirementIds: [],
      message:
        `${report.frameDrift.length} variable(s) are declared \`frame: stable\` but are written by ` +
        `NO requirement: ${report.frameDrift.join(', ')}. Under the framed run they are pinned to ` +
        'their initial value forever, so any property about them holds only because of that ' +
        'declaration — which is the shape that turns a reachable state into an apparent proof. ' +
        'Prove-twice already prevents that from being reported as PROVED; this names the ' +
        'declaration so it can be corrected.',
      evidence: { frameDrift: [...report.frameDrift] },
      repair: {
        ops: report.frameDrift.map(
          (name) => ({ op: 'state', name, type: 'bool', frame: 'volatile' }) satisfies DocumentOp,
        ),
        commands: [`symspec check ${docPath}`],
      },
    })
  }

  return { findings, demotions }
}
