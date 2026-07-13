/**
 * Process exit-code contract for the `check` linter loop (AC-6-2b).
 *
 * `symspec check` is driven in an edit/CI loop, so its POSIX exit status is a
 * first-class part of the agent-facing contract — not an afterthought. This
 * module is the single, pure mapping from a result {@link Envelope} to the
 * process exit code, so every command path (and every test) computes the code
 * the same way.
 *
 * ## The four codes
 *
 *   - **`0` (clean)** — the pipeline completed and NO `error`-severity finding
 *     is present. A run with only `warn`/`info` findings still exits `0`: those
 *     severities are explicitly excluded from the pass/fail gate (AC-3-3,
 *     AC-3-7), so a spec that merely tripped a legitimate-exception rule is not
 *     a build failure.
 *   - **`1` (findings-failure)** — the pipeline completed but one or more
 *     `error`-severity findings are present. A valid `{apiVersion,type,data}`
 *     SUCCESS envelope is STILL written to stdout (the findings are the data);
 *     exit `1` is the signal that the pass/fail gate failed, not that the tool
 *     crashed. This is the code AC-3-3 and AC-3-7 reference as the pass/fail
 *     gate.
 *   - **`2` (operational failure)** — an `ERR_*` failure (crash / usage / IO /
 *     doc-not-found / solver-init). The ERROR envelope
 *     (`{apiVersion,type:'error',error,code,suggestions,partial?}`) is written
 *     to stdout. This is DISTINCT from `1`: a findings-failure means the tool
 *     worked and the spec failed; an operational failure means the tool itself
 *     could not complete.
 *   - **`3` (inconclusive gate failure)** — the pipeline completed, no
 *     `error`-severity finding is present, but the OPT-IN strict coverage gate
 *     (wishlist #4, `--strict` / `--fail-on-unmatched`) tripped: the run could
 *     not actually verify the spec across requirements (`data.verified` is
 *     `false`), or too many atoms went uncompared. A valid SUCCESS envelope is
 *     still on stdout. This is the machine-readable encoding of the manifest
 *     doctrine that silence is not a consistency certificate — DISTINCT from `0`
 *     (which now means "verified clean" only when the gate was requested) and
 *     from `1` (a proven defect). Only reachable when the caller opted into a
 *     strict gate; a default run never returns `3`. An `error`-severity finding
 *     always outranks the strict gate (→ `1`), since a proven conflict is
 *     stronger news than "couldn't check".
 *
 * ## Invariants
 *
 *   - The envelope is ALWAYS written to stdout regardless of the exit code — a
 *     `1` and a `2` both still emit a machine-parseable envelope. This module
 *     only computes the code; it never suppresses output.
 *   - Output flags (`--json`, `--dense`, `--pretty`, `--human`) NEVER change the
 *     exit code. The code is a pure function of the envelope's semantics, not of
 *     how it is rendered. This module takes only the envelope, so a formatting
 *     flag has no channel through which to affect the result.
 *
 * ## Scope boundary
 *
 * This module owns only the code mapping and the finding-severity predicate it
 * rests on. It does not build envelopes (AC-6-2, `cli/envelope.ts`), render them
 * (AC-6-2a, `cli/output.ts`), or write to stdout / call `process.exit` — the
 * command wiring (AC-6-8) computes the code with {@link exitCodeForEnvelope}
 * after emitting the envelope. Keeping it pure makes the whole contract unit-
 * testable without spawning a process.
 *
 * Cite: AC-6-2b (exit-code contract 0 / 1 findings-failure / 2 ERR_*); AC-3-3
 * (warn/info excluded from the pass/fail gate); AC-3-7 (blocking surface check);
 * orchestrator decision 9.
 */

import type { Envelope } from './envelope.js'

// ---------------------------------------------------------------------------
// The three exit codes
// ---------------------------------------------------------------------------

/** Pipeline completed with no `error`-severity finding (warn/info are still clean). */
export const EXIT_CLEAN = 0

/**
 * Pipeline completed but at least one `error`-severity finding is present. A
 * valid success envelope is still on stdout; this is the pass/fail gate signal
 * (AC-3-3 / AC-3-7), not a crash.
 */
export const EXIT_FINDINGS_FAILURE = 1

/**
 * An `ERR_*` operational failure (crash / usage / IO / solver-init). The error
 * envelope is on stdout. Distinct from {@link EXIT_FINDINGS_FAILURE}.
 */
export const EXIT_OPERATIONAL_ERROR = 2

