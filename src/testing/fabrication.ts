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

/**
 * One requirement, spelled so the GtWR lint tier has nothing to say about it.
 *
 * Exported so the drift gate in `./fabrication.test.ts` builds its fixture the same way the
 * corpus does — a second requirement builder would be a second set of lint quirks to keep clean.
 */
export const req = (
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

/** A state-driven requirement, for the bridge fixtures — `guard-implication` needs a guard. */
const stateReq = (n: number, preCondition: string, systemResponse: string) => {
  const id = `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'state-driven' as const,
      systemName: 'latch service',
      systemResponse,
      preCondition,
      negated: false,
      sentence: `While ${preCondition}, the latch service shall ${systemResponse}.`,
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

const stateDoc = (rows: readonly (readonly [number, string, string])[]): RequirementsDocument =>
  docOf(rows.map(([n, pre, resp]) => stateReq(n, pre, resp)))

/**
 * A state-driven requirement in a NAMED system.
 *
 * A peer of {@link stateReq} rather than a widening of it. `stateReq` hardcodes
 * `latch service`, and the bridge fixtures depend on that scope appearing in their atom names —
 * threading a system parameter through it would rewrite every one of their atoms for no reason.
 */
const stateReqIn = (
  systemName: string,
  n: number,
  preCondition: string,
  systemResponse: string,
  negated = false,
) => {
  const id = `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'state-driven' as const,
      systemName,
      systemResponse,
      preCondition,
      negated,
      sentence: `While ${preCondition}, the ${systemName} shall ${negated ? 'not ' : ''}${systemResponse}.`,
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

/**
 * A ubiquitous requirement — no guard slot at all.
 *
 * The numeric tier reads bounds out of the response slot regardless of pattern, so an
 * unconditional pair is the sharpest quantity-key fixture available: both requirements are
 * always active, which removes "the guards keep them apart" as an alternative explanation
 * for an absent conflict and leaves the quantity key as the only thing holding the line.
 */
const ubiquitousReq = (n: number, systemName: string, systemResponse: string) => {
  const id = `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'ubiquitous' as const,
      systemName,
      systemResponse,
      negated: false,
      sentence: `The ${systemName} shall ${systemResponse}.`,
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
    terms: [],
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
  /**
   * Tables the fixture commits BEFORE the plan runs.
   *
   * Most fixtures test what the planner proposes. These test what an already-committed table
   * may do to a verdict — a different claim, and the only way to reach the bridge desync.
   */
  readonly committed?: {
    readonly terms?: readonly { canonical: string; aliases: string[] }[]
    readonly glossary?: readonly { canonical: string; aliases: string[] }[]
  }
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
    /**
     * THE BRIDGE-DESYNC FIXTURE — a committed table must not be able to invert a state bridge.
     *
     * `guard-implication` decides a response ESTABLISHES a state by parsing the raw sentence,
     * while the polarity of that state comes from the atomized form. A committed table that
     * rewrites the response HEAD moves the second without moving the first, so the bridge
     * asserts the negation of what the document says — and the inert-drop compares atom names,
     * not polarity, so it does not catch it.
     *
     * R1 and R2 are the SAME requirement inflected differently; the tool itself calls them
     * logically equivalent. R3 exists only so `latch_engaged` is a guard some other requirement
     * keys on, which is what makes the bridge live rather than inert.
     *
     * Reached here through `terms`, and identically reachable through the shipped `glossary` —
     * so the fix belongs at check time, not in either table's write path.
     */
    id: 'a-committed-table-must-not-invert-a-state-bridge',
    why:
      'Two requirements that both KEEP the latch engaged, plus a third that guards on the ' +
      'latch being engaged. Nothing here conflicts: the tool reports the first two as ' +
      'logically equivalent. A committed table that rewrites the establishing verb must not ' +
      'turn that into a proven contradiction.',
    doc: stateDoc([
      [30, 'the door is open', 'keeps the latch engaged'],
      [31, 'the door is open', 'keep the latch engaged'],
      [32, 'the latch is engaged', 'log the state'],
    ]),
    table: {
      'keeps the latch engaged': [1, 0.02],
      'keep the latch engaged': [1, 0.03],
      'log the state': [0, 1],
    },
    expectsEmptyPlan: false,
    // The committed tables that MUST NOT fabricate. Each was accepted by the CLI and each
    // turned a clean document into an error-severity FND_CONTRADICTION before the fix.
    committed: {
      terms: [{ canonical: 'revokes entry', aliases: ['keeps the latch'] }],
    },
  },
  {
    id: 'a-committed-GLOSSARY-must-not-invert-a-state-bridge',
    why:
      'The same document and the same hazard, reached through the shipped `glossary` command ' +
      'instead of `terms`. This one predates the term table entirely, which is why the fix is ' +
      'at check time: no write-time fence on `terms` could ever have closed it.',
    doc: stateDoc([
      [33, 'the door is open', 'keep the latch engaged'],
      [34, 'the door is open', 'hold the latch engaged'],
      [35, 'the latch is engaged', 'log the state'],
    ]),
    table: {
      'keep the latch engaged': [1, 0.02],
      'hold the latch engaged': [1, 0.03],
      'log the state': [0, 1],
    },
    expectsEmptyPlan: false,
    committed: {
      glossary: [{ canonical: 'revoke entry', aliases: ['keep the latch engaged'] }],
    },
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
    /**
     * FABRICATION A, the regression fixture — reproduced on the built CLI before the fix.
     *
     * The canonical hysteresis-free threshold split, which is how engineers write thresholds. Two
     * guards that cannot both hold, one response atom at opposite polarity. `normalize` deleted the
     * comparator (it is punctuation), so both guards became
     * `sys__gateway__pre__request_latency_30_ms`, one context group hosted both requirements, and
     * the opposed responses proved an `error` FND_CONTRADICTION with `verified: true` and exit 1.
     *
     * Kept as a fixture rather than only an `atomize` unit test because the atom-level assertion
     * cannot see the consequence: the atoms merging is the mechanism, the fabricated verdict is the
     * defect, and only the corpus asserts the second.
     */
    id: 'symbolic-threshold-split',
    why:
      'A threshold split written with symbolic comparators. `>= 30 ms` and `< 30 ms` cannot both ' +
      'hold, so the document is consistent no matter what the responses say — and its responses ' +
      'are one atom at opposite polarity, which is the other half of a contradiction. If the ' +
      'comparator ever stops surviving normalization these two guards share an atom again and the ' +
      'conflict is manufactured.',
    doc: docOf([
      stateReqIn('gateway', 9, 'the request latency is >= 30 ms', 'enable the response cache'),
      stateReqIn('gateway', 10, 'the request latency is < 30 ms', 'disable the response cache'),
    ]),
    table: {
      'enable the response cache': [1, 0.02],
      'disable the response cache': [1, 0.03],
      'the request latency is >= 30 ms': [1, 0.02],
      'the request latency is < 30 ms': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    /**
     * THE EROSION FENCE — the same ground truth as the fixture above, with a comparator added.
     *
     * This fixture exists to catch a failure no other one can: a recognizer that consumes the
     * threshold clause and DROPS the rest of the guard. Erasure is indistinguishable from
     * over-merging in its effect — a weaker antecedent activates in strictly more contexts — so
     * `>= 30 ms and the cache is cold` reduced to `>= 30 ms` would put these two requirements in
     * ONE context group and prove their opposed responses contradictory.
     *
     * The document is consistent for exactly the reason the shift fixture is: a cold cache and a
     * warm cache never co-occur. The shared threshold is the part a partial lift is tempted by.
     */
    id: 'compound-guard-shared-threshold',
    why:
      'Two guards sharing a latency threshold but differing in cache state, with one response ' +
      'at opposite polarity. Consistent because a cold cache and a warm cache cannot both ' +
      'hold, so the two requirements sit in separate context groups. Any rewrite that keeps ' +
      'the threshold and discards the cache clause merges those groups and manufactures the ' +
      'conflict — which is why this fixture guards the recognizer, not the planner.',
    doc: docOf([
      stateReqIn(
        'gateway',
        7,
        'the request latency is >= 30 ms and the cache is cold',
        'enable the response cache',
      ),
      stateReqIn(
        'gateway',
        8,
        'the request latency is >= 30 ms and the cache is warm',
        'disable the response cache',
      ),
    ]),
    table: {
      'enable the response cache': [1, 0.02],
      'disable the response cache': [1, 0.03],
      'the request latency is >= 30 ms and the cache is cold': [1, 0.02],
      'the request latency is >= 30 ms and the cache is warm': [1, 0.03],
    },
    expectsEmptyPlan: true,
  },
  {
    /**
     * FABRICATION B, the regression fixture — reproduced on the built CLI before the fix.
     *
     * The numeric tier's quantity key is the phrase before the comparator. A trailing-word
     * window over that phrase drops the qualifier that distinguishes two shards, so
     * `primary shard replication lag` and `analytics shard replication lag` land on one Real
     * variable, ≤ 10 ms ∧ ≥ 500 ms is UNSAT, and `error FND_NUMERIC_CONTRADICTION` names both
     * requirements. No comparator symbol and no glossary is involved: the lenient key is the
     * whole cause.
     *
     * Both requirements are ubiquitous, so nothing about the guards can be credited for the
     * document being consistent — the quantity key is load-bearing on its own.
     *
     * `expectsEmptyPlan` is false, and deliberately: with the table pushing the two response
     * bodies together the planner proposes one whole-body glossary alias. That merge is a
     * RESPONSE merge, so it costs recall and cannot fabricate; and it leaves the quantity keys
     * alone, because `glossaryIndex` keys on the whole normalized body while `quantityKey`
     * looks up the label — the phrase before the comparator. Both halves of the gate here are
     * the `counts.error` ones, and the BEFORE half is the fabrication-B regression.
     */
    id: 'distinct-shard-quantities',
    why:
      "A tight bound on one shard's replication lag and a loose bound on another shard's are " +
      'two bounds on two quantities, and the sentences differ only in the qualifier that says ' +
      'which shard. Any quantity key that drops that qualifier co-asserts the two bounds on one ' +
      'Real variable and proves a conflict the document does not contain.',
    doc: docOf([
      ubiquitousReq(11, 'database', 'keep the primary shard replication lag at most 10 ms'),
      ubiquitousReq(12, 'database', 'keep the analytics shard replication lag at least 500 ms'),
    ]),
    table: {
      'keep the primary shard replication lag at most 10 ms': [1, 0.02],
      'keep the analytics shard replication lag at least 500 ms': [1, 0.03],
    },
    expectsEmptyPlan: false,
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
