/**
 * The default `check` command pipeline — AC-6-8 (wiring) + AC-5-5 (no-Lean guard).
 *
 * This module wires ALL tiers into one report — the load-bearing contract that
 * `symspec check` returns structural, lint, and formal findings together:
 *
 *   Tier 0  structural   — `core/analyze.ts` (dangling refs, missing slots,
 *                          cycles, orphans), mapped to `FND_*` via the
 *                          single-source bridges in `formal/codes.ts`.
 *   Lint    free + GtWR  — exact duplicates via the solver orchestrator
 *                          (`solvers/index.ts`) and the ~24 GtWR T1 rules
 *                          (`lint/gtwr.ts`, per-statement + set-level).
 *   Formal  SMT (Tier S) — contradiction / subsumption / redundancy / vacuity
 *                          / completeness-heuristic / similar-ununified /
 *                          needs-review over the AC-3-7 gate's INCLUDED subset
 *                          only, each finding carrying AC-4-6 `evidence`.
 *
 * AC-5-5 invariant: nothing in this module (or its import graph) touches the
 * Lean tier. `certify` is a separate command; `check` succeeds on a system
 * with no Lean toolchain. The import list below is the proof — no
 * `../certify/*` import exists.
 *
 * ## Pipeline order is forced (AC-3-7, research-ears-incose.md §4)
 *
 * parse → lint → symbolize → solve. The {@link gateRequirements} partition
 * runs BEFORE the formal tier, and the formal tier only ever sees
 * `included` — an `error`-severity surface check excludes a statement from
 * symbolization, so the SMT layer never receives unsound input. Excluded
 * statements are reported in {@link CheckReport.excluded} (their blocking
 * findings already appear in the lint findings; they are not double-counted).
 *
 * ## Free-tier ambiguity findings are superseded by GtWR
 *
 * `runSolvers` also emits a 33-phrase weasel `Ambiguity` finding, but the GtWR
 * rules (AC-3-2: R7 vague / R8 escape / R9 open-ended …) cover the same
 * lexicons WITH stable codes, character spans, and rewrite suggestions.
 * Reporting both would duplicate every weasel hit, so this wiring keeps the
 * GtWR finding and drops the free-tier `Ambiguity` projection (the free-tier
 * detector still runs for its report side-effects).
 *
 * ## Stored negation view
 *
 * The parse tier extracts response negation as a flag (AC-2-4), and a stored
 * `Requirement` now persists it (`negated`, C1 fix): the schema flag is the
 * source of truth. So {@link toEncodable} threads the stored `negated` flag
 * straight into `EncodableRequirement.negated`. As a FALLBACK for
 * hand-authored documents that baked negation into the response text, it also
 * runs a conservative leading-negator scan ("not …", "never …", "do/does
 * not …") and strips it — but the schema flag wins: if `negated` is already
 * set, the stored text is trusted as-is (positive) and no scan is applied.
 * Either way the atomizer receives positive text + a polarity flag, restoring
 * the same atom-polarity discipline (same atom, opposite polarity) the parse
 * tier established.
 *
 * ## One atomizer, one requirement population, both tiers (AC-2-7)
 *
 * This module is where the propositional and bounded-temporal tiers are wired,
 * and it is therefore where they used to be wired DIFFERENTLY. Two fixes here:
 *
 *   - **One atomizer instance.** The `makeAtomize(glossary, antonyms)` closure
 *     (now owned by `formal/atomize.ts`) is built ONCE per run and handed to BOTH
 *     `encode` and `earsToTemporal`. The temporal tier previously received none —
 *     `earsToTemporal(req)` took no glossary or antonym parameter at all — so
 *     `--temporal` was structurally blind to every committed glossary alias and
 *     antonym pair. Passing the same instance is what makes `G(t → F grant_x)` vs
 *     `G(t → F ¬grant_x)` provable once `antonym add grant revoke` is committed.
 *   - **One requirement population.** Both tiers now score the AC-3-7 gate's
 *     INCLUDED subset. The temporal tier previously scored raw `reqs`, so the two
 *     error-severity tiers disagreed about which document they were checking, and
 *     `FND_EXCLUDED_FROM_FORMAL` ("the solver never saw this") was false about
 *     one of them. The full rationale is at the temporal call site in
 *     {@link runCheck}.
 */

import { analyze, type Finding } from '../core/analyze.ts'
import type { Doc } from '../core/doc.ts'
import { listRequirements } from '../core/doc.ts'
import { renderSentence } from '../core/render.ts'
import type { Requirement, Waiver } from '../core/schema.ts'
import { detectAmbiguity } from '../formal/ambiguity.ts'
import { type AntonymEntry, buildAntonymIndexWithDoc } from '../formal/antonyms.ts'
import { glossaryIndex, makeAtomize, normalize } from '../formal/atomize.ts'
import { getContext } from '../formal/backend.ts'
import { type SolverBounds, SolverBudget } from '../formal/budget.ts'
import { type FndCode, structuralKindToFndCode } from '../formal/codes.ts'
import { findContradictions } from '../formal/contradiction.ts'
import {
  excludedFromFormalFinding,
  noPairsCheckedFinding,
  relationalUncheckedFinding,
} from '../formal/coverage.ts'
import type { Embedder } from '../formal/embed.ts'
import { type EncodableRequirement, type EncodedRequirement, encode } from '../formal/encode.ts'
import { attachEvidenceToAll, type Evidence } from '../formal/finding.ts'
import { buildSimilarityGraph, type GraphRequirement } from '../formal/graph.ts'
import { checkCompleteness } from '../formal/incomplete.ts'
import { findNeedsReview, SolverBudgetExceededError } from '../formal/needs-review.ts'
import { extractNumericPredicates } from '../formal/numeric.ts'
import { findNumericContradictions } from '../formal/numeric-contradiction.ts'
import { findQuantityAliasCandidates } from '../formal/quantity-alias.ts'
import { findRelationalUnchecked } from '../formal/relational.ts'
import { findOppositionCandidates, findSimilarSemantic } from '../formal/semantic.ts'
import { findSimilarUnunified } from '../formal/similar.ts'
import { checkSubsumption } from '../formal/subsumption.ts'
import { findTemporalContradictions } from '../formal/temporal.ts'
import { earsToTemporal } from '../formal/temporal-patterns.ts'
import { checkVacuity } from '../formal/vacuity.ts'
import { checkGtWRules, checkGtWRulesSet } from '../lint/gtwr.ts'
import { type FormalTierResult, runSolvers } from '../solvers/index.ts'
import { asView, type ReqView } from '../solvers/types.ts'
import { type Exclusion, excludedIds, gateRequirements } from './gate.ts'

/** Which pipeline tier produced a finding. */
export type CheckTier = 'structural' | 'lint' | 'formal'

/** Shared severity scale across every tier (matches GtWR + FND semantics). */
export type CheckSeverity = 'error' | 'warn' | 'info'

/**
 * One normalized finding in the single `findings[]` AC-6-8 mandates. Every
 * tier's native shape projects into this: a stable `code` (`FND_*` or
 * `GTWR_*`), the severity the exit-code contract (AC-6-2b) keys on, the
 * requirement ids involved, and the optional per-tier extras (span +
 * suggestion from lint, `evidence` from the formal tier per AC-4-6).
 */
export interface CheckFinding {
  code: string
  severity: CheckSeverity
  tier: CheckTier
  requirementIds: string[]
  message: string
  /** Character span in the rendered sentence (lint tier only). */
  span?: [number, number]
  /** Mechanical rewrite suggestion (lint tier only). */
  suggestion?: string
  /** AC-4-6 machine-checkable evidence (formal tier only). */
  evidence?: Evidence
}

