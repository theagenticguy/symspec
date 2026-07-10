/**
 * The Change-record mutation path (AC-1-5).
 *
 * `applyChange` is the ONLY sanctioned way to mutate a requirements document.
 * It takes the current plain-object `RequirementsDoc`, validates a raw Change
 * against `ChangeSchema`, and returns a NEW plain-object document with the
 * change applied — the input is never mutated (structuredClone up front),
 * following the `const next = applyChange(doc, change)` calling convention.
 *
 * The mutation semantics:
 *   - CreateRequirement on an existing id throws a typed {@link ChangeError}
 *     with code `ERR_DUPLICATE_ID` (AC-1-8) — the same `{code, suggestions}`
 *     shape as `DocLoadError`/`IoError`, so the eventual CLI envelope layer
 *     (AC-6-2) can wrap it without re-deriving the trigger logic.
 *   - UpdateAttribute: null clears an optional (NULLABLE_ATTRS) attr; null on a
 *     required attr throws a typed `ChangeError` with code `ERR_NULL_REQUIRED`;
 *     any EARS-slot edit (the five slots: patternType, preCondition, trigger,
 *     systemName, systemResponse) re-renders `sentence`, a pure metadata edit
 *     (priority/status/verificationMethod) does not (AC-1-6).
 *   - AddRelationship is idempotent; RemoveRelationship / DeleteRequirement are
 *     no-ops on a missing edge / requirement (AC-1-7).
 *
 * `exactOptionalPropertyTypes` is on, so optional slots are set with the
 * conditional-assign idiom (assign only when defined) rather than ever writing
 * `undefined` into a field.
 *
 * NOTE on `ChangeError`'s code namespace: `src/core/codes.ts` (the shared
 * ERR_* Zod enum, AC-6-3) had not landed yet when this file was authored —
 * per the Wave-3 plan note it is created by whichever of T-AC-2-7 lands
 * first. `ChangeError` is scoped locally here, matching the same
 * `{code, suggestions}` shape `load.ts`'s `DocLoadError` and `storage.ts`'s
 * `IoError` already use, so a later consolidation into `codes.ts` is a
 * mechanical move, not a shape change.
 */

import {
  type Change,
  ChangeSchema,
  NULLABLE_ATTRS,
  type Requirement,
  type RequirementsDoc,
  renderSentence,
} from './schema.js'

export type { Change } from './schema.js'
export { ChangeSchema } from './schema.js'

/** Stable ERR_* codes `applyChange` itself is responsible for raising. */
export const CHANGE_ERROR_CODES = ['ERR_DUPLICATE_ID', 'ERR_NULL_REQUIRED'] as const
export type ChangeErrorCode = (typeof CHANGE_ERROR_CODES)[number]

/**
 * Thrown by {@link applyChange} for the two ERR_* conditions it alone can
 * detect (AC-1-6, AC-1-8). Carries the same `{code, suggestions}` shape as
 * `DocLoadError` (`load.ts`) / `IoError` (`storage.ts`) so callers can
 * pattern-match on `.code` uniformly across the core layer.
 */
export class ChangeError extends Error {
  readonly code: ChangeErrorCode
  readonly suggestions: string[]

  constructor(code: ChangeErrorCode, message: string, suggestions: string[]) {
    super(message)
    this.name = 'ChangeError'
    this.code = code
    this.suggestions = suggestions
  }
}

/**
 * Apply a single Change record to a plain-object document. Returns a new
 * document; the input `doc` is left untouched (deep-cloned before mutation).
 */
