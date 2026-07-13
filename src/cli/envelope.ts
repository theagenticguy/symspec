/**
 * Typed CLI envelopes (AC-6-2): the single outer wrapper every symspec command
 * result travels in, so an agent driving the CLI never scrapes prose.
 *
 * ## The two shapes share one discriminant
 *
 * Every successful command result is wrapped in `{ apiVersion, type, data }`
 * and every failure in the superset `{ apiVersion, type: 'error', error, code,
 * suggestions, partial? }`. BOTH envelopes carry `apiVersion` (so an agent can
 * version-negotiate the contract) and a discriminant `type` (so it can switch
 * on one field uniformly across success and error): a success carries the
 * command's own `type` string, a failure carries the literal `'error'`. The
 * error envelope is a strict superset — it adds `error`, `code`, `suggestions`,
 * and an optional `partial` on top of the same `apiVersion` + `type` header.
 *
 * ## `partial` and the Tier-3 parse error
 *
 * `partial` is optional and carries the best-effort slot skeleton recovered by
 * the parse ladder when neither Tier 1 nor Tier 2 produced a full parse
 * (AC-2-7). The Tier-3 error envelope (`parse/tier3.ts`) is precisely an
 * INSTANCE of this outer error envelope: {@link fromTier3Envelope} lifts a
 * `Tier3Envelope` into `{ apiVersion, type:'error', error, code, suggestions,
 * partial }`, so the CLI-agnostic Tier-3 result and the CLI error envelope are
 * the same object modulo the `apiVersion`/`type` header. `partial` is absent
 * (never `null`, never a `partial: undefined` key) when nothing was salvaged,
 * per `exactOptionalPropertyTypes`.
 *
 * ## `apiVersion`
 *
 * `apiVersion` is a distinct envelope-CONTRACT integer, independent of the
 * package version (`--version`) and the document `schemaVersion` (AC-6-12).
 * It is defined once here at {@link API_VERSION}; the manifest (AC-6-1)
 * exposes the same constant so an agent can version-negotiate before its
 * first real command, and `api-version.test.ts` asserts the two never drift.
 * Bump it only when the envelope shape itself changes in a way an agent must
 * negotiate — never in lockstep with a package release or a document
 * `schemaVersion` bump.
 *
 * ## Scope boundary
 *
 * This module owns only the envelope shapes and their constructors. The closed,
 * append-only enum of success `type` values is AC-6-13 (`cli/types-enum.ts`);
 * default-JSON output and `--pretty` are AC-6-2a; the exit-code contract is
 * AC-6-2b; `--dense` is AC-6-4. Those later tasks consume these envelopes; they
 * do not reshape them.
 *
 * Cite: AC-6-2 (typed success/error envelopes sharing `apiVersion`+`type`);
 * AC-2-7 (Tier-3 `partial`); pattern 2 typed envelopes (explore-surface.md §1;
 * explore-docs.md §4 item 10); orchestrator decision 7.
 */

import { z } from 'zod'
import { ErrCodeSchema } from '../core/codes.js'
import { EARS_PATTERNS } from '../core/schema.js'
import type { PartialSlots, Tier3Envelope } from '../parse/tier3.js'

// ---------------------------------------------------------------------------
// apiVersion — the envelope-contract integer (AC-6-2; contract per AC-6-12).
// ---------------------------------------------------------------------------

/**
 * The envelope-contract version (AC-6-12). A distinct INTEGER, independent of
 * both the package version (AC-6-7, `package.json`) and the document
 * `schemaVersion` (AC-1-2, `core/schema.ts` `SCHEMA_VERSION`): those two may
 * change freely without touching this constant, and vice versa. It is stamped
 * on every success and error envelope and exposed by the manifest, and is
 * bumped ONLY on a breaking envelope-shape change an agent must negotiate.
 */
export const API_VERSION = 1

// ---------------------------------------------------------------------------
// Partial-slot schema (the Tier-3 `partial` payload, AC-2-7)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the best-effort slot skeleton the parse ladder recovers on a
 * Tier-3 failure. Mirrors `parse/tier3.ts`'s `PartialSlots` interface: every
 * slot is optional and, per `exactOptionalPropertyTypes`, is ABSENT rather than
 * `null` when unrecovered. Kept as its own exported schema so the error
 * envelope's `partial` validates structurally and round-trips.
 */
