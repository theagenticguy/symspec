/**
 * THE MUTATION FOLD — the only code that turns a {@link DocumentOp} into a changed
 * document.
 *
 * ## One fold, not one-per-command
 *
 * v4 had two mutation paths and the split cost it real behavior. `applyChange`
 * (singular) applied one change; `applyChanges` (plural) was a left-fold with NO
 * try/catch, so the FIRST throw aborted a whole batch with no per-op result and no
 * continue-on-error. Its own lesson
 * (`batch-apply-atomic-fold-per-op-results.md`) concluded that a batch caller must
 * fold the singular form itself — which v4's `apply.ts` then did, in a third
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
 *    v4 lesson that removed the label→UUID sidecar file: an `add` op minting
 *    key `G1` at index 0 must be reference-able by `{"op":"derive","from":"G1"}` at
 *    index 5. Folding against the original would resolve `G1` to nothing.
 * 2. **The document is never mutated in place.** Each step returns a NEW document
 *    (structural copy of the touched parts only). A caller holding the pre-fold
 *    document still has it, which is what makes an atomic abort a no-op rather than
 *    a rollback.
 * 3. **Failure is a VALUE, not a throw.** {@link applyOp} returns
 *    `Ok | OpFailure`. v4 threw `ChangeError` and every caller had a
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
  type StateModel,
  type StateVariable,
  type TermEntry,
  type UpdatableAttr,
  type Waiver,
} from './document.ts'
import { type DocumentOp, EDGE_OP_RELATION } from './ops.ts'
import { renderSentence } from './render.ts'
import { resolveId, resolveRef } from './resolve.ts'
import {
  cheapInitialContradiction,
  isExprError,
  referencedNames,
  validateEffect,
  validateExpression,
} from './state-expr.ts'

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

/**
 * `ERR_USAGE` shorthand, for the many state-model failures that are all one code.
 *
 * Every G4 authoring refusal is a USAGE error — the op as given cannot be applied —
 * and none of them is a distinct catalog code. Spelling `fail('ERR_USAGE', …)` at
 * seventeen sites invites a typo'd code string that `toCatalogError` would then
 * silently default to `ERR_USAGE` anyway, so the code is named once here instead. The
 * codes that ARE distinct (`ERR_NOT_FOUND`, `ERR_DUPLICATE_KEY`, …) still go through
 * {@link fail} explicitly, so the choice of a non-usage code stays visible at its
 * call site.
 */
