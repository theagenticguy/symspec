/**
 * The donor's `src/core/doc.ts`, reduced to the two names the transplanted check
 * path uses.
 *
 * ## Why this file is REWRITTEN (edit #2 of 4)
 *
 * The donor original is a facade over the v2 STORAGE layer: `loadDoc` /
 * `saveDoc` (reading and writing the on-disk JSON via `./storage.ts`),
 * `applyChange` / `applyChanges` (re-exported from `./changes.ts`, the Change-
 * record mutation path), `newId` (`node:crypto.randomUUID`),
 * `resolveRequirement` / `resolveId` (the key⇄UUID duality), and `snapshot`.
 *
 * Every one of those is superseded in the greenfield:
 *
 * - loading and saving is `../../../core/store.ts` (the `DocStore` Layer, with
 *   atomic writes and the V27 unknown-key round trip);
 * - ref resolution is `../../../core/resolve.ts`, the single chokepoint;
 * - mutation is the ops table's business, not the tier's.
 *
 * Measured, the check-path closure imports exactly TWO names here: the `Doc` type
 * alias and `listRequirements`. Keeping the storage facade would have dragged
 * `./storage.ts` and `./changes.ts` into the transplant to serve a load path
 * nothing calls — and worse, would have given the tier a SECOND way to read a
 * document off disk, bypassing the store Layer and its diagnostics.
 *
 * `listRequirements` is byte-identical to the donor's. `Doc` is still the alias
 * for the v2 `RequirementsDoc` — see the note in `./schema.ts` on why the v3→v2
 * projection happens once at the boundary rather than inside the tier.
 */

import type { Requirement, RequirementsDoc } from './schema.ts'

/**
 * A requirements document — a plain object. Kept as a named alias so consumers
 * that pass `Doc` around have a stable type name.
 */
export type Doc = RequirementsDoc

/** Every requirement in the document, in map-insertion order. Verbatim from the
 * donor: the ORDER is load-bearing (it feeds the atom roster and the candidate-
 * pair emission), so this is a plain `Object.values` and not a sort. */
export function listRequirements(doc: Doc): Requirement[] {
  return Object.values(doc.requirements)
}
