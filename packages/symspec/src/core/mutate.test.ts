/**
 * The op vocabulary and the mutation fold.
 *
 * Two things are being established here, and they are different claims:
 *
 * 1. **The vocabulary is closed and reachable.** Every verb in `OP_VERBS` decodes,
 *    every decodable verb is in `OP_VERBS`, and a misspelled field FAILS. The
 *    reachability half is the lesson from `lexicon-entries-need-per-entry-
 *    reachability-tests`: a listed-but-unreachable entry is dead code that
 *    advertises a capability, and only a per-entry assertion finds it.
 * 2. **The fold's semantics are the donor's.** Idempotence where the donor was
 *    idempotent, no-ops where the donor no-op'd, the five-way re-render gate, the
 *    pattern-aware clear guard, and — the one with teeth — resolution against the
 *    RUNNING document so an intra-batch key resolves.
 */

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DOC_VERSION,
  emptyDocument,
  NULLABLE_ATTRS,
  type RequirementsDocument,
  UPDATABLE_ATTRS,
} from './document.ts'
import { applyOp, foldOps, isOpFailure, type OpSuccess } from './mutate.ts'
import { type DocumentOp, decodeOp, EDGE_OP_RELATION, OP_VERBS, opLine } from './ops.ts'

const TS = '2026-01-01T00:00:00.000Z'

/** Decode an op, or throw the schema error — a test helper, so a malformed fixture
 * fails loudly at its own line rather than as a mystery downstream. */
const op = (raw: unknown): DocumentOp =>
  Effect.runSync(Schema.decodeUnknownEffect(Schema.Unknown)(raw).pipe(Effect.flatMap(decodeOp)))

/** Apply one op and assert it succeeded, returning the success. */
const ok = (doc: RequirementsDocument, raw: unknown): OpSuccess => {
  const result = applyOp(doc, op(raw), TS)
  if (isOpFailure(result)) throw new Error(`expected success, got ${result.code}: ${result.error}`)
  return result
}

