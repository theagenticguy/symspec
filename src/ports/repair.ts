/**
 * Repair — the structured remedy every failure and demotion may carry (AC-A-9).
 *
 * Contract vocabulary: the domain tiers PRODUCE a repair (`domain/advice`,
 * `domain/reachability`), and the app ring SERIALIZES it onto the wire
 * (`app/runtime/envelope.ts`), so the shape lives where both rings can name it
 * without importing each other.
 */

/**
 * A machine-actionable remedy attached to a failure.
 *
 * `ops` are ready-to-apply document operations (the JSONL op records the
 * `import`/`apply` stream consumes) — objects rather than a narrower type
 * because the v3 document-op union lands with the doc store, and the envelope
 * must not depend on it. `commands` are literal shell command lines an agent can
 * run as-is.
 *
 * Both arrays are present when a `repair` is present; either may be empty, but a
 * `repair` with two empty arrays is meaningless and should be omitted entirely
 * (see {@link failure}, which drops it).
 */
export interface Repair {
  /** Ready-to-apply document ops, in the `import`/`apply` JSONL op shape. */
  readonly ops: readonly object[]
  /** Literal command lines to run, verbatim. */
  readonly commands: readonly string[]
}
