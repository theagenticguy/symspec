/**
 * Automerge wrapper. The CRDT is the storage substrate; this module exposes
 * a Change-record-shaped API on top so callers (CLI, MCP server, tests) never
 * have to touch Automerge internals.
 *
 * Why this separation: Automerge mutations have to happen inside a
 * `change(...)` callback that mutates the proxy object directly. We translate
 * each Change record into the appropriate proxy mutation here so the rest of
 * the codebase can stay in plain TypeScript.
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import * as Automerge from '@automerge/automerge'
import {
  ChangeSchema,
  NULLABLE_ATTRS,
  type Requirement,
  type RequirementsDoc,
  renderSentence,
  SCHEMA_VERSION,
} from './schema.js'

export type Doc = Automerge.Doc<RequirementsDoc>

export function emptyDoc(): Doc {
  return Automerge.from<RequirementsDoc>({
    schemaVersion: SCHEMA_VERSION,
    requirements: {},
  })
}

export async function loadDoc(path: string): Promise<Doc> {
  const bytes = await readFile(path)
  return Automerge.load<RequirementsDoc>(bytes)
}

export async function saveDoc(doc: Doc, path: string): Promise<void> {
  const bytes = Automerge.save(doc)
  await writeFile(path, bytes)
}

export function newId(): string {
  return randomUUID()
}

/**
 * Apply a single Change record to the doc. Returns the new doc.
 *
 * Idempotency notes:
 * - AddRelationship is a no-op if the edge already exists.
 * - RemoveRelationship is a no-op if the edge isn't present.
 * - DeleteRequirement on a missing id is a no-op (tombstone semantics; we
 *   don't try to recover deleted state).
 * - CreateRequirement on an existing id throws — collisions should be
 *   surfaced, not silently merged.
 */
export function applyChange(doc: Doc, raw: unknown): Doc {
  const change = ChangeSchema.parse(raw)
  const now = new Date().toISOString()

  return Automerge.change(doc, (d) => {
    switch (change.kind) {
      case 'CreateRequirement': {
        if (d.requirements[change.id]) {
          throw new Error(`Requirement ${change.id} already exists`)
        }
        const attrs = change.attrs
        // Automerge rejects `undefined` — only include optional slots if set.
        // Edges are intentionally not part of CreateRequirement; they are
        // added via separate AddRelationship Changes so the operation set
        // stays orthogonal and idempotent.
        const partial: Requirement = {
          id: change.id,
          patternType: attrs.patternType,
          systemName: attrs.systemName,
          systemResponse: attrs.systemResponse,
          sentence: renderSentence({
            patternType: attrs.patternType,
            preCondition: attrs.preCondition,
            trigger: attrs.trigger,
            systemName: attrs.systemName,
            systemResponse: attrs.systemResponse,
          }),
          priority: attrs.priority ?? 'medium',
          status: attrs.status ?? 'draft',
          derives: [],
          satisfies: [],
          verifies: [],
          refines: [],
          createdAt: now,
          updatedAt: now,
        }
        if (attrs.preCondition !== undefined) partial.preCondition = attrs.preCondition
        if (attrs.trigger !== undefined) partial.trigger = attrs.trigger
        if (attrs.verificationMethod !== undefined)
          partial.verificationMethod = attrs.verificationMethod
        d.requirements[change.id] = partial
        break
      }

      case 'UpdateAttribute': {
        const r = d.requirements[change.id]
        if (!r) throw new Error(`Requirement ${change.id} not found`)
        // Automerge rejects `undefined`. We treat `null` from the Change
        // record as "delete this optional field" via the delete operator,
        // but only for attrs that are actually optional (NULLABLE_ATTRS).
        // Nulling a required attr is a programming error and is rejected.
        const target = r as Record<string, unknown>
        if (change.value === null) {
          if (!NULLABLE_ATTRS.has(change.attr)) {
            throw new Error(`Cannot null required attribute "${change.attr}" on ${change.id}`)
          }
          delete target[change.attr]
        } else {
          target[change.attr] = change.value
        }
        // Re-render sentence if any EARS slot changed.
        if (
          change.attr === 'patternType' ||
          change.attr === 'preCondition' ||
          change.attr === 'trigger' ||
          change.attr === 'systemName' ||
          change.attr === 'systemResponse'
        ) {
          r.sentence = renderSentence(r)
        }
        r.updatedAt = now
        break
      }

      case 'AddRelationship': {
        const r = d.requirements[change.from]
        if (!r) throw new Error(`Requirement ${change.from} not found`)
        const arr = r[change.relation]
        if (!arr.includes(change.to)) arr.push(change.to)
        r.updatedAt = now
        break
      }

      case 'RemoveRelationship': {
        const r = d.requirements[change.from]
        if (!r) return // nothing to remove
        const arr = r[change.relation]
        const idx = arr.indexOf(change.to)
        if (idx >= 0) arr.splice(idx, 1)
        r.updatedAt = now
        break
      }

      case 'DeleteRequirement': {
        // Tombstone semantics: just remove the entry. Inbound edges from
        // other requirements become dangling references, which the analysis
        // pass surfaces — they do not error here.
        delete d.requirements[change.id]
        break
      }
    }
  })
}

export function applyChanges(doc: Doc, changes: unknown[]): Doc {
  let current = doc
  for (const c of changes) current = applyChange(current, c)
  return current
}

/**
 * Merge two replicas. Automerge handles concurrent edits automatically;
 * we expose this so the CLI can demonstrate the property explicitly.
 */
export function merge(a: Doc, b: Doc): Doc {
  return Automerge.merge(a, b)
}

export function listRequirements(doc: Doc): Requirement[] {
  return Object.values(doc.requirements)
}

export function getRequirement(doc: Doc, id: string): Requirement | undefined {
  return doc.requirements[id]
}

/**
 * Plain-object snapshot for export / display.
 */
export function snapshot(doc: Doc): RequirementsDoc {
  return JSON.parse(JSON.stringify(doc))
}
