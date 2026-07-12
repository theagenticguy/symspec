/**
 * The `update` command core (AC-6-11): setting a value and clearing an
 * attribute are two explicit surfaces, so the typed CLI has no stringly-typed
 * nulls and no clear-the-field side effect hidden inside a positional argument.
 *
 * ## The two surfaces
 *
 *   - `symspec update <id> <attr> <value>` — SET: the value is stored verbatim.
 *     The literal string `"null"` is just text and is stored as text.
 *   - `symspec update --clear <id> <attr>` — CLEAR: the optional attr is
 *     removed. Maps to the core `UpdateAttribute` Change with `value: null`,
 *     which `applyChange` restricts to `NULLABLE_ATTRS` (preCondition /
 *     trigger / verificationMethod), throwing `ERR_NULL_REQUIRED` otherwise
 *     (AC-1-6).
 *
 * Supplying BOTH `--clear` and a `<value>` (or NEITHER) is a usage error
 * (`ERR_USAGE`): the two intents are mutually exclusive by construction, so an
 * agent can never express "clear, but also here's a value" ambiguity.
 *
 * ## Shape
 *
 * {@link runUpdate} is the pure command core: it takes the loaded document and
 * the parsed arguments and returns `{next?, envelope}` — the updated document
 * (present only on success) plus the typed envelope to emit (AC-6-2). All
 * argument validation flows through `cli/errors.ts` (AC-6-10): unknown attr →
 * `ERR_INVALID_ATTR`, unknown id → `ERR_NOT_FOUND`, clear-on-required →
 * `ERR_NULL_REQUIRED` (lifted from the core `ChangeError`), and the
 * clear/value conflict → `ERR_USAGE`. It never throws and performs no I/O —
 * the command wiring (AC-6-8/6-9) loads, calls, saves on success, and emits.
 *
 * Cite: AC-6-11 (`--clear` replaces the `"null"` sentinel; literal "null"
 * stored as text); AC-6-10 (typed arg-error envelopes); AC-1-6
 * (`ERR_NULL_REQUIRED`, NULLABLE_ATTRS); explore-docs.md §1.3 tech-debt #2.
 */

import { applyChange, applyChanges } from '../core/changes.js'
import { listRequirements } from '../core/doc.js'
import type { EarsPattern, Requirement, RequirementsDoc, UpdatableAttr } from '../core/schema.js'
import type { Envelope, ErrorEnvelope } from './envelope.js'
import { failure, success } from './envelope.js'
import { parseAttr, requireRequirement, toErrorEnvelope, usageError } from './errors.js'

/** The usage line `ERR_USAGE` suggestions cite for this command. */
export const UPDATE_USAGE =
  'symspec update [--clear] <ref> <attr> [value] | update <ref> <attr>=<value>… | update --all --where <attr>=<value> <attr> <value>'

/**
 * MN6: whether clearing `attr` would strip a slot the requirement's `pattern`
 * structurally needs (mirrors `core/analyze.ts`'s MissingTrigger /
 * MissingPreCondition rules). Returns a short reason string when the clear
 * must be blocked, or `undefined` when the clear is safe. Only `trigger` and
 * `preCondition` are pattern-load-bearing; `verificationMethod` is always
 * clearable.
 */
function patternRequiresSlot(pattern: EarsPattern, attr: UpdatableAttr): string | undefined {
  if (attr === 'trigger' && (pattern === 'event-driven' || pattern === 'unwanted-behavior')) {
    return `an ${pattern} requirement's trigger`
  }
  if (attr === 'preCondition' && (pattern === 'state-driven' || pattern === 'optional-feature')) {
    return `a ${pattern} requirement's pre-condition`
  }
  return undefined
}

/**
 * Parsed `update` arguments. `value` is the raw positional (absent when not
 * supplied — never `undefined`-assigned, per `exactOptionalPropertyTypes`);
 * `clear` is the explicit flag. Exactly one of the two must be present.
 */
export interface UpdateArgs {
  readonly id: string
  readonly attr: string
  readonly value?: string
  readonly clear?: boolean
}

