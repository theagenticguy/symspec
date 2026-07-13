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
 */

import { analyze, type Finding } from '../core/analyze.js'
import type { Doc } from '../core/doc.js'
import { listRequirements } from '../core/doc.js'
import { renderSentence } from '../core/render.js'
import type { Requirement, Waiver } from '../core/schema.js'
import { detectAmbiguity } from '../formal/ambiguity.js'
import { type AntonymEntry, buildAntonymIndexWithDoc } from '../formal/antonyms.js'
import { glossaryIndex, normalize, atomize as realAtomize } from '../formal/atomize.js'
import { getContext } from '../formal/backend.js'
import { type FndCode, structuralKindToFndCode } from '../formal/codes.js'
import { findContradictions } from '../formal/contradiction.js'
import { noPairsCheckedFinding } from '../formal/coverage.js'
import type { Embedder } from '../formal/embed.js'
import {
  type Atomize,
  type EncodableRequirement,
  type EncodedRequirement,
  encode,
} from '../formal/encode.js'
import { attachEvidenceToAll, type Evidence } from '../formal/finding.js'
import { buildSimilarityGraph, type GraphRequirement } from '../formal/graph.js'
import { checkCompleteness } from '../formal/incomplete.js'
import { findNeedsReview } from '../formal/needs-review.js'
import { extractNumericPredicates } from '../formal/numeric.js'
import { findNumericContradictions } from '../formal/numeric-contradiction.js'
import { findOppositionCandidates, findSimilarSemantic } from '../formal/semantic.js'
import { findSimilarUnunified } from '../formal/similar.js'
import { checkSubsumption } from '../formal/subsumption.js'
import { findTemporalContradictions } from '../formal/temporal.js'
import { earsToTemporal } from '../formal/temporal-patterns.js'
import { checkVacuity } from '../formal/vacuity.js'
import { checkGtWRules, checkGtWRulesSet } from '../lint/gtwr.js'
import { type FormalTierResult, runSolvers } from '../solvers/index.js'
import { asView, type ReqView } from '../solvers/types.js'
import { type Exclusion, excludedIds, gateRequirements } from './gate.js'

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
  /** Per-group solver timeout in ms (AC-4-7). Default 2000. */
  timeoutMs?: number
  /** Whole-run solver budget in ms (AC-4-7 `ERR_SOLVER_TIMEOUT` boundary). */
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
 * Build the encoder's positional `atomize` adapter (AC-4-2a → encoder), closing
 * over an optional glossary index (AC-9-2) so agent-confirmed synonyms
 * canonicalize to one atom, and an optional doc-augmented antonym index (#1) so
 * agent-confirmed opposites collapse to one atom at opposite polarity. With
 * neither, behavior is byte-identical to the pre-feature run.
 */
function makeAtomize(
  glossary?: ReadonlyMap<string, string>,
  antonyms?: ReadonlyMap<string, AntonymEntry>,
): Atomize {
  return (kind, slotText, systemName, negated) => {
    const a = realAtomize({
      kind,
      text: slotText,
      systemName,
      negated,
      ...(glossary !== undefined ? { glossary } : {}),
      ...(antonyms !== undefined ? { antonyms } : {}),
    })
    return { atom: a.name, negated: a.negated }
  }
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
  const excluded = excludedIds(gateRequirements(requirements))
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
  const gateResult = gateRequirements(requirements)
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

  const report = await runSolvers(doc, {
    ...(options.similarityThreshold !== undefined
      ? { similarityThreshold: options.similarityThreshold }
      : {}),
    formal: async ({ reqs, pairs }): Promise<FormalTierResult> => {
      const included = reqs.filter((r) => !excluded.has(r.id))
      const includedIdSet = new Set(included.map((r) => r.id))
      const encodable = included.map(toEncodable)

      const timeoutMs = options.timeoutMs ?? 2000
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

      const contradictions = await findContradictions(encodable, contradictionOpts)
      const subsumptions = await checkSubsumption(ctx, encodedById, includedPairs)
      const vacuities = await checkVacuity(ctx, encoded)
      const incompletes = await checkCompleteness(ctx, encoded)
      const similar = findSimilarUnunified(
        encodable,
        options.similarityThreshold !== undefined
          ? { similarityThreshold: options.similarityThreshold }
          : {},
      )
      const review = await findNeedsReview(encodable, {
        atomize,
        timeoutMs,
        ...(options.solverBudgetMs !== undefined ? { solverBudgetMs: options.solverBudgetMs } : {}),
      })

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
      const numericContradictions = await findNumericContradictions(ctx, numericReqPreds)

      // AC-33-2: opt-in bounded temporal tier. Map each requirement to LTL
      // (Dwyer/FRET) and prove temporal contradictions via bounded LTL→SMT on
      // the shared Z3-WASM context. Runs over ALL requirements (temporal
      // consistency is independent of the propositional gate). Sound-for-UNSAT.
      const temporalContradictions =
        options.temporal !== undefined
          ? await findTemporalContradictions(
              ctx,
              reqs.map((r) => ({ id: r.id, formula: earsToTemporal(r) })),
              options.temporal.bound ?? 10,
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
  const crossRequirementFired = formal.some(
    (f) => f.requirementIds.length >= 2 || CROSS_REQUIREMENT_FND_CODES.has(f.code),
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

  const demotions: CoverageDemotion[] = []
  if (requirements.length >= 2) {
    for (const row of uncoveredRows) {
      demotions.push({
        reason: 'uncovered-requirement',
        requirementIds: [row.id],
        action: row.suggestion ?? '',
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
  const verified = demotions.length === 0
  const coverageReport: CoverageReport = {
    requirements: coverageRows,
    openOppositionCandidates: openOppositionFindings.length,
    demotions,
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
