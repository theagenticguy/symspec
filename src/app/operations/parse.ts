/**
 * `parse` — turn prose into structured EARS requirements, or punt with a plan.
 *
 * ## Three input shapes, one code path
 *
 * A single line (positional), a whole file (`--file`), or stdin. All three converge
 * on {@link parseBatch}: a single line is the one-element case of a batch, so there
 * is no "single" implementation that could behave differently from the batch one.
 * That matters because v4's own agent-UX finding was that agents feed bullet
 * lists far more often than single sentences — the batch path is the MAIN path, and
 * making the single case a special path would have optimized the rare one.
 *
 * ## `parse` NEVER writes
 *
 * It reads no document and saves nothing: it is a pure transformation from text to
 * ops. That is what makes it safe to call speculatively on anything, and it is why
 * the operation has no `--file <doc>` (its `--file` is the INPUT text, matching
 * v4). Committing the result is `apply`'s job, which keeps "what would this
 * become" and "make it so" as two separate decisions an agent takes deliberately.
 *
 * ## The payload is an APPLY-READY PLAN (spec AC-A-4)
 *
 * Every `ok` result carries its `proposedOp`, every `ERR_PARSE_COMPOUND` carries its
 * `proposedOps`, and the payload rolls all of them up into one `ops[]` array plus
 * the JSONL text that array serializes to. So the whole loop is:
 *
 *   symspec parse --file spec.md --field data.opsJsonl > ops.jsonl
 *   symspec apply --file ops.jsonl
 *
 * v4 could not close that loop: its ops existed only on the COMPOUND error
 * path, under a name the result object did not carry, and its success path emitted
 * slots an agent had to transcribe field by field (threading the top-level `negated`
 * flag by hand — a step only `cli/add.ts` knew to take).
 *
 * ## Exit code: parse failures are DATA, not operational errors
 *
 * A line that will not parse produces an `error`-outcome RESULT inside a SUCCESS
 * envelope, not an `ERR_PARSE_*` error envelope. The run did what it was asked: it
 * read twelve lines and reports what happened to each. Failing the whole invocation
 * because line 7 is a heading would make batch parsing useless.
 *
 * The exit code still reflects it, through the kernel's existing structural rule
 * rather than a special case: the payload publishes `findings[]` carrying one
 * `error`-severity entry per unparseable line, so `exitCodeForEnvelope` maps a batch
 * with any parse failure to exit 1 with no new mapping logic. An agent gets both —
 * a parseable report AND a non-zero status it can gate on.
 */

import { Effect, Schema } from 'effect'
import { type BatchParseResult, parseBatch } from '../../domain/engine/parse/batch.ts'
import type { ParseResult } from '../../domain/engine/parse/result.ts'
import { type AddOp, opLine } from '../../domain/requirements/ops.ts'
import { ErrIo, ErrUsage } from '../../ports/errors.ts'
import { StreamSource } from '../../ports/stream.ts'
import { ok, type Repair } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

const lines = (...xs: readonly string[]): string => xs.join('\n')

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * One finding per unparseable line, in the SAME shape `check` emits.
 *
 * Deliberately the check shape rather than a parse-specific one, and it buys two
 * things. The exit contract already reads `findings[].severity` structurally, so
 * `parse` gets its exit code with no new mapping. And an agent that already knows
 * how to read a `check` finding — code, severity, message, repair — reads a parse
 * finding with no new vocabulary.
 */
export interface ParseFinding {
  /** The stable `ERR_PARSE_*` code for the failure class. */
  readonly code: string
  /** Always `'error'`: a line that will not parse is a hard failure FOR THAT LINE. */
  readonly severity: 'error'
  /** Always `'parse'` — the tier, matching `check`'s tier vocabulary. */
  readonly tier: 'parse'
  /** The 0-based index of the result this finding came from, so an agent can map it
   * back to the line without re-deriving the line policy. */
  readonly index: number
  readonly message: string
  /** The mechanical rewrite suggestions the ladder produced. */
  readonly suggestions: readonly string[]
  /** Present when a mechanical fix exists — i.e. a confident compound split. Absent
   * when the only remedy is a human rewrite, which is the honest signal. */
  readonly repair?: Repair
}

/** The `parse` payload. */
export interface ParsePayload extends BatchParseResult {
  /** Where the text came from: a path, `'stdin'`, or `'argument'`. */
  readonly source: string
  /**
   * EVERY proposed op, in result order — the apply-ready plan.
   *
   * Flattened across both producers: one op per `ok` result, and N ops per
   * confidently-split `ERR_PARSE_COMPOUND`. A `skipped` line and an unsplittable
   * error contribute nothing, so `ops.length` is genuinely "how many requirements
   * this text would create" rather than a count of lines.
   */
  readonly ops: readonly AddOp[]
  /** {@link ops} as JSONL — the exact bytes `apply` reads. Published as a STRING so
   * an agent can `--field data.opsJsonl` it straight into a file without a JSON
   * tool and without re-serializing (and therefore without any chance of
   * re-serializing differently). */
  readonly opsJsonl: string
  /** One finding per unparseable line. Drives the exit code structurally. */
  readonly findings: readonly ParseFinding[]
}

/** Collect every proposed op out of a batch, in result order. */
const opsOf = (results: readonly ParseResult[]): readonly AddOp[] => {
  const ops: AddOp[] = []
  for (const result of results) {
    if (result.outcome === 'ok') ops.push(result.proposedOp)
    else if (result.outcome === 'error' && result.proposedOps !== undefined) {
      ops.push(...result.proposedOps)
    }
  }
  return ops
}

