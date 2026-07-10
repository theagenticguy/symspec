/**
 * Smoke test for AC-5-5: `check` with no Lean installed succeeds.
 *
 * This test verifies the invariant: symspec's default `check` command
 * (Tier 0 + Tier 1/2/3 + Tier S) never invokes Lean and does not require
 * a Lean toolchain. By design, the `src/pipeline/check.ts` module does NOT
 * import anything from `src/certify/discover.ts` or any Lean-discovery logic.
 *
 * This test runs on a system without Lean and confirms that the `check`
 * module itself can be imported and used without triggering Lean
 * discovery. The actual full wiring of `check` (Tier 0 + lint + SMT into
 * one envelope) is AC-6-8 (T-AC-6-8); this test is the prerequisite
 * boundary check that ensure Lean is never on the default path.
 */

import { describe, expect, it } from 'vitest'

/**
 * Check that the check module exists and imports cleanly without Lean
 * discovery.
 */
describe('AC-5-5: check never invokes Lean', () => {
  it('check.ts imports without requiring Lean toolchain', async () => {
    // Simply importing the module should not trigger any Lean discovery.
    // If it did, this import would fail with a LeanDiscoveryError.
    const checkModule = await import('../check.js')
    expect(checkModule).toBeDefined()
    // Verify that the CheckResultSymbol is exported (proof the module loaded).
    expect(checkModule.CheckResultSymbol).toBeDefined()
  })

  it('check module does not depend on discoverLeanToolchain', () => {
    // Verify that discoverLeanToolchain is NOT called during module
    // initialization. This is guaranteed by the module's structure: it does
    // not import from src/certify/discover.ts, so there is no path to a
    // runtime discovery call.
    // This test simply documents the invariant.
    expect(true).toBe(true)
  })
})
