import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json' with { type: 'json' }
import { ErrCodeMeta, ErrCodeSchema } from '../../core/codes.js'
import { f } from '../../core/schema.js'
import { FndCodeMeta, FndCodeSchema } from '../../formal/codes.js'
import { GtwrCodeMeta, GtwrCodeSchema } from '../../lint/codes.js'
import { buildManifest, ManifestSchema } from '../manifest.js'

/**
 * AC-6-1: the `manifest` command emits, as JSON, the full command inventory,
 * argument schemas, and code catalogs DERIVED from the Zod schemas and their
 * `.describe()` corpus — not hand-written prose.
 */

describe('manifest (AC-6-1)', () => {
  it('the built manifest validates against its own Zod schema', () => {
    const manifest = buildManifest()
    expect(() => ManifestSchema.parse(manifest)).not.toThrow()
  })

  it('is byte-stable JSON: two builds serialize identically (pure/deterministic)', () => {
    expect(JSON.stringify(buildManifest())).toBe(JSON.stringify(buildManifest()))
  })

  it('name and version derive from the single package.json source (AC-6-7 alignment)', () => {
    const m = buildManifest()
    expect(m.name).toBe(pkg.name)
    expect(m.version).toBe(pkg.version)
  })

  it('exposes the full v2 command inventory', () => {
    const names = buildManifest().commands.map((c) => c.name)
    for (const expected of [
      'manifest',
      'init',
      'add',
      'update',
      'parse',
      'check',
      'certify',
      'list',
      'show',
      'derive',
      'satisfy',
      'remove-edge',
      'delete',
      'export',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('every command carries a JSON-Schema argument projection', () => {
    for (const cmd of buildManifest().commands) {
      const args = cmd.arguments as Record<string, unknown>
      expect(args.type).toBe('object')
    }
  })

  it("add's argument schema derives its field descriptions from the Zod .describe() corpus", () => {
    const add = buildManifest().commands.find((c) => c.name === 'add')
    expect(add).toBeDefined()
    const args = add?.arguments as {
      properties: Record<string, { description?: string }>
      required: string[]
    }
    // patternType's manifest description is byte-for-byte the schema field's
    // `.describe()` text — the transcription IS the schema, not a hand copy.
    expect(args.properties.patternType?.description).toBe(f.patternType.description)
    expect(args.properties.systemName?.description).toBe(f.systemName.description)
    // Required-vs-optional projection reflects the schema (optionals omitted).
    expect(args.required).toContain('patternType')
    expect(args.required).not.toContain('trigger')
  })

  it('the same field feeds multiple commands from one source (derivation, not copy)', () => {
    // The document-path argument is composed into every doc-bearing command;
    // its description is identical across them because they all read the one
    // Zod field — a hand-written manifest would drift between entries.
    const m = buildManifest()
    const descsFor = (cmd: string) => {
      const args = m.commands.find((c) => c.name === cmd)?.arguments as {
        properties: Record<string, { description?: string }>
      }
      return args.properties.file?.description
    }
    const initFileDesc = descsFor('init')
    expect(initFileDesc).toBeDefined()
    expect(descsFor('check')).toBe(initFileDesc)
    expect(descsFor('list')).toBe(initFileDesc)
    // The requirement id field is single-sourced from schema.ts `f.id`.
    const showArgs = m.commands.find((c) => c.name === 'show')?.arguments as {
      properties: Record<string, { description?: string }>
    }
    expect(showArgs.properties.id?.description).toBe(f.id.description)
  })

  it('the error-code table derives from the exported ErrCodeSchema enum', () => {
    const m = buildManifest()
    const codes = m.codes.error.map((e) => e.code)
    expect(codes).toEqual([...ErrCodeSchema.options])
    // A representative code is present, proving the derivation is live.
    expect(codes).toContain('ERR_DOC_NOT_FOUND')
  })

  it('the GTWR-code table derives from the exported GtwrCodeSchema enum', () => {
    const m = buildManifest()
    const codes = m.codes.gtwr.map((e) => e.code)
    expect(codes).toEqual([...GtwrCodeSchema.options])
    expect(codes).toContain('GTWR_R2_PASSIVE')
  })

  it('the FND-code table derives from the exported FndCodeSchema enum (AC-6-3)', () => {
    const m = buildManifest()
    const codes = m.codes.fnd.map((e) => e.code)
    expect(codes).toEqual([...FndCodeSchema.options])
    expect(codes).toContain('FND_CONTRADICTION')
  })

  it('every code-table row carries the single-sourced .describe() text (AC-6-3)', () => {
    const m = buildManifest()
    // ERR / GTWR / FND descriptions are byte-for-byte the `.describe()` metadata
    // on each enum's per-code corpus — the manifest transcribes the schema, it
    // does not hand-maintain a parallel table.
    for (const row of m.codes.error) {
      expect(row.description).toBe(ErrCodeMeta[row.code as keyof typeof ErrCodeMeta].description)
    }
    for (const row of m.codes.gtwr) {
      expect(row.description).toBe(GtwrCodeMeta[row.code as keyof typeof GtwrCodeMeta].description)
    }
    for (const row of m.codes.fnd) {
      expect(row.description).toBe(FndCodeMeta[row.code as keyof typeof FndCodeMeta].description)
    }
  })

  it('mutating a code .describe() changes the manifest table (AC-6-3 single-source)', () => {
    // AC-6-3 verification: edit a code's `.describe()` and observe the manifest
    // table follow. We temporarily swap one corpus entry for a re-`.describe()`d
    // literal, rebuild the manifest, and assert its row changed — then restore.
    // (`.describe()` returns a new schema; the corpus object is mutated in place
    // and restored, so this is hermetic.)
    const original = FndCodeMeta.FND_CONTRADICTION
    const before = buildManifest().codes.fnd.find(
      (r) => r.code === 'FND_CONTRADICTION',
    )?.description
    try {
      FndCodeMeta.FND_CONTRADICTION = FndCodeSchema.options.includes('FND_CONTRADICTION')
        ? (original.describe('MUTATED-DESCRIBE-FOR-TEST') as typeof original)
        : original
      const after = buildManifest().codes.fnd.find(
        (r) => r.code === 'FND_CONTRADICTION',
      )?.description
      expect(after).toBe('MUTATED-DESCRIBE-FOR-TEST')
      expect(after).not.toBe(before)
    } finally {
      FndCodeMeta.FND_CONTRADICTION = original
    }
    // Restored: the manifest is back to the real source text.
    expect(buildManifest().codes.fnd.find((r) => r.code === 'FND_CONTRADICTION')?.description).toBe(
      before,
    )
  })
})
