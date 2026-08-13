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
import { normalize } from '../donor/formal/atomize.ts'
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
    // G4 — the state model. `state` is spelled with the MINIMAL legal payload (a bool
    // needs no domain), which is also the shape that proves `frame` is genuinely
    // optional on the op and defaulted by the fold.
    state: { op: 'state', name: 'lock_held', type: 'bool' },
    unstate: { op: 'unstate', name: 'lock_held' },
    'state-initial': { op: 'state-initial', predicate: 'lock_held = false' },
    classify: { op: 'classify', ref: 'G1', kind: 'constraint', expression: 'lock_held = false' },
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
  /**
   * The two glossary shapes that resolve by TABLE ORDER, refused at write time.
   *
   * `glossaryIndex` is a flat `normalize(alias) -> normalize(canonical)` map built by walking
   * the groups, and lookup is one hop. So an alias in two groups is last-write-wins, and a
   * canonical that is itself an alias never resolves. Neither errors downstream — both just
   * quietly do something other than what the author asked. `applyOp` refuses them here for the
   * same reason it validates an antonym pair here: the check path stays free of
   * "this table was incoherent" branches.
   *
   * These matter more now that `propose-glossary` emits a whole PLAN of aliases at once.
   */
  it('REFUSES an alias that already belongs to another canonical', () => {
    const base = ok(emptyDocument(), {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'grant a token',
    }).document
    const result = applyOp(
      base,
      op({ op: 'glossary', canonical: 'mint a credential', alias: 'grant a token' }),
      TS,
    )
    expect(isOpFailure(result)).toBe(true)
    if (!isOpFailure(result)) return
    expect(result.code).toBe('ERR_USAGE')
    // Names BOTH canonicals, so an author does not have to go find the other one.
    expect(result.error).toContain('issue a token')
    expect(result.error).toContain('mint a credential')
    // And the op that frees it, runnable.
    expect(result.suggestions.join(' ')).toContain('--remove')
  })

  it('REFUSES a canonical that is already an alias — one-hop resolution', () => {
    const base = ok(emptyDocument(), {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'grant a token',
    }).document
    const result = applyOp(
      base,
      op({ op: 'glossary', canonical: 'grant a token', alias: 'mint a token' }),
      TS,
    )
    expect(isOpFailure(result)).toBe(true)
    if (!isOpFailure(result)) return
    expect(result.error).toContain('cannot also be a canonical')
    expect(result.suggestions.join(' ')).toContain('one hop')
  })

  it('REFUSES an alias of itself', () => {
    const result = applyOp(
      emptyDocument(),
      op({ op: 'glossary', canonical: 'issue a token', alias: 'issue a token' }),
      TS,
    )
    expect(isOpFailure(result)).toBe(true)
  })

  /**
   * Case-only spellings are ONE group, and `--remove` reaches it.
   *
   * Exact-string matching made `"Issue a token"` and `"issue a token"` two groups that
   * `glossaryIndex` then collapsed onto one key — the same defect arriving by a different
   * door. The removal half has to match the same way, or the refusal above would point at an
   * `--remove` that no-ops and leave the author stuck with a row they cannot free.
   */
  it('treats case-only variants as ONE group, in both directions', () => {
    // `normalizeHead` INJECTED, the way `operations/mutation.ts` wires it. Without it the
    // fallback is a bare trim, so the collision checks are case-sensitive — which is the
    // documented default for a caller with no atomizer, and not what the CLI does.
    const withNorm = (doc: RequirementsDocument, raw: unknown): OpSuccess => {
      const result = applyOp(doc, op(raw), TS, { normalizeHead: normalize })
      if (isOpFailure(result)) throw new Error(`expected success, got ${result.code}`)
      return result
    }
    const first = withNorm(emptyDocument(), {
      op: 'glossary',
      canonical: 'issue a token',
      alias: 'grant a token',
    }).document
    const second = withNorm(first, {
      op: 'glossary',
      canonical: 'Issue a token',
      alias: 'mint a token',
    })
    expect(second.document.glossary).toHaveLength(1)
    // The AUTHOR'S original spelling survives — committing an alias must not silently edit a
    // row the author did not name.
    expect(second.document.glossary[0]?.canonical).toBe('issue a token')
    expect(second.document.glossary[0]?.aliases).toEqual(['grant a token', 'mint a token'])

    const removed = withNorm(second.document, {
      op: 'unglossary',
      canonical: 'ISSUE A TOKEN',
      alias: 'Grant A Token',
    })
    expect(removed.noop).toBe(false)
    expect(removed.document.glossary[0]?.aliases).toEqual(['mint a token'])
  })

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

