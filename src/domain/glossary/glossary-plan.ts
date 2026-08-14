/**
 * WHOLE-DOCUMENT GLOSSARY PLANNING — the vocabulary designed once, not pair by pair.
 *
 * ## The gap this closes
 *
 * Vocabulary alignment is the highest-leverage authoring habit symspec has, and every
 * suggestion it offers is PAIRWISE: `FND_SIMILAR_SEMANTIC` fires once per requirement
 * pair, `FND_OPPOSITION_CANDIDATE` once per pair, each carrying one inline `glossary`
 * command. An agent therefore discovers its own vocabulary one pair at a time and never
 * sees the shape of the whole thing — so it commits N independent decisions that may not
 * cohere, and a phrase reachable from two directions gets proposed twice under different
 * canonicals.
 *
 * This module answers the question once: given a document, which response phrasings name
 * one thing? The answer is an equivalence PARTITION, which is the object the glossary
 * actually is, rather than a list of pairs that happen to overlap.
 *
 * ## Nodes are ATOMS, not requirements
 *
 * The input is {@link encodeIncluded}, the vendored tier's own export — the waiver-aware
 * gate plus `makeAtomize(glossaryIndex(...), docAntonymIndex(...))`, so every phrase the
 * COMMITTED tables already unify arrives collapsed onto one atom. Three consequences,
 * all wanted:
 *
 * 1. Nothing already unified is re-proposed.
 * 2. Dedup is stronger than deduplicating raw text — atoms fold articles, punctuation,
 *    inflection, the glossary, and the antonym classes.
 * 3. The atom set cannot drift from what `check` compares, because it is computed by the
 *    function `check` computes it with.
 *
 * ## Cosine never decides
 *
 * `engine/formal/semantic.ts` is explicit that cosine CANNOT distinguish antonymy from
 * synonymy, because antonyms embed CLOSE. So similarity only ever proposes an edge; every
 * decision to WITHHOLD an edge is made by a deterministic signal (the committed antonym
 * table, negating-prefix morphology, or the same-object-different-verb shape). A class
 * with one ambiguous pair is quarantined whole, and the reason is transitivity: `a ≈ b`
 * plus `b ⊥ c` puts all three in one class, and emitting `glossary(a, c)` would convert a
 * PROVABLE contradiction into a proven-consistent claim. That is worse than a miss,
 * because the tool caused it.
 *
 * ## What this module never does
 *
 * It does not write, and it does not pick. `buildGlossaryPlan` is pure given its
 * `Embedder`, returns candidate ops for review, and hands every ambiguous class back as
 * an explicit choice with the consequence of each remedy spelled out.
 */

import type { Doc } from '../engine/core/doc.ts'
import { listRequirements } from '../engine/core/doc.ts'
import {
  ANTONYM_INDEX,
  type AntonymEntry,
  buildAntonymIndexWithDoc,
} from '../engine/formal/antonyms.ts'
import { glossaryIndex, normalize } from '../engine/formal/atomize.ts'
import type { Embedder } from '../engine/formal/embed.ts'
import { deInflectHead } from '../engine/formal/lemma.ts'
import {
  DEFAULT_OPPOSITION_COSINE_FLOOR,
  DEFAULT_SEMANTIC_THRESHOLD,
} from '../engine/formal/semantic.ts'
import { encodeIncluded } from '../engine/pipeline/check.ts'
import type { DocumentOp } from '../requirements/ops.ts'

// ---------------------------------------------------------------------------
// The opposition shape — a duplicate of engine privates, differential-guarded
// ---------------------------------------------------------------------------

/**
 * Split a normalized body into a de-inflected head and rest, fusing a standalone
 * negating-prefix token back onto the verb it modifies.
 *
 * A re-derivation of `fuseNegatingPrefix` in `engine/formal/semantic.ts`, which is a plain
 * `function` and therefore unreachable from outside that module. A duplicate drifts
 * unless something compares them, so `glossary-plan.test.ts` pins this against the
 * ORIGINAL'S OBSERVABLE BEHAVIOR — whether `findOppositionCandidates` fires — rather
 * than against a comment claiming the two agree.
 *
 * `normalize` turns "de-energize the coil" into `de_energize_the_coil`, whose first token
 * is just `de`; reassembling the head as `de_energize` is what lets it compare against
 * "energizes the coil" (head `energize`) as a prefix pair.
 */
export const oppositionShape = (body: string): readonly [string, string] => {
  const tokens = body.split('_')
  const first = tokens[0] ?? ''
  if ((first === 'de' || first === 'un' || first === 'dis') && tokens.length >= 2) {
    return [`${first}_${deInflectHead(tokens[1] as string)}`, tokens.slice(2).join('_')]
  }
  const sep = body.indexOf('_')
  if (sep === -1) return [deInflectHead(body), '']
  return [deInflectHead(body.slice(0, sep)), body.slice(sep + 1)]
}