/**
 * Project the `error` results onto findings.
 *
 * The `repair` is the split ops when there are any — which is the one case where a
 * parse failure has a MECHANICAL fix (apply the two halves instead of the compound).
 * Otherwise the repair is OMITTED rather than emitted with empty arrays: the remedy
 * is a rewrite, no command performs one, and "there is a repair, it is nothing" is a
 * worse signal than absence.
 */
const findingsOf = (results: readonly ParseResult[]): readonly ParseFinding[] => {
  const findings: ParseFinding[] = []
  results.forEach((result, index) => {
    if (result.outcome !== 'error') return
    const ops = result.proposedOps
    const finding: ParseFinding = {
      code: result.code,
      severity: 'error',
      tier: 'parse',
      index,
      message: result.error,
      suggestions: result.suggestions,
      ...(ops !== undefined && ops.length > 0
        ? {
            repair: {
              ops,
              // The command that CONSUMES those ops. Named as a pipe from `parse`
              // rather than as a bare `apply`, because the ops are in this envelope
              // and an agent needs to know how they get to a file.
              commands: ['symspec apply --file <ops.jsonl>'],
            } satisfies Repair,
          }
        : {}),
    }
    findings.push(finding)
  })
  return findings
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * An optional string flag whose ABSENCE is `null`.
 *
 * NOT wrapped in `Schema.optionalKey`, and that omission is the whole point.
 * `withDecodingDefaultKey` ALREADY makes the key optional on the ENCODED side (its
 * declared result is `decodeTo<S, optionalKey<toEncoded<S>>>`); adding an explicit
 * `optionalKey` makes it optional on the TYPE side too, so the decoded value types
 * `text?: string | null | undefined` even though decoding always materializes it.
 *
 * That was not theoretical here — it produced two TS18048/TS2345 errors on the first
 * compile of this file, because the handler branches on `!== null` and the leaked
 * `undefined` made the narrowing incomplete. The tell named in the earlier lesson is
 * exactly what showed up: a `!= null` (nullish) comparison being demanded where
 * `!== null` should suffice. Optional in `Encoded` (the flag may be absent), required
 * in `Type` (the decoded value always has it) is what a default MEANS.
 */
const nullableStringFlag = (description: string) =>
  Schema.withDecodingDefaultKey<Schema.NullOr<Schema.String>>(Effect.succeed(null))(
    Schema.NullOr(Schema.String).annotate({ default: null, description }),
  )

const ParseInput = Schema.Struct({
  text: nullableStringFlag(
    lines(
      'A single requirement sentence to parse — the one-element case of a batch.',
      'Mutually exclusive with --file. Omit both to read lines from STDIN.',
      'Example: "When the user signs in, the auth service shall issue a session token."',
    ),
  ),
  file: nullableStringFlag(
    lines(
      'Path to a file of requirement lines, ONE PER LINE. This is the INPUT TEXT, not a',
      'requirements document — `parse` never reads or writes a document.',
      'Blank lines and `#` comment lines are dropped; a leading list marker (-, *, +, 1., 1)) is',
      'stripped, so a Markdown bullet list feeds in as-is. A bullet carrying prose with no modal',
      'is reported as `skipped` rather than dropped, so nothing you wrote goes missing silently.',
      'Mutually exclusive with the positional text. Omit both to read STDIN.',
      'Example: --file ./requirements.md',
    ),
  ),
})

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

export const parseOp = defineOperation({
  name: 'parse',
  summary: 'Parse prose into structured EARS requirements and emit the ready-to-apply add ops',
  type: 'parse',
  input: ParseInput,
  handler: (input) =>
    Effect.gen(function* () {
      if (input.text !== null && input.file !== null) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              'The positional text and --file are mutually exclusive: parse one sentence OR one file, not both.',
            suggestions: [
              'Drop --file to parse the positional sentence.',
              'Drop the positional sentence to parse the file.',
            ],
            repair: { ops: [], commands: ['symspec parse --file ./requirements.md'] },
          }),
        )
      }

      // The positional short-circuits the reader entirely — no stdin drain, no file
      // read, so `symspec parse "<sentence>"` needs no stdin at all (piping nothing
      // into it must not hang).
      const { text, source } =
        input.text !== null
          ? { text: input.text, source: 'argument' }
          : {
              text: yield* (yield* StreamSource).read(input.file),
              source: input.file ?? 'stdin',
            }

      if (text.trim().length === 0) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              source === 'stdin'
                ? 'No text on stdin. Pipe requirement lines in, pass --file <path>, or supply one sentence as an argument.'
                : `The input at ${source} is empty.`,
            suggestions: [
              'Parse one sentence: `symspec parse "the auth service shall issue a token"`.',
              'Parse a file: `symspec parse --file ./requirements.md`.',
              'Or pipe lines: `cat requirements.md | symspec parse`.',
            ],
          }),
        )
      }

      const batch = yield* Effect.promise(() => parseBatch(text))
      const ops = opsOf(batch.results)

      const payload: ParsePayload = {
        ...batch,
        source,
        ops,
        // One line per op, newline-TERMINATED when non-empty so the text is
        // well-formed POSIX and `>> ops.jsonl` appends cleanly.
        opsJsonl: ops.length > 0 ? `${ops.map(opLine).join('\n')}\n` : '',
        findings: findingsOf(batch.results),
      }
      return ok('parse', payload)
    }),
})

/** Re-exported so the composition root has one import path for the stream source. */
export { ErrIo }