const usage = (error: string, suggestions: readonly string[]): OpFailure =>
  fail('ERR_USAGE', error, suggestions)

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
 * v4's MN6 guard, carried verbatim in substance. `NULLABLE_ATTRS` answers
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
 * edit (priority/status/verification*) must NOT re-render, which is v4's
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

  // THE SECOND DOOR onto the V14/V21 hazard, closed with the same check.
  //
  // `stateEffect`/`stateConstraint` are in `UPDATABLE_ATTRS` (a state model is
  // authored iteratively, so editing one expression without restating the label has
  // to work), which means `update` can write an expression WITHOUT going through
  // `classify`. If it did so unvalidated, `symspec update stateConstraint "typo_var =
  // 1"` would put an undeclared reference straight into the document — and the failure
  // that produces is a solver hang, not a message. So the same validator runs here.
  //
  // Validated against the requirement's OWN kind rather than the attr alone: writing
  // a `stateEffect` onto a requirement classified `constraint` would store an
  // expression the encoder never reads, so the mismatch is refused too.
  if (op.value !== null && (op.attr === 'stateEffect' || op.attr === 'stateConstraint')) {
    const wanted = op.attr === 'stateEffect' ? 'effect' : 'constraint'
    if (target.responseKind !== undefined && target.responseKind !== wanted) {
      return usage(
        `${target.key ?? target.id} is classified ${target.responseKind}, so setting \`${op.attr}\` would store an expression nothing reads.`,
        [
          `Reclassify and set the expression in one step: \`symspec classify ${target.key ?? target.id} --kind ${wanted} --expression "${op.value}"\`.`,
        ],
      )
    }
    const checked =
      wanted === 'effect'
        ? validateEffect(op.value, document.stateModel)
        : validateExpression(op.value, document.stateModel, 'constraint')
    if (isExprError(checked)) {
      return usage(
        `The ${wanted} "${op.value}" on ${target.key ?? target.id} is not valid: ${checked.error}`,
        [...checked.suggestions],
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
  // against v4's `apply` used either spelling.
  const target = requireTarget(document, op.ref ?? op.id, 'ref (or id)', 'delete')
  if (isOpFailure(target)) return target

  const requirements = { ...document.requirements }
  delete requirements[target.id]
  // Inbound edges from other requirements become DANGLING rather than being
  // cascaded away, matching v4: `check` surfaces a dangling reference as a
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

  // Removing an absent edge is a no-op success (v4 AC-1-7: "safe to call
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

/**
 * Commit one synonym alias — refusing the two shapes that resolve by table ORDER.
 *
 * `glossaryIndex` (the atomizer's reader) is a flat `normalize(alias) -> normalize(canonical)`
 * map built by iterating the groups, so a phrase appearing twice is silently last-write-wins,
 * and lookup is ONE HOP, so a canonical that is itself an alias never resolves. Neither shape
 * errors anywhere downstream; both just quietly do something other than what the author asked
 * for. So both are refused HERE, at write time, which is the same discipline
 * {@link MutateOptions.validateAntonyms} applies for the same reason — the check path stays
 * free of "this table was incoherent" branches.
 *
 * Matching is done in NORMALIZED space because that is the space the index keys. Exact-string
 * matching let `"Issue a token"` and `"issue a token"` become two groups that
 * `glossaryIndex` then collapses onto one key, which is the same defect arriving by a
 * different door. The stored spelling of an existing canonical is preserved rather than
 * rewritten: an author's capitalization is theirs, and rewriting it would make committing an
 * alias silently edit a row the author did not name.
 */
const applyGlossary = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'glossary' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const canonical = op.canonical.trim()
  const alias = op.alias.trim()
  if (canonical.length === 0 || alias.length === 0) {
    return fail('ERR_USAGE', 'A `glossary` op requires a non-empty canonical and alias.', [
      'Both fields name a RESPONSE phrasing, e.g. canonical "issue a session token", alias "issue a login credential".',
    ])
  }
  const canonicalKey = norm(canonical)
  const aliasKey = norm(alias)
  if (canonicalKey === aliasKey) {
    return fail('ERR_USAGE', `"${canonical}" cannot be an alias of itself.`, [
      'A glossary entry unifies two DIFFERENT phrasings; these normalize to the same key.',
    ])
  }

  const entry = document.glossary.find((e) => norm(e.canonical) === canonicalKey)
  // IDEMPOTENT: this alias already sits under this canonical.
  if (entry?.aliases.some((a) => norm(a) === aliasKey) === true) {
    return { document, noop: true }
  }

  // The alias already belongs to a DIFFERENT group. Accepting would put one key in two
  // groups, and the winner would be whichever group `glossaryIndex` visits last.
  const otherOwner = document.glossary.find(
    (e) => norm(e.canonical) !== canonicalKey && e.aliases.some((a) => norm(a) === aliasKey),
  )
  if (otherOwner !== undefined) {
    return fail(
      'ERR_USAGE',
      `"${alias}" is already an alias of "${otherOwner.canonical}", so it cannot also be an alias of "${canonical}".`,
      [
        `Free it first: \`symspec glossary "${otherOwner.canonical}" "${alias}" --remove\`.`,
        `Or point this entry at "${otherOwner.canonical}" instead, if that is the reading you meant.`,
      ],
    )
  }

  // The canonical is itself an alias. Alias resolution is ONE HOP, so the chain would never
  // resolve and the merge would silently not happen.
  const canonicalIsAlias = document.glossary.find(
    (e) => norm(e.canonical) !== canonicalKey && e.aliases.some((a) => norm(a) === canonicalKey),
  )
  if (canonicalIsAlias !== undefined) {
    return fail(
      'ERR_USAGE',
      `"${canonical}" is already an alias of "${canonicalIsAlias.canonical}", so it cannot also be a canonical.`,
      [
        'Alias resolution is one hop, so this chain would never resolve.',
        `Use "${canonicalIsAlias.canonical}" as the canonical: \`symspec glossary "${canonicalIsAlias.canonical}" "${alias}"\`.`,
      ],
    )
  }

  const glossary: GlossaryEntry[] =
    entry === undefined
      ? [...document.glossary, { canonical, aliases: [alias] }]
      : document.glossary.map((e) =>
          // The EXISTING canonical spelling is kept, not `canonical`.
          norm(e.canonical) === canonicalKey
            ? { canonical: e.canonical, aliases: [...e.aliases, alias] }
            : e,
        )
  return { document: { ...document, glossary }, noop: false }
}

/**
 * Remove one alias. Matched in NORMALIZED space, symmetrically with {@link applyGlossary}.
 *
 * The symmetry is load-bearing rather than tidy: an entry committed as `"Issue a token"` must
 * be removable by naming `"issue a token"`, or the refusal `applyGlossary` now raises would
 * point at an `--remove` that no-ops, leaving an author stuck with a row they cannot free.
 */
const applyUnglossary = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unglossary' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const canonicalKey = norm(op.canonical.trim())
  const aliasKey = norm(op.alias.trim())
  const entry = document.glossary.find((e) => norm(e.canonical) === canonicalKey)
  if (entry === undefined || !entry.aliases.some((a) => norm(a) === aliasKey)) {
    return { document, noop: true }
  }
  // An emptied group is DROPPED entirely — a canonical with no aliases unifies
  // nothing, so keeping it would be a row that looks like a decision and is not.
  const glossary = document.glossary
    .map((e) =>
      norm(e.canonical) === canonicalKey
        ? { canonical: e.canonical, aliases: e.aliases.filter((a) => norm(a) !== aliasKey) }
        : e,
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
  /**
   * Normalize a phrase to the atomizer's key — a verb head for `antonym`, a whole response
   * phrasing for `glossary`. It is the same `normalize` in both cases, because
   * `glossaryIndex` and the antonym index key the same way.
   *
   * Omitted ⇒ a trim, which stores the text as written and makes the glossary's
   * collision checks case-sensitive. The operation layer supplies the real `normalize`, so a
   * committed record matches what the atomizer looks up.
   */
  readonly normalizeHead?: (text: string) => string
  /**
   * Validate a candidate TERM. Return an error MESSAGE to refuse the write, or `undefined` to
   * accept. Both arguments arrive already normalized.
   *
   * Injected for the same reason as {@link validateAntonyms}: the check needs the engine's
   * antonym index and the guard-implication tier's establish-verb lexicon, and
   * `domain/requirements` must not import the engine. Omitted ⇒ no validation, which is correct
   * for a caller with no engine available and unsound for the CLI — so the operation layer
   * always supplies it.
   *
   * What it refuses, and why it must: a term containing a verb that either lexicon reads moves
   * the polarity `atomize` computes for a state-establishing response while leaving the
   * raw-text parse that RECOGNISES the bridge unchanged. The two disagreeing lets a committed
   * term prove a contradiction the document does not contain — an error-severity fabrication,
   * which is the one outcome the propose/decide split exists to prevent.
   */
  readonly validateTerms?: (canonical: string, alias: string) => string | undefined
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

/**
 * Commit one noun-phrase term — with the refusal that keeps the feature sound.
 *
 * Mirrors {@link applyGlossary}'s four checks, for the same reasons, in the same normalized
 * space. Two things are different, and both come from the substitution being applied INSIDE a
 * body rather than replacing one.
 *
 * **One-hop in TOKEN space (the `canonical contains an alias` refusal).** `atomize` substitutes
 * in a single pass and continues after the tokens it wrote, so a canonical containing a
 * committed alias is NOT rewritten a second time. Accepting such an entry would therefore mean
 * the table's effect depends on whether the reader expects a second pass. Refusing it is the
 * token-space analogue of `applyGlossary`'s one-hop rule, and it keeps the decide key
 * unambiguous.
 *
 * **The verb refusal, delegated to {@link MutateOptions.validateTerms}.** A term that rewrites
 * a response VERB desyncs two pipelines that must agree: `guard-implication` decides whether a
 * response establishes a state by parsing the RAW text, while the bridge's polarity comes from
 * the full `atomize` — which sees the substitution. Rewrite a head into an antonym class and
 * the bridge is still recognised while its polarity flips, so it asserts the negation of what
 * the document says and can prove a contradiction that is not there. Error severity, tool's own
 * doing. So terms are for NOUNS, and that is enforced here rather than documented; the check
 * lives behind the same injection seam as `validateAntonyms` because `domain/requirements` must
 * not import the engine tier.
 */
const applyTerm = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'term' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const canonical = op.canonical.trim()
  const alias = op.alias.trim()
  if (canonical.length === 0 || alias.length === 0) {
    return fail('ERR_USAGE', 'A `term` op requires a non-empty canonical and alias.', [
      'Both fields name a NOUN PHRASE, e.g. canonical "session token", alias "login credential".',
    ])
  }
  const canonicalKey = norm(canonical)
  const aliasKey = norm(alias)
  if (canonicalKey === aliasKey) {
    return fail('ERR_USAGE', `"${canonical}" cannot be a term alias of itself.`, [
      'A term entry unifies two DIFFERENT noun phrases; these normalize to the same key.',
    ])
  }

  const rejected = options.validateTerms?.(canonicalKey, aliasKey)
  if (rejected !== undefined) {
    return fail(
      'ERR_USAGE',
      `The term "${canonical}" / "${alias}" is not committable: ${rejected}`,
      [
        'A term is substituted inside EVERY slot body, so a verb in one moves the polarity the',
        'solver computes while leaving the raw-text bridge parse unchanged — which can prove a',
        'conflict the document does not contain.',
        'Use `symspec glossary` to align a whole phrasing that contains a verb.',
      ],
    )
  }

  const entry = document.terms.find((e) => norm(e.canonical) === canonicalKey)
  // IDEMPOTENT: this alias already sits under this canonical.
  if (entry?.aliases.some((a) => norm(a) === aliasKey) === true) {
    return { document, noop: true }
  }

  const otherOwner = document.terms.find(
    (e) => norm(e.canonical) !== canonicalKey && e.aliases.some((a) => norm(a) === aliasKey),
  )
  if (otherOwner !== undefined) {
    return fail(
      'ERR_USAGE',
      `"${alias}" is already a term alias of "${otherOwner.canonical}", so it cannot also be an alias of "${canonical}".`,
      [
        `Free it first: \`symspec term "${otherOwner.canonical}" "${alias}" --remove\`.`,
        `Or point this entry at "${otherOwner.canonical}" instead, if that is the reading you meant.`,
      ],
    )
  }

  const canonicalIsAlias = document.terms.find(
    (e) => norm(e.canonical) !== canonicalKey && e.aliases.some((a) => norm(a) === canonicalKey),
  )
  if (canonicalIsAlias !== undefined) {
    return fail(
      'ERR_USAGE',
      `"${canonical}" is already a term alias of "${canonicalIsAlias.canonical}", so it cannot also be a canonical.`,
      [
        'Term substitution is one pass, so this chain would never resolve.',
        `Use "${canonicalIsAlias.canonical}" as the canonical: \`symspec term "${canonicalIsAlias.canonical}" "${alias}"\`.`,
      ],
    )
  }

  // One-hop in TOKEN space: the substitution never re-reads what it wrote, so a canonical
  // containing a committed alias would leave the table's meaning ambiguous.
  // Split on EITHER separator. `normalizeHead` is the atomizer's `normalize` in production
  // (underscore-joined), and a bare trim in a caller that has no engine — so a check that split
  // only on `_` would be silently inert for the second, which is the shape a test would then
  // fail to reach.
  const tokensOf = (key: string) => key.split(/[\s_]+/).filter((t) => t.length > 0)
  const canonicalTokens = tokensOf(canonicalKey)
  const contains = (haystack: readonly string[], needle: readonly string[]): boolean => {
    if (needle.length === 0 || needle.length > haystack.length) return false
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      if (needle.every((t, k) => haystack[i + k] === t)) return true
    }
    return false
  }
  const committedAliases = [
    ...document.terms.flatMap((e) => e.aliases.map((a) => norm(a))),
    aliasKey,
  ]
  const swallowed = committedAliases.find(
    (a) =>
      a !== canonicalKey &&
      contains(
        canonicalTokens,
        a.split('_').filter((t) => t.length > 0),
      ),
  )
  if (swallowed !== undefined) {
    return fail(
      'ERR_USAGE',
      `The canonical "${canonical}" contains the committed term alias "${swallowed.replace(/_/g, ' ')}", so the table would be ambiguous.`,
      [
        'Term substitution is a single pass that continues after the tokens it wrote, so the alias',
        'inside this canonical would not be rewritten again — and a reader expecting it to be would',
        'predict a different atom.',
        'Reword the canonical so it does not contain another alias.',
      ],
    )
  }

  const terms: TermEntry[] =
    entry === undefined
      ? [...document.terms, { canonical, aliases: [alias] }]
      : document.terms.map((e) =>
          // The EXISTING canonical spelling is kept, not `canonical`.
          norm(e.canonical) === canonicalKey
            ? { canonical: e.canonical, aliases: [...e.aliases, alias] }
            : e,
        )
  return { document: { ...document, terms }, noop: false }
}

/** Remove one term alias. Matched in NORMALIZED space, symmetrically with {@link applyTerm}. */
const applyUnterm = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unterm' }>,
  options: MutateOptions,
): OpSuccess | OpFailure => {
  const norm = options.normalizeHead ?? ((s: string) => s.trim())
  const canonicalKey = norm(op.canonical.trim())
  const aliasKey = norm(op.alias.trim())
  const entry = document.terms.find((e) => norm(e.canonical) === canonicalKey)
  if (entry === undefined || !entry.aliases.some((a) => norm(a) === aliasKey)) {
    return { document, noop: true }
  }
  // An emptied group is DROPPED entirely, as in `applyUnglossary`: a canonical with no aliases
  // substitutes nothing, so keeping it would be a row that looks like a decision and is not.
  const terms = document.terms
    .map((e) =>
      norm(e.canonical) === canonicalKey
        ? { canonical: e.canonical, aliases: e.aliases.filter((a) => norm(a) !== aliasKey) }
        : e,
    )
    .filter((e) => e.aliases.length > 0)
  return { document: { ...document, terms }, noop: false }
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
// The state model (G4)
// ---------------------------------------------------------------------------

/**
 * Build one {@link StateVariable} from a `state` op.
 *
 * ## Why the per-type rules are re-stated here rather than left to the schema
 *
 * The document schema ALREADY states them structurally — `StateVariable` is a union
 * whose `bool` member has no `domain` key, whose `enum` member requires one, and whose
 * `int` member carries optional bounds — and that union is what the manifest
 * publishes. So a wrong shape would be caught on save regardless, and this function
 * could in principle just assemble and let the decode fail.
 *
 * It does not, because the two failures are not equally useful. A schema failure on
 * save reports a JSON PATH (`at ["stateModel"]["variables"][2]`) against a value the
 * caller never typed — they typed `--type enum` and forgot `--domain`. The rules are
 * therefore checked HERE, where the message can name the flag and the fix, and the
 * schema remains the backstop that makes a hand-edited file safe. That is the same
 * split `applyUpdate`'s clear guard already uses: `NULLABLE_ATTRS` answers "may the
 * schema omit this", the fold answers "may THIS caller omit it", and both are needed
 * because they answer different questions.
 *
 * The one rule that is genuinely only here is the EMPTY RANGE (`min > max`), which the
 * schema cannot express: both bounds are individually valid integers, and their
 * relationship is a cross-field constraint. It matters more than it looks — an empty
 * range is an empty state space, over which every invariant holds VACUOUSLY, so a
 * document carrying one would get a clean reachability proof that means nothing.
 */
const stateVariableOf = (op: Extract<DocumentOp, { op: 'state' }>): StateVariable | OpFailure => {
  // The frame defaults HERE, to the sound value. See `FRAME_KINDS` — a missing
  // declaration may only ever weaken a claim, so an absent `frame` is `volatile`.
  const frame = op.frame ?? 'volatile'
  const initial = op.initial?.trim()
  const common = {
    name: op.name,
    frame,
    ...(initial !== undefined && initial.length > 0 ? { initial } : {}),
  }

  if (op.type === 'bool') {
    if (op.domain !== undefined || op.min !== undefined || op.max !== undefined) {
      return usage(
        `A bool variable has no domain: ${JSON.stringify(op.name)} was declared bool with domain/bounds.`,
        [
          "A bool's domain is {true,false} by construction — declaring one would let the document claim a boolean with three values.",
          'Drop --domain/--min/--max, or declare the variable as `enum` (with --domain) or `int` (with --min/--max).',
        ],
      )
    }
    return { ...common, type: 'bool' }
  }

  if (op.type === 'int') {
    if (op.domain !== undefined) {
      return usage(
        `An int variable's range is --min/--max, not --domain: ${JSON.stringify(op.name)}.`,
        ['Use --min and/or --max for an int; --domain lists the members of an `enum`.'],
      )
    }
    if (op.min !== undefined && op.max !== undefined && op.min > op.max) {
      // An empty range is an EMPTY STATE SPACE, and every invariant over it holds
      // vacuously — the exact "a proof can be vacuously true and the tool would not
      // know" failure the sanity gates exist for. Cheaper to refuse the declaration.
      return usage(
        `The declared range of ${JSON.stringify(op.name)} is empty: min ${op.min} > max ${op.max}.`,
        [
          'An empty range gives the encoder no states at all, so every invariant over it would hold VACUOUSLY.',
          `Swap them: --min ${op.max} --max ${op.min}.`,
        ],
      )
    }
    const domain =
      op.min !== undefined || op.max !== undefined
        ? {
            domain: {
              ...(op.min !== undefined ? { min: op.min } : {}),
              ...(op.max !== undefined ? { max: op.max } : {}),
            },
          }
        : {}
    return { ...common, type: 'int', ...domain }
  }

  // enum
  const members = (op.domain ?? []).map((m) => m.trim()).filter((m) => m.length > 0)
  if (members.length === 0) {
    return usage(`An enum variable requires a non-empty --domain: ${JSON.stringify(op.name)}.`, [
      'List the members: --domain "PENDING,RUNNING,DONE,FAILED".',
      'An enum with an empty domain would give the encoder an empty state space, so every invariant over it would hold VACUOUSLY.',
    ])
  }
  const duplicate = members.find((m, i) => members.indexOf(m) !== i)
  if (duplicate !== undefined) {
    return usage(
      `The enum domain of ${JSON.stringify(op.name)} lists ${JSON.stringify(duplicate)} twice.`,
      ['Each member must appear once — a repeated member is a typo, not a wider domain.'],
    )
  }
  if (op.min !== undefined || op.max !== undefined) {
    return usage(`An enum variable has no numeric bounds: ${JSON.stringify(op.name)}.`, [
      'Drop --min/--max; an enum`s values are the --domain members.',
    ])
  }
  return { ...common, type: 'enum', domain: members }
}

/**
 * Every expression in a document that references state, as `(label, source, kind)`.
 *
 * Collected so ONE function can re-validate the whole document against a CHANGED
 * model — which is what `unstate` and a redeclaration need. Validating only the
 * expression being written would leave the other direction open: dropping a variable
 * five expressions still name, or narrowing an enum domain a constraint still
 * compares against, both produce a document whose next `check` carries an undeclared
 * reference into the encoder. That is the V14/V21 hang reached by a different route,
 * so both routes are closed.
 */
const stateExpressions = (
  document: RequirementsDocument,
): readonly {
  readonly label: string
  readonly source: string
  readonly kind: 'effect' | 'constraint'
}[] => {
  const found: { label: string; source: string; kind: 'effect' | 'constraint' }[] = []
  for (const id of Object.keys(document.requirements).sort()) {
    const requirement = document.requirements[id]
    if (requirement === undefined) continue
    const label = requirement.key ?? requirement.id
    if (requirement.stateEffect !== undefined) {
      found.push({ label, source: requirement.stateEffect, kind: 'effect' })
    }
    if (requirement.stateConstraint !== undefined) {
      found.push({ label, source: requirement.stateConstraint, kind: 'constraint' })
    }
  }
  return found
}

/**
 * Refuse a model change that would orphan an existing expression's reference.
 *
 * Reports the FIRST offender with the referencing requirement named, because that is
 * the fix site — an agent needs to know which requirement to edit, not merely that
 * something broke.
 */
const modelKeepsExpressionsValid = (
  document: RequirementsDocument,
  model: StateModel,
  what: string,
): OpFailure | undefined => {
  for (const { label, source, kind } of stateExpressions(document)) {
    const checked =
      kind === 'effect' ? validateEffect(source, model) : validateExpression(source, model, kind)
    if (isExprError(checked)) {
      return usage(`${what} would invalidate ${label}'s ${kind} "${source}": ${checked.error}`, [
        `Edit or clear ${label} first: \`symspec classify ${label} --retract\`, or \`symspec update state${kind === 'effect' ? 'Effect' : 'Constraint'} "<new expression>" --ref ${label}\`.`,
        ...checked.suggestions,
      ])
    }
  }
  return undefined
}

const applyState = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'state' }>,
): OpSuccess | OpFailure => {
  const name = op.name.trim()
  if (name.length === 0) {
    return usage('A `state` op requires a variable name.', [
      'Name the variable: `symspec state --name lock_held --type bool`.',
    ])
  }

  const variable = stateVariableOf({ ...op, name })
  if (isOpFailure(variable)) return variable

  const existing = document.stateModel.variables.find((v) => v.name === name)
  // IDEMPOTENT on an identical redeclaration, so replaying a plan is free. Compared
  // by canonical VALUE rather than by identity, since the op path always builds a
  // fresh object.
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(variable)) {
    return { document, noop: true }
  }

  const variables =
    existing === undefined
      ? [...document.stateModel.variables, variable]
      : document.stateModel.variables.map((v) => (v.name === name ? variable : v))
  const next: RequirementsDocument = {
    ...document,
    stateModel: { ...document.stateModel, variables },
  }

  // A REDECLARATION can narrow: bool→int, or an enum domain losing a member an
  // expression compares against. Both leave an existing expression referencing
  // something that no longer resolves, so the whole document is re-validated against
  // the new model before the write is accepted.
  if (existing !== undefined) {
    const broken = modelKeepsExpressionsValid(
      next,
      next.stateModel,
      `Redeclaring ${JSON.stringify(name)}`,
    )
    if (broken !== undefined) return broken
  }
  // The model-wide initial predicate is checked too, for the same reason.
  const initialBroken = modelInitialValid(next)
  if (initialBroken !== undefined) return initialBroken

  // SANITY GATE #1, authoring half. Reached from BOTH directions here: a new `--initial`
  // that contradicts the model-wide predicate, and a narrowed `--min`/`--max` that excludes
  // an initial value already committed. The second is the shape an author reaches by
  // bounding a variable after writing its initial, and it is exactly as vacuous as a
  // self-contradictory predicate.
  const vacuous = initialStateSatisfiable(next)
  if (vacuous !== undefined) return vacuous

  return { document: next, noop: false }
}

