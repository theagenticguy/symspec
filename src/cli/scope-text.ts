/**
 * The formal tier's honest-scope disclosure (AC-4-11).
 *
 * The SMT tier makes a precise, deliberately narrow soundness claim, and this
 * module is the single source of the exact prose that states it. The claim is
 * surfaced in two places — the `manifest` command (AC-6-1, so an agent reads
 * the boundary before trusting a `check` result) and formal finding output —
 * both of which import the constants below rather than re-phrasing the claim,
 * so the disclosure can never drift between surfaces.
 *
 * ## What the claim is, and why it is worded exactly this way
 *
 * The tier is *sound modulo atomization, GIVEN the conservative near-exact
 * normalization of AC-4-2a*: every reported conflict is a genuine logical
 * conflict of the requirements AS ATOMIZED (research-smt.md §0, §4.3). The
 * atom table on each finding (AC-4-6) shows exactly what was compared, so a
 * reported `FND_CONTRADICTION` is auditable and real.
 *
 * The dual of that guarantee is the honest limit: because paraphrases become
 * distinct atoms, a real conflict can hide behind unmatched atoms (a false
 * negative). Therefore **silence is not a consistency certificate** — the tier
 * finding nothing does NOT prove the spec consistent (research-smt.md §4.3
 * "SMT-tier silence is *not* a consistency certificate"). This is the correct
 * failure direction for a linter: no hallucinated conflicts, missed ones at
 * worst — precisely what the removed LLM tier could not promise.
 *
 * The one false-positive risk is over-unification (too-aggressive normalization
 * collapsing two distinct conditions into one atom). It is mitigated by (a) the
 * conservative AC-4-2a normalization — no stemming or stopword-stripping beyond
 * leading articles — and (b) the info-severity `FND_SIMILAR_UNUNIFIED` reporter
 * (AC-4-12), which surfaces suspiciously-similar-but-unmatched atoms as a review
 * prompt rather than manufacturing a conflict.
 *
 * Finally, **contextual ambiguity is not checked** — whether a phrase is vague
 * in its domain context is punted to the calling coding agent, documented here
 * as a not-checked boundary rather than silently unhandled (explore-solvers.md
 * §2.2; research-smt.md §4.3; spec Non-goals "No contextual-ambiguity
 * checking").
 *
 * Cite: AC-4-11 (manifest + finding output must state "sound modulo
 * atomization", "silence is not a consistency certificate", and the
 * contextual-ambiguity not-checked boundary); research-smt.md §4.3 "the honest
 * limits"; orchestrator decisions 2–3.
 */

import { z } from 'zod'

/**
 * The core soundness claim. Contains the exact substring
 * `"sound modulo atomization"` that AC-4-11's manifest snapshot test greps for.
 */
export const SCOPE_SOUNDNESS =
  'The formal (SMT) tier is sound modulo atomization, given the conservative ' +
  'near-exact normalization of the atom table: every reported conflict is a ' +
  'genuine logical conflict of the requirements as atomized, and the atom ' +
  'table attached to each finding shows exactly what the solver compared.'

/**
 * The dual of the soundness claim. Contains the exact substring
 * `"silence is not"` (full phrase: "silence is not a consistency certificate")
 * that AC-4-11's manifest snapshot test greps for.
 */
export const SCOPE_SILENCE =
  'Because paraphrases become distinct atoms, a real conflict can be missed ' +
  '(a false negative): silence is not a consistency certificate, so the ' +
  'formal tier reporting no conflict does not prove the spec consistent.'

/**
 * The one false-positive risk and its mitigations (AC-4-11): over-unification
 * from too-aggressive normalization, held back by conservative atomization and
 * the info-severity FND_SIMILAR_UNUNIFIED reporter (AC-4-12).
 */
export const SCOPE_OVER_UNIFICATION =
  'The one false-positive risk is over-unification (too-aggressive ' +
  'normalization collapsing two distinct conditions into one atom); it is ' +
  'mitigated by conservative normalization (no stemming or stopword-stripping ' +
  'beyond leading articles) and the info-severity FND_SIMILAR_UNUNIFIED ' +
  'reporter.'

/**
 * The contextual-ambiguity not-checked boundary (AC-4-11): v2 deliberately does
 * not judge contextual vagueness; that judgment is punted to the calling agent.
 * Contains the exact substring `"contextual ambiguity is not checked"` that
 * AC-4-11's manifest snapshot test greps for.
 */
export const SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED =
  'Deterministic ambiguity detectors (vague terms, quantifier/coordination ' +
  'scope, and referential ambiguity) run and report; but whether a phrase is ' +
  'vague in its domain context — pragmatic/contextual ambiguity — is surfaced ' +
  'for review (FND_AMBIGUITY_NEEDS_JUDGMENT), not decided by symspec, and any ' +
  'LLM ambiguity judgment is propose-only, never a verdict.'

