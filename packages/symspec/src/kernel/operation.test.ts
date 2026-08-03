/**
 * Operations-table kernel tests: the metadata readers, the construction-time
 * assertions, and the manifest/help projections.
 *
 * The two annotation traps (`Schema.Finite` nesting `description` under `allOf`,
 * and `withDecodingDefaultKey` not emitting `default`) are tested directly here
 * with schemas built for the purpose, because both are SILENT in production and
 * the readers that walk around them are the only thing standing between a
 * numeric flag and a blank help line.
 */

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { ErrIo } from './errors.ts'
import {
  buildManifest,
  defineOperation,
  fieldMetadata,
  firstAnnotation,
  flagName,
  inputJsonSchema,
  operationHelp,
  runOperation,
  tableHelp,
} from './operation.ts'

describe('firstAnnotation() — the refinement-nesting walk', () => {
  it('reads a top-level annotation', () => {
    expect(firstAnnotation({ description: 'top' }, 'description')).toBe('top')
  })

  it('reads through allOf — the Schema.Finite shape', () => {
    expect(
      firstAnnotation({ type: 'number', allOf: [{ description: 'nested' }] }, 'description'),
    ).toBe('nested')
  })

  it('reads through anyOf and oneOf', () => {
    expect(firstAnnotation({ anyOf: [{ description: 'a' }] }, 'description')).toBe('a')
    expect(firstAnnotation({ oneOf: [{ description: 'o' }] }, 'description')).toBe('o')
  })

  it('recurses more than one level deep', () => {
    expect(firstAnnotation({ allOf: [{ anyOf: [{ description: 'deep' }] }] }, 'description')).toBe(
      'deep',
    )
  })

  it('prefers the top level over a branch', () => {
    expect(
      firstAnnotation({ description: 'top', allOf: [{ description: 'x' }] }, 'description'),
    ).toBe('top')
  })

  it('returns undefined when nothing is reachable, and tolerates undefined input', () => {
    expect(firstAnnotation({ type: 'string' }, 'description')).toBeUndefined()
    expect(firstAnnotation(undefined, 'description')).toBeUndefined()
    expect(firstAnnotation({ allOf: [] }, 'default')).toBeUndefined()
  })

  it('finds a default of `false` — a falsy value is still a value', () => {
    // A naive `||` or truthiness check would drop this and silently make a
    // boolean flag look required.
    expect(firstAnnotation({ default: false }, 'default')).toBe(false)
    expect(firstAnnotation({ allOf: [{ default: 0 }] }, 'default')).toBe(0)
  })
})

describe('fieldMetadata() — reading a real schema through the JSON-Schema lowering', () => {
  it('reads a required string field', () => {
    const input = Schema.Struct({
      code: Schema.String.annotate({ description: 'the code' }),
    })
    expect(fieldMetadata(input)).toEqual([
      { name: 'code', description: 'the code', default: undefined, required: true },
    ])
  })

  /**
   * The `Schema.Finite` trap: its description lands under `allOf`, so a
   * top-level-only reader renders `--budget-ms` with a BLANK doc and nothing
   * fails. This test is the regression guard for that specific silent failure.
   */
  it('recovers a Schema.Finite description from under allOf', () => {
    const input = Schema.Struct({
      budgetMs: Schema.Finite.annotate({
        description: 'Solver budget in milliseconds',
        default: 5000,
      }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(5000))),
    })
    const [field] = fieldMetadata(input)
    expect(field?.description).toBe('Solver budget in milliseconds')
    expect(field?.default).toBe(5000)
    expect(field?.required).toBe(false)
  })

  it('proves the trap is real: Finite does NOT put description at the top level', () => {
    // The negative control for the walk. If a future beta moves the annotation
    // to the top level this fails, which is the signal to simplify the reader —
    // not a bug.
    const input = Schema.Struct({
      n: Schema.Finite.annotate({ description: 'nested doc', default: 1 }),
    })
    const node = inputJsonSchema(input).properties?.n
    expect(node?.description).toBeUndefined()
    expect(node?.allOf).toBeDefined()
    // …and the walk finds it anyway.
    expect(fieldMetadata(input)[0]?.description).toBe('nested doc')
  })

  it('separates required from defaulted fields', () => {
    const input = Schema.Struct({
      req: Schema.String.annotate({ description: 'required one' }),
      opt: Schema.String.annotate({ description: 'optional one', default: 'root' }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed('root')),
      ),
    })
    const meta = fieldMetadata(input)
    expect(meta.find((f) => f.name === 'req')?.required).toBe(true)
    expect(meta.find((f) => f.name === 'opt')?.required).toBe(false)
    expect(meta.find((f) => f.name === 'opt')?.default).toBe('root')
  })

  it('returns an empty list for a no-input operation', () => {
    expect(fieldMetadata(Schema.Struct({}))).toEqual([])
  })
})

