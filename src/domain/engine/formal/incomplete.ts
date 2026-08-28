/**
 * Completeness heuristic → FND_INCOMPLETE (AC-4-5a).
 *
 * For each same-trigger-family group whose members carry precondition atoms,
 * this module checks whether those preconditions collectively cover all cases
 * by evaluating SAT of `¬(C1 ∨ … ∨ Cn)`. A satisfying model means there is
 * an input that none of the preconditions cover — an uncovered / "else-branch
 * missing" case — and symspec emits `FND_INCOMPLETE` at `info` severity.
 *
 * ## What the SAT question decides: nothing about the document
 *
 * `encode` atomizes both guard slots with `negated: false`, and the atomizer flips polarity only
 * on its `resp` branch, so EVERY `pre` row reaching this tier is positive. A disjunction of
 * positive atoms is falsified by setting them all false, so `¬(C1 ∨ … ∨ Cn)` is SAT for every
 * eligible group and the tier fires on eligibility alone. The `unsat` "covered" branch needs a
 * NEGATED `pre` row, and nothing produces one.
 *
 * "maintenance mode is not enabled" is not `¬P`, either: the copula strip leaves
 * `maintenance_mode_not_enabled`, its own positive atom, so a partition an author wrote as
 * complementary is two unrelated atoms to the solver.
 *
 * Honest framing: a SAT result here says "there is a valuation making all preconditions false at
 * once", which under a positive-only encoding is a property of the encoding rather than of the
 * requirements. The spec (AC-4-5a, research-smt.md §1.5, Appendix B) documents this as a
 * heuristic "no else-branch" lint at INFO severity and not a correctness guarantee, and info is
 * the only reason unconditional firing is noise rather than a fabrication. `incomplete.test.ts`
 * pins the unconditional firing, the eligibility rules that DO discriminate, and the one
 * hand-built atom table that reaches the covered branch.
 *
 * ## Grouping discipline
 *
 * Groups are formed by matching TRIGGER atoms (not trigger text), so the same
 * conservative normalization that drives contradiction detection applies here.
 * A requirement with no trigger (ubiquitous, state-driven-only) is grouped
 * under the empty-string trigger key, meaning its preconditions cover the
 * "always" case; that group is skipped (a group with no trigger has no clear
 * "event" whose cases need to be covered by preconditions).
 *
 * A group is eligible for the check only when:
 *   - it has a non-empty trigger key (at least one trigger atom), AND
 *   - at least two of its members carry non-empty precondition atoms.
 * One-member groups and groups with a single preconditioned member cannot
 * have an "else branch" gap in a meaningful sense (there is no partition to
 * check for exhaustiveness), so they are skipped.
 *
 * ## Purity boundary
 *
 * Atomizer-agnostic: consumes {@link EncodedRequirement}s (from the pure
 * {@link encode}) and a {@link Z3Context}, touching the solver only via
 * {@link materialize}. It never imports `atomize.ts` or `z3-solver` directly.
 */

import type { Z3Context } from './backend.ts'
import type { SolverBounds } from './budget.ts'
import { atom, type EncodedRequirement, materialize, not, or } from './encode.ts'

/** A completeness finding (Appendix B `FND_INCOMPLETE`, info severity). */
export interface IncompleteFinding {
  code: 'FND_INCOMPLETE'
  severity: 'info'
  /**
   * The ids of all requirements in the same-trigger group whose preconditions
   * were checked and found non-exhaustive. The calling agent should review these
   * requirements and decide whether an else-branch is needed.
   */
  requirementIds: string[]
  /** The trigger-atom key that defines this group (the normalized trigger text). */
  triggerKey: string
  message: string
}

/**
 * The trigger atoms of an encoded requirement: normalized trigger slot atoms
 * (kind `trig`). Returns `undefined` for requirements with no trigger (the
 * grouping key is only meaningful when triggers exist).
 */
function triggerKey(e: EncodedRequirement): string | undefined {
  const trigAtoms = e.atoms.filter((a) => a.kind === 'trig').map((a) => a.atom)
  if (trigAtoms.length === 0) return undefined
  return [...new Set(trigAtoms)].sort().join(' ')
}

/**
 * Collect the precondition atom names for an encoded requirement. Returns an
 * empty array when the requirement has no precondition slots (or only has
 * trigger/response atoms). Negation is preserved: a negated precondition atom
 * contributes its NEGATED literal, so `¬P` participates as `¬P` in the
 * disjunction (AC-4-2a). `encode` emits no negated `pre` row, so a hand-built atom table is the
 * only input that can distinguish this from returning every literal positive —
 * `incomplete.test.ts` hands it one.
 */
function preconditionLiterals(e: EncodedRequirement): Array<{ name: string; negated: boolean }> {
  return e.atoms.filter((a) => a.kind === 'pre').map((a) => ({ name: a.atom, negated: a.negated }))
}

