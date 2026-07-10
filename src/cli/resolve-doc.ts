/**
 * Document-path resolution (AC-6-6): the ONE place every document-bound
 * command decides which requirements file it operates on, so the path
 * convention is unified across the whole CLI surface.
 *
 * ## Precedence (normative, AC-6-6)
 *
 * 1. positional `<file>` argument — explicit always wins;
 * 2. `SYMSPEC_DOC` environment variable;
 * 3. the default path {@link DEFAULT_DOC_PATH} (`./requirements.json`).
 *
 * An empty or whitespace-only value at any source is treated as ABSENT (an
 * agent exporting `SYMSPEC_DOC=""` means "unset", not "the file named empty
 * string"), so resolution falls through to the next source.
 *
 * ## `ERR_DOC_NOT_FOUND`
 *
 * Resolution is split into two layers so callers can use either:
 *
 * - {@link resolveDocPath} — pure precedence, no filesystem access. Always
 *   succeeds; reports which source won via `source`.
 * - {@link resolveDoc} — resolves AND requires the file to exist. If the
 *   chosen path does not point at an existing file, it throws
 *   {@link DocResolveError} (`ERR_DOC_NOT_FOUND`) carrying the Appendix-A
 *   suggestions (run `symspec init <file>`; check `SYMSPEC_DOC`).
 *   {@link docNotFoundEnvelope} lifts that error into the typed CLI error
 *   envelope (AC-6-2) for the output layer.
 *
 * `DocResolveError` carries the same `{code, suggestions}` shape as
 * `DocLoadError` (`core/load.ts`) and `IoError` (`core/storage.ts`), so the
 * envelope layer handles all three uniformly.
 *
 * Scope note: the suggestions here point at `symspec init` / `SYMSPEC_DOC`.
 *
 * Cite: AC-6-6 (positional → SYMSPEC_DOC → default; nonexistent →
 * ERR_DOC_NOT_FOUND); Appendix A `ERR_DOC_NOT_FOUND` row (spec.md);
 * explore-surface.md §1; orchestrator decision 7.
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { type ErrorEnvelope, failure } from './envelope.js'

/**
 * The default document path when neither a positional `<file>` nor
 * `SYMSPEC_DOC` is supplied. Relative to the process working directory.
 */
export const DEFAULT_DOC_PATH = './requirements.json'

/** The environment variable consulted at precedence step 2. */
export const DOC_ENV_VAR = 'SYMSPEC_DOC'

/** Which precedence source produced the resolved path. */
export type DocPathSource = 'positional' | 'env' | 'default'

/** A resolved document path plus the source that won the precedence. */
export interface ResolvedDocPath {
  /** Absolute path to the document (relative inputs resolved against `cwd`). */
  readonly path: string
  /** Which precedence source supplied the path. */
  readonly source: DocPathSource
}

/** Options for {@link resolveDocPath} / {@link resolveDoc}. */
export interface ResolveDocOptions {
  /**
   * The positional `<file>` argument, when the invocation supplied one.
   * Omit the key entirely (never pass `undefined` explicitly is fine too —
   * both mean "not supplied") when absent.
   */
  readonly positional?: string
  /**
   * Environment map to consult for {@link DOC_ENV_VAR}. Defaults to
   * `process.env`; injectable for tests.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Base directory for resolving relative paths (and the default path).
   * Defaults to `process.cwd()`; injectable for tests.
   */
  readonly cwd?: string
}

/** Treat empty / whitespace-only values as absent so precedence falls through. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/**
 * Resolve the document path by pure precedence — positional `<file>` →
 * `SYMSPEC_DOC` env → {@link DEFAULT_DOC_PATH} — without touching the
 * filesystem. Always succeeds. Relative paths (including the default) are
 * resolved to absolute against `cwd`.
 */
export function resolveDocPath(options: ResolveDocOptions = {}): ResolvedDocPath {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env

  if (present(options.positional)) {
    return { path: absolutize(options.positional, cwd), source: 'positional' }
  }
  const fromEnv = env[DOC_ENV_VAR]
  if (present(fromEnv)) {
    return { path: absolutize(fromEnv, cwd), source: 'env' }
  }
  return { path: absolutize(DEFAULT_DOC_PATH, cwd), source: 'default' }
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export const DOC_RESOLVE_ERROR_CODES = ['ERR_DOC_NOT_FOUND'] as const
export type DocResolveErrorCode = (typeof DOC_RESOLVE_ERROR_CODES)[number]

/**
 * Thrown by {@link resolveDoc} when the path chosen by the AC-6-6 precedence
 * does not point at an existing file. Same `{code, suggestions}` shape as
 * `DocLoadError`/`IoError` so the CLI envelope layer handles it uniformly;
 * {@link docNotFoundEnvelope} performs that lift.
 */
export class DocResolveError extends Error {
  readonly code: DocResolveErrorCode
  readonly suggestions: string[]
  /** The absolute path that failed to resolve to an existing document. */
  readonly path: string
  /** Which precedence source chose the failing path. */
  readonly source: DocPathSource

  constructor(resolved: ResolvedDocPath) {
    super(
      `No requirements document found at ${resolved.path} (resolved from ${describeSource(resolved.source)}).`,
    )
    this.name = 'DocResolveError'
    this.code = 'ERR_DOC_NOT_FOUND'
    this.path = resolved.path
    this.source = resolved.source
    this.suggestions = [
      `Run \`symspec init ${resolved.path}\` to create the document.`,
      `Check that the ${DOC_ENV_VAR} environment variable points at an existing file.`,
    ]
  }
}

function describeSource(source: DocPathSource): string {
  switch (source) {
    case 'positional':
      return 'the positional <file> argument'
    case 'env':
      return `the ${DOC_ENV_VAR} environment variable`
    case 'default':
      return `the default path ${DEFAULT_DOC_PATH}`
  }
}

/**
 * Resolve the document path (AC-6-6 precedence) AND require it to exist as a
 * file. This is the entry point document-bound commands call.
 *
 * @throws {DocResolveError} `ERR_DOC_NOT_FOUND` when nothing exists at the
 *   resolved path (or the path names a directory, which is equally not a
 *   document).
 */
export function resolveDoc(options: ResolveDocOptions = {}): ResolvedDocPath {
  const resolved = resolveDocPath(options)
  if (!existsSync(resolved.path) || !statSync(resolved.path).isFile()) {
    throw new DocResolveError(resolved)
  }
  return resolved
}

/**
 * Lift a {@link DocResolveError} into the typed CLI error envelope (AC-6-2):
 * `{ apiVersion, type:'error', error, code:'ERR_DOC_NOT_FOUND', suggestions }`.
 * No `partial` — there is nothing to salvage from a missing file.
 */
export function docNotFoundEnvelope(err: DocResolveError): ErrorEnvelope {
  return failure({
    error: err.message,
    code: err.code,
    suggestions: err.suggestions,
  })
}
