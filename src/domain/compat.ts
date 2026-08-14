/**
 * THE BOUNDARY — one function that projects a v3 document onto the v2-shaped view
 * the transplanted formal tier reads.
 *
 * ## Why the translation lives here and nowhere else
 *
 * The transplanted tier consumes `donor/core/schema.ts`'s `RequirementsDoc`: a
 * `schemaVersion` tag, a UUID-keyed requirement map, and the three side tables.
 * The v5 document is `../core/document.ts`'s `RequirementsDocument`: `docVersion`,
 * a `stateModel`, and per-requirement `responseKind`.
 *
 * Two places the conversion could go, and only one is defensible:
 *
 * - INSIDE the tier — translate at each of the ~40 files' call sites. That scatters
 *   the format bridge across 40 engine files, and every future question about the
 *   tier then starts with "is this the tier's behavior or the bridge's?".
 * - AT THE BOUNDARY — one function, here. The tier stays untouched, and there is
 *   exactly one place where a v3 document becomes the v2 view it reads.
 *
 * So: here.
 *
 * ## What is dropped, and why each drop is sound for G2a
 *
 * The projection is LOSSY in exactly two ways, both deliberate:
 *
 * 1. **`stateModel` is dropped.** Nothing in the G2a check path reads it — the
 *    reachability tier that will is G4, and G4's design is to encode the state
 *    model NATIVELY rather than through this v2 view. Dropping it here cannot
 *    silently degrade a verdict because no tier consults it; the moment one does,
 *    it will be a G4 tier that takes the v3 document directly.
 * 2. **`responseKind` is dropped.** Same argument: it is the effect-or-constraint
 *    classification the Horn encoder needs, and the propositional/numeric/temporal
 *    tiers do not read it. The v3 field exists so the classification is DATA rather
 *    than a retrofit (donor V27); it does not yet have a consumer.
 *
 * Neither drop is a `verified` hazard, and that is checkable rather than asserted:
 * `compat.test.ts` proves the tier's output is identical whether or not a document
 * carries a state model, which is the same statement as "no tier reads it".
 *
 * ## What must NOT be lost, and is not
 *
 * `negated` and the rendered `sentence` are the two fields the atomizer and the
 * GtWR/AC-3-7 gate actually key on, and both survive verbatim. `negated` in
 * particular is load-bearing: it is what makes `shall X` and `shall not X` share
 * one atom at opposite polarity so a contradiction is provable rather than looking
 * like two unrelated strings. The v3 schema defaults it to `false` on decode, so
 * it is always present here.
 *
 * ## The `schemaVersion: 2` tag is a lie the tier never reads
 *
 * It is set because the donor type requires the field. Nothing in the check path
 * branches on it (measured: no reference outside the type declaration), so it is a
 * structural placeholder, not a claim that this is a v2 document. Stating that
 * here rather than leaving a bare `2` in the code is the difference between an
 * honest placeholder and a bug someone later "fixes" by writing 3.
 */

import type { Doc } from './engine/core/doc.ts'
import type { Requirement as DonorRequirement } from './engine/core/schema.ts'
import type {
  Requirement as DocumentRequirement,
  RequirementsDocument,
} from './requirements/document.ts'

/**
 * Project one v3 requirement onto the donor's requirement shape.
 *
 * Optional fields are spread CONDITIONALLY rather than assigned `undefined`. The
 * v3 type is exact-optional (`exactOptionalPropertyTypes`), so an absent key is
 * genuinely absent, and preserving that distinction across the boundary matters:
 * the tier tests `trigger !== undefined`, and `{trigger: undefined}` vs `{}`
 * behaves the same for that test but differently under `JSON.stringify`. Keeping
 * absence as absence means a projected document serializes to the same bytes a
 * hand-written v2 document would, so anything that canonicalizes JSON — a fixture,
 * a snapshot, an envelope diff — sees no spurious change.
 */
export const toDonorRequirement = (r: DocumentRequirement): DonorRequirement => ({
  id: r.id,
  patternType: r.patternType,
  systemName: r.systemName,
  systemResponse: r.systemResponse,
  // Present on every decoded v3 requirement (the schema defaults it), and
  // load-bearing: this flag is what puts `shall X` and `shall not X` on one atom
  // at opposite polarity.
  negated: r.negated,
  sentence: r.sentence,
  priority: r.priority,
  status: r.status,
  // Edge arrays are `readonly` in v3 and mutable in the tier's type. Copied rather than
  // cast: the tier does not mutate them today, but sharing the array would make a future
  // mutation inside the engine reach back into the caller's document — an aliasing bug
  // in the most confusing possible place.
  derives: [...r.derives],
  satisfies: [...r.satisfies],
  verifies: [...r.verifies],
  refines: [...r.refines],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(r.key !== undefined ? { key: r.key } : {}),
  ...(r.preCondition !== undefined ? { preCondition: r.preCondition } : {}),
  ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
  ...(r.verificationMethod !== undefined ? { verificationMethod: r.verificationMethod } : {}),
  ...(r.verificationNote !== undefined ? { verificationNote: r.verificationNote } : {}),
})

/**
 * Project a v3 document onto the donor's document shape — the ONE boundary
 * crossing.
 *
 * Requirement ORDER is preserved by construction: `Object.entries` on the v3 map
 * feeds a fresh object in the same sequence, and `listRequirements` is a plain
 * `Object.values`. That is not incidental — the order feeds the atom roster and
 * the candidate-pair emission, so re-ordering here would change `pairsChecked`
 * and therefore the coverage report, while leaving every finding intact. Exactly
 * the kind of divergence that looks like noise in a diff.
 */
export const toDonorDoc = (document: RequirementsDocument): Doc => {
  const requirements: Record<string, DonorRequirement> = {}
  for (const [id, r] of Object.entries(document.requirements)) {
    requirements[id] = toDonorRequirement(r)
  }
  return {
    // A structural placeholder the tier never reads — see the module header.
    schemaVersion: 2,
    requirements,
    glossary: document.glossary.map((g) => ({ canonical: g.canonical, aliases: [...g.aliases] })),
    antonyms: document.antonyms.map((a) => ({ a: a.a, b: a.b })),
    waivers: document.waivers.map((w) => ({
      code: w.code,
      reason: w.reason,
      ...(w.requirementId !== undefined ? { requirementId: w.requirementId } : {}),
    })),
  }
}
