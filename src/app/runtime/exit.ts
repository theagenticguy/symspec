/**
 * The envelope -> exit-code mapping.
 *
 * The EXIT_* constants, {@link ExitCode}, and {@link FindingSeverity} live in
 * `ports/exit.ts` — they are the agent contract's vocabulary. This file is the
 * app-ring half: the pure mapping from a wire envelope to the process exit
 * code, plus the severity predicates it reads with.
 */

import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  EXIT_OPERATIONAL_ERROR,
  type ExitCode,
} from '../../ports/exit.ts'
import { type Envelope, isErrorEnvelope } from './envelope.ts'

// ---------------------------------------------------------------------------
// Finding-severity predicate
// ---------------------------------------------------------------------------

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
