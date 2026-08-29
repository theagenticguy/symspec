/**
 * RELATIONAL VACUITY — the one path that reaches a finding, and who it blames.
 *
 * ## The reachable path
 *
 * `checkVacuityOf` asserts every OTHER requirement's body plus the target's guard literals and
 * looks for `unsat`. Under the shipped atomizer the only way that set goes unsat is:
 *
 *   - two OTHER requirements force one `resp` atom at OPPOSITE polarity, and
 *   - each of their context sets is a subset of the target's, so asserting the target's guard
 *     activates both.
 *
 * So the tier fires on the requirement whose guard is asserted — the target — while the
 * contradiction lives entirely in the other two. `FND_VACUITY` is `warn` with
 * `confidence: 'low'`, so this is not a fabrication (no error severity, no exit 1), but it is a
 * misattribution: an author reading the finding is told the innocent rule can never fire.
 * TODO(slice 8): narrow the blame to the requirements that actually force the contradiction.
 *
 * ## Why a `resp`-versus-`pre` collision cannot be the mechanism
 *
 * A `resp` atom and a `pre` atom are never the same name: `renderAtom` writes
 * `sys__<scope>__<kind>__<body>`, so `kind` is part of atom identity and the two live in
 * disjoint namespaces — the same property the falsifiability lemma in `subsumption.ts` rests on.
 * "shall disable maintenance mode" therefore cannot collide with "while maintenance mode is
 * enabled", and the last case in this file pins that as a namespace property rather than as a
 * fact about two particular phrases.
 */

import { describe, expect, it } from 'vitest'
import { type AtomKind, makeAtomize } from './atomize.ts'
import { getContext } from './backend.ts'
import { type EncodableRequirement, type EncodedRequirement, encode } from './encode.ts'
import { checkVacuity, checkVacuityOf } from './vacuity.ts'

const real = makeAtomize()

const enc = (o: {
  id: string
  preCondition?: string
  trigger?: string
  systemResponse: string
}): EncodedRequirement => {
  const req: EncodableRequirement = {
    id: o.id,
    patternType: o.trigger === undefined ? 'state-driven' : 'event-driven',
    preCondition: o.preCondition,
    trigger: o.trigger,
    systemName: 'lift controller',
    systemResponse: o.systemResponse,
    negated: false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
  }
  return encode(req, real)
}

const DOOR_OPEN = 'the door is open'

/** The blamed requirement: its guard is what activates the other two. */
const target = enc({ id: 'v-target', preCondition: DOOR_OPEN, systemResponse: 'halt the car' })
/** `enable` and `disable` are a seed antonym pair, so these two force ONE atom, opposed. */
const forcesOn = enc({ id: 'v-on', preCondition: DOOR_OPEN, systemResponse: 'enable the alarm' })
const forcesOff = enc({ id: 'v-off', preCondition: DOOR_OPEN, systemResponse: 'disable the alarm' })
/** Same conflict, but behind a guard the target does not assert. */
const forcesOffElsewhere = enc({
  id: 'v-off-elsewhere',
  preCondition: 'the service key is inserted',
  systemResponse: 'disable the alarm',
})

describe('the fixture', () => {
  it('puts the two other requirements on ONE response atom at opposite polarity', () => {
    // The premise. Without it the vacuity assertions below could be green for any reason.
    const resp = (e: EncodedRequirement) => e.atoms.find((a) => a.kind === 'resp')
    expect(resp(forcesOn)?.atom).toBe(resp(forcesOff)?.atom)
    expect(resp(forcesOn)?.negated).toBe(true)
    expect(resp(forcesOff)?.negated).toBe(false)
  })

  it('gives both of them the same guard atom the target carries', () => {
    const guardAtoms = (e: EncodedRequirement) =>
      e.atoms.filter((a) => a.kind !== 'resp').map((a) => a.atom)
    expect(guardAtoms(forcesOn)).toEqual(guardAtoms(target))
    expect(guardAtoms(forcesOff)).toEqual(guardAtoms(target))
  })
})

describe('the bystander a contradiction elsewhere blames', () => {
  it('emits FND_VACUITY against the target and no one else', async () => {
    const ctx = await getContext('symspec-vacuity-reachable')
    expect(await checkVacuity(ctx, [target, forcesOn, forcesOff])).toEqual([
      {
        code: 'FND_VACUITY',
        severity: 'warn',
        confidence: 'low',
        requirementId: 'v-target',
        message:
          "v-target's guard is unreachable given the rest of the spec; the requirement can never fire (low confidence — regex-level heuristic).",
      },
    ])
  })

  it('leaves the two requirements that actually conflict unflagged', async () => {
    // Each of them, checked against the rest, has its own guard satisfiable: the third
    // requirement forces nothing that contradicts. So the blame lands only on the bystander.
    const ctx = await getContext('symspec-vacuity-conflictors')
    expect(await checkVacuity(ctx, [forcesOn, forcesOff])).toEqual([])
  })

  it('needs BOTH polarities forced — one of them is not enough', async () => {
    const ctx = await getContext('symspec-vacuity-one-polarity')
    expect(await checkVacuity(ctx, [target, forcesOn])).toEqual([])
    expect(await checkVacuity(ctx, [target, forcesOff])).toEqual([])
  })

  it('needs both context sets inside the one asserted — an omitted guard does not fire', async () => {
    // `v-off-elsewhere` carries the opposite response behind a DIFFERENT guard, so asserting
    // the target's guard leaves it vacuously satisfied.
    const ctx = await getContext('symspec-vacuity-disjoint-guard')
    expect(await checkVacuity(ctx, [target, forcesOn, forcesOffElsewhere])).toEqual([])
  })
})

describe('a requirement with no guard', () => {
  it('is never a vacuity candidate', async () => {
    // A bare `R` always fires, so there is no guard whose reachability could fail.
    const ctx = await getContext('symspec-vacuity-ubiquitous')
    const ubiquitous = encode(
      {
        id: 'v-ubiquitous',
        patternType: 'ubiquitous',
        preCondition: undefined,
        trigger: undefined,
        systemName: 'lift controller',
        systemResponse: 'halt the car',
        negated: false,
        sentence: '',
        priority: 'medium',
        status: 'draft',
      },
      real,
    )
    expect(await checkVacuityOf(ctx, ubiquitous, [ubiquitous, forcesOn, forcesOff])).toBeUndefined()
  })
})

describe('a response atom and a guard atom are different atoms', () => {
  it('holds for the example the module header names', () => {
    const response = real('resp', 'disable maintenance mode', 'ops portal', false)
    const guard = real('pre', 'maintenance mode is enabled', 'ops portal', false)
    expect(response.atom).not.toBe(guard.atom)
  })

  it('holds for every kind pair over identical text, because `kind` is in the name', () => {
    // The general property, so the case does not depend on the two phrases above normalizing
    // differently. Every kind renders its own namespace, so no text can cross one.
    const kinds: readonly AtomKind[] = ['pre', 'trig', 'resp', 'feat']
    for (const text of ['maintenance mode is enabled', 'the alarm', 'halt the car']) {
      const names = kinds.map((kind) => real(kind, text, 'ops portal', false).atom)
      expect(new Set(names).size, `two kinds collided on ${text}: ${names.join(' ')}`).toBe(
        kinds.length,
      )
    }
  })
})
