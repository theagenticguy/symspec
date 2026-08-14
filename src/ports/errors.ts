/**
 * The ERR_* error catalog: 21 stable operational-error codes, each a
 * {@link Schema.TaggedErrorClass} whose TAG IS THE CODE.
 *
 * ## Why the tag is the code
 *
 * v4 kept two artifacts in sync by hand: a `z.enum` of code strings and a
 * parallel `ErrCodeMeta` map of `z.literal(code).describe(text)`. A code could
 * exist in one and not the other, so a `satisfies` bound was needed to force
 * them to agree. Here there is only ONE artifact per code — the class. Its
 * `_tag` is the wire code, its `description` annotation is the catalog text, and
 * an error instance IS its own catalog entry. There is nothing to keep in sync,
 * so nothing can drift.
 *
 * ## Descriptions are VERBATIM from v4
 *
 * Every `description` below is byte-identical to v4's
 * `src/core/codes.ts` `ErrCodeMeta` `.describe()` text — extracted
 * programmatically, not retyped, because these strings are the agent-facing
 * meaning of the code vocabulary and the spec keeps every code's "meanings
 * intact". Each carries its own `Suggestion:` clause, which is why
 * {@link explainCode} can split one string into a description and a suggestion
 * without a second corpus.
 *
 * ## Append-only
 *
 * Never renumber, rename, or remove a shipped code. New codes append to the END
 * of {@link ERR_CODES}. `errors.test.ts` holds the frozen snapshot that fails on
 * a removal, a rename, or a reorder, and passes on an append.
 *
 * ## The wire projection lives with the wire
 *
 * `app/runtime/errors.ts` holds `toErrorEnvelope`, which takes the closed
 * {@link OperationalError} union and reads `_tag`, `error`, and `suggestions`
 * off it directly — no structural sniffing, no default code. This file is the
 * VOCABULARY: every ring may name an error; only the app ring serializes one.
 */

import { Runtime, Schema } from 'effect'
import { EXIT_OPERATIONAL_ERROR } from './exit.ts'

// ---------------------------------------------------------------------------
// The shared field set
// ---------------------------------------------------------------------------

/**
 * The fields every ERR_* class carries — deliberately the error envelope's
 * payload minus the `code` (which is the tag) and the `apiVersion` (which the
 * envelope constructor stamps).
 *
 * - `error` — the human-readable message. Named to match the wire field, so
 *   {@link toErrorEnvelope} is a rename-free copy.
 * - `suggestions` — actionable next steps. Always present, possibly empty.
 * - `partial` — the best-effort skeleton a failed parse recovered.
 *   `optionalKey` (not `optional`) because the wire contract is an ABSENT key,
 *   never `{partial: null}`.
 * - `repair` — the structured remedy (AC-A-9). Present on the class from day one
 *   so a G3 producer only has to populate it, never to reshape the envelope.
 */
const ErrorFields = {
  error: Schema.String,
  suggestions: Schema.Array(Schema.String),
  partial: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  repair: Schema.optionalKey(
    Schema.Struct({
      ops: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      commands: Schema.Array(Schema.String),
    }),
  ),
} as const

// ---------------------------------------------------------------------------
// The 21 codes, in shipped (append-only) order
//
// GOTCHA (v4 beta.102 + noImplicitOverride): the Runtime marker properties need
// an `override` modifier. `Cause.YieldableError` already declares
// `[Runtime.errorExitCode]?` and `[Runtime.errorReported]?` as optional members,
// so redeclaring them without `override` is TS4114. The S2 spike did not hit
// this because its tsconfig lacked `noImplicitOverride`.
// ---------------------------------------------------------------------------

