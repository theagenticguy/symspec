import { describe, expect, it } from 'vitest'
import type { ReqView } from '../../solvers/types.js'
import { atomize, makeAtomize } from '../atomize.js'
import {
  earsToTemporal,
  F,
  G,
  type TemporalFormula,
  tAtom,
  tImplies,
  tNot,
} from '../temporal-patterns.js'

/**
 * Per-pattern shape tests for the EARS → Dwyer/SPS temporal mapping (AC-33-1).
 * The mapping is pure, so we assert directly on the returned AST structure —
 * no solver, no WASM boot.
 *
 * ## AC-2-7 revised several expectations in this file DELIBERATELY
 *
 * Atom names here are no longer produced by a private normalizer that this tier
 * owned; they come from the SHARED `atomize` the propositional encoder uses, so
 * a temporal atom and its propositional counterpart line up by construction
 * rather than by two files agreeing. Three expectations changed as a result, and
 * each change is the propositional semantics winning a measured divergence:
 *
 *   - the `state-driven` guard was pinned as `…__pre__maintenance_mode_is_enabled`
 *     (copula kept). The propositional atomizer drops one copula token from every
 *     guard slot, so the pinned atom was exactly the one atom the two tiers could
 *     never share for the same real-world condition. Now
 *     `…__pre__maintenance_mode_enabled`.
 *   - the `optional-feature` guard was pinned as
 *     `…__feat__sso_is_configured_for_the_tenant` (copula kept). Same repair; the
 *     `feat` KIND is deliberately preserved (see the `feat` test below).
 *   - `earsToTemporal` now takes the atomizer as a required second argument.
 *     That is the point of the AC: the blindness to glossary/antonym commitments
 *     was structural, at the signature.
 *
 * The three `\w`-class normalization expectations (`:44`/`:56`/`:105` pre-AC-2-7)
 * are punctuation-free inputs, so they survive the punctuation-class change
 * unchanged — but they were guarding the private normalizer, so this file now
 * ALSO asserts the class change directly (see the "one atomizer" block) rather
 * than leaving it implied.
 */

/** The seed-only shared atomizer — what `check` builds for a glossary-free doc. */
const seedAtomize = makeAtomize()

const view = (overrides: Partial<ReqView> = {}): ReqView => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  negated: false,
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

const RESP = 'sys__auth_service__resp__issue_a_session_token'

describe('earsToTemporal — EARS pattern → Dwyer/SPS temporal shape (AC-33-1)', () => {
  it('event-driven → Response: G(trig → F resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      seedAtomize,
    )
    const trig = tAtom('sys__auth_service__trig__user_submits_valid_credentials')
    expect(f).toEqual(G(tImplies(trig, F(tAtom(RESP)))))
  })

  it('unwanted-behavior → Absence: G(cond → ¬resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'unwanted-behavior',
        trigger: 'five consecutive failed logins occur',
        systemResponse: 'issue a session token',
      }),
      seedAtomize,
    )
    const cond = tAtom('sys__auth_service__trig__five_consecutive_failed_logins_occur')
    expect(f).toEqual(G(tImplies(cond, tNot(tAtom(RESP)))))
  })

  it('state-driven → Universality within scope: G(state → resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        systemResponse: 'issue a session token',
      }),
      seedAtomize,
    )
    // REVISED (AC-2-7): the copula `is` is now stripped, exactly as it is on the
    // propositional guard path. The pre-AC-2-7 expectation pinned
    // `…_pre__maintenance_mode_is_enabled` — the un-stripped form — which is the
    // very atom the propositional tier renders `…_pre__maintenance_mode_enabled`.
    // Pinning the un-stripped form was pinning the divergence.
    const state = tAtom('sys__auth_service__pre__maintenance_mode_enabled')
    expect(f).toEqual(G(tImplies(state, tAtom(RESP))))
  })

  it('optional-feature → Universality gated by a feature literal: G(feature → resp)', () => {
    const f = earsToTemporal(
      view({
        patternType: 'optional-feature',
        preCondition: 'SSO is configured for the tenant',
        systemResponse: 'issue a session token',
      }),
      seedAtomize,
    )
    // REVISED (AC-2-7): same copula strip as the state-driven case. The `feat`
    // KIND is unchanged — see the dedicated test below for why keeping it is the
    // conservative choice.
    const feature = tAtom('sys__auth_service__feat__sso_configured_for_the_tenant')
    expect(f).toEqual(G(tImplies(feature, tAtom(RESP))))
  })

  it('ubiquitous → Universality: G(resp)', () => {
    const f = earsToTemporal(view({ patternType: 'ubiquitous' }), seedAtomize)
    expect(f).toEqual(G(tAtom(RESP)))
  })
})

