/**
 * THE COMPLETENESS HEURISTIC — what it actually decides, which is nothing.
 *
 * `checkGroupCompleteness` asks the solver whether `¬(C₁ ∨ … ∨ Cₙ)` is satisfiable and calls a
 * satisfying model an uncovered case. Through `encode` that question has a fixed answer:
 *
 *   - `encode` atomizes both guard slots with `negated: false`, and the atomizer only flips
 *     polarity on the `resp` branch, so every `pre` row is POSITIVE;
 *   - a disjunction of positive atoms is falsified by setting them all false, so the check is
 *     SAT for every eligible group.
 *
 * The tier therefore fires unconditionally on eligibility — two or more preconditioned members
 * under one non-empty trigger key — and the `unsat` "covered" branch is unreachable from any
 * document. `FND_INCOMPLETE` is `info`, so this is noise rather than a fabrication, but it is
 * noise whose message claims a solver result that carried no information.
 *
 * The cases below therefore pin two different things. The eligibility rules are real behaviour
 * that a document reaches. The polarity-preserving line in `preconditionLiterals` is reachable
 * only from a hand-built atom table, and the one case that hands it one is the ONLY thing in the
 * suite that can see that line work — deleting the line changes no document-driven result.
 */

import { describe, expect, it } from 'vitest'
import { makeAtomize } from './atomize.ts'
import { getContext } from './backend.ts'
import { type EncodableRequirement, type EncodedRequirement, encode } from './encode.ts'
import { checkCompleteness, checkGroupCompleteness } from './incomplete.ts'

const real = makeAtomize()

const enc = (o: {
  id: string
  preCondition?: string
  trigger?: string
  systemResponse?: string
}): EncodedRequirement => {
  const req: EncodableRequirement = {
    id: o.id,
    patternType: o.trigger === undefined ? 'state-driven' : 'event-driven',
    preCondition: o.preCondition,
    trigger: o.trigger,
    systemName: 'gateway',
    systemResponse: o.systemResponse ?? 'queue the request',
    negated: false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
  }
  return encode(req, real)
}

const ARRIVES = 'a request arrives'

/** The two branches the module header offers as its example of a COVERED partition. */
const enabled = enc({
  id: 'i-enabled',
  preCondition: 'the maintenance mode is enabled',
  trigger: ARRIVES,
  systemResponse: 'queue the request',
})
const notEnabled = enc({
  id: 'i-not-enabled',
  preCondition: 'the maintenance mode is not enabled',
  trigger: ARRIVES,
  systemResponse: 'forward the request',
})

/** The same precondition text as `enabled`, so the two share one `pre` atom. */
const alsoEnabled = enc({
  id: 'i-also-enabled',
  preCondition: 'the maintenance mode is enabled',
  trigger: ARRIVES,
  systemResponse: 'log the request',
})

/** Flip a `pre` row to negative — a polarity `encode` never produces. */
const negatedPrecondition = (e: EncodedRequirement): EncodedRequirement => ({
  ...e,
  atoms: e.atoms.map((a) => (a.kind === 'pre' ? { ...a, negated: true } : a)),
})

const preRows = (e: EncodedRequirement) => e.atoms.filter((a) => a.kind === 'pre')

describe('every precondition atom `encode` emits is positive', () => {
  it('holds however the author spelled the negation', () => {
    // The mechanism behind the unconditional firing below. "is not enabled" does not become
    // `¬enabled` — it becomes its own atom, `maintenance_mode_not_enabled`, positive.
    for (const text of [
      'the maintenance mode is not enabled',
      'the session is not authenticated',
      'the cache is disabled',
      'the door is open',
    ]) {
      const rows = preRows(enc({ id: 'i-1', preCondition: text, trigger: ARRIVES }))
      expect(
        rows.map((r) => r.negated),
        text,
      ).toEqual([false])
    }
  })

  it('gives the two spellings of one condition two DIFFERENT atoms', () => {
    expect(preRows(enabled)[0]?.atom).not.toBe(preRows(notEnabled)[0]?.atom)
  })
})

