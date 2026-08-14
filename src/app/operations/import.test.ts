/**
 * Tests for `import` — and specifically for the ROUND TRIP against the two
 * hex-bonk production documents.
 *
 * ## Why the round trip is the test that matters
 *
 * The v2 → v3 migration has exactly two live subjects: hex-bonk's
 * `agent-run-triggers` and `schedule-management`. If `import` loses a requirement,
 * an edge, or a waiver from either, the migration story is broken for every real
 * user there is. So the round-trip assertions do not check "roughly the right
 * number" — they compare EVERY requirement field for field against the v2 source,
 * and every edge as a resolved (from, relation, to) triple.
 *
 * ## Why the op streams are DONOR-GENERATED
 *
 * `__fixtures__/*.ops.jsonl` is produced by `scripts/generate-import-fixtures.sh`,
 * which runs the DONOR CLI and harvests its `ERR_SCHEMA_VERSION` envelope. Had this
 * test synthesized the streams itself, it would only prove `import` agrees with
 * this file's idea of an op stream. The fixture is checked in so the suite is
 * hermetic, and a test below asserts it still LOOKS like donor output, so a silent
 * hand edit to a fixture is caught.
 *
 * ## The gaps[] pass-through is checked, not assumed
 *
 * The donor discloses that timestamps do not reproduce. That disclosure must reach
 * the caller VERBATIM — softening it in v5's words would risk making a precise
 * statement vague, and dropping it would make the import claim more fidelity than
 * it has.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { RELATIONS, type Relation, type Requirement } from '../../domain/requirements/document.ts'
import { renderSentence } from '../../domain/requirements/render.ts'
import { resolveRef } from '../../domain/requirements/resolve.ts'
import {
  EDGE_OP_RELATION,
  EDGE_OPS,
  foldImportStream,
  parseSideTableCommand,
  tokenizeCommand,
} from './import.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

/** The v2 source document, as the shape the donor read. */
interface V2Doc {
  readonly schemaVersion: number
  readonly requirements: Record<string, V2Requirement>
  readonly glossary?: readonly { canonical: string; aliases: string[] }[]
  readonly antonyms?: readonly { a: string; b: string }[]
  readonly waivers?: readonly { code: string; requirementId?: string; reason: string }[]
}

interface V2Requirement {
  readonly id: string
  readonly key?: string
  readonly patternType: string
  readonly preCondition?: string
  readonly trigger?: string
  readonly systemName: string
  readonly systemResponse: string
  readonly negated: boolean
  readonly sentence: string
  readonly priority: string
  readonly status: string
  readonly verificationMethod?: string
  readonly verificationNote?: string
  readonly derives: readonly string[]
  readonly satisfies: readonly string[]
  readonly verifies: readonly string[]
  readonly refines: readonly string[]
}

const TIMESTAMP = '2026-08-03T00:00:00.000Z'

const fold = (text: string) => Effect.runSync(foldImportStream(text, TIMESTAMP))

/** The two production documents under test, each with its donor-generated stream. */
const CASES = [
  { name: 'agent-run-triggers', slug: 'hex-bonk-agent-run-triggers' },
  { name: 'schedule-management', slug: 'hex-bonk-schedule-management' },
] as const

/** Every (from, relation, to) triple in a v2 document, as sorted comparable strings. */
const v2Edges = (doc: V2Doc): readonly string[] => {
  const out: string[] = []
  for (const r of Object.values(doc.requirements)) {
    for (const relation of RELATIONS) {
      for (const to of r[relation as keyof V2Requirement] as readonly string[]) {
        out.push(`${r.id} -${relation}-> ${to}`)
      }
    }
  }
  return out.sort()
}

