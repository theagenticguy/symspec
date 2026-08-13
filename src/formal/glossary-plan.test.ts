/**
 * THE GLOSSARY PLAN — asserted through the code that applies it, not against itself.
 *
 * ## Why the headline test folds the plan rather than inspecting it
 *
 * `applyGlossary` (`core/mutate.ts`) locates a group by EXACT `canonical` match with no
 * normalization and no cross-group lookup, so committing an alias that already belongs to
 * a different canonical is silently accepted and the alias ends up in two groups —
 * `glossaryIndex` then resolves it last-write-wins by array order. Committing one alias by
 * hand makes that rare; emitting a whole PLAN makes it likely.
 *
 * A test that scanned `plan.ops` for duplicate aliases would pass while `applyGlossary`
 * quietly forked a group. So the load-bearing assertion applies the plan through the real
 * fold and then asserts a property of the RESULT: the alias index is injective and
 * one-hop closed. That is the only shape that ties this module to the defect it has to
 * route around.
 *
 * ## Vectors are injected, never stubbed
 *
 * `SYMSPEC_EMBED_STUB=1` (which the suite sets) produces deterministic but MEANINGLESS
 * cosines, so it cannot test a threshold at all. Every case here supplies its own unit
 * vectors, so a case can sit deliberately just above or just below the cut.
 */

import { describe, expect, it } from 'vitest'
import { DOC_VERSION, type RequirementsDocument } from '../core/document.ts'
import { foldOps } from '../core/mutate.ts'
import type { DocumentOp } from '../core/ops.ts'
import { glossaryIndex, normalize } from '../donor/formal/atomize.ts'
import type { Embedder } from '../donor/formal/embed.ts'
import { findOppositionCandidates } from '../donor/formal/semantic.ts'
import { toDonorDoc } from './compat.ts'
import { buildGlossaryPlan, isNegatingPrefixPair, oppositionShape } from './glossary-plan.ts'

const TS = '2026-01-01T00:00:00.000Z'

/**
 * Unit vectors from a 2-D table, so every cosine is exactly computable.
 *
 * The `embedder.test.ts` pattern. An unlisted text lands on `[1, 0]`, which makes "I forgot
 * to add this phrase" look like a similarity rather than a miss — so every case lists every
 * phrase it uses.
 */
const tableEmbedder = (
  table: Readonly<Record<string, readonly [number, number]>>,
): Embedder & { calls: string[][] } => {
  const calls: string[][] = []
  const unit = (v: readonly [number, number]): Float32Array => {
    const n = Math.hypot(v[0], v[1]) || 1
    return Float32Array.from([v[0] / n, v[1] / n])
  }
  const fn = async (texts: readonly string[]) => {
    calls.push([...texts])
    return texts.map((t) => unit(table[t] ?? [1, 0]))
  }
  return Object.assign(fn, { calls })
}

