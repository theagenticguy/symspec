/**
 * `--dense` output mode (AC-6-4): a token-economical rendering of the AC-6-2
 * envelopes for an agent that pays per token, WITHOUT changing the typed
 * contract. Dense is a lossless-modulo-defaults projection of the SAME envelope
 * an agent already knows how to parse — never a second, abbreviated dialect.
 *
 * ## What `--dense` does (the three pinned reductions)
 *
 * AC-6-4 pins "compact" — an untestable weasel word in the original spec — to
 * three concrete, mechanical reductions, and NOTHING else:
 *
 *   1. **Minified JSON.** {@link minifyJson} serializes with no pretty-print
 *      whitespace (`JSON.stringify(value)` with no indent argument).
 *   2. **Omit default/null keys.** A key is dropped when its value equals the
 *      field's Zod `.default(...)` — because `schema.parse(...)` re-applies that
 *      exact default on read, so dropping it is information-preserving — or when
 *      it is a `null` the schema would accept as absent (see the round-trip note
 *      below). Driven by the field's Zod schema, so "the default" is never
 *      hand-guessed: it IS `field.def.defaultValue`.
 *   3. **Elide evidence unless `--evidence`.** The heavy `evidence` field every
 *      formal finding carries (AC-4-6: the atom table + unsat core/witness) is
 *      dropped wherever it appears, unless the caller also passes `--evidence`
 *      ({@link DenseOptions.keepEvidence}). `atomTable` travels INSIDE `evidence`
 *      (see `formal/finding.ts`), so eliding the `evidence` key removes it too.
 *
 * Field NAMES and the typed schema are left identical — no key abbreviation,
 * because renaming keys would break AC-6-4's "same typed structure" guarantee
 * and force an agent to learn a second vocabulary. Dense output therefore
 * validates against the SAME Zod schemas as non-dense output.
 *
 * ## Round-trip guarantee (and its exact boundary)
 *
 * For a CANONICAL payload — one already produced by `schema.parse(...)`, so
 * defaults are present and optionals are ABSENT rather than `null` (the
 * `exactOptionalPropertyTypes` discipline this codebase follows everywhere) —
 * densify + re-parse is the identity:
 *
 *     schema.parse(densifyValue(schema, x, { keepEvidence: true })) deepEquals x
 *
 * because every key densify drops is one `schema.parse` re-materializes with the
 * identical default value. This is the AC-6-4 "round-trips to an equal object"
 * guarantee, and it is exact whenever nothing is elided (`keepEvidence: true`)
 * and the payload is canonical.
 *
 * Two intentional boundaries on that guarantee, both required by the AC's own
 * wording:
 *   - Eliding `evidence` (the default) is deliberately lossy — the whole point
 *     is to shed those bytes — so a re-parse of an evidence-elided finding is a
 *     valid, smaller object, not byte-equal to the evidence-bearing original.
 *     `evidence` is an OPTIONAL field, so the elided output still VALIDATES.
 *   - A `null` is dropped only when the field's schema ACCEPTS the key's absence
 *     (optional / `.default(...)` / nullish). A pure `.nullable()` (no default,
 *     not optional) REQUIRES the key, so its `null` is KEPT — dropping it would
 *     fail validation. A canonical payload carries no explicit nulls, so this
 *     rule never perturbs the round-trip identity above; it only trims a
 *     non-canonical `null` an agent should not have sent.
 *
 * ## Scope boundary
 *
 * This module owns only the dense PROJECTION and its minified serialization. The
 * `--dense`/`--evidence` flag parsing and command wiring is CLI-surface work
 * (AC-6-2a `cli/output.ts` / the command layer), which calls {@link denseEnvelope}
 * / {@link densifyEnvelope}. The envelope shapes themselves are AC-6-2
 * (`cli/envelope.ts`); this module consumes them unchanged.
 *
 * Cite: AC-6-4 (`--dense`: minify + omit default/null + elide evidence unless
 * `--evidence`, same typed schema, round-trip); pattern 4 dense mode
 * (explore-surface.md §1; orchestrator decision 7).
 */

import type { z } from 'zod'
import {
  type Envelope,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type SuccessEnvelope,
} from './envelope.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options controlling the dense projection. */
export interface DenseOptions {
  /**
   * When `true`, retain the heavy `evidence`/atom-table fields (AC-4-6) — the
   * `--evidence` escape hatch. When `false`/omitted (the default), every
   * `evidence` key is elided wherever it appears.
   */
  readonly keepEvidence?: boolean
}