/**
 * Refuse a state model whose INITIAL STATE is provably unsatisfiable — the authoring-time
 * half of sanity gate #1.
 *
 * ## Why this is worth a write-time refusal when `check` already gates the run
 *
 * The solver-backed gate in `../formal/reachability.ts` is the complete answer and it fires
 * on every `check`. This closes the same hole one step earlier, where it is preventable
 * rather than merely detectable: the write is REFUSED, so the vacuous document never
 * reaches disk and the author sees the contradiction while they still remember what they
 * meant. It is the same authoring-vs-schema split `stateVariableOf` documents, and the
 * same one the existing empty-range and empty-domain refusals already use — an empty range
 * is exactly this defect reached through a different field, and it was already refused
 * here for exactly this reason.
 *
 * ## It is deliberately INCOMPLETE, and that direction is the sound one
 *
 * `cheapInitialContradiction` reports only contradictions it has PROVEN with a syntactic
 * check and gives up on everything else — see its header for the three cases and why a
 * false positive (refusing a valid document) would be strictly worse than a miss. What it
 * misses, `check` catches. So the two halves are not redundant; they are the same gate at
 * two different costs, and neither is load-bearing alone.
 *
 * Collects the SOURCE of each predicate so the message names which half to edit: the
 * per-variable `initial` and the model-wide one are set by different commands, and a
 * contradiction that exists only in their CONJUNCTION cannot be fixed without knowing
 * which one the author wants to keep.
 */