/**
 * Check one same-trigger-family group for completeness of precondition coverage.
 *
 * For `n` preconditioned requirements in the group (carrying atoms
 * `C1, C2, … Cn`), asserts `¬(C1 ∨ C2 ∨ … ∨ Cn)` and calls `solver.check()`:
 *
 *   - `unsat` → the preconditions are jointly exhaustive (in the propositional
 *     fragment); no finding. Requires a negated `pre` literal, which `encode` never emits.
 *   - `sat`   → there exists a model making all preconditions false simultaneously;
 *     a case might be missing; emit `FND_INCOMPLETE`.
 *   - `unknown` → inconclusive; treated conservatively as "can't prove covered",
 *     which means NO finding (the heuristic should never produce noise from
 *     solver indecision — that would be worse than a false negative).
 *
 * Returns `undefined` when the group is ineligible (no trigger key, or fewer
 * than 2 preconditioned members) or when the solver returns `unsat`/`unknown`.
 */
export async function checkGroupCompleteness(
  ctx: Z3Context,
  trigKey: string,
  encoded: readonly EncodedRequirement[],
  bounds: SolverBounds = {},
): Promise<IncompleteFinding | undefined> {
  // Only groups with a meaningful trigger (non-empty key) make sense to check:
  // a group with no trigger has no "event" whose cases need to be partitioned.
  if (trigKey === '') return undefined

  // Collect the preconditioned members (those with at least one 'pre' atom).
  const preconditioned = encoded.filter((e) => preconditionLiterals(e).length > 0)

  // Need at least 2 preconditioned members to reason about coverage: a single
  // branch cannot have an "else" gap in a meaningful sense.
  if (preconditioned.length < 2) return undefined

  // Gather ALL distinct precondition literals across the group, collecting one
  // disjunct per precondition atom of each member (with its polarity).
  // `¬(C1 ∨ C2 ∨ … ∨ Cn)` checks whether there is a case not covered by any.
  const disjuncts = preconditioned.flatMap((e) =>
    preconditionLiterals(e).map(({ name, negated: neg }) => {
      const base = atom(name)
      return neg ? not(base) : base
    }),
  )

  // Deduplicate disjuncts by structural key to avoid redundant atoms inflating
  // the disjunction (two members can share the same precondition atom).
  const seen = new Set<string>()
  const uniqueDisjuncts = disjuncts.filter((f) => {
    // Use a simple structural fingerprint: 'atom:name' or 'not:atom:name'.
    const key =
      f.op === 'atom'
        ? `atom:${f.name}`
        : f.op === 'not' && f.arg.op === 'atom'
          ? `not:${f.arg.name}`
          : JSON.stringify(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Build ¬(C1 ∨ … ∨ Cn). The `or` constructor collapses a single disjunct to
  // that disjunct itself; `not(single)` still works correctly.
  const coverage = not(or(uniqueDisjuncts))

  const solver = new ctx.Solver()
  // AC-1-7: bound this single solve. A timeout surfaces as `unknown`, which the
  // `res !== 'sat'` guard below already treats as "can't tell" → NO finding, so
  // a per-solver timeout can only suppress a heuristic hint, never emit one.
  if (bounds.timeoutMs !== undefined) solver.set('timeout', bounds.timeoutMs)
  solver.add(materialize(ctx, coverage))

  const res = await solver.check()

  // SAT → uncovered case → emit finding.
  // UNSAT → space covered → no finding.
  // unknown → treat conservatively as "can't tell" → no finding (avoid noise).
  if (res !== 'sat') return undefined

  const ids = [...new Set(preconditioned.map((e) => e.id))].sort()

  return {
    code: 'FND_INCOMPLETE',
    severity: 'info',
    requirementIds: ids,
    triggerKey: trigKey,
    message:
      `Requirements ${ids.join(', ')} share a trigger but their preconditions do not ` +
      `cover all cases (heuristic — only bites when preconditions normalize to ` +
      `complementary atoms; not a formal completeness guarantee).`,
  }
}

/**
 * Run the completeness heuristic over a whole spec: group by trigger key,
 * check each eligible group, collect `FND_INCOMPLETE` findings.
 *
 * Returns findings deduplicated by trigger key (each group reports at most one
 * finding). Async because the solver check is the only async boundary.
 *
 * Bounded per AC-1-7: `bounds.timeoutMs` bounds each group's solve and
 * `bounds.budget` is the whole-run deadline, checked BEFORE each group. Note the
 * grouping here is by TRIGGER key (this tier's own family notion) and the loop
 * never reorders or merges groups — truncation drops a suffix of groups, it never
 * mixes two, so the per-group discipline the SMT tiers rely on is intact.
 */
export async function checkCompleteness(
  ctx: Z3Context,
  all: readonly EncodedRequirement[],
  bounds: SolverBounds = {},
): Promise<IncompleteFinding[]> {
  // Group encoded requirements by their trigger key.
  const groups = new Map<string, EncodedRequirement[]>()
  for (const enc of all) {
    const key = triggerKey(enc) ?? ''
    const existing = groups.get(key)
    if (existing !== undefined) {
      existing.push(enc)
    } else {
      groups.set(key, [enc])
    }
  }

  const findings: IncompleteFinding[] = []
  let checkedGroups = 0
  for (const [key, members] of groups) {
    if (bounds.budget?.expired() === true) {
      bounds.budget.truncate('incomplete', groups.size - checkedGroups)
      break
    }
    checkedGroups += 1
    const finding = await checkGroupCompleteness(ctx, key, members, bounds)
    if (finding !== undefined) findings.push(finding)
  }
  return findings
}
