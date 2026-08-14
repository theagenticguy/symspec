/**
 * THE COMPAT BOUNDARY, tested field by field — because no differential can cover it.
 *
 * ## The coverage gap this file exists to close
 *
 * A differential comparison feeds ONE input to two implementations and diffs the
 * outputs. It is structurally blind to a bug in that shared input: both sides consume
 * the same projection, so both are wrong in the same way and agree perfectly. This
 * projection IS that shared input, which is why it needs direct assertions rather than
 * a comparison.
 *
 * Measured, not assumed: hardcoding `negated: false` here — dropping the single most
 * load-bearing field the boundary carries — left all 22 assertions of a
 * two-implementation comparison green, while a merely reworded finding message failed
 * it immediately. The reason the fixtures could not see it:
 *
 * - the 12 adversarial eval-round documents contain ZERO requirements with
 *   `negated: true` (they express opposition through antonym verb pairs like
 *   grant/revoke, which is a different mechanism);
 * - the two hex-bonk documents DO carry them (2 of 25 and 5 of 42), but flattening
 *   every flag to `false` produces a byte-identical 220-finding report on those
 *   particular documents — the negated requirements happen not to pair with a
 *   positive twin on the same atom.
 *
 * `negated` is exactly the field where that matters. It is what puts `shall X` and
 * `shall not X` on ONE atom at OPPOSITE polarity. Measured on a minimal pair:
 *
 *   negated=true  → FND_CONTRADICTION (+ GTWR_R16_NEGATION)
 *   negated=false → FND_EXACT_DUPLICATE, and FND_NO_PAIRS_CHECKED
 *
 * A proven conflict silently becoming a duplicate report is not a cosmetic drift —
 * it is the tool's core claim inverted.
 *
 * ## So this file tests the boundary DIRECTLY, on purpose-built inputs
 *
 * Every field the projection carries gets a case whose input makes that field
 * OBSERVABLE in the output. Where a field has no consumer in the G2a path
 * (`stateModel`, `responseKind`) the test asserts the honest thing instead: that its
 * presence or absence changes nothing, which is the checkable form of "no tier reads
 * it".
 */

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { solverServiceLayer } from '../adapters/z3/solver-service.ts'
import { SolverService } from '../ports/solver.ts'
import { toDonorDoc, toDonorRequirement } from './compat.ts'
// The pipeline the projection FEEDS, so the observable consequences are the tier's own,
// not a re-derivation of what they ought to be.
import { runCheck } from './engine/pipeline/check.ts'
import type { Requirement, RequirementsDocument } from './requirements/document.ts'
import { emptyDocument } from './requirements/document.ts'
import { renderSentence } from './requirements/render.ts'

const TS = '2026-01-01T00:00:00.000Z'

/** A v3 requirement with its sentence RENDERED from its own slots, so `negated`
 * shows up in the text the lint tier reads as well as in the flag. */
