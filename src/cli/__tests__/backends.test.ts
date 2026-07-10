import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BackendsReportSchema, collectBackends } from '../backends.js'
import { buildManifestWithBackends, ManifestSchema } from '../manifest.js'

/**
 * AC-6-14: the `manifest` command reports, as structured `backends` data, the
 * availability and resolved path/version of each optional backend so an agent
 * can query-then-decide before invoking `certify`/`--solver`.
 *
 *   - z3-wasm is ALWAYS available (in-process WASM; no PATH binary needed).
 *   - z3/cvc5 binary + Lean toolchain report available + resolved path/version
 *     when present, and `available: false` when absent.
 *
 * The two optional backends are environment-dependent, so those assertions
 * branch on whether the tool is actually discoverable here — but in BOTH
 * branches the report must be shape-valid and internally consistent (a
 * resolved path/version present exactly when `available` is true).
 */

/** True if `<bin> --version` succeeds — mirrors the discovery probes' liveness test. */
function toolAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('collectBackends (AC-6-14)', () => {
  it('reports z3-wasm as available with a version string — no PATH binary required', async () => {
    // Empty PATH: no external z3/cvc5/lean can be discoverable. The in-process
    // WASM backend must still report available because it never shells out.
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const backends = await collectBackends()
      expect(backends['z3-wasm'].available).toBe(true)
      if (backends['z3-wasm'].available) {
        expect(typeof backends['z3-wasm'].version).toBe('string')
        expect(backends['z3-wasm'].version.length).toBeGreaterThan(0)
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('the whole report validates against BackendsReportSchema', async () => {
    const backends = await collectBackends()
    expect(() => BackendsReportSchema.parse(backends)).not.toThrow()
  })

  it('reports the binary backend consistently with real z3/cvc5 discoverability', async () => {
    const backends = await collectBackends()
    const binary = backends.binary
    const present = toolAvailable('z3') || toolAvailable('cvc5')
    expect(binary.available).toBe(present)
    if (binary.available) {
      // Present → carries a resolved path, version, family, and source.
      expect(binary.path.length).toBeGreaterThan(0)
      expect(typeof binary.version).toBe('string')
      expect(['z3', 'cvc5']).toContain(binary.kind)
      expect(['solver-path', 'SYMSPEC_Z3', 'PATH']).toContain(binary.source)
    } else {
      // Absent → available:false with no dangling path/version keys.
      expect(binary).toEqual({ available: false })
    }
  })

  it('reports the Lean toolchain consistently with real lean discoverability', async () => {
    const backends = await collectBackends()
    const lean = backends.lean
    const present = toolAvailable('lean')
    expect(lean.available).toBe(present)
    if (lean.available) {
      expect(lean.path).toBe('lean')
      expect(typeof lean.version).toBe('string')
    } else {
      expect(lean).toEqual({ available: false })
    }
  })

  it('never throws even when nothing but the WASM backend is present', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(collectBackends()).resolves.toBeDefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })
})

describe('manifest backends wiring (AC-6-14)', () => {
  it('buildManifestWithBackends embeds a schema-valid backends block', async () => {
    const manifest = await buildManifestWithBackends()
    expect(() => ManifestSchema.parse(manifest)).not.toThrow()
    expect(manifest.backends).toBeDefined()
    expect(manifest.backends?.['z3-wasm'].available).toBe(true)
  })

  it('the manifest still carries the full command inventory alongside backends', async () => {
    const manifest = await buildManifestWithBackends()
    const names = manifest.commands.map((c) => c.name)
    expect(names).toContain('certify')
    expect(names).toContain('check')
  })
})