const initialStateSatisfiable = (document: RequirementsDocument): OpFailure | undefined => {
  const model = document.stateModel
  const collected: {
    expr: Parameters<typeof cheapInitialContradiction>[0][number]['expr']
    source: string
  }[] = []

  for (const variable of model.variables) {
    if (variable.initial === undefined) continue
    const parsed = validateExpression(variable.initial, model, 'initial')
    // An expression that does not VALIDATE is not this check's business — the caller has
    // already refused it, or (on a hand-edited document) `check` discloses it as skipped.
    // Silently ignoring it here is what keeps this check's failures about satisfiability
    // only.
    if (isExprError(parsed)) continue
    collected.push({ expr: parsed, source: `\`--initial\` on state ${variable.name}` })
  }
  if (model.initial !== undefined) {
    const parsed = validateExpression(model.initial, model, 'initial')
    if (!isExprError(parsed)) {
      collected.push({ expr: parsed, source: '`symspec state-initial`' })
    }
  }

  const contradiction = cheapInitialContradiction(collected, model)
  if (contradiction === undefined) return undefined
  return usage(`The state model's initial state would be UNSATISFIABLE: ${contradiction}.`, [
    'An unsatisfiable initial state means the model has NO initial state, so NO state is reachable and every constraint holds VACUOUSLY — `check` would report every constraint PROVED while proving nothing, and would MASK any real violation the document contains.',
    'Fix the contradiction: change one of the predicates, or clear the model-wide one with `symspec state-initial --clear`.',
    'Per-variable initials are CONJOINED with the model-wide one (adding either only narrows the initial states), so two individually-sensible predicates can contradict each other.',
  ])
}

