/**
 * The exit-code contract: a pure {@link Envelope} → exit code function.
 *
 * `symspec check` is driven in an edit/CI loop, so its POSIX exit status is a
 * first-class part of the agent-facing contract — not an afterthought. This
 * module is the single mapping, so every command path and every test computes
 * the code the same way. Ported from v4's `src/cli/exit.ts`; the four
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
 * v4's contract for a usage error, so no wiring is needed to produce it.
 * The `1` this module returns for findings and the `1` the CLI returns for usage
 * are the same code by design, distinguished by whether stdout carried an
 * envelope at all.
 */

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

/**
 * The severity levels a finding may carry. Only `'error'` gates the exit code up
 * to `1`; `'warn'` and `'info'` are clean.
 */
export type FindingSeverity = 'error' | 'warn' | 'info'
