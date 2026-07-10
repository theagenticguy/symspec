/**
 * Manifest `backends` availability report (AC-6-14).
 *
 * An agent should be able to *query then decide* — learn which formal-methods
 * backends are actually runnable in this environment BEFORE it invokes
 * `certify` or passes `--solver`, rather than *fail then learn* by triggering
 * `ERR_SOLVER_MISSING` / `ERR_LEAN_TOOLCHAIN_MISSING` and reading the
 * suggestion off the error envelope. This module assembles that structured
 * report for the `manifest` command (AC-6-1).
 *
 * ## Three backends, one report
 *
 *   - **z3-wasm** — the in-process WASM Z3 that powers the default `check`
 *     tier (AC-4-1). Always available: it ships as an npm dependency and never
 *     shells out, so a fresh install with an empty PATH still runs the SMT
 *     tier. Reported `available: true` with the Z3 version string.
 *   - **z3/cvc5 binary** — the OPTIONAL external solver used for the `--solver`
 *     cross-check (AC-4-9). Reported available with its resolved executable,
 *     version, solver family, and which discovery source resolved it when one
 *     is present on the AC-4-9 discovery path; `available: false` otherwise.
 *   - **lean** — the OPTIONAL Lean 4 toolchain the `certify` tier requires
 *     (AC-5-4). Reported available with its resolved executable and version
 *     when present; `available: false` otherwise.
 *
 * ## Reuse, not re-probe
 *
 * Every probe here delegates to the backend module that already owns the
 * discovery logic — `probeBackend()` (`formal/backend.ts`),
 * `probeSolverBinary()` (`formal/binary-backend.ts`), and
 * `probeLeanToolchain()` (`certify/discover.ts`). This module composes their
 * three non-throwing probes into one report; it never duplicates a spawn or a
 * WASM init. Because all three probes are non-throwing by contract, collecting
 * the report can never fail the `manifest` command itself.
 *
 * Cite: AC-6-14 (manifest `backends` availability/path/version report);
 * research-lean4.md §1.3 (manifest should report Lean as optional, not
 * installed); explore-surface.md §4.
 */

import { z } from 'zod'
import { probeLeanToolchain } from '../certify/discover.js'
import { probeBackend } from '../formal/backend.js'
import { probeSolverBinary } from '../formal/binary-backend.js'

// ---------------------------------------------------------------------------
// Report schema — the `backends` block validates against this so the manifest
// (AC-6-1) can carry it under the same Zod-derived guarantee as everything else.
// ---------------------------------------------------------------------------

/**
 * The in-process WASM Z3 backend (AC-4-1). Always available; carries the Z3
 * version string. The rare init-failure case is still represented so the
 * schema is total, but on any supported install this is `available: true`.
 */
export const WasmBackendSchema = z.union([
  z.object({ available: z.literal(true), version: z.string() }),
  z.object({ available: z.literal(false), error: z.string() }),
])
export type WasmBackend = z.infer<typeof WasmBackendSchema>

/**
 * The optional external `z3`/`cvc5` binary backend (AC-4-9). When present,
 * carries the resolved executable (`path`), the `lean --version`-style version
 * string, the solver `kind`, and which discovery `source` resolved it.
 */
export const BinaryBackendReportSchema = z.union([
  z.object({
    available: z.literal(true),
    path: z.string(),
    version: z.string(),
    kind: z.enum(['z3', 'cvc5']),
    source: z.enum(['solver-path', 'SYMSPEC_Z3', 'PATH']),
  }),
  z.object({ available: z.literal(false) }),
])
export type BinaryBackendReport = z.infer<typeof BinaryBackendReportSchema>

/**
 * The optional Lean 4 toolchain (AC-5-4). When present, carries the resolved
 * executable (`path`) and `lean --version` string; `available: false` otherwise.
 */
export const LeanBackendReportSchema = z.union([
  z.object({ available: z.literal(true), path: z.string(), version: z.string() }),
  z.object({ available: z.literal(false) }),
])
export type LeanBackendReport = z.infer<typeof LeanBackendReportSchema>

/** The whole `backends` block reported by the manifest (AC-6-14). */
export const BackendsReportSchema = z.object({
  'z3-wasm': WasmBackendSchema,
  binary: BinaryBackendReportSchema,
  lean: LeanBackendReportSchema,
})
export type BackendsReport = z.infer<typeof BackendsReportSchema>

// ---------------------------------------------------------------------------
// Collection — composes the three backend-owned probes into one report.
// ---------------------------------------------------------------------------

/**
 * Collect the `backends` availability report by delegating to each backend's
 * own non-throwing probe. Async because the WASM z3 probe (`probeBackend`)
 * awaits the one-time WASM init; the binary and Lean probes are synchronous
 * spawns. Never throws — every probe returns a discriminated availability
 * result, so a missing binary or absent Lean toolchain is reported as
 * `available: false`, not an error.
 */
export async function collectBackends(): Promise<BackendsReport> {
  const wasm = await probeBackend()
  const binary = probeSolverBinary()
  const lean = probeLeanToolchain()

  return {
    // `exactOptionalPropertyTypes` is on: build each variant with exactly the
    // keys its schema declares (omit, never set-to-undefined).
    'z3-wasm': wasm.available
      ? { available: true, version: wasm.version }
      : { available: false, error: wasm.error },
    binary: binary.available
      ? {
          available: true,
          path: binary.bin,
          version: binary.version,
          kind: binary.kind,
          source: binary.source,
        }
      : { available: false },
    lean: lean.available
      ? { available: true, path: lean.bin, version: lean.version }
      : { available: false },
  }
}
