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

import { Console, Effect, Option, Schema } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'
import { isErrorEnvelope } from './kernel/envelope.ts'
import { toErrorEnvelope } from './kernel/errors.ts'
import { exitCodeForEnvelope } from './kernel/exit.ts'
import { fieldMetadata, flagName, type Operation, runOperation } from './kernel/operation.ts'
import { type OutputFlags, renderOutput } from './kernel/output.ts'
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
 *
 * ## Where the output flags enter, and why that placement is the guarantee
 *
 * `--pretty` / `--dense` / `--field` are read from the ROOT command's shared
 * flags (`yield* root`) and passed to {@link renderOutput}, which is the LAST
 * thing that happens to an envelope. The failure path still re-fails the same
 * error object regardless of how it was rendered, so the exit code is computed
 * from the envelope's semantics and the formatting flags have no channel to reach
 * it. "Output flags never change the exit code" is therefore structural here, not
 * a convention someone has to remember.
 */
const emit = <Fields extends Schema.Struct.Fields, T extends string, D>(
  op: Operation<Fields, T, D>,
  raw: unknown,
) =>
  Effect.gen(function* () {
    const flags = yield* outputFlags
    const result = yield* Effect.result(runOperation(op, raw))
    if (result._tag === 'Failure') {
      const failure = result.failure
      // A SchemaError is a usage error, not an operational one — let it through
      // to the CLI runtime rather than dressing it as an ERR_* envelope.
      if (Schema.isSchemaError(failure)) return yield* Effect.fail(failure)
      const envelope = toErrorEnvelope(failure)
      yield* Console.log(renderOutput(envelope, flags))
      return yield* Effect.fail(failure)
    }
    yield* Console.log(renderOutput(result.success, flags))
  })

// ---------------------------------------------------------------------------
// The root command and its shared output flags
// ---------------------------------------------------------------------------

/**
 * The root command, carrying the output-shaping flags as SHARED flags.
 *
 * Shared (not per-command) for two reasons. Mechanically, `withSharedFlags` makes
 * them available to every descendant handler via `yield* root` and accepts them
 * both before and after the subcommand name, npm-style, so `symspec --pretty
 * version` and `symspec version --pretty` both work. Semantically, they are a
 * property of the CLI SURFACE rather than of any use case: putting them in an
 * operation's input schema would publish them in that operation's manifest row as
 * if they affected its behavior, when they only affect its rendering.
 *
 * Declared BEFORE the subcommands because their handlers read it. The subcommands
 * are attached below, which is why `root` and {@link rootWithSubcommands} are two
 * bindings rather than one.
 */
export const root = Command.make('symspec')
  .pipe(
    Command.withDescription(
      'Neurosymbolic spec validator for coding agents. Every command emits one JSON envelope on stdout.',
    ),
  )
  .pipe(
    Command.withSharedFlags({
      pretty: Flag.boolean('pretty').pipe(
        Flag.withDescription(
          'Render human-readable prose instead of the default JSON envelope. Opt-in: JSON is the zero-flag default so an agent never needs a flag to get parseable output. Never changes the exit code.',
        ),
      ),
      dense: Flag.boolean('dense').pipe(
        Flag.withDescription(
          'Minify the envelope and elide the heavy `evidence` payload — token economy for an agent, in the SAME typed shape (no key is ever abbreviated). Never changes the exit code.',
        ),
      ),
      evidence: Flag.boolean('evidence').pipe(
        Flag.withDescription(
          'Keep the `evidence` payload under --dense. The escape hatch for a real investigation into a finding`s proof.',
        ),
      ),
      field: Flag.optional(
        Flag.string('field').pipe(
          Flag.withDescription(
            'Project the envelope down to comma-separated dotted paths (e.g. `data.verified,data.findings.0.code`), so a fix loop can read one value without a JSON tool. The result nests to mirror the requested paths; an unresolved path is omitted. Never changes the exit code.',
          ),
        ),
      ),
    }),
  )

/**
 * Read the root command's shared output flags into the plain
 * {@link OutputFlags} shape.
 *
 * `Flag.optional` yields an `Option`, so `--field`'s absence becomes `null` here
 * — the same "absent means null at the boundary" convention the doc-path flag
 * uses. Declared AFTER `root`: it is an eagerly-evaluated module-level const that
 * READS `root`, so placing it above would be a temporal-dead-zone
 * `ReferenceError` at import that `tsc --noEmit` does not catch.
 */
const outputFlags = Effect.map(
  root,
  (config): OutputFlags => ({
    pretty: config.pretty,
    dense: config.dense,
    evidence: config.evidence,
    field: Option.getOrNull(config.field),
  }),
)

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

/** The root command with every subcommand attached — the runnable tree. */
const rootWithSubcommands = root.pipe(
  Command.withSubcommands([manifestCommand, explainCommand, versionCommand]),
)

/** The runnable CLI, with `--version` wired to the single version constant. */
export const cli = Command.run(rootWithSubcommands, { version: VERSION })

/** Re-exported so the entry point does not need a second import path. */
export { exitCodeForEnvelope, isErrorEnvelope }
