/**
 * The OPERATIONS TABLE — the kernel of symspec v5.
 *
 * ## The claim this module exists to enforce
 *
 * Every use case is ONE entry in one table. The CLI command tree, the
 * machine-readable manifest, and `--help` are all PROJECTIONS of that table, not
 * parallel artifacts kept in sync. The donor's triple-wiring (a commander
 * command, a hand-written manifest row, and a `descriptions.ts` entry) plus the
 * roundtrip drift test that policed it simply do not exist here: a new operation
 * becomes visible on every surface by being appended to the table, and drift is
 * unrepresentable rather than merely tested for.
 *
 * ## What an entry carries
 *
 * - `name` — the CLI subcommand and the manifest key.
 * - `summary` — the SINGLE source for both `--help` and the manifest. Never
 *   restated in either projection.
 * - `type` — the success envelope's discriminant. Cannot be `'error'`
 *   ({@link NotError} makes that a compile error).
 * - `input` — an `effect/Schema` Struct that is SIMULTANEOUSLY the runtime
 *   validator, the JSON-Schema source for the manifest, and the origin of the
 *   CLI flags' descriptions and defaults.
 * - `handler` — an Effect returning the success envelope, failing only with a
 *   catalog {@link OperationalError}.
 *
 * ## The two annotation traps this module walks around
 *
 * Both are SILENT failures verified in spike S2, and both are why
 * {@link fieldMetadata} reads through the JSON-Schema lowering rather than
 * top-level annotations:
 *
 * 1. `Schema.Finite` buries `description` under `allOf` (it is a refinement), so
 *    a naive top-level read renders a numeric flag's help text BLANK and nothing
 *    fails. {@link firstAnnotation} walks `allOf`/`anyOf`/`oneOf`.
 * 2. `withDecodingDefaultKey` does NOT emit `default` into the JSON Schema, so a
 *    defaulted field's default is invisible to the manifest unless it is ALSO
 *    annotated explicitly. {@link defineOperation} asserts the pairing at
 *    construction time (see {@link assertFieldMetadata}) so a forgotten
 *    annotation is a startup failure rather than a silently incomplete manifest.
 *
 * ## Why derivation goes through JSON Schema
 *
 * Reading descriptions and defaults out of `Schema.toJsonSchemaDocument` — the
 * exact artifact the manifest publishes — means the CLI's help text and the
 * manifest are provably the same bytes, not two readings of one schema that
 * could diverge. The alternative (walking `schema.fields[k].ast`) conflates
 * `Schema.optional(X)` with a genuine union and is not what the manifest ships.
 */

import { Effect, Schema } from 'effect'
import type { NotError, OkEnvelope } from './envelope.ts'
import type { OperationalError } from './errors.ts'

// ---------------------------------------------------------------------------
// The JSON-Schema view an operation's metadata is read through
// ---------------------------------------------------------------------------

/**
 * A JSON-Schema node, as far as metadata extraction cares.
 *
 * The `allOf`/`anyOf`/`oneOf` branches are not decoration: refinements
 * (`Schema.Finite`) and unions nest their annotations one level down, so any
 * reader that ignores them loses help text silently.
 */
export interface JsonSchemaNode {
  readonly type?: string
  readonly description?: string
  readonly default?: unknown
  readonly enum?: readonly unknown[]
  readonly allOf?: readonly JsonSchemaNode[]
  readonly anyOf?: readonly JsonSchemaNode[]
  readonly oneOf?: readonly JsonSchemaNode[]
}

