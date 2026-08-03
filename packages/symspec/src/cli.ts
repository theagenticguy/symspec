/**
 * The CLI projection — projection (a) of the operations table.
 *
 * This file contains NO operation knowledge beyond the field→`Flag`-constructor
 * choice. Names, summaries, flag descriptions, flag defaults, and all behavior
 * come from the table; nothing about an operation is restated here in prose.
 *
 * ## What is still hand-mapped, and why that is the right line
 *
 * One thing is declared per input field: WHICH `Flag` constructor it uses
 * (`Flag.string` / `Flag.integer` / `Flag.boolean`). Nothing in a JSON Schema
 * says whether a field should be a flag or a positional argument, or whether a
 * string is a file path, so a fully generic deriver would have to guess. S2's
 * recommendation was to derive ~80% and declare the exceptions; that is what
 * {@link decorate} does — the constructor is declared, while description and
 * default are DERIVED from the schema, which is where drift actually lives.
 *
 * `{onExcessProperty:'error'}` in `runOperation` is the guard on this seam: a
 * flag collected here but absent from the schema is a loud failure, not a
 * silently dropped value.
 */

import { Console, Effect, Schema } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'
import { isErrorEnvelope, renderEnvelope } from './kernel/envelope.ts'
import { toErrorEnvelope } from './kernel/errors.ts'
import { exitCodeForEnvelope } from './kernel/exit.ts'
import { fieldMetadata, flagName, type Operation, runOperation } from './kernel/operation.ts'
import { VERSION } from './kernel/version.ts'
import { explainOp, manifestOp, versionOp } from './operations/index.ts'

// ---------------------------------------------------------------------------
// Emitting an envelope
// ---------------------------------------------------------------------------

/**
 * Run an operation and write its envelope to STDOUT — success and failure alike.
 *
 * Both streams' contents are contract (see `renderEnvelope`'s note): stdout
 * carries exactly one JSON envelope, stderr carries no envelope at all. On
 * failure the envelope is written and then the error is RE-FAILED, so
 * `Runtime.errorExitCode` on the error class produces exit 2 declaratively
 * instead of a `process.exit` call. `Runtime.errorReported = false` on those
 * classes is what stops runMain printing a second, human-shaped report after the
 * JSON an agent just parsed.
 *
 * A decode failure (`SchemaError`) is deliberately NOT caught here: it means a
 * flag the CLI collected does not match the schema, which is a usage error, and
 * the CLI runtime already exits 1 for usage. Swallowing it into an ERR_* envelope
 * would relabel a usage bug as an operational one.
 */
const emit = <Fields extends Schema.Struct.Fields, T extends string, D>(
  op: Operation<Fields, T, D>,
  raw: unknown,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(runOperation(op, raw))
    if (result._tag === 'Failure') {
      const failure = result.failure
      // A SchemaError is a usage error, not an operational one — let it through
      // to the CLI runtime rather than dressing it as an ERR_* envelope.
      if (Schema.isSchemaError(failure)) return yield* Effect.fail(failure)
      const envelope = toErrorEnvelope(failure)
      yield* Console.log(renderEnvelope(envelope))
      return yield* Effect.fail(failure)
    }
    yield* Console.log(renderEnvelope(result.success))
  })

// ---------------------------------------------------------------------------
// Flag derivation
// ---------------------------------------------------------------------------

/**
 * Attach the SCHEMA-SOURCED description and default to a flag.
 *
 * This is the whole single-source mechanism for flag metadata: the description
 * and the default are read out of the same JSON-Schema document the manifest
 * publishes, so `--help` and the manifest are provably the same bytes rather than
 * two readings that could diverge. `Flag.withDefault` is applied ONLY when the
 * schema declares a default, so a required field stays required and produces a
 * usage error (exit 1) when absent.
 *
 * A missing description is impossible to reach here: `defineOperation` throws at
 * construction time, which is the build-time failure S2 recommended over a
 * runtime throw buried in a projection.
 */
const decorate = <A>(
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
  flag: Flag.Flag<A>,
): Flag.Flag<A> => {
  const meta = fieldMetadata(op.input).find((f) => f.name === field)
  if (meta === undefined) {
    throw new Error(`Operation "${op.name}" has no input field "${field}" to derive a flag from`)
  }
  const described = flag.pipe(Flag.withDescription(meta.description))
  return meta.default === undefined
    ? described
    : described.pipe(Flag.withDefault(meta.default as A))
}

/** A string flag for `field`, spelled in kebab-case and decorated from the schema. */
const stringFlag = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => decorate(op, field, Flag.string(flagName(field)))

// ---------------------------------------------------------------------------
// The command tree
// ---------------------------------------------------------------------------

/**
 * `Command.withDescription(op.summary)` — the summary is READ from the table, so
 * `--help` and the manifest cannot disagree about what a command does. This is
 * the identity the drift tests assert.
 */
const manifestCommand = Command.make('manifest', {}, () => emit(manifestOp, {})).pipe(
  Command.withDescription(manifestOp.summary),
)

const explainCommand = Command.make('explain', { code: stringFlag(explainOp, 'code') }, (config) =>
  emit(explainOp, config),
).pipe(Command.withDescription(explainOp.summary))

const versionCommand = Command.make('version', {}, () => emit(versionOp, {})).pipe(
  Command.withDescription(versionOp.summary),
)

/** The root command. */
export const root = Command.make('symspec')
  .pipe(
    Command.withDescription(
      'Neurosymbolic spec validator for coding agents. Every command emits one JSON envelope on stdout.',
    ),
  )
  .pipe(Command.withSubcommands([manifestCommand, explainCommand, versionCommand]))

/** The runnable CLI, with `--version` wired to the single version constant. */
export const cli = Command.run(root, { version: VERSION })

/** Re-exported so the entry point does not need a second import path. */
export { exitCodeForEnvelope, isErrorEnvelope }
