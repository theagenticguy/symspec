/**
 * The honest-scope corpus, diffed against the LIVE DONOR.
 *
 * These seven sentences are the load-bearing honesty of the tool: "silence is not a
 * consistency certificate" is what stops a clean `check` from being read as a proof.
 * They were extracted programmatically rather than retyped, and this file is what makes
 * that meaningful — both sides are READ, so a divergence is a diff rather than a
 * transcription nobody checks.
 *
 * The direction of the risk is worth naming: the dangerous edit to a disclosure is not a
 * typo, it is a paraphrase that drifts toward reassurance. A byte-equality test is the
 * only guard that catches that, because a softened claim still reads fine.
 */

import { describe, expect, it } from 'vitest'
// The LIVE DONOR, by relative path from the repo root's `src/` — the same crossing the
// differential oracle and the code catalogs use.
import { SCOPE as DONOR_SCOPE } from '../../../../src/cli/scope-text.ts'
import { SCOPE, SCOPE_ESSENTIAL, SCOPE_KEYS, scopeParagraphs } from './scope.ts'

describe('the scope corpus is byte-identical to the donor', () => {
  it('carries all seven claims', () => {
    expect(SCOPE_KEYS).toHaveLength(7)
    expect(Object.keys(SCOPE).sort()).toEqual([...SCOPE_KEYS].sort())
  })

  it('matches the donor VERBATIM, claim by claim', () => {
    for (const key of SCOPE_KEYS) {
      expect(SCOPE[key], `${key} diverged from the donor`).toBe(DONOR_SCOPE[key])
    }
  })

  /**
   * The exact substrings the donor's own AC-4-11 snapshot test greps for. Kept as a
   * SEPARATE assertion from the byte-diff above, because the byte-diff would still pass
   * if someone edited BOTH sides in lockstep — and these phrases are the ones whose
   * disappearance would matter regardless of whether the two copies agree.
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
