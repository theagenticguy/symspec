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

import { Console, Data, Effect, Option, Runtime, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import { isErrorEnvelope } from './kernel/envelope.ts'
import { toErrorEnvelope } from './kernel/errors.ts'
import { EXIT_CLEAN, type ExitCode, exitCodeForEnvelope } from './kernel/exit.ts'
import { fieldMetadata, flagName, type Operation, runOperation } from './kernel/operation.ts'
import { type OutputFlags, renderOutput } from './kernel/output.ts'
import { VERSION } from './kernel/version.ts'
import {
  addOp,
  antonymOp,
  applyOpDefinition,
  checkOp,
  deleteOp,
  explainOp,
  glossaryOp,
  importOp,
  initOp,
  installOp,
  linkOp,
  listOp,
  manifestOp,
  parseOp,
  showOp,
  updateOp,
  versionOp,
  waiveOp,
} from './operations/index.ts'

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
 *
 * ## The SUCCESS-path exit code, and the G1 gap it closes
 *
 * A success envelope is not automatically exit 0. `check` emits a perfectly valid
 * success envelope and still has to exit 1 (an error-severity finding is present)
 * or 3 (an opt-in strict gate tripped) — the findings ARE the data, so the envelope
 * is right and the STATUS is the pass/fail signal.
 *
 * G1 shipped `exitCodeForEnvelope` fully implemented and fully tested, but never
 * CALLED it on the success path, because no G1 operation produced findings — so
 * every reachable success was genuinely exit 0 and the omission was invisible. It
 * surfaced the moment `check` landed: `--strict` produced `data.strictGate:'fail'`
 * in the envelope and exit 0 at the shell, which is the worst kind of gate bug (a
 * CI job wired to `--strict` would pass on every inconclusive run).
 *
 * So the mapping is applied HERE, for every operation, from the ALREADY-RENDERED
 * envelope's semantics. Three properties follow:
 *
 * - the envelope is written BEFORE the code is applied, so exit 1 and exit 3 both
 *   still carry a full, parseable payload;
 * - the code is computed from the envelope, not from the operation, so an operation
 *   cannot express an exit code except by putting the facts in its payload — which
 *   is what keeps `exit.ts` the single mapping;
 * - a non-zero success code is raised by FAILING with the code marker rather than
 *   calling `process.exit`, so finalizers still run. That matters concretely: the
 *   solver Layer's release closes the WASM scope, and skipping it is how a process
 *   with a pending Z3 query fails to drain.
 */
const emit = <Fields extends Schema.Struct.Fields, T extends string, D, R>(
  op: Operation<Fields, T, D, R>,
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
    const envelope = result.success
    yield* Console.log(renderOutput(envelope, flags))
    // The envelope is out; now apply its exit semantics. `EXIT_CLEAN` returns
    // normally so the common path costs nothing.
    const code = exitCodeForEnvelope(envelope)
    if (code !== EXIT_CLEAN) return yield* Effect.fail(new GateExit({ code }))
  })

/**
 * The carrier for a NON-ZERO exit on an otherwise SUCCESSFUL run.
 *
 * A deliberately unusual error class, and each of its three properties is doing
 * work:
 *
 * - `Runtime.errorExitCode` is the code itself, so the runtime exits 1 or 3
 *   declaratively — no `process.exit`, so every finalizer (notably the solver
 *   Layer's release) still runs.
 * - `Runtime.errorReported = false` suppresses the runtime's own human-shaped
 *   report. Without it, `symspec check --strict` would print a stack trace AFTER
 *   the JSON envelope an agent just parsed. Note the marker is INVERTED relative to
 *   its name: `false` means "already reported".
 * - It is NOT one of the 21 `ERR_*` catalog classes and never becomes an error
 *   envelope. That is the point: the run SUCCEEDED, the envelope is a success
 *   envelope, and only the process STATUS differs. Reusing an `ERR_*` class here
 *   would have relabelled a findings-failure as an operational failure and
 *   collapsed the 1-vs-2 distinction the exit contract exists to make.
 */
class GateExit extends Data.TaggedError('GateExit')<{ readonly code: ExitCode }> {
  override readonly [Runtime.errorReported] = false
  override get [Runtime.errorExitCode](): number {
    return this.code
  }
}

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

