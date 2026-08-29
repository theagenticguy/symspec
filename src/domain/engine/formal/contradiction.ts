/**
 * Per-context-group contradiction detection (AC-4-3).
 *
 * The single soundness rule this module exists to enforce (research-smt.md §1.2
 * "the reachability subtlety", §5 pipeline): a trigger-guarded conflict is only
 * visible to the solver when the shared context is asserted *reachable*. Because
 * `(X ⇒ Y) ∧ (X ⇒ ¬Y)` is satisfiable (set `X = false`), a naive global
 * conjunction that never asserts any context finds nothing; and a global
 * conjunction that asserts ALL triggers true at once manufactures spurious
 * conflicts between mutually exclusive triggers (`X1` and `X2` that never
 * co-occur). Neither is acceptable.
 *
 * The correct discipline (spec AC-4-3):
 *
 *   1. Group requirements by their *context atoms* (the trigger/precondition
 *      atoms). Requirements whose context normalizes to the SAME atom set share
 *      a group; a ubiquitous requirement (bare `R`, no context) belongs to no
 *      non-empty group.
 *   2. For EACH group, assert THAT group's context atoms true — never every
 *      trigger at once — while including the guarded implication of EVERY
 *      requirement in the spec in the conjunction (whole-spec, not just the
 *      group's members). Other requirements — including ubiquitous ones —
 *      participate through shared response atoms: a ubiquitous `¬R` conflicts
 *      with an event-driven `T ⇒ R` only when the ubiquitous formula is present
 *      while `T` is asserted. Dropping the whole-spec formulas would make that
 *      conflict unreachable.
 *   3. A baseline empty-context group (assert nothing extra) catches
 *      unconditional conflicts — two ubiquitous requirements `R` and `¬R` — that
 *      no trigger group is needed to reach. This is required for an all-
 *      ubiquitous spec where no non-empty group exists; it asserts NO triggers,
 *      which is the opposite of the forbidden "assert all triggers" global
 *      check.
 *
 * Each group check runs `solver.check(...allGuards)` with the group's context
 * atoms `add()`ed as plain assertions. The guards (requirement ids) are the
 * ONLY assumption literals, so `unsatCore()` returns exactly the participating
 * requirement ids — context assertions can never appear in the core (they are
 * not assumptions), so no `CTX-*` filtering is needed with this API surface
 * (research-smt.md §1.3 note; z3-solver assumption-literal core semantics).
 *
 * Scope boundary with sibling tasks:
 *   - Atom construction, per-system scoping, negation-on-same-atom, and the
 *     antonym table are owned by `atomize.ts` (AC-4-2a). This module consumes
 *     `atomize` through the injected `Atomize` shape the encoder defines,
 *     adapting the real function's signature here.
 *   - The guarded-implication encoding is owned by `encode.ts` (AC-4-2).
 *   - MINIMAL unsat-core extraction (the "exactly the REQ-* members, no innocent
 *     third" guarantee, AC-4-4) is implemented here. Z3 unsat cores are NOT
 *     guaranteed minimal by default (z3guide), and because each group's
 *     conjunction spans the WHOLE spec (AC-4-3) an innocent requirement that
 *     shares no atom with the conflict could otherwise ride along in the raw
 *     core. Two belt-and-suspenders measures enforce minimality on the
 *     in-process WASM path (AC-4-4): (a) the z3-only `smt.core.minimize` solver
 *     option is enabled, and (b) a deletion-based assumption-literal re-check
 *     pass ({@link minimizeCore}) shrinks the core to a smallest still-`unsat`
 *     subset. The z3-only option is confined to this in-process path and is
 *     deliberately NOT baked into the portable `.smt2` artifact (AC-4-8), which
 *     documents cvc5's `--minimal-unsat-cores` instead.
 *   - CTX-* filtering (AC-4-4): context atoms are `add()`ed as PLAIN assertions,
 *     never as assumption literals, so — by the z3-solver assumption-core
 *     semantics — they can never appear in `unsatCore()`. The `guardByString`
 *     lookup is the structural CTX-* filter: any core member that is not a
 *     requirement guard maps to `undefined` and is dropped, leaving EXACTLY the
 *     `REQ-*` members.
 *   - Per-group `unknown`/timeout handling as `FND_NEEDS_REVIEW` is AC-4-7. Here
 *     an inconclusive group is skipped (never interpreted as "no conflict" that
 *     would be reported as absence of a finding — it simply contributes no
 *     contradiction), which AC-4-7 will upgrade to an explicit review finding.
 */

