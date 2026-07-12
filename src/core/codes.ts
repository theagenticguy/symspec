/**
 * `ERR_*` operational-error codes enumeration — stable, append-only codes for
 * every failure surfaced through the CLI/error envelope (AC-6-2).
 *
 * This is the shared code namespace other modules import once they emit an
 * `ERR_*` value: today several modules (`storage.ts`'s `IoError`,
 * `load.ts`'s `DocLoadError`, `changes.ts`'s `ChangeError`,
 * `certify/discover.ts`'s `LeanDiscoveryError`) scope their own narrow code
 * unions locally; their `{code, suggestions}` shape matches this enum's
 * members exactly.
 *
 * ## Single-source `.describe()` corpus (AC-6-3)
 *
 * `ErrCodeSchema` is the closed, append-only SET of codes (what the error
 * envelope's `code` field validates against, AC-6-2). Alongside it,
 * {@link ErrCodeMeta} carries a per-code `.describe()` — a `z.literal(code)`
 * annotated with its human/agent-readable meaning. The manifest (AC-6-1) and
 * the generated docs derive their ERR_* table from this corpus (never a
 * parallel hand-list), so editing a code's `.describe()` here is the single
 * edit that changes the manifest. The `satisfies Record<ErrCode, …>` bound
 * makes the corpus and the enum cover EXACTLY the same codes at compile time:
 * add a member to the enum without describing it (or vice versa) and the build
 * fails.
 *
 * ## Append-only (AC-6-3)
 *
 * Never renumber or remove a code once shipped. A snapshot test
 * (`__tests__/codes-append-only.test.ts`) guards this: it fails if any existing
 * member is removed or renamed. New codes append to the END of the enum.
 *
 * ## Re-create, never migrate
 *
 * A document that cannot be loaded (malformed JSON, unrecognized
 * `schemaVersion`) is re-created from source via `symspec init` + `symspec
 * parse`/`add`. These descriptions point the caller at that path.
 *
 * Cite: AC-6-3 (three exported enums, ERR_* is one); AC-2-7 (ERR_PARSE_*
 * Tier-3 envelope codes); Appendix A (spec.md, normative ERR_* table).
 */

import { z } from 'zod'

/**
 * `ERR_*` codes — every stable operational-error identifier symspec emits.
 * Grouped to match Appendix A's table order. Append-only; never renumber or
 * remove.
 */
export const ErrCodeSchema = z.enum([
  // CLI usage / doc resolution
  'ERR_USAGE',
  'ERR_DOC_NOT_FOUND',
  // Document load / schema
  'ERR_DOC_PARSE',
  'ERR_SCHEMA_VERSION',
  // Storage
  'ERR_IO',
  // Change-record mutation (core)
  'ERR_DUPLICATE_ID',
  'ERR_NOT_FOUND',
  'ERR_INVALID_RELATION',
  'ERR_INVALID_ATTR',
  'ERR_NULL_REQUIRED',
  // Tier-3 NL parse ladder (AC-2-7)
  'ERR_PARSE_NO_MODAL',
  'ERR_PARSE_AMBIGUOUS_CLAUSES',
  'ERR_PARSE_COMPOUND',
  'ERR_PARSE_NOT_A_REQUIREMENT',
  // Formal/solver tier
  'ERR_SOLVER_MISSING',
  'ERR_SOLVER_TIMEOUT',
  'ERR_SOLVER_INCONCLUSIVE',
  // Certify (Lean) tier
  'ERR_LEAN_TOOLCHAIN_MISSING',
  // init non-destructive guard (appended — see MN4) — refuses to clobber an
  // existing document unless `--force` is given.
  'ERR_DOC_EXISTS',
  // Semantic tier (appended — AC-9-4): the local embedding model is not cached
  // and remote loading is disabled. Opt-in `--semantic` only; never blocks the
  // SMT/lint tiers.
  'ERR_EMBED_MODEL_MISSING',
  // Stable human keys (appended): a create supplied a `--key` that another
  // requirement in the document already uses. Keys must be unique so a key
  // resolves to exactly one requirement.
  'ERR_DUPLICATE_KEY',
])