/**
 * True when two de-inflected heads relate by a negating prefix — `de-`/`un-`/`dis-`.
 *
 * The other re-derived private (`isNegatingPrefixPair`). Purely structural, so it holds
 * regardless of what the embedder says: seal/unseal, engage/disengage, energize/deenergize.
 */
export const isNegatingPrefixPair = (a: string, b: string): boolean => {
  const plain = (s: string) => s.replace(/_/g, '')
  const pa = plain(a)
  const pb = plain(b)
  return ['de', 'un', 'dis'].some((p) => pa === p + pb || pb === p + pa)
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * Which slot kind the plan reads.
 *
 * A literal rather than a boolean so widening it later is an ADDITIVE, detectable change.
 * Only `response` today, and deliberately: `glossaryIndex` is consulted for every atom
 * kind, so an entry proposed from TRIGGER vocabulary would silently merge responses too —
 * and merging trigger phrasings changes context grouping, i.e. which pairs the
 * contradiction tier compares at all. No existing propose tier takes that step.
 */
export type GlossaryVocabulary = 'response'

/** Which deterministic signal says a pair might be opposites rather than synonyms. */
export type OppositionSignal =
  /** Both heads sit in the committed antonym table at OPPOSITE polarity. */
  | 'seed-antonym'
  /** One head is the other with a `de-`/`un-`/`dis-` prefix. */
  | 'negating-prefix'
  /** Same object remainder, different verb — genuinely undecidable without a human. */
  | 'same-object-different-verb'

/** Why a class was withheld from `ops`. */
export type UnresolvedReason =
  | 'opposition-candidate'
  | 'existing-canonical-conflict'
  | 'cross-system-conflict'
  | 'canonical-is-existing-alias'

/** What picking a remedy does to the document. */
export type RemedyKind = 'as-synonyms' | 'as-antonyms' | 'realign-objects'

/** One way to resolve an ambiguous class, with its consequence stated. */
export interface Remedy {
  readonly kind: RemedyKind
  /** Applyable records, EMPTY when no op performs this remedy. */
  readonly ops: readonly DocumentOp[]
  /** Runnable verbatim. */
  readonly commands: readonly string[]
  /** What the next `check` proves if you pick this one. */
  readonly consequence: string
}

/** One distinct phrasing cluster member — an atom the document has TODAY. */
export interface GlossaryMember {
  /** The scoped atom name, e.g. `sys__auth_service__resp__allow_access`. */
  readonly atom: string
  /** The representative raw slot text (lexicographically smallest seen). */
  readonly phrase: string
  /** Every raw slot text already folded onto this atom. */
  readonly phrases: readonly string[]
  readonly requirementIds: readonly string[]
}

/** A pair within a class that might be opposites. */
export interface AmbiguousPair {
  readonly a: string
  readonly b: string
  readonly signal: OppositionSignal
  /** The two verb heads, exactly what `symspec antonym` takes as positionals. */
  readonly verbs: readonly [string, string]
  /** DISCLOSED for the reader. Never used to decide. */
  readonly cosine: number
  readonly remedies: readonly Remedy[]
}

/** A class the plan is confident about. */
export interface ProposedClass {
  readonly system: string
  readonly canonical: string
  readonly canonicalAtom: string
  /** True when the document already committed this canonical, so it was not a choice. */
  readonly canonicalForced: boolean
  /** Every other member — swapping any one in changes only the label. */
  readonly alternativeCanonicals: readonly string[]
  readonly aliases: readonly string[]
  readonly members: readonly GlossaryMember[]
  readonly ops: readonly DocumentOp[]
  /** The WEAKEST internal pair. Below the threshold means the class formed by chaining. */
  readonly minCosine: number
  readonly weakestPair: readonly [string, string]
  readonly transitive: boolean
}

/**
 * One structurally-opposed pair, reported at DOCUMENT scale.
 *
 * ## The gap this closes
 *
 * `signalFor` used to run only on pairs INSIDE a cosine-formed class, so a pair had to
 * clear the clustering threshold before anything asked whether it was an opposition. A
 * structurally-opposed pair sitting between the opposition floor and that threshold
 * therefore never appeared in the plan at all — only as a pairwise
 * `FND_OPPOSITION_CANDIDATE` during `check --semantic`. An author reading the plan to design
 * their vocabulary in one pass was shown the merges and not the oppositions, which is the
 * half that manufactures rather than masks.
 *
 * The signal is now computed once during the pair sweep and read from there by both
 * consumers, so the class-level `pairs` and this section cannot disagree about what an
 * opposition is — they are one code path rather than two kept in step by a comment.
 *
 * ## Never in `ops`
 *
 * There is no op that resolves an opposition. `antonym` is the DECIDE half for the
 * response tier and is the one committed record whose wrong value manufactures a false
 * contradiction, so it is offered as a runnable command with both readings and never as an
 * applyable record.
 */
export interface OppositionPair {
  readonly system: string
  /** The AUTHOR's phrasings, sorted — never an atom body, never an index. */
  readonly phrases: readonly [string, string]
  readonly atoms: readonly [string, string]
  /** Every requirement on either side, so the reader can go look. */
  readonly requirementIds: readonly string[]
  readonly signal: OppositionSignal
  /** The two verb heads, exactly what `symspec antonym` takes as positionals. */
  readonly verbs: readonly [string, string]
  /** DISCLOSED. Cosine confirms topical relatedness; it never decides opposition. */
  readonly cosine: number
  /** False means morphology admitted this pair, not the cosine — a `de-`/`un-`/`dis-` pair. */
  readonly aboveCosineFloor: boolean
  /**
   * True when this pair also sits inside a cosine-formed class, i.e. it QUARANTINED a merge.
   *
   * The distinction a reader needs: `true` means the planner declined a merge it would
   * otherwise have proposed, `false` means this is a pair worth knowing about that no merge
   * threatened.
   */
  readonly formsClass: boolean
  readonly remedies: readonly Remedy[]
}

/** A class withheld from `ops`, with the choice that would unblock it. */
export interface UnresolvedClass {
  readonly reason: UnresolvedReason
  readonly system: string
  readonly members: readonly GlossaryMember[]
  /** Empty for the three non-opposition reasons. */
  readonly pairs: readonly AmbiguousPair[]
  readonly existingCanonicals: readonly string[]
  readonly message: string
  readonly commands: readonly string[]
}

/** What the pass looked at — so "found nothing" is distinguishable from "did not look". */
export interface GlossaryCorpus {
  /** Admitted by the waiver-aware gate. */
  readonly requirements: number
  readonly systems: number
  readonly responseNodes: number
  /** Must equal `responseNodes`, or the dedup is broken. */
  readonly embedded: number
  readonly pairsCompared: number
  /** Raw phrases the CURRENT tables already folded onto a shared atom. */
  readonly alreadyUnified: number
  /**
   * Pairs carrying a deterministic opposition signal, BEFORE the cosine floor.
   *
   * Reported alongside `oppositions.length` so a reader can tell "no oppositions exist" from
   * "the floor filtered them out" — the same distinction `pairsCompared` draws for merges.
   */
  readonly oppositionSignals: number
}

/** The whole plan. */
export interface GlossaryPlan {
  readonly vocabulary: GlossaryVocabulary
  readonly threshold: number
  /**
   * The topical-relatedness floor below which a non-morphological opposition is not
   * reported. A separate judgment from `threshold`, and imported rather than restated —
   * `engine/formal/semantic.ts` owns the measured band for both.
   */
  readonly oppositionCosineFloor: number
  readonly canonicalRule: 'lexicographic-smallest-normalized-body'
  /** A stub embedder makes every cosine meaningless. Disclosed, never inferred. */
  readonly embedderIsStub: boolean
  readonly corpus: GlossaryCorpus
  /** Sorted weakest-first, so the likeliest-wrong reads first. */
  readonly classes: readonly ProposedClass[]
  readonly unresolved: readonly UnresolvedClass[]
  /**
   * Every structurally-opposed pair in the document, whether or not a merge threatened it.
   * Never in `ops` — no op resolves an opposition.
   */
  readonly oppositions: readonly OppositionPair[]
  /** UNAMBIGUOUS classes only. Collision-free by construction. */
  readonly ops: readonly DocumentOp[]
}

export interface BuildGlossaryPlanOptions {
  readonly threshold?: number
  readonly embedderIsStub?: boolean
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

/**
 * Disjoint-set over sorted string keys.
 *
 * `engine/formal/graph.ts` has one, module-private, so it cannot be
 * imported. Fifteen lines is cheaper than any alternative.
 *
 * The root is always the smaller index, so the PARTITION does not depend on the order edges
 * arrive in. It says nothing about which member becomes canonical: that is decided by
 * {@link pickCanonical}, which sorts on the author's phrase and is the only thing that makes
 * the emitted plan independent of document order. Sorting nodes on collection is defensive
 * rather than load-bearing — removing it changes no output today, and a test that claimed
 * otherwise would be asserting a coincidence.
 */
const partition = (size: number, edges: readonly (readonly [number, number])[]): number[] => {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root] as number
    // Path-compress, so a long chain does not cost the same walk repeatedly.
    let walk = i
    while (parent[walk] !== root) {
      const next = parent[walk] as number
      parent[walk] = root
      walk = next
    }
    return root
  }
  for (const [a, b] of edges) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  return parent.map((_, i) => find(i))
}

