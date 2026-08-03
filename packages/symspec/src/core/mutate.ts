/**
 * THE MUTATION FOLD — the only code that turns a {@link DocumentOp} into a changed
 * document.
 *
 * ## One fold, not one-per-command
 *
 * The donor had two mutation paths and the split cost it real behavior. `applyChange`
 * (singular) applied one change; `applyChanges` (plural) was a left-fold with NO
 * try/catch, so the FIRST throw aborted a whole batch with no per-op result and no
 * continue-on-error. Its own lesson
 * (`batch-apply-atomic-fold-per-op-results.md`) concluded that a batch caller must
 * fold the singular form itself — which the donor's `apply.ts` then did, in a third
 * place, with its own ref-resolution and its own error mapping.
 *
 * Here there is one {@link applyOp} and one {@link foldOps}, and every surface is a
 * caller: the single-op operations (`add`, `update`, `delete`, the edge ops, the
 * side-table ops) each fold a ONE-ELEMENT stream, and `apply` folds an N-element
 * one. So a behavior is impossible to have in one surface and not the other — the
 * `--dry-run` preview, the key-minted-earlier-in-the-batch resolution, the
 * pattern-aware clear guard, and the atomic-abort semantics are all properties of
 * the fold, not of a command.
 *
 * ## THE THREE INVARIANTS
 *
 * 1. **Resolution is against the RUNNING document, never the original.** This is
 *    the donor lesson that removed the label→UUID sidecar file: an `add` op minting
 *    key `G1` at index 0 must be reference-able by `{"op":"derive","from":"G1"}` at
 *    index 5. Folding against the original would resolve `G1` to nothing.
 * 2. **The document is never mutated in place.** Each step returns a NEW document
 *    (structural copy of the touched parts only). A caller holding the pre-fold
 *    document still has it, which is what makes an atomic abort a no-op rather than
 *    a rollback.
 * 3. **Failure is a VALUE, not a throw.** {@link applyOp} returns
 *    `Ok | OpFailure`. The donor threw `ChangeError` and every caller had a
 *    try/catch that re-derived the code from `'code' in e`; a returned union makes
 *    the failure set visible in the type and exhaustive at the call site.
 *
 * ## The clock is INJECTED
 *
 * `createdAt`/`updatedAt` come from a `timestamp` argument, never `new Date()`.
 * That is not testing hygiene — it is what makes a fold REPRODUCIBLE: replaying the
 * same op stream with the same timestamp produces a byte-identical document, which
 * is the property the whole determinism claim rests on and the reason `import`
 * already worked this way.
 */

import {
  type AntonymPair,
  type GlossaryEntry,
  NULLABLE_ATTRS,
  type Relation,
  type Requirement,
  type RequirementsDocument,
  type UpdatableAttr,
  type Waiver,
} from './document.ts'
import { type DocumentOp, EDGE_OP_RELATION } from './ops.ts'
import { renderSentence } from './render.ts'
import { resolveId, resolveRef } from './resolve.ts'

// ---------------------------------------------------------------------------
// The result shapes
// ---------------------------------------------------------------------------

/**
 * One op's failure: a stable ERR_* code plus the message.
 *
 * The code is a plain string rather than the `ErrCode` union because the fold lives
 * in `core/` and the catalog lives in `kernel/` — and the dependency runs the other
 * way (the kernel knows nothing about documents). The mapping from these codes to
 * catalog classes happens at the operation boundary, where it can be exhaustive;
 * {@link FOLD_ERROR_CODES} enumerates the closed set so that mapping cannot miss
 * one.
 */
export interface OpFailure {
  readonly code: string
  readonly error: string
  /** Actionable next steps, so a per-op failure inside a batch is as useful as a
   * top-level error envelope. */
  readonly suggestions: readonly string[]
}

/**
 * The closed set of codes {@link applyOp} can produce. Enumerated so the operation
 * boundary's code→class mapping is exhaustive by test rather than by inspection.
 */