describe('earsToTemporal — response polarity threads AC-2-4 onto the same atom', () => {
  it('negated ubiquitous → G(¬resp) on the positive atom name', () => {
    const f = earsToTemporal(view({ patternType: 'ubiquitous', negated: true }), seedAtomize)
    expect(f).toEqual(G(tNot(tAtom(RESP))))
  })

  it('negated event-driven composes: G(trig → F ¬resp) on the positive atom', () => {
    const f = earsToTemporal(
      view({
        patternType: 'event-driven',
        trigger: 'the user logs out',
        systemResponse: 'issue a session token',
        negated: true,
      }),
      seedAtomize,
    )
    const trig = tAtom('sys__auth_service__trig__user_logs_out')
    expect(f).toEqual(G(tImplies(trig, F(tNot(tAtom(RESP))))))
  })
})

describe('earsToTemporal — purity and determinism (AC-33-1)', () => {
  it('does not mutate its input', () => {
    const req = view({ patternType: 'event-driven', trigger: 'x happens' })
    const snapshot = structuredClone(req)
    earsToTemporal(req, seedAtomize)
    expect(req).toEqual(snapshot)
  })

  it('is deterministic — same input yields a deeply-equal AST', () => {
    const req = view({ patternType: 'state-driven', preCondition: 'p holds' })
    expect(earsToTemporal(req, seedAtomize)).toEqual(earsToTemporal(req, seedAtomize))
  })

  it('is deterministic ACROSS atomizer instances built the same way', () => {
    // Determinism is a property of the atomizer's content, not of the closure
    // identity: two `makeAtomize()` calls must produce byte-identical atoms, or
    // the same document would verify differently between two runs.
    const req = view({ patternType: 'event-driven', trigger: 'the disk fills up' })
    expect(earsToTemporal(req, makeAtomize())).toEqual(earsToTemporal(req, makeAtomize()))
  })

  it('per-system scoping: same response text under two systems yields distinct atoms', () => {
    const a = earsToTemporal(view({ systemName: 'auth service' }), seedAtomize) as Extract<
      TemporalFormula,
      { op: 'G' }
    >
    const b = earsToTemporal(view({ systemName: 'billing service' }), seedAtomize) as Extract<
      TemporalFormula,
      { op: 'G' }
    >
    expect(a.arg).not.toEqual(b.arg)
  })
})

// ---------------------------------------------------------------------------
// AC-2-7: the two tiers share ONE atomizer — divergence-by-divergence
// ---------------------------------------------------------------------------

/** Pull the single atom name out of a `G(atom)` / `G(¬atom)` shape. */
function ubiquitousAtom(f: TemporalFormula): string {
  const g = f as Extract<TemporalFormula, { op: 'G' }>
  const inner = g.arg.op === 'not' ? g.arg.arg : g.arg
  return (inner as Extract<TemporalFormula, { op: 'atom' }>).name
}

/** Pull the antecedent atom name out of a `G(ante → …)` shape. */
function antecedentAtom(f: TemporalFormula): string {
  const g = f as Extract<TemporalFormula, { op: 'G' }>
  const imp = g.arg as Extract<TemporalFormula, { op: 'implies' }>
  const lhs = imp.lhs.op === 'not' ? imp.lhs.arg : imp.lhs
  return (lhs as Extract<TemporalFormula, { op: 'atom' }>).name
}

