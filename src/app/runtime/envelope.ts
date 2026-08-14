/**
 * The envelope contract — the single outer wrapper every symspec result travels
 * in, so an agent driving the CLI never scrapes prose.
 *
 * ## Ported, not reinvented
 *
 * This shape is **agent API**, not legacy: the donor's `src/cli/envelope.ts`
 * defined it, agents in the field switch on it, and the v5 greenfield preserves
 * it byte-for-byte at the wire level. What changed is the implementation
 * language (Zod → Effect Schema) and the provenance of the `code` field (a
 * string enum → the `_tag` of a {@link ./errors.ts} error class). What did NOT
 * change: `{apiVersion, type, data}` on success, `{apiVersion, type:'error',
 * error, code, suggestions, partial?}` on failure, both sharing the
 * `apiVersion` + `type` header so one field discriminates uniformly.
 *
 * ## The two shapes share one discriminant
 *
 * A success carries the operation's own `type` string; a failure carries the
 * literal `'error'`. The error envelope is a strict SUPERSET of the success
 * header — it adds `error`, `code`, `suggestions`, and the optional `partial` /
 * `repair` payloads on top of the same two fields. An agent switches on `type`
 * once and knows which branch it is in.
 *
 * ## `apiVersion`
 *
 * A distinct envelope-CONTRACT integer, independent of the package version
 * (`version` op) and of any future document `schemaVersion`. Bump it only when
 * the envelope SHAPE changes in a way an agent must negotiate — never in
 * lockstep with a release. The manifest exposes the same constant so an agent
 * can version-negotiate before its first real command.
 *
 * ## `repair` — new in v5 (spec AC-A-9)
 *
 * The donor grew a narrow `proposedOps` field late, for one error code
 * (`ERR_PARSE_COMPOUND`). v5 generalizes it from day one: {@link Repair} is the
 * structured, machine-actionable remedy an agent applies to make the failure go
 * away — `ops` to pipe into `import`/`apply`, `commands` to run. It exists as a
 * TYPE in G1 with the plumbing that carries it; the ops-and-commands PRODUCERS
 * land in G3 when findings and demotions get their repair payloads. Declaring
 * the field now means no envelope-shape negotiation later.
 *
 * ## Optional keys are ABSENT, never `undefined`
 *
 * Under `exactOptionalPropertyTypes`, `{partial: undefined}` and `{}` are
 * different types and serialize differently (`JSON.stringify` drops the former's
 * key but a spread of it does not). {@link failure} therefore builds optional
 * keys by conditional spread so an absent payload produces no key at all.
 */

// ---------------------------------------------------------------------------
// apiVersion — the envelope-contract integer
// ---------------------------------------------------------------------------

/**
 * The envelope-contract version. A distinct INTEGER, independent of both the
 * package version and any document `schemaVersion`: those may change freely
 * without touching this constant, and vice versa. Stamped on every success and
 * error envelope and exposed by the manifest.
 */
export const API_VERSION = 1 as const

/** The type of {@link API_VERSION}, for envelope field declarations. */
export type ApiVersion = typeof API_VERSION

// ---------------------------------------------------------------------------
// Repair — the structured remedy (AC-A-9). The SHAPE lives in ports/repair.ts,
// because domain tiers produce a repair and this ring serializes it.
// ---------------------------------------------------------------------------

import type { Repair } from '../../ports/repair.ts'

export type { Repair }

// ---------------------------------------------------------------------------
// Partial — the best-effort recovered skeleton
// ---------------------------------------------------------------------------

/**
 * The best-effort slot skeleton a failed parse recovered. Left as an open record
 * in the kernel: the parse ladder (G2) owns the slot names, and the envelope's
 * job is only to carry the payload. Keys are ABSENT rather than `null` when
 * unrecovered.
 */
export type Partial_ = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// Success envelope
// ---------------------------------------------------------------------------

/**
 * Success envelope: `{apiVersion, type, data}`.
 *
 * `type` is the operation's own discriminant string (each op declares its own;
 * see the `type` field on an `Operation`) and is generic so a handler's return
 * type carries it. `data` is the operation-specific payload.
 */
export interface OkEnvelope<T extends string = string, D = unknown> {
  readonly apiVersion: ApiVersion
  readonly type: T
  readonly data: D
}

/**
 * Wrap a successful result in the success envelope.
 *
 * @param type The operation's discriminant `type`. Must not be `'error'`, which
 *   is reserved for the failure shape — the {@link Operation} type enforces this
 *   statically via {@link NotError}.
 * @param data The operation-specific payload.
 */
export const ok = <T extends string, D>(type: T, data: D): OkEnvelope<T, D> => ({
  apiVersion: API_VERSION,
  type,
  data,
})

