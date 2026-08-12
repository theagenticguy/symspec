/**
 * OUTPUT POST-PROCESSORS — `--pretty`, `--dense`, and `--field`.
 *
 * ## The one rule that makes these safe
 *
 * These are PURE ENVELOPE → STRING functions. They shape how a result is
 * DISPLAYED and nothing else: they never touch an operation's data, never
 * suppress output, and — structurally, not just by convention — cannot change the
 * exit code. `exitCodeForEnvelope` takes the ENVELOPE, and it is called on the
 * envelope BEFORE any of this runs, so a formatting flag has no channel through
 * which to reach it. That is the donor's `--dense` / `--field` contract preserved
 * exactly, and it is why `symspec check --pretty` and `symspec check` fail a CI
 * job identically.
 *
 * ## Why post-processors and not three renderers
 *
 * One {@link renderOutput} entry point resolves the flags in a fixed order, so
 * the modes compose predictably instead of racing:
 *
 *   1. `--field` PROJECTS first (it selects a subset of the envelope object),
 *   2. then `--dense` or `--pretty` RENDERS what survived.
 *
 * That order is the only one that composes: projecting after rendering would mean
 * walking rendered prose, and `--field data.x --dense` sensibly means "the dense
 * form of just that field". `--dense` and `--pretty` are mutually exclusive
 * (minified-for-machines vs prose-for-humans); dense wins if both are somehow
 * passed, because a machine consumer misreading prose is a harder failure than a
 * human squinting at JSON.
 *
 * ## JSON is the zero-flag default
 *
 * An agent must never have to remember a flag to get parseable output. With no
 * flags, {@link renderOutput} emits the same single-line JSON `renderEnvelope`
 * always did. `--pretty` is the opt-in human affordance, never the other way
 * round.
 */

import { type Envelope, type ErrorEnvelope, isErrorEnvelope, renderEnvelope } from './envelope.ts'

// ---------------------------------------------------------------------------
// The flag set
// ---------------------------------------------------------------------------

/**
 * The output-shaping flags every command accepts.
 *
 * Declared once here and attached to the root command as SHARED flags, so they
 * are available on every subcommand without any operation declaring them — they
 * are a property of the CLI surface, not of any use case, and putting them in an
 * operation's input schema would wrongly publish them in that operation's
 * manifest row as if they affected its behavior.
 */
export interface OutputFlags {
  /** Render human-readable prose instead of JSON. Opt-in; JSON is the default. */
  readonly pretty?: boolean
  /** Minify and elide heavy evidence. Machine-facing token economy. */
  readonly dense?: boolean
  /** Retain `evidence` under `--dense`. The escape hatch for a real
   * investigation. */
  readonly evidence?: boolean
  /** Comma-separated dotted paths to project. `null`/absent means no projection. */
  readonly field?: string | null
}

// ---------------------------------------------------------------------------
// --field: dotted-path projection
// ---------------------------------------------------------------------------

/**
 * Split a raw `--field` value into individual dotted paths. Blank segments are
 * dropped, so `--field 'data.a, ,data.b'` is two paths rather than an error — a
 * projection is a display convenience and should not fail a command over
 * whitespace.
 */
export const parseFieldPaths = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

/** Narrow to a plain record (object, not array, not null). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Resolve one dotted path, honoring a numeric segment as an array index
 * (`data.findings.0.code`).
 *
 * Returns `{found: false}` rather than `undefined` for a missing key so the
 * caller can distinguish "this path resolved to `undefined`" from "this path did
 * not resolve" and OMIT the latter — absence is absence, per the same
 * `exactOptionalPropertyTypes` discipline the envelope follows.
 */
const resolvePath = (
  root: unknown,
  segments: readonly string[],
): { readonly found: boolean; readonly value?: unknown } => {
  let current: unknown = root
  for (const seg of segments) {
    if (Array.isArray(current)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return { found: false }
      current = current[idx]
      continue
    }
    if (isPlainObject(current)) {
      if (!Object.hasOwn(current, seg)) return { found: false }
      current = current[seg]
      continue
    }
    // A scalar with path segments remaining: cannot descend further.
    return { found: false }
  }
  return { found: true, value: current }
}

/** Set `value` at the nested location named by `segments`, creating intermediate
 * objects. Numeric segments nest as STRING keys: the projection mirrors the
 * requested path shape rather than reconstructing arrays, which keeps it
 * self-describing and lets overlapping paths merge. */