/**
 * The propose-only boundary for the semantic paraphrase tier (AC-9-7): the
 * always-on embedding pass suggests glossary merges and opposition candidates
 * but NEVER emits a conflict verdict. `check` stays reproducible given the
 * document, its glossary, and the pinned embedding model. Contains the exact
 * substring `"semantic similarity is a propose-only assist"` the manifest test
 * greps for.
 */
export const SCOPE_SEMANTIC_PROPOSE_ONLY =
  'Semantic similarity is a propose-only assist: the always-on embedding tier ' +
  'suggests glossary merges and opposition candidates for paraphrased or ' +
  'polar-opposite responses but never emits a conflict verdict, so `check` ' +
  'remains reproducible given the document, its glossary, and the pinned ' +
  'embedding model. A missing model fails the run closed ' +
  '(ERR_EMBED_MODEL_MISSING) rather than silently skipping the tier; pre-warm ' +
  'with `symspec download-model`.'

/**
 * The coverage-demotion principle (adversarial-eval hardening): `verified` is
 * a whole-document claim — every requirement must participate in a
 * cross-requirement comparison and every opposition candidate must be triaged —
 * and propose-only findings or coverage statistics can only DEMOTE it toward
 * abstention, never promote it. `data.coverage.demotions` enumerates each
 * demotion with the exact discharging command, so an agent iterates:
 * check --strict → apply the listed ops → re-check → verified. Contains the
 * exact substring `"demote verified, never promote"` the manifest test greps
 * for.
 */
export const SCOPE_COVERAGE_DEMOTION =
  '`data.verified` is a whole-document claim: it is true only when every ' +
  'requirement shares vocabulary with a peer (participates in a ' +
  'cross-requirement comparison), every opposition candidate has been triaged ' +
  '(committed via `antonym add`/`glossary add` or waived), and a decide-tier ' +
  'comparison actually ran. Propose-only findings and coverage statistics can ' +
  'only demote verified, never promote it. Each demotion is listed in ' +
  '`data.coverage.demotions` with the concrete command that discharges it, so ' +
  'an agent can iterate: `check --strict` (exit 3 on demotion) -> apply the ' +
  'listed ops or rewrite the named requirements -> re-check -> exit 0.'

/**
 * The numeric-tier scope (AC-30-5): numeric conflicts ARE now checked, over
 * linear integer/real arithmetic; nonlinear-integer arithmetic stays out
 * (undecidable). Contains the exact substring `"numeric conflicts are checked"`.
 */
export const SCOPE_NUMERIC_CHECKED =
  'Numeric conflicts are checked over linear integer/real arithmetic (LIA/LRA): ' +
  'requirements placing jointly unsatisfiable bounds on the same per-system ' +
  'quantity (unit-normalized) are reported as FND_NUMERIC_CONTRADICTION. ' +
  'Nonlinear-integer arithmetic remains out of scope (undecidable).'

/**
 * The composed honest-scope disclosure, as a single readable paragraph joining
 * the claims. This is the string surfaced in the manifest `scope.text`
 * field and available for formal finding output; it contains all of the exact
 * substrings AC-4-11 / AC-9-7 assert.
 */
export const SCOPE_TEXT = [
  SCOPE_SOUNDNESS,
  SCOPE_SILENCE,
  SCOPE_OVER_UNIFICATION,
  SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED,
  SCOPE_SEMANTIC_PROPOSE_ONLY,
  SCOPE_NUMERIC_CHECKED,
  SCOPE_COVERAGE_DEMOTION,
].join(' ')

/**
 * The structured honest-scope object embedded in the manifest under `scope`
 * (AC-4-11). Each claim is exposed as a named field so an agent can switch on
 * an individual boundary, and `text` carries the joined paragraph. Kept as
 * plain, JSON-serializable string data — no environment access, byte-stable.
 */
export const SCOPE = {
  soundness: SCOPE_SOUNDNESS,
  silence: SCOPE_SILENCE,
  overUnification: SCOPE_OVER_UNIFICATION,
  contextualAmbiguityNotChecked: SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED,
  semanticProposeOnly: SCOPE_SEMANTIC_PROPOSE_ONLY,
  numericChecked: SCOPE_NUMERIC_CHECKED,
  coverageDemotion: SCOPE_COVERAGE_DEMOTION,
  text: SCOPE_TEXT,
} as const

/**
 * Zod schema for the manifest `scope` field, pinned to the exact literal
 * strings above so a drifted disclosure fails the manifest's own schema
 * validation (the same self-guarding discipline the code catalogs use).
 */
export const ScopeSchema = z.object({
  soundness: z.literal(SCOPE_SOUNDNESS),
  silence: z.literal(SCOPE_SILENCE),
  overUnification: z.literal(SCOPE_OVER_UNIFICATION),
  contextualAmbiguityNotChecked: z.literal(SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED),
  semanticProposeOnly: z.literal(SCOPE_SEMANTIC_PROPOSE_ONLY),
  numericChecked: z.literal(SCOPE_NUMERIC_CHECKED),
  coverageDemotion: z.literal(SCOPE_COVERAGE_DEMOTION),
  text: z.literal(SCOPE_TEXT),
})
export type Scope = z.infer<typeof ScopeSchema>