// ---------------------------------------------------------------------------
// The state model (G4)
// ---------------------------------------------------------------------------

/**
 * The four state-model ops, and the two doors onto the V14/V21 hazard they close.
 *
 * The hazard is worth restating because it shapes every case here: an undeclared
 * symbol reaching Z3's Fixedpoint was measured to hang the WASM past 45s with no
 * JS-side recovery, on both 4.16.0 and 5.0.0. So a document must never be able to
 * CONTAIN an expression naming an undeclared variable — and there are exactly three
 * ways one could get in:
 *
 *   1. writing the expression against a model that lacks the variable  → `classify`
 *   2. writing it through the raw attribute, bypassing `classify`      → `update`
 *   3. writing it correctly, then REMOVING the variable underneath it  → `unstate`
 *
 * All three are refused, and each has its own case below. The third is the one a
 * reasonable implementation forgets.
 */
describe('the state-model ops (G4)', () => {
  /** A document with one keyed requirement AND a declared bool + int + enum. */
  const withModel = (): { doc: RequirementsDocument; id: string } => {
    const { doc, id } = withOne()
    let current = doc
    for (const raw of [
      { op: 'state', name: 'lock_held', type: 'bool', initial: 'lock_held = false' },
      { op: 'state', name: 'pending', type: 'bool' },
      { op: 'state', name: 'retry_count', type: 'int', min: 0, max: 5 },
      { op: 'state', name: 'run_state', type: 'enum', domain: ['PENDING', 'RUNNING', 'DONE'] },
    ]) {
      current = ok(current, raw).document
    }
    return { doc: current, id }
  }

  /** Apply an op expecting FAILURE, returning it. */
  const bad = (doc: RequirementsDocument, raw: unknown) => {
    const result = applyOp(doc, op(raw), TS)
    if (!isOpFailure(result)) throw new Error(`expected failure, got success`)
    return result
  }

  // -------------------------------------------------------------------------
  // Declaration
  // -------------------------------------------------------------------------

  it('declares a variable, defaulting `frame` to the SOUND value', () => {
    const result = ok(emptyDocument(), { op: 'state', name: 'lock_held', type: 'bool' })
    const variable = result.document.stateModel.variables[0]
    expect(variable?.name).toBe('lock_held')
    // THE soundness default. `stable` would make the tool prove a false answer and
    // hand back an inductive invariant certifying it (donor V16, measured). A missing
    // declaration may only ever WEAKEN a claim.
    expect(variable?.frame).toBe('volatile')
  })

  it('carries an explicit `frame: stable` through when the author opts in', () => {
    const result = ok(emptyDocument(), {
      op: 'state',
      name: 'lock_held',
      type: 'bool',
      frame: 'stable',
    })
    expect(result.document.stateModel.variables[0]?.frame).toBe('stable')
  })

  it('REDECLARATION replaces rather than duplicating, and is not an error', () => {
    // Authoring is iterative — declare an int, then bound it, then mark it stable —
    // so forcing an `unstate` between edits would make a repair plan order-dependent
    // for no benefit.
    const once = ok(emptyDocument(), { op: 'state', name: 'retry_count', type: 'int' })
    const twice = ok(once.document, {
      op: 'state',
      name: 'retry_count',
      type: 'int',
      min: 0,
      max: 3,
    })
    expect(twice.document.stateModel.variables).toHaveLength(1)
    const variable = twice.document.stateModel.variables[0]
    expect(variable?.type === 'int' && variable.domain).toEqual({ min: 0, max: 3 })
    expect(twice.noop).toBe(false)
  })

  it('an IDENTICAL redeclaration is an idempotent no-op, so a replay is free', () => {
    const once = ok(emptyDocument(), { op: 'state', name: 'lock_held', type: 'bool' })
    const twice = ok(once.document, { op: 'state', name: 'lock_held', type: 'bool' })
    expect(twice.noop).toBe(true)
  })

  it.each([
    // [label, op, the substring the message must name]
    ['a bool with a domain', { op: 'state', name: 'x', type: 'bool', domain: ['A'] }, 'no domain'],
    ['an enum with no domain', { op: 'state', name: 'x', type: 'enum' }, 'requires a non-empty'],
    [
      'an enum with a repeated member',
      { op: 'state', name: 'x', type: 'enum', domain: ['A', 'A'] },
      'twice',
    ],
    ['an int with a domain list', { op: 'state', name: 'x', type: 'int', domain: ['A'] }, '--min'],
    [
      'an enum with bounds',
      { op: 'state', name: 'x', type: 'enum', domain: ['A'], min: 0 },
      'no numeric bounds',
    ],
  ])('refuses %s', (_label, raw, expected) => {
    expect(bad(emptyDocument(), raw).error).toContain(expected)
  })

  /**
   * The one rule the SCHEMA cannot express, and it matters more than it looks: an
   * empty range describes no states at all, so every invariant over it holds
   * VACUOUSLY — a clean reachability proof that means nothing.
   */
  it('refuses an EMPTY integer range, because every invariant over it holds vacuously', () => {
    const failure = bad(emptyDocument(), {
      op: 'state',
      name: 'retry_count',
      type: 'int',
      min: 5,
      max: 0,
    })
    expect(failure.error).toContain('empty')
    expect(failure.suggestions.join(' ')).toContain('VACUOUSLY')
    // And the fix is the swapped invocation, spelled out.
    expect(failure.suggestions.join(' ')).toContain('--min 0 --max 5')
  })

  // -------------------------------------------------------------------------
  // Classification — door 1
  // -------------------------------------------------------------------------

  it('classifies a constraint, storing the expression and NOT the effect field', () => {
    const { doc, id } = withModel()
    const result = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'not (lock_held and pending)',
    })
    const requirement = result.document.requirements[id]
    expect(requirement?.responseKind).toBe('constraint')
    expect(requirement?.stateConstraint).toBe('not (lock_held and pending)')
    // ABSENT, not undefined — the exactOptionalPropertyTypes discipline reaching the
    // file, which is what keeps a save byte-stable.
    expect(requirement !== undefined && 'stateEffect' in requirement).toBe(false)
  })

  it('RECLASSIFYING clears the other expression rather than leaving it behind', () => {
    const { doc, id } = withModel()
    const asEffect = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'effect',
      expression: 'lock_held := true',
    })
    const asConstraint = ok(asEffect.document, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const requirement = asConstraint.document.requirements[id]
    expect(requirement?.stateConstraint).toBe('lock_held = false')
    // A leftover `stateEffect` would be an expression nothing reads while looking
    // authoritative — a decision recorded and not applied.
    expect(requirement !== undefined && 'stateEffect' in requirement).toBe(false)
  })

  it('refuses a label with NO expression, because that reads as classified and is not', () => {
    const { doc } = withModel()
    const failure = bad(doc, { op: 'classify', ref: 'G1', kind: 'effect' })
    expect(failure.error).toContain('requires the expression')
    // The message names the runnable fix AND the retraction alternative.
    expect(failure.suggestions.join(' ')).toContain('--expression')
    expect(failure.suggestions.join(' ')).toContain('--retract')
  })

  /** DOOR 1: the expression is written against a model that lacks the variable. */
  it('refuses an UNDECLARED reference in a classification (V14/V21 door 1)', () => {
    const { doc } = withModel()
    const failure = bad(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'ghost_var = true',
    })
    expect(failure.code).toBe('ERR_USAGE')
    expect(failure.error).toContain('ghost_var')
    // The declared names are listed, so the fix is mechanical.
    expect(failure.suggestions.join(' ')).toContain('lock_held')
  })

  it('RETRACTION clears the label and BOTH expressions', () => {
    const { doc, id } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const retracted = ok(classified.document, { op: 'classify', ref: 'G1', kind: null })
    const requirement = retracted.document.requirements[id]
    expect(requirement !== undefined && 'responseKind' in requirement).toBe(false)
    expect(requirement !== undefined && 'stateConstraint' in requirement).toBe(false)
    expect(requirement !== undefined && 'stateEffect' in requirement).toBe(false)
  })

  it('retracting an UNCLASSIFIED requirement is an idempotent no-op', () => {
    const { doc } = withModel()
    expect(ok(doc, { op: 'classify', ref: 'G1', kind: null }).noop).toBe(true)
  })

  it('an identical reclassification is a no-op', () => {
    const { doc } = withModel()
    const once = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    expect(
      ok(once.document, {
        op: 'classify',
        ref: 'G1',
        kind: 'constraint',
        expression: 'lock_held = false',
      }).noop,
    ).toBe(true)
  })

  it('refuses a classification of a ref that resolves to nothing', () => {
    const { doc } = withModel()
    const failure = bad(doc, {
      op: 'classify',
      ref: 'NOPE',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    expect(failure.code).toBe('ERR_NOT_FOUND')
  })

  // -------------------------------------------------------------------------
  // update — door 2
  // -------------------------------------------------------------------------

  /**
   * DOOR 2, and the one most easily left open.
   *
   * `stateEffect`/`stateConstraint` are in `UPDATABLE_ATTRS` because a state model is
   * authored iteratively and editing one expression without restating the label has to
   * work. That means `update` can write an expression WITHOUT going through
   * `classify` — so if `update` did not validate, `symspec update stateConstraint
   * "ghost = 1"` would put an undeclared reference straight into the document, and the
   * failure that produces at check time is a hang rather than a message.
   */
  it('refuses an UNDECLARED reference written through `update` (V14/V21 door 2)', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const failure = bad(classified.document, {
      op: 'update',
      ref: 'G1',
      attr: 'stateConstraint',
      value: 'ghost_var = true',
    })
    expect(failure.code).toBe('ERR_USAGE')
    expect(failure.error).toContain('ghost_var')
  })

  it('refuses through `update` an expression of the WRONG kind for the requirement', () => {
    // Storing a `stateEffect` on a requirement classified `constraint` would be an
    // expression the encoder never reads.
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const failure = bad(classified.document, {
      op: 'update',
      ref: 'G1',
      attr: 'stateEffect',
      value: 'lock_held := true',
    })
    expect(failure.error).toContain('classified constraint')
    expect(failure.suggestions.join(' ')).toContain('symspec classify')
  })

  it('ACCEPTS a valid expression edit through `update`, so iterative authoring works', () => {
    const { doc, id } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const edited = ok(classified.document, {
      op: 'update',
      ref: 'G1',
      attr: 'stateConstraint',
      value: 'retry_count <= 3',
    })
    expect(edited.document.requirements[id]?.stateConstraint).toBe('retry_count <= 3')
  })

  it('CLEARS an expression through `update --clear`, since retracting must be possible', () => {
    const { doc, id } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const cleared = ok(classified.document, {
      op: 'update',
      ref: 'G1',
      attr: 'stateConstraint',
      value: null,
    })
    const requirement = cleared.document.requirements[id]
    expect(requirement !== undefined && 'stateConstraint' in requirement).toBe(false)
  })

  it('lists both expression attrs as clearable and updatable', () => {
    // Pins the two tables the fold consults, so removing an attr from either without
    // deciding what happens to existing documents fails here.
    expect(UPDATABLE_ATTRS).toContain('stateEffect')
    expect(UPDATABLE_ATTRS).toContain('stateConstraint')
    expect(NULLABLE_ATTRS.has('stateEffect')).toBe(true)
    expect(NULLABLE_ATTRS.has('stateConstraint')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // unstate — door 3
  // -------------------------------------------------------------------------

  /**
   * DOOR 3 — the one a reasonable implementation forgets.
   *
   * Write a perfectly valid expression, then remove the variable underneath it. The
   * document now contains an undeclared reference reached without ever writing an
   * invalid expression.
   */
  it('refuses to undeclare a variable an expression still REFERENCES (V14/V21 door 3)', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'not (lock_held and pending)',
    })
    const failure = bad(classified.document, { op: 'unstate', name: 'lock_held' })
    expect(failure.error).toContain('Cannot undeclare')
    // The REFERENCING requirement is named — that is the fix site.
    expect(failure.error).toContain('G1')
    expect(failure.suggestions.join(' ')).toMatch(/V14\/V21|hang/)
  })

  it('refuses to undeclare a variable an EFFECT references, reads as well as writes', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'effect',
      // `pending` is only READ here, never written. A guard that checked write targets
      // alone would let it be removed.
      expression: 'lock_held := pending',
    })
    expect(bad(classified.document, { op: 'unstate', name: 'pending' }).error).toContain(
      'Cannot undeclare',
    )
  })

  it('ALLOWS undeclaring a variable nothing references', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'lock_held = false',
    })
    const removed = ok(classified.document, { op: 'unstate', name: 'run_state' })
    expect(removed.document.stateModel.variables.map((v) => v.name)).not.toContain('run_state')
  })

  it('undeclaring an ABSENT variable is a no-op success, so a replay does not fail', () => {
    expect(ok(emptyDocument(), { op: 'unstate', name: 'never_declared' }).noop).toBe(true)
  })

  /**
   * The SAME hazard through a redeclaration rather than a removal: narrowing an enum
   * domain out from under a constraint that compares against the dropped member.
   */
  it('refuses a REDECLARATION that narrows a domain an expression still compares against', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'run_state != DONE',
    })
    const failure = bad(classified.document, {
      op: 'state',
      name: 'run_state',
      type: 'enum',
      // `DONE` is gone.
      domain: ['PENDING', 'RUNNING'],
    })
    expect(failure.error).toContain('Redeclaring')
    expect(failure.error).toContain('G1')
  })

  it('refuses a redeclaration that changes a TYPE an expression depends on', () => {
    const { doc } = withModel()
    const classified = ok(doc, {
      op: 'classify',
      ref: 'G1',
      kind: 'constraint',
      expression: 'retry_count <= 3',
    })
    // int → bool makes `<=` illegal.
    const failure = bad(classified.document, { op: 'state', name: 'retry_count', type: 'bool' })
    expect(failure.error).toContain('Redeclaring')
  })

  // -------------------------------------------------------------------------
  // state-initial
  // -------------------------------------------------------------------------

  it('sets and clears the model-wide initial predicate', () => {
    const { doc } = withModel()
    const set = ok(doc, {
      op: 'state-initial',
      predicate: 'run_state = PENDING and retry_count = 0',
    })
    expect(set.document.stateModel.initial).toBe('run_state = PENDING and retry_count = 0')
    const cleared = ok(set.document, { op: 'state-initial', predicate: null })
    expect('initial' in cleared.document.stateModel).toBe(false)
  })

  it('refuses an initial predicate naming an undeclared variable', () => {
    const { doc } = withModel()
    expect(bad(doc, { op: 'state-initial', predicate: 'ghost = true' }).error).toContain('ghost')
  })

  it('refuses a non-PREDICATE initial, since it would assert nothing', () => {
    const { doc } = withModel()
    expect(bad(doc, { op: 'state-initial', predicate: 'retry_count' }).error).toContain('PREDICATE')
  })

  it('refuses an `unstate` that would strand the MODEL-WIDE initial predicate', () => {
    const { doc } = withModel()
    const withInitial = ok(doc, { op: 'state-initial', predicate: 'run_state = PENDING' })
    // Nothing in a REQUIREMENT references `run_state`, so the per-requirement guard
    // does not fire — the model-wide predicate is a separate reference site, and
    // missing it would strand exactly the same undeclared reference.
    const failure = bad(withInitial.document, { op: 'unstate', name: 'run_state' })
    expect(failure.error).toContain('initial predicate')
  })

  it('clearing an absent initial predicate is a no-op', () => {
    const { doc } = withModel()
    expect(ok(doc, { op: 'state-initial', predicate: null }).noop).toBe(true)
  })

  // -------------------------------------------------------------------------
  // The batch story
  // -------------------------------------------------------------------------

  /**
   * The whole reason the state model got OPS and not just commands: it is authored as
   * a BATCH, and a batch has to resolve against the RUNNING document — a variable
   * declared at index 0 must be referenceable by a `classify` at index 4.
   */
  it('authors a whole state model in ONE atomic fold, resolving against the RUNNING document', () => {
    const { doc, id } = withOne()
    const result = foldOps(
      doc,
      [
        op({ op: 'state', name: 'lock_held', type: 'bool', initial: 'lock_held = false' }),
        op({ op: 'state', name: 'pending', type: 'bool' }),
        op({ op: 'state-initial', predicate: 'not lock_held' }),
        // References variables declared THREE ops earlier in the same batch.
        op({
          op: 'classify',
          ref: 'G1',
          kind: 'constraint',
          expression: 'not (lock_held and pending)',
        }),
      ],
      TS,
    )
    expect(result.summary.failed).toBe(0)
    expect(result.write).toBe(true)
    expect(result.document.stateModel.variables).toHaveLength(2)
    expect(result.document.requirements[id]?.stateConstraint).toBe('not (lock_held and pending)')
  })

  it('ABORTS the whole batch when a classify references a variable the batch never declared', () => {
    const { doc } = withOne()
    const result = foldOps(
      doc,
      [
        op({ op: 'state', name: 'lock_held', type: 'bool' }),
        op({ op: 'classify', ref: 'G1', kind: 'constraint', expression: 'ghost = true' }),
      ],
      TS,
    )
    // ATOMIC: the document is the ORIGINAL, so a half-authored state model never lands.
    expect(result.write).toBe(false)
    expect(result.abortedAt).toBe(1)
    expect(result.document.stateModel.variables).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // SANITY GATE #1, authoring half — an unsatisfiable INITIAL STATE
  // -------------------------------------------------------------------------

  /**
   * The write-time half of the gate `../formal/reachability.ts` enforces at check time.
   *
   * GUARDS MUST FIRE: deleting the `initialStateSatisfiable` call from `applyState` /
   * `applyStateInitial` makes every case here pass the write, which is what these assert
   * against — the refusal, and the file staying unwritten.
   *
   * ## Why a WRITE-time refusal on top of the solver-backed gate
   *
   * Because a document that never existed cannot be shipped. `check` catches everything
   * (the analysis here is deliberately incomplete — see `cheapInitialContradiction`), but
   * it catches it on a file already on disk, as a finding. Refusing the write names the
   * flag the author just typed. Exactly the split the existing empty-range refusal uses,
   * and an empty range IS this defect through a different field.
   */
  describe('an unsatisfiable initial state is refused at WRITE time', () => {
    it('refuses a SELF-CONTRADICTORY model-wide predicate', () => {
      const doc = ok(emptyDocument(), {
        op: 'state',
        name: 'held',
        type: 'int',
        min: 0,
        max: 3,
      }).document
      const failure = bad(doc, { op: 'state-initial', predicate: 'held = 0 and held = 2' })
      expect(failure.code).toBe('ERR_USAGE')
      expect(failure.error).toContain('UNSATISFIABLE')
      // The message names BOTH literals, so the author sees the contradiction rather than
      // being told one exists.
      expect(failure.error).toContain('0')
      expect(failure.error).toContain('2')
      // And it says what a vacuous model DOES, which is the part that makes the refusal
      // read as protection rather than pedantry.
      expect(failure.suggestions.join(' ')).toContain('VACUOUSLY')
    })

    it('refuses a per-variable initial that CONTRADICTS the model-wide one (LOW-13)', () => {
      // Neither half is wrong alone. They are CONJOINED, so the contradiction exists only
      // in their conjunction — which is why the message has to name which command set
      // which half.
      const doc = ok(emptyDocument(), {
        op: 'state',
        name: 'held',
        type: 'int',
        min: 0,
        max: 3,
        initial: 'held = 0',
      }).document
      const failure = bad(doc, { op: 'state-initial', predicate: 'held = 2' })
      expect(failure.code).toBe('ERR_USAGE')
      expect(failure.error).toContain('--initial')
      expect(failure.error).toContain('state-initial')
    })

    it('refuses an initial value OUTSIDE the declared bounds, from either edit order', () => {
      // (a) bounds first, then the out-of-range initial.
      const bounded = ok(emptyDocument(), {
        op: 'state',
        name: 'held',
        type: 'int',
        min: 0,
        max: 3,
      }).document
      expect(bad(bounded, { op: 'state-initial', predicate: 'held = 5' }).error).toContain(
        'above its declared maximum',
      )

      // (b) THE OTHER ORDER, from ONE op — bounds and initial declared together, which is
      // how `symspec state held --type int --min 0 --max 3 --initial "held = 5"` arrives.
      // Both halves are individually legal and the CONJUNCTION is empty.
      //
      // Note the third conceivable order — an initial already committed, then a bare
      // redeclaration that narrows — cannot reach this gate, and deliberately so: a
      // redeclaration REPLACES the whole variable (see the redeclaration test above), so a
      // `state` op with no `--initial` DROPS the initial rather than narrowing around it.
      // There is then no contradiction because there is no initial. That is existing
      // documented behavior, and this comment exists so a future reader does not mistake
      // the missing case for a hole in the gate.
      const together = bad(emptyDocument(), {
        op: 'state',
        name: 'held',
        type: 'int',
        min: 0,
        max: 3,
        initial: 'held = 5',
      })
      expect(together.code).toBe('ERR_USAGE')
      expect(together.error).toContain('above its declared maximum')
    })

    it('refuses a boolean required both true and false', () => {
      const doc = ok(emptyDocument(), {
        op: 'state',
        name: 'lock_held',
        type: 'bool',
        initial: 'lock_held = true',
      }).document
      expect(bad(doc, { op: 'state-initial', predicate: 'lock_held = false' }).error).toContain(
        'UNSATISFIABLE',
      )
    })

    /**
     * THE INCOMPLETENESS, asserted rather than left implicit — and this is the assertion
     * that keeps the check SOUND.
     *
     * A false positive here REFUSES A VALID DOCUMENT, which is strictly worse than a miss
     * (the solver-backed gate catches every miss on the next `check`). So the analysis
     * gives up on anything it cannot decide with certainty, and these are the cases it must
     * NOT refuse. Without this test, "tighten the check" is an easy and unsafe edit.
     */
    it('ACCEPTS everything it cannot decide with certainty — a false positive would be worse', () => {
      const doc = ok(
        ok(emptyDocument(), { op: 'state', name: 'held', type: 'int', min: 0, max: 3 }).document,
        { op: 'state', name: 'other', type: 'int', min: 0, max: 3 },
      ).document
      for (const predicate of [
        // A DISJUNCTION: satisfiable, and flattening its branches would refuse it.
        'held = 0 or held = 2',
        // A NEGATION anywhere above the facts.
        'not (held = 2)',
        // ORDERING facts, which interact in ways a solver should decide.
        'held <= 3 and held >= 1',
        // Variable-to-variable, where no literal is pinned at all.
        'held = other',
        // Two pins of the SAME value are consistent, not a contradiction.
        'held = 1 and held = 1',
      ]) {
        const result = applyOp(doc, op({ op: 'state-initial', predicate }), TS)
        expect(isOpFailure(result), predicate).toBe(false)
      }
    })

    it('does not fire on a SATISFIABLE model — the gate discriminates', () => {
      const doc = ok(emptyDocument(), {
        op: 'state',
        name: 'held',
        type: 'int',
        min: 0,
        max: 3,
        initial: 'held = 0',
      }).document
      const result = applyOp(doc, op({ op: 'state-initial', predicate: 'held = 0' }), TS)
      expect(isOpFailure(result)).toBe(false)
    })
  })

  it('round-trips every state-model op through `opLine`, so a repair plan is applicable', () => {
    // The property that makes `repair.ops` decodable BY CONSTRUCTION: an op serialized
    // by a producer must decode back through the same union `apply` reads.
    for (const raw of [
      { op: 'state', name: 'lock_held', type: 'bool', frame: 'stable' },
      { op: 'unstate', name: 'lock_held' },
      { op: 'state-initial', predicate: 'lock_held = false' },
      { op: 'classify', ref: 'G1', kind: 'constraint', expression: 'lock_held = false' },
      { op: 'classify', ref: 'G1', kind: null },
    ]) {
      const line = opLine(op(raw))
      const decoded = Effect.runSync(Effect.result(decodeOp(JSON.parse(line))))
      expect(decoded._tag, line).toBe('Success')
    }
  })
})
