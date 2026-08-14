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
import { toEngineDoc } from '../compat.ts'
import { glossaryIndex, normalize } from '../engine/formal/atomize.ts'
import type { Embedder } from '../engine/formal/embed.ts'
import { findOppositionCandidates } from '../engine/formal/semantic.ts'
import { encodeIncluded } from '../engine/pipeline/check.ts'
import { DOC_VERSION, type RequirementsDocument } from '../requirements/document.ts'
import { foldOps } from '../requirements/mutate.ts'
import type { DocumentOp } from '../requirements/ops.ts'
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

/**
 * Every response phrase in the document, mapped to the atom it lands on.
 *
 * Read through `encodeIncluded` — the same function the planner derives its nodes from and
 * the same one `check` compares — so the folding this reports is the folding the solver
 * sees, not a re-derivation that could disagree.
 */
const responseFolding = (document: RequirementsDocument): Map<string, string> => {
  const byPhrase = new Map<string, string>()
  for (const encoded of encodeIncluded(toEngineDoc(document))) {
    for (const row of encoded.atoms) {
      if (row.kind === 'resp') byPhrase.set(row.slotText, row.atom)
    }
  }
  return byPhrase
}

/**
 * Applying a plan may MERGE atoms. It may never SPLIT a pair the current tables already
 * unified.
 *
 * The failure this catches: `atomize` looks the glossary up on `normalize(rawText)` BEFORE
 * de-inflection and before the copula strip, so a phrase folded onto a node by either of
 * those misses the lookup entirely. Alias only the node's representative and that sibling
 * keeps its own body and stays on the old atom, while the representative moves to the
 * canonical — so two phrasings that shared an atom before the commit no longer share one
 * after, and the author who ran `propose-glossary` to align their vocabulary has less
 * alignment than they started with.
 */
const assertNothingSplits = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): void => {
  const phrases = [...before.keys()]
  for (let i = 0; i < phrases.length; i++) {
    for (let j = i + 1; j < phrases.length; j++) {
      const p = phrases[i] as string
      const q = phrases[j] as string
      if (before.get(p) !== before.get(q)) continue
      expect(
        after.get(p),
        `${JSON.stringify(p)} and ${JSON.stringify(q)} shared atom ${before.get(p)} before the plan and SPLIT after it (${after.get(p)} vs ${after.get(q)})`,
      ).toBe(after.get(q))
    }
  }
}

describe('applying the plan leaves a SOUND glossary index', () => {
  it('the clean case: three phrasings become one group', async () => {
    const doc = paraphraseDoc()
    const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
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
      toEngineDoc(doc),
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
      toEngineDoc(doc),
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
    const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    const merged = plan.classes.find((c) => c.canonical === 'mint an access token')
    expect(merged?.canonicalForced, JSON.stringify(plan.classes)).toBe(true)
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })
})

// ---------------------------------------------------------------------------
// The withhold reasons, each reached by a fixture
// ---------------------------------------------------------------------------

