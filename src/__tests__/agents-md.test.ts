/**
 * AC-7-1/AC-7-5: the committed AGENTS.md is derived from the live manifest —
 * never hand-maintained prose. These tests pin the single-source property by
 * asserting the committed file contains strings read from `buildManifest()`
 * AT TEST TIME: mutate any command summary or code `.describe()` and the
 * committed doc no longer matches until regenerated (`pnpm gen:agents`),
 * failing here and in the pre-push `check:agents` diff gate.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildManifest } from '../cli/manifest.js'

const agentsMd = readFileSync(resolve(import.meta.dirname, '..', '..', 'AGENTS.md'), 'utf8')
const manifest = buildManifest()

describe('AGENTS.md single-source derivation (AC-7-5)', () => {
  it('is marked generated', () => {
    expect(agentsMd).toContain('GENERATED FILE')
    expect(agentsMd).toContain('pnpm gen:agents')
  })

  it('contains every command name and its live manifest summary', () => {
    for (const { name, summary } of manifest.commands) {
      expect(agentsMd).toContain(`\`symspec ${name}\``)
      expect(agentsMd).toContain(summary)
    }
  })

  it('contains every code from all three catalogs with its live description', () => {
    for (const table of [manifest.codes.error, manifest.codes.gtwr, manifest.codes.fnd]) {
      for (const { code, description } of table) {
        expect(agentsMd).toContain(`\`${code}\``)
        if (description !== undefined) expect(agentsMd).toContain(description)
      }
    }
  })

  it('quotes the honest-scope disclosure verbatim from the manifest', () => {
    expect(agentsMd).toContain(manifest.scope.soundness)
    expect(agentsMd).toContain(manifest.scope.silence)
    expect(agentsMd).toContain(manifest.scope.contextualAmbiguityNotChecked)
  })

  it('states the live apiVersion and every envelope type', () => {
    expect(agentsMd).toContain(`"apiVersion": ${manifest.apiVersion}`)
    for (const t of manifest.types) expect(agentsMd).toContain(`\`${t}\``)
  })

  it('carries no v1 machinery tokens (SC-1/SC-2)', () => {
    expect(agentsMd).not.toMatch(/Automerge|CRDT|MCP|Bedrock|three-tier|arbiter|ensemble|migrat/i)
  })
})
