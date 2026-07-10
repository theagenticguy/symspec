/**
 * Tests for the completeness heuristic (AC-4-5a).
 *
 * The heuristic groups requirements by trigger atom, collects the precondition
 * atoms of each group, and checks SAT of ¬(C1 ∨ … ∨ Cn). A satisfying model
 * means no precondition covers that case — an "else-branch gap" — and emits
 * FND_INCOMPLETE (info). UNSAT means the preconditions cover the propositional
 * space, so no finding.
 *
 * Spec invariants being tested:
 *   1. A genuine else-branch gap → FND_INCOMPLETE at info severity.
 *   2. A group whose preconditions cover the Boolean space → no finding.
 *   3. A group with fewer than 2 preconditioned members → skipped (no finding).
 *   4. Groups with no trigger key (ubiquitous/state-driven-only) → skipped.
 *   5. `checkCompleteness` sweeps the whole spec correctly.
 */

import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import { type Atomize, type AtomLit, type EncodableRequirement, encode } from '../encode.js'
import { checkCompleteness, checkGroupCompleteness } from '../incomplete.js'

/**
 * A deterministic fake atomizer that mirrors the AC-4-2a shape without
 * antonym unification. Uses kind scoping so 'pre' atoms are distinct from
 * 'resp' atoms for the same text, matching the real atomizer's scoping.
 * For the completeness heuristic, the key invariant is that complementary
 * precondition text maps to the SAME atom name with opposite polarity — for
 * example "feature is enabled" (negated:false) vs
 * "feature is not enabled" (negated:true via AC-2-4 negation extraction).
 * We simulate that by having the fake atomizer strip leading 'not ' from
 * the text and set negated:true, matching how the real pipeline would
 * consume the AC-2-4 `negated` flag on precondition atoms.
 */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')

const fakeAtomize: Atomize = (kind, slotText, systemName, negated): AtomLit => ({
  atom: `sys__${norm(systemName)}__${kind}__${norm(slotText)}`,
  negated,
})

/** Build a minimal EncodableRequirement with sensible defaults. */
const req = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