// ---------------------------------------------------------------------------
// Node extraction
// ---------------------------------------------------------------------------

interface Node {
  readonly atom: string
  readonly system: string
  readonly phrase: string
  readonly phrases: readonly string[]
  readonly requirementIds: readonly string[]
  /**
   * `normalize(phrase)` — the AUTHOR'S wording, for the shape checks.
   *
   * Deliberately NOT the atom name's body. The atom body is post-canonicalization: an
   * antonym class is re-based on its lexicographically smallest member, so "seal the
   * vault" atomizes through the seed class `seal—unseal—expose—conceal` and arrives as
   * `conceal_the_vault`. Reading the head off the atom would tell an author to run
   * `symspec antonym close conceal` — naming a verb that appears nowhere in their
   * document. `findOppositionCandidates` reads the raw response for the same reason.
   */
  readonly body: string
}

/**
 * The antonym index this document's atoms were built with.
 *
 * Mirrors `docAntonymIndex` in `engine/pipeline/check.ts:560` exactly: both heads
 * normalized, and an odd polarity cycle SWALLOWED rather than thrown. The swallow matters
 * here for the same reason it does there — a read-only pass must not crash on a document
 * whose committed antonyms are inconsistent, and the seed index is the honest fallback
 * because it is what `atomize` would have used.
 */
