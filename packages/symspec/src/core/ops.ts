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
 * ## The verbs, and why exactly these
 *
 * They are the donor's `APPLY_OPS` (add / update / derive / satisfy / verify /
 * refine / remove-edge / delete) UNIONED with the three side-table commands the
 * donor's `apply` had no op for and had to emit as shell lines
 * (`glossary add`, `antonym add`, `waive add`), plus their four inverses, plus G4's
 * four STATE-MODEL verbs (`state` / `unstate` / `state-initial` / `classify`).
 *
 * The G4 four are here rather than in a vocabulary of their own for the reason the
 * side tables were folded in: a state model is authored as a BATCH (declare N
 * variables, classify M responses, write M expressions), and a table reachable only
 * through single commands is a table an agent cannot author atomically. One union
 * also keeps `repair.ops` decodable by construction — a reachability demotion's
 * repair emits `classify`/`state` records from the same schemas `apply` decodes.
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
  FRAME_KINDS,
  PRIORITIES,
  RELATIONS,
  RESPONSE_KINDS,
  STATE_VAR_TYPES,
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
 * The INVERSE: relation → the op verb that creates it.
 *
 * Derived from {@link EDGE_OP_RELATION} rather than written out, so the two directions
 * cannot disagree — and `ops.test.ts` asserts they compose to the identity in both
 * directions. It exists because the CLI takes a `--relation derives` (one command, one
 * closed flag) while the op STREAM carries `{"op":"derive"}` (the donor's spelling,
 * append-only), so exactly one place has to map between them.
 */
export const RELATION_EDGE_OP = Object.fromEntries(
  Object.entries(EDGE_OP_RELATION).map(([verb, relation]) => [relation, verb]),
) as Record<(typeof RELATIONS)[number], keyof typeof EDGE_OP_RELATION>

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

/**
 * `{"op":"state", …}` — declare (or redeclare) one state variable.
 *
 * ## Why the state model gets OPS and not just a command
 *
 * Because a state model is authored as a BATCH. Declaring five variables, classifying
 * six responses, and writing six expressions is seventeen edits that only mean
 * something together — and the whole point of the op vocabulary is that seventeen
 * edits are one `apply`. A state model reachable only through single commands would
 * be the one table an agent could not author atomically, which is exactly the shape
 * the donor's side tables had before G2b folded them in.
 *
 * ## `domain` is a LIST, and `frame` defaults at the FOLD
 *
 * `domain` mirrors the schema's per-type rules (required for `enum`, optional bounds
 * for `int`, forbidden for `bool`) rather than restating them: the fold builds the
 * variable and the DOCUMENT SCHEMA is what refuses a bool with a domain, so there is
 * one rule and it lives where the manifest publishes it.
 *
 * `frame` is optional here and the fold defaults it to `volatile`. That is the
 * soundness-critical default (see `FRAME_KINDS`), and it is expressed as an absent
 * key rather than a required field so a stream written without any frame awareness at
 * all gets the SAFE behavior. A required `frame` would make the unsound value as easy
 * to type as the sound one.
 *
 * REDECLARATION replaces, and is not an error: authoring a state model is iterative
 * (declare `retry_count` as an int, then bound it, then mark it stable), and forcing
 * an `unstate` between edits would make a repair plan order-dependent for no benefit.
 * It is reported as a non-noop write, so an agent can see it happened.
 */
export const StateOp = Schema.Struct({
  op: Schema.Literal('state'),
  name: Schema.String,
  type: Schema.Literals(STATE_VAR_TYPES),
  domain: Schema.optionalKey(Schema.Array(Schema.String)),
  min: Schema.optionalKey(Schema.Int),
  max: Schema.optionalKey(Schema.Int),
  frame: Schema.optionalKey(Schema.Literals(FRAME_KINDS)),
  initial: Schema.optionalKey(Schema.String),
})
export type StateOp = typeof StateOp.Type

/**
 * `{"op":"unstate", …}` — undeclare one state variable.
 *
 * REFUSED while any requirement's `stateEffect` or `stateConstraint` still references
 * the variable, which is the inverse of the authoring-time reference check and closes
 * the same hazard from the other side. Without it, `unstate` would be a second route
 * to the state an undeclared reference creates — a document whose expressions name a
 * variable the model does not declare — and that document's next `check` is the
 * V14/V21 hang. The refusal names the referencing requirements so the fix is
 * mechanical.
 */
export const UnstateOp = Schema.Struct({
  op: Schema.Literal('unstate'),
  name: Schema.String,
})
export type UnstateOp = typeof UnstateOp.Type

/**
 * `{"op":"state-initial", …}` — set or clear the model-wide initial-state predicate.
 *
 * `predicate: null` clears it, the same `NullOr` convention `update` uses and for the
 * same reason: JSON distinguishes "the string" from "no value" natively, so one field
 * expresses both intents and no `--clear`-style flag is needed in the stream.
 */
export const StateInitialOp = Schema.Struct({
  op: Schema.Literal('state-initial'),
  predicate: Schema.NullOr(Schema.String),
})
export type StateInitialOp = typeof StateInitialOp.Type

/**
 * `{"op":"classify", …}` — classify one requirement's response, with its expression.
 *
 * ## The label and the expression arrive TOGETHER, deliberately
 *
 * `responseKind` is already an `update`-able attribute, so `{"op":"update","attr":
 * "responseKind","value":"effect"}` was expressible before this op existed. What it
 * could NOT express is the pairing: a requirement labelled `effect` with no
 * `stateEffect` contributes nothing to the transition relation, so it is a
 * classification that reads as done and is not. This op takes both, and the fold
 * refuses a label with no expression — so the mechanically-easy path is also the
 * complete one.
 *
 * `kind: null` RETRACTS the classification, clearing both the label and whichever
 * expression it carried. Retraction is a real authoring move (a response that turned
 * out not to touch state), and it must clear the expression too: a document with
 * `stateConstraint` set and `responseKind` absent would carry a predicate nothing
 * reads, which is the "decision recorded and not applied" shape the antonym
 * normalization note warns about.
 */
export const ClassifyOp = Schema.Struct({
  op: Schema.Literal('classify'),
  ref: Schema.String,
  kind: Schema.NullOr(Schema.Literals(RESPONSE_KINDS)),
  expression: Schema.optionalKey(Schema.String),
})
export type ClassifyOp = typeof ClassifyOp.Type

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
  // G4: the state model. Four verbs in the SAME union, so a reachability repair plan
  // rides the same `apply` as every other repair and there is still exactly one
  // vocabulary — which is what keeps `repair.ops` decodable by construction.
  StateOp,
  UnstateOp,
  StateInitialOp,
  ClassifyOp,
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
  // G4 — APPENDED, never interleaved. The vocabulary is append-only for the same
  // reason the code catalogs are: a stream written against an older build must still
  // decode, and a reorder would silently renumber every position an external snapshot
  // recorded.
  'state',
  'unstate',
  'state-initial',
  'classify',
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