/** Options threaded through to the tiers. */
export interface CheckOptions {
  /** Pairwise lexical-similarity threshold override (free tier + AC-4-12). */
  similarityThreshold?: number
  /**
   * Per-solver timeout in ms (AC-4-7, `--timeout-ms`). Default 2000. Applied via
   * `solver.set('timeout', …)` to EVERY solver every tier constructs (AC-1-7):
   * contradiction, subsumption, vacuity, incomplete, numeric, temporal, and
   * needs-review. A solver that hits it returns `unknown`, which each tier
   * already handles conservatively, so the timeout can only withhold a finding.
   */
  timeoutMs?: number
  /**
   * Whole-run solver budget in ms (`--solver-budget-ms`). A wall-clock deadline
   * spanning EVERY solver tier (AC-1-7), not one tier: the pipeline builds one
   * {@link SolverBudget} and each tier consults it before each unit of work.
   *
   * A tier that stops early records a truncation, which becomes a
   * `solver-budget-exhausted` {@link CoverageDemotion} — so a truncated run can
   * never report `verified: true`. The stricter `ERR_SOLVER_TIMEOUT` abort stays
   * exactly where AC-4-7 put it: `findNeedsReview` throwing when the budget dies
   * inside its own group loop.
   */
  solverBudgetMs?: number
  /**
   * Opt-in semantic paraphrase pass (AC-9-5, `--semantic`). When provided, an
   * embedder proposes `FND_SIMILAR_SEMANTIC` glossary merges for high-cosine
   * unmerged response pairs. Off by default so the base `check` path never
   * loads the embedding model. Propose-only — never a verdict.
   */
  semantic?: {
    embedder: Embedder
    /** Cosine threshold (default `DEFAULT_SEMANTIC_THRESHOLD`, `--semantic-threshold`). */
    threshold?: number
  }
  /**
   * Opt-in bounded temporal tier (AC-33-2, `--temporal`). When set, EARS
   * requirements map to LTL (Dwyer/FRET) and a bounded LTL→SMT check proves
   * temporal contradictions (FND_TEMPORAL_CONTRADICTION). Off by default. The
   * `bound` is the finite trace length (default 10); the tier is sound-for-UNSAT
   * (a `sat` result at the bound is not a consistency certificate).
   */
  temporal?: {
    /** Trace bound k for the bounded encoding (default 10). */
    bound?: number
  }
  /**
   * Strict coverage gate (wishlist #4, `--strict`). When true, an INCONCLUSIVE
   * run — one where the formal tier compared nothing across requirements
   * ({@link CheckReport.verified} is `false`) — escalates from a silent clean
   * exit to a gate failure ({@link CheckReport.strictGate} `'fail'` →
   * `EXIT_INCONCLUSIVE`). Off by default so the base contract is unchanged: an
   * agent must OPT IN to "I couldn't verify this is a build failure." Encodes the
   * manifest doctrine that silence is not a consistency certificate.
   */
  strict?: boolean
  /**
   * Strict unmatched-atom gate (wishlist #4, `--fail-on-unmatched <n>`). When
   * set, a run whose {@link ResidualRisk.unmatchedAtoms} strictly EXCEEDS this
   * threshold fails the gate ({@link CheckReport.strictGate} `'fail'`). An
   * unmatched atom (owned by exactly one requirement) can never form a candidate
   * pair, so it went uncompared; a high count means broad coverage holes.
   * Independent of {@link strict} — either gate tripping fails the run. `0` fails
   * on ANY unmatched atom.
   */
  failOnUnmatched?: number
}

/**
 * Rolled-up residual-risk summary (wishlist #5b): the one-glance surface of what
 * `check` did NOT verify. The tool's honest scope is "silence is not a
 * consistency certificate", and the residual risk lives in the info-tier
 * findings + counters that a careless reader skims past. This object hoists those
 * numbers to the top level so over-trusting silence is harder: when every count
 * is zero AND `pairsChecked > 0`, the run is genuinely clean; any nonzero count
 * (or `noPairsChecked`) names an axis the formal tier could not close.
 *
 * All counts are derived from the SAME kept (post-waiver) finding set the report
 * publishes, so a waived residual-risk finding correctly drops out of the summary
 * too — a reviewed baseline reads as lower residual risk, not silent neglect.
 */
export interface ResidualRisk {
  /**
   * Count of kept `FND_SIMILAR_UNUNIFIED` findings — response pairs that read as
   * near-synonyms but stayed on distinct atoms, so a real conflict between them
   * could hide (AC-4-12). Each is an unverified paraphrase pair.
   */
  similarUnunifiedPairs: number
  /**
   * Count of kept `FND_SIMILAR_SEMANTIC` findings — high-cosine paraphrase merge
   * proposals from the opt-in `--semantic` pass. 0 when `--semantic` is off.
   */
  semanticSuggestions: number
  /**
   * How many candidate pairs the formal tier evaluated (mirrors
   * {@link CheckReport.pairsChecked} for one-glance reading).
   */
  pairsChecked: number
  /**
   * True when {@link pairsChecked} is 0 — the formal tier compared nothing across
   * requirements. The boolean form so a reader does not have to interpret the
   * counter. Pairs with the `FND_NO_PAIRS_CHECKED` info finding.
   */
  noPairsChecked: boolean
  /**
   * How many requirements the AC-3-7 gate excluded, so the formal tier never saw
   * them (mirrors `excluded.length`). Their blocking findings appear in the lint
   * tier; this counter surfaces the coverage hole the exclusion left behind.
   */
  excludedRequirements: number
  /**
   * How many atoms appear in exactly ONE of the gate-included requirements — an
   * atom with no cross-requirement partner can never form a candidate pair, so it
   * went uncompared. Computed over the same encoded (included) atom roster the
   * formal tier built, so it costs nothing beyond a tally.
   */
  unmatchedAtoms: number
  /**
   * How many gate-included requirements share NO atom with any other included
   * requirement — vocabulary-disjoint islands the decide tier never actually
   * constrained against a peer. Mirrors `coverage.requirements[].participates`
   * for one-glance reading; any nonzero count demotes {@link CheckReport.verified}.
   */
  uncoveredRequirements: number
}

/** One requirement's participation row in {@link CoverageReport}. */
export interface CoverageRequirementRow {
  id: string
  /**
   * True when this requirement shares ≥1 atom with ≥1 OTHER gate-included
   * requirement — i.e. the SMT conjunction genuinely constrained it against a
   * peer. A non-participating requirement was never cross-compared, so its
   * conflicts are invisible no matter what the rest of the document proves.
   */
  participates: boolean
  /** This requirement's singleton atoms (atoms no other requirement references). */
  unmatchedAtoms: string[]
  /** Actionable next step when `participates` is false. */
  suggestion?: string
}

/** Why `verified` was demoted, with the concrete discharging action. */
export interface CoverageDemotion {
  reason:
    | 'uncovered-requirement'
    | 'open-opposition-candidate'
    | 'no-decide-tier-comparison'
    | 'semantic-tier-skipped'
    // A requirement was dropped from the formal tier by an error-severity
    // lint/parse finding, so the solver never saw it — `verified` cannot cover
    // it. Discharged by fixing the blocking finding (rephrase), NOT by waiving.
    | 'excluded-from-formal'
    // Same-system+same-trigger opposed numeric bounds whose labels differ only
    // by verb landed on distinct quantity keys and were never compared — a
    // possible single-quantity conflict went unexamined. Discharged by a
    // `glossary add` alias (or waiving if genuinely distinct quantities).
    | 'quantity-alias-candidate'
    // A shared trigger carries numeric bounds alongside unmatched atoms — the
    // shape where aggregate/conservation or cross-quantity relational conflicts
    // hide, which symspec's pairwise numeric tier does not attempt. An honest
    // "not attempted" caveat so `verified` never outruns what was compared.
    | 'relational-reasoning-not-attempted'
    // AC-1-7: the whole-run `--solver-budget-ms` deadline expired and at least
    // one solver tier stopped before finishing its units of work. The run did
    // NOT compare everything it would otherwise have compared, so it cannot
    // certify. One demotion per truncated tier, naming the unrun unit count.
    // Discharged by raising `--solver-budget-ms` (or shrinking the document),
    // never by waiving: a suppressed disclosure is not a completed comparison.
    | 'solver-budget-exhausted'
  requirementIds: string[]
  /** The exact command (or rewrite guidance) that discharges this demotion. */
  action: string
}

/**
 * Per-requirement coverage detail (adversarial-eval hardening): the structured
 * answer to "what exactly did the decide tier NOT verify, and what do I do
 * about it?". This is the driving surface of the agent iteration loop —
 * `verified: false` is not a dead end but a work list: each {@link demotions}
 * entry names its discharging op (`antonym add` / `glossary add` / `waive` /
 * rewrite), and applying them then re-running `check` converges to
 * `verified: true` because every demotion reason is finitely dischargeable.
 *
 * Design principle (the demotion-only rule): propose-only findings and
 * coverage statistics may DEMOTE `verified` toward abstention, but can never
 * PROMOTE it — the dual of the propose/decide split. A fuzzy signal can raise
 * the alarm; only the deterministic decide tier can sound the all-clear.
 */
export interface CoverageReport {
  /** One row per gate-included requirement, ordered by id. */
  requirements: CoverageRequirementRow[]
  /** Count of kept (post-waiver) `FND_OPPOSITION_CANDIDATE` findings. */
  openOppositionCandidates: number
  /** Every reason `verified` is false, empty exactly when `verified` is true. */
  demotions: CoverageDemotion[]
  /**
   * How many requirements reached the formal (SMT) tier — the count the solver
   * actually encoded and could reason about. A first-class, one-glance answer to
   * "how much of the document did `check` formally see?" so a reader never has to
   * infer coverage from the absence of findings.
   */
  encoded: number
  /**
   * How many requirements the AC-3-7 gate excluded from the formal tier (an
   * error-severity lint/parse finding blocked their surface). Nonzero means
   * `verified` is demoted with an `excluded-from-formal` reason per requirement:
   * silence over a requirement the solver never saw is not a consistency
   * certificate. Fix the blocking finding (rephrase) to re-admit it; waiving the
   * finding suppresses the report line but does NOT restore formal coverage.
   */
  excluded: number
  /**
   * A plain-English interpretation of `pairsChecked`, so a low count is not
   * misread as "the tool barely looked". Requirements describing disjoint
   * transitions across different systems/triggers share no atom group and have
   * no same-context peer to conflict with — a singleton is not a coverage gap.
   */
  pairsCheckedNote: string
}

