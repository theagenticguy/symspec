import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json' with { type: 'json' }
import { SCHEMA_VERSION } from '../../core/schema.js'
import {
  API_VERSION,
  ErrorEnvelopeSchema,
  failure,
  SuccessEnvelopeSchema,
  success,
} from '../envelope.js'
import { buildManifest, ManifestSchema } from '../manifest.js'

/**
 * AC-6-12: `apiVersion` is a distinct envelope-contract integer — bumped only
 * on a breaking envelope-shape change — independent of both the package
 * version (AC-6-7) and the document `schemaVersion` (AC-1-2). It is exposed
 * in the manifest and stamped on every success and error envelope.
 */

describe('apiVersion is an envelope-contract integer (AC-6-12)', () => {
  it('is an integer', () => {
    expect(Number.isInteger(API_VERSION)).toBe(true)
  })

  it('is a positive contract version, not a semver string', () => {
    expect(typeof API_VERSION).toBe('number')
    expect(API_VERSION).toBeGreaterThanOrEqual(1)
  })
})

describe('apiVersion equals the manifest apiVersion (AC-6-12)', () => {
  it('the manifest exposes the same API_VERSION constant', () => {
    expect(buildManifest().apiVersion).toBe(API_VERSION)
  })

  it('the manifest schema pins apiVersion as a literal, so drift fails validation', () => {
    const drifted = { ...buildManifest(), apiVersion: API_VERSION + 1 }
    expect(() => ManifestSchema.parse(drifted)).toThrow()
    expect(() => ManifestSchema.parse(buildManifest())).not.toThrow()
  })

  it('is stamped identically on success envelopes, error envelopes, and the manifest', () => {
    const ok = success('check', { findings: [] })
    const err = failure({ error: 'x', code: 'ERR_IO' })
    const manifest = buildManifest()
    expect(ok.apiVersion).toBe(API_VERSION)
    expect(err.apiVersion).toBe(API_VERSION)
    expect(manifest.apiVersion).toBe(API_VERSION)
  })
})

describe('apiVersion is NOT tied to the package version or document schemaVersion (AC-6-12)', () => {
  it('is a different kind of value than the package.json version (integer vs semver string)', () => {
    expect(typeof pkg.version).toBe('string')
    expect(typeof API_VERSION).toBe('number')
    // The semver string never parses to the contract integer by coincidence
    // of format: an integer contract version has no dots to parse.
    expect(String(API_VERSION)).not.toBe(pkg.version)
  })

  it('does not track the package major version', () => {
    const pkgMajorRaw = pkg.version.split('.')[0]
    expect(pkgMajorRaw).toBeDefined()
    const pkgMajor = Number(pkgMajorRaw)
    // The contract holds regardless of what the package major happens to be:
    // apiVersion is defined by the envelope shape alone. Assert the two are
    // sourced independently — API_VERSION is a hand-maintained constant in
    // envelope.ts, not derived from package.json.
    expect(API_VERSION).toBe(1)
    expect(pkgMajor).toBe(0) // current package major; bumping it must not move API_VERSION
    expect(API_VERSION).not.toBe(pkgMajor)
  })

  it('is independent of the document SCHEMA_VERSION constant', () => {
    // Both are integers, but they version different contracts: SCHEMA_VERSION
    // versions the persisted document shape (core/schema.ts), API_VERSION the
    // CLI envelope shape. They are separate exported constants with no
    // derivation between them — currently they even hold different values.
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    expect(API_VERSION).not.toBe(SCHEMA_VERSION)
  })

  it('the envelope schemas pin apiVersion as the contract literal, rejecting other integers', () => {
    const badSuccess = { apiVersion: SCHEMA_VERSION, type: 'check', data: {} }
    expect(() => SuccessEnvelopeSchema.parse(badSuccess)).toThrow()
    const badError = {
      apiVersion: API_VERSION + 1,
      type: 'error',
      error: 'x',
      code: 'ERR_IO',
      suggestions: [],
    }
    expect(() => ErrorEnvelopeSchema.parse(badError)).toThrow()
  })
})
