/**
 * AC-34-2/3: the generative-adversarial harness regression gate. Runs the
 * deterministic (no-model) tiers and asserts every planted defect is detected
 * AND localized. This is the standing "symspec catches increasingly subtle bad
 * specs" guarantee — a regression that lets a known defect slip fails here.
 *
 * The embedding-tier cases (missing-link) are exercised in the CLI harness run
 * with `--semantic`; this test covers the deterministic floor so CI needs no
 * model download.
 */

import { describe, expect, it } from 'vitest'
import { generateCases } from '../generate.js'
import { runHarness } from '../harness.js'

describe('adversarial harness — deterministic floor (AC-34-2)', () => {
  it('detects and localizes every non-model defect across all four tiers', async () => {
    const { scores, gaps } = await runHarness(4, false)
    // Every scored case (model-only cases are skipped without --semantic) must
    // be both detected and localized.
    for (const s of scores) {
      expect(s.detected, `tier ${s.tier} detection`).toBe(s.total)
      expect(s.localized, `tier ${s.tier} localization`).toBe(s.total)
    }
    expect(gaps, `gaps: ${gaps.map((g) => g.id).join(', ')}`).toEqual([])
  })

  it('generates deterministic, valid cases per (tier, seed)', () => {
    const a = generateCases(2, 0)
    const b = generateCases(2, 0)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Every case is a well-formed labelled fixture.
    for (const c of a) {
      expect(c.expectedCodes.length).toBeGreaterThan(0)
      expect(c.culpritIds.length).toBeGreaterThan(0)
      expect(Object.keys(c.doc.requirements).length).toBeGreaterThan(0)
    }
  })
})