const req = (partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement => {
  const base: Requirement = {
    patternType: 'event-driven',
    trigger: 'the user signs in',
    systemName: 'auth service',
    systemResponse: 'issue a session token',
    negated: false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: TS,
    updatedAt: TS,
    ...partial,
  }
  return { ...base, sentence: renderSentence(base) }
}

const docOf = (...requirements: readonly Requirement[]): RequirementsDocument => ({
  ...emptyDocument(),
  requirements: Object.fromEntries(requirements.map((r) => [r.id, r])),
})

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'

/**
 * Run the TRANSPLANTED pipeline over a v3 document through the projection.
 *
 * Deliberately calls the donor `runCheck` directly rather than the `check` operation:
 * this file is about the PROJECTION, and going through the op would add the option
 * translation and the envelope to every assertion for no gain.
 */
const check = (document: RequirementsDocument) =>
  Effect.runPromise(
    Effect.flatMap(SolverService, (solver) =>
      Effect.flatMap(solver.boot, () =>
        Effect.promise(() => runCheck(toDonorDoc(document), { strict: true })),
      ),
    ).pipe(Effect.provide(solverServiceLayer)),
  )

const codesOf = async (document: RequirementsDocument): Promise<ReadonlySet<string>> => {
  const report = await check(document)
  return new Set(report.findings.map((f) => f.code))
}

// ---------------------------------------------------------------------------
// `negated` — the field a whole-document comparison cannot see
// ---------------------------------------------------------------------------

describe('compat — the `negated` flag survives, and it is observable', () => {
  /**
   * THE GUARD. Two requirements, same trigger, same response text, opposite polarity:
   * a contradiction the tier can PROVE, and only if the flag arrives.
   *
   * If the projection drops `negated`, the two become identical and the tier reports
   * `FND_EXACT_DUPLICATE` instead — so this assertion distinguishes "the flag
   * arrived" from "the flag was silently flattened" by the CODE the tier emits, not
   * by inspecting the projection's output object (which would only prove the
   * projection agrees with itself).
   */
  it('shall X vs shall NOT X proves FND_CONTRADICTION, not FND_EXACT_DUPLICATE', async () => {
    const codes = await codesOf(docOf(req({ id: A }), req({ id: B, negated: true })))
    expect(codes.has('FND_CONTRADICTION')).toBe(true)
    // The distinguishing negative: a dropped flag makes the pair identical.
    expect(
      codes.has('FND_EXACT_DUPLICATE'),
      'the pair collapsed to a duplicate, so `negated` was lost in the projection',
    ).toBe(false)
  })

  it('two POSITIVE copies are an exact duplicate, which is the control', async () => {
    // The other half of the pair, so the test above cannot pass for the wrong reason
    // (e.g. FND_CONTRADICTION firing on any two same-trigger requirements).
    const codes = await codesOf(docOf(req({ id: A }), req({ id: B })))
    expect(codes.has('FND_EXACT_DUPLICATE')).toBe(true)
    expect(codes.has('FND_CONTRADICTION')).toBe(false)
  })

  it('carries the flag through the single-requirement projection too', () => {
    // The unit-level statement, so a failure localizes to the projection rather than
    // to a tier: the field is present and has the right value on both settings.
    expect(toDonorRequirement(req({ id: A, negated: true })).negated).toBe(true)
    expect(toDonorRequirement(req({ id: A, negated: false })).negated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The other fields the tier keys on
// ---------------------------------------------------------------------------

describe('compat — every projected field the tier reads', () => {
  it('preserves the rendered `sentence`, which the lint tier and the gate read', async () => {
    // `sentence` is what `checkGtWRules` lints and what the AC-3-7 gate partitions
    // on, so a lost sentence moves requirements between the included and excluded
    // sets. Observable via a GtWR code that can only come from the text.
    const codes = await codesOf(
      docOf(req({ id: A, systemResponse: 'issue a session token quickly' })),
    )
    // "quickly" is a vague term — a GtWR/ambiguity finding that exists only because
    // the sentence text arrived.
    expect([...codes].some((c) => c.startsWith('GTWR_') || c.startsWith('FND_AMBIGUOUS'))).toBe(
      true,
    )
  })

  it('preserves `trigger` and `preCondition`, which scope every atom', async () => {
    const projected = toDonorRequirement(
      req({
        id: A,
        patternType: 'state-driven',
        preCondition: 'maintenance mode is enabled',
        trigger: 'the user signs in',
      }),
    )
    expect(projected.preCondition).toBe('maintenance mode is enabled')
    expect(projected.trigger).toBe('the user signs in')

    // Observable: two requirements with the SAME response under DIFFERENT triggers
    // are not a conflict, because the atoms are scoped by trigger. If the trigger
    // were lost they would collapse.
    const codes = await codesOf(
      docOf(
        req({ id: A, trigger: 'the user signs in', systemResponse: 'grant access' }),
        req({ id: B, trigger: 'the user signs out', systemResponse: 'revoke access' }),
      ),
    )
    expect(codes.has('FND_CONTRADICTION')).toBe(false)
  })

  it('preserves the three side tables, so a committed antonym still decides', async () => {
    // The glossary/antonym/waiver tables are the DECIDE-tier inputs — the whole
    // propose/decide split rests on the tier consulting the COMMITTED tables. A lost
    // antonym table means an agent-confirmed opposition stops being provable.
    const withoutAntonym = docOf(
      req({ id: A, systemResponse: 'open the valve' }),
      req({ id: B, systemResponse: 'shut the valve' }),
    )
    const withAntonym: RequirementsDocument = {
      ...withoutAntonym,
      antonyms: [{ a: 'open', b: 'shut' }],
    }
    const before = await codesOf(withoutAntonym)
    const after = await codesOf(withAntonym)
    // The seed table may already know open/shut; the claim that matters is that the
    // committed table ARRIVES, which the unit assertion pins directly.
    expect(toDonorDoc(withAntonym).antonyms).toEqual([{ a: 'open', b: 'shut' }])
    // And that supplying it never LOSES a finding — the demotion-only direction.
    expect(after.has('FND_CONTRADICTION')).toBe(before.has('FND_CONTRADICTION') || true)
  })

  it('preserves a committed waiver, so a reviewed baseline stays suppressed', async () => {
    const doc = docOf(req({ id: A }), req({ id: B }))
    const waived: RequirementsDocument = {
      ...doc,
      waivers: [{ code: 'FND_EXACT_DUPLICATE', reason: 'reviewed: intentional restatement' }],
    }
    expect(toDonorDoc(waived).waivers).toEqual([
      { code: 'FND_EXACT_DUPLICATE', reason: 'reviewed: intentional restatement' },
    ])
    const report = await check(waived)
    // The waiver bit: the finding is gone from `findings[]` AND counted, so a
    // suppressed baseline stays visible rather than looking like neglect.
    expect(report.findings.some((f) => f.code === 'FND_EXACT_DUPLICATE')).toBe(false)
    expect(report.waived).toBeGreaterThan(0)
  })

  it('preserves a SCOPED waiver`s requirementId', () => {
    // A scoped waiver only bites findings naming that requirement. Losing the scope
    // would silently widen it to document-wide — a suppression the author did not
    // ask for.
    const doc: RequirementsDocument = {
      ...docOf(req({ id: A })),
      waivers: [{ code: 'GTWR_R5_INDEFINITE_ARTICLE', requirementId: A, reason: 'reviewed' }],
    }
    expect(toDonorDoc(doc).waivers[0]?.requirementId).toBe(A)
  })

  it('preserves edge arrays by VALUE, and does not share them with the v3 document', () => {
    const document = docOf(req({ id: A, derives: [B] }), req({ id: B }))
    const projected = toDonorDoc(document)
    expect(projected.requirements[A]?.derives).toEqual([B])
    // A SHARED array would let a future mutation inside the engine tier reach back into
    // the caller's v3 document — an aliasing bug in the most confusing possible place.
    expect(projected.requirements[A]?.derives).not.toBe(document.requirements[A]?.derives)
  })

  it('preserves ABSENCE as absence, not as an explicit undefined', () => {
    // `{trigger: undefined}` and `{}` behave the same for the tier's `!== undefined`
    // guards but serialize differently — so absence has to stay absence, or a projected
    // document differs from a hand-written one on a field neither actually set.
    const projected = toDonorRequirement(req({ id: A, patternType: 'ubiquitous' }))
    expect('preCondition' in projected).toBe(false)
    expect('key' in projected).toBe(false)
    expect('verificationMethod' in projected).toBe(false)
    expect('verificationNote' in projected).toBe(false)
  })

  it('preserves requirement ORDER, which drives the atom roster', () => {
    // Order feeds candidate-pair emission, so re-ordering changes `pairsChecked` and
    // the coverage report while leaving every finding intact — drift that reads as
    // noise in a diff.
    const document: RequirementsDocument = {
      ...emptyDocument(),
      requirements: {
        [B]: req({ id: B }),
        [A]: req({ id: A }),
      },
    }
    expect(Object.keys(toDonorDoc(document).requirements)).toEqual([B, A])
  })
})

// ---------------------------------------------------------------------------
// The two DROPS — asserted as no-ops rather than assumed
// ---------------------------------------------------------------------------

describe('compat — the two dropped v3 fields have no consumer in the G2a path', () => {
  /**
   * "Nothing reads `stateModel`" is the justification for dropping it. That is a
   * CLAIM about the tier, and the checkable form of it is: the tier's output is
   * identical with and without one. If a G4 tier ever starts reading it, this test
   * fails — which is the correct moment to notice, because that tier must take the
   * v3 document directly rather than come through this projection.
   */
  it('a populated stateModel changes NOTHING about the report', async () => {
    const base = docOf(req({ id: A }), req({ id: B, negated: true }))
    const withState: RequirementsDocument = {
      ...base,
      stateModel: {
        variables: [
          // `frame` is REQUIRED on the decoded type as of G4 (it carries a decoding
          // default, so a FILE may omit it — a hand-built value may not). Spelled
          // `volatile` here rather than `stable` because that is the schema's own
          // default and this fixture is meant to be an ordinary state model, not one
          // asserting a hypothesis.
          {
            name: 'session_authenticated',
            type: 'bool',
            frame: 'volatile',
            initial: 'session_authenticated = false',
          },
          { name: 'retry_count', type: 'int', frame: 'volatile', domain: { min: 0, max: 5 } },
          {
            name: 'run_state',
            type: 'enum',
            frame: 'volatile',
            domain: ['PENDING', 'RUNNING', 'DONE'],
          },
        ],
        initial: 'run_state = PENDING and retry_count = 0',
      },
    }
    const without = await check(base)
    const with_ = await check(withState)
    expect(JSON.stringify(with_.findings)).toBe(JSON.stringify(without.findings))
    expect(with_.verified).toBe(without.verified)
    expect(JSON.stringify(with_.coverage.demotions)).toBe(
      JSON.stringify(without.coverage.demotions),
    )
  })

  it('a populated responseKind changes NOTHING about the report', async () => {
    const base = docOf(req({ id: A }), req({ id: B, negated: true }))
    const classified = docOf(
      req({ id: A, responseKind: 'effect' }),
      req({ id: B, negated: true, responseKind: 'constraint' }),
    )
    const plain = await check(base)
    const tagged = await check(classified)
    expect(JSON.stringify(tagged.findings)).toBe(JSON.stringify(plain.findings))
    expect(tagged.verified).toBe(plain.verified)
  })

  it('the schemaVersion placeholder is 2 and is never read', () => {
    // Stated as a test so the placeholder cannot be "fixed" to 3 by someone who reads
    // it as a claim about the document. It is there because the donor TYPE requires
    // the field; no tier branches on it.
    expect(toDonorDoc(emptyDocument()).schemaVersion).toBe(2)
  })
})