/**
 * `Schema.Struct({})` lowers to `{anyOf:[{type:'object'},{type:'array'}]}`, which
 * would tell an agent that a no-input command accepts an ARRAY. Normalizing it is
 * a correctness fix to the published contract, not cosmetics.
 */
describe('inputJsonSchema() — the empty-struct normalization', () => {
  it('publishes a closed empty object for a no-input operation', () => {
    expect(inputJsonSchema(Schema.Struct({}))).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('never claims a no-input operation accepts an array', () => {
    const schema = inputJsonSchema(Schema.Struct({}))
    expect(JSON.stringify(schema)).not.toContain('array')
    expect(schema).not.toHaveProperty('anyOf')
  })

  it('proves the trap is real: the raw lowering DOES offer object-or-array', () => {
    // Negative control. The normalization exists because of this exact output.
    const raw = Schema.toJsonSchemaDocument(Schema.Struct({})).schema as {
      anyOf?: readonly { type?: string }[]
    }
    expect(raw.anyOf?.map((b) => b.type)).toEqual(['object', 'array'])
  })

  it('passes a non-empty struct through as the real lowering', () => {
    const input = Schema.Struct({ a: Schema.String.annotate({ description: 'd' }) })
    const doc = inputJsonSchema(input)
    expect(doc.type).toBe('object')
    expect(doc.required).toEqual(['a'])
    expect(doc.additionalProperties).toBe(false)
  })
})

describe('defineOperation() — construction-time assertions', () => {
  const base = {
    name: 'demo',
    summary: 'a demo operation',
    type: 'demo',
  } as const

  it('accepts a fully annotated operation', () => {
    expect(() =>
      defineOperation({
        ...base,
        input: Schema.Struct({ a: Schema.String.annotate({ description: 'a doc' }) }),
        handler: () => Effect.succeed({ apiVersion: 1, type: 'demo', data: null } as const),
      }),
    ).not.toThrow()
  })

  it('accepts a no-input operation', () => {
    expect(() =>
      defineOperation({
        ...base,
        input: Schema.Struct({}),
        handler: () => Effect.succeed({ apiVersion: 1, type: 'demo', data: null } as const),
      }),
    ).not.toThrow()
  })

  it('REJECTS a field with no reachable description', () => {
    expect(() =>
      defineOperation({
        ...base,
        input: Schema.Struct({ undocumented: Schema.String }),
        handler: () => Effect.succeed({ apiVersion: 1, type: 'demo', data: null } as const),
      }),
    ).toThrow(/no reachable description/)
  })

  /**
   * The `withDecodingDefaultKey` trap: the schema defaults the value but the JSON
   * Schema does not say so, so the manifest hides it from the agent. Caught at
   * construction rather than shipped.
   */
  it('REJECTS an optional field whose default is invisible to the manifest', () => {
    expect(() =>
      defineOperation({
        ...base,
        input: Schema.Struct({
          // Annotated with a description but NOT with `default` — the exact
          // mistake the manifest cannot see.
          section: Schema.String.annotate({ description: 'section id' }).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed('root')),
          ),
        }),
        handler: () => Effect.succeed({ apiVersion: 1, type: 'demo', data: null } as const),
      }),
    ).toThrow(/declares no default/)
  })

  it('ACCEPTS the same field once the default is annotated explicitly', () => {
    expect(() =>
      defineOperation({
        ...base,
        input: Schema.Struct({
          section: Schema.String.annotate({ description: 'section id', default: 'root' }).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed('root')),
          ),
        }),
        handler: () => Effect.succeed({ apiVersion: 1, type: 'demo', data: null } as const),
      }),
    ).not.toThrow()
  })
})