describe('checkGroupCompleteness — AC-4-5a', () => {
  it('genuine else-branch gap → FND_INCOMPLETE at info severity', async () => {
    /**
     * Scenario: Two state-driven requirements under the same trigger, each with
     * a different precondition atom. Neither precondition is the logical
     * complement of the other (both can be false simultaneously), so
     * ¬(P1 ∨ P2) is SAT → uncovered case detected.
     *
     * - REQ-A: "while feature_x is enabled, when request arrives, system shall do A"
     * - REQ-B: "while feature_y is enabled, when request arrives, system shall do B"
     * ¬(feature_x ∨ feature_y) is SAT (set both false) → gap exists.
     */
    const ctx = await getContext('incomplete-gap')
    const a = encode(
      req({
        id: 'REQ-A',
        patternType: 'state-driven',
        preCondition: 'feature_x is enabled',
        trigger: 'request arrives',
        systemResponse: 'do action A',
      }),
      fakeAtomize,
    )
    const b = encode(
      req({
        id: 'REQ-B',
        patternType: 'state-driven',
        preCondition: 'feature_y is enabled',
        trigger: 'request arrives',
        systemResponse: 'do action B',
      }),
      fakeAtomize,
    )

    // Both share the same trigger atom → same group key.
    const trigKey = a.atoms.find((at) => at.kind === 'trig')?.atom ?? ''
    expect(trigKey).toBeTruthy()

    const finding = await checkGroupCompleteness(ctx, trigKey, [a, b])
    expect(finding).not.toBeUndefined()
    expect(finding?.code).toBe('FND_INCOMPLETE')
    expect(finding?.severity).toBe('info')
    expect(finding?.requirementIds.sort()).toEqual(['REQ-A', 'REQ-B'])
  })

  it('covered group: complementary precondition atoms (P vs ¬P) → no finding', async () => {
    /**
     * Scenario: Two requirements share a trigger; one fires "while X is enabled"
     * (atom P, negated:false), the other fires "while X is not enabled"
     * (same atom P, negated:true). Together they cover P ∨ ¬P ≡ true, so
     * ¬(P ∨ ¬P) = false ≡ UNSAT → no gap.
     *
     * We simulate the AC-2-4 `negated` flag by constructing the second
     * requirement with the SAME precondition text and flipping the `negated`
     * field on the precondition atom via the fake atomizer's contract.
     * We do this by injecting an explicit EncodedRequirement with a negated
     * precondition atom directly rather than going through `encode`, so the
     * test is independent of how the real atomizer handles "not" in text.
     */
    const ctx = await getContext('incomplete-covered')

    // REQ-C: when request arrives, while feature_flag is enabled → do C.
    const c = encode(
      req({
        id: 'REQ-C',
        patternType: 'state-driven',
        preCondition: 'feature flag is enabled',
        trigger: 'request arrives',
        systemResponse: 'do action C',
      }),
      fakeAtomize,
    )
    // REQ-D: shares the same trigger, same preCondition TEXT but the AC-2-4
    // negated flag on the precondition makes it ¬feature_flag_is_enabled.
    // We inject negated:true on the precondition by using a custom atomizer
    // for this requirement only.
    const negAtomize: Atomize = (kind, slotText, systemName, negated): AtomLit => ({
      atom: `sys__${norm(systemName)}__${kind}__${norm(slotText)}`,
      // Flip the polarity on precondition atoms to simulate "not enabled".
      negated: kind === 'pre' ? !negated : negated,
    })
    const d = encode(
      req({
        id: 'REQ-D',
        patternType: 'state-driven',
        preCondition: 'feature flag is enabled',
        trigger: 'request arrives',
        systemResponse: 'do action D',
      }),
      negAtomize,
    )

    const trigKey = c.atoms.find((at) => at.kind === 'trig')?.atom ?? ''
    expect(trigKey).toBeTruthy()

    const finding = await checkGroupCompleteness(ctx, trigKey, [c, d])
    // ¬(P ∨ ¬P) is UNSAT → covered → no finding.
    expect(finding).toBeUndefined()
  })

  it('group with fewer than 2 preconditioned members → no finding (ineligible)', async () => {
    /**
     * A trigger group with only ONE preconditioned member has no "else"
     * partition to check — there is only one case. Skip it.
     */
    const ctx = await getContext('incomplete-single')
    const e = encode(
      req({
        id: 'REQ-E',
        patternType: 'state-driven',
        preCondition: 'some condition',
        trigger: 'event occurs',
        systemResponse: 'do action E',
      }),
      fakeAtomize,
    )

    const trigKey = e.atoms.find((at) => at.kind === 'trig')?.atom ?? ''
    const finding = await checkGroupCompleteness(ctx, trigKey, [e])
    expect(finding).toBeUndefined()
  })

  it('empty trigger key (no trigger atom) → skipped', async () => {
    /**
     * A state-driven requirement with no trigger (only a precondition) has
     * triggerKey = '' → the group is skipped. Only trigger-keyed groups make
     * sense for the "which case is uncovered by this event" check.
     */
    const ctx = await getContext('incomplete-no-trigger')
    const f = encode(
      req({
        id: 'REQ-F',
        patternType: 'state-driven',
        preCondition: 'mode is active',
        systemResponse: 'process the request',
      }),
      fakeAtomize,
    )
    const g = encode(
      req({
        id: 'REQ-G',
        patternType: 'state-driven',
        preCondition: 'mode is inactive',
        systemResponse: 'reject the request',
      }),
      fakeAtomize,
    )

    // Both have no trigger → triggerKey is undefined → grouped under '' → skipped.
    const finding = await checkGroupCompleteness(ctx, '', [f, g])
    expect(finding).toBeUndefined()
  })

  it('members without preconditions are excluded from the disjunction check (pure-trigger members do not block finding)', async () => {
    /**
     * A group can have one event-driven member with NO precondition plus two
     * members that DO have preconditions. Only the preconditioned members feed
     * the ¬(C1 ∨ C2) check. The no-precondition member is present but
     * contributes nothing. Since P1 and P2 are unrelated, the gap still fires.
     */
    const ctx = await getContext('incomplete-mixed')
    const noPre = encode(
      req({
        id: 'REQ-H',
        patternType: 'event-driven',
        trigger: 'event fires',
        systemResponse: 'handle unconditionally',
      }),
      fakeAtomize,
    )
    const withPreA = encode(
      req({
        id: 'REQ-I',
        patternType: 'state-driven',
        preCondition: 'flag_one is set',
        trigger: 'event fires',
        systemResponse: 'handle when flag_one',
      }),
      fakeAtomize,
    )
    const withPreB = encode(
      req({
        id: 'REQ-J',
        patternType: 'state-driven',
        preCondition: 'flag_two is set',
        trigger: 'event fires',
        systemResponse: 'handle when flag_two',
      }),
      fakeAtomize,
    )

    const trigKey = noPre.atoms.find((at) => at.kind === 'trig')?.atom ?? ''
    expect(trigKey).toBeTruthy()

    const finding = await checkGroupCompleteness(ctx, trigKey, [noPre, withPreA, withPreB])
    // flag_one and flag_two are unrelated; ¬(flag_one ∨ flag_two) is SAT.
    expect(finding?.code).toBe('FND_INCOMPLETE')
    expect(finding?.requirementIds).toContain('REQ-I')
    expect(finding?.requirementIds).toContain('REQ-J')
    // The no-precondition member is NOT in the ids (only preconditioned members).
    expect(finding?.requirementIds).not.toContain('REQ-H')
  })
})