/** The single field name whose value is elided unless `keepEvidence` is set. */
const ELIDED_KEY = 'evidence'

// ---------------------------------------------------------------------------
// Zod v4 schema introspection (minimal, typed views over `schema.def`)
// ---------------------------------------------------------------------------

/**
 * The subset of Zod v4's internal `def` shapes this module reads. Zod exposes
 * a `.def` on every schema whose `type` tag names the node kind; the extra
 * fields (`innerType`, `defaultValue`, `shape`, `element`, `keyType`,
 * `valueType`) are present only on the kinds that carry them. Verified against
 * the installed `zod` (v4): default → `{ type:'default', innerType, defaultValue }`,
 * optional/nullable/readonly → `{ type, innerType }`, object → `{ type:'object',
 * shape }`, array → `{ type:'array', element }`, record → `{ type:'record',
 * keyType, valueType }`.
 */
interface ZodDef {
  readonly type: string
  readonly innerType?: z.ZodType
  readonly defaultValue?: unknown
  readonly shape?: Readonly<Record<string, z.ZodType>>
  readonly element?: z.ZodType
  readonly valueType?: z.ZodType
}

/** Read the internal `def` view off a Zod schema. */
function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { readonly def: ZodDef }).def
}

/** A schema with its outer wrappers peeled, plus any default discovered en route. */
interface Peeled {
  /** The innermost non-wrapper schema (object/array/record/primitive/…). */
  readonly core: z.ZodType
  /** Whether a `.default(...)` wrapper was found while peeling. */
  readonly hasDefault: boolean
  /** The default value, when `hasDefault` is true. */
  readonly defaultValue?: unknown
}

/**
 * Peel `optional` / `nullable` / `readonly` / `default` wrappers off a field to
 * reach its structural core, capturing the outermost `.default(...)` value if
 * present. `.optional().default(v)` and `.default(v)` both surface `v`.
 */
function peel(schema: z.ZodType): Peeled {
  let current = schema
  let hasDefault = false
  let defaultValue: unknown
  for (;;) {
    const def = defOf(current)
    if (def.type === 'default' && def.innerType !== undefined) {
      if (!hasDefault) {
        hasDefault = true
        defaultValue = def.defaultValue
      }
      current = def.innerType
      continue
    }
    if (
      (def.type === 'optional' || def.type === 'nullable' || def.type === 'readonly') &&
      def.innerType !== undefined
    ) {
      current = def.innerType
      continue
    }
    break
  }
  return hasDefault ? { core: current, hasDefault, defaultValue } : { core: current, hasDefault }
}

/**
 * Whether a field's schema accepts the key being ABSENT — true for `optional`,
 * `.default(...)`, and nullish (`optional(nullable(...))`), false for a pure
 * `.nullable()` / plain required field. Used to decide whether a `null` value
 * is safe to drop: dropping it must not turn a valid document into one the
 * schema rejects.
 */