const antonymIndexOf = (doc: Doc): ReadonlyMap<string, AntonymEntry> => {
  const pairs = doc.antonyms ?? []
  if (pairs.length === 0) return ANTONYM_INDEX
  try {
    return buildAntonymIndexWithDoc(pairs.map((p) => [normalize(p.a), normalize(p.b)] as const))
  } catch {
    return ANTONYM_INDEX
  }
}

/**
 * Collapse the document's response atoms into nodes.
 *
 * One node per distinct atom, carrying every raw phrase that landed on it — so
 * `alreadyUnified` can report how much the committed tables are already doing, which is
 * the number that tells a reader whether the glossary is working.
 */
const nodesOf = (doc: Doc): { readonly nodes: Node[]; readonly alreadyUnified: number } => {
  const systemById = new Map(listRequirements(doc).map((r) => [r.id, normalize(r.systemName)]))
  const byAtom = new Map<
    string,
    { system: string; phrases: Set<string>; requirementIds: Set<string> }
  >()
  let rawPhrases = 0
  for (const encoded of encodeIncluded(doc)) {
    for (const row of encoded.atoms) {
      if (row.kind !== 'resp') continue
      rawPhrases += 1
      const existing = byAtom.get(row.atom)
      const entry = existing ?? {
        system: systemById.get(encoded.id) ?? '',
        phrases: new Set<string>(),
        requirementIds: new Set<string>(),
      }
      entry.phrases.add(row.slotText)
      entry.requirementIds.add(encoded.id)
      if (existing === undefined) byAtom.set(row.atom, entry)
    }
  }
  const nodes = [...byAtom.entries()]
    .map(([atom, entry]) => {
      const phrases = [...entry.phrases].sort()
      const phrase = phrases[0] ?? ''
      return {
        atom,
        system: entry.system,
        phrase,
        phrases,
        requirementIds: [...entry.requirementIds].sort(),
        body: normalize(phrase),
      }
    })
    .sort((a, b) => a.atom.localeCompare(b.atom))
  return { nodes, alreadyUnified: rawPhrases - nodes.length }
}

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

/** The deterministic opposition signal for a pair, or `undefined` when there is none. */
const signalFor = (
  a: Node,
  b: Node,
  antonyms: ReadonlyMap<string, AntonymEntry>,
): { readonly signal: OppositionSignal; readonly verbs: readonly [string, string] } | undefined => {
  const [headA, restA] = oppositionShape(a.body)
  const [headB, restB] = oppositionShape(b.body)
  const verbs = [headA, headB] as const

  // The committed table already relates these verbs at OPPOSITE polarity. Fires only
  // when the remainders DIFFER: if they matched, `atomize` would have unified the pair
  // onto one atom name already and there would be no pair to test.
  const entryA = antonyms.get(headA)
  const entryB = antonyms.get(headB)
  if (
    entryA !== undefined &&
    entryB !== undefined &&
    entryA.canonical === entryB.canonical &&
    entryA.negated !== entryB.negated
  ) {
    return { signal: 'seed-antonym', verbs }
  }
  if (headA !== headB && isNegatingPrefixPair(headA, headB)) {
    return { signal: 'negating-prefix', verbs }
  }
  if (restA !== '' && restA === restB && headA !== headB) {
    return { signal: 'same-object-different-verb', verbs }
  }
  return undefined
}

const quoted = (s: string) => `"${s}"`

