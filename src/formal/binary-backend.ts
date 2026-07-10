/**
 * Optional binary solver backend — discovery + cross-check (AC-4-9, AC-4-10).
 *
 * symspec's default formal tier runs entirely in-process via WASM Z3
 * (`backend.ts`, AC-4-1) and never requires an external `z3`/`cvc5`
 * executable. This module is the *optional* escape hatch: given the portable
 * `.smt2` artifact `emit-smt2.ts` produces (AC-4-8), it discovers a system
 * solver binary and runs that artifact through it as a cross-check —
 * "both solvers agree" is cheap to offer because the emitted artifact is
 * already standard SMT-LIB2 (research-smt.md §2.2, §3.2; explore-surface.md
 * §4).
 *
 * Discovery order (AC-4-9), verbatim from the spec: `--solver-path` (an
 * explicit CLI flag value) → the `SYMSPEC_Z3` env var → a discoverable
 * `z3`/`cvc5` on PATH (tried in that order). Each of the three sources is
 * consulted in turn — the FIRST one that is actually *supplied* (non-empty)
 * is authoritative: if the operator explicitly passes `--solver-path` (or
 * sets `SYMSPEC_Z3`) to a binary that turns out not to work, that is the
 * failure — this module does NOT silently fall through to a lower-precedence
 * source, because doing so would hide an operator misconfiguration behind an
 * unrelated binary. This mirrors the doc-path resolution precedence elsewhere
 * in symspec v2 (positional arg → `SYMSPEC_DOC` env → default): "first
 * defined source wins," not "first working source wins." Only the
 * PATH tier — which has no explicit operator input to honor — tries both
 * `z3` and `cvc5` before giving up.
 *
 * `discoverSolverBinary` throws {@link BinaryBackendError} with
 * `ERR_SOLVER_MISSING` when no source resolves (AC-4-10), carrying the exact
 * `mise use github:Z3Prover/z3@z3-4.16.0` install command as its suggestion.
 * `probeSolverBinary` is the non-throwing sibling — the shape `manifest
 * --backends` (AC-6-14) needs to report binary-backend availability without
 * ever failing the manifest command itself, mirroring `backend.ts`'s
 * `probeBackend()` convention exactly.
 *
 * `runSolverBinary` spawns the discovered binary against an emitted `.smt2`
 * artifact and parses its `sat`/`unsat`/`unknown` verdict plus (on `unsat`)
 * the unsat-core requirement ids off stdout — the same two-line shape
 * `research-smt.md §2.2` documents and `emit-smt2.test.ts`'s standard-reader
 * smoke test already exercises manually. A non-zero exit code is NOT treated
 * as a hard failure: both z3 and cvc5 legitimately exit non-zero in cases
 * that are not solver-invocation errors (e.g. z3 exits non-zero when
 * `(get-unsat-core)` follows a `sat` result, since a core is only available
 * on `unsat` — verified live, see `emit-smt2.test.ts`'s `runZ3` comment).
 * Only stdout content is parsed.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Which solver family a discovered/configured binary belongs to. */
export type SolverKind = 'z3' | 'cvc5'

/** Which discovery source resolved a binary (AC-4-9's precedence order). */
export type SolverDiscoverySource = 'solver-path' | 'SYMSPEC_Z3' | 'PATH'

export const BINARY_BACKEND_ERROR_CODES = ['ERR_SOLVER_MISSING'] as const
export type BinaryBackendErrorCode = (typeof BINARY_BACKEND_ERROR_CODES)[number]

/**
 * Thrown by {@link discoverSolverBinary} when no binary backend can be
 * resolved (AC-4-10). Carries the same `{error, code, suggestions}` shape as
 * the sibling `DocLoadError`/`LeanDiscoveryError` classes so the CLI
 * error-envelope layer (AC-6-2/AC-6-10) can handle it uniformly.
 */
export class BinaryBackendError extends Error {
  readonly code: BinaryBackendErrorCode
  readonly suggestions: string[]

  constructor(message: string, suggestions: string[]) {
    super(message)
    this.name = 'BinaryBackendError'
    this.code = 'ERR_SOLVER_MISSING'
    this.suggestions = suggestions
  }
}

/**
 * The exact install command AC-4-10 requires in the `ERR_SOLVER_MISSING`
 * suggestion. Verbatim — do not reword the command itself.
 */
const MISE_INSTALL_SUGGESTION =
  'Run `mise use github:Z3Prover/z3@z3-4.16.0` to install a z3 solver binary.'

function missingSolverError(): BinaryBackendError {
  return new BinaryBackendError(
    'No z3/cvc5 solver binary found via --solver-path, SYMSPEC_Z3, or PATH.',
    [MISE_INSTALL_SUGGESTION],
  )
}

/** Infer the solver family from an executable's basename (`cvc5` vs everything else → `z3`). */
function inferKind(bin: string): SolverKind {
  const base = bin.split(/[\\/]/).pop() ?? bin
  return /cvc5/i.test(base) ? 'cvc5' : 'z3'
}

/**
 * Probe one candidate executable via `<bin> --version`. `env` is threaded
 * through explicitly (rather than relying on ambient `process.env`) so
 * discovery is fully sandboxable in tests — the same `env` also gates PATH
 * resolution for the child process itself, not just the `SYMSPEC_Z3` lookup.
 */
function probeExecutable(
  bin: string,
  env: NodeJS.ProcessEnv,
): { ok: true; version: string } | { ok: false } {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  if (result.error || result.status !== 0) return { ok: false }
  return { ok: true, version: (result.stdout ?? '').trim() }
}

