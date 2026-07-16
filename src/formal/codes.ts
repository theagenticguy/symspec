/**
 * `FND_*` finding codes enumeration — the closed, append-only set of finding
 * codes the calling agent switches on (Appendix B, spec.md).
 *
 * Every finding symspec emits carries a `{ code, severity, … }` shape whose
 * `code` is one of these. The catalog spans all four tiers:
 *
 *   - Tier 0 structural (AC-3-5/3-6): DANGLING_REFERENCE, MISSING_TRIGGER,
 *     MISSING_PRECONDITION, CYCLE, ORPHAN
 *   - Lint free tier (AC-3-1): EXACT_DUPLICATE  (GtWR rule codes are the
 *     separate `GtwrCodeSchema` catalog in src/lint/codes.ts)
 *   - Formal SMT tier (AC-4-4/4-5/4-7/4-12): CONTRADICTION, SUBSUMPTION,
 *     REDUNDANCY, VACUITY, SIMILAR_UNUNIFIED, NEEDS_REVIEW
 *   - Completeness heuristic (AC-4-5a): INCOMPLETE
 *   - Certify Lean tier (AC-5-2/5-3): CERTIFIED, CERTIFY_FAILED
 *
 * ## Reachability bridges (AC-6-3 "each documented code is reachable")
 *
 * Two producer surfaces do not yet emit their `FND_*` code as a string
 * literal — they discriminate on other fields for historical reasons:
 *
 *   - the Tier-0 structural pass (`core/analyze.ts`) tags findings with a
 *     `kind` (`'DanglingReference'` …); {@link structuralKindToFndCode} is the
 *     canonical, single-source mapping from that `kind` to its `FND_*` code.
 *   - the free-tier exact-duplicate solver tags `kind: 'ExactDuplicate'`;
 *     {@link solverKindToFndCode} maps it to `FND_EXACT_DUPLICATE`.
 *   - the certify tier returns a `certified` boolean; {@link certifiedToFndCode}
 *     maps that verdict to `FND_CERTIFIED` / `FND_CERTIFY_FAILED`.
 *
 * These bridges live here so the code catalog is genuinely single-sourced and
 * the AC-6-3 reachability test can assert every documented code is produced by
 * a real emitter path (either a direct `code:` literal or one of these maps),
 * not merely enumerated.
 *
 * ## Single-source `.describe()` corpus + append-only (AC-6-3)
 *
 * {@link FndCodeMeta} carries a per-code `.describe()`; the manifest (AC-6-1)
 * reads it to build its FND table. `satisfies Record<FndCode, …>` forces the
 * corpus to cover EXACTLY the enum members. Never renumber or remove a code;
 * new codes append to the END. A snapshot test guards this for FND_* alongside
 * the ERR_* and GTWR_* catalogs.
 *
 * Cite: AC-6-3 (three exported enums, FND_* is the third); Appendix B
 * (normative finding-code enum); AC-3-5/3-6, AC-4-4/4-5/4-5a/4-7/4-12, AC-5-2/5-3.
 */

import { z } from 'zod'

/**
 * `FND_*` finding codes — the closed enum an agent switches on. Grouped by
 * tier to match Appendix B's table order. Append-only; never renumber or
 * remove.
 */
