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
 *
 * The degenerate-body block asserts the ABSENCE of both codes, which needs its own premise
 * case: a body that is not actually valid (or not actually unsatisfiable) produces the same
 * empty output as one the screen caught. So the fixture's degeneracy is measured against a raw
 * solver first, alongside the contrast that a body `encode` really emits is contingent.
 */

import { describe, expect, it } from 'vitest'
import { makeAtomize } from './atomize.ts'
import { getContext, type Z3Context } from './backend.ts'
import {
  and,
  atom,
  cmp,
  type EncodableRequirement,
  type EncodedRequirement,
  encode,
  type Formula,
  implies,
  materialize,
  not,
  or,
} from './encode.ts'
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

/**
 * A quantity name of the shape `numeric.ts` owns. It appears only inside a `cmp`, which
 * `atomsOf` contributes nothing for — so a body built from these shares no ATOM with anything.
 */
const QTY = 'sys__gateway__qty__request_latency'
/** A response atom name, so a degenerate body can still share an atom with its counterparty. */
const CACHE = 'sys__gateway__resp__enable_the_response_cache'

/**
 * An encoded requirement with a hand-injected body. `encode` puts no `cmp` in a body and no
 * excluded middle in one, so a degenerate body has to be built directly; everything else is
 * `broad`'s, and only `id`/`body` are read by the tier.
 */
const withBody = (id: string, body: Formula): EncodedRequirement => ({
  ...broad,
  id,
  guard: id,
  atoms: [],
  body,
  formula: implies(atom(id), body),
})

/** `q < 30 ∨ q ≥ 30` — VALID over the reals, and it shares no atom with anything. */
const tautologyAt30 = withBody('taut-30', or([cmp(QTY, '<', 30), cmp(QTY, '>=', 30)]))
/** `q ≤ 10 ∨ q > 10` — a different literal set over the same quantity, equally valid. */
const tautologyAt10 = withBody('taut-10', or([cmp(QTY, '<=', 10), cmp(QTY, '>', 10)]))
/** `q < 5 ∧ q > 10` — UNSATISFIABLE, the other degenerate shape. */
const contradictoryBody = withBody('unsat-body', and([cmp(QTY, '<', 5), cmp(QTY, '>', 10)]))
/** `R ∨ ¬R` — valid AND atom-bearing, so `sharesAtom` admits a pair of these. */
const excludedMiddleA = withBody('em-a', or([atom(CACHE), not(atom(CACHE))]))
/** `R ∨ ¬R` under a second id. */
const excludedMiddleB = withBody('em-b', or([atom(CACHE), not(atom(CACHE))]))

/** Ask the solver directly, so a fixture's degeneracy is measured rather than assumed. */
const solve = async (ctx: Z3Context, f: Formula): Promise<string> => {
  const solver = new ctx.Solver()
  solver.add(materialize(ctx, f))
  return await solver.check()
}

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

const byId = new Map(
  [
    broad,
    narrow,
    twin,
    unrelated,
    tautologyAt30,
    tautologyAt10,
    contradictoryBody,
    excludedMiddleA,
    excludedMiddleB,
  ].map((e) => [e.id, e]),
)

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
    const { findings } = await checkSubsumption(ctx, byId, [pair('narrow', 'broad')])
    expect(findings.map((f) => f.code)).toEqual(['FND_SUBSUMPTION'])
  })

  it('skips a pair whose ids the pipeline gate excluded, and counts the skip', async () => {
    const ctx = await getContext('symspec-subsumption-missing-id')
    expect(await checkSubsumption(ctx, byId, [pair('narrow', 'absent')])).toEqual({
      findings: [],
      pruned: 1,
    })
  })
})

describe('the disjoint-atom prune', () => {
  it('reaches no solver at all for a pair sharing no atom', async () => {
    // A pruned pair and a checked-but-inconclusive pair produce the same empty output, so the
    // prune is only observable by counting solver contact — and by the `pruned` tally, which is
    // what carries it out to the pipeline's `pairsChecked`.
    const { ctx, solvers } = countingSolvers(await getContext('symspec-subsumption-prune'))
    expect(await checkSubsumption(ctx, byId, [pair('broad', 'unrelated')])).toEqual({
      findings: [],
      pruned: 1,
    })
    expect(solvers()).toBe(0)
  })

  it('checks a pair that shares one — four contingency solves, two implications, one finding', async () => {
    // The solve budget of one compared pair, spelled out because it is the tier's whole cost
    // model: two satisfiability probes per requirement to establish contingency, then the two
    // implication solves. The contingency answers are memoized per requirement id, so a second
    // pair over either requirement adds two solves, not six.
    const { ctx, solvers } = countingSolvers(await getContext('symspec-subsumption-prune-shared'))
    const { findings, pruned } = await checkSubsumption(ctx, byId, [pair('narrow', 'broad')])
    expect(findings.map((f) => f.code)).toEqual(['FND_SUBSUMPTION'])
    expect(pruned).toBe(0)
    expect(solvers()).toBe(6)
  })

  it('answers contingency once per requirement across pairs, not once per pair', async () => {
    // The memo is what keeps the screen O(N) on the O(N²) hot path. Three pairs over the same
    // three requirements cost 6 contingency solves, not 12.
    const { ctx, solvers } = countingSolvers(await getContext('symspec-subsumption-memo'))
    const { pruned } = await checkSubsumption(ctx, byId, [
      pair('narrow', 'broad'),
      pair('broad', 'twin'),
      pair('narrow', 'twin'),
    ])
    expect(pruned).toBe(0)
    // 3 requirements × 2 satisfiability probes + 3 pairs × 2 implication solves.
    expect(solvers()).toBe(3 * 2 + 3 * 2)
  })

  it('is behaviour-preserving on this fixture — the pruned pair had no finding to lose', async () => {
    // The docstring's claim is that pruning is not a soundness trade. Driving the pruned pair
    // through the pair checker directly is what makes that a gate rather than an argument.
    const ctx = await getContext('symspec-subsumption-prune-control')
    expect(await checkSubsumptionPair(ctx, broad, unrelated)).toBeUndefined()
  })
})

