/**
 * Guard-implication closure for the contradiction tier (#2).
 *
 * ## The gap this closes
 *
 * The contradiction tier only reaches a conflict when the conflicting rules
 * share a *reachable context* (see `contradiction.ts` — `planContextGroups`
 * groups by identical context-atom sets). So a rule guarded on `authenticated`
 * and one guarded on `verified` are never asserted together, and a real conflict
 * between them stays invisible — EVEN WHEN the spec itself contains a bridge
 * requirement that says "while authenticated, the system shall be verified",
 * i.e. `authenticated ⟹ verified`.
 *
 * The bridge's own encoding does NOT close the gap: its response "be verified"
 * atomizes to a RESPONSE atom (`sys__x__resp__verified`), a different atom from
 * the GUARD atom (`sys__x__pre__verified`) the other rule keys on. So the state
 * it establishes never links to the guard that names the same state.
 *
 * ## The fix (sound, deterministic)
 *
 * For each requirement that (a) has a context (a `pre`/`trig` guard) and (b)
 * whose response is a recognized STATE-ESTABLISHMENT ("be/become/mark/set …
 * <state>"), extract the state phrase, re-atomize it as a GUARD atom, and emit
 * the implication `bridgeId ⟹ (context ⟹ stateAsGuard)`. Asserting this into
 * the whole-spec conjunction lets the SMT solver compute the transitive closure
 * itself: in the group that asserts `authenticated`, the bridge forces
 * `verified`, activating the rule guarded on `verified`, so its conflict with
 * the `authenticated`-guarded rule becomes UNSAT — and the unsat core names the
 * bridge alongside the two conflicting rules.
 *
 * ## Why this is sound (not a "guess the contradiction" heuristic)
 *
 * The emitted implication is a faithful re-encoding of what the bridge
 * requirement ALREADY asserts, guarded by the bridge's own id — so any conflict
 * it makes reachable is a real conflict GIVEN the bridge, and the finding names
 * the bridge so a reader can audit it. The tool stays "sound modulo
 * atomization": the only judgement added is recognizing a state-establishment
 * response, which is deliberately conservative (a fixed verb lexicon, no
 * model). Two extra guards bound the surface:
 *   - the established state, re-atomized as a guard, must EXACTLY match a guard
 *     atom actually used by ANOTHER requirement — otherwise the implication is
 *     inert (its consequent appears in no other formula), so it is dropped
 *     rather than polluting the conjunction;
 *   - the bridge's own response-vs-established-state never self-links (a rule is
 *     not its own bridge).
 * A mis-recognized establishment can therefore only ADD a true-to-the-doc
 * implication whose consequent some rule already guards on; it cannot invent an
 * atom out of nothing.
 */

import { atomize as realAtomize } from './atomize.js'
import {
  type Atomize,
  and,
  atom,
  type EncodableRequirement,
  type Formula,
  implies,
  not,
} from './encode.js'

/**
 * One extracted guard-implication bridge: the requirement it came from and the
 * `bridgeId ⟹ (context ⟹ state)` formula to assert into the whole-spec
 * conjunction. `formula` is guarded by the bridge id so the unsat core names it.
 */
export interface GuardImplication {
  /** The bridge requirement's id (also the guard literal on `formula`). */
  readonly bridgeId: string
  /** `atom(bridgeId) ⟹ (context ⟹ stateLiteral)`. */
  readonly formula: Formula
}

/**
 * The conservative state-establishment verb lexicon. A response led by one of
 * these (optionally followed by an article) establishes the remaining phrase as
 * a state. `mark`/`set`/`flag`/`consider`/`treat` also support the
 * "mark <thing> as <state>" / "set <thing> to <state>" object form, handled
 * separately. High-precision by design — grow only by explicit edit.
 */
const ESTABLISH_VERBS: ReadonlySet<string> = new Set([
  'be',
  'become',
  'becomes',
  'been',
  'is',
  'are',
  'remain',
  'remains',
  'stay',
  'stays',
  'mark',
  'marks',
  'set',
  'sets',
  'flag',
  'flags',
  'consider',
  'considers',
  'treat',
  'treats',
  'enter',
  'enters',
])

/**
 * Extract the established STATE phrase from a response, or `null` when the
 * response is not a recognized state-establishment. Deterministic and
 * conservative:
 *   - "mark/set/flag/consider/treat <thing> as|to <state>" → `<state>`;
 *   - "<verb> <state>" where `<verb>` is an establishment verb → `<state>`
 *     (a leading article after the verb is dropped by the atomizer's normalize).
 * Returns the raw substring; the caller atomizes it (so glossary/normalize
 * canonicalization applies uniformly).
 */
