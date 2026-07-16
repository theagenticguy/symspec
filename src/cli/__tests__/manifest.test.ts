import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json' with { type: 'json' }
import { ErrCodeMeta, ErrCodeSchema } from '../../core/codes.js'
import { f } from '../../core/schema.js'
import { FndCodeMeta, FndCodeSchema } from '../../formal/codes.js'
import { DIMENSIONS } from '../../formal/numeric.js'
import { DEFAULT_SEMANTIC_THRESHOLD } from '../../formal/semantic.js'
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
      'glossary',
      'download-model',
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

  it("apply's doc path documents the `--doc` option, not the shared `--file`", () => {
    // The flagship bug: apply's real commander option is `--doc <path>` (its
    // positional [file] is the JSONL op stream), so the manifest must tell an
    // agent to use --doc. A regression to the shared docFileOpt would document
    // --file and mislead the agent into an ERR_USAGE.
    const apply = buildManifest().commands.find((c) => c.name === 'apply')
    const args = apply?.arguments as { properties: Record<string, { description?: string }> }
    const doc = args.properties.doc?.description ?? ''
    expect(doc).toContain('`--doc <path>`')
    expect(doc).not.toContain('`--file <path>`')
    expect(doc).toContain('Example: --doc ./requirements.json')
  })

  it('surfaces the semantic tier flags with the code-sourced default threshold', () => {
    // AC-9-5: an agent discovering the manifest must see --semantic and
    // --semantic-threshold; the documented default is the ONE constant from
    // formal/semantic.ts so it cannot drift from the code.
    const check = buildManifest().commands.find((c) => c.name === 'check')
    const props = (check?.arguments as { properties: Record<string, { description?: string }> })
      .properties
    expect(props.semantic?.description).toContain('`--semantic`')
    expect(props.semantic?.description).toContain('FND_SIMILAR_SEMANTIC')
    const st = props['semantic-threshold']?.description ?? ''
    expect(st).toContain('`--semantic-threshold <n>`')
    expect(st).toContain(String(DEFAULT_SEMANTIC_THRESHOLD))
  })

  it('states the doc-path convention once at the top level (positional / --file / --doc)', () => {
    // Item 7: an agent driving from the manifest can tell, per command group,
    // how to pass the requirements-document path without reverse-engineering
    // each field. The convention prose is a single top-level field.
    const conventions = buildManifest().conventions
    expect(conventions.docPath).toContain('Positional [file]')
    expect(conventions.docPath).toContain('--file <path> option')
    expect(conventions.docPath).toContain('--doc <path> option (apply)')
  })

  it('surfaces the global --field projection flag in globalOptions', () => {
    // Item 3: an agent discovering the manifest sees --field (jq-style output
    // projection) without fail-then-learn; its description is single-sourced.
    const opts = buildManifest().globalOptions as {
      properties: Record<string, { description?: string }>
    }
    expect(opts.properties.field?.description).toContain('`--field <paths>`')
    expect(opts.properties.field?.description).toContain('jq-style')
  })

  it('exposes the numeric tier units derived from the DIMENSIONS table', () => {
    // Item 4: the unit whitelist is now in the manifest (was a separate, hidden
    // list). `units.numeric` derives from formal/numeric.ts DIMENSIONS, so an
    // agent authoring bounds sees which spellings normalize to a shared base.
    const units = buildManifest().units
    expect(units.numeric.length).toBe(DIMENSIONS.length)
    expect(units.numeric.length).toBeGreaterThan(0)
    const bases = units.numeric.map((d) => d.base)
    expect(bases).toContain('ms')
    expect(bases).toContain('B')
    const time = units.numeric.find((d) => d.base === 'ms')
    expect(time?.units.seconds).toBe(1000)
    expect(time?.units.ms).toBe(1)
    // Byte-for-byte the exported table (single-source, not a hand copy).
    expect(units.numeric).toEqual(DIMENSIONS.map((d) => ({ base: d.base, units: { ...d.units } })))
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