describe('a degenerate body', () => {
  it('is degenerate — the premise every assertion below rests on', async () => {
    // Without this, a green "no finding" case could be green because the body is ordinary. The
    // discriminating fact is the SECOND probe of each pair: `¬body` unsat means the body is
    // valid, which is what makes `implies(anything, body)` answer without reading `anything`.
    const ctx = await getContext('symspec-subsumption-degenerate-premise')
    expect(await solve(ctx, tautologyAt30.body), 'a tautology is satisfiable').toBe('sat')
    expect(await solve(ctx, not(tautologyAt30.body)), 'and unfalsifiable').toBe('unsat')
    expect(await solve(ctx, not(tautologyAt10.body)), 'so is the other one').toBe('unsat')
    expect(await solve(ctx, not(excludedMiddleA.body)), 'and the atom-bearing one').toBe('unsat')
    expect(await solve(ctx, contradictoryBody.body), 'the unsat body has no model').toBe('unsat')
    // The contrast: a body `encode` really emits is contingent, which is the lemma
    // `sharesAtom` proves and the reason this screen changes no verdict on a real document.
    expect(await solve(ctx, broad.body), 'a real body is satisfiable').toBe('sat')
    expect(await solve(ctx, not(broad.body)), 'and falsifiable').toBe('sat')
  })

  it('does not subsume a real requirement', async () => {
    // `implies(broad.body, valid)` is valid for every left side, so a positional read of the
    // solver's answer names `broad` as the more general requirement and tells the author to
    // delete it. The claim is about the shape of `taut-30`'s body, not about either
    // requirement.
    const ctx = await getContext('symspec-subsumption-degenerate-vs-real')
    expect(await checkSubsumptionPair(ctx, broad, tautologyAt30)).toBeUndefined()
    expect(await checkSubsumptionPair(ctx, tautologyAt30, broad)).toBeUndefined()
  })

  it('does not duplicate another degenerate body over the same quantity', async () => {
    // Two tautologies imply each other for the same reason, which reads out as
    // `FND_REDUNDANCY` — "one is redundant" — over two requirements that share no literal.
    const ctx = await getContext('symspec-subsumption-degenerate-redundancy')
    expect(await checkSubsumptionPair(ctx, tautologyAt30, tautologyAt10)).toBeUndefined()
  })

  it('does not subsume the document when it is UNSATISFIABLE either', async () => {
    // The other half of degeneracy, and the one an unsatisfiable guard conjunction produces:
    // `implies(unsat, anything)` is valid, so this body subsumes every counterparty.
    const ctx = await getContext('symspec-subsumption-degenerate-unsat')
    expect(await checkSubsumptionPair(ctx, contradictoryBody, broad)).toBeUndefined()
    expect(await checkSubsumptionPair(ctx, contradictoryBody, tautologyAt30)).toBeUndefined()
  })

  it('is screened at the tier too, and counted as a pair no solve compared', async () => {
    // `sharesAtom` cannot see a `cmp`'s quantity, so a pair of cmp-only tautologies never
    // reaches the pair checker through the tier. These two share an ATOM, so the atom prune
    // admits them and the contingency screen is the only thing between them and a
    // `FND_REDUNDANCY` naming both ids.
    const ctx = await getContext('symspec-subsumption-degenerate-tier')
    expect(await checkSubsumption(ctx, byId, [pair('em-a', 'em-b')])).toEqual({
      findings: [],
      pruned: 1,
    })
  })

  it('reaches the pair checker only directly when the body is cmp-only', async () => {
    // Why the screen lives in `checkSubsumptionPair` rather than in the tier loop: through the
    // tier, `atomsOf`'s empty `cmp` arm prunes this pair before any solve, so the tier alone
    // would make the screen untestable on exactly the shape that motivates it.
    const { ctx, solvers } = countingSolvers(
      await getContext('symspec-subsumption-degenerate-atom-prune'),
    )
    expect(await checkSubsumption(ctx, byId, [pair('taut-30', 'taut-10')])).toEqual({
      findings: [],
      pruned: 1,
    })
    expect(solvers()).toBe(0)
  })
})
