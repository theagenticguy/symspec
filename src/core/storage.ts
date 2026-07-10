/**
 * Plain-JSON persistence for the requirements document.
 *
 * Design (AC-1-1): the document is a single pretty-printed JSON file with
 * lexicographically sorted object keys, so:
 *   - git diffs are line-level, never binary-blob diffs.
 *   - the file is `cat`/`grep`/hand-editable.
 *   - the file is byte-stable: the same document always serializes to the
 *     exact same bytes, regardless of the order its keys were built in.
 *
 * Writes are atomic: `writeDocFile`/`atomicWriteFile` write to a sibling
 * temp file and `rename()` over the target, so a crash or failed write
 * never leaves a partially-written document on disk. Per AC-1-11, a failed
 * write (permissions, disk full) throws {@link IoError} (`ERR_IO`) rather
 * than a raw `fs` error, and by construction the original file at the
 * target path is never touched until the final `rename()` succeeds.
 *
 * Deliberately doc-shape-agnostic: no import of `RequirementsDoc` here.
 * Callers (e.g. `src/core/doc.ts`) supply whatever JSON-serializable value
 * they want persisted; schema validation on read is layered on separately
 * (AC-1-4).
 */

import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const IO_ERROR_CODES = ['ERR_IO'] as const
export type IoErrorCode = (typeof IO_ERROR_CODES)[number]

/**
 * Thrown by {@link atomicWriteFile} / {@link writeDocFile} when the atomic
 * write fails (permissions, disk full, etc. — AC-1-11). Carries the same
 * `{error, code, suggestions}` shape as `DocLoadError`/`LeanDiscoveryError`
 * so the CLI envelope layer (Wave 6) can handle it uniformly.
 *
 * By construction the failure can only ever leave the ORIGINAL `path`
 * untouched: the write lands on a sibling temp file first, and only a
 * successful `rename()` ever touches `path` itself (see {@link
 * atomicWriteFile}).
 */
export class IoError extends Error {
  readonly code: IoErrorCode
  readonly suggestions: string[]

  constructor(
    message: string,
    suggestions: string[] = ['Check file permissions and available disk space.'],
  ) {
    super(message)
    this.name = 'IoError'
    this.code = 'ERR_IO'
    this.suggestions = suggestions
  }
}

/**
 * Recursively sort object keys (lexicographic, default JS string compare)
 * so `JSON.stringify` emits a canonical, byte-stable ordering regardless of
 * insertion order. Arrays keep their element order — only plain-object keys
 * are sorted. Non-plain-object values (Date, etc.) pass through unchanged
 * since `JSON.stringify` already has stable handling for them.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const input = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortKeysDeep(input[key])
    }
    return sorted
  }
  return value
}

/**
 * Serialize any JSON-compatible value to pretty-printed, sorted-key JSON
 * text, terminated with a trailing newline so the file is well-formed text
 * under `cat`/POSIX tooling.
 */
export function serializeDoc<T>(doc: T): string {
  return `${JSON.stringify(sortKeysDeep(doc), null, 2)}\n`
}

/**
 * Parse a document back from JSON text. Deliberately dumb — no schema
 * validation here; that is layered on separately (AC-1-4) so this module
 * stays a pure storage primitive.
 */
export function deserializeDoc<T = unknown>(text: string): T {
  return JSON.parse(text) as T
}

/**
 * Write `contents` atomically: write to a sibling temp file in the same
 * directory as `path`, then `rename()` over the target. `rename()` within
 * the same filesystem is atomic, so a process that crashes mid-write (or a
 * write that fails outright) never leaves a half-written target file.
 *
 * AC-1-11: if either the temp-file write or the rename fails (permissions,
 * disk full), this throws {@link IoError} with `ERR_IO` instead of letting
 * the raw `fs` error escape. Because `path` is never touched until the
 * final `rename()` succeeds, ANY failure here — write or rename — leaves
 * the original file at `path` (if one exists) completely intact. On a
 * failed write, the orphaned temp file is best-effort cleaned up so it does
 * not linger next to the target.
 */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path)
  const tmpPath = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)

  try {
    await writeFile(tmpPath, contents, 'utf8')
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw toIoError(err, `write to temp file ${tmpPath}`)
  }

  try {
    await rename(tmpPath, path)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw toIoError(err, `rename ${tmpPath} to ${path}`)
  }
}

/** Wrap a raw `fs` error as an {@link IoError} with `ERR_IO`, describing `action`. */
function toIoError(err: unknown, action: string): IoError {
  const reason = err instanceof Error ? err.message : String(err)
  return new IoError(`Failed to ${action}: ${reason}`)
}

/** Serialize + atomically write a document to `path`. */
export async function writeDocFile<T>(path: string, doc: T): Promise<void> {
  await atomicWriteFile(path, serializeDoc(doc))
}

/**
 * Read + parse a document from `path`. Returns the raw parsed value;
 * schema validation happens elsewhere (AC-1-4).
 */
export async function readDocFile<T = unknown>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8')
  return deserializeDoc<T>(text)
}
