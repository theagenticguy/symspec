import { describe, expect, it } from 'vitest'
import { buildManifest, ManifestSchema } from '../manifest.js'
import {
  SCOPE,
  SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED,
  SCOPE_SILENCE,
  SCOPE_SOUNDNESS,
  ScopeSchema,
} from '../scope-text.js'

/**
 * AC-4-11: the manifest and finding output must document the formal tier as
 * "sound modulo atomization", state that "silence is not a consistency
 * certificate", and mark contextual ambiguity as not-checked (punted to the
 * calling agent). Verification is by grep/snapshot over the serialized manifest
 * — never a manual read.
 */

describe('honest-scope text (AC-4-11)', () => {
  it('exposes the three exact claim substrings as constants', () => {
    expect(SCOPE_SOUNDNESS).toContain('sound modulo atomization')
    expect(SCOPE_SILENCE).toContain('silence is not')
    expect(SCOPE_CONTEXTUAL_AMBIGUITY_NOT_CHECKED).toContain('contextual ambiguity is not checked')
  })

  it('the composed SCOPE.text carries every required substring', () => {
    expect(SCOPE.text).toContain('sound modulo atomization')
    expect(SCOPE.text).toContain('silence is not')
    // The full canonical phrase, not just the fragment.
    expect(SCOPE.text).toContain('silence is not a consistency certificate')
    expect(SCOPE.text).toContain('contextual ambiguity is not checked')
    // The over-unification false-positive risk and mitigation are disclosed.
    expect(SCOPE.text).toContain('over-unification')
    expect(SCOPE.text).toContain('FND_SIMILAR_UNUNIFIED')
  })

  it('the SCOPE object validates against its self-guarding schema', () => {
    expect(() => ScopeSchema.parse(SCOPE)).not.toThrow()
  })

  it('the built manifest embeds the scope disclosure and still validates', () => {
    const manifest = buildManifest()
    expect(() => ManifestSchema.parse(manifest)).not.toThrow()
    expect(manifest.scope).toEqual(SCOPE)
  })

  it('the SERIALIZED manifest greps positive for the exact AC-4-11 substrings', () => {
    // AC-4-11 verification: assert the manifest TEXT (as an agent would read
    // it) contains the exact substrings — a grep/snapshot, not a manual read.
    const serialized = JSON.stringify(buildManifest())
    expect(serialized).toContain('sound modulo atomization')
    expect(serialized).toContain('silence is not a consistency certificate')
    expect(serialized).toContain('contextual ambiguity is not checked')
  })

  it('the scope disclosure is byte-stable across builds (pure/deterministic)', () => {
    expect(JSON.stringify(buildManifest().scope)).toBe(JSON.stringify(buildManifest().scope))
  })
})