export const FOLD_ERROR_CODES = [
  'ERR_USAGE',
  'ERR_NOT_FOUND',
  'ERR_DUPLICATE_ID',
  'ERR_DUPLICATE_KEY',
  'ERR_NULL_REQUIRED',
] as const

/** One op's success: the new document plus what the op touched. */
export interface OpSuccess {
  readonly document: RequirementsDocument
  /** The requirement UUID the op created or targeted, when it had one. Absent for
   * the side-table ops, which touch no requirement. */
  readonly id?: string
  /** True when the op was a no-op (an idempotent re-apply). Reported rather than
   * hidden so a repair round-trip can tell "already done" from "just done". */
  readonly noop: boolean
}

/**
 * Narrow ANY `T | OpFailure` to its failure branch.
 *
 * Generic in `T` because the fold's internal helpers return their own success
 * shapes alongside the shared failure — {@link requireTarget} yields a
 * `Requirement`, {@link applyOp} yields an {@link OpSuccess} — and one guard for all
 * of them keeps the failure branch a single spelling.
 *
 * `'code' in result` is the discriminant, and it is safe for a reason worth stating
 * rather than assuming: no success shape reachable here carries a `code` field.
 * `Requirement` has none, `OpSuccess` has none. `mutate.test.ts` pins that, so a
 * future field named `code` on either shape is a test failure rather than a silent
 * reclassification of every success as an error.
 */
export const isOpFailure = <T extends object>(result: T | OpFailure): result is OpFailure =>
  'code' in result

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fail = (code: string, error: string, suggestions: readonly string[]): OpFailure => ({
  code,
  error,
  suggestions,
})

/** A UUID for a new requirement. `crypto.randomUUID` rather than a derived hash:
 * `add` is authoring NEW content, so there is nothing to derive an id from, and a
 * random id is correct precisely because two identical `add` ops SHOULD produce two
 * requirements. (`import` derives ids instead, because a replay must be
 * reproducible — a different question, answered differently, in that module.) */
const newId = (): string => globalThis.crypto.randomUUID()

/**
 * Whether clearing `attr` would strip a slot the requirement's OWN pattern needs.
 * Returns the reason when the clear must be refused.
 *
 * The donor's MN6 guard, carried verbatim in substance. `NULLABLE_ATTRS` answers
 * "may this field be absent in the schema"; this answers "may it be absent on THIS
 * requirement" — and the second is stricter. Without it, clearing `trigger` on an
 * event-driven requirement re-renders `"When , the auth service shall …"`, which is
 * a malformed sentence the lint tier then reports as the author's fault.
 */
const patternRequiresSlot = (
  pattern: Requirement['patternType'],
  attr: UpdatableAttr,
): string | undefined => {
  if (attr === 'trigger' && (pattern === 'event-driven' || pattern === 'unwanted-behavior')) {
    return `an ${pattern} requirement's trigger`
  }
  if (attr === 'preCondition' && (pattern === 'state-driven' || pattern === 'optional-feature')) {
    return `a ${pattern} requirement's pre-condition`
  }
  return undefined
}

/**
 * Resolve a ref through the single chokepoint, as an op result.
 *
 * Returns the REQUIREMENT, not just its id, and both halves of that matter. The id
 * is what a write must persist (a key would fail the document schema's UUID check);
 * the requirement is what the caller then reads — its `patternType` for the clear
 * guard, its edge arrays for an idempotence check. Returning only the id would make
 * every caller re-index the map and then guard the `undefined` that
 * `noUncheckedIndexedAccess` correctly insists on, for a lookup that provably
 * succeeded one line earlier.
 */