/** Re-validate the model-wide initial predicate, when there is one. */
const modelInitialValid = (document: RequirementsDocument): OpFailure | undefined => {
  const initial = document.stateModel.initial
  if (initial === undefined) return undefined
  const checked = validateExpression(initial, document.stateModel, 'initial')
  if (isExprError(checked)) {
    return usage(
      `The model-wide initial predicate "${initial}" is no longer valid: ${checked.error}`,
      [
        'Update it with `symspec state-initial "<predicate>"`, or clear it with `symspec state-initial --clear`.',
        ...checked.suggestions,
      ],
    )
  }
  return undefined
}

const applyUnstate = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'unstate' }>,
): OpSuccess | OpFailure => {
  const name = op.name.trim()
  const existing = document.stateModel.variables.find((v) => v.name === name)
  // Removing an already-absent variable is a no-op success, symmetric with removing
  // an absent edge — so an `unstate` in a replayed plan does not fail the batch.
  if (existing === undefined) return { document, noop: true }

  // THE REFERENCE CHECK, from the other side. An expression naming a variable the
  // model no longer declares is exactly the state the authoring-time check exists to
  // prevent, and `unstate` is the only other way to reach it.
  //
  // An expression that ALREADY does not validate (`referencedNames` → `undefined`) is
  // deliberately NOT counted: removing a variable cannot make it worse, so blocking
  // the removal on it would strand the document. See that function's note.
  const referencing: string[] = []
  for (const { label, source, kind } of stateExpressions(document)) {
    const names = referencedNames(source, document.stateModel, kind)
    if (names?.has(name) === true) referencing.push(`${label} (${kind})`)
  }

  if (referencing.length > 0) {
    return usage(
      `Cannot undeclare ${JSON.stringify(name)} — ${referencing.length} expression(s) still reference it: ${referencing.join(', ')}.`,
      [
        'Clear or rewrite those expressions first, then undeclare the variable.',
        'Leaving them would put an UNDECLARED reference into the document, which the reachability encoder cannot encode — the failure it produces is a solver hang, not an error message (v4 findings V14/V21), so it is refused here instead.',
      ],
    )
  }

  const next: RequirementsDocument = {
    ...document,
    stateModel: {
      ...document.stateModel,
      variables: document.stateModel.variables.filter((v) => v.name !== name),
    },
  }
  const initialBroken = modelInitialValid(next)
  if (initialBroken !== undefined) return initialBroken
  return { document: next, noop: false }
}

