/**
 * The exit-code contract: a pure {@link Envelope} → exit code function.
 *
 * `symspec check` is driven in an edit/CI loop, so its POSIX exit status is a
 * first-class part of the agent-facing contract — not an afterthought. This
 * module is the single mapping, so every command path and every test computes
 * the code the same way. Ported from the donor's `src/cli/exit.ts`; the four
 * codes and their meanings are unchanged agent API.
 *
 * ## The four codes
 *
 * - **`0` (clean)** — the operation completed and no `error`-severity finding is
 *   present. A run with only `warn`/`info` findings still exits `0`: those
 *   severities are deliberately excluded from the pass/fail gate, so a spec that
 *   merely tripped a legitimate-exception rule is not a build failure.
 * - **`1` (findings-failure)** — the operation completed but one or more
 *   `error`-severity findings are present. A valid SUCCESS envelope is still
 *   written (the findings ARE the data); `1` signals that the pass/fail gate
 *   failed, not that the tool crashed.
 * - **`2` (operational failure)** — an `ERR_*` failure. The ERROR envelope is
 *   written. Distinct from `1`: a findings-failure means the tool worked and the
 *   spec failed; an operational failure means the tool could not complete.
 * - **`3` (inconclusive)** — the operation completed, no `error`-severity
 *   finding, but an OPT-IN strict coverage gate tripped: the run could not
 *   actually verify the spec. A valid SUCCESS envelope is still written. This is
 *   the machine-readable encoding of the doctrine that silence is not a
 *   consistency certificate. Only reachable when the caller opted in; a default
 *   run never returns `3`. An `error`-severity finding always OUTRANKS the
 *   strict gate (→ `1`), since a proven defect is stronger news than
 *   "couldn't check".
 *
 * ## Where 1 and 3 come from in G1
 *
 * G1 ships no operation that produces findings, so in practice this kernel emits
 * `0` and `2` today. The mapping is nonetheless implemented and tested in full,
 * because it is the contract `check` (G2) plugs into: when `check` lands it
 * supplies `data.findings` / `data.strictGate` and gets the right code for free,
 * rather than the gate logic being invented alongside the detector that needs it.
 *
 * ## Invariants
 *
 * - An envelope is ALWAYS emitted regardless of the code — a `1` and a `2` both
 *   still produce a machine-parseable envelope. This module computes the code; it
 *   never suppresses output and never calls `process.exit`.
 * - Output flags (`--pretty`, `--dense`, `--field`) NEVER change the exit code.
 *   The code is a pure function of the envelope's SEMANTICS, not of how it is
 *   rendered — and since this function takes only the envelope, a formatting flag
 *   has no channel through which to reach it.
 *
 * ## Note on CLI usage errors
 *
 * A CLI PARSE failure (a missing required flag, an unknown subcommand) never
 * reaches this function: `effect/unstable/cli` fails before a handler runs and
 * the runtime exits `1`. That was measured in spike S2, and it happens to match
 * the donor's contract for a usage error, so no wiring is needed to produce it.
 * The `1` this module returns for findings and the `1` the CLI returns for usage
 * are the same code by design, distinguished by whether stdout carried an
 * envelope at all.
 */

import { type Envelope, isErrorEnvelope } from './envelope.ts'

// ---------------------------------------------------------------------------
// The four codes
// ---------------------------------------------------------------------------

/** Completed with no `error`-severity finding (warn/info are still clean). */
export const EXIT_CLEAN = 0

/**
 * Completed, but at least one `error`-severity finding is present. A valid
 * success envelope is still emitted; this is the pass/fail gate signal, not a
 * crash.
 */
export const EXIT_FINDINGS_FAILURE = 1

/**
 * An `ERR_*` operational failure. The error envelope is emitted. Distinct from
 * {@link EXIT_FINDINGS_FAILURE}.
 */
export const EXIT_OPERATIONAL_ERROR = 2

/**
 * An opt-in strict coverage gate tripped on a run with no error-severity
 * finding: the spec could not be verified. A valid success envelope is still
 * emitted. Only reachable when the caller opted in; distinct from
 * {@link EXIT_CLEAN} (verified clean) and {@link EXIT_FINDINGS_FAILURE} (proven
 * defect, which outranks it).
 */
