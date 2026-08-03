/**
 * Tests for document format v3.
 *
 * Three things these are actually about, in order of how much they matter:
 *
 * 1. **The V27 contract, with its guards proven to fire.** Unknown top-level keys
 *    must be preserved, disclosed, AND written back. Each of those three is
 *    asserted separately, and each has a negative control that breaks the
 *    invariant deliberately — a disclosure test that cannot fail is decoration.
 * 2. **Strictness where strictness belongs.** The V27 relaxation is TOP-LEVEL
 *    ONLY. A misspelled field inside a requirement, an unknown edge relation, a
 *    bad enum, or a non-UUID map key must all still be hard failures, and each is
 *    asserted individually so a future widening of the decode options cannot pass
 *    this file.
 * 3. **The beta.102 record-key silent drop.** `Schema.Record(Uuid, …)` returns
 *    Success-with-the-entry-missing on a bad key. The test named for it pins BOTH
 *    halves: that the raw record behaves that way (so the workaround's premise is
 *    verified, not assumed) and that `RequirementsMap` does not.
 */

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_KINDS,
  DOC_VERSION,
  decodeDocument,
  EARS_PATTERNS,
  emptyDocument,
  emptyStateModel,
  KNOWN_TOP_LEVEL_KEYS,
  PRIORITIES,
  partitionTopLevelKeys,
  RELATIONS,
  RESPONSE_KINDS,
  Requirement,
  RequirementsDocument,
  RequirementsMap,
  STATE_VAR_TYPES,
  STATUSES,
  StateModel,
  StateVariable,
  Uuid,
  VERIFICATION_METHODS,
  withUnknownKeys,
} from './document.ts'
import { renderSentence } from './render.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ID_A = '550e8400-e29b-41d4-a716-446655440000'
const ID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/** A minimal but COMPLETE requirement, as it appears on disk. */
const rawRequirement = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'log every authentication attempt',
  sentence: 'The auth service shall log every authentication attempt.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

/** A minimal document carrying one requirement. */
const rawDocument = (extra: Record<string, unknown> = {}) => ({
  docVersion: DOC_VERSION,
  requirements: { [ID_A]: rawRequirement(ID_A) },
  ...extra,
})

/** Decode and unwrap, failing the test on a schema error. */
const decode = (raw: unknown) => Effect.runSync(decodeDocument(raw))

/** Decode and return the Result, for the failure assertions. */
const attempt = (raw: unknown) => Effect.runSync(Effect.result(decodeDocument(raw)))

// ---------------------------------------------------------------------------
// A JSON-Schema reader, re-implemented here on purpose
// ---------------------------------------------------------------------------

/** A JSON-Schema node, as far as these assertions care. */
interface Node {
  readonly description?: string
  readonly default?: unknown
  readonly allOf?: readonly Node[]
  readonly anyOf?: readonly Node[]
  readonly oneOf?: readonly Node[]
  readonly properties?: Record<string, Node>
  readonly items?: Node
}

/**
 * Walk a node and its `allOf`/`anyOf`/`oneOf` branches for an annotation.
 *
 * Deliberately a SECOND implementation of the kernel's `firstAnnotation`. A test
 * that imported the production reader would agree with it by construction —
 * including when it is wrong — so an independent walk is what makes the
 * comparison meaningful. Two known nesting cases it has to survive:
 * `Schema.Finite` (a refinement, nests `description`) and any `Schema.check(...)`
 * (also a refinement, nests `default` as well).
 */