/**
 * The opt-in strict coverage gate (wishlist #4) tripped on a run with no
 * error-severity finding: the spec could not be verified across requirements
 * (`data.verified === false`) or `unmatchedAtoms` exceeded the requested
 * threshold. A valid success envelope is still on stdout. Only reachable when
 * the caller passed `--strict` / `--fail-on-unmatched`; distinct from
 * {@link EXIT_CLEAN} (verified clean) and {@link EXIT_FINDINGS_FAILURE} (proven
 * defect, which outranks it).
 */
export const EXIT_INCONCLUSIVE = 3

/** The closed set of exit codes symspec's `check` loop returns. */
export type ExitCode =
  | typeof EXIT_CLEAN
  | typeof EXIT_FINDINGS_FAILURE
  | typeof EXIT_OPERATIONAL_ERROR
  | typeof EXIT_INCONCLUSIVE

// ---------------------------------------------------------------------------
// Finding-severity predicate
// ---------------------------------------------------------------------------

/**
 * The severity levels a finding may carry. Mirrors the `severity` field on
 * every finding kind (GtWR lint findings in `lint/gtwr.ts`, formal findings in
 * `formal/*.ts`). Only `'error'` gates the exit code up to `1`; `'warn'` and
 * `'info'` are clean (AC-3-3).
 */
export type FindingSeverity = 'error' | 'warn' | 'info'

/**
 * Does this value look like a finding carrying an `error` severity? Findings
 * are plain JSON objects with a `severity` field; the `check` `data` payload's
 * `findings` array is `unknown` to this module (it never depends on any
 * detector's exact shape), so the check is structural: an object whose
 * `severity` is exactly the string `'error'`.
 */
function isErrorSeverity(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'severity' in value &&
    (value as { severity: unknown }).severity === 'error'
  )
}

/**
 * Extract the `findings` array from a success envelope's `data` payload. The
 * `check` command's payload is `{ findings: Finding[] }`; `data` is typed
 * `unknown` on the envelope, so this reads it defensively — a payload that is
 * not an object, or lacks a `findings` array, yields an empty list (no findings
 * ⇒ clean). Never throws.
 */
function findingsOf(data: unknown): readonly unknown[] {
  if (typeof data !== 'object' || data === null) return []
  const findings = (data as { findings?: unknown }).findings
  return Array.isArray(findings) ? findings : []
}

/**
 * True when any finding in a `check` success payload carries `error` severity —
 * the condition that maps a completed run to {@link EXIT_FINDINGS_FAILURE}.
 * `warn`/`info`-only payloads (and empty ones) return `false` (AC-3-3).
 */
export function hasErrorSeverityFinding(data: unknown): boolean {
  return findingsOf(data).some(isErrorSeverity)
}

/**
 * True when a `check` success payload's opt-in strict coverage gate (wishlist
 * #4) tripped — the condition that maps a completed, error-free run to
 * {@link EXIT_INCONCLUSIVE}. Reads `data.strictGate` structurally: it is
 * `'fail'` only when the caller requested a gate (`--strict` /
 * `--fail-on-unmatched`) and it did not hold. A payload without the field (no
 * gate requested, or not a `check` payload) returns `false`, so the default
 * contract is unchanged. Never throws.
 */
export function hasFailedStrictGate(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  return (data as { strictGate?: unknown }).strictGate === 'fail'
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Map a result {@link Envelope} to its process exit code (AC-6-2b):
 *
 *   - an ERROR envelope (`type === 'error'`, an `ERR_*` operational failure)
 *     → {@link EXIT_OPERATIONAL_ERROR} (`2`);
 *   - a SUCCESS envelope whose `data.findings` contains an `error`-severity
 *     finding → {@link EXIT_FINDINGS_FAILURE} (`1`) — a proven defect outranks
 *     the strict gate;
 *   - a SUCCESS envelope with no error finding but a tripped opt-in strict
 *     coverage gate (`data.strictGate === 'fail'`) → {@link EXIT_INCONCLUSIVE}
 *     (`3`);
 *   - any other SUCCESS envelope (clean, or warn/info-only) → {@link EXIT_CLEAN}
 *     (`0`).
 *
 * Pure and total: a function of the envelope's semantics alone. Output flags
 * cannot reach it, and it never writes output or exits the process.
 */
export function exitCodeForEnvelope(env: Envelope): ExitCode {
  if (env.type === 'error') return EXIT_OPERATIONAL_ERROR
  // `SuccessEnvelope.type` is a plain string (not a literal discriminant), so
  // the union does not narrow to `SuccessEnvelope` on the `!== 'error'` branch;
  // read `data` structurally. An error envelope has no `data` key, so this is
  // also correct were one to reach here.
  const data = (env as { data?: unknown }).data
  if (hasErrorSeverityFinding(data)) return EXIT_FINDINGS_FAILURE
  if (hasFailedStrictGate(data)) return EXIT_INCONCLUSIVE
  return EXIT_CLEAN
}
