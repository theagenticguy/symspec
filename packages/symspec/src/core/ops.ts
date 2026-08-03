/**
 * THE DOCUMENT-OP VOCABULARY — one closed union, and the only way a document
 * changes.
 *
 * ## Why this module exists at all
 *
 * Before G2b there were two op vocabularies in the codebase and they were drifting
 * by construction:
 *
 * - `../operations/import.ts` declared five op schemas (`add`, the four edge verbs,
 *   `glossary`, `antonym`, `waive`) for consuming the donor's reproduce stream;
 * - `../formal/repair.ts` emitted `commands: string[]` and an always-empty
 *   `ops: []`, with a header note saying the ops "do not exist until the G2b ops
 *   land".
 *
 * They land here. Every mutation an operation performs, every op record `apply`
 * folds, every record `import` replays, and every `repair.ops` entry a finding
 * carries are the SAME eleven verbs decoded by the SAME schemas. That is what makes
 * the repair round-trip (spec AC-A-1 + AC-A-2) mechanically true rather than
 * aspirational: `check` emits ops from this union, `apply` consumes ops from this
 * union, and there is no translation step in between that could disagree.
 *
 * ## The eleven verbs, and why exactly these
 *
 * They are the donor's `APPLY_OPS` (add / update / derive / satisfy / verify /
 * refine / remove-edge / delete) UNIONED with the three side-table commands the
 * donor's `apply` had no op for and had to emit as shell lines
 * (`glossary add`, `antonym add`, `waive add`).
 *
 * Folding the side tables in is the single most load-bearing change here, and the
 * reason is `repair`. The most common demotion discharges are `glossary add`,
 * `antonym add`, and `waive add` — the donor could only ever name them as prose
 * commands, so an agent had to shell out three times and could not batch a repair
 * plan. As ops they ride the same JSONL stream as everything else, so a whole
 * repair plan is one `apply`.
 *
 * ## `update`'s `value` is NULLABLE, and that replaces the donor's `--clear` split
 *
 * The donor had two surfaces for one intent: `update <ref> <attr> <value>` to set,
 * and `update --clear <ref> <attr>` to clear, because its batch op could not
 * express a clear at all (`apply.ts` required `typeof value === 'string'`). So a
 * batch could set but never clear, and the CLI carried a mutual-exclusion contract
 * to keep `"null"`-the-string from meaning null-the-clear.
 *
 * Here `value: string | null` says it once: a string SETS (and the literal
 * `"null"` is a string, so it sets the text "null"), and `null` CLEARS. JSON
 * distinguishes them natively — which is exactly the distinction the donor had to
 * build a flag for because a shell argv cannot. The CLI keeps `--clear` as the
 * spelling for `null`, since argv still cannot express it.
 *
 * ## Refs are key-OR-UUID everywhere, resolved at the ONE chokepoint
 *
 * Every `ref` / `from` / `to` field accepts a stable key or a UUID and is resolved
 * through `./resolve.ts`. Nothing here resolves anything itself — see the header
 * note in `./mutate.ts` for why the fold resolves against the RUNNING document
 * rather than the original, which is what makes a key minted by an earlier op in
 * the same batch reference-able by a later one.
 */

import { Schema } from 'effect'
import {
  EARS_PATTERNS,
  PRIORITIES,
  RELATIONS,
  RESPONSE_KINDS,
  STATUSES,
  UPDATABLE_ATTRS,
  VERIFICATION_METHODS,
} from './document.ts'

// ---------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------

/**
 * `{"op":"add", …}` — create one requirement.
 *
 * `id` is OPTIONAL and that is the whole ergonomic story: omitting it lets the
 * fold mint a UUID, so an agent authoring a document never handles one. A `key`
 * supplied here is immediately reference-able by LATER ops in the same batch,
 * which is what removes the donor's label→UUID sidecar file.
 *
 * `sentence` is deliberately absent from the op. It is a denormalized rendering of
 * the slots, so carrying it would let a stream assert a sentence inconsistent with
 * the slots it describes; the fold re-renders it instead.
 */