/** The remedies for one ambiguous pair, in the order worth trying them. */
const remediesFor = (
  a: Node,
  b: Node,
  signal: OppositionSignal,
  verbs: readonly [string, string],
): readonly Remedy[] => {
  const asSynonyms: Remedy = {
    kind: 'as-synonyms',
    ops: [{ op: 'glossary', canonical: a.phrase, alias: b.phrase }],
    commands: [`symspec glossary ${quoted(a.phrase)} ${quoted(b.phrase)}`],
    consequence:
      'Both phrasings collapse onto one atom, so a contradiction between them becomes ' +
      'unprovable — correct if they mean the same thing, and MASKING if they are opposites.',
  }
  const asAntonyms: Remedy = {
    kind: 'as-antonyms',
    ops: [{ op: 'antonym', a: verbs[0], b: verbs[1] }],
    commands: [`symspec antonym ${verbs[0]} ${verbs[1]}`],
    consequence:
      'The verbs collapse to one atom at OPPOSITE polarity, so a conflict between them ' +
      'becomes provable rather than invisible.',
  }

  // `seed-antonym` is the case where offering both would be wrong. The table ALREADY
  // relates these verbs, so an `antonym` op changes nothing — the reason they did not
  // unify is the object remainder. Realigning the objects is the fix that works.
  if (signal === 'seed-antonym') {
    return [
      {
        kind: 'realign-objects',
        ops: [],
        commands: [
          `symspec show ${a.requirementIds[0] ?? '<id>'}`,
          `symspec show ${b.requirementIds[0] ?? '<id>'}`,
        ],
        consequence:
          `The antonym table already relates "${verbs[0]}" and "${verbs[1]}" at opposite ` +
          'polarity; these did not unify because their objects differ. Reword one response ' +
          'so both name the same object, and the committed table proves the conflict with ' +
          'no new vocabulary at all.',
      },
      {
        ...asSynonyms,
        consequence: `${asSynonyms.consequence} Here the committed antonym table says these verbs are OPPOSITES, so this remedy would mask a conflict it already knows about.`,
      },
    ]
  }
  return signal === 'negating-prefix' ? [asAntonyms, asSynonyms] : [asSynonyms, asAntonyms]
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Build the whole-document glossary plan.
 *
 * Pure given `embedder`. Never writes, never picks: `ops` carries only classes with zero
 * ambiguous pairs and zero collisions, and everything else is an `unresolved` entry
 * naming the choice and its consequence.
 */
export const buildGlossaryPlan = async (
  doc: Doc,
  embedder: Embedder,
  options: BuildGlossaryPlanOptions = {},
): Promise<GlossaryPlan> => {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD
  const { nodes, alreadyUnified } = nodesOf(doc)
  const antonyms = antonymIndexOf(doc)
  const committed = glossaryIndex(doc.glossary ?? [])
  const canonicalSet = new Set((doc.glossary ?? []).map((g) => normalize(g.canonical)))

  // ONE batched call, over distinct atoms rather than requirements. The existing pairwise
  // tiers embed every requirement's response — including cross-system ones they then skip
  // — and do not dedup despite a comment saying they do.
  const vectors = nodes.length > 0 ? await embedder(nodes.map((n) => n.phrase)) : []
  const { cosine } = await import('../engine/formal/embed.ts')

  // Per system: atoms are system-scoped, so two systems using identical wording are
  // genuinely distinct and comparing across them is meaningless.
  const bySystem = new Map<string, number[]>()
  for (const [i, node] of nodes.entries()) {
    const bucket = bySystem.get(node.system)
    if (bucket === undefined) bySystem.set(node.system, [i])
    else bucket.push(i)
  }

  const edges: [number, number][] = []
  const cosines = new Map<string, number>()
  const key = (i: number, j: number) => `${Math.min(i, j)}|${Math.max(i, j)}`
  /**
   * The opposition signal per compared pair, computed HERE rather than inside the per-class
   * loop.
   *
   * Both consumers read this one map: the class-level quarantine, and the document-scale
   * `oppositions` section. Computing it in the class loop alone is what made a
   * sub-threshold opposition invisible to the plan, and computing it twice would be two
   * implementations of "what counts as an opposition" kept in step by a comment.
   */
  const signals = new Map<
    string,
    { readonly signal: OppositionSignal; readonly verbs: readonly [string, string] }
  >()
  let pairsCompared = 0
  for (const bucket of [...bySystem.values()]) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x] as number
        const j = bucket[y] as number
        pairsCompared += 1
        const vi = vectors[i]
        const vj = vectors[j]
        const score = vi !== undefined && vj !== undefined ? cosine(vi, vj) : 0
        cosines.set(key(i, j), score)
        const hit = signalFor(nodes[i] as Node, nodes[j] as Node, antonyms)
        if (hit !== undefined) signals.set(key(i, j), hit)
        if (score >= threshold) edges.push([i, j])
      }
    }
  }

  const roots = partition(nodes.length, edges)
  const groups = new Map<number, number[]>()
  for (const [i, root] of roots.entries()) {
    const bucket = groups.get(root)
    if (bucket === undefined) groups.set(root, [i])
    else bucket.push(i)
  }

  // ---- Classify each multi-member group -----------------------------------
  interface Candidate {
    readonly system: string
    readonly members: Node[]
    readonly indices: number[]
    readonly pairs: AmbiguousPair[]
    readonly existingCanonicals: string[]
    readonly canonicalIsExistingAlias: boolean
  }
  const candidates: Candidate[] = []
  /** Pair keys that sit inside a multi-member class, so `formsClass` is a fact not a guess. */
  const classPairKeys = new Set<string>()
  for (const indices of [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number))) {
    if (indices.length < 2) continue
    const members = indices.map((i) => nodes[i] as Node)
    const pairs: AmbiguousPair[] = []
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const i = indices[x] as number
        const j = indices[y] as number
        const a = nodes[i] as Node
        const b = nodes[j] as Node
        // Read the memoized signal. Deliberately NOT gated on the opposition cosine floor:
        // a class formed by chaining can hold an internal pair whose own cosine is far below
        // it, and that pair still quarantines. The floor is a REPORTING gate for the
        // document-scale section, never a condition on withholding a merge.
        const hit = signals.get(key(i, j))
        if (hit === undefined) continue
        classPairKeys.add(key(i, j))
        pairs.push({
          a: a.atom,
          b: b.atom,
          signal: hit.signal,
          verbs: hit.verbs,
          cosine: Number((cosines.get(key(i, j)) ?? 0).toFixed(3)),
          remedies: remediesFor(a, b, hit.signal, hit.verbs),
        })
      }
    }
    // Every canonical the document already commits for a member of this class.
    const existing = new Set<string>()
    for (const m of members) {
      const mapped = committed.get(normalize(m.phrase))
      if (mapped !== undefined) existing.add(mapped)
      if (canonicalSet.has(normalize(m.phrase))) existing.add(normalize(m.phrase))
    }
    const chosen = pickCanonical(members, existing, committed)
    candidates.push({
      system: members[0]?.system ?? '',
      members,
      indices,
      pairs,
      existingCanonicals: [...existing].sort(),
      // `glossaryIndex` resolves ONE HOP, so a canonical that is itself an alias would
      // leave the chain silently unresolved.
      canonicalIsExistingAlias:
        committed.get(normalize(chosen.canonical)) !== undefined &&
        committed.get(normalize(chosen.canonical)) !== normalize(chosen.canonical),
    })
  }

  // ---- Global reconciliation: count first, so there is no first-wins pick --
  //
  // The glossary table is DOCUMENT-WIDE while every class above was proven under ONE
  // system, and that gap is where collisions come from. Counting how many CLASSES claim a
  // phrase — not how many distinct canonicals they chose — is the test that catches it.
  //
  // The distinct-canonical test misses the worst case. Two per-system classes that happen
  // to pick the SAME canonical apply cleanly: `applyGlossary` finds the group and pushes,
  // leaving an index that is injective and one-hop closed. It is still wrong — the two
  // classes' aliases are now transitively merged ACROSS systems, on evidence that only
  // ever compared within one. Soundness of the resulting table is not the property that
  // matters here; provenance of the merge is.
  //
  // Counted over every FOLDED phrase, not each node's representative, because every folded
  // phrase becomes an alias key (see `aliasesFor`). Counting representatives alone would
  // leave a collision on a non-representative spelling invisible to this pass and then let
  // `applyGlossary` fork the group by table order — the exact defect the reconciliation
  // exists to catch, reachable through the phrasing the author happened not to write first.
  const claimingClasses = new Map<string, number>()
  for (const c of candidates) {
    // A node may fold two spellings onto one normalized key; that is ONE claim by this
    // class, not two, so dedupe within the class before counting across classes.
    const claimed = new Set<string>()
    for (const m of c.members) for (const phrase of m.phrases) claimed.add(normalize(phrase))
    for (const phrase of claimed) {
      claimingClasses.set(phrase, (claimingClasses.get(phrase) ?? 0) + 1)
    }
  }

  const classes: ProposedClass[] = []
  const unresolved: UnresolvedClass[] = []
  for (const c of candidates) {
    const chosen = pickCanonical(c.members, new Set(c.existingCanonicals), committed)
    const aliases = aliasesFor(c.members, chosen.canonical)
    // Contested on ANY folded phrase, matching what `claimingClasses` counted.
    const contested = c.members.some((m) =>
      m.phrases.some((p) => (claimingClasses.get(normalize(p)) ?? 0) > 1),
    )
    const aliasUnderOther = c.members.some((m) => {
      const mapped = committed.get(normalize(m.phrase))
      return mapped !== undefined && mapped !== normalize(chosen.canonical)
    })

    // MOST-SPECIFIC FIRST, and the order is load-bearing rather than cosmetic.
    //
    // `canonicalIsExistingAlias` is a strictly narrower condition than `aliasUnderOther`:
    // the chosen canonical is always a MEMBER, so if it maps to something other than
    // itself then that member maps to something other than the chosen canonical, which is
    // `aliasUnderOther` by definition. Testing the general condition first therefore made
    // the specific one unreachable for EVERY document — a dead branch no fixture could
    // enter, which is why it had no test. The narrower reason carries the actionable
    // detail (one-hop resolution would silently drop the merge), so it must be asked first.
    const reason: UnresolvedReason | undefined =
      c.pairs.length > 0
        ? 'opposition-candidate'
        : c.canonicalIsExistingAlias
          ? 'canonical-is-existing-alias'
          : c.existingCanonicals.length > 1 || aliasUnderOther
            ? 'existing-canonical-conflict'
            : contested
              ? 'cross-system-conflict'
              : undefined

    if (reason !== undefined) {
      unresolved.push({
        reason,
        system: c.system,
        members: c.members.map(asMember),
        pairs: c.pairs,
        existingCanonicals: c.existingCanonicals,
        message: messageFor(reason, c.members, c.pairs, c.existingCanonicals),
        commands: [...new Set(c.pairs.flatMap((p) => p.remedies.flatMap((r) => r.commands)))],
      })
      continue
    }

    const internal = pairwiseCosines(c.indices, nodes, cosines, key)
    const ops: DocumentOp[] = aliases.map((alias) => ({
      op: 'glossary',
      canonical: chosen.canonical,
      alias,
    }))
    classes.push({
      system: c.system,
      canonical: chosen.canonical,
      canonicalAtom: chosen.atom,
      canonicalForced: chosen.forced,
      alternativeCanonicals: c.members
        .map((m) => m.phrase)
        .filter((p) => p !== chosen.canonical)
        .sort(),
      aliases,
      members: c.members.map(asMember),
      ops,
      minCosine: internal.min,
      weakestPair: internal.pair,
      transitive: internal.min < threshold,
    })
  }

  // ---- Document-scale oppositions -----------------------------------------
  //
  // Every signalled pair the sweep saw, gated exactly the way `findOppositionCandidates`
  // gates: a morphological pair is admitted regardless of cosine, everything else must clear
  // the topical floor. Cosine is disclosed on the record and decides nothing.
  const oppositions: OppositionPair[] = []
  for (const [pairKey, hit] of signals) {
    const [left, right] = pairKey.split('|')
    const i = Number(left)
    const j = Number(right)
    const a = nodes[i] as Node
    const b = nodes[j] as Node
    const score = cosines.get(pairKey) ?? 0
    const aboveCosineFloor = score >= DEFAULT_OPPOSITION_COSINE_FLOOR
    if (!aboveCosineFloor && !isNegatingPrefixPair(hit.verbs[0], hit.verbs[1])) continue
    const phrases: readonly [string, string] =
      a.phrase.localeCompare(b.phrase) <= 0 ? [a.phrase, b.phrase] : [b.phrase, a.phrase]
    oppositions.push({
      system: a.system,
      phrases,
      atoms: a.atom.localeCompare(b.atom) <= 0 ? [a.atom, b.atom] : [b.atom, a.atom],
      requirementIds: [...new Set([...a.requirementIds, ...b.requirementIds])].sort(),
      signal: hit.signal,
      verbs: hit.verbs,
      cosine: Number(score.toFixed(3)),
      aboveCosineFloor,
      formsClass: classPairKeys.has(pairKey),
      remedies: remediesFor(a, b, hit.signal, hit.verbs),
    })
  }

  classes.sort((a, b) => a.minCosine - b.minCosine || a.canonical.localeCompare(b.canonical))
  unresolved.sort((a, b) => a.reason.localeCompare(b.reason) || a.system.localeCompare(b.system))
  oppositions.sort(
    (a, b) =>
      a.system.localeCompare(b.system) ||
      a.phrases[0].localeCompare(b.phrases[0]) ||
      a.phrases[1].localeCompare(b.phrases[1]),
  )

  return {
    vocabulary: 'response',
    threshold,
    oppositionCosineFloor: DEFAULT_OPPOSITION_COSINE_FLOOR,
    canonicalRule: 'lexicographic-smallest-normalized-body',
    embedderIsStub: options.embedderIsStub ?? false,
    corpus: {
      requirements: encodeIncluded(doc).length,
      systems: bySystem.size,
      responseNodes: nodes.length,
      embedded: vectors.length,
      pairsCompared,
      alreadyUnified,
      oppositionSignals: signals.size,
    },
    classes,
    unresolved,
    oppositions,
    ops: classes.flatMap((c) => c.ops),
  }
}