export const PartialSlotsSchema = z.object({
  patternType: z.enum(EARS_PATTERNS).optional(),
  systemName: z.string().optional(),
  systemResponse: z.string().optional(),
  preCondition: z.string().optional(),
  trigger: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Proposed `add` ops (the compound-splitter auto-fix payload, wishlist #6)
// ---------------------------------------------------------------------------

/**
 * Zod schema for ONE ready-to-apply `add` op the compound splitter proposes for
 * an `ERR_PARSE_COMPOUND` failure. It is the exact `apply` JSONL op shape
 * (`{"op":"add", …}`) an agent pipes straight into `symspec apply`, so its
 * fields mirror `CreateRequirementAttrsSchema`'s create attrs — with `id`
 * deliberately OMITTED so `apply` mints a fresh UUID per op (no non-determinism
 * leaks into the proposal). `.describe()` makes it self-documenting in the
 * generated manifest/agent docs.
 */
export const ProposedAddOpSchema = z
  .object({
    op: z.literal('add').describe('The apply op discriminant — always "add" for a proposed split.'),
    patternType: z.enum(EARS_PATTERNS),
    systemName: z.string(),
    systemResponse: z.string(),
    negated: z.boolean().optional(),
    preCondition: z.string().optional(),
    trigger: z.string().optional(),
  })
  .describe(
    'One ready-to-apply `add` op proposed by the compound splitter for an ERR_PARSE_COMPOUND ' +
      'failure — the exact `symspec apply` JSONL op shape ({"op":"add", …}), with `id` omitted ' +
      'so apply mints a fresh UUID. When the error envelope carries `proposedOps`, an agent can ' +
      'write the ops to a .jsonl stream and run `symspec apply` to create the split requirements ' +
      'directly, instead of hand-rewriting the compound sentence.',
  )

/** One ready-to-apply `add` op proposed for a compound-split auto-fix. */
export type ProposedAddOp = z.infer<typeof ProposedAddOpSchema>

// ---------------------------------------------------------------------------
// Success envelope
// ---------------------------------------------------------------------------

/**
 * Success envelope: `{ apiVersion, type, data }`. `type` is the command's own
 * discriminant string (the closed enum lands in AC-6-13); `data` is the
 * command-specific payload, left `unknown` here so each command supplies its
 * own typed payload without this module depending on every command's shape.
 */
export const SuccessEnvelopeSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  type: z.string().min(1),
  data: z.unknown(),
})

/** A success envelope with a typed `data` payload. */
export interface SuccessEnvelope<T = unknown> {
  readonly apiVersion: typeof API_VERSION
  readonly type: string
  readonly data: T
}

// ---------------------------------------------------------------------------
// Error envelope (superset of the success header)
// ---------------------------------------------------------------------------

/**
 * Error envelope: `{ apiVersion, type:'error', error, code, suggestions,
 * partial? }`. Shares the `apiVersion` + `type` header with the success
 * envelope (its `type` is the literal `'error'`) and adds the failure payload.
 * `partial` is present only for Tier-3 parse errors that recovered a skeleton.
 */
export const ErrorEnvelopeSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  type: z.literal('error'),
  error: z.string(),
  code: ErrCodeSchema,
  suggestions: z.array(z.string()),
  partial: PartialSlotsSchema.optional(),
  proposedOps: z.array(ProposedAddOpSchema).min(2).optional(),
})

/** An error envelope. */
export interface ErrorEnvelope {
  readonly apiVersion: typeof API_VERSION
  readonly type: 'error'
  readonly error: string
  readonly code: z.infer<typeof ErrCodeSchema>
  readonly suggestions: readonly string[]
  readonly partial?: PartialSlots
  /**
   * For `ERR_PARSE_COMPOUND` only: the machine-actionable `add` ops the compound
   * splitter proposes (≥2), ready to pipe into `symspec apply`. Present only
   * when the split was unambiguous; absent otherwise.
   */
  readonly proposedOps?: readonly ProposedAddOp[]
}

/**
 * Either envelope. Discriminated on `type`: `'error'` is a failure, any other
 * value is a success. An agent can switch on this one field uniformly.
 */
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Wrap a successful command result in the success envelope.
 *
 * @param type  The command's discriminant `type` (e.g. `'check'`, `'parse'`).
 *              Must not be `'error'`, which is reserved for the failure shape.
 * @param data  The command-specific payload.
 */
export function success<T>(type: string, data: T): SuccessEnvelope<T> {
  return { apiVersion: API_VERSION, type, data }
}

/** Options for {@link failure}. `partial`/`proposedOps` are omitted when absent. */
export interface FailureOptions {
  readonly error: string
  readonly code: z.infer<typeof ErrCodeSchema>
  readonly suggestions?: readonly string[]
  readonly partial?: PartialSlots
  /** Machine-actionable `add` ops (≥2) for an ERR_PARSE_COMPOUND auto-fix. */
  readonly proposedOps?: readonly ProposedAddOp[]
}

/**
 * Wrap a failure in the error envelope. `partial` is included only when the
 * caller supplies a non-empty skeleton, and `proposedOps` only when the caller
 * supplies at least two ops — each key is OMITTED (not set to `undefined`/`null`)
 * otherwise, per `exactOptionalPropertyTypes`, mirroring how `partial` is handled.
 */
export function failure(opts: FailureOptions): ErrorEnvelope {
  const hasPartial = opts.partial !== undefined && Object.keys(opts.partial).length > 0
  const hasOps = opts.proposedOps !== undefined && opts.proposedOps.length > 0
  return {
    apiVersion: API_VERSION,
    type: 'error',
    error: opts.error,
    code: opts.code,
    suggestions: opts.suggestions ?? [],
    ...(hasPartial ? { partial: opts.partial as PartialSlots } : {}),
    ...(hasOps ? { proposedOps: opts.proposedOps as readonly ProposedAddOp[] } : {}),
  }
}

/**
 * Lift a Tier-3 parse-error envelope (`parse/tier3.ts`) into the CLI error
 * envelope. This is the concrete realization of AC-6-2's "the Tier-3 parse
 * result is an INSTANCE of this error envelope": it copies `error`, `code`,
 * `suggestions`, and the recovered `partial` under the shared `apiVersion` +
 * `type:'error'` header. `partial` is forwarded only when the Tier-3 result
 * carried one.
 */
export function fromTier3Envelope(t3: Tier3Envelope): ErrorEnvelope {
  return failure({
    error: t3.error,
    code: t3.code,
    suggestions: t3.suggestions,
    ...(t3.partial !== undefined ? { partial: t3.partial } : {}),
  })
}