/** The complete `check` result the CLI wraps in its envelope (AC-6-2). */
export interface CheckReport {
  /** Every tier's findings, normalized and stably ordered. */
  findings: CheckFinding[]
  /** AC-3-7 exclusions: statements the formal tier never saw, with evidence. */
  excluded: Exclusion[]
  /** How many candidate pairs the formal tier evaluated (AC-8-3 counter). */
  pairsChecked: number
  /**
   * How many findings were dropped by a committed waiver (wishlist #3). A
   * waived finding is removed from {@link findings} AND from {@link counts}, so
   * the exit gate honors the waiver too; this counter keeps the suppression
   * visible so a reader can tell a reviewed baseline from silent neglect.
   */
  waived: number
  /** Findings tallied by severity — the exit-code contract's input. */
  counts: { error: number; warn: number; info: number }
  /** Rolled-up residual-risk summary (wishlist #5b) — what was NOT verified. */
  residualRisk: ResidualRisk
  /** Per-requirement coverage + the actionable demotion list (agent loop). */
  coverage: CoverageReport
  /**
   * First-class "did the formal tier actually verify anything across
   * requirements?" flag (wishlist #5, hardened after the Run 3 adversarial
   * eval). `true` requires ALL of:
   *   (a) PARTICIPATION — every gate-included requirement shares ≥1 atom with
   *       another included requirement, so the SMT conjunction genuinely
   *       constrained it against a peer. This kills the eval's winning shape:
   *       dense distractor vocabulary buying one checked pair while the
   *       conflicting pair's atoms stayed singletons;
   *   (b) NO OPEN OPPOSITION CANDIDATES — every kept `FND_OPPOSITION_CANDIDATE`
   *       has been triaged (committed via `antonym add`/`glossary add`, or
   *       waived). An untriaged candidate is a possible conflict the decide
   *       tier cannot see, so certifying over it would be dishonest;
   *   (c) a decide-tier cross-requirement comparison actually happened
   *       (pairsChecked > 0 or a non-propose-only cross-requirement finding);
   *   (d) when ≥2 requirements exist, the semantic tier ran (an embedder was
   *       supplied) — the opposition detector is part of the certification
   *       surface, so skipping it demotes.
   * A spec with <2 requirements is vacuously verified. Every demotion is
   * enumerated with its discharging action in {@link CheckReport.coverage}.
   *
   * Demotion-only invariant: propose-only findings and coverage stats can only
   * push this flag toward `false` (abstention), never toward `true`.
   */
  verified: boolean
  /**
   * Outcome of the opt-in strict coverage gate (wishlist #4). `undefined` when
   * neither {@link CheckOptions.strict} nor {@link CheckOptions.failOnUnmatched}
   * was requested (the gate did not run). `'pass'` when a requested gate ran and
   * held; `'fail'` when it tripped (inconclusive under `--strict`, or
   * `unmatchedAtoms` over the `--fail-on-unmatched` threshold). The exit-code
   * mapping reads this to return `EXIT_INCONCLUSIVE` for a `'fail'` with no
   * error-severity finding.
   */
  strictGate?: 'pass' | 'fail'
}

/**
 * The formal-tier finding codes whose analysis inherently spans ≥2 requirements
 * — the "cross-requirement conflict" family. Grounded in `formal/codes.ts`
 * (Appendix B): the contradiction/subsumption/redundancy propositional checks,
 * the numeric and bounded-temporal conflict tiers, and the two similar-pair
 * reporters. Used to suppress the contradictory `FND_NO_PAIRS_CHECKED` info
 * finding (see {@link runCheck}). Every genuine cross-requirement finding also
 * names ≥2 ids, so the id-count predicate is the primary signal; this set is the
 * belt-and-suspenders guard for a degenerate core that minimized to one id.
 */
const CROSS_REQUIREMENT_FND_CODES: ReadonlySet<string> = new Set<FndCode>([
  'FND_CONTRADICTION',
  'FND_SUBSUMPTION',
  'FND_REDUNDANCY',
  'FND_NUMERIC_CONTRADICTION',
  'FND_TEMPORAL_CONTRADICTION',
  'FND_SIMILAR_UNUNIFIED',
  'FND_SIMILAR_SEMANTIC',
])

/**
 * Propose-only info codes: they SPAN two requirements (so they suppress the
 * `FND_NO_PAIRS_CHECKED` "nothing was compared" disclaimer — a comparison DID
 * happen) but they are NOT verdicts — each is an agent-confirmable SUGGESTION,
 * not a proven consistency result. So they must NOT count toward
 * {@link CheckReport.verified} (#5): a fuzzy cosine proposal is the opposite of
 * a verification, and letting one flip `verified` to `true` would quiet the
 * "silence is not a consistency certificate" signal that the `--strict` gate
 * (#4) rests on. This is the distinction the adversarial review surfaced:
 * "compared" (disclaimer) and "verified" (the boolean/gate) are different
 * claims, and only a DECIDE-tier finding establishes the latter.
 */
const PROPOSE_ONLY_FND_CODES: ReadonlySet<string> = new Set<FndCode>([
  'FND_SIMILAR_UNUNIFIED',
  'FND_SIMILAR_SEMANTIC',
  'FND_OPPOSITION_CANDIDATE',
  'FND_MISSING_TRACE_LINK',
  'FND_DUPLICATE_CLUSTER',
  // Demotion-only coverage disclosures: each RAISES the alarm (demotes
  // `verified`) but is never itself a verdict, and — unlike the similar-pair
  // reporters above — must NOT suppress `FND_NO_PAIRS_CHECKED`, because each
  // signals that a comparison did NOT happen (a requirement went unencoded, two
  // bounds never met, or relational reasoning was skipped). So they are
  // deliberately excluded from CROSS_REQUIREMENT_FND_CODES.
  'FND_EXCLUDED_FROM_FORMAL',
  'FND_QUANTITY_ALIAS_CANDIDATE',
  'FND_RELATIONAL_UNCHECKED',
])

/**
 * The coverage-GAP subset of the propose-only codes: findings that span ≥2
 * requirement ids yet mean "a comparison did NOT happen" (a requirement was
 * excluded from the solver, two numeric bounds landed on different keys, or
 * aggregate/relational reasoning was not attempted). They must NOT suppress the
 * `FND_NO_PAIRS_CHECKED` disclaimer through the id-count clause — doing so would
 * let the report both claim nothing was compared (`residualRisk.noPairsChecked`)
 * and hide the disclaimer that says so. Distinct from the semantic-tier propose
 * codes (similar/opposition/missing-trace-link), which DO reflect a real
 * embedding comparison and legitimately suppress the disclaimer.
 */
const COVERAGE_GAP_FND_CODES: ReadonlySet<string> = new Set<FndCode>([
  'FND_EXCLUDED_FROM_FORMAL',
  'FND_QUANTITY_ALIAS_CANDIDATE',
  'FND_RELATIONAL_UNCHECKED',
])

/**
 * True when finding `f` is suppressed by waiver `w` (wishlist #3): the codes
 * match, and either the waiver is document-wide (no `requirementId`) or the
 * finding names that requirement. Scoped waivers only bite findings that
 * actually reference the scoped requirement.
 */
function isWaived(f: CheckFinding, w: Waiver): boolean {
  if (f.code !== w.code) return false
  if (w.requirementId === undefined) return true
  return f.requirementIds.includes(w.requirementId)
}

const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warn: 1, info: 2 }

/** Output-shaping options for {@link filterReport} (wishlist #5). */
export interface ReportFilter {
  /**
   * Drop findings below this severity from the emitted report. `error` keeps
   * only error-severity findings; `warn` keeps error+warn; `info` (default)
   * keeps everything. SAFE for the exit gate: because `error` is the top of the
   * severity order, a min-severity filter can never remove the error-severity
   * finding the gate keys on, so it only ever hides warn/info noise.
   */
  minSeverity?: CheckSeverity
  /**
   * Return only the findings array (plus the always-cheap `counts`/`waived`
   * tallies), dropping the heavier `excluded` table. The findings themselves —
   * and therefore the exit gate — are untouched.
   */
  findingsOnly?: boolean
}

/**
 * Apply the output-shaping filters (wishlist #5) to a finished report, upstream
 * of rendering. This is a presentation projection for a tight fix loop, NOT a
 * semantic change: it never removes an error-severity finding (min-severity
 * stops at `error`) and never alters `counts`, so `exitCodeForEnvelope` returns
 * the same code whether or not the caller filtered. `counts` continues to
 * reflect the FULL post-waiver finding set, so a `--min-severity error` view
 * still truthfully reports how many warn/info findings were hidden.
 */
export function filterReport(report: CheckReport, filter: ReportFilter): CheckReport {
  const min = filter.minSeverity ?? 'info'
  const threshold = SEVERITY_RANK[min]
  const findings =
    threshold === SEVERITY_RANK.info
      ? report.findings
      : report.findings.filter((f) => SEVERITY_RANK[f.severity] <= threshold)
  const next: CheckReport = { ...report, findings }
  if (filter.findingsOnly === true) next.excluded = []
  return next
}