describe('runOperation()', () => {
  const op = defineOperation({
    name: 'echo',
    summary: 'echo the input',
    type: 'echoed',
    input: Schema.Struct({ text: Schema.String.annotate({ description: 'text to echo' }) }),
    handler: (input) =>
      Effect.succeed({ apiVersion: 1, type: 'echoed', data: { text: input.text } } as const),
  })

  it('decodes valid input and returns the handler envelope', async () => {
    const env = await Effect.runPromise(runOperation(op, { text: 'hi' }))
    expect(env).toEqual({ apiVersion: 1, type: 'echoed', data: { text: 'hi' } })
  })

  it('fails on a MISSING field rather than passing undefined through', async () => {
    const r = await Effect.runPromise(Effect.result(runOperation(op, {})))
    expect(r._tag).toBe('Failure')
  })

  it('fails LOUDLY on an excess property — the unmapped-flag guard', async () => {
    // `{onExcessProperty:'error'}` is what makes the hand-mapped flag layer safe:
    // a flag the CLI collected but the schema does not name must not be silently
    // dropped.
    const r = await Effect.runPromise(
      Effect.result(runOperation(op, { text: 'hi', stowaway: true })),
    )
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect(String(r.failure)).toMatch(/stowaway/)
  })

  it('propagates a handler failure through the error channel', async () => {
    const failing = defineOperation({
      name: 'boom',
      summary: 'always fails',
      type: 'never',
      input: Schema.Struct({}),
      handler: () => Effect.fail(new ErrIo({ error: 'disk', suggestions: [] })),
    })
    const r = await Effect.runPromise(Effect.result(runOperation(failing, {})))
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') expect((r.failure as ErrIo)._tag).toBe('ERR_IO')
  })
})

describe('buildManifest() — projection (b)', () => {
  const opA = defineOperation({
    name: 'alpha',
    summary: 'the alpha operation',
    type: 'alphaDone',
    input: Schema.Struct({ x: Schema.String.annotate({ description: 'the x' }) }),
    handler: () => Effect.succeed({ apiVersion: 1, type: 'alphaDone', data: null } as const),
  })

  const manifest = () =>
    buildManifest({
      operations: [opA],
      apiVersion: 1,
      version: '9.9.9',
      exitCodes: [{ code: 0, meaning: 'clean' }],
      // All three catalogs are REQUIRED arguments, not optional ones, which is what
      // makes "the manifest publishes every stable code" structural: a build that
      // forgot a catalog would not compile rather than shipping a partial contract.
      errorCodes: [{ code: 'ERR_IO', description: 'io' }],
      findingCodes: [{ code: 'FND_CONTRADICTION', description: 'a proven conflict' }],
      lintCodes: [{ code: 'GTWR_R1_PATTERN', description: 'not EARS' }],
    })

  it('reads name, summary and type off the operation', () => {
    const row = manifest().operations[0]
    expect(row?.name).toBe('alpha')
    expect(row?.summary).toBe(opA.summary)
    expect(row?.type).toBe('alphaDone')
  })

  it('publishes the SAME JSON Schema the flag derivation reads', () => {
    // Shared provenance is the whole claim; asserting identity of the object
    // makes "provably the same artifact" a test rather than a comment.
    expect(manifest().operations[0]?.input).toEqual(inputJsonSchema(opA.input))
  })

  it('carries the version, apiVersion, exit codes and error codes through', () => {
    const m = manifest()
    expect(m.apiVersion).toBe(1)
    expect(m.version).toBe('9.9.9')
    expect(m.exitCodes).toEqual([{ code: 0, meaning: 'clean' }])
    expect(m.errorCodes).toEqual([{ code: 'ERR_IO', description: 'io' }])
  })

  it('is JSON-serializable', () => {
    expect(() => JSON.stringify(manifest())).not.toThrow()
  })
})

describe('operationHelp() / tableHelp() — projection (c)', () => {
  const op = defineOperation({
    name: 'gamma',
    summary: 'the gamma operation',
    type: 'gammaDone',
    input: Schema.Struct({
      one: Schema.String.annotate({ description: 'field one' }),
      two: Schema.Finite.annotate({ description: 'field two', default: 3 }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(3)),
      ),
    }),
    handler: () => Effect.succeed({ apiVersion: 1, type: 'gammaDone', data: null } as const),
  })

  it('carries the table summary, not a restatement', () => {
    expect(operationHelp(op).summary).toBe(op.summary)
  })

  it('lists every flag with a non-blank description', () => {
    const help = operationHelp(op)
    expect(help.flags.map((f) => f.name)).toEqual(['one', 'two'])
    for (const flag of help.flags) expect(flag.description.length).toBeGreaterThan(0)
  })

  it('projects the whole table', () => {
    expect(tableHelp([op, op]).map((h) => h.name)).toEqual(['gamma', 'gamma'])
  })
})

describe('flagName() — camelCase to kebab-case', () => {
  it('converts camelCase', () => {
    expect(flagName('dryRun')).toBe('dry-run')
    expect(flagName('budgetMs')).toBe('budget-ms')
    expect(flagName('failOnUnmatchedAtoms')).toBe('fail-on-unmatched-atoms')
  })

  it('leaves an all-lowercase name alone', () => {
    expect(flagName('code')).toBe('code')
    expect(flagName('doc')).toBe('doc')
  })

  it('is deterministic', () => {
    expect(flagName('someField')).toBe(flagName('someField'))
  })
})