/** A struct's lowered JSON Schema: its properties and its required set. */
interface JsonSchemaStruct {
  readonly type?: string
  readonly properties?: Record<string, JsonSchemaNode>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

/**
 * Walk a node and its `allOf`/`anyOf`/`oneOf` branches for the first defined
 * value of `key`, depth-first.
 *
 * This is the workaround for S2 surprise #4: `Schema.Finite` emits
 * `{type:'number', allOf:[{description:'…'}]}` while `Schema.String` and
 * `Schema.Boolean` put `description` at the top level. Without the walk, every
 * numeric flag renders a blank description and no test fails.
 */
export const firstAnnotation = <K extends 'description' | 'default'>(
  node: JsonSchemaNode | undefined,
  key: K,
): JsonSchemaNode[K] | undefined => {
  if (node === undefined) return undefined
  if (node[key] !== undefined) return node[key]
  for (const branch of [node.allOf, node.anyOf, node.oneOf]) {
    for (const child of branch ?? []) {
      const found = firstAnnotation(child, key)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * The JSON Schema of an operation's input struct — the exact object the manifest
 * publishes, so anything derived from it is provably the same artifact the
 * manifest shows.
 *
 * ## The empty-struct trap (a NEW silent defect, beyond the 8 known)
 *
 * `Schema.toJsonSchemaDocument(Schema.Struct({}))` does NOT lower to
 * `{type:'object', properties:{}}` as one would expect. It lowers to
 * `{anyOf:[{type:'object'},{type:'array'}]}` — the JSON-Schema encoding of "any
 * non-null object-ish value", because an empty struct constrains nothing.
 *
 * That is actively MISLEADING in a manifest an agent reads to decide how to call
 * an operation: `manifest` and `version` take no input at all, but the published
 * schema says they accept an object OR AN ARRAY. Nothing fails; the agent is just
 * told something false.
 *
 * Normalized here rather than at the manifest, so every consumer of this function
 * — the manifest, the flag derivation, the help projection, and the drift tests —
 * sees the same honest shape: a closed object with no properties. Detection is on
 * `input.fields`, not on the lowered output, so it cannot misfire on a schema that
 * legitimately produced an `anyOf`.
 */
export const inputJsonSchema = (input: Schema.Struct<Schema.Struct.Fields>): JsonSchemaStruct => {
  if (Object.keys(input.fields).length === 0) {
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
  return Schema.toJsonSchemaDocument(input).schema as JsonSchemaStruct
}

/** Everything a projection needs to know about one input field. */
export interface FieldMetadata {
  readonly name: string
  /** Single-sourced help text. Guaranteed non-blank (construction asserts it). */
  readonly description: string
  /** The schema-declared default, or `undefined` for a required field. */
  readonly default: unknown
  /** Whether the field is in the schema's `required` set. */
  readonly required: boolean
}

/**
 * Read every input field's projection metadata off the lowered JSON Schema, in
 * declaration order.
 */
export const fieldMetadata = (
  input: Schema.Struct<Schema.Struct.Fields>,
): readonly FieldMetadata[] => {
  const doc = inputJsonSchema(input)
  const required = new Set(doc.required ?? [])
  return Object.entries(doc.properties ?? {}).map(([name, node]) => {
    const description = firstAnnotation(node, 'description')
    return {
      name,
      description: typeof description === 'string' ? description : '',
      default: firstAnnotation(node, 'default'),
      required: required.has(name),
    }
  })
}

// ---------------------------------------------------------------------------
// The table entry
// ---------------------------------------------------------------------------

/**
 * The METADATA view of an operation — everything the projections read, and
 * nothing they do not.
 *
 * This is the type the heterogeneous table is stored as, and it is why no `any`
 * appears anywhere in this kernel. The projections (`manifest`, help, the drift
 * tests) touch only `name`, `summary`, `type`, and `input`; none of them invokes
 * a handler. Dropping `handler` from the iteration view therefore drops the only
 * member whose type varies in a way an existential would have to erase, so a
 * concrete `Operation<Fields, T, D>` is assignable to this WITHOUT a cast —
 * `Schema.Struct<Fields>` widens to `Schema.Struct<Schema.Struct.Fields>`
 * covariantly, while a `handler` (contravariant in its input) would not.
 *
 * S2 finding 1 hit this from the other side: it typed the table as
 * `Operation<any, any, any>` and found that a shared RUNNER over that type does
 * not typecheck. The conclusion there was "keep the runner generic and reserve
 * the existential for iteration". Narrowing the ITERATION type to metadata is the
 * same conclusion carried one step further, and it removes the `any` entirely —
 * which matters because `noExplicitAny` is an error in this repo's lint config.
 */
export interface OperationMetadata {
  /** The CLI subcommand name and the manifest key. */
  readonly name: string
  /** The single source for the manifest summary AND the `--help` description. */
  readonly summary: string
  /** The success envelope's discriminant. */
  readonly type: string
  /** Runtime validator, manifest JSON-Schema source, and CLI flag origin, at once. */
  readonly input: Schema.Struct<Schema.Struct.Fields>
}

/**
 * One operation: the whole definition of a use case, as data.
 *
 * Generic in its input fields, its success `type`, its payload, and its handler's
 * SERVICE REQUIREMENTS, so a handler's full signature is precise at the
 * definition site. The heterogeneous TABLE is stored as
 * {@link OperationMetadata}.
 *
 * ## Why `R` exists
 *
 * `manifest`, `explain`, and `version` need nothing from the world, so G1's first
 * three operations had `R = never` implicitly. Every operation that touches a
 * DOCUMENT needs the store and the path resolver, and those arrive as Effect
 * services. Declaring the requirement in the type — rather than reaching for a
 * module-level singleton — is what keeps a handler testable against an in-memory
 * store and keeps the composition root the only place that decides where a
 * document actually lives.
 *
 * `R` defaults to `never` so the three existing definitions are untouched: an
 * operation that needs nothing still reads as `Operation<Fields, T, D>`.
 */
export interface Operation<Fields extends Schema.Struct.Fields, T extends string, D, R = never> {
  /** The CLI subcommand name and the manifest key. */
  readonly name: string
  /** The single source for the manifest summary AND the `--help` description. */
  readonly summary: string
  /** The success envelope's discriminant. `'error'` is rejected at compile time. */
  readonly type: NotError<T>
  /** Runtime validator, manifest JSON-Schema source, and CLI flag origin, at once. */
  readonly input: Schema.Struct<Fields>
  /** The behavior. Fails only with a catalog error; may require services. */
  readonly handler: (
    input: Schema.Struct<Fields>['Type'],
  ) => Effect.Effect<OkEnvelope<T, D>, OperationalError, R>
}

/**
 * The type the heterogeneous operations table is iterated as.
 *
 * An alias for {@link OperationMetadata}, kept as its own name because
 * "AnyOperation" is what the call sites mean. Behavior is never reached through
 * this type — a handler is only ever invoked via the fully generic
 * {@link runOperation}, which preserves each operation's precise input and
 * payload types.
 */
export type AnyOperation = OperationMetadata

/**
 * Assert an operation's input schema exposes complete projection metadata, at
 * construction time.
 *
 * Two failure classes, both otherwise SILENT:
 *
 * - A field with no reachable `description` means a projection lost its single
 *   source: `--help` would render a blank flag doc and the manifest a blank
 *   property. S2 caught exactly this for `Schema.Finite` only by diffing help
 *   against the manifest.
 * - An OPTIONAL field with no `default` in the JSON Schema is the
 *   `withDecodingDefaultKey` trap: the schema defaults the value at decode time
 *   but the manifest cannot see it, so an agent reading the manifest does not
 *   know what it will get. The fix is an explicit `.annotate({default})`
 *   alongside the pipe, and this assertion is what forces it.
 *
 * Throwing at module load makes both a startup failure rather than a
 * wrong-looking manifest, which is the S2 recommendation to make "no description
 * reachable" a build/test-time failure.
 */
const assertFieldMetadata = (name: string, input: Schema.Struct<Schema.Struct.Fields>): void => {
  for (const field of fieldMetadata(input)) {
    if (field.description === '') {
      throw new Error(
        `Operation "${name}" field "${field.name}" has no reachable description annotation — ` +
          'the manifest and --help would both render it blank. Annotate the field with ' +
          '{description}. (Note: Schema.Finite nests annotations under allOf.)',
      )
    }
    if (!field.required && field.default === undefined) {
      throw new Error(
        `Operation "${name}" field "${field.name}" is optional but declares no default in its ` +
          'JSON Schema. withDecodingDefaultKey does NOT emit `default`, so the manifest would ' +
          'hide it — add an explicit .annotate({default: …}) alongside the pipe.',
      )
    }
  }
}

/**
 * Define one table entry, validating its projection metadata immediately.
 *
 * The identity-with-a-check shape is what makes the table's invariants
 * non-negotiable: an operation that cannot project cannot be constructed.
 */
export const defineOperation = <Fields extends Schema.Struct.Fields, T extends string, D, R>(
  op: Operation<Fields, T, D, R>,
): Operation<Fields, T, D, R> => {
  assertFieldMetadata(op.name, op.input)
  return op
}

// ---------------------------------------------------------------------------
// Running an operation
// ---------------------------------------------------------------------------

/**
 * Decode raw CLI input against the operation's schema, then run its handler.
 *
 * `{onExcessProperty: 'error'}` turns a flag the CLI collected but the schema
 * does not name into a LOUD failure instead of a silently dropped value — the
 * guard that makes the hand-mapped flag layer safe. Verified to fire in S2.
 *
 * Kept fully generic (not typed against {@link AnyOperation}) for the reason
 * documented there.
 */
export const runOperation = <Fields extends Schema.Struct.Fields, T extends string, D, R>(
  op: Operation<Fields, T, D, R>,
  raw: unknown,
): Effect.Effect<
  OkEnvelope<T, D>,
  OperationalError | Schema.SchemaError,
  // TWO requirement sources, unioned:
  //
  // - `R` — what the HANDLER needs (the doc store, the path resolver, …). The
  //   composition root provides these; a handler that needs nothing resolves it
  //   to `never`.
  // - `Schema.Struct.DecodingServices<Fields>` — what DECODING needs. Not
  //   `never`: a schema may require a service for an effectful default or a
  //   transformation, and that shows up in R. Declaring it `never` is a type
  //   error rather than a widening, which is the honest outcome — the channel is
  //   propagated so a future op whose input genuinely needs a service composes,
  //   and today's service-free schemas resolve it to `never` at the call site.
  R | Schema.Struct.DecodingServices<Fields>
> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(op.input, { onExcessProperty: 'error' })(raw)
    return yield* op.handler(input)
  })

// ---------------------------------------------------------------------------
// Projection: the manifest
// ---------------------------------------------------------------------------

/** One operation's manifest row. */
export interface ManifestOperation {
  readonly name: string
  readonly summary: string
  readonly type: string
  readonly input: unknown
}

/** One row of a stable-code catalog: the code an agent switches on, and what it
 * means. Shared by all three catalogs so an agent parses one shape. */
export interface CodeRow {
  readonly code: string
  readonly description: string
}

/**
 * The manifest payload: the whole agent-facing contract in one object.
 *
 * ## All THREE code catalogs, not one
 *
 * The spec's standing constraint is that all 75 stable codes (21 `ERR_*` / 24
 * `GTWR_*` / 30 `FND_*`) survive with meanings intact, and that "codes are the API
 * agents switch on". G1 published only `errorCodes`, which was honest for a build
 * whose operations could not yet emit a finding — `check` did not exist. Once it
 * did, an agent reading the manifest to learn what `FND_CONTRADICTION` means found
 * nothing, and the codes it actually has to branch on were the two catalogs the
 * manifest omitted.
 *
 * So `findingCodes` (FND_*) and `lintCodes` (GTWR_*) join it here, read from the
 * transplanted catalogs' own description corpora — one projection each, no hand
 * table. `manifest.test.ts` asserts the total is 75 and that each catalog's order is
 * its append-only order.
 */
export interface Manifest {
  readonly apiVersion: number
  readonly version: string
  readonly operations: readonly ManifestOperation[]
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[]
  /** The 21 `ERR_*` operational-failure codes. An error envelope's `code`. */
  readonly errorCodes: readonly CodeRow[]
  /** The 30 `FND_*` finding codes. A `check` finding's `code`. */
  readonly findingCodes: readonly CodeRow[]
  /** The 24 `GTWR_*` lint rule codes. A lint-tier finding's `code`, and what a
   * `waive` op names. */
  readonly lintCodes: readonly CodeRow[]
}

/**
 * Build the manifest from the table — projection (b).
 *
 * Every row is READ from the operation, never restated: `summary` is the table's
 * own string and `input` is the same `toJsonSchemaDocument` output the CLI flags
 * take their descriptions and defaults from. That shared provenance is what the
 * drift tests assert, and what makes the assertion meaningful.
 */
export const buildManifest = (args: {
  readonly operations: readonly AnyOperation[]
  readonly apiVersion: number
  readonly version: string
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[]
  readonly errorCodes: readonly CodeRow[]
  readonly findingCodes: readonly CodeRow[]
  readonly lintCodes: readonly CodeRow[]
}): Manifest => ({
  apiVersion: args.apiVersion,
  version: args.version,
  operations: args.operations.map((op) => ({
    name: op.name,
    summary: op.summary,
    type: op.type,
    input: inputJsonSchema(op.input),
  })),
  exitCodes: args.exitCodes,
  errorCodes: args.errorCodes,
  findingCodes: args.findingCodes,
  lintCodes: args.lintCodes,
})

// ---------------------------------------------------------------------------
// Projection: help metadata
// ---------------------------------------------------------------------------

/**
 * The help view of one operation: its summary plus each flag's derived
 * description and default.
 *
 * This is the same data `--help` renders and the same data the manifest
 * publishes, exposed as one structure so the drift tests can compare the two
 * surfaces field by field without scraping rendered text.
 */
export interface OperationHelp {
  readonly name: string
  readonly summary: string
  readonly flags: readonly FieldMetadata[]
}

/** Build the help projection for one operation — projection (c). */
export const operationHelp = (op: AnyOperation): OperationHelp => ({
  name: op.name,
  summary: op.summary,
  flags: fieldMetadata(op.input),
})

/** Build the help projection for the whole table. */
export const tableHelp = (operations: readonly AnyOperation[]): readonly OperationHelp[] =>
  operations.map(operationHelp)

/**
 * camelCase field name → kebab-case CLI flag spelling (`dryRun` → `dry-run`).
 *
 * Deterministic and shared, so the flag spelling in the CLI tree and the
 * spelling the drift tests expect come from one rule rather than two hand-typed
 * strings.
 */
export const flagName = (field: string): string =>
  field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