/**
 * Marker retained for the AC-5-5 boundary test (`check-no-lean.test.ts`),
 * which predates this wiring and asserts the module loads without Lean.
 */
export const CheckResultSymbol = Symbol('CheckResult')

/** Legacy alias kept for the AC-5-5 guard's published shape. */
export interface CheckResult {
  findings: CheckFinding[]
}

/**
 * Resolve the antonym index a check run consults from the document's committed
 * pairs (#1). Normalizes both heads (so a pair authored as "Open"/"Shut" matches
 * the normalized leading verb the atomizer keys on) and folds them into the seed
 * table via the signed union-find. Defensive: if the committed pairs contain an
 * inconsistent polarity cycle (which the CLI rejects at write time, but a
 * hand-edited doc could still carry), fall back to the seed-only index rather
 * than throwing mid-check — a malformed antonym set must not take down the whole
 * linter. Returns `undefined` when there are no doc pairs so `makeAtomize` omits
 * the arg entirely and the default seed path runs unchanged.
 */
function docAntonymIndex(doc: Doc): ReadonlyMap<string, AntonymEntry> | undefined {
  const pairs = doc.antonyms ?? []
  if (pairs.length === 0) return undefined
  const normalized = pairs.map((p) => [normalize(p.a), normalize(p.b)] as const)
  try {
    return buildAntonymIndexWithDoc(normalized)
  } catch {
    return undefined
  }
}

/** Conservative leading-negator scan for stored response text (see header). */
const LEADING_NEGATOR = /^(?:do(?:es)?\s+not|not|never)\s+/i

/**
 * Project a stored requirement into the encodable view, resolving negation.
 *
 * The persisted `negated` flag (C1) is authoritative: when it is set, the
 * stored `systemResponse` is already the positive atom, so it passes through
 * untouched with `negated: true`. Only when the flag is absent/false do we
 * fall back to the conservative leading-negator text scan (for hand-authored
 * docs that baked "not …" into the response), stripping it to the positive
 * atom.
 */
export function toEncodable(view: ReqView): EncodableRequirement {
  if (view.negated === true) return { ...view, negated: true }
  const match = LEADING_NEGATOR.exec(view.systemResponse)
  if (match === null) return view
  return {
    ...view,
    systemResponse: view.systemResponse.slice(match[0].length),
    negated: true,
  }
}

/**
 * Encode the AC-3-7-INCLUDED requirements into the same guarded-implication
 * {@link EncodedRequirement} set the in-process formal tier asserts — the exact
 * input `--emit-smt2` (AC-4-8) exports and `--solver z3-bin`/`cvc5` (AC-4-9)
 * cross-checks. Reuses the pipeline's own gate + `toEncodable` + `pipelineAtomize`
 * so the artifact is a faithful export of what `check` would evaluate, never a
 * parallel encoding that could drift. Pure and Z3-free (no `getContext`, no
 * solver contact) — it only builds the plain-data formula AST.
 */
export function encodeIncluded(doc: Doc): EncodedRequirement[] {
  const requirements = listRequirements(doc)
  // Waiver-aware gate (waiver-vs-exclusion soundness): a waived blocking finding
  // re-admits its requirement to the formal tier, so `--emit-smt2` exports the
  // SAME included set `check` evaluates. Empty waivers ⇒ identical partition.
  const excluded = excludedIds(gateRequirements(requirements, doc.waivers ?? []))
  const atomize = makeAtomize(glossaryIndex(doc.glossary), docAntonymIndex(doc))
  return requirements
    .map(asView)
    .filter((r) => !excluded.has(r.id))
    .map(toEncodable)
    .map((r) => encode(r, atomize))
}

const STRUCTURAL_SEVERITY: Record<FndCode & `FND_${string}`, CheckSeverity> = {
  FND_DANGLING_REFERENCE: 'error',
  FND_MISSING_TRIGGER: 'error',
  FND_MISSING_PRECONDITION: 'error',
  FND_CYCLE: 'error',
  FND_ORPHAN: 'warn',
  FND_LEAF_UNVERIFIABLE: 'warn',
} as Record<FndCode, CheckSeverity>

/** The requirement ids a Tier-0 structural finding names, per finding kind. */
function structuralIds(finding: Finding): string[] {
  if (finding.kind === 'DanglingReference') return [finding.from]
  if (finding.kind === 'CycleDetected') return [...finding.nodes]
  return [finding.id]
}

function normalizeStructural(findings: Finding[]): CheckFinding[] {
  return findings.map((f) => {
    const code = structuralKindToFndCode[f.kind]
    return {
      code,
      severity: STRUCTURAL_SEVERITY[code] ?? 'error',
      tier: 'structural' as const,
      requirementIds: structuralIds(f),
      message: f.message,
    }
  })
}

function normalizeLint(requirements: readonly Requirement[]): CheckFinding[] {
  const withSentences = requirements.map((requirement) => ({
    requirement,
    sentence: requirement.sentence || renderSentence(requirement),
  }))

  const perStatement = withSentences.flatMap(({ requirement, sentence }) =>
    checkGtWRules(requirement, sentence).map((f) => ({
      code: f.code,
      severity: f.severity,
      tier: 'lint' as const,
      requirementIds: [requirement.id],
      message: f.message,
      span: f.span,
      ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    })),
  )

  const setLevel = checkGtWRulesSet(withSentences).map((f) => ({
    code: f.code,
    severity: f.severity,
    tier: 'lint' as const,
    requirementIds: f.requirementId !== undefined ? [f.requirementId] : [],
    message: f.message,
    span: f.span,
    ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
  }))

  return [...perStatement, ...setLevel]
}

/**
 * Between-tier whole-run deadline gate (AC-1-7). Returns `true` — and records the
 * skip on the budget's truncation ledger — when `budget` is present and already
 * expired, so the caller can skip a whole tier that would otherwise start work it
 * cannot finish. Returns `false` when there is no budget (unbounded run) or time
 * remains.
 *
 * Used for the two tiers whose internal loop is NOT cut mid-flight: the
 * contradiction tier (whose per-context-group discipline must not be
 * restructured) and the needs-review tier (which owns the `ERR_SOLVER_TIMEOUT`
 * boundary). Every recorded skip becomes a `solver-budget-exhausted` demotion, so
 * a skipped tier can never be mistaken for a clean one.
 */
function budgetSpent(budget: SolverBudget | undefined, tier: string, units: number): boolean {
  if (budget === undefined || !budget.expired()) return false
  budget.truncate(tier, units)
  return true
}

/** Stable output order: severity, then code, then first requirement id. */
function compareFindings(a: CheckFinding, b: CheckFinding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  const byCode = a.code.localeCompare(b.code)
  if (byCode !== 0) return byCode
  return (a.requirementIds[0] ?? '').localeCompare(b.requirementIds[0] ?? '')
}

/**
 * Run the full default `check` pipeline over a loaded document. Never touches
 * Lean (AC-5-5); never hands a gate-excluded statement to the SMT layer
 * (AC-3-7); every formal finding carries `evidence` (AC-4-6).
 */
