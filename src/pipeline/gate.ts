/**
 * Pipeline-exclusion gate (AC-3-7).
 *
 * "While lint runs before the formal layer in the forced pipeline, symspec
 * shall mark statements that fail a parse or a blocking (`error`-severity)
 * surface check as excluded from symbolization, so the SMT layer never
 * receives unsound input" (spec AC-3-7).
 *
 * research-ears-incose.md §4 names this the forced Layer A → Layer C order:
 * "Rules that fail at Layer A make Layer C unsound … pipeline order is
 * forced: parse → lint → symbolize → solve." This module is the gate
 * between lint (Layer A, `src/lint/gtwr.ts`, AC-3-2) and symbolize/solve
 * (Layer C, `src/formal/encode.ts` + `atomize.ts`, AC-4-2/AC-4-2a): it
 * partitions a requirement set into the subset that may be handed to the
 * formal encoder and the subset that must not be, carrying the offending
 * findings as evidence.
 *
 * Only `error`-severity GtWR findings are blocking (AC-3-3 exiles the
 * legitimate-exception rules — R26/R32/R35/R16 — to `warn`/`info`, which are
 * explicitly excluded from any pass/fail gate and therefore must NOT exclude
 * a statement from symbolization here).
 *
 * `parseFailed` is accepted as an optional per-requirement input so a future
 * wiring task (the Tier-3 `ParseResult` error/`skipped` outcomes, AC-2-8, not
 * yet built) can feed "failed to parse" requirements through the SAME gate
 * without a second exclusion mechanism — AC-3-7's ubiquitous text names BOTH
 * "a parse" failure and a blocking surface check as exclusion triggers. This
 * module owns only the gate itself; it does not synthesize parse failures.
 *
 * Pure: no I/O, no solver contact. `checkGtWRules` (AC-3-2) is deterministic,
 * so gating the same requirement set twice yields the identical partition.
 */

import { renderSentence } from '../core/render.js'
import type { Requirement } from '../core/schema.js'
import { checkGtWRules, type GtWRFinding } from '../lint/gtwr.js'

/** Why a requirement was excluded from symbolization. */
export type ExclusionReason = 'parse-failure' | 'blocking-surface-check'

/** One excluded requirement, with the evidence that excluded it. */
export interface Exclusion {
  id: string
  reason: ExclusionReason
  /** The blocking (`error`-severity) findings, when `reason` is `'blocking-surface-check'`. Omitted for `'parse-failure'`. */
  findings: GtWRFinding[]
}

/** The gate's verdict over one requirement set. */
export interface GateResult {
  /** Requirements clear to hand to the formal encoder (AC-4-2/AC-4-2a). */
  included: Requirement[]
  /** Requirements excluded from symbolization, with the reason and evidence. */
  excluded: Exclusion[]
}

/** Per-requirement input to {@link gate}: the requirement plus optional parse-failure provenance. */
export interface GateInput {
  requirement: Requirement
  /**
   * True when an upstream parse tier (Tier 1/2/3) failed to produce a
   * trustworthy slot set for this requirement. Optional — a caller that does
   * not yet track parse outcomes (no `ParseResult` wiring, AC-2-8 not yet
   * built) may omit this and the gate falls back to the surface-check-only
   * path. Never assign `false`-as-`undefined`; omit the key entirely when
   * unknown (exactOptionalPropertyTypes).
   */
  parseFailed?: boolean
}

/**
 * Run the GtWR lint (AC-3-2) over one requirement's rendered sentence and
 * report only the `error`-severity findings — the ones that are blocking
 * under AC-3-3 (R26/R32/R35/R16's legitimate exceptions land at `warn`/`info`
 * and must never exclude a statement here).
 */
function blockingFindings(requirement: Requirement): GtWRFinding[] {
  const sentence = requirement.sentence || renderSentence(requirement)
  return checkGtWRules(requirement, sentence).filter((f) => f.severity === 'error')
}

/**
 * Partition a requirement set into the subset safe to symbolize and the
 * subset excluded by AC-3-7. This is the pipeline-exclusion gate: the SMT
 * layer (Layer C) must only ever see `included`.
 *
 * Each `Requirement` is checked in isolation:
 *   1. If the caller marks it `parseFailed: true`, it is excluded with
 *      reason `'parse-failure'` — no surface check is run (there is no
 *      trustworthy sentence to lint).
 *   2. Otherwise the GtWR surface check (AC-3-2) runs; any `error`-severity
 *      finding excludes the requirement with reason
 *      `'blocking-surface-check'`, carrying those findings as evidence.
 *   3. A requirement with zero blocking findings (including one with only
 *      `warn`/`info` findings, per AC-3-3) is included.
 */
export function gate(inputs: readonly GateInput[]): GateResult {
  const included: Requirement[] = []
  const excluded: Exclusion[] = []

  for (const { requirement, parseFailed } of inputs) {
    if (parseFailed === true) {
      excluded.push({ id: requirement.id, reason: 'parse-failure', findings: [] })
      continue
    }

    const findings = blockingFindings(requirement)
    if (findings.length > 0) {
      excluded.push({ id: requirement.id, reason: 'blocking-surface-check', findings })
      continue
    }

    included.push(requirement)
  }

  return { included, excluded }
}

/**
 * Convenience wrapper over {@link gate} for the common case: a plain list of
 * requirements with no parse-failure tracking yet (no caller currently wires
 * `ParseResult` through this gate). Every requirement is gated purely on the
 * AC-3-2 surface check.
 */
export function gateRequirements(requirements: readonly Requirement[]): GateResult {
  return gate(requirements.map((requirement) => ({ requirement })))
}

/** The stable set of ids excluded by a {@link GateResult}, for quick membership checks downstream. */
export function excludedIds(result: GateResult): Set<string> {
  return new Set(result.excluded.map((e) => e.id))
}
