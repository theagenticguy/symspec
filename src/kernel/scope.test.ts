/**
 * The honest-scope corpus, pinned claim by claim against a frozen snapshot.
 *
 * These seven sentences are the load-bearing honesty of the tool: "silence is not a
 * consistency certificate" is what stops a clean `check` from being read as a proof.
 *
 * The direction of the risk is what shapes this file. The dangerous edit to a disclosure
 * is not a typo, it is a paraphrase that drifts toward reassurance — and a softened claim
 * still reads fine, so review alone does not catch it. Byte-equality does, which is why
 * {@link FROZEN} spells all seven out in full rather than sampling them: changing a
 * disclosure has to be a deliberate two-place edit that shows up as a diff on this file.
 *
 * The phrase-level assertions below are kept SEPARATE from the byte-diff, because they
 * survive a lockstep edit to both places. Those are the phrases whose disappearance
 * matters however the two copies agree.
 */

import { describe, expect, it } from 'vitest'
import { SCOPE, SCOPE_ESSENTIAL, SCOPE_KEYS, scopeParagraphs } from './scope.ts'

/** The seven claims, verbatim. A diff here is the review signal. */
const FROZEN: Record<(typeof SCOPE_KEYS)[number], string> = {
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
}

describe('the scope corpus is pinned, claim by claim', () => {
  it('carries all seven claims', () => {
    expect(SCOPE_KEYS).toHaveLength(7)
    expect(Object.keys(SCOPE).sort()).toEqual([...SCOPE_KEYS].sort())
  })

  it('matches the frozen corpus VERBATIM, claim by claim', () => {
    for (const key of SCOPE_KEYS) {
      expect(SCOPE[key], `${key} was reworded`).toBe(FROZEN[key])
    }
  })

  /**
   * The phrases the disclosure exists to say. Asserted independently of the byte-diff
   * above, because a lockstep edit to both places passes that one and this one still
   * fails — and these are the phrases whose disappearance changes what a reader concludes.
   */
  it('preserves the phrases the disclosure exists to say', () => {
    expect(SCOPE.soundness).toContain('sound modulo atomization')
    expect(SCOPE.silence).toContain('silence is not a consistency certificate')
    expect(SCOPE.overUnification).toContain('over-unification')
    expect(SCOPE.contextualAmbiguityNotChecked).toContain('not decided by symspec')
    expect(SCOPE.semanticProposeOnly).toContain('propose-only assist')
    expect(SCOPE.numericChecked).toContain('LIA/LRA')
    expect(SCOPE.coverageDemotion).toContain('demote verified, never promote')
  })

  it('renders as separate paragraphs in reading order', () => {
    const paragraphs = scopeParagraphs()
    expect(paragraphs).toHaveLength(7)
    expect(paragraphs[0]).toBe(SCOPE.soundness)
    expect(paragraphs[1]).toBe(SCOPE.silence)
    expect(paragraphs[6]).toBe(SCOPE.coverageDemotion)
  })

  it('does NOT ship a pre-joined blob', () => {
    // The donor's `SCOPE.text` is deliberately absent: a joined paragraph can fall out
    // of sync with its own parts, and neither consumer here wants it.
    expect('text' in SCOPE).toBe(false)
  })

  it('names the two claims a thin-pointer surface must not drop', () => {
    // soundness (a reported conflict is real) and silence (its absence is not a proof)
    // are the two whose omission changes what an agent CONCLUDES.
    expect(SCOPE_ESSENTIAL).toEqual([SCOPE.soundness, SCOPE.silence])
  })
})