export async function runCheck(doc: Doc, options: CheckOptions = {}): Promise<CheckReport> {
  const requirements = listRequirements(doc)

  // ---- Tier 0: structural ------------------------------------------------
  const findings: CheckFinding[] = normalizeStructural(analyze(doc))

  // ---- Lint: GtWR (per-statement + set-level) ----------------------------
  findings.push(...normalizeLint(requirements))

  // ---- Ambiguity family (AC-31): deterministic, always-on ----------------
  // Vague/quantifier/reference detectors + the structured contextual-ambiguity
  // punt. Pure over the requirement set (no solver, no model), so it runs on
  // the default `check` path like structural + lint.
  for (const f of detectAmbiguity(requirements.map(asView))) {
    findings.push({
      code: f.code,
      severity: f.severity,
      tier: 'lint',
      requirementIds: [...f.requirementIds],
      message: f.message,
      ...(f.span !== undefined ? { span: f.span } : {}),
    })
  }

  // ---- AC-3-7 gate: partition before symbolization -----------------------
  // Waiver-aware (waiver-vs-exclusion soundness): a committed waiver on a
  // formal-blocking finding re-admits its requirement to the formal tier, so
  // gateResult.excluded naturally shrinks and the FND_EXCLUDED_FROM_FORMAL loop
  // below no longer fires for a requirement the author took responsibility for.
  // Empty waivers ⇒ the exact pre-feature partition.
  const gateResult = gateRequirements(requirements, doc.waivers ?? [])
  const excluded = excludedIds(gateResult)

  // ---- Free tier + formal tier via the solver orchestrator ---------------
  // The formal runner captures its rich (FND-coded, evidence-carrying)
  // findings in this closure; it reports `findings: []` back to the
  // orchestrator so nothing is double-counted between the SolverReport
  // projection and the rich findings below.
  const formal: CheckFinding[] = []

  // Wishlist #5b: count atoms that appear in exactly ONE gate-included
  // requirement. Such an atom has no cross-requirement partner, so it can never
  // form a candidate pair and went uncompared — a residual-risk axis. Captured
  // from the SAME encoded roster the formal tier builds (so it is free), inside
  // the closure where `encoded` is in scope.
  let unmatchedAtoms = 0
  // Adversarial-eval hardening: the full atom→owners map escapes the closure so
  // the per-requirement participation coverage (and its demotion of `verified`)
  // is computed from the same roster.
  let coverageAtomOwners: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  let coverageIncludedIds: readonly string[] = []

  // AC-1-7: the ONE whole-run solver deadline every tier shares, plus its
  // truncation ledger. Constructed inside the formal runner (so the clock starts
  // at the first solver contact, not at document load — no solver knob governs
  // parse/lint time) and hoisted here so the demotion loop below can read the
  // ledger after `runSolvers` returns. `undefined` when no budget was requested,
  // in which case every tier runs unbounded exactly as before.
  let solverBudget: SolverBudget | undefined

  const report = await runSolvers(doc, {
    ...(options.similarityThreshold !== undefined
      ? { similarityThreshold: options.similarityThreshold }
      : {}),
    formal: async ({ reqs, pairs }): Promise<FormalTierResult> => {
      const included = reqs.filter((r) => !excluded.has(r.id))
      const includedIdSet = new Set(included.map((r) => r.id))
      const encodable = included.map(toEncodable)

      const timeoutMs = options.timeoutMs ?? 2000
      // AC-1-7: start the whole-run deadline here — the first line of the formal
      // runner — so it measures SOLVER time. Every tier below receives `bounds`
      // and therefore both knobs; `bounds.budget` is undefined when the caller
      // asked for no budget, which makes every tier's deadline check a no-op.
      solverBudget =
        options.solverBudgetMs !== undefined ? new SolverBudget(options.solverBudgetMs) : undefined
      const bounds: SolverBounds = {
        timeoutMs,
        ...(solverBudget !== undefined ? { budget: solverBudget } : {}),
      }
      // AC-9-3: canonicalize atoms through the committed glossary so
      // agent-confirmed paraphrases collide and paraphrased contradictions
      // become provable. Empty glossary ⇒ identical to a glossary-free run.
      // #1: fold the committed antonym pairs into the seed table so
      // agent-confirmed opposites (open/shut) collapse to one atom at opposite
      // polarity — the shape the contradiction tier proves. Empty ⇒ seed-only.
      const atomize = makeAtomize(glossaryIndex(doc.glossary), docAntonymIndex(doc))
      const contradictionOpts = { atomize, timeoutMs }

      // Whole-spec checks (contradiction / vacuity / completeness / review)
      // and pairwise checks (subsumption / redundancy) share one encoding.
      const ctx = await getContext('symspec-check')
      const encoded = encodable.map((r) => encode(r, atomize))
      const encodedById: ReadonlyMap<string, EncodedRequirement> = new Map(
        encoded.map((e) => [e.id, e]),
      )

      // Wishlist #5b: tally the spec-wide atom roster and count singletons —
      // atoms that appear in exactly one included requirement. An atom counts
      // once per requirement (a requirement that repeats an atom across slots
      // does not make it "matched"); an atom is "matched" only when ≥2 distinct
      // requirements reference it. Deterministic, no solver contact.
      const atomOwners = new Map<string, Set<string>>()
      for (const e of encoded) {
        for (const row of e.atoms) {
          let owners = atomOwners.get(row.atom)
          if (owners === undefined) {
            owners = new Set<string>()
            atomOwners.set(row.atom, owners)
          }
          owners.add(e.id)
        }
      }
      for (const owners of atomOwners.values()) {
        if (owners.size === 1) unmatchedAtoms += 1
      }
      coverageAtomOwners = atomOwners
      coverageIncludedIds = included.map((r) => r.id)

      const includedPairs = pairs.filter((p) => includedIdSet.has(p.a) && includedIdSet.has(p.b))

      // AC-1-7: the contradiction tier already bounds each per-group solver
      // internally (`contradiction.ts` sets `timeout` per group), so the
      // whole-run deadline is enforced BETWEEN tiers here — the tier is skipped
      // wholesale if the budget is already spent, and the skip is recorded so it
      // demotes `verified`. Deliberately NOT a mid-loop cut inside
      // `findContradictions`: its per-context-group discipline is load-bearing
      // (the reachability lesson), and this task must not restructure it.
      const contradictions = budgetSpent(solverBudget, 'contradiction', encodable.length)
        ? []
        : await findContradictions(encodable, contradictionOpts)
      const subsumptions = await checkSubsumption(ctx, encodedById, includedPairs, bounds)
      const vacuities = await checkVacuity(ctx, encoded, bounds)
      const incompletes = await checkCompleteness(ctx, encoded, bounds)
      const similar = findSimilarUnunified(
        encodable,
        options.similarityThreshold !== undefined
          ? { similarityThreshold: options.similarityThreshold }
          : {},
      )
      // AC-4-7 boundary, preserved exactly. `findNeedsReview` is the ONE tier
      // allowed to raise `ERR_SOLVER_TIMEOUT`, and it does so when the budget
      // dies inside its own group loop. So it is handed the REMAINING budget
      // rather than the original figure — otherwise a run that had already burned
      // the budget in subsumption would hand this tier a full fresh budget and
      // the documented whole-run abort would be unreachable.
      //
      // When the budget is ALREADY spent before this tier starts, the tier is
      // skipped and the skip recorded, rather than entered so it can throw: a
      // reportable demotion beats an error envelope with no report, and
      // `verified` is false either way. The throw stays reachable for the
      // budget-expires-mid-loop case, which is precisely the whole-run boundary
      // AC-4-7 defines.
      //
      // AC-1-7 follow-up. Handing this tier the remaining budget made the
      // pipeline's failure mode NON-MONOTONE in the budget, which was verified
      // live on a 100-requirement document: budgets of 1/100/500/1000/1500ms and
      // 3000ms+ all returned a usable report with honest truncation demotions,
      // but 2000ms — the band where the budget survives subsumption and then
      // dies inside this tier's group loop — produced `ERR_SOLVER_TIMEOUT`,
      // exit 2, and NO report at all. A tighter budget failing more softly than
      // a looser one is incoherent, and it hands an agent an error envelope on
      // exactly the runs where a partial verdict is most useful.
      //
      // So the pipeline treats a mid-loop budget death the same way it treats
      // every other tier's truncation: record it and demote. The throw itself is
      // preserved (its contract is directly tested in
      // `formal/__tests__/needs-review.test.ts`) and remains the behavior for a
      // direct library caller of `findNeedsReview`; only the PIPELINE, which has
      // a report to return and a demotion channel to return it through, absorbs
      // it. `verified` is false either way, so this trades no soundness.
      let review: Awaited<ReturnType<typeof findNeedsReview>> = []
      if (!budgetSpent(solverBudget, 'needs-review', encodable.length)) {
        try {
          review = await findNeedsReview(encodable, {
            atomize,
            timeoutMs,
            ...(solverBudget !== undefined
              ? { solverBudgetMs: Math.max(0, solverBudget.remainingMs()) }
              : {}),
          })
        } catch (e) {
          if (!(e instanceof SolverBudgetExceededError)) throw e
          // Unrun group count is unknown from here; record the tier as truncated
          // so the demotion fires and the coverage report stays honest.
          solverBudget?.truncate('needs-review', encodable.length)
        }
      }

      // AC-30-3: numeric/arithmetic conflict tier. Extract per-slot numeric
      // predicates (deterministic, unit-normalized, per-system quantity keys)
      // and prove any same-quantity set jointly unsatisfiable over LIA/LRA.
      // Runs over ALL requirements, NOT the gate-included subset: numeric
      // conflict detection is independent of the propositional-encoding
      // soundness the AC-3-7 gate protects, so a lint-blocking finding (e.g. a
      // missing-units warning on a bare number) must not hide a real numeric
      // contradiction. Reuses the shared context.
      // #3: reuse the committed synonym glossary as a quantity-alias map so two
      // phrasings of one physical quantity ("keep valid for" vs "expire after")
      // key to a single quantity and the LIA/LRA solver compares them. Empty
      // glossary ⇒ identical to the pre-feature numeric path.
      const quantityAliases = glossaryIndex(doc.glossary)
      const numericReqPreds = reqs.map((r) => ({
        id: r.id,
        predicates: [
          ...extractNumericPredicates(r.systemResponse, r.systemName, quantityAliases),
          ...(r.trigger !== undefined
            ? extractNumericPredicates(r.trigger, r.systemName, quantityAliases)
            : []),
          ...(r.preCondition !== undefined
            ? extractNumericPredicates(r.preCondition, r.systemName, quantityAliases)
            : []),
        ],
      }))
      const numericContradictions = await findNumericContradictions(ctx, numericReqPreds, bounds)

      // Issue #2 (reproducer a): the numeric tier keys a quantity off the noun
      // phrase before the comparator, so ONE physical quantity described with
      // two different verbs ("complete the infusion within ≤30 min" vs "run the
      // infusion for ≥60 min") splits into two keys and the joint bound is never
      // compared. Propose-only: flag same-system+same-trigger opposed bounds
      // whose labels share an object but differ in verb, suggesting a `glossary
      // add` alias that routes both to one quantity key (DECIDE tier). Demotes
      // `verified`; never a verdict. Reuses the predicates already extracted
      // (with the committed alias map applied), so a pair already unified via
      // the glossary no longer differs and the candidate stops firing.
      const predsById = new Map(numericReqPreds.map((p) => [p.id, p.predicates]))
      const quantityAliasCandidates = findQuantityAliasCandidates(
        reqs.map((r) => ({
          id: r.id,
          systemName: r.systemName,
          triggerKey: r.trigger !== undefined ? normalize(r.trigger) : '',
          predicates: predsById.get(r.id) ?? [],
        })),
      )

      // Issue #2 (reproducer b + aggregate/relational families): detect the
      // STRUCTURAL SHAPE where aggregate/conservation or emergent-structural
      // (odd-cycle 2-coloring, pigeonhole, transitivity) conflicts hide — bounds
      // or inter-entity relational language under one shared trigger that the
      // pairwise same-quantity numeric tier does not attempt. Demotion-only: it
      // declines to certify (DEMOTES `verified`), never asserts a conflict, so
      // it cannot manufacture a false one. Per-requirement `hasUnmatchedAtom` is
      // read from the atom-owner roster built above (owners.size === 1).
      const singletonOwnerIds = new Set<string>()
      for (const [, owners] of atomOwners) {
        if (owners.size === 1) for (const id of owners) singletonOwnerIds.add(id)
      }
      const relationalUnchecked = findRelationalUnchecked(
        reqs.map((r) => ({
          id: r.id,
          systemName: r.systemName,
          triggerKey: r.trigger !== undefined ? normalize(r.trigger) : '',
          responseText: r.systemResponse,
          hasNumericBound: (predsById.get(r.id) ?? []).length > 0,
          hasUnmatchedAtom: singletonOwnerIds.has(r.id),
        })),
      )

      // AC-33-2: opt-in bounded temporal tier. Map each requirement to LTL
      // (Dwyer/FRET) and prove temporal contradictions via bounded LTL→SMT on
      // the shared Z3-WASM context. Sound-for-UNSAT.
      //
      // ## Which requirements the temporal tier scores (AC-2-7 divergence 8)
      //
      // It scores `encodable` — the AC-3-7 gate's INCLUDED subset, threaded
      // through `toEncodable`. It used to score raw `reqs`, so the two tiers
      // reasoned over DIFFERENT requirement populations while both reported at
      // error severity. That is resolved deliberately, in favour of the gated
      // set, for three reasons:
      //
      //   1. **The gate exists because unsound input makes a solver verdict
      //      unsound, and that argument is tier-agnostic.** AC-3-7's forced
      //      pipeline order (parse → lint → symbolize → solve) rests on "a
      //      statement that fails a surface check has no trustworthy slot set".
      //      A requirement whose sentence does not match any EARS pattern has no
      //      trustworthy TRIGGER either — and the temporal tier's whole shape is
      //      `G(trigger → …)`. Feeding it a slot the lint tier just declared
      //      untrustworthy, and then reporting `FND_TEMPORAL_CONTRADICTION` at
      //      error severity on the strength of it, is the propose/decide rule
      //      inverted: the decide tier would be LOOSER about its input than the
      //      tier that gates it. `decide-tier-must-carry-every-guard-the-propose-
      //      tier-has` is the general form of that bug.
      //   2. **Nothing is silently lost, because the coverage hole is already
      //      disclosed and already demotes.** An excluded requirement produces
      //      `FND_EXCLUDED_FROM_FORMAL` plus an `excluded-from-formal` demotion
      //      per requirement, so `verified` cannot be true over it — for BOTH
      //      tiers now, with one disclosure covering both. Under the previous
      //      split, an excluded requirement was un-scored propositionally and
      //      scored temporally, so `FND_EXCLUDED_FROM_FORMAL` was literally
      //      false about the temporal tier: the solver HAD seen it.
      //   3. **It is the direction that cannot fabricate.** Scoring fewer
      //      requirements can only withhold an `unsat` (a false negative, the
      //      honest direction for a sound-for-UNSAT tier), and the gate is
      //      waiver-aware: `symspec waive add <blocking-code> --ref <id>`
      //      re-admits a requirement to BOTH tiers at once, which is a reviewed,
      //      reasoned discharge rather than a silent one.
      //
      // The numeric tier deliberately keeps scoring raw `reqs`, and that is not
      // an inconsistency: its soundness does not depend on the propositional
      // atomization the gate protects (a bare number with a missing-units warning
      // still carries a real, comparable bound), whereas the temporal tier is
      // built on exactly the atoms and slots the gate is about. That distinction
      // is already written down at the numeric tier's call site above.
      const temporalContradictions =
        options.temporal !== undefined
          ? await findTemporalContradictions(
              ctx,
              encodable.map((r) => ({ id: r.id, formula: earsToTemporal(r, atomize) })),
              options.temporal.bound ?? 10,
              bounds,
            )
          : []

      // AC-9-5: opt-in semantic paraphrase pass. Propose-only — emits
      // FND_SIMILAR_SEMANTIC info findings suggesting glossary merges for
      // high-cosine response pairs that atomize (incl. the glossary) did not
      // already unify. Runs over the SAME included set; never a verdict.
      const semantic =
        options.semantic !== undefined
          ? await findSimilarSemantic(included, options.semantic.embedder, {
              glossary: glossaryIndex(doc.glossary),
              ...(options.semantic.threshold !== undefined
                ? { threshold: options.semantic.threshold }
                : {}),
            })
          : []

      // #6: opt-in opposition-candidate proposals. Same embedder, propose-only —
      // emits FND_OPPOSITION_CANDIDATE for same-system responses that share an
      // object but differ on the leading verb and are not already unified as
      // antonyms, suggesting `symspec antonym add`. Cosine is only a
      // topical-relatedness floor; the structure is the signal. Never a verdict.
      const opposition =
        options.semantic !== undefined
          ? await findOppositionCandidates(included, options.semantic.embedder, {
              glossary: glossaryIndex(doc.glossary),
              ...(docAntonymIndex(doc) !== undefined
                ? { antonyms: docAntonymIndex(doc) as ReadonlyMap<string, AntonymEntry> }
                : {}),
            })
          : []

      // AC-32-2/4: always-on-when-semantic embedding graph. Builds a
      // deterministic kNN similarity graph over the INCLUDED requirements'
      // rendered sentences and proposes (info-only) missing trace links +
      // near-duplicate clusters. Reuses the same injected embedder as the
      // paraphrase pass; propose-only, never a verdict.
      const graph =
        options.semantic !== undefined
          ? await buildSimilarityGraph(
              included.map((r): GraphRequirement => {
                const full = doc.requirements[r.id]
                const linkedTo = full ? [...full.refines, ...full.derives, ...full.satisfies] : []
                return { id: r.id, text: r.sentence || r.systemResponse, linkedTo }
              }),
              options.semantic.embedder,
              options.semantic.threshold !== undefined
                ? { threshold: options.semantic.threshold }
                : {},
            )
          : []

      // AC-4-6: unsat-triggered findings carry the atom table + core.
      const withEvidence = attachEvidenceToAll(
        [...contradictions, ...subsumptions, ...vacuities],
        encodedById,
      )

      for (const f of withEvidence) {
        const requirementIds = f.code === 'FND_VACUITY' ? [f.requirementId] : [...f.requirementIds]
        formal.push({
          code: f.code,
          severity: f.severity,
          tier: 'formal',
          requirementIds,
          message: f.message,
          evidence: f.evidence,
        })
      }
      for (const f of [
        ...incompletes,
        ...similar,
        ...review,
        ...semantic,
        ...graph,
        ...opposition,
        ...quantityAliasCandidates,
      ]) {
        formal.push({
          code: f.code,
          severity: f.severity,
          tier: 'formal',
          requirementIds: [...f.requirementIds],
          message: f.message,
        })
      }

      // AC-30-3: numeric contradictions carry their own arithmetic-predicate
      // evidence (quantity + normalized comparators/values), distinct from the
      // atom-table evidence of the propositional checks.
      for (const f of numericContradictions) {
        formal.push({
          code: f.code,
          severity: f.severity,
          tier: 'formal',
          requirementIds: [...f.requirementIds],
          message: f.message,
          evidence: f.evidence,
        })
      }

      // AC-33-2: temporal contradictions carry bounded-check evidence.
      for (const f of temporalContradictions) {
        formal.push({
          code: f.code,
          severity: f.severity,
          tier: 'formal',
          requirementIds: [...f.requirementIds],
          message: f.message,
          evidence: f.evidence,
        })
      }

      // Issue #2: relational/aggregate blind-spot disclosures. Demotion-only
      // info findings that name the shared-trigger group whose aggregate or
      // cross-entity relation the pairwise numeric tier did not attempt.
      for (const f of relationalUnchecked) {
        const finding = relationalUncheckedFinding(f.requirementIds)
        formal.push({
          code: finding.code,
          severity: finding.severity,
          tier: 'formal',
          requirementIds: [...finding.requirementIds],
          message: finding.message,
        })
      }

      return { findings: [], pairsChecked: includedPairs.length }
    },
  })

  // Free-tier projections: exact duplicates keep their FND code; the
  // free-tier weasel `Ambiguity` findings are superseded by GtWR (header).
  for (const f of report.findings) {
    if (f.kind === 'ExactDuplicate') {
      findings.push({
        code: 'FND_EXACT_DUPLICATE',
        severity: 'error',
        tier: 'lint',
        requirementIds: [...f.ids],
        message: f.message,
      })
    }
  }

  findings.push(...formal)

  // Formal-exclusion disclosure: emit one loud FND_EXCLUDED_FROM_FORMAL info
  // finding per requirement the AC-3-7 gate dropped, so a coverage hole the
  // solver never saw is visible in findings[] — not merely a count buried in
  // residualRisk. Each also DEMOTES `verified` below. This is the fix for the
  // "0 contradictions, verified: true, but a third of the doc was never checked"
  // false-confidence trap (both feedback sources).
  for (const ex of gateResult.excluded) {
    const blockingCodes = ex.findings.map((f) => f.code)
    const finding = excludedFromFormalFinding(ex.id, ex.reason, blockingCodes)
    findings.push({
      code: finding.code,
      severity: finding.severity,
      // A gate-phase coverage disclosure, NOT a solver output: the requirement
      // was excluded at the AC-3-7 gate (structural boundary) before
      // symbolization, so it is tagged 'structural'. This keeps it distinct from
      // formal-tier (solver) findings — nothing the SMT layer reasoned about
      // names an excluded requirement, but this disclosure deliberately does.
      tier: 'structural',
      requirementIds: [...finding.requirementIds],
      message: finding.message,
    })
  }

  // Wishlist #6: a formal tier that compared zero PAIRS proved nothing via the
  // pairwise (subsumption/redundancy) route. Emit a loud info finding (only when
  // there were ≥2 requirements that COULD have been related) so the coverage
  // gap is visible in findings[] rather than only in the numeric pairsChecked
  // field.
  //
  // BUT suppress it when a genuine cross-requirement finding already fired
  // (item 4): `pairsChecked` counts ONLY the pairwise tier's candidate pairs,
  // while the contradiction / numeric / temporal / similar tiers reason across
  // ALL requirements independent of that pair filter. So a `--temporal` (or
  // numeric, or contradiction) run can prove an error across two requirements
  // while `pairsChecked === 0` — and emitting "no two requirements were compared
  // across requirements" alongside a proven cross-requirement error is a
  // contradictory signal. The disclaimer is only truthful when NOTHING
  // cross-requirement fired.
  //
  // Condition: suppress when any accumulated formal finding either names ≥2
  // requirement ids (the primary signal — every genuine cross-requirement
  // finding names the ≥2 ids its analysis spanned) OR carries one of the known
  // cross-requirement conflict codes (a backstop for a degenerate unsat core
  // that minimized down to a single id). Single-requirement findings
  // (ambiguity, GtWR lint, a lone vacuity/needs-review naming one id) do NOT
  // suppress it, so the disclosure still fires when truly nothing was compared
  // across requirements.
  // A cross-requirement finding of ANY kind (verdict OR propose-only proposal)
  // means a comparison DID happen, so the "nothing was compared" disclaimer must
  // not fire alongside it (coverage-disclaimer lesson).
  //
  // EXCEPTION (adversarial review): the coverage-GAP codes are the opposite —
  // each spans ≥2 ids yet signals a comparison did NOT happen (a requirement was
  // excluded from the solver, two bounds landed on different keys, or aggregate/
  // relational reasoning was skipped). If one of those suppressed the disclaimer
  // via the `length >= 2` clause, the report would claim (residualRisk.
  // noPairsChecked=true) that nothing was compared while omitting the finding
  // that says so — an internal contradiction. So they never count as "a
  // comparison happened". The semantic-tier propose codes (opposition / similar /
  // missing-trace-link) still DO suppress: those come from a real embedding
  // comparison of the pair.
  const crossRequirementFired = formal.some(
    (f) =>
      (f.requirementIds.length >= 2 && !COVERAGE_GAP_FND_CODES.has(f.code)) ||
      CROSS_REQUIREMENT_FND_CODES.has(f.code),
  )
  // Wishlist #6 disclaimer: emit the FND_NO_PAIRS_CHECKED info finding when the
  // pairwise tier checked nothing AND no cross-requirement finding (of any kind)
  // fired. A single-requirement finding (ambiguity, lint, lone vacuity) does not
  // suppress it, so the disclosure still fires when truly nothing was compared.
  const noPairsChecked =
    report.pairsChecked === 0 && requirements.length >= 2 && !crossRequirementFired
  if (noPairsChecked) {
    const coverage = noPairsCheckedFinding(requirements.map((r) => r.id))
    findings.push({
      code: coverage.code,
      severity: coverage.severity,
      tier: 'formal',
      requirementIds: [...coverage.requirementIds],
      message: coverage.message,
    })
  }

  // Wishlist #3: drop findings suppressed by a committed waiver BEFORE tallying,
  // so the exit-code gate honors the waiver too. Count what was dropped so the
  // report can surface a reviewed-baseline `waived` number. Runs BEFORE the
  // `verified` computation because a waived opposition candidate is a triaged
  // one — it must stop demoting (agent-loop convergence).
  const waivers = doc.waivers ?? []
  let waived = 0
  const kept = findings.filter((f) => {
    if (waivers.some((w) => isWaived(f, w))) {
      waived += 1
      return false
    }
    return true
  })
  kept.sort(compareFindings)

  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of kept) counts[f.severity] += 1

  // Wishlist #5, hardened after the Run 3 adversarial eval: `verified` is a
  // STRICTER claim than "something was compared" — it is "the decide tier
  // actually verified consistency across the WHOLE document". The eval's
  // winning shape was 10-12 requirements with dense shared guard vocabulary
  // buying one checked pair (verified=true under the old any-pair predicate)
  // while the genuinely conflicting responses sat on singleton atoms nobody
  // compared. The hardened predicate demotes on:
  //   - any gate-included requirement whose atoms are ALL singletons
  //     (participation — clause a);
  //   - any kept FND_OPPOSITION_CANDIDATE (untriaged possible conflict —
  //     clause b; waived candidates were triaged and do not demote);
  //   - no decide-tier cross-requirement comparison at all (clause c, the
  //     original predicate);
  //   - the semantic tier not running over a ≥2-requirement doc (clause d —
  //     the opposition detector is part of the certification surface).
  // Demotion-only invariant: propose-only findings and coverage stats can push
  // `verified` to false but NEVER to true — a fuzzy cosine proposal must not
  // quiet the "silence is not a consistency certificate" signal the `--strict`
  // gate rests on. Every demotion carries its discharging action so an agent
  // can iterate: apply the op (antonym add / glossary add / waive / rewrite),
  // re-run check, converge.
  const decideTierCrossReqFired = formal.some(
    (f) => f.requirementIds.length >= 2 && !PROPOSE_ONLY_FND_CODES.has(f.code),
  )
  const inconclusive =
    report.pairsChecked === 0 && requirements.length >= 2 && !decideTierCrossReqFired

  // A requirement participates when (a) it shares ≥1 atom with another
  // included requirement (the propositional conjunction constrained it), OR
  // (b) a decide-tier cross-requirement finding names it (the numeric/temporal
  // tiers compare requirements the propositional atom roster cannot see).
  const decideFindingParticipants = new Set<string>()
  for (const f of formal) {
    if (f.requirementIds.length >= 2 && !PROPOSE_ONLY_FND_CODES.has(f.code)) {
      for (const id of f.requirementIds) decideFindingParticipants.add(id)
    }
  }
  const coverageRows: CoverageRequirementRow[] = [...coverageIncludedIds]
    .sort()
    .map((id): CoverageRequirementRow => {
      const singletons: string[] = []
      let shares = decideFindingParticipants.has(id)
      for (const [atomName, owners] of coverageAtomOwners) {
        if (!owners.has(id)) continue
        if (owners.size >= 2) shares = true
        else singletons.push(atomName)
      }
      singletons.sort()
      return {
        id,
        participates: shares,
        unmatchedAtoms: singletons,
        ...(shares
          ? {}
          : {
              suggestion:
                `Rewrite ${id} to share guard/response vocabulary with the requirements it ` +
                'relates to, or link its terms via `symspec glossary add`/`symspec antonym add` ' +
                'so the formal tier can cross-compare it.',
            }),
      }
    })
  const uncoveredRows = coverageRows.filter((r) => !r.participates)

  const openOppositionFindings = kept.filter((f) => f.code === 'FND_OPPOSITION_CANDIDATE')
  // NOTE: the excluded-from-formal demotion is driven by `gateResult.excluded`
  // (a structural fact), NOT by the post-waiver `kept` set — see the demotion
  // loop below. Quantity-alias and relational demotions ARE keyed off `kept` on
  // purpose: those findings are genuinely triaged away by a waiver (the author
  // confirmed the quantities differ, or hand-verified the aggregate), which is a
  // legitimate discharge, unlike suppressing a coverage FACT.
  const quantityAliasFindings = kept.filter((f) => f.code === 'FND_QUANTITY_ALIAS_CANDIDATE')
  const relationalFindings = kept.filter((f) => f.code === 'FND_RELATIONAL_UNCHECKED')

  const demotions: CoverageDemotion[] = []
  if (requirements.length >= 2) {
    for (const row of uncoveredRows) {
      demotions.push({
        reason: 'uncovered-requirement',
        requirementIds: [row.id],
        action: row.suggestion ?? '',
      })
    }
    // Excluded-from-formal: the solver never saw these requirements, so
    // `verified` cannot cover them. Discharged by fixing the blocking finding
    // (rephrase) — or by WAIVING that blocking finding, which the waiver-aware
    // gate honors by re-admitting the requirement (so `gateResult.excluded`
    // shrinks and this demotion disappears). It is computed from
    // `gateResult.excluded` (the structural fact), NOT from the post-waiver
    // finding set: waiving the DISCLOSURE code (`FND_EXCLUDED_FROM_FORMAL`)
    // hides the report line but must NEVER promote `verified` over a requirement
    // the solver still never saw — that would be a demotion-only violation
    // (a suppression is not a decide-tier proof). Adversarial-review hardened.
    for (const ex of gateResult.excluded) {
      demotions.push({
        reason: 'excluded-from-formal',
        requirementIds: [ex.id],
        action:
          `Rephrase ${ex.id} to clear the error-severity lint/parse finding that blocked it from ` +
          'the formal tier (see the finding message for the blocking code), then re-run `symspec ' +
          'check`. Alternatively, `symspec waive add <blocking-code> --ref ' +
          `${ex.id}` +
          ' --reason "…"` — the waiver-aware gate re-admits the requirement to the solver. Waiving ' +
          'the FND_EXCLUDED_FROM_FORMAL disclosure itself does NOT restore coverage.',
      })
    }
    // Quantity-alias candidates: a possible single-quantity numeric conflict
    // was never compared because two verb-phrasings split one quantity.
    for (const f of quantityAliasFindings) {
      demotions.push({
        reason: 'quantity-alias-candidate',
        requirementIds: [...f.requirementIds],
        action:
          'Two same-trigger opposed numeric bounds landed on different quantity keys. If they ' +
          'constrain one physical quantity, commit the `symspec glossary add` alias from the ' +
          "finding's message so the numeric tier compares them; otherwise waive it. Then re-run `symspec check`.",
      })
    }
    // Relational/aggregate blind spot: the pairwise same-quantity numeric tier
    // did not attempt aggregate sums or cross-entity relations under this shared
    // trigger. An honest "not attempted" caveat, dischargeable by hand-verifying
    // (then waiving) or restating as a same-quantity bound.
    for (const f of relationalFindings) {
      demotions.push({
        reason: 'relational-reasoning-not-attempted',
        requirementIds: [...f.requirementIds],
        action:
          `Aggregate/cross-quantity reasoning over ${f.requirementIds.join(', ')} was not attempted ` +
          '(the numeric tier is pairwise same-quantity only). Verify any shared-resource sum or ' +
          'cross-entity relation by hand and waive this finding, or restate the constraint as a ' +
          'same-quantity numeric bound the solver can check.',
      })
    }
    for (const f of openOppositionFindings) {
      demotions.push({
        reason: 'open-opposition-candidate',
        requirementIds: [...f.requirementIds],
        action:
          'Triage this opposition candidate: commit `symspec antonym add <a> <b>` if the verbs are ' +
          'opposites, `symspec glossary add "<a>" "<b>"` if synonyms, or waive it ' +
          `(\`symspec waive add FND_OPPOSITION_CANDIDATE --reason "…"\`) if neither. See the finding's message for the exact verbs.`,
      })
    }
    if (inconclusive) {
      demotions.push({
        reason: 'no-decide-tier-comparison',
        requirementIds: requirements.map((r) => r.id),
        action:
          'No cross-requirement comparison happened. Align vocabulary across requirements (shared ' +
          'guards/objects) or commit glossary/antonym links so the decide tier can compare pairs.',
      })
    }
    if (options.semantic === undefined) {
      demotions.push({
        reason: 'semantic-tier-skipped',
        requirementIds: [],
        action:
          'The semantic/opposition tier did not run, so untriaged opposition candidates may exist. ' +
          'Run `symspec check` via the CLI (which loads the embedding model), or supply an embedder ' +
          'to runCheck; pre-warm an air-gapped host with `symspec download-model`.',
      })
    }
  }

  // AC-1-7 — the soundness-critical demotion. A run whose `--solver-budget-ms`
  // deadline cut a tier short did NOT compare everything it would otherwise have
  // compared, so it must not certify. One demotion per truncated tier, naming the
  // unrun unit count, with the raise-the-budget action.
  //
  // Deliberately OUTSIDE the `requirements.length >= 2` guard above. That guard
  // encodes "a spec with <2 requirements is VACUOUSLY verified" — true only when
  // the tiers actually ran to completion. Truncation is a statement about the
  // RUN, not about the document's size, so it demotes unconditionally. This is
  // the one demotion reason a small document cannot escape.
  //
  // Not waiver-discharged: `demotions` is not derived from the finding set here,
  // so waiving a code cannot suppress it. Truncation is a coverage FACT (the same
  // reasoning that keeps `excluded-from-formal` keyed off `gateResult.excluded`
  // rather than the post-waiver `kept` set) — a suppression is not a comparison.
  for (const t of solverBudget?.truncations() ?? []) {
    demotions.push({
      reason: 'solver-budget-exhausted',
      // No specific requirement is at fault: the whole run was cut short. An
      // empty id list matches the `semantic-tier-skipped` precedent for a
      // run-scoped (not requirement-scoped) demotion.
      requirementIds: [],
      action:
        `The ${t.tier} tier stopped after the whole-run --solver-budget-ms deadline ` +
        `(${solverBudget?.budgetMs ?? 0}ms) expired, leaving ${t.skipped} unit(s) of work unrun, so ` +
        'this run compared less than it would have. Raise --solver-budget-ms (or reduce the ' +
        'document / raise --similarity-threshold to shrink the candidate-pair set), then re-run ' +
        '`symspec check`. Waiving a finding cannot discharge this — the comparison did not happen.',
    })
  }
  const verified = demotions.length === 0
  const encodedCount = coverageIncludedIds.length
  const excludedCount = gateResult.excluded.length
  const pairsCheckedNote =
    requirements.length < 2
      ? 'Fewer than two requirements: nothing to cross-compare.'
      : `${encodedCount} requirement(s) reached the formal tier` +
        (excludedCount > 0 ? ` (${excludedCount} excluded by blocking lint/parse findings)` : '') +
        `; ${report.pairsChecked} candidate pair(s) shared an atom and were compared. A low count ` +
        'is expected for requirements describing disjoint transitions across different ' +
        'systems/triggers — a singleton with no same-context peer is not a coverage gap. ' +
        'Non-participating requirements are listed in `coverage.requirements` with a rewrite hint.'
  const coverageReport: CoverageReport = {
    requirements: coverageRows,
    openOppositionCandidates: openOppositionFindings.length,
    demotions,
    encoded: encodedCount,
    excluded: excludedCount,
    pairsCheckedNote,
  }

  // Wishlist #5b: roll the residual-risk axes up from the KEPT (post-waiver)
  // finding set, so a waived residual-risk finding drops out of the summary too.
  const residualRisk: ResidualRisk = {
    similarUnunifiedPairs: kept.filter((f) => f.code === 'FND_SIMILAR_UNUNIFIED').length,
    semanticSuggestions: kept.filter((f) => f.code === 'FND_SIMILAR_SEMANTIC').length,
    pairsChecked: report.pairsChecked,
    noPairsChecked: report.pairsChecked === 0,
    excludedRequirements: gateResult.excluded.length,
    unmatchedAtoms,
    uncoveredRequirements: uncoveredRows.length,
  }

  // Wishlist #4: resolve the opt-in strict coverage gate. It runs only when a
  // gate was requested; when it runs it fails if the run is inconclusive (under
  // `--strict`) OR the unmatched-atom count exceeds the `--fail-on-unmatched`
  // threshold. A tripped gate maps to EXIT_INCONCLUSIVE unless an error-severity
  // finding already claims the stronger EXIT_FINDINGS_FAILURE (resolved in
  // exit.ts). Left undefined when no gate was requested so a default run's
  // contract is untouched.
  const gateRequested = options.strict === true || options.failOnUnmatched !== undefined
  const gateTripped =
    (options.strict === true && !verified) ||
    (options.failOnUnmatched !== undefined && unmatchedAtoms > options.failOnUnmatched)
  const strictGate: 'pass' | 'fail' | undefined = gateRequested
    ? gateTripped
      ? 'fail'
      : 'pass'
    : undefined

  return {
    findings: kept,
    excluded: gateResult.excluded,
    pairsChecked: report.pairsChecked,
    waived,
    counts,
    residualRisk,
    coverage: coverageReport,
    verified,
    ...(strictGate !== undefined ? { strictGate } : {}),
  }
}