/**
 * Which member becomes `canonical`.
 *
 * An existing committed canonical WINS — it is the only value that does not fork a group
 * the document already has. Otherwise the lexicographically smallest normalized body, the
 * same rule `engine/formal/antonyms.ts` uses to canonicalize a signed antonym class, so
 * there is one canonicalization rule to learn for both side tables.
 *
 * The choice is transparently arbitrary, and that is the honest property: applying a
 * `glossary` op never rewrites requirement text, so the PARTITION does all the work and
 * the canonical is only a label plus an atom-body spelling in evidence. It cannot change
 * a verdict, so any deterministic rule is sound — and a rule that looked like judgment
 * (most frequent, say) would imply the tool knows which phrasing is better. It does not.
 */
const pickCanonical = (
  members: readonly Node[],
  existing: ReadonlySet<string>,
  committed: ReadonlyMap<string, string>,
): { readonly canonical: string; readonly atom: string; readonly forced: boolean } => {
  const forced = members.find(
    (m) => existing.has(normalize(m.phrase)) && committed.get(normalize(m.phrase)) === undefined,
  )
  const chosen =
    forced ??
    [...members].sort(
      (a, b) =>
        normalize(a.phrase).localeCompare(normalize(b.phrase)) || a.phrase.localeCompare(b.phrase),
    )[0]
  return {
    canonical: chosen?.phrase ?? '',
    atom: chosen?.atom ?? '',
    forced: forced !== undefined,
  }
}

