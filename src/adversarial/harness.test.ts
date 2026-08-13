/**
 * THE GENERATED-DEFECT GATE — the standing "it catches increasingly subtle bad specs" claim.
 *
 * `../formal/adversarial.test.ts` pins twelve rounds a red team already won. This is the other
 * half and the one that finds things nobody has seen: a generator emits labelled defects at
 * four escalating difficulty tiers, and every one must be both DETECTED and LOCALIZED.
 *
 * The two gates fail for different reasons, which is why both exist. A regression that lets a
 * KNOWN escape through fails the pinned rounds. A regression that lets a whole CLASS of defect
 * through — a detector narrowed, a lexicon entry made unreachable, a gate excluding
 * requirements the tier needed — fails here, on an input no author wrote by hand.
 *
 * Deterministic tiers only: no model is loaded, so CI needs no ~110 MB download, and the
 * embedding-dependent cases are SKIPPED and counted rather than silently absent.
 */

import { describe, expect, it } from 'vitest'
import { generateCases } from './generate.ts'
import { formatGaps, runHarness } from './harness.ts'

describe('every generated defect is detected AND localized', () => {
  it('across all four difficulty tiers', async () => {
    const { scores, gaps } = await runHarness(4)
    for (const score of scores) {
      // DETECTION and LOCALIZATION asserted separately: a tier that fired the right code on
      // the wrong requirements would pass a detection-only gate while being unusable.
      expect(score.detected, `tier ${score.tier} detection`).toBe(score.total)
      expect(score.localized, `tier ${score.tier} localization`).toBe(score.total)
    }
    expect(gaps.length, `\n${formatGaps(gaps)}`).toBe(0)
  })

  it('scores a NON-EMPTY ladder at every tier, so a pass cannot be vacuous', async () => {
    // The failure this guards: a generator change that emitted nothing, or a skip rule that
    // swallowed every case, would satisfy the assertions above by comparing zero to zero.
    const { scores } = await runHarness(4)
    expect(scores).toHaveLength(4)
    for (const score of scores) {
      expect(score.total, `tier ${score.tier} scored nothing`).toBeGreaterThan(0)
    }
  })

  it('DISCLOSES the cases it skipped for want of a model', async () => {
    // No silent caps: a run that quietly dropped the embedding-dependent cases would report a
    // clean ladder over less than it claims to cover.
    const { scores } = await runHarness(4)
    const skipped = scores.reduce((n, s) => n + s.skipped, 0)
    const generated = [1, 2, 3, 4].reduce((n, t) => n + generateCases(t).length, 0)
    const scored = scores.reduce((n, s) => n + s.total, 0)
    expect(scored + skipped, 'every generated case is either scored or counted as skipped').toBe(
      generated,
    )
    expect(skipped, 'the model-only cases should be the skipped ones').toBeGreaterThan(0)
  })
})

describe('the generator is a pure function of (tier, seed)', () => {
  it('is byte-identical across two calls', () => {
    // The property that makes a miss REPLAYABLE. Without it a gap report names a document
    // nobody can reconstruct.
    expect(JSON.stringify(generateCases(2, 0))).toBe(JSON.stringify(generateCases(2, 0)))
  })

  it('varies by seed and by tier, so the ladder is not one document four times', () => {
    expect(JSON.stringify(generateCases(2, 0))).not.toBe(JSON.stringify(generateCases(2, 1)))
    expect(JSON.stringify(generateCases(1, 0))).not.toBe(JSON.stringify(generateCases(4, 0)))
  })

  it('emits WELL-FORMED labels — a fixture with no ground truth scores nothing', () => {
    for (const tier of [1, 2, 3, 4]) {
      for (const testCase of generateCases(tier)) {
        expect(testCase.expectedCodes.length, `${testCase.id} expects no code`).toBeGreaterThan(0)
        expect(testCase.culpritIds.length, `${testCase.id} names no culprit`).toBeGreaterThan(0)
        expect(
          Object.keys(testCase.doc.requirements).length,
          `${testCase.id} has an empty document`,
        ).toBeGreaterThan(0)
        // The culprits must EXIST in the document, or localization can never succeed and the
        // fixture is unsatisfiable rather than hard.
        for (const id of testCase.culpritIds) {
          expect(
            testCase.doc.requirements[id],
            `${testCase.id} names absent culprit ${id}`,
          ).toBeDefined()
        }
        expect(testCase.tier).toBe(tier)
      }
    }
  })
})