const requireTarget = (
  document: RequirementsDocument,
  ref: string | undefined,
  field: string,
  verb: string,
): Requirement | OpFailure => {
  if (ref === undefined) {
    return fail('ERR_USAGE', `The \`${verb}\` op requires "${field}".`, [
      `Add a "${field}" field naming a requirement by its stable key or its UUID.`,
    ])
  }
  const found = resolveRef(document, ref)
  if (found === undefined) {
    return fail(
      'ERR_NOT_FOUND',
      `No requirement matches "${ref}" (tried it as a UUID, then as a stable key).`,
      ['Run `symspec list` to see every requirement with its key and UUID.'],
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

const applyAdd = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'add' }>,
  timestamp: string,
): OpSuccess | OpFailure => {
  const id = op.id ?? newId()

  if (document.requirements[id] !== undefined) {
    return fail('ERR_DUPLICATE_ID', `Requirement ${id} already exists.`, [
      'Use an `update` op to modify the existing requirement.',
      'Or omit "id" so a fresh UUID is minted.',
    ])
  }
  // A key must resolve to exactly ONE requirement, or key-addressing stops being as
  // safe as UUID-addressing — so a reused key is refused BEFORE anything is written.
  if (op.key !== undefined && resolveRef(document, op.key) !== undefined) {
    return fail('ERR_DUPLICATE_KEY', `Key "${op.key}" is already used by another requirement.`, [
      'Choose a different key.',
      'Or omit "key" to create the requirement without a stable key.',
    ])
  }

  const negated = op.negated ?? false
  const requirement: Requirement = {
    id,
    ...(op.key !== undefined ? { key: op.key } : {}),
    patternType: op.patternType,
    ...(op.preCondition !== undefined ? { preCondition: op.preCondition } : {}),
    ...(op.trigger !== undefined ? { trigger: op.trigger } : {}),
    systemName: op.systemName,
    systemResponse: op.systemResponse,
    negated,
    ...(op.responseKind !== undefined ? { responseKind: op.responseKind } : {}),
    // RE-RENDERED, never carried on the op — see the note in `./ops.ts`.
    sentence: renderSentence({
      patternType: op.patternType,
      preCondition: op.preCondition,
      trigger: op.trigger,
      systemName: op.systemName,
      systemResponse: op.systemResponse,
      negated,
    }),
    priority: op.priority ?? 'medium',
    status: op.status ?? 'draft',
    ...(op.verificationMethod !== undefined ? { verificationMethod: op.verificationMethod } : {}),
    ...(op.verificationNote !== undefined ? { verificationNote: op.verificationNote } : {}),
    // Edges are NOT part of `add`, deliberately: they arrive as their own ops, so
    // the op set stays orthogonal and every edge is individually idempotent.
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  return {
    document: { ...document, requirements: { ...document.requirements, [id]: requirement } },
    id,
    noop: false,
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/** The five EARS structural slots whose edit re-renders `sentence`. A pure metadata
 * edit (priority/status/verification*) must NOT re-render, which is the donor's
 * "five-way re-render gate". */
const EARS_SLOTS: ReadonlySet<UpdatableAttr> = new Set([
  'patternType',
  'preCondition',
  'trigger',
  'systemName',
  'systemResponse',
])

const applyUpdate = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'update' }>,
  timestamp: string,
): OpSuccess | OpFailure => {
  const target = requireTarget(document, op.ref, 'ref', 'update')
  if (isOpFailure(target)) return target

  if (op.value === null) {
    if (!NULLABLE_ATTRS.has(op.attr)) {
      return fail(
        'ERR_NULL_REQUIRED',
        `Cannot clear the required attribute "${op.attr}" on ${target.id}.`,
        [
          'Provide a value instead of null.',
          `Clearable attributes: ${[...NULLABLE_ATTRS].sort().join(', ')}.`,
        ],
      )
    }
    // The pattern-aware half — stricter than schema nullability. See
    // `patternRequiresSlot`.
    const required = patternRequiresSlot(target.patternType, op.attr)
    if (required !== undefined) {
      return fail(
        'ERR_NULL_REQUIRED',
        `Cannot clear ${op.attr} on a ${target.patternType} requirement — the pattern requires it.`,
        [
          `Set a new ${op.attr} value instead of clearing it.`,
          `Or change patternType first, if ${required} no longer applies.`,
        ],
      )
    }
  }

  // Build the next requirement by KEY, so a clear is a genuinely absent key rather
  // than an `undefined` value — the exactOptionalPropertyTypes discipline reaching
  // the persisted file, which is what keeps a save byte-stable.
  const next: Record<string, unknown> = { ...target }
  if (op.value === null) delete next[op.attr]
  else next[op.attr] = op.value

  const updated = next as unknown as Requirement
  const rendered = EARS_SLOTS.has(op.attr)
    ? { ...updated, sentence: renderSentence(updated), updatedAt: timestamp }
    : { ...updated, updatedAt: timestamp }

  return {
    document: {
      ...document,
      requirements: { ...document.requirements, [target.id]: rendered },
    },
    id: target.id,
    noop: false,
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

const applyDelete = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'delete' }>,
): OpSuccess | OpFailure => {
  // `ref` wins over `id`; both are key-or-UUID. Donor parity — a stream written
  // against the donor's `apply` used either spelling.
  const target = requireTarget(document, op.ref ?? op.id, 'ref (or id)', 'delete')
  if (isOpFailure(target)) return target

  const requirements = { ...document.requirements }
  delete requirements[target.id]
  // Inbound edges from other requirements become DANGLING rather than being
  // cascaded away, matching the donor: `check` surfaces a dangling reference as a
  // finding, and silently rewriting other requirements' edges would be a mutation
  // the caller did not ask for.
  return { document: { ...document, requirements }, id: target.id, noop: false }
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

const applyEdge = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: keyof typeof EDGE_OP_RELATION }>,
  timestamp: string,
): OpSuccess | OpFailure => {
  const source = requireTarget(document, op.from, 'from', op.op)
  if (isOpFailure(source)) return source
  const to = requireTarget(document, op.to, 'to', op.op)
  if (isOpFailure(to)) return to

  const relation: Relation = EDGE_OP_RELATION[op.op]

  // IDEMPOTENT: an existing edge is a no-op success, so replaying a repair plan
  // never duplicates one.
  if (source[relation].includes(to.id)) {
    return { document, id: source.id, noop: true }
  }

  return {
    document: {
      ...document,
      requirements: {
        ...document.requirements,
        [source.id]: {
          ...source,
          [relation]: [...source[relation], to.id],
          updatedAt: timestamp,
        },
      },
    },
    id: source.id,
    noop: false,
  }
}

const applyRemoveEdge = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'remove-edge' }>,
  timestamp: string,
): OpSuccess | OpFailure => {
  const source = requireTarget(document, op.from, 'from', 'remove-edge')
  if (isOpFailure(source)) return source
  const to = requireTarget(document, op.to, 'to', 'remove-edge')
  if (isOpFailure(to)) return to

  // Removing an absent edge is a no-op success (donor AC-1-7: "safe to call
  // defensively").
  if (!source[op.relation].includes(to.id)) {
    return { document, id: source.id, noop: true }
  }

  return {
    document: {
      ...document,
      requirements: {
        ...document.requirements,
        [source.id]: {
          ...source,
          [op.relation]: source[op.relation].filter((t) => t !== to.id),
          updatedAt: timestamp,
        },
      },
    },
    id: source.id,
    noop: false,
  }
}