describe('checkCompleteness — whole-spec sweep (AC-4-5a)', () => {
  it('returns one FND_INCOMPLETE for the gap group, nothing for a covered group', async () => {
    /**
     * Spec:
     *   - T1 group: REQ-X (pre A, trig T1), REQ-Y (pre B, trig T1) — gap (A and B unrelated)
     *   - T2 group: REQ-P (pre C, trig T2), REQ-Q (pre ¬C, trig T2) — covered (C ∨ ¬C ≡ true)
     * Expected: one FND_INCOMPLETE for the T1 group; nothing for T2.
     */
    const ctx = await getContext('incomplete-sweep')

    // T1 group — gap: two unrelated preconditions.
    const reqX = encode(
      req({
        id: 'REQ-X',
        patternType: 'state-driven',
        preCondition: 'alpha is on',
        trigger: 'system starts',
        systemResponse: 'initialize alpha mode',
      }),
      fakeAtomize,
    )
    const reqY = encode(
      req({
        id: 'REQ-Y',
        patternType: 'state-driven',
        preCondition: 'beta is on',
        trigger: 'system starts',
        systemResponse: 'initialize beta mode',
      }),
      fakeAtomize,
    )

    // T2 group — covered: complementary preconditions via negAtomize.
    const negAtomize2: Atomize = (kind, slotText, systemName, negated): AtomLit => ({
      atom: `sys__${norm(systemName)}__${kind}__${norm(slotText)}`,
      negated: kind === 'pre' ? !negated : negated,
    })
    const reqP = encode(
      req({
        id: 'REQ-P',
        patternType: 'state-driven',
        preCondition: 'maintenance mode',
        trigger: 'request received',
        systemResponse: 'queue the request',
        systemName: 'gateway',
      }),
      fakeAtomize,
    )
    const reqQ = encode(
      req({
        id: 'REQ-Q',
        patternType: 'state-driven',
        preCondition: 'maintenance mode',
        trigger: 'request received',
        systemResponse: 'process the request',
        systemName: 'gateway',
      }),
      negAtomize2,
    )

    const findings = await checkCompleteness(ctx, [reqX, reqY, reqP, reqQ])

    // Exactly one finding for the T1 group.
    expect(findings).toHaveLength(1)
    const f = findings[0]!
    expect(f.code).toBe('FND_INCOMPLETE')
    expect(f.severity).toBe('info')
    expect(f.requirementIds.sort()).toEqual(['REQ-X', 'REQ-Y'])
  })

  it('returns empty array when no group is eligible', async () => {
    /**
     * A spec of only ubiquitous requirements has no trigger groups; no groups
     * have ≥2 preconditioned members; checkCompleteness returns [].
     */
    const ctx = await getContext('incomplete-empty')
    const u1 = encode(
      req({ id: 'U1', patternType: 'ubiquitous', systemResponse: 'log the request' }),
      fakeAtomize,
    )
    const u2 = encode(
      req({ id: 'U2', patternType: 'ubiquitous', systemResponse: 'emit a metric' }),
      fakeAtomize,
    )
    const findings = await checkCompleteness(ctx, [u1, u2])
    expect(findings).toEqual([])
  })
})