export const FndCodeSchema = z.enum([
  // Tier 0 — structural (AC-3-5, AC-3-6)
  'FND_DANGLING_REFERENCE',
  'FND_MISSING_TRIGGER',
  'FND_MISSING_PRECONDITION',
  'FND_CYCLE',
  'FND_ORPHAN',
  // Lint — free tier (AC-3-1)
  'FND_EXACT_DUPLICATE',
  // Formal tier — SMT (AC-4-4, AC-4-5, AC-4-7, AC-4-12)
  'FND_CONTRADICTION',
  'FND_SUBSUMPTION',
  'FND_REDUNDANCY',
  'FND_VACUITY',
  'FND_SIMILAR_UNUNIFIED',
  'FND_NEEDS_REVIEW',
  // Completeness heuristic — lint tier (AC-4-5a)
  'FND_INCOMPLETE',
  // Certify tier — Lean (AC-5-2, AC-5-3)
  'FND_CERTIFIED',
  'FND_CERTIFY_FAILED',
  // Semantic paraphrase-bridging tier (AC-9-5) — propose-only, never a verdict
  'FND_SIMILAR_SEMANTIC',
  // Numeric/arithmetic conflict tier (AC-30-3) — deterministic verdict (LIA/LRA)
  'FND_NUMERIC_CONTRADICTION',
  // DAG well-formedness (AC-32-3) — deterministic structural verdict
  'FND_LEAF_UNVERIFIABLE',
  // Embedding-graph proposals (AC-32-2/4) — propose-only, never a verdict
  'FND_MISSING_TRACE_LINK',
  'FND_DUPLICATE_CLUSTER',
  // Ambiguity family (AC-31-1/2/3/5) — deterministic detectors + structured punt
  'FND_AMBIGUOUS_VAGUE',
  'FND_AMBIGUOUS_QUANTIFIER',
  'FND_AMBIGUOUS_REFERENCE',
  'FND_AMBIGUITY_NEEDS_JUDGMENT',
  // Bounded temporal tier (AC-33-2) — sound-for-UNSAT verdict over a trace bound
  'FND_TEMPORAL_CONTRADICTION',
  // Formal-coverage disclosure (appended) — the formal tier evaluated ZERO
  // pairs (no two requirements shared an atom), so `check` performed no
  // cross-requirement conflict analysis. An info finding so silence that looks
  // like a pass is loud instead.
  'FND_NO_PAIRS_CHECKED',
  // Opposition-candidate proposal (appended — #6) — two same-system responses
  // that share an object but differ on the leading verb, a likely antonym pair
  // the seed/committed antonym tables did not unify. Propose-only, info-tier:
  // it suggests `symspec antonym add`, never a verdict.
  'FND_OPPOSITION_CANDIDATE',
  // Formal-exclusion disclosure (appended) — a requirement was dropped from the
  // formal (SMT) tier because an error-severity lint/parse finding blocked its
  // surface. `verified` cannot cover a requirement the solver never saw, so this
  // is a first-class LOUD signal (not buried in residualRisk) and DEMOTES
  // `verified`. Info-tier, one per excluded requirement.
  'FND_EXCLUDED_FROM_FORMAL',
  // Quantity-alias proposal (appended) — two same-system+same-trigger numeric
  // bounds land on DIFFERENT quantity keys that nonetheless share a noun token
  // (e.g. "complete the infusion within ≤30 min" vs "run the infusion for ≥60
  // min"). The bounds may constrain ONE physical quantity the verb phrasing
  // split apart. Propose-only: suggests `symspec glossary add` to unify the
  // quantities so the LIA tier can compare their bounds. Never a verdict; it
  // DEMOTES `verified` because a possible numeric conflict went unexamined.
  'FND_QUANTITY_ALIAS_CANDIDATE',
  // Relational-reasoning disclosure (appended) — requirements under one shared
  // trigger carry numeric bounds AND unmatched (singleton) atoms, the shape
  // where aggregate/conservation or cross-quantity relational conflicts hide.
  // symspec's numeric tier is pairwise same-quantity only; it does NOT attempt
  // aggregate sums or cross-quantity arithmetic. Info-tier, DEMOTES `verified`
  // so "verified" never outruns what the solver actually compared.
  'FND_RELATIONAL_UNCHECKED',
])

export type FndCode = z.infer<typeof FndCodeSchema>

/** Convenience: export the inner tuple for Zod snapshot/reachability tests. */
export const FndCodes = FndCodeSchema.options

/**
 * Per-code `.describe()` corpus for the FND_* catalog (AC-6-3). The manifest
 * reads `.description` off these described literals to build its FND table; the
 * `satisfies` bound forces the corpus to cover EXACTLY the enum members.
 */
