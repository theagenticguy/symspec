/**
 * Load-time validation for the on-disk requirements document (AC-1-4, AC-1-9).
 *
 * The v2 document is a hand-editable, pretty-printed JSON file (`storage.ts`,
 * AC-1-1), so it MUST be checked on every read: a stray hand-edit, an
 * accidental truncation, or any other malformed input must never reach the
 * rest of the pipeline unvalidated. `loadRequirementsDoc` is the single funnel
 * every command runs a document through before touching it.
 *
 * Two error paths, kept deliberately disjoint (AC-1-9's "buildability" note):
 *
 *   1. `ERR_DOC_PARSE` — the bytes are not valid JSON at all, OR they parse
 *      as JSON but fail {@link RequirementsDocSchema}. The suggestion set is
 *      generic: check the path, or `symspec init` a fresh document.
 *
 *   2. `ERR_SCHEMA_VERSION` — the bytes ARE valid JSON and DO satisfy
 *      `RequirementsDocSchema` (so this is a well-formed, v2-shaped
 *      document), but `schemaVersion` does not equal the current
 *      `SCHEMA_VERSION`. This can only be reached once ERR_DOC_PARSE's gate
 *      has already passed, so the two codes never compete for the same
 *      input. Forward-looking only — it fires for a v2-shaped doc carrying a
 *      version symspec does not recognize.
 *
 * Both are typed `DocLoadError` instances so callers (the CLI envelope
 * layer, later waves) can pattern-match on `.code` without re-deriving the
 * trigger logic here.
 */

import { readFile } from 'node:fs/promises'
import { RequirementsDocSchema, SCHEMA_VERSION } from './schema.js'
import { deserializeDoc } from './storage.js'

export const DOC_LOAD_ERROR_CODES = ['ERR_DOC_PARSE', 'ERR_SCHEMA_VERSION'] as const
export type DocLoadErrorCode = (typeof DOC_LOAD_ERROR_CODES)[number]

/**
 * Thrown by {@link loadRequirementsDoc} / {@link parseRequirementsDoc} for
 * either of the two disjoint load-time failure modes. Carries the same
 * `{error, code, suggestions}` fields the CLI's error envelope (AC-6-2) will
 * read directly, so the envelope layer never needs to re-derive them.
 */
export class DocLoadError extends Error {
  readonly code: DocLoadErrorCode
  readonly suggestions: string[]

  constructor(code: DocLoadErrorCode, message: string, suggestions: string[]) {
    super(message)
    this.name = 'DocLoadError'
    this.code = code
    this.suggestions = suggestions
  }
}

/**
 * Validate already-decoded document text against the load-time contract
 * (AC-1-4, AC-1-9). Pure — no I/O.
 *
 * Throws {@link DocLoadError} on either failure mode; returns the validated,
 * schema-parsed document (with Zod defaults applied) otherwise.
 */
export function parseRequirementsDoc(text: string) {
  let raw: unknown
  try {
    raw = deserializeDoc(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new DocLoadError('ERR_DOC_PARSE', `Document is not valid JSON: ${reason}`, [
      'Check the path points at a symspec requirements document (JSON).',
      'If you need a new document, run `symspec init <file>`.',
    ])
  }

  const result = RequirementsDocSchema.safeParse(raw)
  if (!result.success) {
    throw new DocLoadError(
      'ERR_DOC_PARSE',
      `Document does not satisfy RequirementsDocSchema: ${result.error.message}`,
      [
        'Fix the reported field(s), or restore from a known-good backup.',
        'If you need a new document, run `symspec init <file>`.',
      ],
    )
  }

  const doc = result.data
  // Reachable only once the document is confirmed valid JSON that satisfies
  // RequirementsDocSchema, so the two error paths never compete for one input.
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new DocLoadError(
      'ERR_SCHEMA_VERSION',
      `Document schemaVersion is ${doc.schemaVersion}, but symspec expects ${SCHEMA_VERSION}.`,
      [
        `This document declares an unrecognized schemaVersion; symspec expects ${SCHEMA_VERSION}.`,
        'Re-create the document at the current schema: run `symspec init <file>`, then re-add each requirement (use `symspec parse` on each sentence to recover EARS slots for `symspec add`).',
      ],
    )
  }

  return doc
}

/**
 * Read + validate the requirements document at `path`. The single funnel
 * every command runs a document through before use.
 */
export async function loadRequirementsDoc(path: string) {
  const text = await readFile(path, 'utf8')
  return parseRequirementsDoc(text)
}