export type ErrCode = z.infer<typeof ErrCodeSchema>

/** Convenience: export the inner tuple for Zod snapshot/reachability tests. */
export const ErrCodes = ErrCodeSchema.options

/**
 * Per-code `.describe()` corpus for the ERR_* catalog (AC-6-3). Each value is a
 * `z.literal(code)` carrying the code's meaning as `.describe()` metadata; the
 * manifest reads `.description` off these to build its error-code table, so
 * this is the single source of the ERR_* documentation. The `satisfies` bound
 * forces this map to describe EXACTLY the {@link ErrCodeSchema} members.
 */
export const ErrCodeMeta = {
  ERR_USAGE: z
    .literal('ERR_USAGE')
    .describe('Invalid or missing CLI arguments. Suggestion: consult the command usage string.'),
  ERR_DOC_NOT_FOUND: z
    .literal('ERR_DOC_NOT_FOUND')
    .describe(
      'The requirements-document path did not resolve. Suggestion: run `symspec init <file>`, or set SYMSPEC_DOC to an existing document.',
    ),
  ERR_DOC_PARSE: z
    .literal('ERR_DOC_PARSE')
    .describe(
      'The document is not valid JSON or fails RequirementsDocSchema. Suggestion: fix the offending JSON path, or re-create the document from source with `symspec init` then `symspec parse`/`add`.',
    ),
  ERR_SCHEMA_VERSION: z
    .literal('ERR_SCHEMA_VERSION')
    .describe(
      "The document's schemaVersion does not equal the current SCHEMA_VERSION. Suggestion: re-create the document at the current schema with `symspec init` then re-add its requirements.",
    ),
  ERR_IO: z
    .literal('ERR_IO')
    .describe(
      'An atomic write to the document failed (permissions or disk). The original file is left intact. Suggestion: check filesystem permissions and free space.',
    ),
  ERR_DUPLICATE_ID: z
    .literal('ERR_DUPLICATE_ID')
    .describe(
      'A CreateRequirement supplied a UUID that already exists. Suggestion: use `symspec update`, or omit --id to auto-mint a fresh UUID.',
    ),
  ERR_NOT_FOUND: z
    .literal('ERR_NOT_FOUND')
    .describe(
      'The referenced requirement id is not present. Suggestion: list existing ids with `symspec list`.',
    ),
  ERR_INVALID_RELATION: z
    .literal('ERR_INVALID_RELATION')
    .describe(
      'The edge relation is not one of the defined RELATIONS. Suggestion: use one of derives/satisfies/verifies/refines.',
    ),
  ERR_INVALID_ATTR: z
    .literal('ERR_INVALID_ATTR')
    .describe(
      'The update attribute is not an updatable attribute. Suggestion: list updatable attrs in the manifest.',
    ),
  ERR_NULL_REQUIRED: z
    .literal('ERR_NULL_REQUIRED')
    .describe(
      'Null/--clear was applied to a required (non-nullable) attribute. Suggestion: provide a value; only preCondition/trigger/verificationMethod are clearable.',
    ),
  ERR_PARSE_NO_MODAL: z
    .literal('ERR_PARSE_NO_MODAL')
    .describe(
      'No `shall`/modal main clause was found. Suggestion: prepend "the <system> shall …"; apply the provided mechanical rewrite.',
    ),
  ERR_PARSE_AMBIGUOUS_CLAUSES: z
    .literal('ERR_PARSE_AMBIGUOUS_CLAUSES')
    .describe(
      'Clause boundaries could not be resolved after Tier 2. Suggestion: reorder to EARS clause order; see the recovered partial slots.',
    ),
  ERR_PARSE_COMPOUND: z
    .literal('ERR_PARSE_COMPOUND')
    .describe(
      'A compound requirement (top-level and/or) was detected. Suggestion: split at "and"/"or" into separate requirements.',
    ),
  ERR_PARSE_NOT_A_REQUIREMENT: z
    .literal('ERR_PARSE_NOT_A_REQUIREMENT')
    .describe(
      'The input is prose with no obligation. Suggestion: rewrite as `<system> shall …`, or skip it — it is not a requirement.',
    ),
  ERR_SOLVER_MISSING: z
    .literal('ERR_SOLVER_MISSING')
    .describe(
      'A binary solver backend was requested but none was found by the discovery order. Suggestion: install one with `mise use github:Z3Prover/z3@z3-4.16.0`.',
    ),
  ERR_SOLVER_TIMEOUT: z
    .literal('ERR_SOLVER_TIMEOUT')
    .describe(
      'The overall run budget (--solver-budget-ms) was exceeded — a whole-run failure, never a single group. Suggestion: raise --solver-budget-ms.',
    ),
  ERR_SOLVER_INCONCLUSIVE: z
    .literal('ERR_SOLVER_INCONCLUSIVE')
    .describe(
      'A whole-run solver-init failure / the solver is unusable — never a per-group `unknown` (that is FND_NEEDS_REVIEW). Suggestion: verify the solver backend and raise the timeout.',
    ),
  ERR_LEAN_TOOLCHAIN_MISSING: z
    .literal('ERR_LEAN_TOOLCHAIN_MISSING')
    .describe(
      '`certify` was requested but no Lean toolchain is discoverable. Suggestion: run `elan default stable`. This never blocks a prior SMT-tier result.',
    ),
  ERR_DOC_EXISTS: z
    .literal('ERR_DOC_EXISTS')
    .describe(
      '`init` refused to overwrite an existing document at the resolved path. Suggestion: pass --force to recreate it, or choose a different path — the existing file is left intact.',
    ),
  ERR_EMBED_MODEL_MISSING: z
    .literal('ERR_EMBED_MODEL_MISSING')
    .describe(
      'The opt-in `--semantic` embedding model is not cached and remote loading is disabled. Suggestion: pre-download the model or set SYMSPEC_EMBED_ALLOW_REMOTE=1 once. Never blocks the SMT/lint tiers.',
    ),
  ERR_DUPLICATE_KEY: z
    .literal('ERR_DUPLICATE_KEY')
    .describe(
      'A create supplied a --key that another requirement already uses; keys must be unique. Suggestion: choose a different key, or omit --key to create the requirement without one.',
    ),
} satisfies Record<ErrCode, z.ZodLiteral<ErrCode>>

