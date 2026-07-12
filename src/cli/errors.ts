/**
 * Typed argument-error envelopes (AC-6-10): every invalid or missing CLI
 * argument surfaces as a `{apiVersion, type:'error', error, code, suggestions}`
 * envelope — never an unhandled stack trace.
 *
 * ## Why this module exists
 *
 * An agent driving the CLI cannot parse a `console.error` + `exit(1)` or a raw
 * stack trace. Every invalid or missing argument therefore maps to the stable
 * `ERR_*` catalog (Appendix A): `ERR_USAGE` for malformed/missing arguments,
 * and the three specific argument codes — `ERR_NOT_FOUND` (requirement id not
 * present), `ERR_INVALID_RELATION` (edge relation not in `RELATIONS`), and
 * `ERR_INVALID_ATTR` (update attr not in `UPDATABLE_ATTRS`) — each paired with
 * the actionable suggestion Appendix A prescribes.
 *
 * ## The two shapes offered
 *
 *   1. **Envelope builders** ({@link usageError}, {@link notFoundError},
 *      {@link invalidRelationError}, {@link invalidAttrError}) — pure
 *      constructors over `cli/envelope.ts`'s {@link failure}, one per code,
 *      each baking in the Appendix-A suggestion so no command re-invents it.
 *   2. **Argument guards** ({@link parseRelation}, {@link parseAttr},
 *      {@link requireRequirement}) — validate-and-narrow helpers returning an
 *      {@link ArgResult}: `{ok:true, value}` with the NARROWED type on success,
 *      `{ok:false, envelope}` carrying the ready-to-emit error envelope
 *      otherwise. Command wiring switches on `ok` and never constructs an
 *      argument-error envelope by hand.
 *
 * {@link toErrorEnvelope} closes the "no stack trace" half of the AC: any
 * thrown coded error from the core layer (`ChangeError`, `DocLoadError`,
 * `IoError`, … — all of which carry the `{code, suggestions}` shape) lifts
 * into the error envelope with its own code preserved; anything else falls
 * back to the caller-supplied code (default `ERR_USAGE`) so a crash still
 * emits a machine-parseable envelope.
 *
 * ## Scope boundary
 *
 * This module owns argument validation and error-to-envelope lifting only. It
 * does not build success envelopes (AC-6-2), render output (AC-6-2a), compute
 * exit codes (AC-6-2b), or register commands (AC-6-8/6-9) — the command wiring
 * consumes these helpers.
 *
 * Cite: AC-6-10 (typed arg-error envelopes, never a stack trace); Appendix A
 * rows ERR_USAGE / ERR_NOT_FOUND / ERR_INVALID_RELATION / ERR_INVALID_ATTR;
 * explore-surface.md §1; explore-docs.md §1.4.
 */

import type { ErrCode } from '../core/codes.js'
import { ErrCodeSchema } from '../core/codes.js'
import { resolveRequirement } from '../core/doc.js'
import type { Relation, Requirement, RequirementsDoc, UpdatableAttr } from '../core/schema.js'
import { RELATIONS, UPDATABLE_ATTRS } from '../core/schema.js'
import type { ErrorEnvelope } from './envelope.js'
import { failure } from './envelope.js'

// ---------------------------------------------------------------------------
// ArgResult — the guard return shape
// ---------------------------------------------------------------------------

/**
 * Result of an argument guard: either the validated (and type-narrowed) value,
 * or the ready-to-emit error envelope. Discriminated on `ok` so command wiring
 * handles both arms exhaustively without try/catch.
 */
export type ArgResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly envelope: ErrorEnvelope }

/** Wrap a validated value in the success arm. */
const ok = <T>(value: T): ArgResult<T> => ({ ok: true, value })

/** Wrap an error envelope in the failure arm. */
const err = <T>(envelope: ErrorEnvelope): ArgResult<T> => ({ ok: false, envelope })

// ---------------------------------------------------------------------------
// Envelope builders — one per Appendix-A argument-error code
// ---------------------------------------------------------------------------

/**
 * `ERR_USAGE`: invalid or missing CLI arguments. `usage` is the correct usage
 * string for the command (Appendix A: the suggestion IS the usage line), with
 * any extra caller suggestions appended after it.
 */
export function usageError(
  message: string,
  usage: string,
  extra: readonly string[] = [],
): ErrorEnvelope {
  return failure({
    error: message,
    code: 'ERR_USAGE',
    suggestions: [`Usage: ${usage}`, ...extra],
  })
}