const setNested = (
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void => {
  let cursor = target
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string
    const existing = cursor[key]
    if (isPlainObject(existing)) {
      cursor = existing
    } else {
      const next: Record<string, unknown> = {}
      cursor[key] = next
      cursor = next
    }
  }
  const last = segments[segments.length - 1]
  if (last !== undefined) cursor[last] = value
}

/**
 * Project a value down to just the requested dotted paths, returning a NEW nested
 * object mirroring them.
 *
 * The result NESTS (so `data.verified` lands at `{data:{verified:…}}`) rather than
 * flattening to `{verified:…}`, for two reasons: an agent can see where each value
 * came from, and multiple overlapping paths merge cleanly instead of colliding on
 * a shared leaf name.
 *
 * A path that does not resolve is OMITTED, and a projection where nothing resolved
 * is `{}` — a truthful "nothing matched" rather than an error, so projecting over
 * an unexpected envelope shape never throws.
 */
export const projectFields = (root: unknown, paths: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = path.split('.').filter((s) => s.length > 0)
    if (segments.length === 0) continue
    const resolved = resolvePath(root, segments)
    if (resolved.found) setNested(out, segments, resolved.value)
  }
  return out
}

// ---------------------------------------------------------------------------
// --dense: minify + elide
// ---------------------------------------------------------------------------

/**
 * The field name elided under `--dense` unless `--evidence` is passed.
 *
 * The formal tier's `evidence` payload (the atom table plus the unsat core or
 * witness) is by far the heaviest thing an envelope carries, and an agent in a
 * fix loop reads `code` and `suggestions`, not the proof. `atomTable` travels
 * INSIDE `evidence`, so eliding this one key removes it too.
 */
export const ELIDED_KEY = 'evidence'

/**
 * The dense projection: drop `evidence` (unless kept) and drop every `null`,
 * recursing through arrays and plain objects.
 *
 * ## Why dropping nulls is information-preserving here, and where the boundary is
 *
 * Every optional field in this codebase is an ABSENT KEY, never `null` — the
 * `exactOptionalPropertyTypes` discipline holds all the way out to the wire, and
 * `failure()` builds optional envelope keys by conditional spread precisely so
 * `{partial: undefined}` never serializes. So a `null` in a CANONICAL envelope
 * does not occur, and dropping one cannot lose information a consumer relied on.
 *
 * Eliding `evidence` IS deliberately lossy — shedding those bytes is the entire
 * point — so a dense envelope is a valid SMALLER envelope, not a byte-equal one.
 * That is the same boundary the donor drew, stated here rather than discovered.
 *
 * ## Field NAMES are never abbreviated
 *
 * Renaming keys would force an agent to learn a second vocabulary and would break
 * the guarantee that dense output validates against the same contract as default
 * output. Dense is a smaller instance of ONE format, not a second dialect.
 *
 * ## What is deliberately NOT implemented yet
 *
 * The donor also dropped keys equal to their SCHEMA DEFAULT, which it could do
 * because every payload had a Zod schema to consult. G1's operations do not
 * declare OUTPUT schemas (only input ones), so there is no default table to read
 * and guessing one would be exactly the kind of hand-maintained parallel corpus
 * this kernel exists to avoid. The reduction lands when output schemas do, in G2.
 * Until then `--dense` is honestly two reductions, not three.
 */
export const densifyValue = (value: unknown, keepEvidence: boolean): unknown => {
  if (Array.isArray(value)) return value.map((item) => densifyValue(item, keepEvidence))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === ELIDED_KEY && !keepEvidence) continue
      if (v === null) continue
      out[k] = densifyValue(v, keepEvidence)
    }
    return out
  }
  return value
}

/** Minified JSON: no pretty-print whitespace. The dense wire form. */
export const minifyJson = (value: unknown): string => JSON.stringify(value)

// ---------------------------------------------------------------------------
// --pretty: prose
// ---------------------------------------------------------------------------

const INDENT = '  '

/**
 * Render a scalar for prose output. Strings appear UNQUOTED — prose is for a
 * human, and quoting every string is JSON's job, not prose's.
 *
 * `null` and `undefined` render as `(none)`, the SAME token
 * {@link renderValue} uses for an absent value at any other position. Without
 * this, a null LEAF took `String(null)` and printed the literal `null` while a
 * null at the top of a subtree printed `(none)` — two spellings for one fact,
 * which is exactly the kind of small inconsistency a human report cannot afford.
 * (Caught by `output.test.ts` rather than by reading the code.)
 */
