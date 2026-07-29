/**
 * Derive the exact, machine-applicable op stream that reproduces a loaded
 * document at the CURRENT schema (AC-1-5, second disjunct).
 *
 * ## Why this module exists
 *
 * `load.ts`'s `ERR_SCHEMA_VERSION` path fires only AFTER
 * `RequirementsDocSchema.safeParse` has already succeeded, so the document it
 * rejects is by construction fully readable: every requirement, every typed
 * edge, every glossary entry, antonym pair and waiver is present and validated.
 * The old failure told the caller to "re-create the document … then re-add each
 * requirement" — prose an agent cannot execute. Since the content is readable,
 * the ops that rebuild it are DERIVABLE with zero format guessing, so this
 * module emits them instead.
 *
 * ## Two output channels, because only two exist
 *
 *   1. **`ops`** — `symspec apply` JSONL op records. Emitted in dependency
 *      order: every `add` first, then the edge ops that reference them, so the
 *      whole stream folds in one atomic `apply` (see `cli/apply.ts`).
 *   2. **`commands`** — shell commands for the doc-committed tables that have
 *      NO `apply` op today. `APPLY_OPS` is `add | update | derive | satisfy |
 *      verify | refine | remove-edge | delete`; `glossary`, `antonym` and
 *      `waive` are separate top-level commands, so their content CANNOT ride
 *      the op stream. Emitting a fabricated `{"op":"glossary"}` record would be
 *      rejected by `apply` — claiming an unsupported capability is exactly the
 *      defect this work removes — so those rows are reported as commands.
 *
 * Anything that genuinely does not reproduce is reported explicitly in
 * {@link ReproducePlan.gaps} rather than papered over: runtime-stamped
 * timestamps, edges whose target UUID no longer resolves (`apply` would abort
 * the batch with `ERR_NOT_FOUND`, so they are DROPPED from `ops` and disclosed),
 * and any hand-edited `sentence` the EARS renderer does not reproduce from the
 * requirement's own slots.
 *
 * ## Fidelity choices
 *
 *   - The `add` op carries the original `id`. `cli/apply.ts`'s `add` handler
 *     reads `id` off the record and only mints a fresh UUID when it is absent,
 *     so preserving it keeps requirement identity stable — which is what lets a
 *     UUID-scoped waiver (`WaiverSchema.requirementId`) and every reproduced
 *     edge still resolve. (Contrast `ProposedAddOpSchema`, which deliberately
 *     OMITS `id`: that payload proposes NEW requirements, where a caller-chosen
 *     UUID would leak non-determinism. Here the UUID is existing data.)
 *   - `negated`, `priority` and `status` are always emitted even when they equal
 *     the create-time default, so the reproduction does not depend on the
 *     default table staying put.
 *   - `sentence` is never emitted: it is a denormalized view the mutation path
 *     re-renders from the slots (`core/render.ts`), so it comes back for free.
 *
 * Pure: no I/O, no randomness, no mutation of its argument.
 */

import { renderSentence } from './render.js'
import type {
  EarsPattern,
  Priority,
  Relation,
  RequirementsDoc,
  Status,
  VerificationMethod,
} from './schema.js'
import { RELATIONS } from './schema.js'

// ---------------------------------------------------------------------------
// Op shapes — the exact `symspec apply` JSONL records
// ---------------------------------------------------------------------------

/**
 * The four edge-creating `apply` op verbs, keyed by the schema relation they
 * add. The INVERSE of `cli/apply.ts`'s `EDGE_OP_RELATION`; declared here (rather
 * than imported) so `core/` never depends on `cli/`. Typed as a total
 * `Record<Relation, …>`, so adding a relation to `RELATIONS` fails to compile
 * until this table is extended, and `reproduce.test.ts` asserts the two tables
 * are exact inverses so they cannot drift.
 */
export const RELATION_REPRODUCE_OP: Record<Relation, 'derive' | 'satisfy' | 'verify' | 'refine'> = {
  derives: 'derive',
  satisfies: 'satisfy',
  verifies: 'verify',
  refines: 'refine',
}

