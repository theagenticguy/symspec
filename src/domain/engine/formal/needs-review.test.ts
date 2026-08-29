/**
 * An inconclusive group has to NAME the requirements it could not decide.
 *
 * `FND_NEEDS_REVIEW` is the tier's whole output, and it is skipped when a group has no
 * members — the baseline group of a document with no unconditional requirement legitimately
 * has none. So a member projection that comes back empty for a group that HAS members turns
 * "the solver could not decide these two requirements" into silence, which is the one
 * reading AC-4-7 forbids.
 *
 * Members are recovered by rebuilding a requirement's context key and comparing it to
 * `ContextGroup.key`, so the two sides must agree on the separator byte. A requirement
 * carrying BOTH a precondition and a trigger is the smallest document where they can
 * disagree: its context is two atoms, and a single-atom context has no separator in it at
 * all.
 */

import { describe, expect, it } from 'vitest'
import { atomize as realAtomize } from './atomize.ts'
import type { Atomize, EncodableRequirement } from './encode.ts'
import { encode } from './encode.ts'
import {
  findNeedsReview,
  planNeedsReviewGroups,
  SolverBudgetExceededError,
} from './needs-review.ts'

/** The same positional adapter over the real atomizer that both tiers construct. */
const atomize: Atomize = (kind, slotText, systemName, negated) => {
  const a = realAtomize({ kind, text: slotText, systemName, negated })
  return { atom: a.name, negated: a.negated }
}

/** A requirement guarded in BOTH EARS slots, so its context is two atoms. */
const twoSlotReq = (id: string, response: string): EncodableRequirement => ({
  id,
  patternType: 'event-driven',
  preCondition: 'the cache is cold',
  trigger: 'a request arrives',
  systemName: 'gateway',
  systemResponse: response,
  negated: false,
  sentence: `While the cache is cold, when a request arrives, the gateway shall ${response}.`,
  priority: 'medium',
  status: 'draft',
})

const REQS = [
  twoSlotReq('req-a', 'enable the response cache'),
  twoSlotReq('req-b', 'log the request'),
] as const

describe('a two-slot context group names its members', () => {
  it('projects both member ids onto the group their guard atoms form', () => {
    const groups = planNeedsReviewGroups(REQS.map((r) => encode(r, atomize)))
    const twoAtom = groups.filter((g) => g.contextAtoms.length === 2)
    expect(twoAtom.map((g) => g.memberIds)).toEqual([['req-a', 'req-b']])
  })

  it('reports FND_NEEDS_REVIEW for that group when the check is inconclusive', () => {
    // The consequence, which the projection assertion above cannot see: a group with no
    // members emits nothing at all, so an empty projection reads as a decided group.
    return expect(
      findNeedsReview(REQS, {
        checkGroup: (group) =>
          Promise.resolve(
            group.contextAtoms.length === 2 ? ('unknown' as const) : ('sat' as const),
          ),
      }).then((findings) => findings.map((f) => f.requirementIds)),
    ).resolves.toEqual([['req-a', 'req-b']])
  })
})

describe('the whole-run budget is this tier`s one abort boundary', () => {
  it('throws SolverBudgetExceededError once the budget is spent, on an injected clock', () => {
    // `pipeline/check.ts` absorbs this throw into a truncation demotion and cites the
    // contract as directly tested. A per-group `unknown` must never raise it — that is the
    // finding above — so the two boundaries are gated separately.
    let ticks = 0
    return expect(
      findNeedsReview(REQS, {
        atomize,
        solverBudgetMs: 1,
        now: () => (ticks++ === 0 ? 0 : 100),
        checkGroup: () => Promise.resolve('sat' as const),
      }),
    ).rejects.toBeInstanceOf(SolverBudgetExceededError)
  })
})