const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return NONE
  return typeof value === 'string' ? value : String(value)
}

/** The single spelling for "no value" in prose output. */
const NONE = '(none)'

/** The single spelling for "present but empty" in prose output. */
const EMPTY = '(empty)'

/**
 * Recursively render a JSON-ish value as indented prose lines.
 *
 * Self-contained on purpose (no pretty-printer dependency) so prose output is
 * stable across releases and cannot change because a transitive dependency did.
 * `(none)` and `(empty)` are spelled out rather than left blank, because a blank
 * line in a human report is ambiguous between "no value" and "a bug".
 */
const renderValue = (value: unknown, depth: number): string => {
  const pad = INDENT.repeat(depth)
  if (value === null || value === undefined) return `${pad}${NONE}`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${EMPTY}`
    return value
      .map((item) =>
        isPlainObject(item) || Array.isArray(item)
          ? `${pad}-\n${renderValue(item, depth + 1)}`
          : `${pad}- ${scalar(item)}`,
      )
      .join('\n')
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}${EMPTY}`
    return keys
      .map((key) => {
        const v = value[key]
        return isPlainObject(v) || Array.isArray(v)
          ? `${pad}${key}:\n${renderValue(v, depth + 1)}`
          : `${pad}${key}: ${scalar(v)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(value)}`
}

/** Prose for a success envelope: a header line naming the type, then the payload. */
const renderSuccessProse = (env: Envelope): string => {
  const header = `${env.type} (apiVersion ${env.apiVersion})`
  const body = renderValue((env as { readonly data: unknown }).data, 1)
  return body.length > 0 ? `${header}\n${body}` : header
}

/** Prose for an error envelope: the code and message first, since that is what a
 * human reading a failure needs in the first line. */
const renderErrorProse = (env: ErrorEnvelope): string => {
  const out = [`Error [${env.code}]: ${env.error}`]
  if (env.suggestions.length > 0) {
    out.push('Suggestions:')
    for (const s of env.suggestions) out.push(`  - ${s}`)
  }
  if (env.partial !== undefined) {
    out.push('Recovered partial:')
    out.push(renderValue(env.partial, 1))
  }
  if (env.repair !== undefined) {
    if (env.repair.commands.length > 0) {
      out.push('Repair — run:')
      for (const c of env.repair.commands) out.push(`  ${c}`)
    }
    if (env.repair.ops.length > 0) {
      out.push(`Repair — ${env.repair.ops.length} op record(s) to pipe into \`symspec import\`:`)
      for (const op of env.repair.ops) out.push(`  ${JSON.stringify(op)}`)
    }
  }
  return out.join('\n')
}

/**
 * Render an envelope as human prose.
 *
 * Intentionally NOT valid JSON, so a consumer can never mistake `--pretty` output
 * for the machine envelope. That is a feature: a script that accidentally passes
 * `--pretty` fails loudly at its JSON parse instead of silently reading prose as
 * data.
 */
export const renderProse = (env: Envelope): string =>
  isErrorEnvelope(env) ? renderErrorProse(env) : renderSuccessProse(env)

// ---------------------------------------------------------------------------
// The single entry point
// ---------------------------------------------------------------------------

/**
 * Render an envelope for output, applying the flags in the one order that
 * composes: PROJECT (`--field`), then RENDER (`--dense` / `--pretty` / default
 * JSON).
 *
 * Pure. Takes the envelope and the flags, returns a string. It cannot reach the
 * exit code because it is not given one — the code is computed from the envelope
 * elsewhere, which is what makes "output flags never change the exit code" a
 * structural property rather than a promise.
 *
 * A `--field` projection is rendered as JSON even under `--pretty`, because a
 * projection's whole purpose is to feed a value to something; prose-wrapping a
 * single extracted number would defeat it. Dense still minifies it.
 */
export const renderOutput = (env: Envelope, flags: OutputFlags = {}): string => {
  const raw = flags.field
  if (raw !== null && raw !== undefined && raw.trim().length > 0) {
    const projected = projectFields(env, parseFieldPaths(raw))
    return flags.dense === true
      ? minifyJson(densifyValue(projected, flags.evidence === true))
      : JSON.stringify(projected)
  }
  if (flags.dense === true) return minifyJson(densifyValue(env, flags.evidence === true))
  if (flags.pretty === true) return renderProse(env)
  return renderEnvelope(env)
}