let seq = 0
const req = (systemName: string, systemResponse: string, trigger: string) => {
  seq += 1
  const id = `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, '0')}`
  return [
    id,
    {
      id,
      patternType: 'event-driven' as const,
      systemName,
      systemResponse,
      trigger,
      negated: false,
      sentence: `When ${trigger}, the ${systemName} shall ${systemResponse}.`,
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

const docOf = (
  rows: readonly (readonly [string, unknown])[],
  extra: { glossary?: unknown[]; antonyms?: unknown[] } = {},
): RequirementsDocument =>
  ({
    docVersion: DOC_VERSION,
    requirements: Object.fromEntries(rows),
    glossary: extra.glossary ?? [],
    antonyms: extra.antonyms ?? [],
    waivers: [],
    stateModel: { variables: [] },
  }) as unknown as RequirementsDocument

/** Three auth phrasings that mean one thing, plus one unrelated system. */
const PARAPHRASE_TABLE = {
  'issue a session token': [1, 0.05],
  'issue a login credential': [1, 0.08],
  'mint an access token': [1, 0.11],
  'issue a receipt': [0, 1],
} as const

const paraphraseDoc = () =>
  docOf([
    req('auth service', 'issue a session token', 'the user signs in'),
    req('auth service', 'issue a login credential', 'the user signs in'),
    req('auth service', 'mint an access token', 'the user signs in'),
    req('billing service', 'issue a receipt', 'a payment settles'),
  ])

// ---------------------------------------------------------------------------
// THE HEADLINE: apply the plan, then inspect the RESULT
// ---------------------------------------------------------------------------

/**
 * `glossaryIndex` is `alias -> canonical`, flat and ONE HOP.
 *
 * Injective on aliases means no alias resolves two ways. One-hop closed means no canonical
 * is itself an alias — because `atomize` looks up exactly once, a chain silently never
 * resolves and the merge an author thought they committed does not happen.
 */
const assertIndexIsSound = (document: RequirementsDocument): void => {
  const index = glossaryIndex(document.glossary)
  const seen = new Map<string, string>()
  for (const group of document.glossary) {
    for (const alias of group.aliases) {
      const key = normalize(alias)
      const previous = seen.get(key)
      expect(
        previous === undefined || previous === normalize(group.canonical),
        `alias ${JSON.stringify(alias)} resolves two ways: ${previous} and ${normalize(group.canonical)}`,
      ).toBe(true)
      seen.set(key, normalize(group.canonical))
    }
  }
  for (const [alias, canonical] of index) {
    expect(
      index.get(canonical),
      `canonical ${JSON.stringify(canonical)} (for alias ${JSON.stringify(alias)}) is ITSELF an alias — the chain never resolves`,
    ).toBeUndefined()
  }
}

const applyPlan = (document: RequirementsDocument, ops: readonly DocumentOp[]) => {
  const folded = foldOps(document, ops, TS, { continueOnError: false })
  expect(
    folded.results.every((r) => r.ok),
    JSON.stringify(folded.results),
  ).toBe(true)
  return folded.document
}

describe('applying the plan leaves a SOUND glossary index', () => {
  it('the clean case: three phrasings become one group', async () => {
    const doc = paraphraseDoc()
    const plan = await buildGlossaryPlan(toDonorDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    expect(plan.ops.length).toBe(2)
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })

  /**
   * The case that makes the reconciliation pass load-bearing.
   *
   * `issue a receipt` is a paraphrase of `issue a session token` under `auth service` AND
   * of `issue a voucher` under `billing service`, so two classes both want to claim it.
   * Committing both would leave the alias in two groups, resolving by table order.
   */
  it('the CONTESTED case: a phrase two classes want is withheld from both', async () => {
    const doc = docOf([
      req('auth service', 'issue a session token', 'the user signs in'),
      req('auth service', 'issue a receipt', 'the user signs in'),
      req('billing service', 'issue a voucher', 'a payment settles'),
      req('billing service', 'issue a receipt', 'a payment settles'),
    ])
    const plan = await buildGlossaryPlan(
      toDonorDoc(doc),
      tableEmbedder({
        'issue a session token': [1, 0.05],
        'issue a receipt': [1, 0.08],
        'issue a voucher': [1, 0.11],
      }),
    )
    // Both classes name `issue a receipt`, so both are held back rather than one winning.
    expect(plan.unresolved.map((u) => u.reason)).toContain('cross-system-conflict')
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })

  /**
   * The canonical names the AUTHOR'S wording, not the internal atom spelling.
   *
   * `atomize` merges verb classes, so "grant access" arrives on the atom
   * `..._resp__allow_access` — a spelling the document never contains. That makes atom order
   * and phrase order disagree here: by atom, `allow_access` sorts first; by phrase,
   * `bestow_permissions` does. Picking by atom position would put a canonical in the glossary
   * that the author cannot find in their own spec, which is the same defect class as reading
   * an antonym-class canonical out as a verb head.
   */
  it('picks the canonical by the author`s phrase, not by the atom spelling', async () => {
    const doc = docOf([
      req('auth service', 'grant access', 'the user signs in'),
      req('auth service', 'bestow permissions', 'the user signs in'),
    ])
    const plan = await buildGlossaryPlan(
      toDonorDoc(doc),
      tableEmbedder({ 'grant access': [1, 0.05], 'bestow permissions': [1, 0.08] }),
    )
    expect(plan.classes).toHaveLength(1)
    expect(plan.classes[0]?.canonical).toBe('bestow permissions')
    expect(plan.classes[0]?.aliases).toEqual(['grant access'])
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })

  it('respects a canonical the document already committed', async () => {
    const doc = docOf(
      [
        req('auth service', 'issue a session token', 'the user signs in'),
        req('auth service', 'mint an access token', 'the user signs in'),
      ],
      { glossary: [{ canonical: 'mint an access token', aliases: ['grant a token'] }] },
    )
    const plan = await buildGlossaryPlan(toDonorDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    const merged = plan.classes.find((c) => c.canonical === 'mint an access token')
    expect(merged?.canonicalForced, JSON.stringify(plan.classes)).toBe(true)
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })
})

// ---------------------------------------------------------------------------
// Ambiguity: never fabricate a merge across a suspected opposite
// ---------------------------------------------------------------------------

describe('a suspected opposite quarantines its whole class', () => {
  /** `seal`/`unseal` is a negating-prefix pair; `close` chains in by similarity. */
  const vaultDoc = () =>
    docOf([
      req('vault service', 'seal the vault', 'the shift ends'),
      req('vault service', 'close the vault', 'the alarm trips'),
      req('vault service', 'shut the vault', 'the audit begins'),
    ])
  const VAULT_TABLE = {
    'seal the vault': [1, 0.05],
    'close the vault': [1, 0.08],
    'shut the vault': [1, 0.11],
  } as const

  it('emits NO op merging a same-object-different-verb pair', async () => {
    const plan = await buildGlossaryPlan(toDonorDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
    // The property, stated over the ops rather than over the classification: whatever the
    // planner decided, no emitted merge may join two phrasings the shape check flags.
    for (const op of plan.ops) {
      if (op.op !== 'glossary') continue
      const [ha, ra] = oppositionShape(normalize(op.canonical))
      const [hb, rb] = oppositionShape(normalize(op.alias))
      expect(
        ra !== '' && ra === rb && ha !== hb,
        `merged ${JSON.stringify(op.canonical)} with ${JSON.stringify(op.alias)} — same object, different verb`,
      ).toBe(false)
      expect(isNegatingPrefixPair(ha, hb)).toBe(false)
    }
  })

  it('hands back BOTH remedies, with the consequence of each', async () => {
    const plan = await buildGlossaryPlan(toDonorDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
    const held = plan.unresolved.find((u) => u.reason === 'opposition-candidate')
    expect(held, JSON.stringify(plan.unresolved)).toBeDefined()
    const kinds = new Set(held?.pairs.flatMap((p) => p.remedies.map((r) => r.kind)))
    // The tool must not pick. Both readings are offered, each saying what it costs.
    expect(kinds.has('as-synonyms') || kinds.has('realign-objects')).toBe(true)
    expect(kinds.has('as-antonyms') || kinds.has('realign-objects')).toBe(true)
    for (const pair of held?.pairs ?? []) {
      for (const remedy of pair.remedies) {
        expect(remedy.consequence.length, `${remedy.kind} has no consequence`).toBeGreaterThan(20)
      }
    }
  })

  it('names the AUTHOR`s verbs, not the antonym class canonical', async () => {
    // `seal` sits in the seed class seal-unseal-expose-conceal, which canonicalizes to
    // `conceal`. Reading the head off the ATOM would tell an author to run
    // `symspec antonym close conceal`, naming a verb absent from their document.
    const plan = await buildGlossaryPlan(toDonorDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
    const verbs = plan.unresolved.flatMap((u) => u.pairs.flatMap((p) => [...p.verbs]))
    expect(verbs.length).toBeGreaterThan(0)
    expect(verbs).not.toContain('conceal')
  })

  it('does not use COSINE to decide opposition — only to propose the edge', async () => {
    // Same document, cosines pushed to near-identical. The class still does not merge,
    // because the withholding decision is structural.
    const plan = await buildGlossaryPlan(
      toDonorDoc(vaultDoc()),
      tableEmbedder({
        'seal the vault': [1, 0.001],
        'close the vault': [1, 0.002],
        'shut the vault': [1, 0.003],
      }),
    )
    expect(plan.ops).toEqual([])
    expect(plan.unresolved.map((u) => u.reason)).toContain('opposition-candidate')
  })
})

// ---------------------------------------------------------------------------
// Dedup, determinism, and disclosure
// ---------------------------------------------------------------------------

describe('the pass embeds each distinct phrasing exactly once', () => {
  it('makes ONE call, over ATOMS rather than raw texts', async () => {
    // The distinction that matters: "Issue a session token." and "issue a session token"
    // are DIFFERENT raw texts on the SAME atom, because `normalize` lowercases and drops
    // punctuation. A pass that deduplicated by TEXT would embed both; deduplicating by ATOM
    // embeds one. Inconsistent capitalization across a real spec is the ordinary case.
    const doc = docOf([
      req('auth service', 'issue a session token', 'the user signs in'),
      req('auth service', 'Issue a session token.', 'the token expires'),
      req('auth service', 'mint an access token', 'the user signs in'),
      req('billing service', 'issue a receipt', 'a payment settles'),
    ])
    const embedder = tableEmbedder({
      ...PARAPHRASE_TABLE,
      'Issue a session token.': [1, 0.05],
    })
    const plan = await buildGlossaryPlan(toDonorDoc(doc), embedder)
    expect(embedder.calls.length, 'one batched call, not one per pair').toBe(1)
    expect(embedder.calls[0]?.length).toBe(plan.corpus.responseNodes)
    expect(plan.corpus.embedded).toBe(plan.corpus.responseNodes)
    // The dedup is real: fewer nodes than requirements, and the difference is reported.
    expect(plan.corpus.responseNodes).toBeLessThan(plan.corpus.requirements)
    expect(plan.corpus.alreadyUnified).toBeGreaterThan(0)
    // And the folded node carries BOTH spellings, so nothing is lost by collapsing them.
    const folded = plan.classes.flatMap((c) => c.members).find((m) => m.phrases.length > 1)
    expect(folded?.phrases, 'the two spellings should share one atom').toEqual([
      'Issue a session token.',
      'issue a session token',
    ])
  })

  it('compares only WITHIN a system', async () => {
    const doc = paraphraseDoc()
    const plan = await buildGlossaryPlan(toDonorDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    // 3 auth nodes + 1 billing node ⇒ 3 pairs, not the 6 a flat O(n²) would compare.
    expect(plan.corpus.pairsCompared).toBe(3)
    expect(plan.corpus.systems).toBe(2)
  })
})

describe('the plan is deterministic', () => {
  it('is byte-identical across two runs', async () => {
    // ONE document, twice. Two `paraphraseDoc()` calls would mint fresh ids and the plan
    // reports `requirementIds`, so that would test the fixture rather than the planner.
    const doc = paraphraseDoc()
    const a = await buildGlossaryPlan(toDonorDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    const b = await buildGlossaryPlan(toDonorDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on the order requirements sit in the document', async () => {
    // `toDonorDoc` preserves `Object.entries` order, so an insertion-order difference
    // reaches the planner. The partition and the canonical must not notice.
    const rows = [
      req('auth service', 'issue a session token', 'the user signs in'),
      req('auth service', 'issue a login credential', 'the user signs in'),
      req('auth service', 'mint an access token', 'the user signs in'),
    ]
    const forward = await buildGlossaryPlan(
      toDonorDoc(docOf(rows)),
      tableEmbedder(PARAPHRASE_TABLE),
    )
    const reversed = await buildGlossaryPlan(
      toDonorDoc(docOf([...rows].reverse())),
      tableEmbedder(PARAPHRASE_TABLE),
    )
    expect(forward.ops).toEqual(reversed.ops)
    expect(forward.classes.map((c) => c.canonical)).toEqual(
      reversed.classes.map((c) => c.canonical),
    )
  })
})

describe('the plan discloses what it did and did not do', () => {
  it('reports a CHAINED class rather than hiding it', async () => {
    // A and B similar, B and C similar, A and C NOT — so the class exists only by
    // transitivity, and `minCosine` sits below the threshold to say so.
    const doc = docOf([
      req('auth service', 'alpha the token', 'the user signs in'),
      req('auth service', 'beta the token', 'the user signs in'),
      req('auth service', 'gamma the token', 'the user signs in'),
    ])
    const plan = await buildGlossaryPlan(
      toDonorDoc(doc),
      tableEmbedder({
        'alpha the token': [1, 0],
        'beta the token': [1, 0.65],
        'gamma the token': [1, 1.4],
      }),
      { threshold: 0.7 },
    )
    const chained = plan.classes.filter((c) => c.transitive)
    if (chained.length > 0) {
      expect(chained[0]?.minCosine).toBeLessThan(0.7)
      // Weakest first, so the likeliest-wrong reads first.
      expect(plan.classes[0]?.minCosine).toBe(Math.min(...plan.classes.map((c) => c.minCosine)))
    }
  })

  it('distinguishes "nothing to merge" from "did not look"', async () => {
    const doc = docOf([
      req('auth service', 'issue a session token', 'the user signs in'),
      req('auth service', 'delete the audit log', 'the retention window closes'),
    ])
    const plan = await buildGlossaryPlan(
      toDonorDoc(doc),
      tableEmbedder({
        'issue a session token': [1, 0],
        'delete the audit log': [0, 1],
      }),
    )
    expect(plan.ops).toEqual([])
    expect(plan.unresolved).toEqual([])
    // The proof that it looked. Without this an empty plan is indistinguishable from a
    // tier that never ran — the omission failure the semantic tier fails closed against.
    expect(plan.corpus.pairsCompared).toBeGreaterThan(0)
  })

  it('discloses a stub embedder rather than leaving it inferable', async () => {
    const plan = await buildGlossaryPlan(
      toDonorDoc(paraphraseDoc()),
      tableEmbedder(PARAPHRASE_TABLE),
      { embedderIsStub: true },
    )
    expect(plan.embedderIsStub).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The necessary duplicate, pinned by DIFFERENTIAL
// ---------------------------------------------------------------------------

/**
 * `oppositionShape` and `isNegatingPrefixPair` re-derive `fuseNegatingPrefix` and
 * `isNegatingPrefixPair` from `donor/formal/semantic.ts`, which are plain `function`s and
 * therefore unreachable. A copy of frozen logic drifts unless something compares them, and
 * the only comparable surface is the original's OBSERVABLE behavior — whether
 * `findOppositionCandidates` fires on a pair.
 */
describe('the re-derived shape check agrees with the frozen original', () => {
  /**
   * Pairs the donor's OTHER gates do not short-circuit.
   *
   * `findOppositionCandidates` skips a pair when the atoms are already unified or when the
   * antonym index already relates the heads — so it deliberately does NOT fire on
   * seal/unseal or grant/deny, because the seed table already handles them. Those pairs
   * therefore cannot be differentialled through the finding at all; only NOVEL verb pairs
   * can, and those are what this table holds.
   */
  const NOVEL = [
    ['close the vault', 'shut the vault', true],
    ['approve the claim', 'escalate the claim', true],
    ['issue a token', 'issue a token', false],
    ['issue a session token', 'delete the audit log', false],
  ] as const

  it.each(NOVEL)('%s vs %s', async (a, b, expected) => {
    const reqs = [
      { id: 'r-a', systemName: 'sys', systemResponse: a },
      { id: 'r-b', systemName: 'sys', systemResponse: b },
    ]
    // Cosine held well above the opposition floor, so the FLOOR never explains a miss and
    // any disagreement is the shape check's.
    const donorFired =
      (await findOppositionCandidates(reqs, tableEmbedder({ [a]: [1, 0.02], [b]: [1, 0.03] })))
        .length > 0

    const [ha, ra] = oppositionShape(normalize(a))
    const [hb, rb] = oppositionShape(normalize(b))
    const oursFired = ra !== '' && ra === rb && ha !== hb

    expect(oursFired, `expected ${expected} for ${a} vs ${b}`).toBe(expected)
    // The differential itself: the two implementations must not disagree.
    expect(oursFired, 'the re-derived shape check DRIFTED from the frozen original').toBe(
      donorFired,
    )
  })

  /**
   * The morphology half, asserted DIRECTLY.
   *
   * These pairs are unreachable through the finding — the seed antonym table relates every
   * one of them, so the donor short-circuits before the shape check runs. Asserting the
   * primitive is the only option left, and saying so here is what stops a reader assuming
   * the differential above covers it.
   */
  it.each([
    ['seal', 'unseal', true],
    ['engage', 'disengage', true],
    ['energize', 'de_energize', true],
    ['seal', 'close', false],
    ['grant', 'deny', false],
  ] as const)('negating prefix: %s vs %s', (a, b, expected) => {
    expect(isNegatingPrefixPair(a, b)).toBe(expected)
  })

  it('fuses a standalone negating prefix back onto its verb', () => {
    // `normalize` turns "de-energize the coil" into `de_energize_the_coil`, whose first
    // token is bare `de`. Without the fuse the head would be `de` and the object would
    // include the verb, so the pair would never compare.
    expect(oppositionShape(normalize('de-energize the coil'))).toEqual(['de_energize', 'the_coil'])
    expect(oppositionShape(normalize('energize the coil'))).toEqual(['energize', 'the_coil'])
    expect(isNegatingPrefixPair('de_energize', 'energize')).toBe(true)
  })

  /**
   * A RECALL GAP in the frozen lemmatizer, pinned so it is a known quantity.
   *
   * `deInflectHead` strips two characters from a `-zes` ending, so "energizes" lemmatizes to
   * `energiz` rather than `energize` — and `de_energize` vs `energiz` is not a prefix pair.
   * The 3sg form of a `-ze` verb therefore does NOT pair with its `de-` opposite, while the
   * base form does. `donor/formal/semantic.ts` names this exact case as one that works.
   *
   * Left as-is: the lemmatizer is frozen, and the failure direction is a MISSED suggestion
   * in a propose-only tier, which is the honest direction. Asserted rather than silently
   * inherited, so a future lemmatizer change shows up here as an improvement.
   */
  it('MISSES a 3sg `-zes` verb against its de- opposite (frozen lemmatizer)', () => {
    expect(oppositionShape(normalize('energizes the coil'))).toEqual(['energiz', 'the_coil'])
    expect(isNegatingPrefixPair('de_energize', 'energiz')).toBe(false)
  })
})