/** Options for {@link discoverSolverBinary} / {@link probeSolverBinary}. */
export interface DiscoverSolverBinaryOptions {
  /** The `--solver-path` CLI flag value, if the operator supplied one. Highest precedence. */
  solverPath?: string
  /**
   * Environment to resolve `SYMSPEC_Z3` from and to run child-process
   * discovery under (its `PATH` gates the PATH tier). Defaults to
   * `process.env`; tests inject a sandboxed environment to make discovery
   * deterministic regardless of the host's real PATH.
   */
  env?: NodeJS.ProcessEnv
}

/** A resolved binary solver backend, ready for {@link runSolverBinary}. */
export interface DiscoveredSolver {
  /** The resolved executable — a bare PATH-relative name, or the exact path an operator supplied. */
  bin: string
  /** The solver family, inferred from the executable name. */
  kind: SolverKind
  /** `<bin> --version` stdout, trimmed. */
  version: string
  /** Which discovery source resolved this binary. */
  source: SolverDiscoverySource
}

/**
 * Resolve a binary solver backend by the AC-4-9 discovery order:
 * `--solver-path` → `SYMSPEC_Z3` → PATH (`z3` then `cvc5`).
 *
 * Throws {@link BinaryBackendError} (`ERR_SOLVER_MISSING`) when the
 * highest-precedence *supplied* source does not resolve, or when none of
 * the three sources resolves at all (AC-4-10).
 */
export function discoverSolverBinary(options: DiscoverSolverBinaryOptions = {}): DiscoveredSolver {
  const env = options.env ?? process.env

  if (options.solverPath !== undefined && options.solverPath !== '') {
    const probe = probeExecutable(options.solverPath, env)
    if (!probe.ok) throw missingSolverError()
    return {
      bin: options.solverPath,
      kind: inferKind(options.solverPath),
      version: probe.version,
      source: 'solver-path',
    }
  }

  const envPath = env.SYMSPEC_Z3
  if (envPath !== undefined && envPath !== '') {
    const probe = probeExecutable(envPath, env)
    if (!probe.ok) throw missingSolverError()
    return { bin: envPath, kind: inferKind(envPath), version: probe.version, source: 'SYMSPEC_Z3' }
  }

  for (const candidate of ['z3', 'cvc5'] as const) {
    const probe = probeExecutable(candidate, env)
    if (probe.ok) {
      return { bin: candidate, kind: candidate, version: probe.version, source: 'PATH' }
    }
  }

  throw missingSolverError()
}

/**
 * Non-throwing sibling of {@link discoverSolverBinary} — used by `manifest
 * --backends` (AC-6-14) to report binary-backend availability/path/version
 * without ever failing the manifest command when no binary is installed,
 * mirroring `backend.ts`'s `probeBackend()` convention.
 */
export function probeSolverBinary(
  options: DiscoverSolverBinaryOptions = {},
): ({ available: true } & DiscoveredSolver) | { available: false; error: string } {
  try {
    const discovered = discoverSolverBinary(options)
    return { available: true, ...discovered }
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Options for {@link runSolverBinary}. */
export interface RunSolverBinaryOptions {
  /**
   * Overall wall-clock budget in ms, mapped to the binary's own timeout flag
   * (research-smt.md §2.2: z3's `-T:<seconds>`, cvc5's `--tlimit=<ms>`).
   * Omitted (default) passes no timeout flag.
   */
  timeoutMs?: number
}

/** The parsed verdict of running an emitted `.smt2` artifact through a binary backend. */
export interface BinaryCheckResult {
  status: 'sat' | 'unsat' | 'unknown'
  /** Unsat-core requirement/guard ids, in the order the solver printed them. `[]` unless `status === 'unsat'`. */
  core: string[]
}

/** Build the timeout argv fragment for a given solver kind (empty when no timeout is requested). */
function timeoutArgs(kind: SolverKind, timeoutMs: number | undefined): string[] {
  if (timeoutMs === undefined) return []
  if (kind === 'z3') {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    return [`-T:${seconds}`]
  }
  return [`--tlimit=${timeoutMs}`]
}

/** Parse the `(get-unsat-core)` s-expression line into its space-separated member names. */
function parseCoreLine(line: string | undefined): string[] {
  if (line === undefined) return []
  const inner = line.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  if (inner.length === 0) return []
  return inner.split(/\s+/)
}

/**
 * Run an emitted `.smt2` artifact (AC-4-8) through a discovered binary
 * backend and parse its verdict (AC-4-9). Writes the artifact to a scratch
 * temp file (cleaned up unconditionally), spawns the binary against it, and
 * parses stdout's `sat`/`unsat`/`unknown` line plus, on `unsat`, the
 * following unsat-core line.
 *
 * Never throws on a non-zero exit code — see the module-level doc comment
 * for why that is expected solver behavior, not an invocation failure. A
 * spawn failure (e.g. the binary vanished between discovery and this call)
 * degrades to `{ status: 'unknown', core: [] }` rather than throwing, since
 * discovery has already validated the executable once; callers treat
 * `unknown` as inconclusive regardless of cause (AC-4-7).
 */
export function runSolverBinary(
  smt2: string,
  discovered: DiscoveredSolver,
  options: RunSolverBinaryOptions = {},
): BinaryCheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'symspec-binary-backend-'))
  const file = join(dir, 'artifact.smt2')
  try {
    writeFileSync(file, smt2, 'utf8')
    const args = [...timeoutArgs(discovered.kind, options.timeoutMs), file]
    const result = spawnSync(discovered.bin, args, { encoding: 'utf8' })

    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const statusLine = lines[0]
    const status: BinaryCheckResult['status'] =
      statusLine === 'sat' || statusLine === 'unsat' ? statusLine : 'unknown'
    const core = status === 'unsat' ? parseCoreLine(lines[1]) : []

    return { status, core }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