/**
 * A single code-catalog row: the stable code and its single-sourced
 * `.describe()` text. The manifest's code tables (AC-6-1/AC-6-3) are arrays of
 * these, derived from an enum + its `*CodeMeta` describe corpus.
 */
export interface CodeCatalogEntry<T extends string = string> {
  readonly code: T
  readonly description: string
}

/**
 * Build a `{code, description}` catalog table by iterating an enum's options in
 * their (append-only) order and reading each code's `.describe()` from its meta
 * corpus. Deriving the description from the `.describe()` metadata — never a
 * parallel hand-list — is the AC-6-3 single-source guarantee: mutating a
 * `.describe()` changes every table built from it (manifest included). Shared
 * by all three code catalogs (ERR_*, GTWR_*, FND_*).
 */
export function buildCodeCatalog<T extends string>(
  options: readonly T[],
  meta: Record<T, z.ZodLiteral<T>>,
): CodeCatalogEntry<T>[] {
  return options.map((code) => ({
    code,
    description: meta[code].description ?? '',
  }))
}

/** The ERR_* catalog table, single-sourced from {@link ErrCodeMeta}. */
export function errCodeCatalog(): CodeCatalogEntry<ErrCode>[] {
  return buildCodeCatalog(ErrCodes, ErrCodeMeta)
}