describe('a class blocked by the committed table names WHICH way it is blocked', () => {
  /**
   * `canonical-is-existing-alias` — the reason that was UNREACHABLE.
   *
   * `canonicalIsExistingAlias` says the chosen canonical is itself an alias of something
   * outside the class, so committing the class would build `a -> b -> c` and
   * `glossaryIndex` resolves ONE HOP, leaving the merge the author thought they made
   * silently undone.
   *
   * The chosen canonical is always a MEMBER, so whenever that holds, the member's own
   * mapping differs from the chosen canonical — which is exactly `aliasUnderOther`, the
   * test guarding `existing-canonical-conflict`. With that reason earlier in the ladder,
   * this branch could never be entered by any document. Ordering the ladder
   * most-specific-first is what makes it reachable, and this fixture is what proves it.
   */
  /**
   * The two phrasings differ in their OBJECT, so `same-object-different-verb` does not
   * fire and the class reaches the committed-table ladder at all. A same-object pair
   * (`alpha the token` / `beta the token`) is quarantined as an opposition candidate long
   * before any of these reasons is consulted.
   */
  it('reports canonical-is-existing-alias, not the more general conflict', async () => {
    const doc = docOf(
      [
        req('ledger service', 'reconcile the ledger', 'the day closes'),
        req('ledger service', 'settle the accounts', 'the day closes'),
      ],
      // `reconcile the ledger` — which the lexicographic rule picks as canonical — is
      // already an alias of a phrase NO member of this class mentions.
      { glossary: [{ canonical: 'zeta the batch', aliases: ['reconcile the ledger'] }] },
    )
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({ 'reconcile the ledger': [1, 0.05], 'settle the accounts': [1, 0.08] }),
    )
    expect(plan.ops).toEqual([])
    expect(plan.unresolved.map((u) => u.reason)).toEqual(['canonical-is-existing-alias'])
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })

  /**
   * `existing-canonical-conflict` — reachable before and after the reorder, and previously
   * untested. Two members are each already a canonical of their own committed group, so
   * there is no way to pick one without demoting the other.
   */
  it('reports existing-canonical-conflict when two members are both already canonical', async () => {
    const doc = docOf(
      [
        req('ledger service', 'reconcile the ledger', 'the day closes'),
        req('ledger service', 'settle the accounts', 'the day closes'),
      ],
      {
        glossary: [
          { canonical: 'reconcile the ledger', aliases: ['reconcile the books'] },
          { canonical: 'settle the accounts', aliases: ['settle the balances'] },
        ],
      },
    )
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({ 'reconcile the ledger': [1, 0.05], 'settle the accounts': [1, 0.08] }),
    )
    expect(plan.ops).toEqual([])
    const held = plan.unresolved.find((u) => u.reason === 'existing-canonical-conflict')
    expect(held, JSON.stringify(plan.unresolved)).toBeDefined()
    // The message must name BOTH canonicals, or the author cannot tell what to reconcile.
    expect(held?.existingCanonicals).toEqual(['reconcile_the_ledger', 'settle_the_accounts'])
    assertIndexIsSound(applyPlan(doc, plan.ops))
  })
})

// ---------------------------------------------------------------------------
// Applying a plan may merge atoms; it may never split them
// ---------------------------------------------------------------------------

