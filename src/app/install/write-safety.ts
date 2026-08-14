/**
 * File-write safety for `install` — dropping skill files into a host's config dir without
 * ever clobbering a user's own content.
 *
 * `install` NEVER edits a host's root instruction file (`CLAUDE.md` / `AGENTS.md` /
 * `GEMINI.md`); it writes only into dedicated skill/rule subdirectories. But even there a
 * user may have hand-edited the file symspec previously wrote, so writes are idempotent
 * and content-aware:
 *
 * - {@link writeManagedFile} writes only when the on-disk content DIFFERS, reporting
 *   `created` / `updated` / `unchanged`, so a re-run is a quiet no-op when nothing changed.
 * - {@link removeManagedFile} deletes a file symspec owns, reporting `removed` /
 *   `unchanged`, and never errors on an already-absent file.
 *
 * A skill is ONE file symspec owns whole, so there is no marker-splicing here. Splicing
 * only matters when co-editing a shared file, which install deliberately does not do.
 *
 * ## Through the platform `FileSystem`, not `node:fs`
 *
 * Unlike v4's version (which called `node:fs` directly), every write here goes
 * through Effect's `FileSystem` service. That is not ceremony: it makes the whole install
 * surface testable against an in-memory filesystem, which is what lets
 * `install.test.ts` assert the host→path matrix for all five targets and both locations
 * without touching the developer's actual `~/.claude`. A test that had to write to a real
 * home directory would either be skipped or be dangerous.
 *
 * The atomic-write discipline is the store's: temp SIBLING file, then `rename`. Same
 * reasoning as `core/store.ts` — `rename` is atomic within one filesystem, so a crash
 * mid-write cannot leave a half-written skill file, and any failure leaves the original
 * completely intact.
 */

import { Effect, FileSystem, Path } from 'effect'
import { ErrIo } from '../../ports/errors.ts'

/** What a single file write/remove did — surfaced per file in the envelope. */
export type FileAction = 'created' | 'updated' | 'unchanged' | 'removed'

/** One file's outcome: its path and the action taken. */
export interface FileResult {
  readonly path: string
  readonly action: FileAction
}

/** A monotonic counter for temp names, so two writes in one millisecond cannot collide. */
let tempCounter = 0

/**
 * Write `contents` to `path` idempotently and atomically.
 *
 * `unchanged` when the file already holds byte-identical content (NO write at all, so a
 * re-run touches nothing), `updated` when it existed with different content, `created`
 * when it was absent. Parent directories are created as needed.
 *
 * Fails with `ERR_IO`, and the message says the original was not modified — which is true
 * by construction because the target is only touched by the final `rename`.
 */
export const writeManagedFile = (
  path: string,
  contents: string,
): Effect.Effect<FileResult, ErrIo, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (exists) {
      const current = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))
      // Byte equality is the idempotency check — the whole file is the managed unit.
      if (current === contents) return { path, action: 'unchanged' as const }
    }

    yield* Effect.mapError(
      fs.makeDirectory(pathService.dirname(path), { recursive: true }),
      (cause) =>
        new ErrIo({
          error: `Failed to create the directory for ${path}: ${describe(cause)}`,
          suggestions: ['Check filesystem permissions.', `Nothing at ${path} was modified.`],
        }),
    )

    tempCounter += 1
    const temp = pathService.join(
      pathService.dirname(path),
      `.${Date.now().toString(36)}${tempCounter.toString(36)}.symspec.tmp`,
    )
    const cleanup = fs.remove(temp).pipe(Effect.catchCause(() => Effect.void))

    yield* Effect.mapError(fs.writeFileString(temp, contents), (cause) => {
      return new ErrIo({
        error: `Failed to write ${temp}: ${describe(cause)}`,
        suggestions: [
          'Check filesystem permissions and available disk space.',
          `Any existing file at ${path} was NOT modified.`,
        ],
      })
    }).pipe(Effect.tapError(() => cleanup))

    yield* Effect.mapError(fs.rename(temp, path), (cause) => {
      return new ErrIo({
        error: `Failed to rename ${temp} to ${path}: ${describe(cause)}`,
        suggestions: [
          'Check filesystem permissions and that the target directory exists.',
          `Any existing file at ${path} was NOT modified.`,
        ],
      })
    }).pipe(Effect.tapError(() => cleanup))

    return { path, action: exists ? ('updated' as const) : ('created' as const) }
  })

/**
 * Remove a symspec-owned file.
 *
 * `removed` when a file was deleted, `unchanged` when it was already absent. Never fails
 * on a missing file, so `install --uninstall` is safe to run repeatedly — including
 * against a host that was never installed.
 */
export const removeManagedFile = (
  path: string,
): Effect.Effect<FileResult, ErrIo, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return { path, action: 'unchanged' as const }
    yield* Effect.mapError(
      fs.remove(path),
      (cause) =>
        new ErrIo({
          error: `Failed to remove ${path}: ${describe(cause)}`,
          suggestions: ['Check filesystem permissions.'],
        }),
    )
    return { path, action: 'removed' as const }
  })

/** One line describing a platform failure, for an `ERR_IO` message. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