/** A boolean flag for `field`, spelled in kebab-case and decorated from the schema. */
const booleanFlag = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => decorate(op, field, Flag.boolean(flagName(field)))

/**
 * An INTEGER flag for `field`, spelled in kebab-case and decorated from the schema.
 *
 * `Flag.integer`, not `Flag.string` plus a parse: a non-numeric value is then a CLI
 * usage error (exit 1) before any handler runs, which is where a malformed number
 * belongs. The alternative — accept a string and let the schema reject it — would
 * report a numeric typo as an operational failure through the error envelope, and
 * `check`'s numeric knobs are the flags most likely to be typo'd.
 */
const integerFlag = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => decorate(op, field, Flag.integer(flagName(field)))

/**
 * A FLOAT flag, decorated from the schema.
 *
 * Distinct from {@link integerFlag} because a cosine threshold is genuinely
 * fractional — `Flag.integer` would reject `0.72`, and the ONE value this flag exists
 * to set is a decimal. `Flag.float` keeps a malformed value a CLI usage error (exit 1)
 * before any handler runs, which is where a numeric typo belongs.
 */
const floatFlag = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => decorate(op, field, Flag.float(flagName(field)))

/**
 * An OPTIONAL POSITIONAL argument for a doc-path field, decorated from the schema.
 *
 * A positional (not a flag) for the document path, matching the donor's shape:
 * `symspec list ./requirements.json` is what an agent naturally types, and the
 * donor's own error text confirms an agent tries exactly that. The description is
 * still read from the schema, so the single-source property holds across the
 * flag/argument distinction.
 *
 * `Argument.optional` yields an `Option`, unwrapped to `null` at the handler
 * boundary — the same convention the schema's `NullOr` default encodes, so the two
 * halves agree without a translation table.
 */
const pathArgument = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => {
  const meta = fieldMetadata(op.input).find((f) => f.name === field)
  if (meta === undefined) {
    throw new Error(
      `Operation "${op.name}" has no input field "${field}" to derive an argument from`,
    )
  }
  return Argument.optional(Argument.string(field).pipe(Argument.withDescription(meta.description)))
}

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

const initCommand = Command.make(
  'init',
  { file: pathArgument(initOp, 'file'), force: booleanFlag(initOp, 'force') },
  (config) => emit(initOp, { file: Option.getOrNull(config.file), force: config.force }),
).pipe(Command.withDescription(initOp.summary))

const listCommand = Command.make('list', { file: pathArgument(listOp, 'file') }, (config) =>
  emit(listOp, { file: Option.getOrNull(config.file) }),
).pipe(Command.withDescription(listOp.summary))

/**
 * `show <ref>` takes its ref as a REQUIRED positional, and the doc path as a
 * second optional one — so `symspec show TX-B6` and `symspec show TX-B6 ./doc.json`
 * both read naturally. A missing ref is a usage error (exit 1) because the schema
 * field is required, which is derived, not hand-wired.
 */
const showCommand = Command.make(
  'show',
  {
    ref: Argument.string('ref').pipe(
      Argument.withDescription(
        fieldMetadata(showOp.input).find((f) => f.name === 'ref')?.description ?? '',
      ),
    ),
    file: pathArgument(showOp, 'file'),
  },
  (config) => emit(showOp, { ref: config.ref, file: Option.getOrNull(config.file) }),
).pipe(Command.withDescription(showOp.summary))

/**
 * `import` takes everything as FLAGS, not positionals — deliberately unlike the
 * other document commands.
 *
 * It has TWO paths (the op stream in, the document out), and a bare `symspec
 * import a.jsonl b.json` would be ambiguous about which is which at exactly the
 * moment an agent is doing a one-shot migration it cannot easily undo. Named flags
 * make the direction unmistakable.
 */
const importCommand = Command.make(
  'import',
  {
    file: stringFlag(importOp, 'file'),
    doc: stringFlag(importOp, 'doc'),
    force: booleanFlag(importOp, 'force'),
    dryRun: booleanFlag(importOp, 'dryRun'),
  },
  (config) => emit(importOp, config),
).pipe(Command.withDescription(importOp.summary))