import { atomize as realAtomize } from './atomize.ts'
import type { Z3Context } from './backend.ts'
import { getContext } from './backend.ts'
import {
  type Atomize,
  type EncodableRequirement,
  type EncodedRequirement,
  encode,
  materialize,
  type Z3Bool,
} from './encode.ts'
import { extractGuardImplications } from './guard-implication.ts'

/** A live `z3-solver` Solver instance, as produced by {@link Z3Context}. */
type Z3Solver = InstanceType<Z3Context['Solver']>

/**
 * A contradiction finding (Appendix B `FND_CONTRADICTION`, severity `error`).
 *
 * Minimal self-contained shape owned by this task: `requirementIds` are the
 * filtered unsat-core members. The richer `evidence` field (atom table +
 * core/witness) is threaded by AC-4-6 (`finding.ts`) and the single `FND_*`
 * enum by AC-6-3 (`formal/codes.ts`); both layer onto this without changing the
 * detection here.
 */
export interface ContradictionFinding {
  readonly code: 'FND_CONTRADICTION'
  readonly severity: 'error'
  /** The conflicting requirement ids, deduplicated and lexicographically sorted. */
  readonly requirementIds: string[]
  /** Human/agent-readable summary of the conflict. */
  readonly message: string
}

/**
 * Adapter from the AC-4-2a `atomize({ kind, text, systemName, negated })` shape
 * to the encoder's positional `Atomize` contract. Kept in this integration file
 * per the encode.ts design note ("the integration tier passes the real AC-4-2a
 * atomize, adapting its signature in its own file").
 */
const defaultAtomize: Atomize = (kind, slotText, systemName, negated) => {
  const a = realAtomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}

/** The trigger/precondition atom names of an encoded requirement (its context). */
export function contextAtomsOf(enc: EncodedRequirement): string[] {
  return enc.atoms.filter((a) => a.kind === 'trig' || a.kind === 'pre').map((a) => a.atom)
}

/**
 * Group-key separator for joined atom names: U+0000, which `atomize` can never
 * emit, so `{a, b_c}` and `{a_b, c}` cannot collide on one key. Written as an
 * escape rather than a literal control character because a literal NUL makes git
 * classify the whole file as binary, and this subtree's review discipline is the
 * diff.
 */
const GROUP_KEY_SEP = '\u0000'

/** A planned context group: the atoms to assert true for this reachability check. */
export interface ContextGroup {
  /** Stable key = the sorted, deduplicated context atoms joined; `''` = baseline. */
  readonly key: string
  /** The context atoms to assert true (empty for the baseline group). */
  readonly contextAtoms: string[]
}

/**
 * THE group key for one requirement's context atoms — sorted, deduplicated,
 * {@link GROUP_KEY_SEP}-joined.
 *
 * Exported because a consumer that recovers a group's MEMBERS has to rebuild
 * this key per requirement and compare it to {@link ContextGroup.key}, and the
 * separator is the one byte the two sides must agree on. A second copy joining
 * on a different string matches only single-atom contexts: every group of ≥2
 * atoms silently finds no members, and a tier that names its members reports
 * nothing at all for exactly the groups where two slots meet.
 */
export function contextGroupKey(contextAtoms: readonly string[]): string {
  return [...new Set(contextAtoms)].sort().join(GROUP_KEY_SEP)
}