export const AddOp = Schema.Struct({
  op: Schema.Literal('add'),
  id: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  patternType: Schema.Literals(EARS_PATTERNS),
  preCondition: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Schema.String),
  systemName: Schema.String,
  systemResponse: Schema.String,
  negated: Schema.optionalKey(Schema.Boolean),
  responseKind: Schema.optionalKey(Schema.Literals(RESPONSE_KINDS)),
  priority: Schema.optionalKey(Schema.Literals(PRIORITIES)),
  status: Schema.optionalKey(Schema.Literals(STATUSES)),
  verificationMethod: Schema.optionalKey(Schema.Literals(VERIFICATION_METHODS)),
  verificationNote: Schema.optionalKey(Schema.String),
})
export type AddOp = typeof AddOp.Type

/**
 * `{"op":"update", …}` — set or CLEAR one attribute.
 *
 * `value: null` clears, and the fold refuses to clear an attribute that is not in
 * the document's nullable set (`ERR_NULL_REQUIRED`) — including one the
 * requirement's OWN pattern structurally needs, which is a stricter rule than
 * "optional in the schema" and the one that stops a re-render producing
 * `"When , the …"`.
 */
export const UpdateOp = Schema.Struct({
  op: Schema.Literal('update'),
  ref: Schema.String,
  attr: Schema.Literals(UPDATABLE_ATTRS),
  value: Schema.NullOr(Schema.String),
})
export type UpdateOp = typeof UpdateOp.Type

/**
 * `{"op":"delete", …}` — remove one requirement.
 *
 * Accepts `ref` OR `id`, both key-or-UUID and resolved identically, because the
 * donor's `apply` accepted both and a stream written against it must keep working.
 * `ref` wins when both appear. Neither is required by the SCHEMA — the fold reports
 * a missing ref as a per-op usage error, which keeps the message specific ("delete
 * requires ref (or id)") rather than a schema-shaped complaint about a union.
 */
export const DeleteOp = Schema.Struct({
  op: Schema.Literal('delete'),
  ref: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
})
export type DeleteOp = typeof DeleteOp.Type

/** The four edge-CREATING verbs → the relation each adds. One table, so the verb
 * set and the relation set cannot disagree; `ops.test.ts` asserts it is a
 * bijection onto {@link RELATIONS}. */
export const EDGE_OP_RELATION = {
  derive: 'derives',
  satisfy: 'satisfies',
  verify: 'verifies',
  refine: 'refines',
} as const satisfies Record<string, (typeof RELATIONS)[number]>

/** The edge verbs, derived from the table. */
export const EDGE_OPS = Object.keys(EDGE_OP_RELATION) as readonly (keyof typeof EDGE_OP_RELATION)[]

/**
 * `{"op":"derive"|"satisfy"|"verify"|"refine", …}` — add one typed edge.
 *
 * IDEMPOTENT in the fold: re-adding an existing edge is a no-op success, so
 * replaying a stream never duplicates an edge. That is what lets an agent re-run a
 * repair plan without first checking what it already applied.
 */
export const EdgeOp = Schema.Struct({
  op: Schema.Literals(EDGE_OPS),
  from: Schema.String,
  to: Schema.String,
})
export type EdgeOp = typeof EdgeOp.Type

/** `{"op":"remove-edge", …}` — remove one typed edge. A no-op when the edge is
 * already absent, so it is safe to call defensively (donor AC-1-7). */
export const RemoveEdgeOp = Schema.Struct({
  op: Schema.Literal('remove-edge'),
  from: Schema.String,
  relation: Schema.Literals(RELATIONS),
  to: Schema.String,
})
export type RemoveEdgeOp = typeof RemoveEdgeOp.Type

/**
 * `{"op":"glossary", …}` — commit one synonym alias under a canonical phrase.
 *
 * The DECIDE half of the semantic tier: the propose tier only ever SUGGESTS one of
 * these, and the formal tier canonicalizes response atoms through the committed
 * table. So this op is the mechanism by which a fuzzy suggestion becomes a
 * deterministic verdict — and the reason a cosine can never reach a verdict
 * without a human or agent committing this record first.
 */
export const GlossaryOp = Schema.Struct({
  op: Schema.Literal('glossary'),
  canonical: Schema.String,
  alias: Schema.String,
})
export type GlossaryOp = typeof GlossaryOp.Type