const applyStateInitial = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'state-initial' }>,
): OpSuccess | OpFailure => {
  if (op.predicate === null) {
    if (document.stateModel.initial === undefined) return { document, noop: true }
    const model: StateModel = { variables: document.stateModel.variables }
    return { document: { ...document, stateModel: model }, noop: false }
  }

  const predicate = op.predicate.trim()
  if (predicate.length === 0) {
    return usage('An empty initial-state predicate constrains nothing.', [
      'Write a predicate, e.g. `symspec state-initial "run_state = PENDING and retry_count = 0"`.',
      'Or clear it entirely with `symspec state-initial --clear`.',
    ])
  }
  const checked = validateExpression(predicate, document.stateModel, 'initial')
  if (isExprError(checked)) {
    return usage(`The initial-state predicate "${predicate}" is not valid: ${checked.error}`, [
      ...checked.suggestions,
    ])
  }
  if (document.stateModel.initial === predicate) return { document, noop: true }
  const next: RequirementsDocument = {
    ...document,
    stateModel: { ...document.stateModel, initial: predicate },
  }
  // SANITY GATE #1, authoring half — the LOW-13 route. This is the command that most easily
  // reaches the contradiction, because the model-wide predicate is CONJOINED with every
  // per-variable one: `state-initial "held = 2"` over a variable already declared
  // `--initial "held = 0"` produces a model with no initial state, and neither half is
  // wrong on its own.
  const vacuous = initialStateSatisfiable(next)
  if (vacuous !== undefined) return vacuous
  return { document: next, noop: false }
}

