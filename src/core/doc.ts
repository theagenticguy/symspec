/**
 * Plain-object document facade (AC-8-4).
 *
 * v2 stores the requirements document as plain JSON (AC-1-1), so this module
 * is a thin facade over the storage primitives in `./storage.ts` plus the
 * Change-record mutation path in `./changes.ts`.
 *
 * The `Doc` type is just `RequirementsDoc` (a plain object). `applyChange` /
 * `applyChanges` are re-exported from `./changes.ts` so consumers use the
 * `const next = applyChange(doc, change)` convention. `merge()` does not
 * exist: concurrent-replica merge has no meaning for a single-agent JSON file.
 */

import { randomUUID } from 'node:crypto'
import type { Requirement, RequirementsDoc } from './schema.js'
import { SCHEMA_VERSION } from './schema.js'
import { readDocFile, writeDocFile } from './storage.js'

export { applyChange, applyChanges } from './changes.js'

/**
 * A requirements document — a plain object. Kept as a named alias so consumers
 * that pass `Doc` around have a stable type name.
 */
export type Doc = RequirementsDoc

/** Construct a fresh, empty document at the current schema version. */
export function emptyDoc(): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    requirements: {},
    glossary: [],
  }
}

/**
 * Load a document from `path`. Reads the pretty-printed JSON written by
 * `saveDoc`. Schema validation on read is layered on separately (AC-1-4,
 * `./load.ts`); this facade returns the parsed plain object as-is.
 */
export async function loadDoc(path: string): Promise<Doc> {
  return readDocFile<Doc>(path)
}

/**
 * Persist a document to `path` as pretty-printed, sorted-key JSON, written
 * atomically (temp file + rename) by the storage layer.
 */
export async function saveDoc(doc: Doc, path: string): Promise<void> {
  await writeDocFile(path, doc)
}

/** Mint a fresh requirement UUID. */
export function newId(): string {
  return randomUUID()
}

export function listRequirements(doc: Doc): Requirement[] {
  return Object.values(doc.requirements)
}

export function getRequirement(doc: Doc, id: string): Requirement | undefined {
  return doc.requirements[id]
}

/**
 * Plain-object snapshot for export / display — a defensive deep copy so callers
 * cannot mutate stored state through the returned object.
 */
export function snapshot(doc: Doc): RequirementsDoc {
  return structuredClone(doc)
}