const annotationOf = <K extends 'description' | 'default'>(
  node: Node | undefined,
  key: K,
): Node[K] | undefined => {
  if (node === undefined) return undefined
  if (node[key] !== undefined) return node[key]
  for (const branch of [node.allOf, node.anyOf, node.oneOf]) {
    for (const child of branch ?? []) {
      const found = annotationOf(child, key)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The version tag
// ---------------------------------------------------------------------------

describe('docVersion', () => {
  it('is 3', () => {
    expect(DOC_VERSION).toBe(3)
  })

  it('accepts a document declaring exactly 3', () => {
    expect(decode(rawDocument()).document.docVersion).toBe(3)
  })

  it('rejects any other version, including v2', () => {
    for (const v of [2, 4, 0, -1, '3', null]) {
      expect(attempt({ ...rawDocument(), docVersion: v })._tag, `docVersion ${String(v)}`).toBe(
        'Failure',
      )
    }
  })

  it('rejects a v2 document outright — the key is `schemaVersion`, not `docVersion`', () => {
    // The rename is the point: a v2 file has no `docVersion` at all, so it fails
    // with a message about the missing version key rather than being read as a v3
    // whose number happens to be wrong.
    const v2 = { schemaVersion: 2, requirements: {} }
    const r = attempt(v2)
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(String(r.failure)).toContain('docVersion')
  })
})

// ---------------------------------------------------------------------------
// THE V27 CONTRACT
// ---------------------------------------------------------------------------

describe('V27 — unknown top-level keys are disclosed, never stripped, never fatal', () => {
  const withUnknown = rawDocument({
    stateModel: { variables: [{ name: 'run_state', type: 'bool' }] },
    someFutureTable: [{ a: 1 }],
    anotherFutureKey: 'hello',
  })

  it('LOADS successfully — an unknown key is not a hard failure', () => {
    expect(attempt(withUnknown)._tag).toBe('Success')
  })

  it('PRESERVES the unknown keys verbatim on the load result', () => {
    const loaded = decode(withUnknown)
    expect(loaded.unknownKeys).toEqual({
      someFutureTable: [{ a: 1 }],
      anotherFutureKey: 'hello',
    })
  })

  it('DISCLOSES them as one info-grade diagnostic naming every key', () => {
    const loaded = decode(withUnknown)
    const d = loaded.diagnostics.find((x) => x.kind === 'unknown-top-level-key')
    expect(d).toBeDefined()
    expect(d?.severity).toBe('info')
    expect(d?.keys).toEqual(['anotherFutureKey', 'someFutureTable'])
    expect(d?.detail).toContain('anotherFutureKey')
    expect(d?.detail).toContain('someFutureTable')
    expect(d?.detail).toContain('PRESERVED')
  })

  it('does NOT let an unknown key leak into the decoded document', () => {
    // Preservation is on `unknownKeys`, deliberately NOT on the typed document:
    // the document value is exactly the schema's shape, so no downstream reader
    // ever sees an unvalidated field where a validated one is expected.
    const loaded = decode(withUnknown)
    expect(Object.keys(loaded.document)).not.toContain('someFutureTable')
    expect(Object.keys(loaded.document)).not.toContain('anotherFutureKey')
  })

  it('WRITES the unknown keys back — forward compat is read AND write', () => {
    const loaded = decode(withUnknown)
    const serialized = withUnknownKeys(loaded.document, loaded.unknownKeys)
    expect(serialized.someFutureTable).toEqual([{ a: 1 }])
    expect(serialized.anotherFutureKey).toBe('hello')
    expect(serialized.docVersion).toBe(DOC_VERSION)
  })

  it('SURVIVES a full load → save → load round trip', () => {
    // The exact V27 failure was that ONE mutation destroyed the key. This is the
    // round trip that failure would break.
    const first = decode(withUnknown)
    const written = withUnknownKeys(first.document, first.unknownKeys)
    const second = decode(written)
    expect(second.unknownKeys).toEqual(first.unknownKeys)
    expect(second.document).toEqual(first.document)
  })

  it('reports NO diagnostic for a document this build fully understands', () => {
    expect(decode(rawDocument()).diagnostics).toEqual([])
  })

  /**
   * NEGATIVE CONTROL for the preservation half. Strip the unknown keys the way a
   * strip-mode decode would and assert the round trip demonstrably LOSES them —
   * proving the assertions above are measuring something real.
   */
  it('the guard FIRES: a strip-mode save loses the key', () => {
    const loaded = decode(withUnknown)
    const stripped = { ...loaded.document } as Record<string, unknown>
    expect(stripped.someFutureTable).toBeUndefined()
    expect(decode(stripped).unknownKeys).toEqual({})
  })

  /** NEGATIVE CONTROL for the disclosure half. */
  it('the guard FIRES: no unknown key means no unknown-key diagnostic', () => {
    const kinds = decode(rawDocument()).diagnostics.map((d) => d.kind)
    expect(kinds).not.toContain('unknown-top-level-key')
  })

  it('preserves a key whose value is null or false — falsy is not absent', () => {
    const loaded = decode(rawDocument({ futureNull: null, futureFalse: false }))
    expect(loaded.unknownKeys).toEqual({ futureNull: null, futureFalse: false })
    expect(loaded.diagnostics[0]?.keys).toEqual(['futureFalse', 'futureNull'])
  })
})

describe('partitionTopLevelKeys', () => {
  it('routes every schema field to `known`', () => {
    const all = Object.fromEntries([...KNOWN_TOP_LEVEL_KEYS].map((k) => [k, 1]))
    const { known, unknown } = partitionTopLevelKeys(all)
    expect(Object.keys(known).sort()).toEqual([...KNOWN_TOP_LEVEL_KEYS].sort())
    expect(unknown).toEqual({})
  })

  it('derives the known set from the schema, so it cannot drift from the fields', () => {
    expect([...KNOWN_TOP_LEVEL_KEYS].sort()).toEqual(
      Object.keys(RequirementsDocument.fields).sort(),
    )
  })

  it('is total on a non-object input', () => {
    for (const bad of [null, 42, 'x', [1, 2], undefined]) {
      expect(partitionTopLevelKeys(bad)).toEqual({ known: {}, unknown: {} })
    }
  })
})

// ---------------------------------------------------------------------------
// Strictness BELOW the top level
// ---------------------------------------------------------------------------

describe('strictness is relaxed at the TOP LEVEL ONLY', () => {
  it('REJECTS an unknown field inside a requirement', () => {
    const r = attempt({
      ...rawDocument(),
      requirements: { [ID_A]: rawRequirement(ID_A, { bogusField: 1 }) },
    })
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(String(r.failure)).toContain('bogusField')
  })

  it('REJECTS a misspelled edge relation inside a requirement', () => {
    // `derive` (singular) is the APPLY OP verb, not the schema relation — an easy
    // and consequential typo, since a silently ignored edge array is an edge that
    // does not exist.
    expect(
      attempt({
        ...rawDocument(),
        requirements: { [ID_A]: rawRequirement(ID_A, { derive: [ID_B] }) },
      })._tag,
    ).toBe('Failure')
  })

  it('REJECTS an unknown key inside the state model', () => {
    expect(attempt(rawDocument({ stateModel: { variables: [], bogus: 1 } }))._tag).toBe('Failure')
  })

  it('REJECTS an unknown key inside a glossary entry', () => {
    expect(
      attempt(rawDocument({ glossary: [{ canonical: 'x', aliases: [], bogus: 1 }] }))._tag,
    ).toBe('Failure')
  })

  it('REJECTS an out-of-enum value for every closed enum', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['patternType', 'ubiquitious'],
      ['priority', 'urgent'],
      ['status', 'done'],
      ['verificationMethod', 'vibes'],
      ['responseKind', 'sideEffect'],
    ]
    for (const [field, bad] of cases) {
      const r = attempt({
        ...rawDocument(),
        requirements: { [ID_A]: rawRequirement(ID_A, { [field]: bad }) },
      })
      expect(r._tag, `${field}=${bad}`).toBe('Failure')
    }
  })

  it('REJECTS an empty prose slot — a blank systemResponse is not a requirement', () => {
    expect(
      attempt({
        ...rawDocument(),
        requirements: { [ID_A]: rawRequirement(ID_A, { systemResponse: '' }) },
      })._tag,
    ).toBe('Failure')
  })

  it('REJECTS a non-UUID edge target', () => {
    expect(
      attempt({
        ...rawDocument(),
        requirements: { [ID_A]: rawRequirement(ID_A, { derives: ['TX-B6'] }) },
      })._tag,
    ).toBe('Failure')
  })

  it('REJECTS a key that violates KEY_PATTERN', () => {
    for (const bad of ['42', '-leading', 'has space', 'x'.repeat(65), '']) {
      expect(
        attempt({
          ...rawDocument(),
          requirements: { [ID_A]: rawRequirement(ID_A, { key: bad }) },
        })._tag,
        `key ${JSON.stringify(bad)}`,
      ).toBe('Failure')
    }
  })

  it('ACCEPTS the key shapes the donor documents', () => {
    for (const good of ['G1', 'AUTH-3', 'TX-B6', 'perf.p99', 'S12', 'a_b']) {
      expect(
        attempt({
          ...rawDocument(),
          requirements: { [ID_A]: rawRequirement(ID_A, { key: good }) },
        })._tag,
        `key ${good}`,
      ).toBe('Success')
    }
  })
})

// ---------------------------------------------------------------------------
// The beta.102 record-key silent drop
// ---------------------------------------------------------------------------

describe('beta.102 trap: Schema.Record SILENTLY DROPS a bad key', () => {
  /**
   * The premise of the workaround, verified rather than assumed. If a future beta
   * fixes `Schema.Record` to fail loudly, this test starts failing and tells us
   * the `isPropertyNames` wrapper is no longer load-bearing — which is exactly the
   * signal we want, and much better than the wrapper quietly becoming cargo cult.
   */
  it('the RAW record decodes Success with the entry MISSING (the defect)', () => {
    const raw = Schema.Record(Uuid, Schema.Number)
    const r = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(raw, { onExcessProperty: 'error', errors: 'all' })({
          'not-a-uuid': 1,
          [ID_A]: 2,
        }),
      ),
    )
    expect(r._tag).toBe('Success')
    if (r._tag === 'Success') {
      expect(r.success).toEqual({ [ID_A]: 2 })
      expect(Object.keys(r.success)).not.toContain('not-a-uuid')
    }
  })

  it('RequirementsMap FAILS on the same input instead of dropping it', () => {
    const r = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(RequirementsMap, { onExcessProperty: 'error' })({
          'not-a-uuid': rawRequirement(ID_A),
        }),
      ),
    )
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(String(r.failure)).toContain('UUID')
  })

  it('the whole document FAILS on a non-UUID requirements key', () => {
    const r = attempt({ ...rawDocument(), requirements: { 'TX-B6': rawRequirement(ID_A) } })
    expect(r._tag).toBe('Failure')
  })

  it('keeps every requirement when every key is a UUID', () => {
    const loaded = decode({
      ...rawDocument(),
      requirements: { [ID_A]: rawRequirement(ID_A), [ID_B]: rawRequirement(ID_B) },
    })
    expect(Object.keys(loaded.document.requirements).sort()).toEqual([ID_A, ID_B].sort())
  })

  it('publishes the propertyNames constraint in the JSON Schema', () => {
    // The manifest must still advertise the real rule, or an agent reading it
    // would not know keys are UUIDs.
    const json = JSON.stringify(Schema.toJsonSchemaDocument(RequirementsMap).schema)
    expect(json).toContain('propertyNames')
    expect(json).toContain('uuid')
  })
})

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
  it('materializes every document-level default from a bare v3 document', () => {
    const loaded = decode({ docVersion: DOC_VERSION })
    expect(loaded.document).toEqual(emptyDocument())
  })

  it('materializes every requirement-level default', () => {
    const r = decode(rawDocument()).document.requirements[ID_A]
    expect(r).toMatchObject({
      negated: false,
      priority: 'medium',
      status: 'draft',
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    })
  })

  it('leaves genuinely optional fields ABSENT, not null', () => {
    const r = decode(rawDocument()).document.requirements[ID_A]
    for (const field of [
      'key',
      'preCondition',
      'trigger',
      'responseKind',
      'verificationMethod',
      'verificationNote',
    ]) {
      expect(Object.hasOwn(r as object, field), `${field} should be absent`).toBe(false)
    }
  })

  it('publishes every default in the JSON Schema (the withDecodingDefaultKey trap)', () => {
    // withDecodingDefaultKey does not emit `default`, and an `.annotate({default})`
    // applied AFTER it lands on a wrapper the lowering discards. This asserts the
    // ordering `withDefault` encapsulates actually reached the published schema.
    //
    // NOTE the `allOf` walk. `requirements` carries a `Schema.check(...)`
    // refinement (the propertyNames guard), and a refinement nests BOTH its
    // `description` AND its `default` one level down under `allOf` — the same
    // lowering quirk the kernel documents for `Schema.Finite`'s description, now
    // observed to apply to `default` as well. A top-level-only read reports
    // `undefined` here and would have "proved" the default was missing.
    const props = (
      Schema.toJsonSchemaDocument(RequirementsDocument).schema as {
        properties?: Record<string, Node>
      }
    ).properties
    expect(annotationOf(props?.requirements, 'default')).toEqual({})
    expect(annotationOf(props?.glossary, 'default')).toEqual([])
    expect(annotationOf(props?.antonyms, 'default')).toEqual([])
    expect(annotationOf(props?.waivers, 'default')).toEqual([])
    expect(annotationOf(props?.stateModel, 'default')).toEqual({ variables: [] })
  })

  it('publishes a description for every defaulted field too, through the same walk', () => {
    const props = (
      Schema.toJsonSchemaDocument(RequirementsDocument).schema as {
        properties?: Record<string, Node>
      }
    ).properties
    for (const field of ['requirements', 'stateModel', 'glossary', 'antonyms', 'waivers']) {
      const d = annotationOf(props?.[field], 'description')
      expect(typeof d, `${field} description`).toBe('string')
      expect((d as string).length).toBeGreaterThan(0)
    }
  })

  it('types a defaulted field as REQUIRED after decoding', () => {
    // Optional in Encoded (the file may omit it), required in Type (decoding
    // always materializes it). If `withDefault` wrapped in `optionalKey` this
    // would need a `?.` and the compiler would stop catching a missing field.
    const doc = decode({ docVersion: DOC_VERSION }).document
    const count: number = Object.keys(doc.requirements).length
    const vars: number = doc.stateModel.variables.length
    expect(count).toBe(0)
    expect(vars).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The state model
// ---------------------------------------------------------------------------

describe('stateModel — first-class from day one', () => {
  const model = (variables: readonly unknown[], extra: Record<string, unknown> = {}) =>
    rawDocument({ stateModel: { variables, ...extra } })

  it('accepts a bool variable with no domain', () => {
    expect(attempt(model([{ name: 'lock_held', type: 'bool' }]))._tag).toBe('Success')
  })

  it('REJECTS a bool variable that declares a domain — {true,false} is not negotiable', () => {
    expect(
      attempt(model([{ name: 'lock_held', type: 'bool', domain: ['yes', 'no', 'maybe'] }]))._tag,
    ).toBe('Failure')
  })

  it('accepts an int variable with, and without, bounds', () => {
    expect(attempt(model([{ name: 'n', type: 'int' }]))._tag).toBe('Success')
    expect(attempt(model([{ name: 'n', type: 'int', domain: { min: 0, max: 9 } }]))._tag).toBe(
      'Success',
    )
    expect(attempt(model([{ name: 'n', type: 'int', domain: { min: 0 } }]))._tag).toBe('Success')
  })

  it('REJECTS non-integer int bounds', () => {
    expect(attempt(model([{ name: 'n', type: 'int', domain: { min: 0.5 } }]))._tag).toBe('Failure')
  })

  it('REQUIRES a domain on an enum variable', () => {
    expect(attempt(model([{ name: 'run_state', type: 'enum' }]))._tag).toBe('Failure')
  })

  it('REJECTS an enum with an EMPTY domain — that is a typo, not a variable', () => {
    expect(attempt(model([{ name: 'run_state', type: 'enum', domain: [] }]))._tag).toBe('Failure')
  })

  it('accepts an enum with a non-empty domain', () => {
    const r = attempt(model([{ name: 'run_state', type: 'enum', domain: ['PENDING', 'RUNNING'] }]))
    expect(r._tag).toBe('Success')
  })

  it('REJECTS an unknown variable type', () => {
    expect(attempt(model([{ name: 'x', type: 'string' }]))._tag).toBe('Failure')
  })

  it('accepts a per-variable and a model-wide initial predicate', () => {
    const r = attempt(
      model([{ name: 'run_state', type: 'enum', domain: ['P'], initial: 'run_state = P' }], {
        initial: 'run_state = P and lock_held = false',
      }),
    )
    expect(r._tag).toBe('Success')
  })

  it('defaults to an empty model, and emptyStateModel matches it', () => {
    expect(decode(rawDocument()).document.stateModel).toEqual(emptyStateModel())
    expect(emptyStateModel()).toEqual({ variables: [] })
  })

  it('returns a FRESH empty model each call — no shared mutable state', () => {
    expect(emptyStateModel()).not.toBe(emptyStateModel())
    expect(emptyDocument()).not.toBe(emptyDocument())
  })

  it('survives a save/load round trip alongside requirements', () => {
    const raw = model([
      { name: 'run_state', type: 'enum', domain: ['PENDING', 'RUNNING', 'DONE'] },
      { name: 'lock_held', type: 'bool', initial: 'lock_held = false' },
      { name: 'retries', type: 'int', domain: { min: 0, max: 5 } },
    ])
    const first = decode(raw)
    const second = decode(withUnknownKeys(first.document, first.unknownKeys))
    expect(second.document.stateModel).toEqual(first.document.stateModel)
    expect(second.document.stateModel.variables).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// responseKind
// ---------------------------------------------------------------------------

describe('responseKind — optional at authoring, present in the schema from day one', () => {
  it('is a field of the requirement schema even when no document sets it', () => {
    expect(Object.keys(Requirement.fields)).toContain('responseKind')
  })

  it('accepts both classifications', () => {
    for (const kind of RESPONSE_KINDS) {
      const r = attempt({
        ...rawDocument(),
        requirements: { [ID_A]: rawRequirement(ID_A, { responseKind: kind }) },
      })
      expect(r._tag, kind).toBe('Success')
    }
  })

  it('is ABSENT (not defaulted) when unset — an unclassified response says so', () => {
    // A default here would be a lie: it would make every legacy requirement claim
    // a classification nobody made, which is precisely what the reachability tier
    // must be able to distinguish from a real one.
    const r = decode(rawDocument()).document.requirements[ID_A]
    expect(Object.hasOwn(r as object, 'responseKind')).toBe(false)
  })

  it('appears in the published JSON Schema with both values', () => {
    const json = JSON.stringify(Schema.toJsonSchemaDocument(Requirement).schema)
    expect(json).toContain('responseKind')
    expect(json).toContain('constraint')
  })
})

// ---------------------------------------------------------------------------
// Sentence drift
// ---------------------------------------------------------------------------

describe('sentence-drift disclosure', () => {
  it('reports a stored sentence the renderer would not produce', () => {
    const loaded = decode({
      ...rawDocument(),
      requirements: { [ID_A]: rawRequirement(ID_A, { sentence: 'Hand-edited prose.' }) },
    })
    const d = loaded.diagnostics.find((x) => x.kind === 'sentence-drift')
    expect(d?.severity).toBe('info')
    expect(d?.requirementIds).toEqual([ID_A])
  })

  it('reports NOTHING when the stored sentence matches the renderer', () => {
    expect(decode(rawDocument()).diagnostics.map((d) => d.kind)).not.toContain('sentence-drift')
  })

  it('the guard FIRES per requirement, not just for the first', () => {
    const loaded = decode({
      ...rawDocument(),
      requirements: {
        [ID_A]: rawRequirement(ID_A),
        [ID_B]: rawRequirement(ID_B, { sentence: 'Different prose.' }),
      },
    })
    const d = loaded.diagnostics.find((x) => x.kind === 'sentence-drift')
    expect(d?.requirementIds).toEqual([ID_B])
  })

  it('never grades a diagnostic above info — a disclosure is not a gate', () => {
    const loaded = decode({
      ...rawDocument({ futureKey: 1 }),
      requirements: { [ID_A]: rawRequirement(ID_A, { sentence: 'drifted' }) },
    })
    expect(loaded.diagnostics).toHaveLength(2)
    for (const d of loaded.diagnostics) expect(d.severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

describe('renderSentence', () => {
  const base = { systemName: 'auth service', systemResponse: 'issue a session token' } as const

  it('renders each of the five EARS templates', () => {
    expect(renderSentence({ ...base, patternType: 'ubiquitous' })).toBe(
      'The auth service shall issue a session token.',
    )
    expect(
      renderSentence({ ...base, patternType: 'event-driven', trigger: 'the user logs in' }),
    ).toBe('When the user logs in, the auth service shall issue a session token.')
    expect(
      renderSentence({ ...base, patternType: 'state-driven', preCondition: 'MFA is enabled' }),
    ).toBe('While MFA is enabled, the auth service shall issue a session token.')
    expect(
      renderSentence({
        ...base,
        patternType: 'optional-feature',
        preCondition: 'SSO is configured',
      }),
    ).toBe('Where SSO is configured, the auth service shall issue a session token.')
    expect(
      renderSentence({ ...base, patternType: 'unwanted-behavior', trigger: 'the token expires' }),
    ).toBe('If the token expires, then the auth service shall issue a session token.')
  })

  it('combines preCondition and trigger on the event-driven template', () => {
    expect(
      renderSentence({
        ...base,
        patternType: 'event-driven',
        preCondition: 'MFA is enabled',
        trigger: 'the user logs in',
      }),
    ).toBe(
      'While MFA is enabled, when the user logs in, the auth service shall issue a session token.',
    )
  })

  it('renders `shall not` for a negated response, leaving the response positive', () => {
    expect(renderSentence({ ...base, patternType: 'ubiquitous', negated: true })).toBe(
      'The auth service shall not issue a session token.',
    )
    expect(
      renderSentence({ ...base, patternType: 'event-driven', trigger: 't', negated: true }),
    ).toContain('shall not issue a session token')
  })

  it('is total over EARS_PATTERNS', () => {
    for (const patternType of EARS_PATTERNS) {
      expect(renderSentence({ ...base, patternType })).toMatch(/\.$/)
    }
  })
})

// ---------------------------------------------------------------------------
// Vocabulary snapshots (append-only discipline)
// ---------------------------------------------------------------------------

describe('closed vocabularies are frozen — append-only, never renamed or reordered', () => {
  it('EARS_PATTERNS', () => {
    expect(EARS_PATTERNS).toEqual([
      'ubiquitous',
      'event-driven',
      'state-driven',
      'optional-feature',
      'unwanted-behavior',
    ])
  })
  it('PRIORITIES', () => {
    expect(PRIORITIES).toEqual(['low', 'medium', 'high', 'critical'])
  })
  it('STATUSES', () => {
    expect(STATUSES).toEqual(['draft', 'approved', 'implemented', 'verified'])
  })
  it('VERIFICATION_METHODS', () => {
    expect(VERIFICATION_METHODS).toEqual(['test', 'inspection', 'analysis', 'demonstration'])
  })
  it('RELATIONS', () => {
    expect(RELATIONS).toEqual(['derives', 'satisfies', 'verifies', 'refines'])
  })
  it('RESPONSE_KINDS', () => {
    expect(RESPONSE_KINDS).toEqual(['effect', 'constraint'])
  })
  it('STATE_VAR_TYPES', () => {
    expect(STATE_VAR_TYPES).toEqual(['bool', 'int', 'enum'])
  })
  it('DIAGNOSTIC_KINDS', () => {
    expect(DIAGNOSTIC_KINDS).toEqual(['unknown-top-level-key', 'sentence-drift'])
  })
  it('every RELATION is an edge array on the requirement schema', () => {
    for (const relation of RELATIONS) {
      expect(Object.keys(Requirement.fields)).toContain(relation)
    }
  })
  it('every STATE_VAR_TYPE is a member of the StateVariable union', () => {
    const json = JSON.stringify(Schema.toJsonSchemaDocument(StateVariable).schema)
    for (const t of STATE_VAR_TYPES) expect(json).toContain(`"${t}"`)
  })
})

// ---------------------------------------------------------------------------
// Annotation completeness — the manifest's single source
// ---------------------------------------------------------------------------

describe('every field carries a description — the manifest has no second corpus', () => {
  const descriptionOf = (node: Node | undefined): string | undefined => {
    const d = annotationOf(node, 'description')
    return typeof d === 'string' ? d : undefined
  }

  const blankFields = (schema: Schema.Top, label: string): string[] => {
    const doc = Schema.toJsonSchemaDocument(schema as never).schema as Node
    const blank: string[] = []
    for (const [name, node] of Object.entries(doc.properties ?? {})) {
      const d = descriptionOf(node)
      if (d === undefined || d.trim() === '') blank.push(`${label}.${name}`)
    }
    return blank
  }

  it('on the document', () => {
    expect(blankFields(RequirementsDocument, 'document')).toEqual([])
  })

  it('on the requirement', () => {
    expect(blankFields(Requirement, 'requirement')).toEqual([])
  })

  it('on the state model', () => {
    expect(blankFields(StateModel, 'stateModel')).toEqual([])
  })

  it('on every state-variable branch', () => {
    const doc = Schema.toJsonSchemaDocument(StateVariable).schema as Node
    const branches = doc.anyOf ?? doc.oneOf ?? []
    expect(branches.length).toBe(STATE_VAR_TYPES.length)
    for (const [i, branch] of branches.entries()) {
      for (const [name, node] of Object.entries(branch.properties ?? {})) {
        const d = descriptionOf(node)
        expect(d?.trim(), `stateVariable[${i}].${name} has no description`).toBeTruthy()
      }
    }
  })

  /** NEGATIVE CONTROL: the walk must be able to REPORT a blank description, or
   * the four tests above prove nothing. */
  it('the description guard FIRES on a field with no annotation', () => {
    const Unannotated = Schema.Struct({ naked: Schema.String })
    expect(blankFields(Unannotated, 'x')).toEqual(['x.naked'])
  })
})