/**
 * One `{"op":"add", …}` record. Mirrors `CreateRequirementAttrsSchema` plus the
 * preserved `id` the `apply` handler reads off the record. Optional slots are
 * ABSENT rather than `null` when the requirement does not carry them.
 */
export interface ReproduceAddOp {
  readonly op: 'add'
  readonly id: string
  readonly key?: string
  readonly patternType: EarsPattern
  readonly preCondition?: string
  readonly trigger?: string
  readonly systemName: string
  readonly systemResponse: string
  readonly negated: boolean
  readonly priority: Priority
  readonly status: Status
  readonly verificationMethod?: VerificationMethod
  readonly verificationNote?: string
}

/** One edge-creating op record (`derive` / `satisfy` / `verify` / `refine`). */
export interface ReproduceEdgeOp {
  readonly op: 'derive' | 'satisfy' | 'verify' | 'refine'
  readonly from: string
  readonly to: string
}

/** One record of the reproduce op stream. */
export type ReproduceOp = ReproduceAddOp | ReproduceEdgeOp

// ---------------------------------------------------------------------------
// Gaps — what the op stream provably does NOT carry
// ---------------------------------------------------------------------------

/** Why one aspect of the document is not reproduced by the op stream. */
export type ReproduceGapKind = 'timestamps' | 'dangling-edge' | 'rendered-sentence'

/**
 * One honest disclosure. Present in {@link ReproducePlan.gaps} only when it
 * actually applies to this document (the timestamp gap always does).
 */
export interface ReproduceGap {
  readonly kind: ReproduceGapKind
  /** Human-readable statement of exactly what will not come back. */
  readonly detail: string
  /** The requirements involved, when the gap is requirement-scoped. */
  readonly requirementIds?: readonly string[]
}

/**
 * The full reproduction plan for one document: the `apply` op stream, the shell
 * commands for the tables `apply` has no op for, and the explicit gaps.
 */
export interface ReproducePlan {
  readonly ops: readonly ReproduceOp[]
  readonly commands: readonly string[]
  readonly gaps: readonly ReproduceGap[]
}

// ---------------------------------------------------------------------------
// Op derivation
// ---------------------------------------------------------------------------

/**
 * Requirement UUIDs in a deterministic order. The on-disk document already
 * sorts its object keys (`storage.ts` `sortKeysDeep`), but sorting here makes
 * the op stream independent of how the document reached memory.
 */
function orderedIds(doc: RequirementsDoc): string[] {
  return Object.keys(doc.requirements).sort()
}

/**
 * The `add` ops for every requirement, in {@link orderedIds} order. One op per
 * requirement; no `update` op is ever needed because every persisted attribute
 * except `id` (carried on the op), `sentence` (re-rendered) and the two
 * timestamps (runtime-stamped) is a legal create attr.
 */
export function reproduceAddOps(doc: RequirementsDoc): ReproduceAddOp[] {
  const ops: ReproduceAddOp[] = []
  for (const id of orderedIds(doc)) {
    const r = doc.requirements[id]
    if (r === undefined) continue
    ops.push({
      op: 'add',
      id: r.id,
      ...(r.key !== undefined ? { key: r.key } : {}),
      patternType: r.patternType,
      ...(r.preCondition !== undefined ? { preCondition: r.preCondition } : {}),
      ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
      systemName: r.systemName,
      systemResponse: r.systemResponse,
      negated: r.negated,
      priority: r.priority,
      status: r.status,
      ...(r.verificationMethod !== undefined ? { verificationMethod: r.verificationMethod } : {}),
      ...(r.verificationNote !== undefined ? { verificationNote: r.verificationNote } : {}),
    })
  }
  return ops
}

/** An edge that cannot be reproduced because its target no longer resolves. */
export interface DanglingEdge {
  readonly from: string
  readonly relation: Relation
  readonly to: string
}

/**
 * The edge ops for every typed outbound edge, plus the dangling edges that were
 * deliberately left out. Array order within each relation is preserved, so the
 * reproduced document's edge arrays match the original element-for-element.
 *
 * A dangling target (a UUID no requirement carries) is legal in the document —
 * writes are permissive and `symspec check` reports the dangling reference as a
 * finding — but `apply` resolves `to` through `resolveId` and fails the op with
 * `ERR_NOT_FOUND`, which in atomic mode aborts the ENTIRE batch. Emitting one
 * would therefore hand back an op stream that cannot run, so it is dropped here
 * and disclosed as a {@link ReproduceGap}.
 */