/**
 * `{"op":"antonym", …}` — commit one polar-opposite verb-head pair.
 *
 * The opposition twin of `glossary`, and the ONE op whose wrong value MANUFACTURES
 * a false contradiction rather than merely masking one: committing a SYNONYM pair
 * as an antonym collapses two identical responses to R vs ¬R and the solver then
 * proves a conflict that does not exist. The fold therefore validates the merged
 * signed union-find and refuses an inconsistent pair, which is why the check path
 * can stay throw-free.
 */
export const AntonymOp = Schema.Struct({
  op: Schema.Literal('antonym'),
  a: Schema.String,
  b: Schema.String,
})
export type AntonymOp = typeof AntonymOp.Type

/** `{"op":"waive", …}` — commit one reviewed finding suppression, optionally
 * scoped to a requirement. `reason` is REQUIRED: a waiver with no audit trail is
 * indistinguishable from neglect to the next reader. */
export const WaiveOp = Schema.Struct({
  op: Schema.Literal('waive'),
  code: Schema.String,
  reason: Schema.String,
  ref: Schema.optionalKey(Schema.String),
})
export type WaiveOp = typeof WaiveOp.Type

/** `{"op":"unwaive", …}` — remove a committed waiver. The inverse of `waive`, so a
 * repair plan is reversible by an op stream rather than by hand-editing the file. */
export const UnwaiveOp = Schema.Struct({
  op: Schema.Literal('unwaive'),
  code: Schema.String,
  ref: Schema.optionalKey(Schema.String),
})
export type UnwaiveOp = typeof UnwaiveOp.Type

/** `{"op":"unglossary", …}` — remove one committed alias. */
export const UnglossaryOp = Schema.Struct({
  op: Schema.Literal('unglossary'),
  canonical: Schema.String,
  alias: Schema.String,
})
export type UnglossaryOp = typeof UnglossaryOp.Type

/** `{"op":"unantonym", …}` — remove one committed antonym pair (either order). */
export const UnantonymOp = Schema.Struct({
  op: Schema.Literal('unantonym'),
  a: Schema.String,
  b: Schema.String,
})
export type UnantonymOp = typeof UnantonymOp.Type

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Every document op, as one union. `apply`, `import`, and every `repair.ops` entry
 * decode against THIS — there is no second vocabulary and no per-surface subset,
 * so an op an agent reads out of a `repair` is an op `apply` accepts by
 * construction.
 */
export const DocumentOp = Schema.Union([
  AddOp,
  UpdateOp,
  DeleteOp,
  EdgeOp,
  RemoveEdgeOp,
  GlossaryOp,
  AntonymOp,
  WaiveOp,
  UnwaiveOp,
  UnglossaryOp,
  UnantonymOp,
])
export type DocumentOp = typeof DocumentOp.Type

/**
 * Every op VERB, for the manifest and for a "did you mean" on an unknown verb.
 *
 * Spelled out rather than derived from the union, because reading a literal off a
 * `Schema.Union` member's AST is exactly the kind of annotation archaeology this
 * beta lies about (three silent JSON-Schema failures so far). `ops.test.ts` asserts
 * this list decodes 1:1 against {@link DocumentOp}, which is a stronger check than
 * a derivation would be: it proves each verb is REACHABLE, not merely listed.
 */
export const OP_VERBS = [
  'add',
  'update',
  'delete',
  'derive',
  'satisfy',
  'verify',
  'refine',
  'remove-edge',
  'glossary',
  'antonym',
  'waive',
  'unwaive',
  'unglossary',
  'unantonym',
] as const
export type OpVerb = (typeof OP_VERBS)[number]

/** Decode one raw op record. `{onExcessProperty:'error'}` so a misspelled field is
 * a LOUD per-op failure instead of a silently dropped value — the same guard the
 * kernel puts on operation input, for the same reason. */
export const decodeOp = Schema.decodeUnknownEffect(DocumentOp, { onExcessProperty: 'error' })

/**
 * Serialize an op to the ONE JSONL line `apply` reads back.
 *
 * Used by every `repair.ops` producer, so a repair an agent pipes into `apply` is
 * byte-for-byte a line this module can decode. Keys are NOT sorted: the op's
 * declaration order reads better for a human scanning a repair plan (`op` first),
 * and unlike the document file there is no diff-stability requirement on a stream
 * that is generated fresh every run.
 */
export const opLine = (op: DocumentOp): string => JSON.stringify(op)