/**
 * Rejects `'error'` as an operation's success `type`. `'error'` is the failure
 * envelope's reserved discriminant; an op that claimed it would make `type`
 * ambiguous for every agent. Resolves to `never` for that one literal, so the
 * op fails to typecheck rather than shipping the collision.
 */
export type NotError<T extends string> = T extends 'error' ? never : T

// ---------------------------------------------------------------------------
// Error envelope (a strict superset of the success header)
// ---------------------------------------------------------------------------

/**
 * Error envelope: `{apiVersion, type:'error', error, code, suggestions,
 * partial?, repair?}`.
 *
 * Shares the `apiVersion` + `type` header with {@link OkEnvelope} (its `type` is
 * the literal `'error'`) and adds the failure payload:
 *
 * - `error` — the human-readable message. Named `error` (not `message`) because
 *   that is the donor's shipped wire field.
 * - `code` — a stable `ERR_*` code from {@link ./errors.ts}. This is the field
 *   agents switch on; it is the `_tag` of the error class that produced the
 *   envelope, so the code and the class cannot drift.
 * - `suggestions` — always present, possibly empty. Prose next steps.
 * - `partial` — present only when a parse recovered a skeleton.
 * - `repair` — present only when a structured remedy exists (AC-A-9).
 */
export interface ErrorEnvelope {
  readonly apiVersion: ApiVersion
  readonly type: 'error'
  readonly error: string
  readonly code: string
  readonly suggestions: readonly string[]
  readonly partial?: Partial_
  readonly repair?: Repair
}

/** Options for {@link failure}. Optional payloads are omitted when empty. */
export interface FailureOptions {
  readonly error: string
  readonly code: string
  readonly suggestions?: readonly string[]
  readonly partial?: Partial_
  readonly repair?: Repair
}

/**
 * Wrap a failure in the error envelope.
 *
 * `suggestions` defaults to `[]` (the field is always present so an agent never
 * has to test for it). `partial` and `repair` are each OMITTED — not set to
 * `undefined` or `null` — when the caller supplies nothing useful: an empty
 * `partial` object, or a `repair` with no ops AND no commands, carries no
 * information and would only add noise to the wire.
 */
export const failure = (opts: FailureOptions): ErrorEnvelope => {
  const hasPartial = opts.partial !== undefined && Object.keys(opts.partial).length > 0
  const repair = opts.repair
  const hasRepair = repair !== undefined && (repair.ops.length > 0 || repair.commands.length > 0)
  return {
    apiVersion: API_VERSION,
    type: 'error',
    error: opts.error,
    code: opts.code,
    suggestions: opts.suggestions ?? [],
    ...(hasPartial ? { partial: opts.partial as Partial_ } : {}),
    ...(hasRepair ? { repair: repair as Repair } : {}),
  }
}

// ---------------------------------------------------------------------------
// Either envelope
// ---------------------------------------------------------------------------

/**
 * Either envelope. Discriminated on `type`: the literal `'error'` is a failure,
 * any other value is a success. An agent switches on this one field uniformly
 * across every operation.
 */
export type Envelope<T extends string = string, D = unknown> = OkEnvelope<T, D> | ErrorEnvelope

/** Narrow an {@link Envelope} to its failure branch. */
export const isErrorEnvelope = (env: Envelope): env is ErrorEnvelope => env.type === 'error'

/**
 * Serialize an envelope to the single line written to STDOUT — success and
 * failure alike.
 *
 * ## Both envelopes go to stdout (donor fidelity, deliberately NOT the spike's
 * choice)
 *
 * The donor writes every envelope, error included, to stdout: `src/cli/index.ts`
 * `emit()` renders and calls `writeStdoutAndExit`, and `src/cli/exit.ts`'s
 * contract docs say so explicitly for code `2` ("The ERROR envelope … is written
 * to stdout"). The S2 kernel spike put errors on stderr instead. THE DONOR WINS:
 * the stream is part of the shipped agent API, and an agent running
 * `symspec check | jq` would silently receive nothing on failure if errors moved
 * to stderr — a worse break than a shape change, because it looks like success
 * with empty output rather than a parse error.
 *
 * Stderr therefore carries no envelope at all, which leaves it free for the one
 * thing it should carry: nothing. `Logger.LogToStderr` is provided on every
 * entry point so a stray `Effect.log*` lands there instead of corrupting the
 * stdout envelope (the v4 default logger writes to stdout — verified by probe in
 * S2). The two rules compose: envelopes own stdout, diagnostics own stderr.
 *
 * One newline-terminated JSON object per invocation, no pretty-printing: the
 * default output is what an agent parses, and `--pretty` (a later G1 task) is
 * the opt-in human affordance rather than the other way round.
 */
export const renderEnvelope = (env: Envelope): string => JSON.stringify(env)