/** The `data` payload of a successful `update` envelope. */
export interface UpdateData {
  readonly id: string
  readonly attr: UpdatableAttr
  /** `'set'` when a value was stored, `'cleared'` when the attr was removed. */
  readonly action: 'set' | 'cleared'
}

/**
 * Result of {@link runUpdate}: the envelope to emit, plus the updated document
 * when (and only when) the update succeeded. `next` is OMITTED on failure —
 * the caller persists nothing.
 */
export type UpdateResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<UpdateData> }
  | { readonly envelope: Envelope<UpdateData> }

/**
 * Execute an `update` against a loaded document. Pure: returns a new document
 * (via `applyChange`'s structuredClone) and never mutates the input, never
 * throws, never touches the filesystem.
 *
 *   - SET path (`value` supplied, no `--clear`): stores the string verbatim —
 *     the literal `"null"` is text, not a clear (AC-6-11).
 *   - CLEAR path (`--clear`, no value): builds the core Change with
 *     `value: null`; `applyChange` clears a `NULLABLE_ATTRS` member and throws
 *     `ERR_NULL_REQUIRED` (lifted to an envelope here) for a required attr.
 *   - Both or neither → `ERR_USAGE`.
 */
export function runUpdate(doc: RequirementsDoc, args: UpdateArgs): UpdateResult {
  const clearing = args.clear === true
  const hasValue = args.value !== undefined

  if (clearing && hasValue) {
    return {
      envelope: usageError(
        '--clear and a <value> are mutually exclusive: clear removes the attribute, a value sets it',
        UPDATE_USAGE,
      ),
    }
  }
  if (!clearing && !hasValue) {
    return {
      envelope: usageError(
        'update requires a <value>, or --clear to remove the attribute',
        UPDATE_USAGE,
      ),
    }
  }

  const attr = parseAttr(args.attr)
  if (!attr.ok) return { envelope: attr.envelope }

  const target = requireRequirement(doc, args.id)
  if (!target.ok) return { envelope: target.envelope }

  // MN6: `trigger`/`preCondition` are structurally NULLABLE, but clearing the
  // slot a requirement's OWN pattern needs would re-render a broken sentence
  // ("When , the …") and only surface later as an analyze MissingTrigger/
  // MissingPreCondition finding. Block it up front with a typed envelope so the
  // agent never persists a malformed sentence — the slot is required *for this
  // pattern*, so ERR_NULL_REQUIRED is the honest code.
  if (clearing) {
    const requiredClear = patternRequiresSlot(target.value.patternType, attr.value)
    if (requiredClear !== undefined) {
      return {
        envelope: failure({
          error: `Cannot clear ${attr.value} on a ${target.value.patternType} requirement — the pattern requires it.`,
          code: 'ERR_NULL_REQUIRED',
          suggestions: [
            `Set a new ${attr.value} value instead of clearing it.`,
            `Or change patternType first if ${requiredClear} no longer applies.`,
          ],
        }),
      }
    }
  }

  // Use the RESOLVED UUID (target may have been found by stable key), so the
  // Change always references the canonical id even when `args.id` was a key.
  const resolvedId = target.value.id

  try {
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: resolvedId,
      attr: attr.value,
      // The ONLY place null enters: the explicit --clear flag. A positional
      // "null" string lands in the else branch verbatim (AC-6-11).
      value: clearing ? null : (args.value as string),
    })
    const data: UpdateData = {
      id: resolvedId,
      attr: attr.value,
      action: clearing ? 'cleared' : 'set',
    }
    return { next, envelope: success('update', data) }
  } catch (e) {
    // ChangeError (ERR_NULL_REQUIRED) and any other coded core error lift with
    // their own code; nothing escapes as a stack trace (AC-6-10).
    return { envelope: toErrorEnvelope(e) }
  }
}

// ---------------------------------------------------------------------------
// Multi-attribute update (wishlist #7) + bulk transition (wishlist #8)
// ---------------------------------------------------------------------------

/**
 * One `attr=value` assignment parsed from the CLI. Only the SET form is
 * supported in multi/bulk mode — clearing stays on the single-attr `--clear`
 * surface, where the mutual-exclusion contract lives.
 */
export interface AttrAssignment {
  readonly attr: string
  readonly value: string
}

