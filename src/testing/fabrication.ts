/**
 * THE FABRICATION CORPUS — documents that must NOT acquire a conflict.
 *
 * ## The metric this exists to supply
 *
 * Every gate in this package scores the same direction: a planted defect must be found.
 * `./eval-rounds.ts` scores detection and localization; `./harness.ts` climbs difficulty
 * tiers looking for escapes. None of them can fail a detector that fires on everything.
 * `.erpaval/specs/003-symspec-v4/spec.md` AC-4-10 names the gap directly — the oracle is
 * the fixture label written by the same author, so a tool that reported a contradiction in
 * every document would pass the whole suite.
 *
 * This is the other direction. Each fixture is a document whose requirements are
 * LEXICALLY CLOSE and GENUINELY DISTINCT, carrying the reason they must stay apart. The
 * assertion is that running `propose-glossary`, applying everything the plan was willing
 * to emit, and re-checking produces no error-severity finding. A merge the planner should
 * have withheld shows up here as a conflict the document does not contain.
 *
 * ## Why it belongs with the vocabulary tier specifically
 *
 * Over-unification is the one false-positive risk the README discloses, and every
 * widening of the glossary pass moves that risk. A wrong response merge only MASKS a
 * conflict, so it costs recall. A wrong GUARD merge asserts two different conditions are
 * one condition, which puts two requirements into one context group and can prove a
 * conflict that is not there — the failure the tool must never produce, because unlike a
 * miss it is the tool's own doing.
 *
 * ## The embedder is a TABLE, never the stub
 *
 * `SYMSPEC_EMBED_STUB=1` produces deterministic but meaningless cosines, so it cannot put
 * a pair deliberately above the threshold. Every fixture supplies its own unit vectors and
 * pushes its pair WELL above the cut, because the point is to prove the withhold is
 * structural: cosine is doing everything it can to merge these, and the planner declines
 * anyway.
 */

import { DOC_VERSION, type RequirementsDocument } from '../domain/requirements/document.ts'

const TS = '2026-01-01T00:00:00.000Z'

/** One requirement, spelled so the GtWR lint tier has nothing to say about it. */
const req = (
  n: number,
  systemName: string,
  trigger: string,
  systemResponse: string,
  negated = false,
) => {
  const id = `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'event-driven' as const,
      systemName,
      systemResponse,
      trigger,
      negated,
      sentence: `When ${trigger}, the ${systemName} shall ${negated ? 'not ' : ''}${systemResponse}.`,
      priority: 'medium' as const,
      status: 'draft' as const,
      createdAt: TS,
      updatedAt: TS,
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    },
  ] as const
}

const docOf = (rows: readonly (readonly [string, unknown])[]): RequirementsDocument =>
  ({
    docVersion: DOC_VERSION,
    requirements: Object.fromEntries(rows),
    glossary: [],
    antonyms: [],
    waivers: [],
    stateModel: { variables: [] },
  }) as unknown as RequirementsDocument

/** One fixture: a document, the vectors that push its pair together, and why it must hold. */
export interface FabricationCase {
  readonly id: string
  /** Why these phrasings are genuinely distinct — the ground truth, in prose. */
  readonly why: string
  readonly doc: RequirementsDocument
  /** Unit vectors per raw phrase. Every phrase the document contains must be listed. */
  readonly table: Readonly<Record<string, readonly [number, number]>>
  /**
   * True when the planner is expected to emit nothing at all for this document.
   *
   * Stated per fixture rather than asserted globally, because "the plan was empty" and
   * "the plan was applied and fabricated nothing" are different claims and only the second
   * is the point. A fixture that expects an empty plan is asserting a WITHHOLD.
   */
  readonly expectsEmptyPlan: boolean
}

/**
 * The corpus.
 *
 * Deliberately small and hand-written. A generated corpus would need a generator that
 * knows which phrasings are genuinely distinct, which is the judgment under test.
 */
export const fabricationCases = (): readonly FabricationCase[] => [
  {
    id: 'same-object-opposed-verbs',
    why:
      'Sending and receiving one packet are different events that happen to share an ' +
      'object. `quantity-alias.ts` names this exact pair as the trap: merging them would ' +
      'manufacture a conflict between two requirements that describe opposite ends of one ' +
      'link.',
    doc: docOf([
      req(1, 'relay service', 'the link opens', 'transmit the packet'),
      req(2, 'relay service', 'the link opens', 'receive the packet'),
    ]),
    table: {
      'transmit the packet': [1, 0.02],
      'receive the packet': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    // The load-bearing fixture. The two above merge onto ONE polarity, so a wrong merge
    // there is a redundancy (warn) — bad, but not the failure this gate is named for. Here
    // the polarities are opposite and the trigger is shared, so a wrong merge produces
    // `FND_CONTRADICTION` at error severity in a document that plainly has no conflict.
    // Without this case the `counts.error` assertion would be satisfiable by every fixture
    // for reasons unrelated to fabrication.
    id: 'same-object-opposed-verbs-opposite-polarity',
    why:
      'Transmitting a packet and NOT receiving one are both true of a one-way link under ' +
      'the same trigger. The verbs share an object, so a merge collapses them onto one ' +
      'atom — and because the polarities differ, that merge proves a contradiction the ' +
      'document does not contain.',
    doc: docOf([
      req(9, 'gateway service', 'the audit begins', 'transmit the packet'),
      req(10, 'gateway service', 'the audit begins', 'receive the packet', true),
    ]),
    table: {
      'transmit the packet': [1, 0.02],
      'receive the packet': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    id: 'negating-prefix-different-objects',
    why:
      'De-duplicating a ledger and duplicating a shard are unrelated operations whose ' +
      'verbs happen to relate by a `de-` prefix. The morphology fires regardless of the ' +
      'object, and it must, because the alternative is trusting cosine to tell an opposite ' +
      'from a paraphrase.',
    doc: docOf([
      req(3, 'index service', 'the batch lands', 'duplicate the shard'),
      req(4, 'index service', 'the batch lands', 'de-duplicate the ledger'),
    ]),
    table: {
      'duplicate the shard': [1, 0.02],
      'de-duplicate the ledger': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    id: 'mutually-exclusive-guards-opposed-response',
    why:
      'One response at opposite polarity under two triggers that cannot both hold. The ' +
      'document is consistent precisely BECAUSE the guards are distinct: the shift ending ' +
      'and the shift beginning never co-occur, so `planContextGroups` keeps the two ' +
      'requirements in separate groups and neither contradicts the other. Aligning those ' +
      'two triggers is what a guard-slot proposal would suggest, and committing it would ' +
      'manufacture the conflict.',
    doc: docOf([
      req(5, 'vault service', 'the shift ends', 'seal the vault'),
      req(6, 'vault service', 'the shift begins', 'seal the vault', true),
    ]),
    table: {
      'seal the vault': [1, 0.02],
      'the shift ends': [1, 0.02],
      'the shift begins': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    id: 'distinct-agents-same-report',
    why:
      'A sensor reporting a fault and an operator reporting a fault are different events. ' +
      'The responses are opposed, so merging the two triggers would prove a conflict; the ' +
      'document as written has none.',
    doc: docOf([
      req(7, 'alarm service', 'the sensor reports a fault', 'raise the siren'),
      req(8, 'alarm service', 'the operator reports a fault', 'raise the siren', true),
    ]),
    table: {
      'raise the siren': [1, 0.02],
      'the sensor reports a fault': [1, 0.02],
      'the operator reports a fault': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
]