// ---------------------------------------------------------------------------
// The side tables
// ---------------------------------------------------------------------------

const applyGlossary = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'glossary' }>,
): OpSuccess | OpFailure => {
  const canonical = op.canonical.trim()
  const alias = op.alias.trim()
  if (canonical.length === 0 || alias.length === 0) {
    return fail('ERR_USAGE', 'A `glossary` op requires a non-empty canonical and alias.', [
      'Both fields name a RESPONSE phrasing, e.g. canonical "issue a session token", alias "issue a login credential".',
    ])
  }

  const entry = document.glossary.find((e) => e.canonical === canonical)
  // IDEMPOTENT: this exact alias already sits under this canonical.
  if (entry?.aliases.includes(alias) === true) {
    return { document, noop: true }
  }
  const glossary: GlossaryEntry[] =
    entry === undefined
      ? [...document.glossary, { canonical, aliases: [alias] }]
      : document.glossary.map((e) =>
          e.canonical === canonical ? { canonical, aliases: [...e.aliases, alias] } : e,
        )
  return { document: { ...document, glossary }, noop: false }
}

const applyUnglossary = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unglossary' }>,
): OpSuccess | OpFailure => {
  const canonical = op.canonical.trim()
  const alias = op.alias.trim()
  const entry = document.glossary.find((e) => e.canonical === canonical)
  if (entry === undefined || !entry.aliases.includes(alias)) {
    return { document, noop: true }
  }
  // An emptied group is DROPPED entirely — a canonical with no aliases unifies
  // nothing, so keeping it would be a row that looks like a decision and is not.
  const glossary = document.glossary
    .map((e) =>
      e.canonical === canonical ? { canonical, aliases: e.aliases.filter((a) => a !== alias) } : e,
    )
    .filter((e) => e.aliases.length > 0)
  return { document: { ...document, glossary }, noop: false }
}