export function establishedState(response: string): string | null {
  const trimmed = response.trim()
  if (trimmed === '') return null
  const words = trimmed.split(/\s+/)
  const head = words[0]?.toLowerCase() ?? ''
  if (!ESTABLISH_VERBS.has(head)) return null

  // Object form: "mark the session as verified" / "set the flag to active".
  // Take the phrase after the LAST " as "/" to " connector.
  const asMatch = /\b(?:as|to)\s+(.+)$/i.exec(trimmed)
  if (
    asMatch?.[1] !== undefined &&
    (head === 'mark' ||
      head === 'marks' ||
      head === 'set' ||
      head === 'sets' ||
      head === 'flag' ||
      head === 'flags' ||
      head === 'consider' ||
      head === 'considers' ||
      head === 'treat' ||
      head === 'treats')
  ) {
    return asMatch[1].trim()
  }

  // Bare form: drop the leading establishment verb; the rest is the state.
  const rest = words.slice(1).join(' ').trim()
  return rest === '' ? null : rest
}

/**
 * Compute the guard-implication bridges the spec asserts (#2).
 *
 * `atomize` MUST be the same (glossary/antonym-aware) atomizer the contradiction
 * tier uses, so the state atom a bridge establishes and the guard atom another
 * rule keys on canonicalize identically. Pure and deterministic — no solver
 * contact.
 *
 * A requirement contributes a bridge only when: it has a context guard; its
 * response is a recognized state-establishment; and the established state,
 * re-atomized as a `pre` guard, matches a guard atom used by SOME OTHER
 * requirement (so the implication is not inert). The emitted formula is
 * `bridgeId ⟹ (context ⟹ stateLiteral)`, with `stateLiteral` carrying the
 * response's negation (a "shall not be verified" bridge establishes ¬verified).
 */
export function extractGuardImplications(
  reqs: readonly EncodableRequirement[],
  atomize: Atomize,
): GuardImplication[] {
  if (reqs.length < 2) return []

  // The set of guard atoms actually used across the spec — the consequent of a
  // bridge must land here or the implication is inert (dropped).
  const guardAtoms = new Set<string>()
  for (const r of reqs) {
    if (r.preCondition !== undefined && r.preCondition !== '') {
      guardAtoms.add(atomize('pre', r.preCondition, r.systemName, false).atom)
    }
    if (r.trigger !== undefined && r.trigger !== '') {
      guardAtoms.add(atomize('trig', r.trigger, r.systemName, false).atom)
    }
  }

  const out: GuardImplication[] = []
  for (const r of reqs) {
    // Must have a context to bridge FROM.
    const contextLits: Formula[] = []
    if (r.preCondition !== undefined && r.preCondition !== '') {
      const p = atomize('pre', r.preCondition, r.systemName, false)
      contextLits.push(p.negated ? not(atom(p.atom)) : atom(p.atom))
    }
    if (r.trigger !== undefined && r.trigger !== '') {
      const t = atomize('trig', r.trigger, r.systemName, false)
      contextLits.push(t.negated ? not(atom(t.atom)) : atom(t.atom))
    }
    if (contextLits.length === 0) continue

    const stateText = establishedState(r.systemResponse)
    if (stateText === null) continue

    // Re-atomize the established state as a GUARD (pre) atom, threading the
    // response's negation so "shall not be verified" establishes ¬verified. The
    // response's own negation is what `encode` would pass as the resp negation;
    // recompute it here via the resp atomization so glossary/antonym rewrites of
    // the response verb compose correctly.
    const respNegated = atomize('resp', r.systemResponse, r.systemName, r.negated ?? false).negated
    const stateAtomLit = atomize('pre', stateText, r.systemName, respNegated)

    // Inert-implication guard: the consequent must be a guard some OTHER
    // requirement keys on. A rule is never its own bridge.
    if (!guardAtoms.has(stateAtomLit.atom)) continue

    const stateLiteral: Formula = stateAtomLit.negated
      ? not(atom(stateAtomLit.atom))
      : atom(stateAtomLit.atom)

    out.push({
      bridgeId: r.id,
      formula: implies(atom(r.id), implies(and(contextLits), stateLiteral)),
    })
  }
  return out
}

/** Default atomizer adapter mirroring `contradiction.ts` (glossary-free path). */
export const defaultBridgeAtomize: Atomize = (kind, slotText, systemName, negated) => {
  const a = realAtomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}
