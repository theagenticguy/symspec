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
import type { Requirement } from '../core/schema.js'
import { detectAmbiguity } from '../formal/ambiguity.js'
import { glossaryIndex, atomize as realAtomize } from '../formal/atomize.js'
import { getContext } from '../formal/backend.js'
import { type FndCode, structuralKindToFndCode } from '../formal/codes.js'
import { findContradictions } from '../formal/contradiction.js'
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
import { findSimilarSemantic } from '../formal/semantic.js'
import { findSimilarUnunified } from '../formal/similar.js'
import { checkSubsumption } from '../formal/subsumption.js'
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
    /** Cosine threshold (default 0.82, `--semantic-threshold`). */
    threshold?: number
  }
}

/** The complete `check` result the CLI wraps in its envelope (AC-6-2). */
export interface CheckReport {
  /** Every tier's findings, normalized and stably ordered. */
  findings: CheckFinding[]
  /** AC-3-7 exclusions: statements the formal tier never saw, with evidence. */
  excluded: Exclusion[]
  /** How many candidate pairs the formal tier evaluated (AC-8-3 counter). */
  pairsChecked: number
  /** Findings tallied by severity — the exit-code contract's input. */
  counts: { error: number; warn: number; info: number }
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
 * canonicalize to one atom. With no glossary the behavior is byte-identical to
 * a glossary-free run.
 */
function makeAtomize(glossary?: ReadonlyMap<string, string>): Atomize {
  return (kind, slotText, systemName, negated) => {
    const a = realAtomize({
      kind,
      text: slotText,
      systemName,
      negated,
      ...(glossary !== undefined ? { glossary } : {}),
    })
    return { atom: a.name, negated: a.negated }
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
  const atomize = makeAtomize(glossaryIndex(doc.glossary))
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

const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warn: 1, info: 2 }

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
      const atomize = makeAtomize(glossaryIndex(doc.glossary))
      const contradictionOpts = { atomize, timeoutMs }

      // Whole-spec checks (contradiction / vacuity / completeness / review)
      // and pairwise checks (subsumption / redundancy) share one encoding.
      const ctx = await getContext('symspec-check')
      const encoded = encodable.map((r) => encode(r, atomize))
      const encodedById: ReadonlyMap<string, EncodedRequirement> = new Map(
        encoded.map((e) => [e.id, e]),
      )

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
      const numericReqPreds = included.map((r) => ({
        id: r.id,
        predicates: [
          ...extractNumericPredicates(r.systemResponse, r.systemName),
          ...(r.trigger !== undefined ? extractNumericPredicates(r.trigger, r.systemName) : []),
          ...(r.preCondition !== undefined
            ? extractNumericPredicates(r.preCondition, r.systemName)
            : []),
        ],
      }))
      const numericContradictions = await findNumericContradictions(ctx, numericReqPreds)

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
      for (const f of [...incompletes, ...similar, ...review, ...semantic, ...graph]) {
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
  findings.sort(compareFindings)

  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity] += 1

  return { findings, excluded: gateResult.excluded, pairsChecked: report.pairsChecked, counts }
}