/** Canonical, order-independent key for an antonym pair. */
const pairKey = (a: string, b: string): string => [a, b].sort().join(' ')

/**
 * The antonym-consistency validator, injected.
 *
 * `core/` must not import the transplanted formal tier — the dependency runs the
 * other way (`../formal/compat.ts` reads `core/`, never the reverse), and a cycle
 * would put the atomizer in the load graph of every document read. So the caller
 * supplies the check, and `../operations/mutation.ts` wires the real
 * `buildAntonymIndexWithDoc`.
 *
 * The check is not optional bookkeeping: an antonym pair is the ONE committed
 * record whose wrong value MANUFACTURES a false contradiction. An odd polarity
 * cycle (asserting a↔b when a and b already resolve to the same polarity through
 * the seed table) makes the index builder throw — and it must throw HERE, at write
 * time with a usage error, so the check path stays throw-free.
 */
export interface MutateOptions {
  /**
   * Validate a candidate antonym table. Return an error MESSAGE to refuse the
   * write, or `undefined` to accept. Omitted ⇒ no validation, which is correct for
   * a caller with no formal tier available (and unsound for the CLI, which is why
   * the operation layer always supplies it).
   */
  readonly validateAntonyms?: (pairs: readonly AntonymPair[]) => string | undefined
  /** Normalize a response verb-head to the atomizer's key. Omitted ⇒ a trim, which
   * stores the head as written. The operation layer supplies the real `normalize`
   * so a committed pair matches what the atomizer looks up. */
  readonly normalizeHead?: (text: string) => string
}

const applyAntonym = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'antonym' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const a = norm(op.a)
  const b = norm(op.b)
  if (a.length === 0 || b.length === 0) {
    return fail('ERR_USAGE', 'An `antonym` op requires two non-empty response verb-heads.', [
      'Each is the LEADING VERB of a response, e.g. a "open", b "shut".',
    ])
  }
  if (a === b) {
    return fail('ERR_USAGE', `"${a}" cannot be its own antonym.`, [
      'Supply two DIFFERENT verb-heads; a verb is not its own opposite.',
    ])
  }

  const key = pairKey(a, b)
  if (document.antonyms.some((p) => pairKey(norm(p.a), norm(p.b)) === key)) {
    return { document, noop: true }
  }

  const candidate: AntonymPair[] = [...document.antonyms, { a, b }]
  const inconsistent = options.validateAntonyms?.(candidate)
  if (inconsistent !== undefined) {
    return fail(
      'ERR_USAGE',
      `The antonym pair "${a}"/"${b}" is inconsistent with the committed antonyms: ${inconsistent}`,
      [
        'The signed antonym classes must stay consistent — this pair would create an odd polarity cycle.',
        'Inspect the committed pairs and the seed table before re-asserting this one.',
      ],
    )
  }

  return { document: { ...document, antonyms: candidate }, noop: false }
}