/** A document with one keyed ubiquitous requirement, for the ref-resolution cases. */
const withOne = (): { doc: RequirementsDocument; id: string } => {
  const result = ok(emptyDocument(), {
    op: 'add',
    key: 'G1',
    patternType: 'ubiquitous',
    systemName: 'auth service',
    systemResponse: 'log every attempt',
  })
  if (result.id === undefined) throw new Error('add produced no id')
  return { doc: result.document, id: result.id }
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the op vocabulary is closed, reachable, and strict', () => {
  /**
   * One minimal VALID record per verb. Written out rather than generated, because
   * the point is to prove each verb is reachable THROUGH THE DECODER with a payload
   * a caller would plausibly write — a generated fixture would be derived from the
   * same schema it is meant to test.
   */
  const MINIMAL: Record<string, unknown> = {
    add: { op: 'add', patternType: 'ubiquitous', systemName: 's', systemResponse: 'r' },
    update: { op: 'update', ref: 'G1', attr: 'status', value: 'approved' },
    delete: { op: 'delete', ref: 'G1' },
    derive: { op: 'derive', from: 'G1', to: 'G2' },
    satisfy: { op: 'satisfy', from: 'G1', to: 'G2' },
    verify: { op: 'verify', from: 'G1', to: 'G2' },
    refine: { op: 'refine', from: 'G1', to: 'G2' },
    'remove-edge': { op: 'remove-edge', from: 'G1', relation: 'derives', to: 'G2' },
    glossary: { op: 'glossary', canonical: 'c', alias: 'a' },
    antonym: { op: 'antonym', a: 'open', b: 'shut' },
    waive: { op: 'waive', code: 'GTWR_R1_PATTERN', reason: 'reviewed' },
    unwaive: { op: 'unwaive', code: 'GTWR_R1_PATTERN' },
    unglossary: { op: 'unglossary', canonical: 'c', alias: 'a' },
    unantonym: { op: 'unantonym', a: 'open', b: 'shut' },
  }

  it.each(
    OP_VERBS.map((verb) => [verb] as const),
  )('%s is REACHABLE through the decoder', (verb) => {
    // The reachability half: a verb listed in OP_VERBS that the union cannot decode
    // would be advertised in the manifest and rejected at runtime.
    const raw = MINIMAL[verb]
    expect(raw, `no minimal fixture for the "${verb}" verb`).toBeDefined()
    const decoded = Effect.runSync(Effect.result(decodeOp(raw)))
    expect(decoded._tag, `"${verb}" failed to decode`).toBe('Success')
  })

  it('has a fixture for every verb and no fixture for a verb that does not exist', () => {
    // The other direction: a verb the union decodes but OP_VERBS omits would be
    // invisible in the manifest while working at runtime — an undocumented feature.
    expect(Object.keys(MINIMAL).sort()).toEqual([...OP_VERBS].sort())
  })

  it('REJECTS an unknown verb, so a typo is not silently skipped', () => {
    const decoded = Effect.runSync(Effect.result(decodeOp({ op: 'ad', patternType: 'ubiquitous' })))
    expect(decoded._tag).toBe('Failure')
  })

  it('REJECTS a misspelled FIELD rather than dropping it', () => {
    // The onExcessProperty guard. Without it `systemRespones` would decode to an
    // `add` missing its response — the same species as the beta.102 record-key
    // silent-drop, reached through a different door.
    const decoded = Effect.runSync(
      Effect.result(
        decodeOp({
          op: 'add',
          patternType: 'ubiquitous',
          systemName: 's',
          systemResponse: 'r',
          systemRespones: 'typo',
        }),
      ),
    )
    expect(decoded._tag).toBe('Failure')
  })

  it('EDGE_OP_RELATION is a bijection onto the four relations', () => {
    const relations = Object.values(EDGE_OP_RELATION)
    expect([...relations].sort()).toEqual(['derives', 'refines', 'satisfies', 'verifies'])
    expect(new Set(relations).size).toBe(relations.length)
  })

  it('`update` accepts only UPDATABLE_ATTRS, and rejects the immutable handles', () => {
    for (const attr of UPDATABLE_ATTRS) {
      const decoded = Effect.runSync(
        Effect.result(decodeOp({ op: 'update', ref: 'G1', attr, value: 'x' })),
      )
      expect(decoded._tag, `${attr} should be updatable`).toBe('Success')
    }
    // The four the vocabulary must NOT admit, each for its own documented reason.
    for (const attr of ['id', 'key', 'sentence', 'createdAt']) {
      const decoded = Effect.runSync(
        Effect.result(decodeOp({ op: 'update', ref: 'G1', attr, value: 'x' })),
      )
      expect(decoded._tag, `${attr} must not be updatable`).toBe('Failure')
    }
  })

  it('`opLine` round-trips through the decoder', () => {
    // The property the repair round-trip depends on: an op a finding emits is an op
    // `apply` can read back. If this broke, `repair.ops` would be decorative.
    for (const verb of OP_VERBS) {
      const original = op(MINIMAL[verb])
      const reparsed = Effect.runSync(decodeOp(JSON.parse(opLine(original)) as unknown))
      expect(reparsed).toEqual(original)
    }
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('add', () => {
  it('mints a UUID, renders the sentence, and fills the defaults', () => {
    const { doc, id } = withOne()
    const created = doc.requirements[id]
    expect(created).toBeDefined()
    expect(created?.sentence).toBe('The auth service shall log every attempt.')
    expect(created?.priority).toBe('medium')
    expect(created?.status).toBe('draft')
    expect(created?.negated).toBe(false)
    expect(created?.derives).toEqual([])
    expect(created?.createdAt).toBe(TS)
    // The minted id is a UUID, which is what the document schema requires.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('renders `shall not` from the negated FLAG, leaving the response positive', () => {
    // The load-bearing polarity contract: the response text stays positive so
    // `shall X` and `shall not X` share one atom at opposite polarity.
    const result = ok(emptyDocument(), {
      op: 'add',
      patternType: 'ubiquitous',
      systemName: 'svc',
      systemResponse: 'issue a token',
      negated: true,
    })
    const created = Object.values(result.document.requirements)[0]
    expect(created?.sentence).toBe('The svc shall not issue a token.')
    expect(created?.systemResponse).toBe('issue a token')
  })

  it('refuses a duplicate supplied id and a duplicate key, writing nothing', () => {
    const { doc, id } = withOne()

    const dupId = applyOp(
      doc,
      op({ op: 'add', id, patternType: 'ubiquitous', systemName: 's', systemResponse: 'r' }),
      TS,
    )
    expect(isOpFailure(dupId) && dupId.code).toBe('ERR_DUPLICATE_ID')

    const dupKey = applyOp(
      doc,
      op({ op: 'add', key: 'G1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'r' }),
      TS,
    )
    expect(isOpFailure(dupKey) && dupKey.code).toBe('ERR_DUPLICATE_KEY')

    // Neither attempt touched the document.
    expect(Object.keys(doc.requirements)).toHaveLength(1)
  })

  it('never mutates the input document', () => {
    const before = emptyDocument()
    ok(before, { op: 'add', patternType: 'ubiquitous', systemName: 's', systemResponse: 'r' })
    expect(Object.keys(before.requirements)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('resolves a ref by KEY and persists the UUID', () => {
    const { doc, id } = withOne()
    const result = ok(doc, { op: 'update', ref: 'G1', attr: 'status', value: 'approved' })
    expect(result.id).toBe(id)
    expect(result.document.requirements[id]?.status).toBe('approved')
  })

  it('re-renders `sentence` for an EARS slot and NOT for metadata', () => {
    const { doc, id } = withOne()

    const slot = ok(doc, {
      op: 'update',
      ref: 'G1',
      attr: 'systemResponse',
      value: 'reject logins',
    })
    expect(slot.document.requirements[id]?.sentence).toBe('The auth service shall reject logins.')

    const meta = ok(doc, { op: 'update', ref: 'G1', attr: 'priority', value: 'high' })
    // The five-way gate: a metadata edit leaves the stored sentence byte-identical.
    expect(meta.document.requirements[id]?.sentence).toBe(doc.requirements[id]?.sentence)
  })

  it('stores the literal string "null" as TEXT, not as a clear', () => {
    // The donor needed a `--clear` flag precisely because argv cannot distinguish
    // these. JSON can, so the op does.
    const { doc, id } = withOne()
    const result = ok(doc, { op: 'update', ref: 'G1', attr: 'verificationNote', value: 'null' })
    expect(result.document.requirements[id]?.verificationNote).toBe('null')
  })

  it('CLEARS a nullable attr by OMITTING the key, never by writing undefined', () => {
    const { doc, id } = withOne()
    const set = ok(doc, { op: 'update', ref: 'G1', attr: 'verificationNote', value: 'suite X' })
    const cleared = ok(set.document, {
      op: 'update',
      ref: 'G1',
      attr: 'verificationNote',
      value: null,
    })
    const requirement = cleared.document.requirements[id]
    expect(requirement).toBeDefined()
    // Absence is an ABSENT KEY — what keeps a save byte-stable and what
    // exactOptionalPropertyTypes means all the way to the file.
    expect(requirement !== undefined && 'verificationNote' in requirement).toBe(false)
  })

  it('refuses to clear a non-nullable attr', () => {
    const { doc } = withOne()
    const result = applyOp(doc, op({ op: 'update', ref: 'G1', attr: 'status', value: null }), TS)
    expect(isOpFailure(result) && result.code).toBe('ERR_NULL_REQUIRED')
  })

  it('refuses to clear a slot the requirement`s OWN pattern needs', () => {
    // The pattern-aware guard, which is STRICTER than schema nullability: `trigger`
    // is in NULLABLE_ATTRS, and clearing it here would render "When , the ...".
    expect(NULLABLE_ATTRS.has('trigger')).toBe(true)
    const seeded = ok(emptyDocument(), {
      op: 'add',
      key: 'E1',
      patternType: 'event-driven',
      trigger: 'a user signs in',
      systemName: 'svc',
      systemResponse: 'issue a token',
    })
    const result = applyOp(
      seeded.document,
      op({ op: 'update', ref: 'E1', attr: 'trigger', value: null }),
      TS,
    )
    expect(isOpFailure(result) && result.code).toBe('ERR_NULL_REQUIRED')
    expect(isOpFailure(result) && result.error).toContain('the pattern requires it')

    // ...and the SAME clear is legal on a ubiquitous requirement, which is what
    // makes this a pattern rule rather than a blanket refusal.
    const ubiquitous = ok(emptyDocument(), {
      op: 'add',
      key: 'U1',
      patternType: 'ubiquitous',
      trigger: 'a user signs in',
      systemName: 'svc',
      systemResponse: 'issue a token',
    })
    const allowed = applyOp(
      ubiquitous.document,
      op({ op: 'update', ref: 'U1', attr: 'trigger', value: null }),
      TS,
    )
    expect(isOpFailure(allowed)).toBe(false)
  })

  it('reports ERR_NOT_FOUND for an unknown ref', () => {
    const { doc } = withOne()
    const result = applyOp(
      doc,
      op({ op: 'update', ref: 'NOPE', attr: 'status', value: 'approved' }),
      TS,
    )
    expect(isOpFailure(result) && result.code).toBe('ERR_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// Edges and delete
// ---------------------------------------------------------------------------

describe('edges and delete', () => {
  /** Two keyed requirements, for the edge cases. */
  const withTwo = (): RequirementsDocument => {
    const a = ok(emptyDocument(), {
      op: 'add',
      key: 'G1',
      patternType: 'ubiquitous',
      systemName: 's',
      systemResponse: 'do a',
    })
    return ok(a.document, {
      op: 'add',
      key: 'S1',
      patternType: 'ubiquitous',
      systemName: 's',
      systemResponse: 'do b',
    }).document
  }

  it('adds each relation, addressed by key, storing UUIDs', () => {
    let doc = withTwo()
    for (const [verb, relation] of Object.entries(EDGE_OP_RELATION)) {
      const result = ok(doc, { op: verb, from: 'G1', to: 'S1' })
      doc = result.document
      const source = Object.values(doc.requirements).find((r) => r.key === 'G1')
      const target = Object.values(doc.requirements).find((r) => r.key === 'S1')
      expect(
        source?.[relation as keyof typeof EDGE_OP_RELATION extends never ? never : 'derives'],
      ).toBeDefined()
      // The stored value is the resolved UUID, never the raw key.
      expect(source?.[relation]).toContain(target?.id)
    }
  })

  it('is IDEMPOTENT: re-adding an edge is a no-op success', () => {
    const doc = withTwo()
    const first = ok(doc, { op: 'derive', from: 'G1', to: 'S1' })
    expect(first.noop).toBe(false)
    const second = ok(first.document, { op: 'derive', from: 'G1', to: 'S1' })
    expect(second.noop).toBe(true)
    // And the edge is still exactly one.
    const source = Object.values(second.document.requirements).find((r) => r.key === 'G1')
    expect(source?.derives).toHaveLength(1)
  })

  it('remove-edge is a no-op when the edge is already absent', () => {
    const doc = withTwo()
    const result = ok(doc, { op: 'remove-edge', from: 'G1', relation: 'derives', to: 'S1' })
    expect(result.noop).toBe(true)
  })

  it('remove-edge removes exactly the named edge', () => {
    const doc = withTwo()
    const added = ok(doc, { op: 'derive', from: 'G1', to: 'S1' })
    const removed = ok(added.document, {
      op: 'remove-edge',
      from: 'G1',
      relation: 'derives',
      to: 'S1',
    })
    expect(removed.noop).toBe(false)
    const source = Object.values(removed.document.requirements).find((r) => r.key === 'G1')
    expect(source?.derives).toEqual([])
  })

  it('delete accepts ref OR id, and leaves inbound edges DANGLING rather than cascading', () => {
    const doc = withTwo()
    const linked = ok(doc, { op: 'derive', from: 'G1', to: 'S1' })
    const target = Object.values(linked.document.requirements).find((r) => r.key === 'S1')
    expect(target).toBeDefined()

    const deleted = ok(linked.document, { op: 'delete', id: 'S1' })
    expect(Object.keys(deleted.document.requirements)).toHaveLength(1)
    const source = Object.values(deleted.document.requirements).find((r) => r.key === 'G1')
    // The edge SURVIVES as a dangling reference — `check` reports it; the delete
    // does not silently rewrite a requirement the caller did not name.
    expect(source?.derives).toEqual([target?.id])
  })
})

// ---------------------------------------------------------------------------
// The side tables
// ---------------------------------------------------------------------------

describe('the side tables', () => {
  it('glossary add merges into an existing canonical, and is idempotent', () => {
    const first = ok(emptyDocument(), {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'grant a token',
    })
    expect(first.document.glossary).toEqual([
      { canonical: 'issue a token', aliases: ['grant a token'] },
    ])

    // A SECOND alias merges into the same entry rather than creating a second one —
    // the donor emits one command per alias, so a naive append would produce N
    // single-alias entries where the source had one N-alias entry.
    const second = ok(first.document, {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'mint a token',
    })
    expect(second.document.glossary).toHaveLength(1)
    expect(second.document.glossary[0]?.aliases).toEqual(['grant a token', 'mint a token'])

    const again = ok(second.document, {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'mint a token',
    })
    expect(again.noop).toBe(true)
  })

  it('unglossary drops an emptied group entirely', () => {
    const added = ok(emptyDocument(), { op: 'glossary', canonical: 'c', alias: 'a' })
    const removed = ok(added.document, { op: 'unglossary', canonical: 'c', alias: 'a' })
    // A canonical with no aliases unifies nothing, so keeping it would be a row that
    // looks like a decision and is not.
    expect(removed.document.glossary).toEqual([])
  })

  it('antonym is UNORDERED and idempotent in either order', () => {
    const first = ok(emptyDocument(), { op: 'antonym', a: 'open', b: 'shut' })
    expect(first.document.antonyms).toEqual([{ a: 'open', b: 'shut' }])
    const reversed = ok(first.document, { op: 'antonym', a: 'shut', b: 'open' })
    expect(reversed.noop).toBe(true)
    const unantonym = ok(reversed.document, { op: 'unantonym', a: 'shut', b: 'open' })
    expect(unantonym.document.antonyms).toEqual([])
  })

  it('antonym refuses a self-pair', () => {
    const result = applyOp(emptyDocument(), op({ op: 'antonym', a: 'open', b: 'open' }), TS)
    expect(isOpFailure(result) && result.code).toBe('ERR_USAGE')
    expect(isOpFailure(result) && result.error).toContain('cannot be its own antonym')
  })

  it('antonym refuses a pair the injected validator rejects', () => {
    // The false-contradiction guard. An antonym is the one committed record whose
    // wrong value MANUFACTURES a conflict, so an inconsistent pair must fail at
    // WRITE time — which keeps the check path throw-free.
    const result = applyOp(emptyDocument(), op({ op: 'antonym', a: 'open', b: 'shut' }), TS, {
      validateAntonyms: () => 'inconsistent polarity cycle',
    })
    expect(isOpFailure(result) && result.code).toBe('ERR_USAGE')
    // The validator's own message is carried through verbatim, not paraphrased —
    // it names the actual inconsistency and the op layer cannot reconstruct it.
    expect(isOpFailure(result) && result.error).toContain('inconsistent polarity cycle')
    // ...and the suggestions explain WHY that matters, which the validator does not.
    expect(isOpFailure(result) ? result.suggestions.join(' ') : '').toContain('odd polarity cycle')
  })

  it('antonym normalizes both heads through the injected normalizer', () => {
    const result = ok(emptyDocument(), { op: 'antonym', a: ' Open ', b: 'SHUT' })
    // Default normalizer is a trim, so casing survives; the operation layer supplies
    // the atomizer's real `normalize`, which is what makes a committed pair match
    // what the atomizer looks up.
    expect(result.document.antonyms).toEqual([{ a: 'Open', b: 'SHUT' }])

    const lowered = ok(emptyDocument(), { op: 'antonym', a: ' Open ', b: 'SHUT' })
    expect(lowered.document.antonyms[0]?.a).toBe('Open')

    const normalized = applyOp(emptyDocument(), op({ op: 'antonym', a: ' Open ', b: 'SHUT' }), TS, {
      normalizeHead: (s) => s.trim().toLowerCase(),
    })
    expect(isOpFailure(normalized)).toBe(false)
    expect((normalized as OpSuccess).document.antonyms).toEqual([{ a: 'open', b: 'shut' }])
  })

  it('waive stores an unscoped waiver, and resolves a KEY scope to the UUID', () => {
    const { doc, id } = withOne()

    const unscoped = ok(doc, { op: 'waive', code: 'GTWR_R1_PATTERN', reason: 'reviewed' })
    expect(unscoped.document.waivers).toEqual([{ code: 'GTWR_R1_PATTERN', reason: 'reviewed' }])

    const scoped = ok(doc, {
      op: 'waive',
      code: 'GTWR_R5_INDEFINITE_ARTICLE',
      reason: 'domain prose',
      ref: 'G1',
    })
    // The STORED scope is the stable UUID, so the waiver survives relabeling.
    expect(scoped.document.waivers).toEqual([
      { code: 'GTWR_R5_INDEFINITE_ARTICLE', requirementId: id, reason: 'domain prose' },
    ])
  })

  it('waive is idempotent and the FIRST reason wins', () => {
    const { doc } = withOne()
    const first = ok(doc, { op: 'waive', code: 'C', reason: 'the original justification' })
    const second = ok(first.document, { op: 'waive', code: 'C', reason: 'a different story' })
    expect(second.noop).toBe(true)
    // Re-waiving does not quietly overwrite the original audit trail.
    expect(second.document.waivers[0]?.reason).toBe('the original justification')
  })

  it('waive requires a reason', () => {
    const result = applyOp(emptyDocument(), op({ op: 'waive', code: 'C', reason: '   ' }), TS)
    expect(isOpFailure(result) && result.code).toBe('ERR_USAGE')
  })

  it('unwaive matches on code AND scope, and no-ops on an absent waiver', () => {
    const { doc, id } = withOne()
    const scoped = ok(doc, { op: 'waive', code: 'C', reason: 'r', ref: 'G1' })

    // An UNSCOPED unwaive must NOT remove a SCOPED waiver — they are different
    // records, and collapsing them would silently widen a removal.
    const wrongScope = ok(scoped.document, { op: 'unwaive', code: 'C' })
    expect(wrongScope.noop).toBe(true)
    expect(wrongScope.document.waivers).toHaveLength(1)

    const right = ok(scoped.document, { op: 'unwaive', code: 'C', ref: id })
    expect(right.document.waivers).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

describe('foldOps', () => {
  it('resolves a key minted EARLIER IN THE SAME BATCH', () => {
    // The invariant that removed the donor's label→UUID sidecar file. Resolution is
    // against the RUNNING document, so `G1` exists by the time the edge op runs.
    const ops = [
      { op: 'add', key: 'G1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do a' },
      { op: 'add', key: 'S1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do b' },
      { op: 'derive', from: 'G1', to: 'S1' },
      { op: 'update', ref: 'S1', attr: 'status', value: 'approved' },
    ].map(op)

    const result = foldOps(emptyDocument(), ops, TS)
    expect(result.summary).toEqual({ total: 4, ok: 4, failed: 0, noop: 0 })
    expect(result.write).toBe(true)

    const g1 = Object.values(result.document.requirements).find((r) => r.key === 'G1')
    const s1 = Object.values(result.document.requirements).find((r) => r.key === 'S1')
    expect(g1?.derives).toEqual([s1?.id])
    expect(s1?.status).toBe('approved')
  })

  it('ATOMIC by default: any failure writes NOTHING and reports the index', () => {
    const before = emptyDocument()
    const ops = [
      { op: 'add', key: 'G1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do a' },
      { op: 'derive', from: 'G1', to: 'MISSING' },
      { op: 'add', key: 'G2', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do c' },
    ].map(op)

    const result = foldOps(before, ops, TS)
    expect(result.write).toBe(false)
    expect(result.abortedAt).toBe(1)
    // The returned document is the ORIGINAL — an abort is a no-op, not a rollback.
    expect(Object.keys(result.document.requirements)).toHaveLength(0)
    expect(result.results[1]?.code).toBe('ERR_NOT_FOUND')
    // It stopped: the third op never ran.
    expect(result.results).toHaveLength(2)
  })

  it('continue-on-error applies what succeeds and reports each failure', () => {
    const ops = [
      { op: 'add', key: 'G1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do a' },
      { op: 'derive', from: 'G1', to: 'MISSING' },
      { op: 'add', key: 'G2', patternType: 'ubiquitous', systemName: 's', systemResponse: 'do c' },
    ].map(op)

    const result = foldOps(emptyDocument(), ops, TS, { continueOnError: true })
    expect(result.summary).toEqual({ total: 3, ok: 2, failed: 1, noop: 0 })
    expect(result.write).toBe(true)
    expect(result.abortedAt).toBeUndefined()
    expect(Object.keys(result.document.requirements)).toHaveLength(2)
    // Every entry carries its index, so a caller can map a failure back to its line.
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('an ALL-NO-OP fold is not writable, so a re-run does not touch the file', () => {
    const seeded = foldOps(
      emptyDocument(),
      [
        { op: 'add', key: 'G1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'a' },
        { op: 'add', key: 'S1', patternType: 'ubiquitous', systemName: 's', systemResponse: 'b' },
        { op: 'derive', from: 'G1', to: 'S1' },
      ].map(op),
      TS,
    )

    // Replay JUST the idempotent op: nothing changes, so nothing should be written.
    const replay = foldOps(seeded.document, [op({ op: 'derive', from: 'G1', to: 'S1' })], TS)
    expect(replay.summary.noop).toBe(1)
    expect(replay.summary.failed).toBe(0)
    expect(replay.write).toBe(false)
  })

  it('is REPRODUCIBLE for a fixed timestamp when ids are supplied', () => {
    // The determinism claim. Ids are supplied here because `add` mints a RANDOM UUID
    // by design (two identical adds ARE two requirements); with ids fixed, the same
    // stream and the same clock produce byte-identical output.
    const ops = [
      {
        op: 'add',
        id: '550e8400-e29b-41d4-a716-446655440000',
        key: 'G1',
        patternType: 'ubiquitous',
        systemName: 's',
        systemResponse: 'do a',
      },
      { op: 'glossary', canonical: 'do a', alias: 'perform a' },
      { op: 'waive', code: 'C', reason: 'r', ref: 'G1' },
    ].map(op)

    const first = foldOps(emptyDocument(), ops, TS)
    const second = foldOps(emptyDocument(), ops, TS)
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document))
  })

  it('an empty stream is a clean nothing, not a failure', () => {
    const result = foldOps(emptyDocument(), [], TS)
    expect(result.summary).toEqual({ total: 0, ok: 0, failed: 0, noop: 0 })
    expect(result.write).toBe(false)
    expect(result.document.docVersion).toBe(DOC_VERSION)
  })

  it('NO success shape carries a `code` field, which is what makes isOpFailure sound', () => {
    // The guard's own guard. `isOpFailure` discriminates on `'code' in result`, so a
    // success shape growing a `code` field would reclassify every success as an
    // error — silently, and everywhere.
    const success = ok(emptyDocument(), {
      op: 'add',
      patternType: 'ubiquitous',
      systemName: 's',
      systemResponse: 'r',
    })
    expect('code' in success).toBe(false)
    const requirement = Object.values(success.document.requirements)[0]
    expect(requirement !== undefined && 'code' in requirement).toBe(false)
  })
})
