/**
 * SUBSUMPTION AND REDUNDANCY — the direction, the prune, and the two codes.
 *
 * `subsumption.ts`'s header names this file as the thing that pins the moreGeneral/moreSpecific
 * direction "by putting the general requirement in the pair's `b` slot, where a positional
 * assignment would be provably wrong". That is the whole subject of the first block, and the
 * fixture is built so a positional assignment is wrong in one pair order and right in the other
 * — a single ordering cannot discriminate, because positional and by-id agree on it.
 *
 * The direction is not cosmetic. `moreGeneral`/`moreSpecific` are output bytes: they name which
 * requirement an author is told to delete. Swapping them tells the author to delete the general
 * rule and keep the narrow one, which silently shrinks the specified behaviour.
 *
 * `sharesAtom` gets a case of its own because its claim is BEHAVIOUR-PRESERVING pruning, and
 * that claim has two halves that fail in opposite directions: a disjoint pair must reach no
 * solver at all (or the prune buys nothing), and a sharing pair must still be checked (or the
 * prune eats real findings). Observing the first half needs the solver constructions counted,
 * since a pruned pair and a checked-and-inconclusive pair produce the same empty output.
 *
 * `FND_SUBSUMPTION` and `FND_REDUNDANCY` are asserted as EMITTED codes here, at their severity
 * and with their message bytes.
 */

import { describe, expect, it } from 'vitest'
import { makeAtomize } from './atomize.ts'
import { getContext, type Z3Context } from './backend.ts'
import { type EncodableRequirement, type EncodedRequirement, encode } from './encode.ts'
import { checkSubsumption, checkSubsumptionPair } from './subsumption.ts'

const real = makeAtomize()

const enc = (o: {
  id: string
  preCondition?: string
  trigger?: string
  systemName?: string
  systemResponse?: string
}): EncodedRequirement => {
  const req: EncodableRequirement = {
    id: o.id,
    patternType: 'event-driven',
    preCondition: o.preCondition,
    trigger: o.trigger,
    systemName: o.systemName ?? 'lift controller',
    systemResponse: o.systemResponse ?? 'halt the car',
    negated: false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
  }
  return encode(req, real)
}

/** `T ⇒ R`: the requirement that fires in the SUPERSET of cases. */
const broad = enc({ id: 'broad', trigger: 'the call button is pressed' })
/** `(P ∧ T) ⇒ R`: the same response under one extra guard. */
const narrow = enc({
  id: 'narrow',
  preCondition: 'the door is open',
  trigger: 'the call button is pressed',
})
/** `broad`'s slots verbatim under a second id — an identical literal set. */
const twin = enc({ id: 'twin', trigger: 'the call button is pressed' })
/** Another system, another trigger, another response: no atom in common with any of the above. */
const unrelated = enc({
  id: 'unrelated',
  trigger: 'the alarm test starts',
  systemName: 'siren panel',
  systemResponse: 'sound the chime',
})

const atomsOf = (e: EncodedRequirement, kind: 'context' | 'resp'): string[] =>
  e.atoms
    .filter((a) => (kind === 'resp' ? a.kind === 'resp' : a.kind !== 'resp'))
    .map((a) => `${a.atom}${a.negated ? '[NEG]' : ''}`)
    .sort()

/**
 * A context that counts how many `Solver`s are constructed through it. `implies()` builds one
 * per direction, so a checked pair costs two and a pruned pair costs none.
 */
function countingSolvers(ctx: Z3Context): { ctx: Z3Context; solvers: () => number } {
  let count = 0
  const spy = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'Solver') count += 1
      return Reflect.get(target, prop)
    },
  })
  return { ctx: spy, solvers: () => count }
}

const pair = (a: string, b: string) =>
  ({ a, b, reason: 'same-system-same-trigger-different-response' }) as const

const byId = new Map([broad, narrow, twin, unrelated].map((e) => [e.id, e]))

describe('the fixture', () => {
  it('is a strict context subset over an IDENTICAL response literal', () => {
    // The premise every direction assertion below rests on. Without it, a green direction case
    // could be green because the pair is not a subsumption at all.
    expect(atomsOf(narrow, 'resp')).toEqual(atomsOf(broad, 'resp'))
    const broadContext = atomsOf(broad, 'context')
    const narrowContext = atomsOf(narrow, 'context')
    expect(narrowContext).toEqual(expect.arrayContaining(broadContext))
    expect(narrowContext.length).toBeGreaterThan(broadContext.length)
  })

  it('gives `twin` an identical literal set to `broad`, under a different id', () => {
    expect(atomsOf(twin, 'context')).toEqual(atomsOf(broad, 'context'))
    expect(atomsOf(twin, 'resp')).toEqual(atomsOf(broad, 'resp'))
    expect(twin.id).not.toBe(broad.id)
  })

  it('gives `unrelated` no atom in common with the others', () => {
    const others = new Set([broad, narrow, twin].flatMap((e) => e.atoms.map((a) => a.atom)))
    for (const a of unrelated.atoms) expect(others.has(a.atom), a.atom).toBe(false)
  })
})