const applyUnantonym = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unantonym' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const key = pairKey(norm(op.a), norm(op.b))
  const antonyms = document.antonyms.filter((p) => pairKey(norm(p.a), norm(p.b)) !== key)
  if (antonyms.length === document.antonyms.length) return { document, noop: true }
  return { document: { ...document, antonyms }, noop: false }
}

/** Two waivers match iff they suppress the same code at the same scope. */
const sameWaiver = (a: Waiver, b: Waiver): boolean =>
  a.code === b.code && a.requirementId === b.requirementId

const applyWaive = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'waive' }>,
): OpSuccess | OpFailure => {
  const code = op.code.trim()
  const reason = op.reason.trim()
  if (code.length === 0 || reason.length === 0) {
    return fail('ERR_USAGE', 'A `waive` op requires a non-empty code and reason.', [
      'The reason is the audit trail that distinguishes a reviewed waiver from neglect — write the actual justification.',
    ])
  }

  // An optional scope is resolved to the stable UUID before storing, so a waiver
  // keeps biting the right requirement regardless of any human-facing relabeling.
  let requirementId: string | undefined
  if (op.ref !== undefined) {
    const scoped = requireTarget(document, op.ref, 'ref', 'waive')
    if (isOpFailure(scoped)) return scoped
    requirementId = scoped.id
  }

  const waiver: Waiver =
    requirementId !== undefined ? { code, requirementId, reason } : { code, reason }
  // IDEMPOTENT, and the STORED reason wins: the first review is authoritative, so
  // re-waiving with different prose does not quietly overwrite the original
  // justification.
  if (document.waivers.some((w) => sameWaiver(w, waiver))) {
    return { document, noop: true }
  }
  return { document: { ...document, waivers: [...document.waivers, waiver] }, noop: false }
}