export const FndCodeMeta = {
  FND_DANGLING_REFERENCE: z
    .literal('FND_DANGLING_REFERENCE')
    .describe('error — an edge targets a nonexistent requirement UUID.'),
  FND_MISSING_TRIGGER: z
    .literal('FND_MISSING_TRIGGER')
    .describe('error — an event-driven / unwanted-behavior requirement has no trigger.'),
  FND_MISSING_PRECONDITION: z
    .literal('FND_MISSING_PRECONDITION')
    .describe('error — a state-driven / optional-feature requirement has no precondition.'),
  FND_CYCLE: z
    .literal('FND_CYCLE')
    .describe('error — a cycle in `derives`/`refines` (canonical-rotation deduplicated).'),
  FND_ORPHAN: z
    .literal('FND_ORPHAN')
    .describe('warn — a requirement with zero inbound/outbound edges (document size > 1).'),
  FND_EXACT_DUPLICATE: z
    .literal('FND_EXACT_DUPLICATE')
    .describe('error — an identical slot-tuple hash: two requirements are exact duplicates.'),
  FND_CONTRADICTION: z
    .literal('FND_CONTRADICTION')
    .describe(
      'error — a context group is unsat; ids are the filtered MINIMAL unsat core; requires same-atom opposite-polarity responses.',
    ),
  FND_SUBSUMPTION: z
    .literal('FND_SUBSUMPTION')
    .describe(
      'warn — a directional implication is valid; `moreGeneral` is the superset-of-cases side.',
    ),
  FND_REDUNDANCY: z
    .literal('FND_REDUNDANCY')
    .describe('warn — a bi-implication is valid: the two requirements are logical duplicates.'),
  FND_VACUITY: z
    .literal('FND_VACUITY')
    .describe(
      'warn — a guard is unreachable given all OTHER requirement formulas (relational, labeled lower confidence).',
    ),
  FND_SIMILAR_UNUNIFIED: z
    .literal('FND_SIMILAR_UNUNIFIED')
    .describe(
      'info — responses with Jaccard ≥ 0.7 that did not unify to one atom; an over-unification-adjacent review prompt (suggests rewording one response via `symspec update`).',
    ),
  FND_NEEDS_REVIEW: z
    .literal('FND_NEEDS_REVIEW')
    .describe(
      'info — a per-group solver `unknown`/timeout/unencodable result; explicitly NOT a "no conflict".',
    ),
  FND_INCOMPLETE: z
    .literal('FND_INCOMPLETE')
    .describe(
      'info — a heuristic guard-coverage gap over a same-trigger-family group; NOT a formal completeness guarantee.',
    ),
  FND_CERTIFIED: z
    .literal('FND_CERTIFIED')
    .describe('info — kernel-checked by Lean; carries `#print axioms` provenance.'),
  FND_CERTIFY_FAILED: z
    .literal('FND_CERTIFY_FAILED')
    .describe('error — Lean produced a `severity:"error"` diagnostic; certification failed.'),
  FND_SIMILAR_SEMANTIC: z
    .literal('FND_SIMILAR_SEMANTIC')
    .describe(
      'info — two responses embed with cosine ≥ threshold but did not unify to one atom; a PROPOSE-only prompt to add a `symspec glossary` entry. Never a verdict.',
    ),
  FND_NUMERIC_CONTRADICTION: z
    .literal('FND_NUMERIC_CONTRADICTION')
    .describe(
      'error — two+ requirements place jointly unsatisfiable linear numeric constraints (LIA/LRA) on the same per-system quantity; ids are the minimal unsat core, evidence lists the conflicting predicates (unit-normalized).',
    ),
  FND_LEAF_UNVERIFIABLE: z
    .literal('FND_LEAF_UNVERIFIABLE')
    .describe(
      'warn — a refinement-DAG leaf (inbound refines/derives, no outbound) with no `verifies` edge; a leaf must be independently verifiable (KAOS/SysML leaf-verifiability).',
    ),
  FND_MISSING_TRACE_LINK: z
    .literal('FND_MISSING_TRACE_LINK')
    .describe(
      'info — two requirements embed with cosine ≥ threshold but share no committed refines/derives/satisfies edge; a PROPOSE-only candidate trace link. Never a verdict.',
    ),
  FND_DUPLICATE_CLUSTER: z
    .literal('FND_DUPLICATE_CLUSTER')
    .describe(
      'info — three+ requirements form a tight semantic cluster; a PROPOSE-only prompt to review for near-duplication or an unstated shared parent. Never a verdict.',
    ),
  FND_AMBIGUOUS_VAGUE: z
    .literal('FND_AMBIGUOUS_VAGUE')
    .describe(
      'info — a vague/weasel term (e.g. "fast", "user-friendly", "as appropriate") with no measurable meaning; deterministic lexical scan, carries the offending span.',
    ),
  FND_AMBIGUOUS_QUANTIFIER: z
    .literal('FND_AMBIGUOUS_QUANTIFIER')
    .describe(
      'warn/info — scope/quantifier ambiguity: un-parenthesized "and…or" coordination (warn), leading "all/each/every", or a bare-plural subject; deterministic pattern scan with a span.',
    ),
  FND_AMBIGUOUS_REFERENCE: z
    .literal('FND_AMBIGUOUS_REFERENCE')
    .describe(
      'info — a pronoun or bare definite NP ("it", "the system") with ≥2 candidate antecedents in scope; deterministic detection (recall-first), resolution is punted to the agent.',
    ),
  FND_AMBIGUITY_NEEDS_JUDGMENT: z
    .literal('FND_AMBIGUITY_NEEDS_JUDGMENT')
    .describe(
      'info — pragmatic/contextual ambiguity was not assessed deterministically; a structured prompt to hand the requirement to an LLM/agent review. Never a verdict, never in the reproducibility hash.',
    ),
  FND_TEMPORAL_CONTRADICTION: z
    .literal('FND_TEMPORAL_CONTRADICTION')
    .describe(
      'error — a set of requirements is temporally inconsistent under bounded LTL→SMT (no trace of length ≤ k satisfies them jointly); sound-for-UNSAT, evidence carries {bound,complete:false}. Opt-in via `check --temporal`.',
    ),
  FND_NO_PAIRS_CHECKED: z
    .literal('FND_NO_PAIRS_CHECKED')
    .describe(
      'info — the formal tier evaluated 0 candidate pairs (no two requirements shared an atom), so no cross-requirement conflict/subsumption analysis actually ran. Silence here is not a consistency certificate; consider glossary entries to align vocabulary so related requirements share atoms.',
    ),
  FND_OPPOSITION_CANDIDATE: z
    .literal('FND_OPPOSITION_CANDIDATE')
    .describe(
      'info — two same-system responses share an object phrase but differ on the leading verb (e.g. "open the valve" vs "shut the valve"), a LIKELY antonym pair the seed/committed antonym tables have not unified. Propose-only: if the verbs are truly opposite, run `symspec antonym add <verbA> <verbB>` so the formal tier collapses them to one atom at opposite polarity and can prove any conflict. Never a verdict.',
    ),
  FND_EXCLUDED_FROM_FORMAL: z
    .literal('FND_EXCLUDED_FROM_FORMAL')
    .describe(
      'info — a requirement was excluded from the formal (SMT) tier because an error-severity lint or parse finding blocked its surface, so no cross-requirement analysis covered it. A LOUD coverage signal that DEMOTES `verified` (silence over an unchecked requirement is not a consistency certificate); discharge by fixing the blocking finding (rephrase) — waiving the finding alone does NOT restore formal coverage.',
    ),
  FND_QUANTITY_ALIAS_CANDIDATE: z
    .literal('FND_QUANTITY_ALIAS_CANDIDATE')
    .describe(
      'info — two same-system, same-trigger numeric bounds landed on different quantity keys that share a noun token (e.g. "complete the infusion within ≤30 min" vs "run the infusion for ≥60 min"), so a possible single-quantity conflict was never compared. Propose-only: if the bounds constrain ONE quantity, run the suggested `symspec glossary add` to unify them so the LIA tier can prove any conflict. DEMOTES `verified`; never a verdict.',
    ),
  FND_RELATIONAL_UNCHECKED: z
    .literal('FND_RELATIONAL_UNCHECKED')
    .describe(
      "info — requirements under one shared trigger carry numeric bounds alongside unmatched (singleton) atoms — the shape where aggregate/conservation or cross-quantity relational conflicts hide. symspec's numeric tier is pairwise same-quantity only and does NOT attempt aggregate sums or cross-quantity arithmetic, so this reasoning was not attempted. DEMOTES `verified` so it never outruns what was compared; never a verdict.",
    ),
} satisfies Record<FndCode, z.ZodLiteral<FndCode>>