describe('the subsumption direction', () => {
  it('names the general requirement when it occupies the `b` slot', async () => {
    // The discriminating half, and the only assertion in the repo a positional `moreGeneral`
    // breaks. `checkSubsumptionPair`'s `aImpliesB` branch spells the by-id mapping
    // `subsumption(a.id, b.id, …)`, which is positionally indistinguishable from by-id — so the
    // ordering that puts the general requirement in `a` agrees with a fully positional
    // implementation and pins nothing. Only `bImpliesA`, reached here, has to invert.
    // Measured: making `bImpliesA` positional too reds exactly this case out of the whole suite.
    const ctx = await getContext('symspec-subsumption-direction-b')
    const result = await checkSubsumptionPair(ctx, narrow, broad)
    expect(result).toEqual({
      code: 'FND_SUBSUMPTION',
      severity: 'warn',
      moreGeneral: 'broad',
      moreSpecific: 'narrow',
      requirementIds: ['narrow', 'broad'],
      message: 'broad subsumes narrow (more general implies more specific).',
    })
  })

  it('names the same requirement when the pair is handed over the other way round', async () => {
    // The stability half: the verdict is a property of the pair, not of which slot the caller
    // happened to use, so the two orderings agree on `moreGeneral`/`moreSpecific`. This case
    // rides the `aImpliesB` branch, where by-id and positional coincide, so it cannot on its own
    // tell the two apart — the `b`-slot case above is what does that.
    const ctx = await getContext('symspec-subsumption-direction-a')
    const result = await checkSubsumptionPair(ctx, broad, narrow)
    expect(result).toEqual({
      code: 'FND_SUBSUMPTION',
      severity: 'warn',
      moreGeneral: 'broad',
      moreSpecific: 'narrow',
      requirementIds: ['broad', 'narrow'],
      message: 'broad subsumes narrow (more general implies more specific).',
    })
  })

  it('reports `requirementIds` in pair order, so the ids are stable for reporting', async () => {
    const ctx = await getContext('symspec-subsumption-pair-order')
    const forward = await checkSubsumptionPair(ctx, narrow, broad)
    const reverse = await checkSubsumptionPair(ctx, broad, narrow)
    expect(forward?.requirementIds).toEqual(['narrow', 'broad'])
    expect(reverse?.requirementIds).toEqual(['broad', 'narrow'])
  })
})

describe('the emitted codes', () => {
  it('emits FND_REDUNDANCY for two identical literal sets', async () => {
    const ctx = await getContext('symspec-subsumption-redundancy')
    expect(await checkSubsumptionPair(ctx, broad, twin)).toEqual({
      code: 'FND_REDUNDANCY',
      severity: 'warn',
      requirementIds: ['broad', 'twin'],
      message: 'broad and twin are logically equivalent (bi-implication); one is redundant.',
    })
  })

  it('emits nothing for a pair neither direction relates', async () => {
    const ctx = await getContext('symspec-subsumption-unrelated')
    expect(await checkSubsumptionPair(ctx, broad, unrelated)).toBeUndefined()
  })

  it('carries FND_SUBSUMPTION out through the whole-tier entry point', async () => {
    const ctx = await getContext('symspec-subsumption-tier')
    const findings = await checkSubsumption(ctx, byId, [pair('narrow', 'broad')])
    expect(findings.map((f) => f.code)).toEqual(['FND_SUBSUMPTION'])
  })

  it('skips a pair whose ids the pipeline gate excluded', async () => {
    const ctx = await getContext('symspec-subsumption-missing-id')
    expect(await checkSubsumption(ctx, byId, [pair('narrow', 'absent')])).toEqual([])
  })
})

describe('the disjoint-atom prune', () => {
  it('reaches no solver at all for a pair sharing no atom', async () => {
    // A pruned pair and a checked-but-inconclusive pair produce the same empty output, so the
    // prune is only observable by counting solver contact.
    const { ctx, solvers } = countingSolvers(await getContext('symspec-subsumption-prune'))
    expect(await checkSubsumption(ctx, byId, [pair('broad', 'unrelated')])).toEqual([])
    expect(solvers()).toBe(0)
  })

  it('checks a pair that shares one — two solves, one finding', async () => {
    const { ctx, solvers } = countingSolvers(await getContext('symspec-subsumption-prune-shared'))
    const findings = await checkSubsumption(ctx, byId, [pair('narrow', 'broad')])
    expect(findings.map((f) => f.code)).toEqual(['FND_SUBSUMPTION'])
    expect(solvers()).toBe(2)
  })

  it('is behaviour-preserving on this fixture — the pruned pair had no finding to lose', async () => {
    // The docstring's claim is that pruning is not a soundness trade. Driving the pruned pair
    // through the pair checker directly is what makes that a gate rather than an argument.
    const ctx = await getContext('symspec-subsumption-prune-control')
    expect(await checkSubsumptionPair(ctx, broad, unrelated)).toBeUndefined()
  })
})