describe('AC-2-7 — the temporal tier atomizes through the SHARED atomizer', () => {
  it('produces byte-identical atom names to the propositional atomizer, per slot kind', () => {
    // The load-bearing assertion of this AC: for every slot kind, the name the
    // temporal mapping emits IS the name `atomize` emits. Anything else and the
    // two tiers are reasoning about different atoms while both reporting at error
    // severity. Asserted against `atomize` directly (not against a hand-written
    // string), so it cannot drift as normalization evolves.
    const resp = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'store the plaintext' }),
      seedAtomize,
    )
    expect(ubiquitousAtom(resp)).toBe(
      atomize({ kind: 'resp', text: 'store the plaintext', systemName: 'auth service' }).name,
    )

    const trig = earsToTemporal(
      view({ patternType: 'event-driven', trigger: 'the token expires' }),
      seedAtomize,
    )
    expect(antecedentAtom(trig)).toBe(
      atomize({ kind: 'trig', text: 'the token expires', systemName: 'auth service' }).name,
    )

    const pre = earsToTemporal(
      view({ patternType: 'state-driven', preCondition: 'the session is active' }),
      seedAtomize,
    )
    expect(antecedentAtom(pre)).toBe(
      atomize({ kind: 'pre', text: 'the session is active', systemName: 'auth service' }).name,
    )
  })

  it('divergence 1 — uses the propositional PUNCTUATION class, not `\\w`', () => {
    // `[^\w\s]` (the old private normalizer) keeps `_` and was not applied to
    // runs, so `read-only mode` collapsed to `readonly_mode` and `TLS 1.3` to
    // `tls_13`. The propositional class `[^a-z0-9\s]+` maps each punctuation run
    // to a separator. Both inputs are real: hyphenated modifiers and dotted
    // version numbers are ordinary requirement prose.
    const hyphen = earsToTemporal(
      view({ patternType: 'state-driven', preCondition: 'read-only mode' }),
      seedAtomize,
    )
    expect(antecedentAtom(hyphen)).toBe('sys__auth_service__pre__read_only_mode')

    const dotted = earsToTemporal(
      view({ patternType: 'state-driven', preCondition: 'TLS 1.3 is negotiated' }),
      seedAtomize,
    )
    expect(antecedentAtom(dotted)).toBe('sys__auth_service__pre__tls_1_3_negotiated')
  })

  it('divergence 2 — strips one copula from `trig` guards too, not just `pre`', () => {
    const a = earsToTemporal(
      view({ patternType: 'event-driven', trigger: 'the queue is drained' }),
      seedAtomize,
    )
    const b = earsToTemporal(
      view({ patternType: 'event-driven', trigger: 'the queue drained' }),
      seedAtomize,
    )
    expect(antecedentAtom(a)).toBe(antecedentAtom(b))
  })

  it('divergence 3 — inherits the SEED antonym classes (grant/revoke unify)', () => {
    // The single biggest win of the unification: `G(resp)` for "grant access" and
    // "revoke access" now name ONE atom at OPPOSITE polarity, which is exactly
    // the shape `findTemporalContradictions` exists to refute and previously
    // could not reach.
    const grant = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'grant access' }),
      seedAtomize,
    )
    const revoke = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'revoke access' }),
      seedAtomize,
    )
    expect(ubiquitousAtom(grant)).toBe(ubiquitousAtom(revoke))
    // …and at opposite polarity, not the same.
    const grantG = grant as Extract<TemporalFormula, { op: 'G' }>
    const revokeG = revoke as Extract<TemporalFormula, { op: 'G' }>
    expect(grantG.arg.op).toBe('atom')
    expect(revokeG.arg.op).toBe('not')
  })

  it('divergence 4 — de-inflects the leading response verb (`opens`/`open`)', () => {
    const inflected = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'opens the relief valve' }),
      seedAtomize,
    )
    const base = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'open the relief valve' }),
      seedAtomize,
    )
    expect(ubiquitousAtom(inflected)).toBe(ubiquitousAtom(base))
  })

  it('divergence 5 — honors a committed GLOSSARY alias', () => {
    // The payoff shape: a doc-committed synonym now unifies temporal atoms, so a
    // paraphrased temporal conflict becomes provable. Pre-AC-2-7 this was
    // unreachable at the signature level — `earsToTemporal` had no glossary
    // parameter to pass one through.
    const glossary = new Map([['issue_a_login_credential', 'issue_a_session_token']])
    const withGlossary = makeAtomize(glossary)
    const aliased = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'issue a login credential' }),
      withGlossary,
    )
    expect(ubiquitousAtom(aliased)).toBe(RESP)
    // Control: without the glossary the two stay distinct (so the test proves the
    // glossary did the work, not an accidental collision).
    const unaliased = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'issue a login credential' }),
      seedAtomize,
    )
    expect(ubiquitousAtom(unaliased)).not.toBe(RESP)
  })

  it('divergence 7 — negation lands on POLARITY, never inside the atom name', () => {
    // The docstring invariant the old temporal path broke: a hand-authored
    // response that bakes in "not" must atomize to the POSITIVE atom with
    // `negated`, so `R` and `¬R` are one atom at two polarities. The temporal
    // path had no leading-negator handling at all, so it produced
    // `…__resp__not_store_plaintext` — a DIFFERENT atom, which can never conflict
    // with `…__resp__store_plaintext`.
    //
    // The strip itself lives in `check.ts:toEncodable`, which now feeds BOTH
    // tiers (divergence 8), so what this asserts is the downstream half: given
    // the positive text plus the flag, the temporal atom is the positive one.
    const positive = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'store plaintext' }),
      seedAtomize,
    )
    const negated = earsToTemporal(
      view({ patternType: 'ubiquitous', systemResponse: 'store plaintext', negated: true }),
      seedAtomize,
    )
    expect(ubiquitousAtom(negated)).toBe(ubiquitousAtom(positive))
    expect(ubiquitousAtom(negated)).not.toContain('not_')
    expect((negated as Extract<TemporalFormula, { op: 'G' }>).arg.op).toBe('not')
  })

  it('divergence 9 — an empty guard slot is OMITTED, never a shared empty atom', () => {
    // `sys__auth_service__trig__` used to be a well-formed atom every malformed
    // requirement in the system SHARED, so two unrelated authoring bugs became
    // co-triggered and could combine into a reported temporal contradiction. The
    // obligation now degrades to the unguarded form, which is confined to this
    // requirement's own atoms.
    const missing = earsToTemporal(view({ patternType: 'event-driven' }), seedAtomize)
    expect(missing).toEqual(G(F(tAtom(RESP))))

    // Also covers a slot that normalizes AWAY to nothing — the raw-text guard
    // alone would let `"---"` through and re-create the shared empty atom.
    const punctuationOnly = earsToTemporal(
      view({ patternType: 'state-driven', preCondition: '---' }),
      seedAtomize,
    )
    expect(punctuationOnly).toEqual(G(tAtom(RESP)))

    // The hazard itself: two DIFFERENT malformed requirements must not end up
    // sharing an atom just because both are malformed.
    const other = earsToTemporal(
      view({ patternType: 'event-driven', systemResponse: 'lock the account' }),
      seedAtomize,
    )
    expect(JSON.stringify(missing)).not.toBe(JSON.stringify(other))
  })

  it('note (a) — the `feat` kind SURVIVES, so an optional-feature guard stays distinct', () => {
    // AC-2-7's open semantic decision (a), implemented CONSERVATIVELY. One
    // `preCondition` slot yields two atom namespaces depending on `patternType`,
    // which is arguably wrong — but collapsing `feat` → `pre` INCREASES
    // unification (an optional-feature guard would start sharing an atom with a
    // state-driven guard of the same text), and more unification means more
    // error-severity findings. That is the direction a human decides, not a
    // refactor. What AC-2-7 does fix is that `feat` normalizes IDENTICALLY to
    // `pre` — same punctuation class, same copula strip, same glossary — so the
    // ONLY remaining difference is the kind marker.
    const sameText = 'the tenant is on the premium plan'
    const feat = earsToTemporal(
      view({ patternType: 'optional-feature', preCondition: sameText }),
      seedAtomize,
    )
    const pre = earsToTemporal(
      view({ patternType: 'state-driven', preCondition: sameText }),
      seedAtomize,
    )
    const featName = antecedentAtom(feat)
    const preName = antecedentAtom(pre)
    expect(featName).not.toBe(preName)
    // The bodies are identical; only the kind marker differs. If this ever fails,
    // `feat` has drifted from `pre` again and the AC-2-7 repair has regressed.
    expect(featName.replace('__feat__', '__KIND__')).toBe(preName.replace('__pre__', '__KIND__'))
  })
})