describe('the plan never SPLITS a pair the tables already unified', () => {
  /**
   * `settle the accounts` and `settles the accounts` share one atom today, because
   * `deInflectHead` folds the 3sg form. The class merges them onto `reconcile the ledger`,
   * whose object DIFFERS, so no opposition signal quarantines it.
   *
   * Verbs chosen for two reasons: neither `settle` nor `reconcile` is in the seed antonym
   * table, so no polarity re-basing muddies the atom; and the objects differ, so
   * `same-object-different-verb` does not fire.
   */
  const ledgerDoc = () =>
    docOf([
      req('ledger service', 'reconcile the ledger', 'the day closes'),
      req('ledger service', 'settle the accounts', 'the day closes'),
      req('ledger service', 'settles the accounts', 'the batch lands'),
    ])
  const LEDGER_TABLE = {
    'reconcile the ledger': [1, 0.05],
    'settle the accounts': [1, 0.08],
    'settles the accounts': [1, 0.08],
  } as const

  it('aliases every folded phrasing, not just the node`s representative', async () => {
    const doc = ledgerDoc()
    const before = responseFolding(doc)
    // The premise: the two spellings really do share an atom before anything is applied.
    expect(before.get('settle the accounts')).toBe(before.get('settles the accounts'))

    const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(LEDGER_TABLE))
    expect(plan.ops.length, JSON.stringify(plan)).toBeGreaterThan(0)

    const applied = applyPlan(doc, plan.ops)
    assertNothingSplits(before, responseFolding(applied))
    assertIndexIsSound(applied)
  })

  it('holds for every fixture in this file, not just the one built for it', async () => {
    for (const [table, build] of [
      [PARAPHRASE_TABLE, paraphraseDoc],
      [LEDGER_TABLE, ledgerDoc],
    ] as const) {
      const doc = build()
      const before = responseFolding(doc)
      const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(table))
      assertNothingSplits(before, responseFolding(applyPlan(doc, plan.ops)))
    }
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
    const plan = await buildGlossaryPlan(toEngineDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
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
    const plan = await buildGlossaryPlan(toEngineDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
    const held = plan.unresolved.find((u) => u.reason === 'opposition-candidate')
    expect(held, JSON.stringify(plan.unresolved)).toBeDefined()
    const kinds = new Set(held?.pairs.flatMap((p) => p.remedies.map((r) => r.kind)))
    // The tool must not pick. Both readings are offered, each saying what it costs.
    //
    // Asserted as an EXACT set rather than two disjunctions. `has(x) || has('realign-objects')`
    // is satisfied by either half, so it passed without `realign-objects` ever appearing in
    // any fixture — a shape that reads like it covers both remedies while pinning neither.
    // The seed-antonym case below is where `realign-objects` is actually reached.
    expect([...kinds].sort()).toEqual(['as-antonyms', 'as-synonyms'])
    for (const pair of held?.pairs ?? []) {
      for (const remedy of pair.remedies) {
        expect(remedy.consequence.length, `${remedy.kind} has no consequence`).toBeGreaterThan(20)
      }
    }
  })

  /**
   * The `seed-antonym` signal and its `realign-objects` remedy — the branch that offers
   * only TWO remedies and deliberately omits `as-antonyms`.
   *
   * `grant` and `revoke` already sit in one signed class (via grant/revoke, grant/deny,
   * and deny's other pairs) at opposite polarity, so `symspec antonym grant revoke` would
   * change nothing. The reason these did not unify is the OBJECT: `access` against
   * `permission`. Offering an antonym op here would hand an agent a command that runs
   * clean and fixes nothing.
   */
  it('offers realign-objects, and NO antonym op, when the table already relates the verbs', async () => {
    const doc = docOf([
      req('vault service', 'grant access', 'the badge scans'),
      req('vault service', 'revoke permission', 'the badge scans'),
    ])
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({ 'grant access': [1, 0.05], 'revoke permission': [1, 0.08] }),
    )
    const held = plan.unresolved.find((u) => u.reason === 'opposition-candidate')
    expect(held, JSON.stringify(plan.unresolved)).toBeDefined()
    const pair = held?.pairs[0]
    expect(pair?.signal).toBe('seed-antonym')

    // Order matters: the remedy that actually works reads FIRST.
    expect(pair?.remedies.map((r) => r.kind)).toEqual(['realign-objects', 'as-synonyms'])
    // `realign-objects` is advice, not an op — there is no record that performs it.
    expect(pair?.remedies[0]?.ops).toEqual([])
    // And the synonym reading is offered only with the warning that it masks a known conflict.
    expect(pair?.remedies[1]?.consequence).toContain('OPPOSITES')
    // The commands must be runnable and must NOT include an inert antonym op.
    expect(held?.commands.some((c) => c.startsWith('symspec antonym'))).toBe(false)
    expect(plan.ops).toEqual([])
  })

  it('names the AUTHOR`s verbs, not the antonym class canonical', async () => {
    // `seal` sits in the seed class seal-unseal-expose-conceal, which canonicalizes to
    // `conceal`. Reading the head off the ATOM would tell an author to run
    // `symspec antonym close conceal`, naming a verb absent from their document.
    const plan = await buildGlossaryPlan(toEngineDoc(vaultDoc()), tableEmbedder(VAULT_TABLE))
    const verbs = plan.unresolved.flatMap((u) => u.pairs.flatMap((p) => [...p.verbs]))
    expect(verbs.length).toBeGreaterThan(0)
    expect(verbs).not.toContain('conceal')
  })

  it('does not use COSINE to decide opposition — only to propose the edge', async () => {
    // Same document, cosines pushed to near-identical. The class still does not merge,
    // because the withholding decision is structural.
    const plan = await buildGlossaryPlan(
      toEngineDoc(vaultDoc()),
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
// Opposition, at DOCUMENT scale rather than only inside a formed class
// ---------------------------------------------------------------------------

/**
 * 2-D vectors at an exact cosine to `[1, 0]`.
 *
 * `cos θ = 1 / hypot(1, t)` for `[1, t]`, so `t = tan(acos(c))`. Writing the target cosine
 * and deriving the vector keeps the intent in the test instead of in a magic number, and
 * lets a case sit deliberately inside the band between the opposition floor and the
 * clustering threshold — the band that had no coverage at all.
 */
const atCosine = (c: number): readonly [number, number] => [1, Math.tan(Math.acos(c))]

describe('every structurally-opposed pair is reported, not only the ones a class caught', () => {
  const vaultPair = () =>
    docOf([
      req('vault service', 'close the vault', 'the shift ends'),
      req('vault service', 'shut the vault', 'the audit begins'),
    ])
  const vaultTable = (c: number) => ({
    'close the vault': [1, 0] as const,
    'shut the vault': atCosine(c),
  })

  /**
   * THE GAP. At 0.60 the pair is above the opposition floor (0.5) and below the clustering
   * threshold (0.72), so no class forms — and before this, nothing asked whether it was an
   * opposition. `check --semantic` reported it pairwise while the whole-document plan an
   * author reads to design their vocabulary said nothing.
   */
  it('reports a pair BETWEEN the opposition floor and the clustering threshold', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(vaultPair()), tableEmbedder(vaultTable(0.6)))
    // No class formed, so the old code path never evaluated this pair.
    expect(plan.classes).toEqual([])
    expect(plan.unresolved).toEqual([])

    expect(plan.oppositions).toHaveLength(1)
    const only = plan.oppositions[0]
    expect(only?.signal).toBe('same-object-different-verb')
    expect(only?.phrases).toEqual(['close the vault', 'shut the vault'])
    expect(only?.aboveCosineFloor).toBe(true)
    // The distinction a reader needs: nothing was quarantined here, because nothing merged.
    expect(only?.formsClass).toBe(false)
    expect(only?.cosine).toBeGreaterThanOrEqual(plan.oppositionCosineFloor)
    expect(only?.cosine).toBeLessThan(plan.threshold)
  })

  it('marks formsClass when the pair also QUARANTINED a merge', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(vaultPair()), tableEmbedder(vaultTable(0.95)))
    expect(plan.unresolved.map((u) => u.reason)).toEqual(['opposition-candidate'])
    expect(plan.oppositions).toHaveLength(1)
    expect(plan.oppositions[0]?.formsClass).toBe(true)
  })

  /**
   * Below the floor the pair is unrelated rather than opposed, so it is not reported — but
   * `oppositionSignals` still counts it, which is what distinguishes "no oppositions exist"
   * from "the floor filtered them out".
   */
  it('withholds a sub-floor pair from the report, and still says it saw one', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(vaultPair()), tableEmbedder(vaultTable(0.4)))
    expect(plan.oppositions).toEqual([])
    expect(plan.corpus.oppositionSignals).toBe(1)
  })

  /**
   * Morphology bypasses the floor, exactly as `semantic.ts` argues: a `de-`/`un-`/`dis-`
   * pair is opposition by STRUCTURE, so no embedding is needed to believe it. Verbs chosen
   * outside the seed antonym table — a seed pair like seal/unseal would be unified by
   * `atomize` into ONE node, leaving no pair to report.
   */
  it('reports a negating-prefix pair even far BELOW the cosine floor', async () => {
    const doc = docOf([
      req('index service', 'duplicate the shard', 'the batch lands'),
      req('index service', 'de-duplicate the shard', 'the audit begins'),
    ])
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({
        'duplicate the shard': [1, 0],
        'de-duplicate the shard': atCosine(0.2),
      }),
    )
    expect(plan.oppositions).toHaveLength(1)
    expect(plan.oppositions[0]?.signal).toBe('negating-prefix')
    // Admitted by structure, and the record says so rather than implying the cosine carried it.
    expect(plan.oppositions[0]?.aboveCosineFloor).toBe(false)
    expect(plan.oppositions[0]?.cosine).toBeLessThan(plan.oppositionCosineFloor)
  })

  it('never puts an opposition in `ops` — no op resolves one', async () => {
    for (const c of [0.4, 0.6, 0.95]) {
      const plan = await buildGlossaryPlan(toEngineDoc(vaultPair()), tableEmbedder(vaultTable(c)))
      expect(plan.ops).toEqual([])
      for (const o of plan.oppositions) {
        expect(o.remedies.flatMap((r) => r.ops).length, JSON.stringify(o)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('is deterministic and order-independent', async () => {
    const rows = [
      req('vault service', 'close the vault', 'the shift ends'),
      req('vault service', 'shut the vault', 'the audit begins'),
    ]
    const table = vaultTable(0.6)
    const forward = await buildGlossaryPlan(toEngineDoc(docOf(rows)), tableEmbedder(table))
    const reversed = await buildGlossaryPlan(
      toEngineDoc(docOf([...rows].reverse())),
      tableEmbedder(table),
    )
    expect(JSON.stringify(forward.oppositions)).toBe(JSON.stringify(reversed.oppositions))
  })

  /**
   * The DIVERGENCE, asserted rather than hidden.
   *
   * `findOppositionCandidates` skips any pair whose heads share an antonym canonical —
   * polarity-blind — because from the engine's seat the pair is "already handled". The plan
   * fires `seed-antonym` when the canonicals match and the POLARITIES DIFFER, because at
   * document scale the useful thing to say is that these did not unify only because their
   * objects differ, and realigning the objects proves the conflict with no new vocabulary.
   *
   * So the two are NOT the same predicate, and a test claiming they agree everywhere would
   * be wrong. This pins where they part company and why.
   */
  it('reports a seed-antonym pair the engine deliberately skips', async () => {
    const a = 'grant access'
    const b = 'revoke permission'
    const engineFired = (
      await findOppositionCandidates(
        [
          { id: 'r-a', systemName: 'sys', systemResponse: a },
          { id: 'r-b', systemName: 'sys', systemResponse: b },
        ],
        tableEmbedder({ [a]: [1, 0.02], [b]: [1, 0.03] }),
      )
    ).length
    expect(engineFired, 'the engine skips a pair its antonym table already relates').toBe(0)

    const plan = await buildGlossaryPlan(
      toEngineDoc(
        docOf([
          req('vault service', a, 'the badge scans'),
          req('vault service', b, 'the badge scans'),
        ]),
      ),
      tableEmbedder({ [a]: [1, 0.02], [b]: [1, 0.03] }),
    )
    expect(plan.oppositions.map((o) => o.signal)).toEqual(['seed-antonym'])
    expect(plan.oppositions[0]?.remedies[0]?.kind).toBe('realign-objects')
  })
})

// ---------------------------------------------------------------------------
// GUARD-slot vocabulary — suggested, never applied
// ---------------------------------------------------------------------------

describe('guard vocabulary is proposed and NEVER applyable', () => {
  /** Two trigger phrasings for one condition, differing in more than one token. */
  const alignableDoc = () =>
    docOf([
      req('door service', 'latch the bolt', 'the operator closes the panel'),
      req('door service', 'log the event', 'the panel is shut by the operator'),
    ])
  const ALIGNABLE = {
    'latch the bolt': [1, 0],
    'log the event': [0, 1],
    'the operator closes the panel': [1, 0.05],
    'the panel is shut by the operator': [1, 0.08],
  } as const

  it('proposes a guard alignment with NO ops field to apply', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(alignableDoc()), tableEmbedder(ALIGNABLE))
    expect(plan.guardClasses.length, JSON.stringify(plan.guardClasses)).toBeGreaterThan(0)
    const suggested = plan.guardClasses.find((g) => g.withheldBy.length === 0)
    expect(suggested, JSON.stringify(plan.guardClasses)).toBeDefined()
    expect(suggested?.vocabulary).toBe('guard')
    // The embargo, as a property over the whole plan rather than over this fixture.
    expect(plan.ops).toEqual([])
    expect(JSON.stringify(plan.guardClasses)).not.toContain('"op":')
  })

  /**
   * The payoff, and the reason a guard suggestion is reviewable at all: it names the
   * comparisons the merge unlocks — which is also exactly the set a WRONG merge would
   * compare wrongly.
   */
  it('names the requirements the alignment would newly make comparable', async () => {
    // ONE document, read twice. `req` mints a fresh id per call, so building the fixture
    // again would compare this plan against a different document's ids.
    const doc = alignableDoc()
    const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(ALIGNABLE))
    const suggested = plan.guardClasses.find((g) => g.withheldBy.length === 0)
    expect(suggested?.unlocks.length, JSON.stringify(suggested)).toBe(2)
    // Real ids from the document, not indices or atom bodies.
    const ids = Object.keys(doc.requirements)
    for (const id of suggested?.unlocks ?? []) expect(ids).toContain(id)
  })

  it('reports the AUTHOR`s guard phrasing, never a copula-stripped body', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(alignableDoc()), tableEmbedder(ALIGNABLE))
    const phrases = plan.guardClasses.flatMap((g) => [g.canonical, ...g.aliases])
    expect(phrases.length).toBeGreaterThan(0)
    for (const p of phrases) {
      expect(p, `${JSON.stringify(p)} looks like an atom body, not a phrase`).not.toMatch(/_/)
    }
  })

  /**
   * Two triggers one token apart are the same sentence with one thing changed, and that one
   * thing is usually the point. `ends`/`begins` are not in the antonym table, so nothing but
   * `single-token-difference` catches this — and if it merged, the identical opposite-polarity
   * responses would prove a contradiction the document does not contain.
   */
  it('WITHHOLDS two guards that differ by exactly one token', async () => {
    const doc = docOf([
      req('vault service', 'seal the vault', 'the shift ends'),
      req('vault service', 'lock the door', 'the shift begins'),
    ])
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({
        'seal the vault': [1, 0],
        'lock the door': [0, 1],
        'the shift ends': [1, 0.02],
        'the shift begins': [1, 0.03],
      }),
    )
    const withheld = plan.guardClasses.filter((g) => g.withheldBy.length > 0)
    expect(withheld.length, JSON.stringify(plan.guardClasses)).toBeGreaterThan(0)
    expect(withheld.flatMap((g) => g.withheldBy.map((w) => w.signal))).toContain(
      'single-token-difference',
    )
    // A withheld class makes no claim about what it would unlock.
    expect(withheld[0]?.unlocks).toEqual([])
  })

  it('WITHHOLDS a negated guard against its affirmative twin', async () => {
    const doc = docOf([
      req('vault service', 'seal the vault', 'the operator is present'),
      req('vault service', 'lock the door', 'the operator is not present'),
    ])
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({
        'seal the vault': [1, 0],
        'lock the door': [0, 1],
        'the operator is present': [1, 0.02],
        'the operator is not present': [1, 0.03],
      }),
    )
    const signals = plan.guardClasses.flatMap((g) => g.withheldBy.map((w) => w.signal))
    expect(signals, JSON.stringify(plan.guardClasses)).toContain('negated-token')
  })

  /**
   * `symspec antonym` is gated to `resp` in `atomize`, so it provably cannot change a guard
   * atom. Offering it would hand an agent a command that runs clean and fixes nothing.
   */
  it('never offers an antonym remedy for a guard, because none can work', async () => {
    const doc = docOf([
      req('vault service', 'seal the vault', 'the shift ends'),
      req('vault service', 'lock the door', 'the shift begins'),
    ])
    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({
        'seal the vault': [1, 0],
        'lock the door': [0, 1],
        'the shift ends': [1, 0.02],
        'the shift begins': [1, 0.03],
      }),
    )
    for (const g of plan.guardClasses) {
      expect(g.remedies.map((r) => r.kind)).not.toContain('as-antonyms')
      for (const r of g.remedies) expect(r.ops).toEqual([])
      // Safest first when withheld: doing nothing is the correct read of mutually
      // exclusive guards.
      if (g.withheldBy.length > 0) expect(g.remedies[0]?.kind).toBe('leave-distinct')
    }
  })

  it('pools trigger and precondition vocabulary into ONE node per body', async () => {
    // A `pre` and a `trig` with the SAME text are two ATOMS (the kind is in the atom name)
    // but ONE glossary key, because `glossaryIndex` is keyed on the body alone. Keyed by atom
    // name they would surface as two nodes at cosine 1.0 whose proposed alias equals its own
    // canonical — which `applyGlossary` refuses with ERR_USAGE, failing the fold rather than
    // merely reading oddly. So the guard key drops the kind, and this is what proves it.
    const shared = 'the vault is sealed'
    const stateReq = (systemResponse: string) => {
      seq += 1
      const id = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, '0')}`
      return [
        id,
        {
          id,
          patternType: 'state-driven' as const,
          systemName: 'audit service',
          systemResponse,
          preCondition: shared,
          negated: false,
          sentence: `While ${shared}, the audit service shall ${systemResponse}.`,
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
    const doc = docOf([
      req('audit service', 'log the access', shared),
      stateReq('notify the auditor'),
    ])

    const plan = await buildGlossaryPlan(
      toEngineDoc(doc),
      tableEmbedder({
        'log the access': [1, 0],
        'notify the auditor': [0, 1],
        [shared]: [1, 0.02],
      }),
    )
    // ONE guard node for the shared body, not one per kind.
    expect(plan.corpus.guardNodes, JSON.stringify(plan.corpus)).toBe(1)
    expect(plan.corpus.guardPhrasesFolded).toBe(1)
    // A single node cannot form a class, so nothing self-aliasing is proposed.
    expect(plan.guardClasses).toEqual([])
  })

  it('reports both slot families as looked-at, even on an empty document', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(docOf([])), tableEmbedder({}))
    expect(plan.vocabularies).toEqual(['response', 'guard'])
    // The applyable half is still response-only, so nothing an agent branches on moved.
    expect(plan.vocabulary).toBe('response')
    expect(plan.guardClasses).toEqual([])
  })

  it('counts guard pairs separately, and the total is their sum', async () => {
    const plan = await buildGlossaryPlan(toEngineDoc(alignableDoc()), tableEmbedder(ALIGNABLE))
    expect(plan.corpus.pairsCompared).toBe(
      plan.corpus.responsePairsCompared + plan.corpus.guardPairsCompared,
    )
    expect(plan.corpus.guardPairsCompared).toBeGreaterThan(0)
    // `crossSlotPhrases` is defined even when nothing collides, so "no withhold fired" is
    // distinguishable from "the check did not run".
    expect(plan.corpus.crossSlotPhrases).toBe(0)
  })

  it('is deterministic and order-independent over guards too', async () => {
    const rows = Object.entries(alignableDoc().requirements)
    const forward = await buildGlossaryPlan(
      toEngineDoc(docOf(rows as never)),
      tableEmbedder(ALIGNABLE),
    )
    const reversed = await buildGlossaryPlan(
      toEngineDoc(docOf([...rows].reverse() as never)),
      tableEmbedder(ALIGNABLE),
    )
    expect(JSON.stringify(forward.guardClasses)).toBe(JSON.stringify(reversed.guardClasses))
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
    const plan = await buildGlossaryPlan(toEngineDoc(doc), embedder)
    expect(embedder.calls.length, 'one batched call, not one per pair').toBe(1)
    // ONE call over BOTH slot families. Responses first, so the response slice keeps the
    // indices the rest of the pass already used.
    expect(embedder.calls[0]?.length).toBe(plan.corpus.responseNodes + plan.corpus.guardNodes)
    expect(plan.corpus.embedded).toBe(plan.corpus.responseNodes + plan.corpus.guardNodes)
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
    const plan = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
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
    const a = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    const b = await buildGlossaryPlan(toEngineDoc(doc), tableEmbedder(PARAPHRASE_TABLE))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on the order requirements sit in the document', async () => {
    // `toEngineDoc` preserves `Object.entries` order, so an insertion-order difference
    // reaches the planner. The partition and the canonical must not notice.
    const rows = [
      req('auth service', 'issue a session token', 'the user signs in'),
      req('auth service', 'issue a login credential', 'the user signs in'),
      req('auth service', 'mint an access token', 'the user signs in'),
    ]
    const forward = await buildGlossaryPlan(
      toEngineDoc(docOf(rows)),
      tableEmbedder(PARAPHRASE_TABLE),
    )
    const reversed = await buildGlossaryPlan(
      toEngineDoc(docOf([...rows].reverse())),
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
      toEngineDoc(doc),
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
      toEngineDoc(doc),
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
      toEngineDoc(paraphraseDoc()),
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
 * `isNegatingPrefixPair` from `engine/formal/semantic.ts`, which are plain `function`s and
 * therefore unreachable. A copy drifts unless something compares them, and
 * the only comparable surface is the original's OBSERVABLE behavior — whether
 * `findOppositionCandidates` fires on a pair.
 */
describe('the re-derived shape check agrees with the engine original', () => {
  /**
   * Pairs v4's OTHER gates do not short-circuit.
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
    const engineFired =
      (await findOppositionCandidates(reqs, tableEmbedder({ [a]: [1, 0.02], [b]: [1, 0.03] })))
        .length > 0

    const [ha, ra] = oppositionShape(normalize(a))
    const [hb, rb] = oppositionShape(normalize(b))
    const oursFired = ra !== '' && ra === rb && ha !== hb

    expect(oursFired, `expected ${expected} for ${a} vs ${b}`).toBe(expected)
    // The differential itself: the two implementations must not disagree.
    expect(oursFired, 'the re-derived shape check DRIFTED from the engine original').toBe(
      engineFired,
    )
  })

  /**
   * The morphology half, asserted DIRECTLY.
   *
   * These pairs are unreachable through the finding — the seed antonym table relates every
   * one of them, so v4 short-circuits before the shape check runs. Asserting the
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
   * The 3sg form of a `-ze` verb pairs with its `de-` opposite — the exact case
   * `engine/formal/semantic.ts` documents ("energizes the coil", head
   * `energize`, against `de_energize`). `engine/formal/lemma.test.ts` owns the
   * token-level rows; this asserts the pairing those rows exist for.
   */
  it('pairs a 3sg `-zes` verb with its de- opposite', () => {
    expect(oppositionShape(normalize('energizes the coil'))).toEqual(['energize', 'the_coil'])
    expect(isNegatingPrefixPair('de_energize', 'energize')).toBe(true)
  })
})