/**
 * `parse [text]` — the sentence as an optional POSITIONAL, the file as a flag.
 *
 * The asymmetry with `import` (which makes both paths flags) is deliberate and comes
 * from what is ambiguous. `import` has two PATHS (stream in, document out) and a bare
 * `import a.jsonl b.json` would not say which is which. `parse` has one path and one
 * sentence, and they are not confusable: a sentence is not a path. So
 * `symspec parse "the auth service shall issue a token"` reads the way an agent
 * types it, and `--file` names the batch case explicitly.
 */
const parseCommand = Command.make(
  'parse',
  {
    text: Argument.optional(
      Argument.string('text').pipe(
        Argument.withDescription(
          fieldMetadata(parseOp.input).find((f) => f.name === 'text')?.description ?? '',
        ),
      ),
    ),
    file: stringFlag(parseOp, 'file'),
  },
  (config) => emit(parseOp, { text: Option.getOrNull(config.text), file: config.file }),
).pipe(Command.withDescription(parseOp.summary))

/**
 * `check [file]` — the document path as an optional positional (matching `list` and
 * `show`, and matching what an agent types), every knob as a flag.
 *
 * `--min-severity` is a `stringFlag` even though the schema declares a closed
 * literal set: `effect/unstable/cli` has no enum flag constructor on beta.102, and
 * the schema's `Schema.Literals` rejects an out-of-set value at decode time with
 * the legal values named. So the validation still happens exactly once, in the
 * schema, and the manifest still publishes the `enum` — the flag layer just does
 * not duplicate it.
 */
const checkCommand = Command.make(
  'check',
  {
    file: pathArgument(checkOp, 'file'),
    timeoutMs: integerFlag(checkOp, 'timeoutMs'),
    solverBudgetMs: integerFlag(checkOp, 'solverBudgetMs'),
    temporalBound: integerFlag(checkOp, 'temporalBound'),
    strict: booleanFlag(checkOp, 'strict'),
    // OPTIONAL, because omitting the flag is how the gate is disabled — a negative
    // sentinel is unreachable here (`--fail-on-unmatched -1` parses `-1` as the next
    // flag and dumps help), and 0 is the strictest legal threshold rather than a
    // sentinel. `Flag.optional` yields an `Option`, unwrapped to `null` at the
    // handler boundary, matching the schema's `NullOr` default.
    failOnUnmatched: Flag.optional(integerFlag(checkOp, 'failOnUnmatched')),
    minSeverity: stringFlag(checkOp, 'minSeverity'),
    findingsOnly: booleanFlag(checkOp, 'findingsOnly'),
    // The ONE flag here that defaults TRUE, so the spelling has to be
    // `--semantic=false` rather than a bare `--no-semantic`. `Flag.boolean` +
    // `Flag.withDefault(true)` (derived from the schema) gives exactly that.
    semantic: booleanFlag(checkOp, 'semantic'),
    // OPTIONAL for the same reason `--fail-on-unmatched` is: omitting it means "use
    // the measured default", which is a different statement from any number.
    semanticThreshold: Flag.optional(floatFlag(checkOp, 'semanticThreshold')),
  },
  (config) =>
    emit(checkOp, {
      file: Option.getOrNull(config.file),
      timeoutMs: config.timeoutMs,
      solverBudgetMs: config.solverBudgetMs,
      temporalBound: config.temporalBound,
      strict: config.strict,
      failOnUnmatched: Option.getOrNull(config.failOnUnmatched),
      minSeverity: config.minSeverity,
      findingsOnly: config.findingsOnly,
      semantic: config.semantic,
      semanticThreshold: Option.getOrNull(config.semanticThreshold),
    }),
).pipe(Command.withDescription(checkOp.summary))

// ---------------------------------------------------------------------------
// The MUTATION commands
// ---------------------------------------------------------------------------

/**
 * A REQUIRED positional argument, described from the schema.
 *
 * Positionals for the values an agent naturally types in order (`update G1 status
 * approved`), flags for everything else. The description is still read from the
 * schema, so the single-source property holds across the flag/argument distinction.
 */
const positional = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => {
  const meta = fieldMetadata(op.input).find((f) => f.name === field)
  if (meta === undefined) {
    throw new Error(`Operation "${op.name}" has no input field "${field}"`)
  }
  return Argument.string(field).pipe(Argument.withDescription(meta.description))
}

/** An OPTIONAL positional, for a value whose absence is meaningful. */
const optionalPositional = (
  op: { readonly name: string; readonly input: Schema.Struct<Schema.Struct.Fields> },
  field: string,
) => Argument.optional(positional(op, field))

