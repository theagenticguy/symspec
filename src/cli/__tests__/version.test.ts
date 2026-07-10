import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json' with { type: 'json' }
import { buildManifest } from '../manifest.js'
import { VERSION } from '../version.js'

/**
 * AC-6-7: symspec derives its version string from a SINGLE source
 * (`package.json`) for both the CLI (`--version`) and the manifest, eliminating
 * the v1 hardcoded-`0.1.0` duplication.
 *
 * Verification (spec): `CLI --version == manifest version == package.json
 * version`. The tri-equality below pins all three to the one source; the
 * built-binary case additionally proves the value survives tsdown bundling
 * (the JSON import is inlined, not read at runtime).
 */

describe('version single-source (AC-6-7)', () => {
  it('VERSION equals package.json version (the single source)', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('the manifest version derives from the same package.json source', () => {
    expect(buildManifest().version).toBe(VERSION)
  })

  it('the tri-equality holds: CLI VERSION == manifest version == package.json version', () => {
    // All three read the one field of the one file; a hand-copied version would
    // let any pair drift. Pinning them equal is the AC-6-7 contract.
    expect(VERSION).toBe(pkg.version)
    expect(buildManifest().version).toBe(pkg.version)
  })

  it('is a non-empty semver-shaped string', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION.length).toBeGreaterThan(0)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('the built CLI --version prints exactly package.json version (survives bundling)', () => {
    // Proves the type-asserted JSON import is inlined by tsdown into the shipped
    // `dist/cli.mjs` — the shared surface an agent invokes — rather than relying
    // on a runtime file read. Skipped when the bundle has not been built yet;
    // the pure-module tri-equality above still enforces the single-source
    // contract without a build.
    const cliBundle = fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))
    if (!existsSync(cliBundle)) {
      return
    }
    const printed = execFileSync('node', [cliBundle, '--version'], {
      encoding: 'utf8',
    }).trim()
    expect(printed).toBe(pkg.version)
  })
})