export function reproduceEdgeOps(doc: RequirementsDoc): {
  ops: ReproduceEdgeOp[]
  dangling: DanglingEdge[]
} {
  const ops: ReproduceEdgeOp[] = []
  const dangling: DanglingEdge[] = []
  for (const id of orderedIds(doc)) {
    const r = doc.requirements[id]
    if (r === undefined) continue
    for (const relation of RELATIONS) {
      for (const to of r[relation]) {
        if (doc.requirements[to] === undefined) {
          dangling.push({ from: r.id, relation, to })
          continue
        }
        ops.push({ op: RELATION_REPRODUCE_OP[relation], from: r.id, to })
      }
    }
  }
  return { ops, dangling }
}

/**
 * The whole op stream in dependency order: every `add` first, then every edge
 * op. Ordering is what makes the stream applicable in ONE atomic `apply` —
 * `apply` resolves each edge's `from`/`to` against the FOLDED document, so a
 * requirement minted earlier in the same batch is already there.
 */
export function reproduceOps(doc: RequirementsDoc): ReproduceOp[] {
  return [...reproduceAddOps(doc), ...reproduceEdgeOps(doc).ops]
}

/** Serialize the op stream to `apply`-ready JSONL text (one record per line). */
export function reproduceOpsJsonl(doc: RequirementsDoc): string {
  const ops = reproduceOps(doc)
  return ops.length === 0 ? '' : `${ops.map((op) => JSON.stringify(op)).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Commands — the doc-committed tables `apply` has no op for
// ---------------------------------------------------------------------------

/** Shell-safe argument: bare when unambiguous, single-quoted otherwise. */
function quoteArg(value: string): string {
  return /^[A-Za-z0-9._/=:-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The exact `symspec` commands that rebuild the glossary, antonym and waiver
 * tables. These are NOT `apply` ops (`APPLY_OPS` covers requirements and edges
 * only), so they are reported as commands rather than fabricated op records.
 * A waiver's stored UUID scope is emitted as `--ref <uuid>` and resolves because
 * the `add` ops preserve requirement UUIDs.
 */
export function reproduceCommands(doc: RequirementsDoc): string[] {
  const commands: string[] = []
  for (const entry of doc.glossary) {
    for (const alias of entry.aliases) {
      commands.push(`symspec glossary add ${quoteArg(entry.canonical)} ${quoteArg(alias)}`)
    }
  }
  for (const pair of doc.antonyms) {
    commands.push(`symspec antonym add ${quoteArg(pair.a)} ${quoteArg(pair.b)}`)
  }
  for (const waiver of doc.waivers) {
    const ref = waiver.requirementId !== undefined ? ` --ref ${waiver.requirementId}` : ''
    commands.push(
      `symspec waive add ${quoteArg(waiver.code)} --reason ${quoteArg(waiver.reason)}${ref}`,
    )
  }
  return commands
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Build the full reproduction plan for `doc`: the `apply` op stream, the
 * commands for the non-op tables, and every gap the plan does not close.
 */
export function reproducePlan(doc: RequirementsDoc): ReproducePlan {
  const addOps = reproduceAddOps(doc)
  const { ops: edgeOps, dangling } = reproduceEdgeOps(doc)
  const gaps: ReproduceGap[] = []

  // Always true: applyChange stamps `createdAt`/`updatedAt` with the wall clock.
  if (addOps.length > 0) {
    gaps.push({
      kind: 'timestamps',
      detail:
        'createdAt/updatedAt are stamped by the runtime when each op is applied, so the rebuilt document carries fresh timestamps rather than the originals.',
    })
  }

  if (dangling.length > 0) {
    gaps.push({
      kind: 'dangling-edge',
      detail: `${dangling.length} edge(s) point at a UUID no requirement in this document carries, and are omitted from the op stream because \`apply\` fails such an op with ERR_NOT_FOUND and aborts the batch: ${dangling
        .map((e) => `${e.from} -${e.relation}-> ${e.to}`)
        .join(', ')}.`,
      requirementIds: [...new Set(dangling.map((e) => e.from))],
    })
  }

  // `sentence` is a denormalized view the mutation path re-renders from the
  // slots, so it reproduces for free — UNLESS the stored text was hand-edited
  // away from what the renderer produces, in which case the rebuilt document
  // will carry the rendered form instead. Report the divergence rather than let
  // it read as a silent rewrite.
  const divergent = orderedIds(doc).filter((id) => {
    const r = doc.requirements[id]
    return r !== undefined && renderSentence(r) !== r.sentence
  })
  if (divergent.length > 0) {
    gaps.push({
      kind: 'rendered-sentence',
      detail: `${divergent.length} requirement(s) store a \`sentence\` that differs from the one the EARS renderer produces from their own slots; the rebuilt document carries the rendered form: ${divergent.join(', ')}.`,
      requirementIds: divergent,
    })
  }

  return { ops: [...addOps, ...edgeOps], commands: reproduceCommands(doc), gaps }
}