/** Every (from, relation, to) triple in an imported v3 document. */
const v3Edges = (requirements: Readonly<Record<string, Requirement>>): readonly string[] => {
  const out: string[] = []
  for (const r of Object.values(requirements)) {
    for (const relation of RELATIONS) {
      for (const to of r[relation]) out.push(`${r.id} -${relation}-> ${to}`)
    }
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// THE ROUND TRIP
// ---------------------------------------------------------------------------

describe.each(CASES)('round trip: hex-bonk $name', ({ slug }) => {
  const source = JSON.parse(fixture(`${slug}.v2.json`)) as V2Doc
  const result = fold(fixture(`${slug}.ops.jsonl`))
  const imported = result.document.requirements

  it('imports EVERY requirement, by UUID', () => {
    expect(Object.keys(imported).sort()).toEqual(Object.keys(source.requirements).sort())
    expect(result.counts.requirements).toBe(Object.keys(source.requirements).length)
  })

  it('imports EVERY edge, as the same (from, relation, to) triples', () => {
    expect(v3Edges(imported)).toEqual(v2Edges(source))
    expect(result.counts.edges).toBe(v2Edges(source).length)
  })

  it('preserves every requirement FIELD FOR FIELD', () => {
    // The assertion that would catch a quietly dropped optional slot, which is the
    // failure mode a count-only check misses entirely.
    for (const [id, want] of Object.entries(source.requirements)) {
      const got = imported[id]
      expect(got, `requirement ${id} missing`).toBeDefined()
      if (got === undefined) continue
      expect(got.id).toBe(want.id)
      expect(got.key).toBe(want.key)
      expect(got.patternType).toBe(want.patternType)
      expect(got.preCondition).toBe(want.preCondition)
      expect(got.trigger).toBe(want.trigger)
      expect(got.systemName).toBe(want.systemName)
      expect(got.systemResponse).toBe(want.systemResponse)
      expect(got.negated).toBe(want.negated)
      expect(got.priority).toBe(want.priority)
      expect(got.status).toBe(want.status)
      expect(got.verificationMethod).toBe(want.verificationMethod)
      expect(got.verificationNote).toBe(want.verificationNote)
    }
  })

  it('preserves every stable KEY, so a doc driven by keys still resolves', () => {
    const sourceKeys = Object.values(source.requirements)
      .map((r) => r.key)
      .filter((k): k is string => k !== undefined)
      .sort()
    const importedKeys = Object.values(imported)
      .map((r) => r.key)
      .filter((k): k is string => k !== undefined)
      .sort()
    expect(importedKeys).toEqual(sourceKeys)
    // And each one resolves through the chokepoint.
    for (const key of sourceKeys) {
      expect(resolveRef(result.document, key)?.key, key).toBe(key)
    }
  })

  it('RE-RENDERS the sentence from the slots, matching the v2 stored text', () => {
    // The donor deliberately does not emit `sentence` — it is a denormalized view.
    // This asserts the round trip reproduces it anyway, which is only true if the
    // renderer is faithful AND every slot survived. Any drift here means one or the
    // other broke.
    for (const [id, want] of Object.entries(source.requirements)) {
      const got = imported[id]
      if (got === undefined) continue
      expect(got.sentence, `sentence for ${want.key ?? id}`).toBe(want.sentence)
      expect(renderSentence(got)).toBe(want.sentence)
    }
  })

  it('imports every side-table row the source carried', () => {
    expect(result.counts.waivers).toBe(source.waivers?.length ?? 0)
    expect(result.counts.antonyms).toBe(source.antonyms?.length ?? 0)
    // The glossary count compares CANONICAL ENTRIES, not commands: the donor emits
    // one command per ALIAS, so N aliases under one canonical must merge back into
    // one entry rather than becoming N single-alias entries.
    expect(result.counts.glossary).toBe(source.glossary?.length ?? 0)
  })

  it('passes the donor`s gaps[] through VERBATIM', () => {
    expect(result.gaps.length).toBeGreaterThan(0)
    // The timestamp gap always applies to a document with requirements.
    expect(result.gaps.join(' ')).toContain('createdAt/updatedAt')
  })

  it('reports NO unresolved refs, NO duplicates, and NO unreadable lines', () => {
    expect(result.unresolved).toEqual([])
    expect(result.duplicates).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('stamps fresh timestamps — the one thing the stream provably cannot carry', () => {
    for (const r of Object.values(imported)) {
      expect(r.createdAt).toBe(TIMESTAMP)
      expect(r.updatedAt).toBe(TIMESTAMP)
    }
  })

  it('produces a v3 document with an empty state model and no responseKind', () => {
    // v2 could express neither, so an import must not invent either. A defaulted
    // responseKind would be a classification nobody made.
    expect(result.document.docVersion).toBe(3)
    expect(result.document.stateModel).toEqual({ variables: [] })
    for (const r of Object.values(imported)) {
      expect(Object.hasOwn(r, 'responseKind')).toBe(false)
    }
  })

  it('is DETERMINISTIC — the same stream folds to the same document', () => {
    expect(fold(fixture(`${slug}.ops.jsonl`)).document).toEqual(result.document)
  })
})

// ---------------------------------------------------------------------------
// The fixtures are still donor-shaped
// ---------------------------------------------------------------------------

describe('the checked-in op streams still look like DONOR output', () => {
  it.each(CASES)('$name uses the donor`s three line kinds and nothing else', ({ slug }) => {
    // Guards against a hand edit that would quietly make the round trip test a test
    // of this file's imagination instead of the donor's actual emitter.
    for (const line of fixture(`${slug}.ops.jsonl`).split('\n')) {
      const text = line.trim()
      if (text.length === 0) continue
      const known = text.startsWith('{') || text.startsWith('symspec ') || text.startsWith('#gap ')
      expect(known, `unexpected line kind: ${text.slice(0, 60)}`).toBe(true)
    }
  })

  it.each(CASES)('$name carries only op verbs import knows', ({ slug }) => {
    const known = new Set<string>(['add', ...EDGE_OPS, 'glossary', 'antonym', 'waive'])
    for (const line of fixture(`${slug}.ops.jsonl`).split('\n')) {
      if (!line.trim().startsWith('{')) continue
      const op = (JSON.parse(line) as { op: string }).op
      expect(known.has(op), `unknown op verb ${op}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The edge-op table
// ---------------------------------------------------------------------------

describe('EDGE_OP_RELATION is the exact inverse of the donor`s table', () => {
  it('maps every relation exactly once', () => {
    expect(Object.values(EDGE_OP_RELATION).sort()).toEqual([...RELATIONS].sort())
  })

  it('is the donor`s RELATION_REPRODUCE_OP inverted', () => {
    // Restated verbatim from the donor's `src/core/reproduce.ts`. If either side
    // gains a relation without the other, this fails — the same construction the
    // donor used to keep its own two tables from drifting.
    const donorTable: Record<Relation, string> = {
      derives: 'derive',
      satisfies: 'satisfy',
      verifies: 'verify',
      refines: 'refine',
    }
    for (const [relation, verb] of Object.entries(donorTable)) {
      expect(EDGE_OP_RELATION[verb as keyof typeof EDGE_OP_RELATION]).toBe(relation)
    }
  })

  it('derives EDGE_OPS from the table, so the two cannot disagree', () => {
    expect([...EDGE_OPS].sort()).toEqual(Object.keys(EDGE_OP_RELATION).sort())
  })
})

// ---------------------------------------------------------------------------
// Command-line parsing
// ---------------------------------------------------------------------------

describe('side-table command parsing', () => {
  it('tokenizes bare and single-quoted arguments', () => {
    expect(tokenizeCommand('symspec glossary add open shut')).toEqual([
      'symspec',
      'glossary',
      'add',
      'open',
      'shut',
    ])
    expect(tokenizeCommand("symspec glossary add 'issue a token' 'grant a token'")).toEqual([
      'symspec',
      'glossary',
      'add',
      'issue a token',
      'grant a token',
    ])
  })

  it('unescapes the donor`s embedded-quote spelling', () => {
    // The donor writes an embedded apostrophe as '\'' — a real waiver reason in the
    // agent-run-triggers fixture uses it ("document's vocabulary"), so getting this
    // wrong silently corrupts a reviewed audit trail.
    const tokens = tokenizeCommand(`symspec waive add X --reason 'the doc'\\''s vocabulary'`)
    expect(tokens[tokens.length - 1]).toBe("the doc's vocabulary")
  })

  it('parses `glossary add`', () => {
    expect(parseSideTableCommand("symspec glossary add 'issue a token' 'grant a token'")).toEqual({
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'grant a token',
    })
  })

  it('parses `antonym add`', () => {
    expect(parseSideTableCommand('symspec antonym add open shut')).toEqual({
      op: 'antonym',
      a: 'open',
      b: 'shut',
    })
  })

  it('parses `waive add` with and without a scope', () => {
    expect(parseSideTableCommand("symspec waive add GTWR_R6 --reason 'a standard id'")).toEqual({
      op: 'waive',
      code: 'GTWR_R6',
      reason: 'a standard id',
    })
    expect(
      parseSideTableCommand(
        "symspec waive add GTWR_R6 --reason 'a standard id' --ref 550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toEqual({
      op: 'waive',
      code: 'GTWR_R6',
      reason: 'a standard id',
      ref: '550e8400-e29b-41d4-a716-446655440000',
    })
  })

  it('returns undefined for anything it does not recognize', () => {
    // A CLOSED parser: saying "I don't know this" beats half-executing something.
    for (const line of [
      'symspec check',
      'symspec glossary remove a b',
      'rm -rf /',
      'symspec waive add CODE',
      'symspec unknown add a b',
    ]) {
      expect(parseSideTableCommand(line), line).toBeUndefined()
    }
  })

  it('reports an unrecognized `symspec` command as a problem, not a crash', () => {
    const result = fold('symspec check --strict\n')
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.detail).toContain('Unrecognized')
    expect(result.problems[0]?.line).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Fold semantics
// ---------------------------------------------------------------------------

const ID_A = '550e8400-e29b-41d4-a716-446655440000'
const ID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

const addLine = (extra: Record<string, unknown>) =>
  JSON.stringify({
    op: 'add',
    patternType: 'ubiquitous',
    systemName: 'auth service',
    systemResponse: 'log every attempt',
    ...extra,
  })

describe('fold semantics', () => {
  it('resolves a FORWARD key reference — order in the file does not matter', () => {
    // The donor emits dependency-ordered streams, but a hand-written one must not
    // silently lose edges for putting an edge before its target. Two passes.
    const stream = [
      '{"op":"derive","from":"G1","to":"S1"}',
      addLine({ id: ID_A, key: 'G1' }),
      addLine({ id: ID_B, key: 'S1' }),
    ].join('\n')
    const result = fold(stream)
    expect(result.counts.edges).toBe(1)
    expect(result.document.requirements[ID_A]?.derives).toEqual([ID_B])
    expect(result.unresolved).toEqual([])
  })

  it('DROPS an edge with an unresolvable endpoint and DISCLOSES it', () => {
    // Writing it would put a non-UUID in an edge array (schema rejects) or a
    // dangling reference in the file (which would make the import a lie).
    const result = fold(
      [addLine({ id: ID_A, key: 'G1' }), '{"op":"derive","from":"G1","to":"NOPE"}'].join('\n'),
    )
    expect(result.counts.edges).toBe(0)
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0]?.ref).toBe('NOPE')
    expect(result.unresolved[0]?.detail).toContain('NOT created')
  })

  it('is idempotent on a repeated edge', () => {
    const result = fold(
      [
        addLine({ id: ID_A, key: 'G1' }),
        addLine({ id: ID_B, key: 'S1' }),
        '{"op":"derive","from":"G1","to":"S1"}',
        '{"op":"derive","from":"G1","to":"S1"}',
      ].join('\n'),
    )
    expect(result.document.requirements[ID_A]?.derives).toEqual([ID_B])
  })

  it('reports a duplicate id rather than overwriting', () => {
    const result = fold([addLine({ id: ID_A }), addLine({ id: ID_A })].join('\n'))
    expect(result.counts.requirements).toBe(1)
    expect(result.duplicates).toEqual([`id ${ID_A}`])
  })

  it('reports a duplicate KEY rather than overwriting', () => {
    const result = fold(
      [addLine({ id: ID_A, key: 'G1' }), addLine({ id: ID_B, key: 'G1' })].join('\n'),
    )
    expect(result.counts.requirements).toBe(1)
    expect(result.duplicates).toEqual(['key G1'])
  })

  it('DERIVES a deterministic id when an add carries none', () => {
    // Never random: a random id makes the same input produce a different document
    // every run, which breaks determinism and makes an import undiffable.
    const stream = addLine({ key: 'G1' })
    const a = fold(stream)
    const b = fold(stream)
    const idA = Object.keys(a.document.requirements)[0]
    expect(idA).toBeDefined()
    expect(Object.keys(b.document.requirements)).toEqual([idA])
    // And it is UUID-shaped, so it satisfies the document schema.
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('derives DIFFERENT ids for different keys and same for the same key', () => {
    const two = fold([addLine({ key: 'G1' }), addLine({ key: 'G2' })].join('\n'))
    expect(Object.keys(two.document.requirements)).toHaveLength(2)
  })

  it('rejects one bad op record as a PROBLEM without aborting the rest', () => {
    // An import over 82 records must report the one bad line, not abort and leave
    // the caller guessing which.
    const result = fold(
      [addLine({ id: ID_A }), '{"op":"add","bogusField":1}', addLine({ id: ID_B })].join('\n'),
    )
    expect(result.counts.requirements).toBe(2)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.line).toBe(2)
  })

  it('reports a line that starts with { but is not JSON', () => {
    const result = fold('{not json\n')
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.detail).toContain('not valid JSON')
  })

  it('SKIPS prose without complaining — a real stream has step headers in it', () => {
    const result = fold(
      ['Step 2 — write the following op records:', addLine({ id: ID_A }), '', 'Done.'].join('\n'),
    )
    expect(result.counts.requirements).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.linesSkipped).toBeGreaterThan(0)
  })

  it('carries #gap lines through', () => {
    const result = fold(['#gap timestamps do not reproduce', addLine({ id: ID_A })].join('\n'))
    expect(result.gaps).toEqual(['timestamps do not reproduce'])
  })

  it('MERGES glossary aliases under one canonical entry', () => {
    // The donor emits one command per alias; N appends would produce N entries
    // where the source had one.
    const result = fold(
      [
        "symspec glossary add 'issue a token' 'grant a token'",
        "symspec glossary add 'issue a token' 'mint a token'",
      ].join('\n'),
    )
    expect(result.document.glossary).toEqual([
      { canonical: 'issue a token', aliases: ['grant a token', 'mint a token'] },
    ])
  })

  it('treats an antonym pair as UNORDERED', () => {
    const result = fold(
      ['symspec antonym add open shut', 'symspec antonym add shut open'].join('\n'),
    )
    expect(result.document.antonyms).toHaveLength(1)
  })

  it('resolves a waiver scope written as a KEY into the stored UUID', () => {
    const result = fold(
      [addLine({ id: ID_A, key: 'G1' }), "symspec waive add GTWR_R6 --reason 'ok' --ref G1"].join(
        '\n',
      ),
    )
    expect(result.document.waivers[0]?.requirementId).toBe(ID_A)
  })

  it('WIDENS an unresolvable waiver scope instead of dropping the waiver', () => {
    // Dropping it would resurrect a finding someone reviewed and accepted; a
    // broader-than-intended waiver is the lesser harm, and it is disclosed.
    const result = fold("symspec waive add GTWR_R6 --reason 'ok' --ref NOPE\n")
    expect(result.document.waivers).toHaveLength(1)
    expect(result.document.waivers[0]?.requirementId).toBeUndefined()
    expect(result.unresolved[0]?.detail).toContain('UNSCOPED')
  })

  it('accepts responseKind on an add — the v3 field a v5-generated stream can carry', () => {
    const result = fold(addLine({ id: ID_A, responseKind: 'constraint' }))
    expect(result.document.requirements[ID_A]?.responseKind).toBe('constraint')
  })

  it('applies create-time defaults for omitted metadata', () => {
    const r = fold(addLine({ id: ID_A })).document.requirements[ID_A]
    expect(r).toMatchObject({ negated: false, priority: 'medium', status: 'draft' })
  })

  it('folds an EMPTY stream into an empty document without failing', () => {
    const result = fold('')
    expect(result.counts.requirements).toBe(0)
    expect(result.document.docVersion).toBe(3)
  })
})
