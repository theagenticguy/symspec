/**
 * Output rendering (AC-6-2a): the typed JSON envelope is the DEFAULT output for
 * every command, and a human-readable prose rendering is opt-in ONLY via an
 * explicit `--pretty` (alias `--human`) flag.
 *
 * ## Why JSON is the zero-flag default
 *
 * An agent driving the CLI must never remember a flag to obtain parseable
 * output, and there is no human-eyes-only escape hatch that yields prose by
 * default. So with no flags, {@link resolveOutputMode} selects `'json'` and
 * {@link renderEnvelope} serializes the {@link Envelope} straight to
 * pretty-printed JSON (2-space indent). `--dense` (AC-6-4) minifies that same
 * JSON; this module emits the readable-JSON default and does not own `--dense`.
 *
 * ## `--json` is a no-op compatibility alias
 *
 * Any `--json` token that appears in help text or other ACs selects the
 * already-default JSON envelope — it is never a gate that must be passed to get
 * JSON. Passing `--json` therefore produces BYTE-IDENTICAL output to passing no
 * flag at all: both resolve to `'json'`.
 *
 * ## `--pretty` / `--human` opt into prose
 *
 * Only an explicit `--pretty` (or its alias `--human`) selects the `'pretty'`
 * mode, in which {@link renderEnvelope} produces human-readable prose instead of
 * JSON. Prose is deliberately NOT valid JSON, so a consumer can never confuse
 * the two modes.
 *
 * ## Scope boundary
 *
 * This module owns only the mapping from output flags to a rendered string. It
 * does not set the process exit code (AC-6-2b, `cli/exit.ts`), minify or elide
 * fields (AC-6-4, `cli/dense.ts`), or build the envelopes themselves (AC-6-2,
 * `cli/envelope.ts`) — it renders envelopes those tasks produce.
 *
 * Cite: AC-6-2a (JSON default; `--pretty`/`--human` opt-in; `--json` no-op
 * alias); AC-6-2 (the envelope shapes this renders); orchestrator decision 7.
 */

import type { Envelope, ErrorEnvelope } from './envelope.js'

// ---------------------------------------------------------------------------
// Output mode + flag resolution
// ---------------------------------------------------------------------------

/**
 * The two rendering modes. `'json'` is the zero-flag default (and what `--json`
 * selects); `'pretty'` is opt-in via `--pretty`/`--human`.
 */
export type OutputMode = 'json' | 'pretty'

/**
 * The output-selecting flags a command may carry. All optional and default to
 * unset, per `exactOptionalPropertyTypes` — an absent flag is simply not set.
 * `json` is the no-op compatibility alias; `pretty`/`human` are the prose
 * opt-in (aliases of each other).
 */
export interface OutputFlags {
  /** No-op compatibility alias for the default JSON output. */
  readonly json?: boolean
  /** Opt into human-readable prose. */
  readonly pretty?: boolean
  /** Alias of {@link OutputFlags.pretty}. */
  readonly human?: boolean
}

/**
 * Resolve the output mode from the command flags.
 *
 * `--pretty` or its alias `--human` selects `'pretty'`. Everything else —
 * including no flags at all and the no-op `--json` alias — selects the default
 * `'json'` mode. Because `--json` and no-flag both fall through to `'json'`,
 * their rendered output is byte-identical (AC-6-2a).
 */
export function resolveOutputMode(flags: OutputFlags = {}): OutputMode {
  if (flags.pretty === true || flags.human === true) return 'pretty'
  return 'json'
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render an {@link Envelope} to a string in the given mode (default `'json'`).
 *
 * In `'json'` mode the envelope is serialized to pretty-printed JSON with a
 * 2-space indent — the zero-flag default that keeps every command's output
 * machine-parseable. In `'pretty'` mode it is rendered to human-readable prose.
 */
export function renderEnvelope(env: Envelope, mode: OutputMode = 'json'): string {
  return mode === 'pretty' ? renderProse(env) : renderJson(env)
}

/**
 * Convenience: resolve the mode from {@link OutputFlags} and render in one call.
 * With no flags (or `--json`) this returns the default JSON; with `--pretty` /
 * `--human` it returns prose.
 */
export function formatEnvelope(env: Envelope, flags: OutputFlags = {}): string {
  return renderEnvelope(env, resolveOutputMode(flags))
}

/** Serialize an envelope to the default pretty-printed JSON (2-space indent). */
function renderJson(env: Envelope): string {
  return JSON.stringify(env, null, 2)
}

/** Type guard: an error envelope carries the literal `'error'` discriminant. */
function isError(env: Envelope): env is ErrorEnvelope {
  return env.type === 'error'
}

/**
 * Render an envelope to human-readable prose. The output is intentionally NOT
 * JSON, so a consumer cannot mistake `--pretty` output for the default machine
 * envelope.
 */
function renderProse(env: Envelope): string {
  return isError(env) ? renderErrorProse(env) : renderSuccessProse(env)
}

/** Prose for a success envelope: a header line plus the indented data payload. */
function renderSuccessProse(env: Envelope): string {
  const lines = [`${env.type} (apiVersion ${env.apiVersion})`]
  const body = renderValue((env as { data: unknown }).data, 1)
  if (body.length > 0) lines.push(body)
  return lines.join('\n')
}

/** Prose for an error envelope: message, code, suggestions, and any partial. */
function renderErrorProse(env: ErrorEnvelope): string {
  const lines = [`Error [${env.code}]: ${env.error}`]
  if (env.suggestions.length > 0) {
    lines.push('Suggestions:')
    for (const s of env.suggestions) lines.push(`  - ${s}`)
  }
  if (env.partial !== undefined) {
    lines.push('Recovered partial:')
    lines.push(renderValue(env.partial, 1))
  }
  return lines.join('\n')
}

const INDENT = '  '

/**
 * Recursively render an arbitrary JSON-ish value to indented prose lines. Kept
 * self-contained (no external pretty-printer) so prose output stays stable and
 * dependency-free.
 */
function renderValue(value: unknown, depth: number): string {
  const pad = INDENT.repeat(depth)

  if (value === null || value === undefined) return `${pad}(none)`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(empty)`
    return value
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          return `${pad}-\n${renderValue(item, depth + 1)}`
        }
        return `${pad}- ${scalar(item)}`
      })
      .join('\n')
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}(empty)`
    return keys
      .map((key) => {
        const v = value[key]
        if (isPlainObject(v) || Array.isArray(v)) {
          return `${pad}${key}:\n${renderValue(v, depth + 1)}`
        }
        return `${pad}${key}: ${scalar(v)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(value)}`
}

/** Render a scalar (string/number/boolean) for prose output. */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  return String(value)
}

/** Narrow to a plain record (object, not array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