// ---------------------------------------------------------------------------
// Suggestion rendering — the channel the CLI error envelope actually forwards
// ---------------------------------------------------------------------------

/**
 * Render a {@link ReproducePlan} as the `suggestions` array of a
 * `DocLoadError`.
 *
 * Why suggestions carry the payload: the CLI lifts a thrown core error through
 * `cli/errors.ts`'s `toErrorEnvelope`, which forwards exactly `{message, code,
 * suggestions}` onto the AC-6-2 error envelope. `suggestions` is therefore the
 * ONLY channel that reaches an agent driving `dist/cli.mjs`, so the ops travel
 * in it verbatim. Library callers additionally get the structured plan off
 * `DocLoadError.reproduce`.
 *
 * The machine contract, stated in the payload itself so it is discoverable
 * without reading this source:
 *
 *   - a suggestion starting with `{` is ONE `symspec apply` JSONL op record —
 *     concatenate them in order, one per line, to get the ops file;
 *   - a suggestion starting with `symspec ` is a shell command to run in order;
 *   - anything else is prose.
 *
 * A human reading `--pretty` gets the same list as a bulleted plan, so both
 * audiences are served by one array.
 */
export function reproduceSuggestions(
  plan: ReproducePlan,
  actualVersion: number,
  expectedVersion: number,
): string[] {
  const suggestions: string[] = [
    `This document declares schemaVersion ${actualVersion}; symspec expects ${expectedVersion}.`,
    'It does satisfy the current document schema, so every requirement, edge, glossary entry, antonym pair and waiver in it is readable — the exact ops that rebuild it at the expected schemaVersion are listed below.',
    'How to read this list: a suggestion starting with "{" is one `symspec apply` JSONL op record (keep the order, one record per line); a suggestion starting with "symspec " is a shell command to run in the order given; everything else is prose.',
    'Step 1 — create the document to rebuild into: `symspec init <file>`.',
  ]

  if (plan.ops.length === 0) {
    suggestions.push(
      'Step 2 — this document declares no reproducible requirements, so there is no op stream to apply.',
    )
  } else {
    suggestions.push(
      `Step 2 — write the following ${plan.ops.length} op record(s) to an ops file, one per line, and run \`symspec apply <ops.jsonl> --doc <file>\`. They are already in dependency order (every requirement before the edges that reference it), so the whole stream applies atomically in one run.`,
    )
    for (const op of plan.ops) suggestions.push(JSON.stringify(op))
  }

  if (plan.commands.length > 0) {
    suggestions.push(
      `Step 3 — run the following ${plan.commands.length} command(s) against the new document. The glossary, antonym and waiver tables have no \`apply\` op, so they are rebuilt through their own commands: point these at the new file with SYMSPEC_DOC=<file>, or append \`--file <file>\` to each.`,
    )
    for (const command of plan.commands) suggestions.push(command)
  }

  for (const gap of plan.gaps) {
    suggestions.push(`Not reproduced by the plan above: ${gap.detail}`)
  }

  return suggestions
}