/** Invalid or missing CLI arguments. */
export class ErrUsage extends Schema.TaggedErrorClass<ErrUsage>()('ERR_USAGE', ErrorFields, {
  description: 'Invalid or missing CLI arguments. Suggestion: consult the command usage string.',
}) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The requirements-document path did not resolve. */
export class ErrDocNotFound extends Schema.TaggedErrorClass<ErrDocNotFound>()(
  'ERR_DOC_NOT_FOUND',
  ErrorFields,
  {
    description:
      'The requirements-document path did not resolve. Suggestion: run `symspec init <file>`, or set SYMSPEC_DOC to an existing document.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The document is not valid JSON or fails RequirementsDocSchema. */
export class ErrDocParse extends Schema.TaggedErrorClass<ErrDocParse>()(
  'ERR_DOC_PARSE',
  ErrorFields,
  {
    description:
      'The document is not valid JSON or fails RequirementsDocSchema. Suggestion: fix the offending JSON path, or re-create the document from source with `symspec init` then `symspec parse`/`add`.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The document's schemaVersion does not equal the current SCHEMA_VERSION, though it does satisfy the current document schema. The suggestions therefore carry the exact ops that reproduce it: a `symspec init` step, one `symspec apply` JSONL op record per requirement and per edge in dependency order, the `symspec glossary`/`antonym`/`waive` commands for the tables `apply` has no op for, and an explicit statement of anything the ops do not reproduce. */
export class ErrSchemaVersion extends Schema.TaggedErrorClass<ErrSchemaVersion>()(
  'ERR_SCHEMA_VERSION',
  ErrorFields,
  {
    description:
      "The document's schemaVersion does not equal the current SCHEMA_VERSION, though it does satisfy the current document schema. The suggestions therefore carry the exact ops that reproduce it: a `symspec init` step, one `symspec apply` JSONL op record per requirement and per edge in dependency order, the `symspec glossary`/`antonym`/`waive` commands for the tables `apply` has no op for, and an explicit statement of anything the ops do not reproduce. Suggestion: `symspec init <file>`, then pipe the reported op records through `symspec apply`.",
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** An atomic write to the document failed (permissions or disk). The original file is left intact. */
export class ErrIo extends Schema.TaggedErrorClass<ErrIo>()('ERR_IO', ErrorFields, {
  description:
    'An atomic write to the document failed (permissions or disk). The original file is left intact. Suggestion: check filesystem permissions and free space.',
}) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** A CreateRequirement supplied a UUID that already exists. */
export class ErrDuplicateId extends Schema.TaggedErrorClass<ErrDuplicateId>()(
  'ERR_DUPLICATE_ID',
  ErrorFields,
  {
    description:
      'A CreateRequirement supplied a UUID that already exists. Suggestion: use `symspec update`, or omit --id to auto-mint a fresh UUID.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The referenced requirement id is not present. */
export class ErrNotFound extends Schema.TaggedErrorClass<ErrNotFound>()(
  'ERR_NOT_FOUND',
  ErrorFields,
  {
    description:
      'The referenced requirement id is not present. Suggestion: list existing ids with `symspec list`.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The edge relation is not one of the defined RELATIONS. */
export class ErrInvalidRelation extends Schema.TaggedErrorClass<ErrInvalidRelation>()(
  'ERR_INVALID_RELATION',
  ErrorFields,
  {
    description:
      'The edge relation is not one of the defined RELATIONS. Suggestion: use one of derives/satisfies/verifies/refines.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The update attribute is not an updatable attribute. */
export class ErrInvalidAttr extends Schema.TaggedErrorClass<ErrInvalidAttr>()(
  'ERR_INVALID_ATTR',
  ErrorFields,
  {
    description:
      'The update attribute is not an updatable attribute. Suggestion: list updatable attrs in the manifest.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** Null/--clear was applied to a required (non-nullable) attribute. */
export class ErrNullRequired extends Schema.TaggedErrorClass<ErrNullRequired>()(
  'ERR_NULL_REQUIRED',
  ErrorFields,
  {
    description:
      'Null/--clear was applied to a required (non-nullable) attribute. Suggestion: provide a value; only preCondition/trigger/verificationMethod are clearable.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** No `shall`/modal main clause was found. */
export class ErrParseNoModal extends Schema.TaggedErrorClass<ErrParseNoModal>()(
  'ERR_PARSE_NO_MODAL',
  ErrorFields,
  {
    description:
      'No `shall`/modal main clause was found. Suggestion: prepend "the <system> shall …"; apply the provided mechanical rewrite.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** Clause boundaries could not be resolved after Tier 2. */
export class ErrParseAmbiguousClauses extends Schema.TaggedErrorClass<ErrParseAmbiguousClauses>()(
  'ERR_PARSE_AMBIGUOUS_CLAUSES',
  ErrorFields,
  {
    description:
      'Clause boundaries could not be resolved after Tier 2. Suggestion: reorder to EARS clause order; see the recovered partial slots.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** A compound requirement (top-level and/or) was detected. */
export class ErrParseCompound extends Schema.TaggedErrorClass<ErrParseCompound>()(
  'ERR_PARSE_COMPOUND',
  ErrorFields,
  {
    description:
      'A compound requirement (top-level and/or) was detected. Suggestion: split at "and"/"or" into separate requirements.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The input is prose with no obligation. */
export class ErrParseNotARequirement extends Schema.TaggedErrorClass<ErrParseNotARequirement>()(
  'ERR_PARSE_NOT_A_REQUIREMENT',
  ErrorFields,
  {
    description:
      'The input is prose with no obligation. Suggestion: rewrite as `<system> shall …`, or skip it — it is not a requirement.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** A binary solver backend was requested but none was found by the discovery order. */
export class ErrSolverMissing extends Schema.TaggedErrorClass<ErrSolverMissing>()(
  'ERR_SOLVER_MISSING',
  ErrorFields,
  {
    description:
      'A binary solver backend was requested but none was found by the discovery order. Suggestion: install one with `mise use github:Z3Prover/z3@z3-4.16.0`.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The overall run budget (--solver-budget-ms) was exceeded — a whole-run failure, never a single group. */
export class ErrSolverTimeout extends Schema.TaggedErrorClass<ErrSolverTimeout>()(
  'ERR_SOLVER_TIMEOUT',
  ErrorFields,
  {
    description:
      'The overall run budget (--solver-budget-ms) was exceeded — a whole-run failure, never a single group. Suggestion: raise --solver-budget-ms.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** A whole-run solver-init failure / the solver is unusable — never a per-group `unknown` (that is FND_NEEDS_REVIEW). */
export class ErrSolverInconclusive extends Schema.TaggedErrorClass<ErrSolverInconclusive>()(
  'ERR_SOLVER_INCONCLUSIVE',
  ErrorFields,
  {
    description:
      'A whole-run solver-init failure / the solver is unusable — never a per-group `unknown` (that is FND_NEEDS_REVIEW). Suggestion: verify the solver backend and raise the timeout.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** `certify` was requested but no Lean toolchain is discoverable. */
export class ErrLeanToolchainMissing extends Schema.TaggedErrorClass<ErrLeanToolchainMissing>()(
  'ERR_LEAN_TOOLCHAIN_MISSING',
  ErrorFields,
  {
    description:
      '`certify` was requested but no Lean toolchain is discoverable. Suggestion: run `elan default stable`. This never blocks a prior SMT-tier result.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** `init` refused to overwrite an existing document at the resolved path. */
export class ErrDocExists extends Schema.TaggedErrorClass<ErrDocExists>()(
  'ERR_DOC_EXISTS',
  ErrorFields,
  {
    description:
      '`init` refused to overwrite an existing document at the resolved path. Suggestion: pass --force to recreate it, or choose a different path — the existing file is left intact.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** The embedding model (core to every `check`) is not cached and remote loading is disabled — the run fails closed rather than silently skipping the semantic/opposition tier. */
export class ErrEmbedModelMissing extends Schema.TaggedErrorClass<ErrEmbedModelMissing>()(
  'ERR_EMBED_MODEL_MISSING',
  ErrorFields,
  {
    description:
      'The embedding model (core to every `check`) is not cached and remote loading is disabled — the run fails closed rather than silently skipping the semantic/opposition tier. Suggestion: run `symspec download-model` once, or set SYMSPEC_EMBED_ALLOW_REMOTE=1 for this run.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}

/** A create supplied a --key that another requirement already uses; keys must be unique. */
export class ErrDuplicateKey extends Schema.TaggedErrorClass<ErrDuplicateKey>()(
  'ERR_DUPLICATE_KEY',
  ErrorFields,
  {
    description:
      'A create supplied a --key that another requirement already uses; keys must be unique. Suggestion: choose a different key, or omit --key to create the requirement without one.',
  },
) {
  override readonly [Runtime.errorExitCode] = EXIT_OPERATIONAL_ERROR
  override readonly [Runtime.errorReported] = false
}
// ---------------------------------------------------------------------------
// The closed union and the code list
// ---------------------------------------------------------------------------

/**
 * The closed union of every operational error. A handler's error channel is
 * typed against this, so adding a failure mode without adding a class here is a
 * compile error rather than an untagged throw.
 */
export type OperationalError =
  | ErrUsage
  | ErrDocNotFound
  | ErrDocParse
  | ErrSchemaVersion
  | ErrIo
  | ErrDuplicateId
  | ErrNotFound
  | ErrInvalidRelation
  | ErrInvalidAttr
  | ErrNullRequired
  | ErrParseNoModal
  | ErrParseAmbiguousClauses
  | ErrParseCompound
  | ErrParseNotARequirement
  | ErrSolverMissing
  | ErrSolverTimeout
  | ErrSolverInconclusive
  | ErrLeanToolchainMissing
  | ErrDocExists
  | ErrEmbedModelMissing
  | ErrDuplicateKey

/**
 * Every ERR_* class, in shipped order. The catalog projections
 * ({@link errCodeCatalog}, the manifest, `explain`) iterate this one array, so
 * a new code becomes visible on every surface by being appended here.
 */
export const ERR_CLASSES = [
  ErrUsage,
  ErrDocNotFound,
  ErrDocParse,
  ErrSchemaVersion,
  ErrIo,
  ErrDuplicateId,
  ErrNotFound,
  ErrInvalidRelation,
  ErrInvalidAttr,
  ErrNullRequired,
  ErrParseNoModal,
  ErrParseAmbiguousClauses,
  ErrParseCompound,
  ErrParseNotARequirement,
  ErrSolverMissing,
  ErrSolverTimeout,
  ErrSolverInconclusive,
  ErrLeanToolchainMissing,
  ErrDocExists,
  ErrEmbedModelMissing,
  ErrDuplicateKey,
] as const

/** The union of ERR_* code strings. */
export type ErrCode = OperationalError['_tag']

// ---------------------------------------------------------------------------
// Reading the catalog off the classes
// ---------------------------------------------------------------------------

/**
 * The minimum structural view of a schema this module reads: its AST's
 * annotation bag.
 *
 * `.ast.annotations` IS public API on beta.102, but every value in it is typed
 * `unknown` (the bag is an index signature), so each read narrows explicitly.
 * That is a feature here: a missing or non-string annotation THROWS rather than
 * silently yielding `undefined`, which is what makes a code that forgot its
 * description a build failure instead of a blank row in the manifest.
 */
interface AnnotatedSchema {
  readonly ast: { readonly annotations?: { readonly [x: string]: unknown } | undefined }
}

/**
 * The stable code of an ERR_* class, read from the `identifier` annotation
 * `TaggedErrorClass` populates from the tag. Equal to `new C({...})._tag`
 * without having to construct an instance.
 */
export const tagOf = (cls: AnnotatedSchema): string => {
  const id = cls.ast.annotations?.identifier
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('ERR_* class is missing its identifier annotation')
  }
  return id
}

/**
 * The catalog text of an ERR_* class, read from its `description` annotation.
 * Throws when absent — a code with no description has lost its single source,
 * which is exactly the drift this kernel exists to make impossible.
 *
 * The thrown message names the offending class WITHOUT calling {@link tagOf},
 * which would itself throw on a class that is missing its identifier and so
 * report the wrong problem: "missing identifier" when the actual fault is a
 * missing description. Read the identifier defensively instead, so the error
 * always describes the fault the caller actually has.
 */
export const descriptionOf = (cls: AnnotatedSchema): string => {
  const d = cls.ast.annotations?.description
  if (typeof d !== 'string' || d.length === 0) {
    const id = cls.ast.annotations?.identifier
    const which = typeof id === 'string' && id.length > 0 ? id : '<unidentified>'
    throw new Error(`ERR_* class ${which} is missing its description annotation`)
  }
  return d
}

/**
 * Every ERR_* code as a string, in shipped order — derived from
 * {@link ERR_CLASSES} tags rather than hand-listed, so it cannot disagree with
 * the classes. This is the append-only sequence the snapshot test freezes.
 *
 * DECLARED HERE, below {@link tagOf}, deliberately. It is an eagerly-evaluated
 * module-level `const` that CALLS `tagOf`, so placing it above `tagOf`'s own
 * `const` declaration puts the call in the temporal dead zone: the module throws
 * `ReferenceError: Cannot access 'tagOf' before initialization` on import.
 * `tsc --noEmit` does NOT catch that (it only tracks TDZ within a scope, not
 * across module-level initializer order), so the failure surfaces as a vitest
 * import crash instead of a type error. Keep derived constants after the
 * functions they call.
 */
export const ERR_CODES: readonly string[] = ERR_CLASSES.map((cls) => tagOf(cls))

/** One row of the ERR_* catalog: the stable code and its single-sourced text. */
export interface CodeCatalogEntry {
  readonly code: string
  readonly description: string
}

/**
 * The ERR_* catalog table, derived from the classes' own annotations. The
 * manifest and `explain` both read this, so editing a class's `description` is
 * the single edit that changes every surface.
 */
export const errCodeCatalog = (): readonly CodeCatalogEntry[] =>
  ERR_CLASSES.map((cls) => ({ code: tagOf(cls), description: descriptionOf(cls) }))

/**
 * A code's meaning split into its two halves at the `Suggestion:` marker every
 * v4 description carries. Returning both separately lets `explain` answer
 * "what does this code mean" and "what do I do about it" as distinct fields
 * without a second corpus to maintain.
 */
export interface CodeExplanation {
  readonly code: string
  /** The full single-sourced catalog text, verbatim. */
  readonly description: string
  /** The description up to `Suggestion:` — what the code MEANS. */
  readonly meaning: string
  /** The `Suggestion:` clauses — what to DO. Empty when the text carries none. */
  readonly suggestions: readonly string[]
}

/**
 * Explain one code: its verbatim text plus that text split into meaning and
 * suggestions. Returns `undefined` for an unknown code — the caller decides
 * whether that is an {@link ErrNotFound} (the `explain` op) or something else.
 */
export const explainCode = (code: string): CodeExplanation | undefined => {
  const row = errCodeCatalog().find((r) => r.code === code)
  if (row === undefined) return undefined
  const [meaning, ...rest] = row.description.split(/\s*Suggestion:\s*/)
  return {
    code: row.code,
    description: row.description,
    meaning: (meaning ?? '').trim(),
    suggestions: rest.map((s) => s.trim()).filter((s) => s.length > 0),
  }
}

/**
 * Codes whose text is closest to a misspelling, for a did-you-mean suggestion.
 *
 * Ranks by a cheap, deterministic pair of signals rather than a full edit
 * distance: shared leading prefix length first (so `ERR_PARSE_X` suggests the
 * other `ERR_PARSE_*` codes), then shared token overlap. Deterministic ordering
 * matters because these strings land in an envelope an agent may diff.
 */
export const nearestCodes = (code: string, limit = 3): readonly string[] => {
  const target = code.toUpperCase()
  const tokens = new Set(target.split('_').filter((t) => t.length > 0))
  const sharedPrefix = (a: string, b: string): number => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  return [...ERR_CODES]
    .map((candidate) => ({
      candidate,
      prefix: sharedPrefix(target, candidate),
      overlap: candidate.split('_').filter((t) => tokens.has(t)).length,
    }))
    .filter((s) => s.prefix > 0 || s.overlap > 0)
    .sort(
      (a, b) =>
        b.prefix - a.prefix || b.overlap - a.overlap || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, limit)
    .map((s) => s.candidate)
}