function absenceAllowed(schema: z.ZodType): boolean {
  let current = schema
  for (;;) {
    const def = defOf(current)
    if (def.type === 'optional' || def.type === 'default') return true
    if ((def.type === 'nullable' || def.type === 'readonly') && def.innerType !== undefined) {
      current = def.innerType
      continue
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Plain-value helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural deep-equality over JSON-shaped values (defaults are JSON data). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function isElided(key: string, opts: DenseOptions): boolean {
  return key === ELIDED_KEY && opts.keepEvidence !== true
}

// ---------------------------------------------------------------------------
// Schema-free strip (used where no schema is available — e.g. `z.unknown()` data)
// ---------------------------------------------------------------------------

/**
 * Reduce a value with no schema to lean on: drop `evidence` keys (unless
 * `keepEvidence`) and drop every `null` value, recursing through arrays and
 * plain objects. Used for the envelope's `data` when no data schema is supplied
 * and for `z.unknown()`/`z.any()` sub-schemas, where defaults cannot be known.
 */
export function stripAgnostic(value: unknown, opts: DenseOptions = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => stripAgnostic(item, opts))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (isElided(k, opts)) continue
      if (v === null) continue
      out[k] = stripAgnostic(v, opts)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Schema-driven densify
// ---------------------------------------------------------------------------

/**
 * Densify a value against its Zod schema: drop keys equal to their field
 * default, drop schema-absence-safe `null`s, elide `evidence` (unless
 * `keepEvidence`), recursing through objects, arrays, and records. Returns a
 * NEW plain value; the input is never mutated. For a canonical parsed payload
 * with `keepEvidence: true`, `schema.parse(densifyValue(schema, x))` deep-equals
 * `x` (the AC-6-4 round-trip guarantee).
 */
export function densifyValue(schema: z.ZodType, value: unknown, opts: DenseOptions = {}): unknown {
  const { core } = peel(schema)
  const def = defOf(core)

  switch (def.type) {
    case 'object':
      return def.shape !== undefined ? densifyObject(def.shape, value, opts) : value
    case 'array':
      if (!Array.isArray(value) || def.element === undefined) return value
      return value.map((item) => densifyValue(def.element as z.ZodType, item, opts))
    case 'record':
      if (!isPlainObject(value) || def.valueType === undefined) return value
      return densifyRecord(def.valueType, value, opts)
    case 'unknown':
    case 'any':
      return stripAgnostic(value, opts)
    default:
      // Primitives, enums, literals, unions: no structure to reduce.
      return value
  }
}

/**
 * Densify one object against a Zod object's field schemas. Each present key is
 * either dropped (elided evidence, default-equal, or absence-safe null) or
 * recursively densified against its field schema. Keys not in the schema shape
 * are passed through {@link stripAgnostic} (dropping their nulls/evidence).
 */
function densifyObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: unknown,
  opts: DenseOptions,
): unknown {
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (isElided(k, opts)) continue
    const field = shape[k]
    if (field === undefined) {
      // Extra key with no field schema: strip agnostically, drop bare nulls.
      if (v === null) continue
      out[k] = stripAgnostic(v, opts)
      continue
    }
    const { hasDefault, defaultValue } = peel(field)
    if (hasDefault && deepEqual(v, defaultValue)) continue
    if (v === null && absenceAllowed(field)) continue
    out[k] = densifyValue(field, v, opts)
  }
  return out
}

/**
 * Densify a record's entry VALUES against the record's value schema. Entry KEYS
 * (e.g. requirement UUIDs) are preserved — a record has no per-key default, so
 * the reduction applies inside each value, never to the map's membership.
 */
function densifyRecord(
  valueType: z.ZodType,
  value: Record<string, unknown>,
  opts: DenseOptions,
): unknown {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = densifyValue(valueType, v, opts)
  }
  return out
}

// ---------------------------------------------------------------------------
// Envelope-level helpers
// ---------------------------------------------------------------------------

/**
 * Densify a whole AC-6-2 envelope. The `apiVersion`/`type` header is preserved
 * verbatim; a SUCCESS envelope's `data` is densified against `dataSchema` when
 * supplied (or stripped agnostically when not, since the envelope types `data`
 * as `z.unknown()`); an ERROR envelope is densified against
 * {@link ErrorEnvelopeSchema}. Returns a new envelope object that still
 * validates against the same success/error envelope schema as its input.
 */
export function densifyEnvelope<T>(
  env: Envelope<T>,
  dataSchema?: z.ZodType,
  opts: DenseOptions = {},
): Envelope<unknown> {
  if (env.type === 'error') {
    return densifyValue(ErrorEnvelopeSchema, env, opts) as ErrorEnvelope
  }
  // `type` is a plain `string` on the success shape (the closed enum is
  // AC-6-13), so it does not discriminate `'error'` away structurally; the
  // guard above did that operationally, leaving a success envelope here.
  const ok = env as SuccessEnvelope<T>
  const data =
    dataSchema !== undefined
      ? densifyValue(dataSchema, ok.data, opts)
      : stripAgnostic(ok.data, opts)
  const dense: SuccessEnvelope<unknown> = {
    apiVersion: ok.apiVersion,
    type: ok.type,
    data,
  }
  return dense
}

/** Minified JSON serialization: no pretty-print whitespace. The dense wire form. */
export function minifyJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * The `--dense` output for an envelope: densify it (per {@link densifyEnvelope})
 * then serialize minified. This is the single call the CLI surface makes when
 * `--dense` is passed; `--evidence` maps to `{ keepEvidence: true }`.
 */
export function denseEnvelope<T>(
  env: Envelope<T>,
  dataSchema?: z.ZodType,
  opts: DenseOptions = {},
): string {
  return minifyJson(densifyEnvelope(env, dataSchema, opts))
}
