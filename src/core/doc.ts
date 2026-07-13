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
    waivers: [],
    antonyms: [],
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
 * True when `ref` is shaped like a UUID (the canonical id form). Used to decide
 * whether a raw reference should be looked up directly in the UUID-keyed map or
 * treated as a human key that needs a scan. Deliberately loose (8-4-4-4-12 hex);
 * anything that is not UUID-shaped is a key candidate.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a raw reference — either a UUID or a stable human key — to the
 * requirement it names, or `undefined` if nothing matches. A UUID-shaped `ref`
 * is looked up directly in the O(1) map; anything else is matched against the
 * requirements' `key` field. This is the single place the key⇄UUID duality is
 * decided, so every id-taking command resolves keys by delegating here.
 */
export function resolveRequirement(doc: Doc, ref: string): Requirement | undefined {
  if (UUID_LIKE.test(ref)) {
    const byId = doc.requirements[ref]
    if (byId !== undefined) return byId
  }
  return Object.values(doc.requirements).find((r) => r.key === ref)
}

/**
 * Resolve a raw reference to the requirement's stable UUID, or `undefined`. The
 * id-taking commands work in UUID terms internally (edges, Change records), so
 * this returns the canonical id even when the caller passed a human key.
 */
export function resolveId(doc: Doc, ref: string): string | undefined {
  return resolveRequirement(doc, ref)?.id
}

/**
 * Plain-object snapshot for export / display — a defensive deep copy so callers
 * cannot mutate stored state through the returned object.
 */
export function snapshot(doc: Doc): RequirementsDoc {
  return structuredClone(doc)
}
