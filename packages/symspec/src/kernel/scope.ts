/**
 * THE HONEST-SCOPE CORPUS — what symspec guarantees, and what it does not.
 *
 * ## Transplanted, not rewritten
 *
 * Every string below was extracted programmatically rather than retyped. That is the same
 * discipline the three code catalogs follow, and for a stronger reason: these sentences
 * are the LOAD-BEARING HONESTY of the whole tool. "Silence is not a consistency
 * certificate" is the claim that keeps a clean `check` from being read as a proof, and a
 * paraphrase of it that drifted toward reassurance would be the single most damaging edit
 * anyone could make to this repo.
 *
 * `scope.test.ts` pins all seven verbatim against a frozen copy, so rewording one is a
 * deliberate two-place edit that shows up as a diff — never a silent softening.
 *
 * ## Why this module owns the corpus
 *
 * The two agent-facing surfaces — the installed skill body and the generated `AGENTS.md`
 * — both have to quote the disclosure, and they must quote it from a module inside the
 * package they ship with.
 *
 * ## The one string that is NOT carried over
 *
 * The donor's `SCOPE.text` (all seven claims joined into one paragraph) is deliberately
 * absent. It existed because the donor's manifest published a single `scope.text` field,
 * and a joined blob is worse than the parts for both consumers here: an agent switching
 * on a specific claim wants the named field, and a rendered surface wants the claims as
 * separate quoted paragraphs. {@link scopeParagraphs} produces the latter on demand, so
 * nothing needs a pre-joined constant that could fall out of sync with its own parts.
 */

/**
 * The seven honest-scope claims, each a named field so an agent can branch on the one
 * it cares about rather than grepping a paragraph.
 *
 * Order is the donor's, which is also the order they are worth reading: what the tier
 * proves, what its silence does NOT mean, the one false-positive risk, the three
 * not-decided boundaries, and finally the demotion-only rule that ties `verified` to all
 * of it.
 */
export const SCOPE = {
  soundness:
    'The formal (SMT) tier is sound modulo atomization, given the conservative near-exact normalization of the atom table: every reported conflict is a genuine logical conflict of the requirements as atomized, and the atom table attached to each finding shows exactly what the solver compared.',
  silence:
    'Because paraphrases become distinct atoms, a real conflict can be missed (a false negative): silence is not a consistency certificate, so the formal tier reporting no conflict does not prove the spec consistent.',
  overUnification:
    'The one false-positive risk is over-unification (too-aggressive normalization collapsing two distinct conditions into one atom); it is mitigated by conservative normalization (no stemming or stopword-stripping beyond leading articles) and the info-severity FND_SIMILAR_UNUNIFIED reporter.',
  contextualAmbiguityNotChecked:
    'Deterministic ambiguity detectors (vague terms, quantifier/coordination scope, and referential ambiguity) run and report; but whether a phrase is vague in its domain context — pragmatic/contextual ambiguity — is surfaced for review (FND_AMBIGUITY_NEEDS_JUDGMENT), not decided by symspec, and any LLM ambiguity judgment is propose-only, never a verdict.',
  semanticProposeOnly:
    'Semantic similarity is a propose-only assist: the always-on embedding tier suggests glossary merges and opposition candidates for paraphrased or polar-opposite responses but never emits a conflict verdict, so `check` remains reproducible given the document, its glossary, and the pinned embedding model. A missing model fails the run closed (ERR_EMBED_MODEL_MISSING) rather than silently skipping the tier; pre-warm with `symspec download-model`.',
  numericChecked:
    'Numeric conflicts are checked over linear integer/real arithmetic (LIA/LRA): requirements placing jointly unsatisfiable bounds on the same per-system quantity (unit-normalized) are reported as FND_NUMERIC_CONTRADICTION. Nonlinear-integer arithmetic remains out of scope (undecidable).',
  coverageDemotion:
    '`data.verified` is a whole-document claim: it is true only when every requirement shares vocabulary with a peer (participates in a cross-requirement comparison), every opposition candidate has been triaged (committed via `antonym add`/`glossary add` or waived), and a decide-tier comparison actually ran. Propose-only findings and coverage statistics can only demote verified, never promote it. Each demotion is listed in `data.coverage.demotions` with the concrete command that discharges it, so an agent can iterate: `check --strict` (exit 3 on demotion) -> apply the listed ops or rewrite the named requirements -> re-check -> exit 0.',
} as const

/** The claim keys, for a surface that wants to iterate rather than name them. */
export const SCOPE_KEYS = [
  'soundness',
  'silence',
  'overUnification',
  'contextualAmbiguityNotChecked',
  'semanticProposeOnly',
  'numericChecked',
  'coverageDemotion',
] as const satisfies readonly (keyof typeof SCOPE)[]

/**
 * The claims as separate paragraphs, in reading order — what a Markdown surface renders
 * as consecutive blockquotes.
 *
 * A FUNCTION returning an array rather than a pre-joined constant, so the rendered
 * surfaces cannot drift from the named fields the way the donor's `SCOPE.text` could.
 */
export const scopeParagraphs = (): readonly string[] => SCOPE_KEYS.map((key) => SCOPE[key])

/**
 * The two claims a THIN-POINTER surface must carry even when it carries nothing else.
 *
 * The installed skill body is deliberately short (the codegraph lesson: a skill that
 * duplicates the docs drifts from them), so it has to choose. These two are the choice,
 * because they are the ones whose absence changes what an agent CONCLUDES: `soundness`
 * says a reported conflict is real, and `silence` says the absence of one is not a
 * proof. Every other claim refines a decision an agent has already made correctly if it
 * has these two.
 */
export const SCOPE_ESSENTIAL = [SCOPE.soundness, SCOPE.silence] as const
