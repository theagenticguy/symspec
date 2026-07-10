/**
 * Lean 4 toolchain discovery (AC-5-4).
 *
 * Before `symspec certify` attempts to run a `.lean` file through the Lean
 * type-checker, this module probes for a discoverable `lean` executable on
 * PATH and returns a structured error if none is found.
 *
 * The discovery is defensive — a simple spawn attempt with `--version`, so
 * even a misconfigured PATH or permission issue is caught early and surfaced
 * as `ERR_LEAN_TOOLCHAIN_MISSING` with actionable guidance rather than a
 * cryptic spawn error downstream in {@link runLean}.
 *
 * Discovery is NOT invoked during `symspec check` (the default SMT tier runs
 * with no Lean dependency, per AC-5-5). It fires only when `--certify` is
 * explicitly requested, and NEVER blocks the prior SMT result — the certify
 * tier is optional (research-lean4.md §4 Tier L).
 *
 * Rationale/cite: research-lean4.md §1.3 "symspec's doctor/manifest command
 * should report Lean as optional, not installed … and return
 * ERR_LEAN_TOOLCHAIN_MISSING with that suggestion when --certify is
 * requested without it."
 */

import { spawnSync } from 'node:child_process'

export const LEAN_DISCOVERY_ERROR_CODES = ['ERR_LEAN_TOOLCHAIN_MISSING'] as const
export type LeanDiscoveryErrorCode = (typeof LEAN_DISCOVERY_ERROR_CODES)[number]

/**
 * Error type for Lean toolchain discovery failures (AC-5-4).
 * Carries the same `{error, code, suggestions}` shape as DocLoadError
 * ({@link DocLoadError}) so the CLI envelope layer can handle it uniformly
 * (Wave 6 / AC-6-10).
 */
export class LeanDiscoveryError extends Error {
  readonly code: LeanDiscoveryErrorCode
  readonly suggestions: string[]

  constructor(message: string, suggestions: string[]) {
    super(message)
    this.name = 'LeanDiscoveryError'
    this.code = 'ERR_LEAN_TOOLCHAIN_MISSING'
    this.suggestions = suggestions
  }
}

/**
 * The canonical suggestion for installing a Lean toolchain via elan.
 * Elan is the idiomatic Lean version manager (analogous to rustup), and
 * `elan default stable` sets up the latest stable Lean toolchain on the user's
 * PATH. If elan is already installed, the command updates to the latest
 * stable; if not, it prompts to install elan first.
 *
 * (research-lean4.md §1.3: "`mise install ubi:leanprover/elan@4.2.3` is
 * supported for project-level tool pinning, but the one-liner for the user to
 * run is `elan default stable`.")
 */
const ELAN_INSTALL_SUGGESTION = 'Run `elan default stable` to install or update the Lean toolchain.'

/**
 * Probe for the `lean` executable on PATH by attempting `lean --version`.
 * Throws {@link LeanDiscoveryError} with `ERR_LEAN_TOOLCHAIN_MISSING` if:
 *  - `lean` is not found on PATH (spawn fails with ENOENT), or
 *  - `lean --version` fails or returns a non-zero exit code.
 *
 * Otherwise returns silently (no return value — the discovery succeeded).
 *
 * The probe is synchronous and fires only when `--certify` is requested,
 * so the small blocking I/O cost (one fork + `lean --version` execution)
 * is acceptable and only paid once per explicit certify invocation.
 */
export function discoverLeanToolchain(): void {
  const result = spawnSync('lean', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // spawnSync sets `error` if the process cannot be spawned at all (e.g. ENOENT).
  if (result.error) {
    throw new LeanDiscoveryError(
      'Lean toolchain not found on PATH. Install via elan to enable the optional `symspec certify` tier.',
      [ELAN_INSTALL_SUGGESTION],
    )
  }

  // Even if spawn succeeds, check the exit code (defensive against misconfigured wrappers).
  if (result.status !== 0) {
    throw new LeanDiscoveryError(
      'Lean toolchain found on PATH but `lean --version` failed (exit code ' +
        result.status +
        '). Check your installation.',
      [ELAN_INSTALL_SUGGESTION],
    )
  }
}

/**
 * Non-throwing sibling of {@link discoverLeanToolchain} — used by `manifest
 * --backends` (AC-6-14) to report the OPTIONAL Lean toolchain's availability
 * and, when present, its resolved executable and `lean --version` string,
 * without ever failing the manifest command when Lean is not installed.
 *
 * Mirrors the `probeBackend()` (`formal/backend.ts`) and `probeSolverBinary()`
 * (`formal/binary-backend.ts`) conventions exactly so the three backends share
 * one probe shape, and centralizes Lean's `lean --version` spawn here rather
 * than duplicating it in the CLI layer. The resolved `bin` is the bare
 * PATH-relative `lean` name — the same convention `probeSolverBinary()` uses
 * for a PATH-discovered `z3`/`cvc5` — since the toolchain is discovered on
 * PATH, not by absolute path.
 *
 * Rationale/cite: research-lean4.md §1.3 — "symspec's doctor/manifest command
 * should report Lean as optional, not installed."
 */
export function probeLeanToolchain():
  | { available: true; bin: string; version: string }
  | { available: false } {
  const result = spawnSync('lean', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) return { available: false }
  return { available: true, bin: 'lean', version: (result.stdout ?? '').trim() }
}