/**
 * Whether a requirement whose guard atoms are `contextAtoms` is LIVE in `group`
 * — i.e. every one of its guard atoms is asserted there, so its obligation holds
 * wherever the group's context holds.
 *
 * THE definition of co-liveness, so no tier can hold a second one. It is the
 * condition {@link findContradictions} creates physically by `add()`ing a
 * group's context atoms: a requirement whose guard is a subset participates,
 * one carrying an unasserted guard atom does not.
 *
 * A UBIQUITOUS requirement (`contextAtoms` empty) is live in EVERY group,
 * `[] ⊆ anything`, which is correct — an unconditional obligation holds under
 * every context — and is why an all-ubiquitous document has exactly the one
 * baseline group and every requirement in it. A tier that additionally requires
 * a NON-EMPTY guard is asking a different question (which GUARDED pairs met) and
 * says so at its call site.
 */
export function liveIn(group: ContextGroup, contextAtoms: readonly string[]): boolean {
  return contextAtoms.every((a) => group.contextAtoms.includes(a))
}

/**
 * Plan the context groups over raw context-atom sets. Pure and deterministic —
 * no solver contact — so the grouping discipline is unit testable on its own
 * (mutually exclusive triggers land in DISTINCT groups; the baseline empty group
 * is always present).
 *
 * Groups are the DISTINCT context-atom sets across the spec, plus one baseline
 * empty-context group. Two requirements sharing a trigger unify into one group
 * (their conflict becomes reachable); two requirements with different triggers
 * stay in separate groups (each group asserts only its own trigger, so mutually
 * exclusive triggers are never asserted together and cannot fake a conflict).
 *
 * Takes the atom sets rather than {@link EncodedRequirement}s so a tier that
 * carries its own per-requirement context — the numeric tier, whose population is
 * every requirement rather than the propositional gate's included subset — plans
 * the SAME groups through the same code instead of a second implementation of the
 * rule that decides.
 */
export function planGroups(contexts: readonly (readonly string[])[]): ContextGroup[] {
  // Baseline empty-context group is always first, so unconditional (ubiquitous
  // vs ubiquitous) conflicts are checked even for an all-ubiquitous spec.
  const groups = new Map<string, string[]>()
  groups.set('', [])
  for (const context of contexts) {
    const uniq = [...new Set(context)].sort()
    if (uniq.length === 0) continue
    groups.set(contextGroupKey(uniq), uniq)
  }
  return [...groups].map(([key, contextAtoms]) => ({ key, contextAtoms }))
}

/** {@link planGroups} over the context atoms of an encoded requirement set. */
export function planContextGroups(encoded: readonly EncodedRequirement[]): ContextGroup[] {
  return planGroups(encoded.map(contextAtomsOf))
}

/** Options for {@link findContradictions}. */
export interface FindContradictionsOptions {
  /**
   * Atom-table function (AC-4-2a). Defaults to the real `atomize`; injectable so
   * a test can pin atomization behavior. The default is the sound choice — the
   * whole-spec reachability proof (AC-4-3) exercises the real atomizer.
   */
  atomize?: Atomize
  /** Per-group solver timeout in ms (research-smt.md §2.3). Default 2000. */
  timeoutMs?: number
}

/**
 * The requirement id a guard assumption literal names.
 *
 * {@link encode} sets `guard = req.id`, so the Z3 symbol's TEXT is the requirement
 * id. Z3 renders a symbol whose text is not a legal SMT-LIB2 *simple* symbol —
 * a UUID beginning with a digit — as a `|...|`-quoted symbol, so the delimiters
 * come back off to recover the id.
 */
function guardId(guard: Z3Bool): string {
  return guard.toString().replace(/^\|(.*)\|$/, '$1')
}

