/**
 * File-write safety primitives for `symspec install` — the discipline that lets
 * it drop skill/rule files into a host's config dir without ever clobbering a
 * user's own content.
 *
 * `symspec install` NEVER edits a host's root instruction file (CLAUDE.md /
 * AGENTS.md / GEMINI.md); it only writes into dedicated skill/rule
 * subdirectories. But even there a user may have hand-edited the file symspec
 * previously wrote, so writes are idempotent and content-aware:
 *
 *   - {@link writeManagedFile} writes only when the on-disk content differs,
 *     reporting `created` / `updated` / `unchanged` so a re-run is a quiet no-op
 *     when nothing changed. The write itself is atomic (temp + rename, reused
 *     from `core/storage.ts`), so a crash mid-write cannot corrupt the target.
 *   - {@link removeManagedFile} deletes a file symspec owns, reporting `removed`
 *     / `unchanged`, and never errors on an already-absent file.
 *
 * These files are symspec-owned in their entirety (one skill = one file in a
 * dedicated dir), so there is no marker-splicing here — the whole file is the
 * managed unit. Marker splicing only matters when co-editing a shared file,
 * which install deliberately does not do.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../../core/storage.js'

/** What a single file write/remove did — surfaced per-file in the envelope. */
export type FileAction = 'created' | 'updated' | 'unchanged' | 'removed'

/** One file's outcome: its absolute path and the action taken. */
export interface FileResult {
  readonly path: string
  readonly action: FileAction
}

/**
 * Write `contents` to `path` idempotently. Returns `unchanged` when the file
 * already holds byte-identical content (no write, so a re-run is quiet),
 * `updated` when it existed with different content, `created` when it was
 * absent. Creates parent directories as needed; the write is atomic.
 */
export async function writeManagedFile(path: string, contents: string): Promise<FileResult> {
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    if (current === contents) return { path, action: 'unchanged' }
    await atomicWriteFile(path, contents)
    return { path, action: 'updated' }
  }
  mkdirSync(dirname(path), { recursive: true })
  await atomicWriteFile(path, contents)
  return { path, action: 'created' }
}

/**
 * Remove a symspec-owned file. Returns `removed` when a file was deleted,
 * `unchanged` when it was already absent. Never throws on a missing file, so
 * `install --uninstall` is safe to run repeatedly.
 */
export function removeManagedFile(path: string): FileResult {
  if (!existsSync(path)) return { path, action: 'unchanged' }
  rmSync(path)
  return { path, action: 'removed' }
}
