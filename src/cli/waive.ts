/**
 * The `waive` command core (wishlist #3): manage the document's committed
 * finding waivers — the reviewed-suppression half of the lint workflow.
 *
 * A recurring authoring pain point: `symspec check` re-emits ~200 non-actionable
 * warnings every run with no record that they were reviewed, so the next reader
 * cannot tell triage from neglect, and a heuristic false positive (GTWR_R6 on
 * "RFC 9457") forces a choice between degrading prose and living with noise.
 * A waiver is the dignified exit: a `{code, requirementId?, reason}` record,
 * committed to the document, that `symspec check` honors by dropping matching
 * findings from `findings[]` and the exit gate while reporting the count under
 * `waived` (see `pipeline/check.ts`).
 *
 * Pure and I/O-free like the other command cores (`glossary`/`add`/`update`):
 * each op takes the loaded document and returns `{next?, envelope}` — the
 * mutated document (only on a mutating success) plus the typed envelope to emit.
 * The command wiring loads, calls, saves on `next`, and emits.
 *
 * `add` is idempotent (an identical waiver is a no-op success); `remove` of an
 * absent waiver is a no-op success; `list` never mutates. The optional
 * requirement scope accepts a stable key or a UUID and is stored as the UUID,
 * so a waiver survives any human-facing relabeling.
 */

import { resolveId } from '../core/doc.js'
import type { RequirementsDoc, Waiver } from '../core/schema.js'
import type { Envelope } from './envelope.js'
import { success } from './envelope.js'
import { notFoundError, usageError } from './errors.js'

/** The usage line waive `ERR_USAGE` suggestions cite. */
export const WAIVE_USAGE =
  'symspec waive <add|remove|list> [code] [--ref <key|uuid>] [--reason "<why>"]'

/** `data` payload of a waive envelope. */
export interface WaiveData {
  readonly action: 'added' | 'removed' | 'listed' | 'noop'
  readonly waivers: Waiver[]
}

/** Result of a waive op: envelope always, `next` only on a mutating success. */
export type WaiveResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<WaiveData> }
  | { readonly envelope: Envelope<WaiveData> }

/** Deep-copy the waivers so a returned `next` never aliases the input's array. */
function cloneWaivers(waivers: readonly Waiver[]): Waiver[] {
  return waivers.map((w) => ({
    code: w.code,
    ...(w.requirementId !== undefined ? { requirementId: w.requirementId } : {}),
    reason: w.reason,
  }))
}

/** Two waivers match iff they suppress the same code with the same scope. */
function sameWaiver(a: Waiver, b: Waiver): boolean {
  return a.code === b.code && a.requirementId === b.requirementId
}

/** List the committed waivers (no mutation). */
export function waiveList(doc: RequirementsDoc): WaiveResult {
  return {
    envelope: success('waive', { action: 'listed', waivers: cloneWaivers(doc.waivers) }),
  }
}

/**
 * Add a waiver for `code`, optionally scoped to the requirement named by `ref`
 * (a stable key or UUID). Idempotent: an identical waiver is a no-op success.
 * A `ref` that does not resolve is ERR_NOT_FOUND. `reason` is required so a
 * waiver always carries the audit trail that distinguishes review from neglect.
 */
export function waiveAdd(
  doc: RequirementsDoc,
  code: string,
  reason: string,
  ref?: string,
): WaiveResult {
  const c = code.trim()
  const r = reason.trim()
  if (c.length === 0 || r.length === 0) {
    return {
      envelope: usageError(
        'waive add requires a non-empty <code> and --reason',
        WAIVE_USAGE,
      ) as Envelope<WaiveData>,
    }
  }

  // Resolve an optional key/UUID scope to the stable UUID before storing, so a
  // scoped waiver keeps biting the right requirement regardless of relabeling.
  let requirementId: string | undefined
  if (ref !== undefined) {
    const resolved = resolveId(doc, ref)
    if (resolved === undefined) return { envelope: notFoundError(ref) as Envelope<WaiveData> }
    requirementId = resolved
  }

  const waiver: Waiver =
    requirementId !== undefined ? { code: c, requirementId, reason: r } : { code: c, reason: r }

  const waivers = cloneWaivers(doc.waivers)
  if (waivers.some((w) => sameWaiver(w, waiver))) {
    // Idempotent: same code + same scope already waived. Report the existing
    // set unchanged (the stored reason wins — first review is authoritative).
    return { envelope: success('waive', { action: 'noop', waivers }) }
  }
  waivers.push(waiver)
  return {
    next: { ...doc, waivers },
    envelope: success('waive', { action: 'added', waivers }),
  }
}

/**
 * Remove the waiver for `code` at the scope named by `ref` (key/UUID, or
 * document-wide when omitted). No-op success if no such waiver exists.
 */
export function waiveRemove(doc: RequirementsDoc, code: string, ref?: string): WaiveResult {
  const c = code.trim()
  // A ref that cannot resolve simply matches nothing (there can be no waiver
  // scoped to a non-existent requirement), so remove is a no-op rather than an
  // error — symmetric with glossary remove.
  const requirementId = ref !== undefined ? resolveId(doc, ref) : undefined
  const target: Waiver =
    requirementId !== undefined ? { code: c, requirementId, reason: '' } : { code: c, reason: '' }

  const waivers = cloneWaivers(doc.waivers)
  const kept = waivers.filter((w) => !sameWaiver(w, target))
  if (kept.length === waivers.length) {
    return { envelope: success('waive', { action: 'noop', waivers }) }
  }
  return {
    next: { ...doc, waivers: kept },
    envelope: success('waive', { action: 'removed', waivers: kept }),
  }
}