/**
 * `ERR_NOT_FOUND`: a requirement reference (UUID or stable key) that a command
 * requires to exist (show / update / delete-target / edge source) is not present
 * in the document.
 */
export function notFoundError(ref: string): ErrorEnvelope {
  return failure({
    error: `Requirement ${ref} not found`,
    code: 'ERR_NOT_FOUND',
    suggestions: ['List ids and keys with `symspec list`.'],
  })
}

/** `ERR_INVALID_RELATION`: an edge relation not in `RELATIONS`. */
export function invalidRelationError(relation: string): ErrorEnvelope {
  return failure({
    error: `Unknown relation "${relation}"`,
    code: 'ERR_INVALID_RELATION',
    suggestions: [`Valid relations: ${RELATIONS.join('/')}.`],
  })
}

/** `ERR_INVALID_ATTR`: an update attr not in `UPDATABLE_ATTRS`. */
export function invalidAttrError(attr: string): ErrorEnvelope {
  return failure({
    error: `Unknown attribute "${attr}"`,
    code: 'ERR_INVALID_ATTR',
    suggestions: [`Updatable attrs: ${UPDATABLE_ATTRS.join(', ')}.`],
  })
}

// ---------------------------------------------------------------------------
// Argument guards — validate-and-narrow
// ---------------------------------------------------------------------------

/**
 * Validate a raw relation string against `RELATIONS`, narrowing it to
 * {@link Relation} on success and yielding the `ERR_INVALID_RELATION` envelope
 * otherwise.
 */
export function parseRelation(raw: string): ArgResult<Relation> {
  return (RELATIONS as readonly string[]).includes(raw)
    ? ok(raw as Relation)
    : err(invalidRelationError(raw))
}

/**
 * Validate a raw attr string against `UPDATABLE_ATTRS`, narrowing it to
 * {@link UpdatableAttr} on success and yielding the `ERR_INVALID_ATTR`
 * envelope otherwise.
 */
export function parseAttr(raw: string): ArgResult<UpdatableAttr> {
  return (UPDATABLE_ATTRS as readonly string[]).includes(raw)
    ? ok(raw as UpdatableAttr)
    : err(invalidAttrError(raw))
}

/**
 * Require that `ref` resolves to a requirement in `doc` — by stable key OR by
 * UUID (see {@link resolveRequirement}) — yielding the node on success and the
 * `ERR_NOT_FOUND` envelope otherwise. Commands that must fail on a missing
 * reference (show / update / edge source / delete) call this BEFORE building a
 * Change, so the core layer's untyped `throw new Error(... not found)` path is
 * never reached from the CLI, and every one of them accepts a human key wherever
 * it accepts a UUID for free.
 */
export function requireRequirement(doc: RequirementsDoc, ref: string): ArgResult<Requirement> {
  const r = resolveRequirement(doc, ref)
  return r === undefined ? err(notFoundError(ref)) : ok(r)
}

// ---------------------------------------------------------------------------
// Thrown-error lifting — "never an unhandled stack trace"
// ---------------------------------------------------------------------------

/** Structural check for the core layer's `{code, suggestions}` error shape. */
function isCodedError(e: unknown): e is Error & { code: ErrCode; suggestions?: readonly string[] } {
  return (
    e instanceof Error &&
    'code' in e &&
    ErrCodeSchema.safeParse((e as { code: unknown }).code).success
  )
}

/**
 * Lift any thrown value into an {@link ErrorEnvelope}. A coded core error
 * (`ChangeError` / `DocLoadError` / `IoError` / … — anything carrying a valid
 * `ERR_*` `code`) keeps its own code, message, and suggestions. Everything
 * else — a raw `Error`, a Zod validation throw, a non-Error value — falls back
 * to `fallbackCode` (default `ERR_USAGE`) with the message preserved, so no
 * failure path ever escapes as a stack trace (AC-6-10).
 */
export function toErrorEnvelope(e: unknown, fallbackCode: ErrCode = 'ERR_USAGE'): ErrorEnvelope {
  if (isCodedError(e)) {
    return failure({
      error: e.message,
      code: e.code,
      suggestions: e.suggestions ?? [],
    })
  }
  const message = e instanceof Error ? e.message : String(e)
  return failure({ error: message, code: fallbackCode, suggestions: [] })
}