const applyClassify = (
  document: RequirementsDocument,
  op: Extract<DocumentOp, { op: 'classify' }>,
  timestamp: string,
): OpSuccess | OpFailure => {
  const target = requireTarget(document, op.ref, 'ref', 'classify')
  if (isOpFailure(target)) return target

  // RETRACTION clears the label AND the expression. See `ClassifyOp` — leaving a
  // predicate behind with no label would be a decision recorded and not applied.
  if (op.kind === null) {
    if (
      target.responseKind === undefined &&
      target.stateEffect === undefined &&
      target.stateConstraint === undefined
    ) {
      return { document, id: target.id, noop: true }
    }
    const cleared: Record<string, unknown> = { ...target, updatedAt: timestamp }
    delete cleared.responseKind
    delete cleared.stateEffect
    delete cleared.stateConstraint
    return {
      document: {
        ...document,
        requirements: {
          ...document.requirements,
          [target.id]: cleared as unknown as Requirement,
        },
      },
      id: target.id,
      noop: false,
    }
  }

  const expression = op.expression?.trim()
  if (expression === undefined || expression.length === 0) {
    // A label with no expression contributes NOTHING to the encoding while looking
    // classified — the "reads as done and is not" case `ClassifyOp` documents.
    return usage(
      `Classifying ${target.key ?? target.id} as ${op.kind} requires the expression that says WHAT it ${op.kind === 'effect' ? 'changes' : 'asserts'}.`,
      [
        op.kind === 'effect'
          ? `Supply it: \`symspec classify ${target.key ?? target.id} --kind effect --expression "lock_held := true"\`.`
          : `Supply it: \`symspec classify ${target.key ?? target.id} --kind constraint --expression "not (lock_held and pending)"\`.`,
        'A responseKind with no expression contributes nothing to the reachability encoding, so it would read as classified while the solver saw no state model at all.',
        `Retract instead with \`symspec classify ${target.key ?? target.id} --retract\` if the response does not touch state.`,
      ],
    )
  }

  // THE V14/V21 FRONT DOOR. Every reference must resolve against the DECLARED model,
  // here, at write time, where the failure is an ERR_* an author can act on.
  const checked =
    op.kind === 'effect'
      ? validateEffect(expression, document.stateModel)
      : validateExpression(expression, document.stateModel, 'constraint')
  if (isExprError(checked)) {
    return usage(
      `The ${op.kind} "${expression}" on ${target.key ?? target.id} is not valid: ${checked.error}`,
      [...checked.suggestions],
    )
  }

  // Build by KEY so the unused half is genuinely ABSENT rather than `undefined` —
  // the exactOptionalPropertyTypes discipline reaching the file, which is what keeps
  // a save byte-stable and keeps a reclassification from leaving the old expression
  // behind.
  const next: Record<string, unknown> = { ...target, updatedAt: timestamp }
  next.responseKind = op.kind
  if (op.kind === 'effect') {
    next.stateEffect = expression
    delete next.stateConstraint
  } else {
    next.stateConstraint = expression
    delete next.stateEffect
  }
  const updated = next as unknown as Requirement

  if (
    target.responseKind === op.kind &&
    target.stateEffect === updated.stateEffect &&
    target.stateConstraint === updated.stateConstraint
  ) {
    return { document, id: target.id, noop: true }
  }

  return {
    document: {
      ...document,
      requirements: { ...document.requirements, [target.id]: updated },
    },
    id: target.id,
    noop: false,
  }
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
      return applyGlossary(document, op, options)
    case 'unglossary':
      return applyUnglossary(document, op, options)
    case 'antonym':
      return applyAntonym(document, op, options)
    case 'unantonym':
      return applyUnantonym(document, op, options)
    case 'waive':
      return applyWaive(document, op)
    case 'unwaive':
      return applyUnwaive(document, op)
    case 'state':
      return applyState(document, op)
    case 'unstate':
      return applyUnstate(document, op)
    case 'state-initial':
      return applyStateInitial(document, op)
    case 'classify':
      return applyClassify(document, op, timestamp)
    case 'term':
      return applyTerm(document, op, options)
    case 'unterm':
      return applyUnterm(document, op, options)
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
