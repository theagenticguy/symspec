/**
 * Regression gate over the Run 1–3 adversarial-eval winning rounds
 * (adversarial/eval-rounds.ts). Every case here was a real red-team WIN —
 * symspec exited 0 with `verified: true` over a z3-confirmed contradiction —
 * and each now asserts the fix that closes it:
 *   - proof cases (expectedCodes non-empty): `FND_CONTRADICTION` fires and
 *     names the planted culprits;
 *   - the abstention case (empty expectedCodes): no proof is possible, so the
 *     hardened `verified` must DEMOTE with actionable coverage reasons —
 *     the run refuses to certify instead of certifying a lie.
 * All under strict + temporal + an injected deterministic embedder, mirroring
 * the eval's `--strict --semantic --temporal` configuration.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../../src/formal/embed.js'
import { runCheck } from '../../src/pipeline/check.js'
import { evalRoundCases } from '../eval-rounds.js'

/** Deterministic hash embedder (same recipe as the SYMSPEC_EMBED_STUB). */
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(8)
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    for (let d = 0; d < 8; d++) {
      h ^= h << 13
      h ^= h >>> 17
      h ^= h << 5
      v[d] = ((h >>> 0) % 2000) / 1000 - 1
    }
    let norm = 0
    for (let d = 0; d < 8; d++) norm += (v[d] as number) ** 2
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < 8; d++) v[d] = (v[d] as number) / norm
    return v
  })

const evalOpts = {
  strict: true as const,
  temporal: {},
  semantic: { embedder: fakeEmbedder },
}

describe('adversarial eval rounds — the Run 1–3 wins are closed', () => {
  const cases = evalRoundCases()
  const proofCases = cases.filter((c) => c.expectedCodes.length > 0)
  const abstainCases = cases.filter((c) => c.expectedCodes.length === 0)

  it.each(proofCases.map((c) => [c.id, c] as const))(
    '%s → FND_CONTRADICTION naming the culprits',
    async (_id, c) => {
      const report = await runCheck(c.doc, evalOpts)
      const fired = report.findings.filter((f) => c.expectedCodes.includes(f.code))
      expect(fired.length, c.note).toBeGreaterThan(0)
      // Localization: some fired finding names ALL planted culprits.
      const localized = fired.some((f) => {
        const ids = new Set(f.requirementIds)
        return c.culpritIds.every((id) => ids.has(id))
      })
      expect(localized, `culprits ${c.culpritIds.join(', ')} named — ${c.note}`).toBe(true)
      // A proven contradiction is error severity → exit 1 territory, and the
      // eval's exact win condition (exit 0) is impossible.
      expect(report.counts.error).toBeGreaterThan(0)
    },
  )

  it.each(abstainCases.map((c) => [c.id, c] as const))(
    '%s → verified DEMOTES with actionable coverage (never certifies a lie)',
    async (_id, c) => {
      const report = await runCheck(c.doc, evalOpts)
      // No proof is expected...
      expect(report.findings.filter((f) => f.code === 'FND_CONTRADICTION')).toHaveLength(0)
      // ...so the eval's win condition (verified=true, strict pass) must be
      // unreachable: the run abstains.
      expect(report.verified).toBe(false)
      expect(report.strictGate).toBe('fail')
      expect(report.coverage.demotions.length).toBeGreaterThan(0)
      // Every demotion is actionable — carries a next step.
      for (const d of report.coverage.demotions) {
        expect(d.action.length).toBeGreaterThan(0)
      }
    },
  )

  it('the eval win condition (exit-0-shaped: no errors AND strict pass) is unreachable on every round', async () => {
    for (const c of evalRoundCases()) {
      const report = await runCheck(c.doc, evalOpts)
      const exitZeroShaped = report.counts.error === 0 && report.strictGate !== 'fail'
      expect(exitZeroShaped, `${c.id} must not certify clean — ${c.note}`).toBe(false)
    }
  })
})
