/**
 * `StreamSource` — where an operation reads TEXT from, as a service.
 *
 * ## Why this is a service and not two lines of I/O
 *
 * Three operations now read a text stream that is not a requirements document:
 * `import` (an op stream), `parse` (requirement prose), and `apply` (an op stream).
 * All three want the same "a path, or stdin" behavior, and stdin is exactly the
 * dependency that would otherwise force every one of their tests to spawn a
 * process.
 *
 * Behind a service, the operations are unit-testable against an in-memory reader
 * while `cli.test.ts` still exercises the real stdin path end to end against the
 * shipped bundle. That split is the whole point: the in-process tests cover the
 * BEHAVIOR, and one spawned test covers the fact that the bytes actually arrive —
 * which, per the G2a exit-code lesson, is the only kind of test that can see a
 * process-boundary contract at all.
 *
 * ## Extracted from `import.ts` (G2b)
 *
 * G1b defined this inside `import.ts` because `import` was its only consumer.
 * Leaving it there and importing it from `parse` would have made `parse` depend on
 * `import` for no reason a reader could infer. Moving it costs one re-export.
 */

import { Context, Effect, FileSystem, Layer, Stdio, Stream } from 'effect'
import { ErrIo } from '../kernel/errors.ts'

export class StreamSource extends Context.Service<
  StreamSource,
  {
    /** Read the stream from `path`, or from stdin when `path` is null/undefined/empty. */
    readonly read: (path: string | null | undefined) => Effect.Effect<string, ErrIo>
  }
>()('symspec/StreamSource') {}

/**
 * The production stream source: a file read, or stdin.
 *
 * `stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)` reads stdin whole. Noted
 * because the obvious-looking alternative does NOT work on beta.102: `Stream.runFold`
 * with an array accumulator fails at runtime with `TypeError: initial is not a
 * function` (probed).
 */
export const streamSourceLayer = Layer.effect(StreamSource)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const stdio = yield* Stdio.Stdio
    return StreamSource.of({
      read: (path) => {
        if (path === null || path === undefined || path.length === 0) {
          return stdio.stdin.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.mapError(
              (cause) =>
                new ErrIo({
                  error: `Failed to read from stdin: ${cause instanceof Error ? cause.message : String(cause)}`,
                  suggestions: ['Pass --file <path> to read from a file instead.'],
                }),
            ),
          )
        }
        return Effect.mapError(
          fs.readFileString(path),
          (cause) =>
            new ErrIo({
              error: `Failed to read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
              suggestions: [
                'Check the path exists and is readable.',
                'Omit --file to read from stdin instead.',
              ],
            }),
        )
      },
    })
  }),
)