export const EXIT_INCONCLUSIVE = 3

/** The closed set of exit codes symspec returns. */
export type ExitCode =
  | typeof EXIT_CLEAN
  | typeof EXIT_FINDINGS_FAILURE
  | typeof EXIT_OPERATIONAL_ERROR
  | typeof EXIT_INCONCLUSIVE

/** Every exit code, in ascending order — the manifest's exit-code table. */
export const EXIT_CODES = [
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_OPERATIONAL_ERROR,
  EXIT_INCONCLUSIVE,
] as const

// ---------------------------------------------------------------------------
// Finding-severity predicate
// ---------------------------------------------------------------------------

/**
 * The severity levels a finding may carry. Only `'error'` gates the exit code up
 * to `1`; `'warn'` and `'info'` are clean.
 */
export type FindingSeverity = 'error' | 'warn' | 'info'

/**
 * Does this value look like a finding carrying `error` severity?
 *
 * Findings are plain JSON objects with a `severity` field. This module never
 * depends on any detector's exact shape (the detectors land in G2), so the check
 * is deliberately structural: an object whose `severity` is exactly `'error'`.
 */
const isErrorSeverity = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'severity' in value &&
  (value as { severity: unknown }).severity === 'error'

/**
 * Extract the `findings` array from a success payload. Read defensively: a
 * payload that is not an object, or lacks a `findings` array, yields an empty
 * list (no findings ⇒ clean). Never throws.
 */
const findingsOf = (data: unknown): readonly unknown[] => {
  if (typeof data !== 'object' || data === null) return []
  const findings = (data as { findings?: unknown }).findings
  return Array.isArray(findings) ? findings : []
}

/**
 * True when any finding in a success payload carries `error` severity — the
 * condition that maps a completed run to {@link EXIT_FINDINGS_FAILURE}.
 * `warn`/`info`-only and empty payloads return `false`.
 */
export const hasErrorSeverityFinding = (data: unknown): boolean =>
  findingsOf(data).some(isErrorSeverity)

/**
 * True when a success payload's opt-in strict coverage gate tripped — the
 * condition that maps a completed, error-free run to {@link EXIT_INCONCLUSIVE}.
 * Reads `data.strictGate` structurally: it is `'fail'` only when the caller
 * requested a gate and it did not hold. A payload without the field (no gate
 * requested) returns `false`, so the default contract is unchanged. Never
 * throws.
 */
export const hasFailedStrictGate = (data: unknown): boolean => {
  if (typeof data !== 'object' || data === null) return false
  return (data as { strictGate?: unknown }).strictGate === 'fail'
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Map a result {@link Envelope} to its process exit code:
 *
 * - an ERROR envelope → {@link EXIT_OPERATIONAL_ERROR} (`2`);
 * - a SUCCESS envelope whose `data.findings` holds an `error`-severity finding →
 *   {@link EXIT_FINDINGS_FAILURE} (`1`) — a proven defect outranks the gate;
 * - a SUCCESS envelope with no error finding but a tripped strict gate
 *   (`data.strictGate === 'fail'`) → {@link EXIT_INCONCLUSIVE} (`3`);
 * - any other SUCCESS envelope → {@link EXIT_CLEAN} (`0`).
 *
 * Pure and total: a function of the envelope's semantics alone. Output flags
 * cannot reach it; it never writes output and never exits the process.
 */
export const exitCodeForEnvelope = (env: Envelope): ExitCode => {
  // Narrow via the {@link isErrorEnvelope} PREDICATE rather than an inline
  // `env.type === 'error'` test. `OkEnvelope`'s `type` is generic (`T extends
  // string`, defaulting to `string`), and `string` includes `'error'`, so a bare
  // comparison does not narrow the union — the else branch stays `Envelope` and
  // `env.data` is a type error. The predicate's declared `env is ErrorEnvelope`
  // narrows both branches, which keeps this function honest without a cast.
  if (isErrorEnvelope(env)) return EXIT_OPERATIONAL_ERROR
  const data = env.data
  if (hasErrorSeverityFinding(data)) return EXIT_FINDINGS_FAILURE
  if (hasFailedStrictGate(data)) return EXIT_INCONCLUSIVE
  return EXIT_CLEAN
}