// ---------------------------------------------------------------------------
// Reachability bridges — canonical, single-source maps from a producer's
// discriminant to its FND_* code. See the module header.
// ---------------------------------------------------------------------------

/**
 * The Tier-0 structural pass (`core/analyze.ts`) discriminant `kind` → its
 * `FND_*` code. This is the single source of that correspondence; the `check`
 * wiring (AC-6-8) and the reachability test both read it.
 */
export const structuralKindToFndCode = {
  DanglingReference: 'FND_DANGLING_REFERENCE',
  MissingTrigger: 'FND_MISSING_TRIGGER',
  MissingPreCondition: 'FND_MISSING_PRECONDITION',
  CycleDetected: 'FND_CYCLE',
  OrphanRequirement: 'FND_ORPHAN',
  LeafUnverifiable: 'FND_LEAF_UNVERIFIABLE',
} as const satisfies Record<string, FndCode>

/**
 * The free-tier solver discriminant `kind` → its `FND_*` code. Only the
 * exact-duplicate solver maps to an `FND_*` code here; the pairwise/formal
 * kinds surface under the formal-tier codes above.
 */
export const solverKindToFndCode = {
  ExactDuplicate: 'FND_EXACT_DUPLICATE',
} as const satisfies Record<string, FndCode>

/** The certify verdict boolean → its `FND_*` code (AC-5-2/5-3). */
export function certifiedToFndCode(certified: boolean): FndCode {
  return certified ? 'FND_CERTIFIED' : 'FND_CERTIFY_FAILED'
}