/**
 * Validate one assignment against a target requirement: narrow the attr, refuse
 * a pattern-load-bearing clear-by-empty, and build the `UpdateAttribute` Change.
 * Returns the Change on success or the ready-to-emit error envelope. Shared by
 * the multi-attr and bulk paths so their validation is byte-identical to the
 * single-attr surface's.
 */
function buildUpdateChange(
  target: Requirement,
  assignment: AttrAssignment,
): { readonly change: object } | { readonly envelope: ErrorEnvelope } {
  const attr = parseAttr(assignment.attr)
  if (!attr.ok) return { envelope: attr.envelope }
  return {
    change: {
      kind: 'UpdateAttribute',
      id: target.id,
      attr: attr.value,
      value: assignment.value,
    },
  }
}

/** The `data` payload of a successful multi-attribute `update` envelope. */
export interface UpdateManyData {
  readonly id: string
  /** The attributes set, in the order supplied. */
  readonly attrs: UpdatableAttr[]
  readonly action: 'set'
}

export type UpdateManyResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<UpdateManyData> }
  | { readonly envelope: Envelope<UpdateManyData> }

/**
 * Set several attributes on ONE requirement (by key or UUID) in a single call
 * (wishlist #7). All assignments are validated and folded before any is
 * committed, so a bad attr in the batch leaves the document untouched. EARS-slot
 * edits re-render the sentence exactly once per edit via the core Change path.
 */
export function runUpdateMany(
  doc: RequirementsDoc,
  ref: string,
  assignments: readonly AttrAssignment[],
): UpdateManyResult {
  if (assignments.length === 0) {
    return { envelope: usageError('update requires at least one attr=value pair', UPDATE_USAGE) }
  }

  const target = requireRequirement(doc, ref)
  if (!target.ok) return { envelope: target.envelope }

  const changes: object[] = []
  const attrs: UpdatableAttr[] = []
  for (const a of assignments) {
    const built = buildUpdateChange(target.value, a)
    if ('envelope' in built) return { envelope: built.envelope }
    changes.push(built.change)
    attrs.push(a.attr as UpdatableAttr)
  }

  try {
    const next = applyChanges(doc, changes)
    return { next, envelope: success('update', { id: target.value.id, attrs, action: 'set' }) }
  } catch (e) {
    return { envelope: toErrorEnvelope(e) }
  }
}

/** The `data` payload of a successful bulk `update` envelope. */
export interface UpdateBulkData {
  readonly attr: UpdatableAttr
  readonly value: string
  /** UUIDs of every requirement the transition was applied to. */
  readonly matched: string[]
  readonly action: 'set'
}

export type UpdateBulkResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<UpdateBulkData> }
  | { readonly envelope: Envelope<UpdateBulkData> }

/**
 * Apply one `attr=value` transition to EVERY requirement matching a
 * `whereAttr=whereValue` filter (wishlist #8) — the end-of-authoring promotion
 * ritual (`--all --where status=draft status approved`) in one call instead of
 * N. The filter attr is validated for a clear error message, then matched by
 * string equality against the stored value. Zero matches is a successful no-op
 * with an empty `matched` list, so the ritual is safe to run unconditionally.
 */
export function runUpdateBulk(
  doc: RequirementsDoc,
  where: AttrAssignment,
  set: AttrAssignment,
): UpdateBulkResult {
  const whereAttr = parseAttr(where.attr)
  if (!whereAttr.ok) return { envelope: whereAttr.envelope }
  const setAttr = parseAttr(set.attr)
  if (!setAttr.ok) return { envelope: setAttr.envelope }

  const matched = listRequirements(doc).filter(
    (r) => (r as Record<string, unknown>)[whereAttr.value] === where.value,
  )

  const changes = matched.map((r) => ({
    kind: 'UpdateAttribute',
    id: r.id,
    attr: setAttr.value,
    value: set.value,
  }))

  try {
    const next = applyChanges(doc, changes)
    return {
      next,
      envelope: success('update', {
        attr: setAttr.value,
        value: set.value,
        matched: matched.map((r) => r.id),
        action: 'set',
      }),
    }
  } catch (e) {
    return { envelope: toErrorEnvelope(e) }
  }
}
