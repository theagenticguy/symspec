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
import type { Requirement, Waiver } from '../core/schema.js'
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
 * True when a committed waiver `w` suppresses the blocking finding `f` on
 * requirement `requirementId`: the codes match and the waiver is either
 * document-wide (no `requirementId`) or scoped to this requirement. Mirrors
 * `isWaived` in `src/pipeline/check.ts` — kept in sync deliberately (the check
 * pipeline drops the SAME finding from `findings[]`, so a waived blocking
 * finding must both disappear from the report AND stop excluding the
 * requirement here, or the two would disagree).
 */
function isWaivedBlocking(f: GtWRFinding, requirementId: string, w: Waiver): boolean {
  if (f.code !== w.code) return false
  if (w.requirementId === undefined) return true
  return w.requirementId === requirementId
}

/**
 * Run the GtWR lint (AC-3-2) over one requirement's rendered sentence and
 * report only the `error`-severity findings — the ones that are blocking
 * under AC-3-3 (R26/R32/R35/R16's legitimate exceptions land at `warn`/`info`
 * and must never exclude a statement here).
 *
 * A committed waiver that matches a blocking finding DROPS it from the returned
 * set: the author has taken responsibility for that finding, so it must no
 * longer exclude the requirement from the formal tier (waiver-vs-exclusion
 * soundness — see {@link gate}). A requirement whose ONLY blocking findings are
 * all waived therefore returns `[]` and is re-admitted to symbolization.
 */
function blockingFindings(requirement: Requirement, waivers: readonly Waiver[]): GtWRFinding[] {
  const sentence = requirement.sentence || renderSentence(requirement)
  return checkGtWRules(requirement, sentence)
    .filter((f) => f.severity === 'error')
    .filter((f) => !waivers.some((w) => isWaivedBlocking(f, requirement.id, w)))
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
 *
 * ## Waiver-vs-exclusion soundness (`waivers`)
 *
 * An optional `waivers` list makes the gate waiver-aware: a blocking finding
 * suppressed by a committed waiver no longer excludes its requirement, so a
 * requirement whose ONLY blocking finding is waived is RE-ADMITTED to the formal
 * tier (its atoms rejoin the SMT conjunction and cross-requirement analysis).
 * This closes a silent unsoundness: previously `check` waived a formal-blocking
 * finding out of `findings[]` (and the exit gate) but the gate still excluded
 * the requirement, so the author saw the finding "resolved" yet the solver
 * silently never reasoned about that requirement. Re-admission is defensible
 * because a waiver is a reviewed, reasoned decision — the author took
 * responsibility for the finding. Waivers default to empty, so a caller that
 * passes none gets the exact pre-feature partition.
 */
export function gate(inputs: readonly GateInput[], waivers: readonly Waiver[] = []): GateResult {
  const included: Requirement[] = []
  const excluded: Exclusion[] = []

  for (const { requirement, parseFailed } of inputs) {
    if (parseFailed === true) {
      excluded.push({ id: requirement.id, reason: 'parse-failure', findings: [] })
      continue
    }

    const findings = blockingFindings(requirement, waivers)
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
 * AC-3-2 surface check. Pass `waivers` to make the gate waiver-aware — a waived
 * blocking finding then re-admits its requirement to the formal tier (see
 * {@link gate}).
 */
export function gateRequirements(
  requirements: readonly Requirement[],
  waivers: readonly Waiver[] = [],
): GateResult {
  return gate(
    requirements.map((requirement) => ({ requirement })),
    waivers,
  )
}

/** The stable set of ids excluded by a {@link GateResult}, for quick membership checks downstream. */
export function excludedIds(result: GateResult): Set<string> {
  return new Set(result.excluded.map((e) => e.id))
}
