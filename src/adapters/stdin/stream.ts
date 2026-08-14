/**
 * The production {@link StreamSource}: a file read, or stdin.
 */

import { Effect, FileSystem, Layer, Stdio, Stream } from 'effect'
import { ErrIo } from '../../ports/errors.ts'
import { StreamSource } from '../../ports/stream.ts'

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