export function applyChange(doc: RequirementsDoc, raw: unknown): RequirementsDoc {
  const change: Change = ChangeSchema.parse(raw)
  const now = new Date().toISOString()
  const d: RequirementsDoc = structuredClone(doc)

  switch (change.kind) {
    case 'CreateRequirement': {
      if (d.requirements[change.id]) {
        throw new ChangeError('ERR_DUPLICATE_ID', `Requirement ${change.id} already exists`, [
          'Use `symspec update` to modify the existing requirement.',
        ])
      }
      const attrs = change.attrs
      // Edges are intentionally not part of CreateRequirement; they are added
      // via separate AddRelationship Changes so the operation set stays
      // orthogonal and idempotent. Optional EARS slots are assigned only when
      // present (exactOptionalPropertyTypes: never write `undefined`).
      // Response polarity (AC-2-4): the create attrs may carry `negated` (from
      // the parse tier's stripped-negator flag or an explicit `--negated`). It
      // is persisted on the node and threaded into the renderer so the stored
      // `sentence` reads "shall not <response>" — never the semantic inverse.
      const negated = attrs.negated ?? false
      const partial: Requirement = {
        id: change.id,
        patternType: attrs.patternType,
        systemName: attrs.systemName,
        systemResponse: attrs.systemResponse,
        negated,
        sentence: renderSentence({
          patternType: attrs.patternType,
          preCondition: attrs.preCondition,
          trigger: attrs.trigger,
          systemName: attrs.systemName,
          systemResponse: attrs.systemResponse,
          negated,
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
      // `null` from the Change record means "clear this optional field", but
      // only for attrs that are actually optional (NULLABLE_ATTRS). Nulling a
      // required attr is a programming error and is rejected.
      const target = r as Record<string, unknown>
      if (change.value === null) {
        if (!NULLABLE_ATTRS.has(change.attr)) {
          throw new ChangeError(
            'ERR_NULL_REQUIRED',
            `Cannot null required attribute "${change.attr}" on ${change.id}`,
            [
              'Provide a value instead of null.',
              'Only preCondition, trigger, and verificationMethod are clearable.',
            ],
          )
        }
        delete target[change.attr]
      } else {
        target[change.attr] = change.value
      }
      // Re-render the canonical sentence iff the updated attr is one of the
      // five EARS structural slots (AC-1-6's "five-way re-render gate"): the
      // pattern itself, plus the four clause slots. Pure metadata attrs
      // (priority, status, verificationMethod) never touch `sentence`.
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

    // --- Edge ops (AC-1-7: "safe to call defensively") -------------------
    // AddRelationship is idempotent: adding an edge that already exists is a
    // no-op rather than a duplicate push, so replaying the same Change (or a
    // caller retrying after an ambiguous network response) never produces a
    // second copy of the edge. `from` must still resolve to a real
    // requirement — that half of the contract is not "safe to call
    // defensively" in the spec (only Remove/Delete's *targets* are), so a
    // missing source still throws.
    case 'AddRelationship': {
      const r = d.requirements[change.from]
      if (!r) throw new Error(`Requirement ${change.from} not found`)
      const arr = r[change.relation]
      if (!arr.includes(change.to)) arr.push(change.to)
      r.updatedAt = now
      break
    }

    // RemoveRelationship no-ops (rather than throwing) when the source
    // requirement no longer exists, and no-ops when the edge itself is
    // already absent from that source — either way "remove an edge that
    // isn't there" leaves the document unchanged and never errors.
    case 'RemoveRelationship': {
      const r = d.requirements[change.from]
      if (!r) return d // nothing to remove: missing source is a no-op
      const arr = r[change.relation]
      const idx = arr.indexOf(change.to)
      if (idx >= 0) arr.splice(idx, 1) // no-op when the edge is already absent
      r.updatedAt = now
      break
    }

    // DeleteRequirement no-ops on an id that is already gone (deleting twice,
    // or deleting an id that never existed, must not throw — AC-1-7).
    // Tombstone semantics: remove the entry. Inbound edges from other
    // requirements become dangling references, which the analysis pass
    // surfaces — they do not error here.
    case 'DeleteRequirement': {
      delete d.requirements[change.id]
      break
    }
  }

  return d
}

/** Apply a sequence of Change records left-to-right, threading the result. */
export function applyChanges(doc: RequirementsDoc, changes: unknown[]): RequirementsDoc {
  let current = doc
  for (const c of changes) current = applyChange(current, c)
  return current
}