/**
 * Every phrasing that must be aliased for the class to actually collapse — one per
 * FOLDED PHRASE, not one per node.
 *
 * ## Why the node's representative is not enough
 *
 * `atomize` looks the glossary up on `normalize(rawText)` and does it FIRST, before
 * de-inflection and before the copula strip. A node carries every raw phrase that landed
 * on its atom, and de-inflection or a dropped copula is often what put them there — so a
 * sibling's normalized form is NOT the representative's, and it misses a lookup keyed on
 * the representative alone.
 *
 * Aliasing only the representative therefore SPLITS a group the tables already unified:
 * the representative is rewritten to the canonical while its sibling keeps its own body
 * and stays behind. An author who ran this pass to align their vocabulary would end with
 * less alignment than they started with, and the tool would have caused it. Aliasing every
 * folded phrase is the fix, and it is also strictly more robust — the fold is pinned by a
 * committed record instead of re-derived by morphology on every run.
 *
 * Deduplicated by NORMALIZED key, because that is the key `glossaryIndex` holds and
 * `applyGlossary` matches on: two raw spellings that normalize alike ("Issue a token." and
 * "issue a token") need one entry, and emitting both would be a no-op the fold reports as
 * a duplicate. The smallest raw spelling wins, the same tie-break `pickCanonical` uses, so
 * the choice is order-independent.
 */
