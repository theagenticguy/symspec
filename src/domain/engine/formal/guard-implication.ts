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

import { atomize as realAtomize } from './atomize.ts'
import {
  type Atomize,
  and,
  atom,
  type EncodableRequirement,
  type Formula,
  implies,
  not,
} from './encode.ts'
import { deInflectHead } from './lemma.ts'

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
 * The conservative state-establishment verb lexicon, in BASE form — heads are
 * de-inflected ({@link deInflectHead}: "marks"→"mark", "keeps"→"keep",
 * "kept"→"keep") before the lookup, so inflected phrasings need no hand-listed
 * variants. A response led by one of these (optionally followed by an article)
 * establishes the remaining phrase as a state. The verbs in
 * {@link OBJECT_FORM_VERBS} also support the "mark <thing> as <state>" /
 * "set <thing> to <state>" / "escalate <thing> to <state>" object form, handled
 * separately. High-precision by design — grow only by explicit edit.
 */
const ESTABLISH_VERBS: ReadonlySet<string> = new Set([
  'be',
  'become',
  'been',
  'is',
  'are',
  'remain',
  'stay',
  'mark',
  'set',
  'flag',
  'consider',
  'treat',
  'enter',
  // Adversarial-eval expansion: bridge verbs the Run 2/3 specs used.
  'classify',
  'label',
  'record',
  'register',
  'designate',
  'escalate',
  'promote',
  'transition',
  'place',
  // "keeps the reactor online" / "hold the coolant valve sealed": the remainder
  // after the verb IS the state ("the reactor online" ≡ guard "the reactor is
  // online" after copula normalization). The inert-implication guard keeps
  // misparses harmless — an unmatched state never enters the conjunction.
  'keep',
  'hold',
])

/**
 * The establish verbs that take the object form
 * "<verb> <thing> as|to|into|in <state>" — the connector introduces the state.
 */
const OBJECT_FORM_VERBS: ReadonlySet<string> = new Set([
  'mark',
  'set',
  'flag',
  'consider',
  'treat',
  'classify',
  'label',
  'record',
  'register',
  'designate',
  'escalate',
  'promote',
  'transition',
  'place',
  'keep',
  'hold',
])

/**
 * Extract the established STATE phrase from a response, or `null` when the
 * response is not a recognized state-establishment. Deterministic and
 * conservative; the head verb is de-inflected before the lexicon lookup:
 *   - "<object-form verb> <thing> as|to|into|in <state>" → `<state>`
 *     ("mark the session as verified", "escalate the principal to privileged",
 *     "place the record in quarantine");
 *   - "<verb> <state>" where `<verb>` is an establishment verb → `<state>`
 *     ("keeps the reactor online" → "the reactor online"; a leading article and
 *     any copula are dropped by the atomizer's guard normalization, so the
 *     state matches a guard phrased "while the reactor is online").
 * Returns the raw substring; the caller atomizes it (so glossary/normalize/
 * copula canonicalization applies uniformly).
 */
export function establishedState(response: string): string | null {
  const candidates = establishedStateCandidates(response)
  // The single-reading view is the BARE state (last candidate) — the object
  // form's connector-introduced phrase ("verified" in "mark the session as
  // verified"), matching the original contract of this function.
  const last = candidates[candidates.length - 1]
  return last ?? null
}

/**
 * All candidate readings of the established state, most specific first. The
 * object form is genuinely ambiguous about how the matching guard is phrased:
 * "mark the session as verified" establishes a state a guard may name either as
 * "the session (is) verified" (subject included) or just "verified" — so BOTH
 * candidates are offered and {@link extractGuardImplications} bridges on
 * whichever one an actual guard uses. Sound: each candidate is an honest
 * re-encoding of the same doc assertion, and the inert-implication filter
 * drops any candidate no guard names.
 */
export function establishedStateCandidates(response: string): string[] {
  const trimmed = response.trim()
  if (trimmed === '') return []
  const words = trimmed.split(/\s+/)
  const head = deInflectHead(words[0]?.toLowerCase() ?? '')
  if (!ESTABLISH_VERBS.has(head)) return []

  // Object form: "mark the session as verified" / "set the flag to active" /
  // "escalate the principal to privileged" / "place the record in quarantine".
  // The state phrase follows the LAST " as "/" to "/" into "/" in " connector;
  // the object phrase sits between the verb and the connector.
  const asMatch = /^(.+?)\s+\b(?:as|to|into|in)\s+(.+)$/i.exec(words.slice(1).join(' '))
  if (asMatch?.[2] !== undefined && OBJECT_FORM_VERBS.has(head)) {
    const object = (asMatch[1] as string).trim()
    const state = asMatch[2].trim()
    const candidates = [state]
    if (object !== '') candidates.unshift(`${object} ${state}`)
    return candidates
  }

  // Bare form: drop the leading establishment verb; the rest is the state.
  const rest = words.slice(1).join(' ').trim()
  return rest === '' ? [] : [rest]
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

    const stateTexts = establishedStateCandidates(r.systemResponse)
    if (stateTexts.length === 0) continue

    // Re-atomize each candidate state as a GUARD (pre) atom, threading the
    // response's negation so "shall not be verified" establishes ¬verified. The
    // response's own negation is what `encode` would pass as the resp negation;
    // recompute it here via the resp atomization so glossary/antonym rewrites of
    // the response verb compose correctly. The FIRST candidate that lands on a
    // guard some other requirement uses wins (most specific — object+state —
    // first); non-landing candidates are inert and dropped.
    const respNegated = atomize('resp', r.systemResponse, r.systemName, r.negated ?? false).negated
    for (const stateText of stateTexts) {
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
      break
    }
  }
  return out
}

/** Default atomizer adapter mirroring `contradiction.ts` (glossary-free path). */
export const defaultBridgeAtomize: Atomize = (kind, slotText, systemName, negated) => {
  const a = realAtomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}