const addCommand = Command.make(
  'add',
  {
    patternType: Flag.optional(stringFlag(addOp, 'patternType')),
    systemName: Flag.optional(stringFlag(addOp, 'systemName')),
    systemResponse: Flag.optional(stringFlag(addOp, 'systemResponse')),
    preCondition: Flag.optional(stringFlag(addOp, 'preCondition')),
    trigger: Flag.optional(stringFlag(addOp, 'trigger')),
    negated: booleanFlag(addOp, 'negated'),
    key: Flag.optional(stringFlag(addOp, 'key')),
    responseKind: Flag.optional(stringFlag(addOp, 'responseKind')),
    priority: Flag.optional(stringFlag(addOp, 'priority')),
    status: Flag.optional(stringFlag(addOp, 'status')),
    verificationMethod: Flag.optional(stringFlag(addOp, 'verificationMethod')),
    verificationNote: Flag.optional(stringFlag(addOp, 'verificationNote')),
    fromParse: Flag.optional(stringFlag(addOp, 'fromParse')),
    file: Flag.optional(stringFlag(addOp, 'file')),
    dryRun: booleanFlag(addOp, 'dryRun'),
  },
  (config) =>
    emit(addOp, {
      patternType: Option.getOrNull(config.patternType),
      systemName: Option.getOrNull(config.systemName),
      systemResponse: Option.getOrNull(config.systemResponse),
      preCondition: Option.getOrNull(config.preCondition),
      trigger: Option.getOrNull(config.trigger),
      negated: config.negated,
      key: Option.getOrNull(config.key),
      responseKind: Option.getOrNull(config.responseKind),
      priority: Option.getOrNull(config.priority),
      status: Option.getOrNull(config.status),
      verificationMethod: Option.getOrNull(config.verificationMethod),
      verificationNote: Option.getOrNull(config.verificationNote),
      fromParse: Option.getOrNull(config.fromParse),
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(addOp.summary))

/**
 * `update <attr> [value]` — the ATTR is a positional, the ref is a flag.
 *
 * Deliberately not the donor's `update <ref> <attr> <value>`: `--ref` and `--where` are
 * mutually exclusive, and a bulk update has no ref at all, so a leading ref positional
 * would be present in one mode and absent in the other. Naming it makes the two modes
 * read the same.
 */
const updateCommand = Command.make(
  'update',
  {
    attr: positional(updateOp, 'attr'),
    value: optionalPositional(updateOp, 'value'),
    ref: Flag.optional(stringFlag(updateOp, 'ref')),
    clear: booleanFlag(updateOp, 'clear'),
    where: Flag.optional(stringFlag(updateOp, 'where')),
    file: Flag.optional(stringFlag(updateOp, 'file')),
    dryRun: booleanFlag(updateOp, 'dryRun'),
  },
  (config) =>
    emit(updateOp, {
      attr: config.attr,
      value: Option.getOrNull(config.value),
      ref: Option.getOrNull(config.ref),
      clear: config.clear,
      where: Option.getOrNull(config.where),
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(updateOp.summary))

const deleteCommand = Command.make(
  'delete',
  {
    ref: positional(deleteOp, 'ref'),
    file: Flag.optional(stringFlag(deleteOp, 'file')),
    dryRun: booleanFlag(deleteOp, 'dryRun'),
  },
  (config) =>
    emit(deleteOp, {
      ref: config.ref,
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(deleteOp.summary))

const linkCommand = Command.make(
  'link',
  {
    from: positional(linkOp, 'from'),
    to: positional(linkOp, 'to'),
    relation: stringFlag(linkOp, 'relation'),
    remove: booleanFlag(linkOp, 'remove'),
    file: Flag.optional(stringFlag(linkOp, 'file')),
    dryRun: booleanFlag(linkOp, 'dryRun'),
  },
  (config) =>
    emit(linkOp, {
      from: config.from,
      to: config.to,
      relation: config.relation,
      remove: config.remove,
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(linkOp.summary))

const waiveCommand = Command.make(
  'waive',
  {
    code: positional(waiveOp, 'code'),
    reason: Flag.optional(stringFlag(waiveOp, 'reason')),
    ref: Flag.optional(stringFlag(waiveOp, 'ref')),
    remove: booleanFlag(waiveOp, 'remove'),
    file: Flag.optional(stringFlag(waiveOp, 'file')),
    dryRun: booleanFlag(waiveOp, 'dryRun'),
  },
  (config) =>
    emit(waiveOp, {
      code: config.code,
      reason: Option.getOrNull(config.reason),
      ref: Option.getOrNull(config.ref),
      remove: config.remove,
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(waiveOp.summary))

const glossaryCommand = Command.make(
  'glossary',
  {
    canonical: positional(glossaryOp, 'canonical'),
    alias: positional(glossaryOp, 'alias'),
    remove: booleanFlag(glossaryOp, 'remove'),
    file: Flag.optional(stringFlag(glossaryOp, 'file')),
    dryRun: booleanFlag(glossaryOp, 'dryRun'),
  },
  (config) =>
    emit(glossaryOp, {
      canonical: config.canonical,
      alias: config.alias,
      remove: config.remove,
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(glossaryOp.summary))

const antonymCommand = Command.make(
  'antonym',
  {
    a: positional(antonymOp, 'a'),
    b: positional(antonymOp, 'b'),
    remove: booleanFlag(antonymOp, 'remove'),
    file: Flag.optional(stringFlag(antonymOp, 'file')),
    dryRun: booleanFlag(antonymOp, 'dryRun'),
  },
  (config) =>
    emit(antonymOp, {
      a: config.a,
      b: config.b,
      remove: config.remove,
      file: Option.getOrNull(config.file),
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(antonymOp.summary))

/**
 * `apply` takes everything as FLAGS, and the naming is the donor's lesson applied.
 *
 * It has TWO paths (the op stream in, the document out), so `--ops` and `--file` are
 * both named. The donor registered `--doc` for the document while reusing a shared
 * description whose prose said `--file`, and its manifest consequently told an agent to
 * run `apply --file` — which returned ERR_USAGE on the flagship command.
 */
const applyCommand = Command.make(
  'apply',
  {
    ops: Flag.optional(stringFlag(applyOpDefinition, 'ops')),
    file: Flag.optional(stringFlag(applyOpDefinition, 'file')),
    continueOnError: booleanFlag(applyOpDefinition, 'continueOnError'),
    dryRun: booleanFlag(applyOpDefinition, 'dryRun'),
  },
  (config) =>
    emit(applyOpDefinition, {
      ops: Option.getOrNull(config.ops),
      file: Option.getOrNull(config.file),
      continueOnError: config.continueOnError,
      dryRun: config.dryRun,
    }),
).pipe(Command.withDescription(applyOpDefinition.summary))

/**
 * `install` — everything as FLAGS, no positionals.
 *
 * `--mode` is a `stringFlag` even though the schema declares a closed literal set, for the
 * same reason `check --min-severity` is: `effect/unstable/cli` has no enum flag
 * constructor on beta.102, and the schema's `Schema.Literals` rejects an out-of-set value
 * at decode time with the legal values named. Validation still happens exactly once, in
 * the schema, and the manifest still publishes the `enum`.
 */
const installCommand = Command.make(
  'install',
  {
    mode: stringFlag(installOp, 'mode'),
    target: Flag.optional(stringFlag(installOp, 'target')),
    global: booleanFlag(installOp, 'global'),
  },
  (config) =>
    emit(installOp, {
      mode: config.mode,
      target: Option.getOrNull(config.target),
      global: config.global,
    }),
).pipe(Command.withDescription(installOp.summary))

/** The root command with every subcommand attached — the runnable tree. */
const rootWithSubcommands = root.pipe(
  Command.withSubcommands([
    initCommand,
    importCommand,
    parseCommand,
    addCommand,
    updateCommand,
    linkCommand,
    deleteCommand,
    waiveCommand,
    glossaryCommand,
    antonymCommand,
    applyCommand,
    listCommand,
    showCommand,
    checkCommand,
    manifestCommand,
    explainCommand,
    versionCommand,
    installCommand,
  ]),
)

/** The runnable CLI, with `--version` wired to the single version constant. */
export const cli = Command.run(rootWithSubcommands, { version: VERSION })

/** Re-exported so the entry point does not need a second import path. */
export { exitCodeForEnvelope, isErrorEnvelope }