const aliasesFor = (members: readonly Node[], canonical: string): string[] => {
  const canonicalKey = normalize(canonical)
  const byKey = new Map<string, string>()
  for (const m of members) {
    for (const phrase of m.phrases) {
      const key = normalize(phrase)
      // The canonical's own spelling is not an alias of itself; `applyGlossary` refuses it.
      if (key === canonicalKey) continue
      const seen = byKey.get(key)
      if (seen === undefined || phrase.localeCompare(seen) < 0) byKey.set(key, phrase)
    }
  }
  return [...byKey.values()].sort()
}

const asMember = (n: Node): GlossaryMember => ({
  atom: n.atom,
  phrase: n.phrase,
  phrases: n.phrases,
  requirementIds: n.requirementIds,
})

/**
 * The weakest internal pair — what says whether a class formed by chaining.
 *
 * Reports the two PHRASES rather than node indices. An index is meaningless to a reader and
 * it is also unstable: it depends on the order nodes were collected, so publishing one would
 * make the payload order-dependent even though the partition is not.
 */
const pairwiseCosines = (
  indices: readonly number[],
  nodes: readonly Node[],
  cosines: ReadonlyMap<string, number>,
  key: (i: number, j: number) => string,
): { readonly min: number; readonly pair: readonly [string, string] } => {
  let min = 1
  let pair: readonly [string, string] = ['', '']
  for (let x = 0; x < indices.length; x++) {
    for (let y = x + 1; y < indices.length; y++) {
      const i = indices[x] as number
      const j = indices[y] as number
      const score = cosines.get(key(i, j)) ?? 0
      if (score <= min) {
        min = score
        const a = (nodes[i] as Node).phrase
        const b = (nodes[j] as Node).phrase
        // Sorted, so the pair does not encode which node happened to be seen first.
        pair = a <= b ? [a, b] : [b, a]
      }
    }
  }
  return { min: Number(min.toFixed(3)), pair }
}

const messageFor = (
  reason: UnresolvedReason,
  members: readonly Node[],
  pairs: readonly AmbiguousPair[],
  existing: readonly string[],
): string => {
  const phrases = members.map((m) => quoted(m.phrase)).join(', ')
  switch (reason) {
    case 'opposition-candidate': {
      const signals = [...new Set(pairs.map((p) => p.signal))].sort().join(', ')
      return (
        `${phrases} cluster above the similarity threshold, but ${pairs.length} pair(s) look ` +
        `like polar OPPOSITES rather than paraphrases (${signals}). Merging them would make a ` +
        'provable conflict unprovable, so the whole class is withheld — one ambiguous pair ' +
        'quarantines it, because the class is transitive. Pick a remedy per pair and re-run.'
      )
    }
    case 'existing-canonical-conflict':
      return (
        `${phrases} cluster together, but the document already commits ${existing.length} ` +
        `canonical(s) for members of this class (${existing.map(quoted).join(', ')}). Merging ` +
        'would fork a committed group. Resolve the existing entries first with ' +
        '`symspec glossary --remove`, then re-run.'
      )
    case 'cross-system-conflict':
      return (
        `${phrases} cluster together, but at least one phrase is claimed by another proposed ` +
        'class under a different canonical. The glossary table is document-wide while this ' +
        'evidence is per-system, so committing both would leave one alias resolving by table ' +
        'order. Decide which reading is intended and commit that one by hand.'
      )
    case 'canonical-is-existing-alias':
      return (
        `${phrases} cluster together, but the canonical this class would use is itself already ` +
        'an alias of something else. Alias resolution is ONE HOP, so the chain would silently ' +
        'never resolve. Point the existing entry at a canonical outside this class, then re-run.'
      )
  }
}