describe('the tier fires on eligibility alone', () => {
  it('emits FND_INCOMPLETE for the partition the module header calls covered', async () => {
    const ctx = await getContext('symspec-incomplete-unconditional')
    expect(await checkCompleteness(ctx, [enabled, notEnabled])).toEqual([
      {
        code: 'FND_INCOMPLETE',
        severity: 'info',
        requirementIds: ['i-enabled', 'i-not-enabled'],
        triggerKey: 'sys__gateway__trig__request_arrives',
        message:
          'Requirements i-enabled, i-not-enabled share a trigger but their preconditions do not ' +
          'cover all cases (heuristic — only bites when preconditions normalize to ' +
          'complementary atoms; not a formal completeness guarantee).',
      },
    ])
  })

  it('emits it for two members sharing ONE precondition atom too', async () => {
    // Deduplication leaves a single disjunct, and `¬P` is satisfiable, so even a group with no
    // partition at all to be incomplete about produces the finding.
    const ctx = await getContext('symspec-incomplete-shared-atom')
    const findings = await checkCompleteness(ctx, [enabled, alsoEnabled])
    expect(findings.map((f) => f.requirementIds)).toEqual([['i-also-enabled', 'i-enabled']])
  })

  it('reports the ids sorted, not in document order', async () => {
    const ctx = await getContext('symspec-incomplete-id-order')
    const forward = await checkCompleteness(ctx, [enabled, notEnabled])
    const reverse = await checkCompleteness(ctx, [notEnabled, enabled])
    expect(reverse.map((f) => f.requirementIds)).toEqual(forward.map((f) => f.requirementIds))
  })
})

describe('the eligibility rules', () => {
  it('skips a group with no trigger', async () => {
    // A group with no event has no cases a precondition could be asked to partition.
    const ctx = await getContext('symspec-incomplete-no-trigger')
    const a = enc({ id: 'i-a', preCondition: 'the maintenance mode is enabled' })
    const b = enc({ id: 'i-b', preCondition: 'the maintenance mode is not enabled' })
    expect(a.atoms.some((row) => row.kind === 'trig')).toBe(false)
    expect(await checkCompleteness(ctx, [a, b])).toEqual([])
  })

  it('skips a group with fewer than two preconditioned members', async () => {
    const ctx = await getContext('symspec-incomplete-one-member')
    const bare = enc({ id: 'i-bare', trigger: ARRIVES })
    expect(await checkCompleteness(ctx, [enabled, bare])).toEqual([])
    expect(await checkCompleteness(ctx, [enabled])).toEqual([])
  })

  it('groups on trigger ATOMS, so two triggers keep their members apart', async () => {
    const ctx = await getContext('symspec-incomplete-two-triggers')
    const other = enc({
      id: 'i-other',
      preCondition: 'the maintenance mode is not enabled',
      trigger: 'the health probe fires',
    })
    expect(await checkCompleteness(ctx, [enabled, other])).toEqual([])
  })

  it('groups paraphrases that normalize to one trigger atom together', async () => {
    const ctx = await getContext('symspec-incomplete-same-atom-trigger')
    const punctuated = enc({
      id: 'i-punctuated',
      preCondition: 'the maintenance mode is not enabled',
      trigger: 'A request arrives!',
      systemResponse: 'forward the request',
    })
    expect(punctuated.atoms.find((row) => row.kind === 'trig')?.atom).toBe(
      enabled.atoms.find((row) => row.kind === 'trig')?.atom,
    )
    expect((await checkCompleteness(ctx, [enabled, punctuated])).length).toBe(1)
  })
})

describe('the `covered` branch', () => {
  it('needs a negated precondition row, which only a hand-built atom table has', async () => {
    // `P` and `¬P` on ONE atom make the disjunction a tautology, so `¬(P ∨ ¬P)` is unsat and the
    // group is reported covered. This is the sole witness in the suite that
    // `preconditionLiterals` preserves polarity at all: through `encode` the flag is always
    // false, so dropping the polarity handling changes no document-driven result.
    const ctx = await getContext('symspec-incomplete-covered')
    const flipped = negatedPrecondition(alsoEnabled)
    expect(preRows(flipped).map((r) => r.negated)).toEqual([true])
    expect(preRows(flipped)[0]?.atom).toBe(preRows(enabled)[0]?.atom)
    expect(await checkCompleteness(ctx, [enabled, flipped])).toEqual([])
  })

  it('is not reached when the two polarities sit on different atoms', async () => {
    // The control for the case above: flipping a row whose atom nobody else carries leaves the
    // disjunction falsifiable, so the finding comes back.
    const ctx = await getContext('symspec-incomplete-covered-control')
    const flipped = negatedPrecondition(notEnabled)
    expect((await checkCompleteness(ctx, [enabled, flipped])).length).toBe(1)
  })

  it('is reachable through the group entry point with an explicit trigger key', async () => {
    const ctx = await getContext('symspec-incomplete-covered-group')
    const flipped = negatedPrecondition(alsoEnabled)
    expect(await checkGroupCompleteness(ctx, 'any-key', [enabled, flipped])).toBeUndefined()
    expect(await checkGroupCompleteness(ctx, '', [enabled, notEnabled])).toBeUndefined()
    expect(await checkGroupCompleteness(ctx, 'any-key', [enabled, notEnabled])).toMatchObject({
      code: 'FND_INCOMPLETE',
      triggerKey: 'any-key',
    })
  })
})