/** Ascending requirement id: the canonical visit order for core minimization. */
function byGuardId(a: Z3Bool, b: Z3Bool): number {
  const x = guardId(a)
  const y = guardId(b)
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

/**
 * Deletion-based minimization of an unsat core (AC-4-4).
 *
 * Z3 does not guarantee a minimal core even with `smt.core.minimize`, and the
 * whole-spec conjunction (AC-4-3) means the raw core can contain a requirement
 * that is not actually part of the conflict. This pass shrinks `core` to a
 * MINIMAL (irreducible) still-`unsat` subset: for each candidate guard, re-check
 * the conjunction with that guard dropped from the assumption set; if the result
 * is still `unsat` the guard was inessential and is removed permanently.
 *
 * The re-check uses `solver.check(...assumptions)` on the SAME solver — the
 * whole-spec formulas and this group's context atoms are already `add()`ed as
 * permanent assertions, and assumptions are temporary per z3-solver semantics,
 * so no solver rebuild or `push`/`pop` is needed. The result is guaranteed
 * irreducible: on return, dropping ANY remaining guard makes the subset `sat`.
 *
 * Cost is bounded: at most `|core|` re-checks (each O(spec) but over a handful
 * of guards for the 2–3 requirement conflicts this targets), and only runs on a
 * group that already returned `unsat`.
 *
 * `unknown` from a re-check is treated conservatively as "cannot prove this
 * guard inessential", so the guard is KEPT — never dropped on an inconclusive
 * answer, which would risk an under-reported (missing) culprit.
 *
 * ## Why the visit order is canonicalized (invariant 5, determinism)
 *
 * A group can admit MORE THAN ONE minimal unsat subset — one rule demanding a
 * response and two forbidding it gives `{A,B}` and `{A,C}`, with `{B,C}` sat — and
 * deletion visits candidates in the order it receives them, so which subset
 * survives is decided by that order. Sorting on requirement id first makes the
 * result a function of the passed core's MEMBERSHIP alone, and returns it in the
 * ascending-id order the finding reports.
 *
 * The scope of that, exactly: this sort is the SECOND line of defence, not the one
 * that decides today's output. Measured on this z3-solver build, a
 * two-minimal-core group returns an already-irreducible 2-element `unsatCore()`, so
 * the loop below bails at its first iteration and this sort reorders a pair and
 * changes nothing. WHICH of the group's minimal cores arrives is decided by the
 * sequence the solver was fed, which is why {@link findContradictions} sorts its
 * assertion and assumption sequences too. This sort is what keeps the answer stable
 * if a solver returns the same core in a different order, or a core wide enough for
 * the deletion pass to bite — neither of which `smt.core.minimize` promises to
 * prevent (see the module header). `contradiction.test.ts` gates the two layers
 * separately, because a fixture that reaches one does not reach the other.
 */
export async function minimizeCore(solver: Z3Solver, core: readonly Z3Bool[]): Promise<Z3Bool[]> {
  // Only core members are candidates: a guard the solver assumed but left OUT of
  // the core is not needed for THIS unsat proof, so removing it cannot make the
  // subset sat. It may well be essential to a DIFFERENT minimal core — which is
  // precisely why the pass can only refine the core it is handed, and why the
  // caller must feed the solver a canonical sequence to fix which core that is.
  // Re-checks assume ONLY the kept guards; any guard left unassumed has its
  // implication satisfied vacuously (z3 is free to set the guard false), so it
  // cannot re-enter a resulting core. That is exactly the minimization we want.
  const kept = [...core].sort(byGuardId)
  for (let i = 0; i < kept.length; ) {
    const candidate = kept.filter((_, j) => j !== i)
    // A single remaining assumption can never be a cross-requirement conflict;
    // stop shrinking once we would go below a pair. (The caller also enforces
    // the ≥2 floor, but stopping here avoids a pointless final re-check.)
    if (candidate.length < 2) break
    const res = await solver.check(...candidate)
    if (res === 'unsat') {
      // Guard `kept[i]` was inessential; drop it and re-examine index i.
      kept.splice(i, 1)
    } else {
      // `sat` (essential) or `unknown` (unprovable-inessential) → keep it.
      i++
    }
  }
  return kept
}

/**
 * Detect contradictions across a whole spec via per-context-group whole-spec
 * reachability checks (AC-4-3).
 *
 * Async because the solver call is the only asynchronous boundary. Everything
 * up to the check (encode, atomize, group) is deterministic. Returns one
 * `FND_CONTRADICTION` per distinct conflicting requirement-id set (deduped
 * across groups), or `[]` when the spec is consistent as atomized.
 *
 * A contradiction is detectable ONLY when two responses resolve to the SAME
 * atom with opposite polarity (explicit `shall not` via AC-2-4, or an antonym
 * pair via AC-4-2a). Conflicts across unrelated response atoms are a documented
 * false negative (sound modulo atomization, AC-4-11) — the correct failure
 * direction for a linter.
 */
export async function findContradictions(
  reqs: readonly EncodableRequirement[],
  options: FindContradictionsOptions = {},
): Promise<ContradictionFinding[]> {
  if (reqs.length < 2) return []

  const atomize = options.atomize ?? defaultAtomize
  const timeoutMs = options.timeoutMs ?? 2000

  const encoded = reqs.map((r) => encode(r, atomize))
  const ctx = await getContext('symspec-contradiction')

  // #2: guard-implication closure. A bridge requirement ("while authenticated,
  // be verified") asserts `authenticated ⟹ verified`, but its response atomizes
  // to a RESPONSE atom that never links to the GUARD atom another rule keys on.
  // Re-encode each such bridge as `bridgeId ⟹ (context ⟹ stateAsGuard)` and add
  // it to the whole-spec conjunction, so the solver computes the transitive
  // closure: asserting a bridge's antecedent context forces the established
  // state, activating a rule guarded on that state and making a previously
  // unreachable conflict UNSAT. Guarded by the bridge id, so the bridge appears
  // in the unsat core alongside the two conflicting rules. Sound: it only
  // re-expresses an implication the spec already asserts.
  const bridges = extractGuardImplications(reqs, atomize)
  const bridgeAsts = [...bridges]
    .sort((a, b) => (a.bridgeId < b.bridgeId ? -1 : a.bridgeId > b.bridgeId ? 1 : 0))
    .map((b) => materialize(ctx, b.formula))

  // Materialize each requirement's guarded formula once; z3 interns Bool consts
  // by name within a context, so these ASTs are safe to reuse across the fresh
  // Solver we build per group.
  //
  // ## Why the solver-facing sequences are id-sorted (invariant 5, determinism)
  //
  // A group can admit MORE THAN ONE minimal unsat subset — one rule demanding a
  // response and two forbidding it gives `{A,B}` and `{A,C}`, with `{B,C}` sat.
  // Which one `unsatCore()` names is a function of the sequence the solver was
  // fed, and the enumeration loop below then drops that core's guards, so only
  // ONE of the two overlapping conflicts is ever reported. `requirementIds` and
  // the ids interpolated into `message` are output bytes, so feeding the solver
  // in DOCUMENT order makes those bytes depend on where in the file an author
  // happened to put a requirement: moving a rule up three lines renames the
  // culprit. Sorting the assertion and assumption sequences on requirement id
  // makes every byte handed to the solver a function of the requirement SET, so
  // the reported culprits are too. `contradiction.test.ts` pins it across every
  // permutation of the fixture, through this function rather than the minimizer.
  //
  // Reporting either overlapping conflict is sound — both are real, and the
  // unreported one is a MISS, the honest direction. What is not acceptable is
  // which one being decided by file position.
  const solverOrder = [...encoded].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const formulaAsts = solverOrder.map((e) => materialize(ctx, e.formula))

  // Guard assumption literals: their string form maps back to the requirement
  // id. The core returns a subset of exactly these, so id recovery needs no
  // CTX-* filtering.
  const guardByString = new Map<string, string>()
  const guardAsts = solverOrder.map((e) => {
    const g = ctx.Bool.const(e.guard)
    guardByString.set(g.toString(), e.id)
    return g
  })

  const findings = new Map<string, ContradictionFinding>()

  for (const group of planContextGroups(encoded)) {
    const solver = new ctx.Solver()
    solver.set('timeout', timeoutMs)
    // AC-4-4: enable z3's own core minimization on the in-process WASM path.
    // This is a z3-only option and is intentionally NOT emitted into the
    // portable `.smt2` artifact (AC-4-8) — that path documents cvc5's
    // `--minimal-unsat-cores`. Belt-and-suspenders with `minimizeCore` below.
    solver.set('smt.core.minimize', true)
    for (const f of formulaAsts) solver.add(f)
    // #2: the guard-implication bridges are part of the whole-spec conjunction —
    // each is guarded by its bridge id (an assumption literal), so a bridge only
    // takes effect when its requirement is assumed and it can appear in the core.
    for (const f of bridgeAsts) solver.add(f)
    for (const name of group.contextAtoms) solver.add(ctx.Bool.const(name))

    // A single group can host MORE THAN ONE independent conflict — two disjoint
    // requirement pairs whose responses clash on DIFFERENT atoms are both
    // reachable under the same asserted context (and the all-ubiquitous baseline
    // group can host any number). A single `check`/core extraction would surface
    // only the first and silently drop the rest — a false negative for a
    // conflict detector. So enumerate: after recording a minimal core, drop its
    // guards from the assumption set and re-check. Each iteration removes ≥2
    // assumed guards, so the loop terminates; dropping a guard leaves that
    // requirement's implication vacuously satisfiable (z3 may set the guard
    // false), which cannot manufacture a spurious core — it only prevents
    // re-deriving a conflict already reported. This finds every pairwise-DISJOINT
    // conflict in the group.
    let assumptions = [...guardAsts]
    while (assumptions.length >= 2) {
      const res = await solver.check(...assumptions)
      // `unknown`/timeout is never "no conflict"; stop enumerating this group
      // here (AC-4-7 upgrades a per-group inconclusive to FND_NEEDS_REVIEW).
      if (res !== 'unsat') break

      // The raw core is a subset of the guard assumption literals. Context atoms
      // are plain assertions, never assumptions, so they can never be here —
      // hence no textual `CTX-*` filter is needed; the guard lookup below is the
      // filter. Minimize (AC-4-4) so an innocent whole-spec requirement that
      // shares no atom cannot ride along.
      const rawCore = [...solver.unsatCore()].filter((b) => guardByString.has(b.toString()))
      if (rawCore.length === 0) break
      const minimal = await minimizeCore(solver, rawCore)
      const ids = minimal
        .map((b) => guardByString.get(b.toString()))
        .filter((x): x is string => x !== undefined)

      // Drop the core's guards from the assumption set so the NEXT check finds a
      // different (disjoint) conflict rather than re-deriving this one. Uses the
      // raw-core membership (superset of `minimal`) so a guard the minimizer
      // pruned as inessential is not re-assumed into an identical loop.
      const coreStrs = new Set(rawCore.map((b) => b.toString()))
      assumptions = assumptions.filter((g) => !coreStrs.has(g.toString()))

      // A contradiction is a joint property of ≥2 requirements. A degenerate
      // single-id (or empty) core cannot be a cross-requirement conflict.
      const unique = [...new Set(ids)].sort()
      if (unique.length < 2) continue

      const key = unique.join(',')
      if (!findings.has(key)) {
        findings.set(key, {
          code: 'FND_CONTRADICTION',
          severity: 'error',
          requirementIds: unique,
          message:
            `Requirements ${unique.join(', ')} cannot all hold: their responses resolve to ` +
            'the same atom with opposite polarity under a reachable context.',
        })
      }
    }
  }

  return [...findings.values()]
}