const applyUnwaive = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unwaive' }>,
): OpSuccess | OpFailure => {
  const code = op.code.trim()
  // A ref that resolves to nothing simply matches nothing — there can be no waiver
  // scoped to a requirement that does not exist — so this is a no-op rather than an
  // error, symmetric with removing an absent edge.
  const requirementId = op.ref !== undefined ? resolveId(document, op.ref) : undefined
  const target: Waiver =
    requirementId !== undefined ? { code, requirementId, reason: '' } : { code, reason: '' }
  const waivers = document.waivers.filter((w) => !sameWaiver(w, target))
  if (waivers.length === document.waivers.length) return { document, noop: true }
  return { document: { ...document, waivers }, noop: false }
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply ONE op to a document, returning the new document or a typed failure.
 *
 * Exhaustive over {@link DocumentOp} by construction: every arm returns and the
 * return type admits no `undefined`, so adding a verb to the union without handling
 * it here is a compile error rather than a silently ignored op.
 */
export const applyOp = (
  document: RequirementsDocument,
  op: DocumentOp,
  timestamp: string,
  options: MutateOptions = {},
): OpSuccess | OpFailure => {
  switch (op.op) {
    case 'add':
      return applyAdd(document, op, timestamp)
    case 'update':
      return applyUpdate(document, op, timestamp)
    case 'delete':
      return applyDelete(document, op)
    case 'derive':
    case 'satisfy':
    case 'verify':
    case 'refine':
      return applyEdge(document, op, timestamp)
    case 'remove-edge':
      return applyRemoveEdge(document, op, timestamp)
    case 'glossary':
      return applyGlossary(document, op)
    case 'unglossary':
      return applyUnglossary(document, op)
    case 'antonym':
      return applyAntonym(document, op, options)
    case 'unantonym':
      return applyUnantonym(document, op, options)
    case 'waive':
      return applyWaive(document, op)
    case 'unwaive':
      return applyUnwaive(document, op)
  }
}

// ---------------------------------------------------------------------------
// The batch fold
// ---------------------------------------------------------------------------

/** One op's entry in a fold's result array. */
export interface FoldEntry {
  /** 0-based index among the ops the fold was given. */
  readonly index: number
  readonly op: string
  readonly ok: boolean
  /** The requirement UUID the op created or targeted, when it had one. */
  readonly id?: string
  /** True when the op was an idempotent no-op. */
  readonly noop?: boolean
  readonly code?: string
  readonly error?: string
  readonly suggestions?: readonly string[]
}

/** What a fold produced. `document` is the folded result; in ATOMIC mode with any
 * failure it is the UNCHANGED input, which is what makes an abort a no-op. */
export interface FoldResult {
  readonly document: RequirementsDocument
  readonly results: readonly FoldEntry[]
  readonly summary: {
    readonly total: number
    readonly ok: number
    readonly failed: number
    readonly noop: number
  }
  /** True when the caller should PERSIST `document`. False on an atomic abort and
   * on a run where nothing actually changed. */
  readonly write: boolean
  /** The 0-based index of the op that aborted an atomic fold. Absent otherwise. */
  readonly abortedAt?: number
}

/**
 * Fold a stream of ops over a document.
 *
 * ATOMIC by default (`continueOnError: false`): every op is applied in memory, and
 * the result is only marked writable when ALL of them succeeded. Any failure
 * returns the ORIGINAL document with `write: false` and `abortedAt` set — so a
 * crashed batch leaves the file untouched and the resume story is "fix that line
 * and re-run", not "work out how far it got".
 *
 * `continueOnError: true` applies what succeeds and still marks the result
 * writable, with a per-op results array. That is the mode a repair plan wants: an
 * op that is already applied (a no-op) or that names a requirement someone deleted
 * should not block the eight repairs that do apply.
 *
 * `write` is false when nothing CHANGED even if everything succeeded — an
 * all-no-op fold has nothing to persist, and skipping the save keeps a
 * re-run from touching the file's mtime.
 */
export const foldOps = (
  document: RequirementsDocument,
  ops: readonly DocumentOp[],
  timestamp: string,
  options: MutateOptions & { readonly continueOnError?: boolean } = {},
): FoldResult => {
  const continueOnError = options.continueOnError === true
  const results: FoldEntry[] = []
  let current = document
  let changed = false
  let failed = 0
  let noops = 0

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    if (op === undefined) continue
    // Applied against `current`, NEVER against `document` — invariant 1.
    const result = applyOp(current, op, timestamp, options)

    if (isOpFailure(result)) {
      failed += 1
      results.push({
        index,
        op: op.op,
        ok: false,
        code: result.code,
        error: result.error,
        suggestions: result.suggestions,
      })
      if (!continueOnError) {
        return {
          // The ORIGINAL — an atomic abort writes nothing.
          document,
          results,
          summary: { total: ops.length, ok: index, failed: 1, noop: noops },
          write: false,
          abortedAt: index,
        }
      }
      continue
    }

    current = result.document
    if (result.noop) noops += 1
    else changed = true
    results.push({
      index,
      op: op.op,
      ok: true,
      ...(result.id !== undefined ? { id: result.id } : {}),
      ...(result.noop ? { noop: true } : {}),
    })
  }

  return {
    document: current,
    results,
    summary: {
      total: ops.length,
      ok: results.filter((r) => r.ok).length,
      failed,
      noop: noops,
    },
    write: changed,
  }
}
