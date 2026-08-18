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
import { GUARD_KINDS, glossaryIndex, normalize, renderAtom } from '../engine/formal/atomize.ts'
import { contextAtomsOf, planContextGroups } from '../engine/formal/contradiction.ts'
import type { Embedder } from '../engine/formal/embed.ts'
import type { EncodedRequirement } from '../engine/formal/encode.ts'
import { ESTABLISH_VERBS } from '../engine/formal/guard-implication.ts'
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
 * Which slot family a class was proposed from.
 *
 * A literal rather than a boolean, so widening it is an ADDITIVE, detectable change — which
 * is what happened: `guard` joined `response`.
 *
 * ## Why guards were parked, and what actually unparked them
 *
 * The recorded reason was that `glossaryIndex` is consulted for every atom kind, so an entry
 * proposed from trigger vocabulary would silently merge responses too. That is true only on
 * EXACT normalized-text identity, and the glossary lookup runs before the copula strip: a
 * guard clause is a state or event clause (`the vault is sealed` → `vault_is_sealed`) while
 * a response is an action clause (`seal the vault` → `seal_the_vault`), so the two key
 * spaces barely intersect in well-formed EARS. The `cross-slot-collision` withhold closes
 * that hole anyway, because it is cheap and provably sound, but it is a DEFENSIVE guard
 * rather than a common case.
 *
 * The hazard that is real is the other one: merging two guard phrasings changes CONTEXT
 * GROUPING. `planContextGroups` keys a group on a requirement's sorted `trig`+`pre` atoms
 * and `findContradictions` asserts one group at a time, so two requirements whose guards are
 * paraphrases are never live together and their responses are never compared. Aligning the
 * guards is therefore the single highest-leverage thing an author can do — and committing
 * the alignment WRONGLY asserts two different conditions are one, which can prove a conflict
 * the document does not contain.
 *
 * That asymmetry is why a guard class is suggest-only: `GuardClass` carries no `ops` field at
 * all, so "an agent cannot apply this mechanically" is a type error rather than a review
 * comment.
 */
export type GlossaryVocabulary = 'response' | 'guard'

/** Which deterministic signal says a pair might be opposites rather than synonyms. */
export type OppositionSignal =
  /** Both heads sit in the committed antonym table at OPPOSITE polarity. */
  | 'seed-antonym'
  /** One head is the other with a `de-`/`un-`/`dis-` prefix. */
  | 'negating-prefix'
  /** Same object remainder, different verb — genuinely undecidable without a human. */
  | 'same-object-different-verb'

/**
 * Which deterministic signal says two GUARD phrasings may be different conditions.
 *
 * A separate vocabulary from {@link OppositionSignal}, because the response signals do not
 * transfer. `oppositionShape` splits a leading verb from an object, which is the right shape
 * for an action clause and the wrong one for a state clause: on `the user signs in` it yields
 * head `user`, so `same-object-different-verb` degenerates into "same tail, different
 * subject" — noise — while the real guard opposition (`the door is locked` against `the door
 * is unlocked`) lives in the predicate tail and is missed entirely.
 *
 * These are deliberately OVER-EAGER. In this direction over-eagerness only ever withholds a
 * suggestion, and the alternative is a merge that regroups contexts and can manufacture an
 * error-severity contradiction. So a guard merge is proposed only when the two phrasings
 * differ in MORE THAN ONE token — which is exactly the regime where cosine adds information
 * and where an opposition is unlikely to be expressible by a single word.
 */
export type GuardSignal =
  /** The token multisets differ by exactly one negator (`not`, `never`, `no`). */
  | 'negated-token'
  /** Some aligned token pair relates by a `de-`/`un-`/`dis-` prefix (locked/unlocked). */
  | 'negating-prefix-token'
  /** Some aligned token pair sits in the antonym table at OPPOSITE polarity. */
  | 'antonym-token'
  /** The bodies differ in exactly one token position — the guard analogue of same-object. */
  | 'single-token-difference'
  /**
   * A phrase in this class also occurs as a RESPONSE, and `glossaryIndex` is kind-blind, so
   * the entry would rewrite response atoms too.
   *
   * Defensive rather than common: it needs exact normalized-text identity between a state or
   * event clause and an action clause, and the glossary lookup runs before the copula strip,
   * so `the vault is sealed` (`vault_is_sealed`) and `seal the vault` (`seal_the_vault`) do
   * not collide. Kept because it is two set lookups and the failure it prevents is silent.
   */
  | 'cross-slot-collision'

/** Why a class was withheld from `ops`. */
export type UnresolvedReason =
  | 'opposition-candidate'
  | 'existing-canonical-conflict'
  | 'cross-system-conflict'
  | 'canonical-is-existing-alias'
  /**
   * A phrase in this class also occurs in the OTHER slot family, and `glossaryIndex` is
   * kind-blind — so committing the entry would rewrite atoms in that family too, changing
   * which requirements the contradiction tier compares. Defensive: it requires exact
   * normalized-text identity across an action clause and a state clause, which well-formed
   * EARS rarely produces.
   */
  | 'cross-slot-collision'

/** What picking a remedy does to the document. */
export type RemedyKind =
  | 'as-synonyms'
  | 'as-antonyms'
  | 'realign-objects'
  /** Reword one GUARD so both name the same condition. The fix that actually works. */
  | 'realign-guards'
  /** Do nothing. Correct for mutually exclusive guards, and the safe default. */
  | 'leave-distinct'

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

/** One reason a guard class must not be committed as written. */
export interface GuardWithhold {
  readonly signal: GuardSignal
  /** The AUTHOR's two guard phrasings, sorted. */
  readonly phrases: readonly [string, string]
  /**
   * The differing tokens, when they can be named from the author's own wording.
   *
   * Omitted rather than guessed: the guard shape body is copula-stripped, so a token could
   * in principle be reported that the author never wrote. Present only when the token occurs
   * verbatim in the representative phrase.
   */
  readonly tokens?: readonly [string, string]
  /** DISCLOSED. Never used to decide. */
  readonly cosine: number
}

/**
 * A GUARD-slot alignment — trigger and precondition vocabulary, proposed and never applied.
 *
 * ## No `ops` field, on purpose
 *
 * A wrong response merge MASKS a conflict, costing recall. A wrong guard merge asserts two
 * genuinely different conditions are one, puts two requirements into a single context group,
 * and can prove a contradiction the document does not contain — the tool's own fabrication,
 * at error severity, gating exit 1. That is the hazard class the antonym table sits in, and
 * the answer there is the same: emit a structural candidate with both readings and a runnable
 * command, never an applyable record. `--field data.opsJsonl > plan.jsonl | symspec apply` is
 * exactly a bare command, and `consequence` is a warning aimed at a reader who is not there.
 *
 * Leaving the field off entirely — rather than setting it to `[]` — is what makes the
 * embargo checkable by `tsc` instead of by review.
 *
 * ## The decide tier is LOOSER here, which forces the choice
 *
 * `applyGlossary` checks empty fields, self-alias, alias-already-owned, and the one-hop
 * chain. It has no slot awareness and no system awareness at all. So the propose tier holds
 * guards the decide tier does not re-validate, and under
 * `.erpaval/solutions/architecture/decide-tier-must-carry-every-guard-the-propose-tier-has.md`
 * it must not hand out a machine-applyable record whose safety rests on a document-scale
 * precondition nothing re-checks when the next requirement is added.
 */
export interface GuardClass {
  readonly vocabulary: 'guard'
  readonly system: string
  readonly canonical: string
  readonly aliases: readonly string[]
  readonly members: readonly GlossaryMember[]
  readonly minCosine: number
  readonly weakestPair: readonly [string, string]
  readonly transitive: boolean
  /**
   * The requirement ids that would newly become CO-ACTIVE in one context group.
   *
   * The payoff, stated per class. Computed by re-encoding with the candidate entry and
   * diffing `planContextGroups` — pure, Z3-free, and the same composition the fabrication
   * gate uses to show what a guard merge costs. This is what makes a guard suggestion
   * reviewable rather than a bare similarity claim: it names the comparisons the merge
   * unlocks, which is also exactly the set a wrong merge would compare wrongly.
   */
  readonly unlocks: readonly string[]
  /** Non-empty means DO NOT commit this as written. */
  readonly withheldBy: readonly GuardWithhold[]
  /** Ordered safest-first. `realign-guards` is the one that actually works. */
  readonly remedies: readonly Remedy[]
}

/** Why a term candidate must not be committed as written. */
export interface TermWithhold {
  /** The offending token, named so the author knows which word was the problem. */
  readonly token: string
  readonly reason: 'antonym-head' | 'state-bridge-verb'
}

/**
 * A NOUN-PHRASE generalization of a proposed phrase class — commit one term instead of N
 * phrase aliases, and it keeps applying to requirements written later.
 *
 * ## Where these come from
 *
 * Every candidate is derived from a class the plan already proposed. When a class's members
 * share a leading phrasing and differ only in a contiguous tail, that tail is a noun the
 * document names two ways: `issue a session token` and `issue a login credential` share
 * `issue a` and differ on `session token` / `login credential`. The phrase merge fixes those
 * two strings; the term fixes the noun.
 *
 * The shape is the MIRROR of `sharedObjectSuffix` in `engine/formal/quantity-alias.ts`, which
 * finds a shared object with differing verbs. A term needs a shared verb with differing
 * objects, so that helper could not be reused — noted because the reuse looked obvious.
 *
 * ## Never in `ops`
 *
 * Same reason as a guard class, one step stronger. A term entry rewrites many atoms from one
 * record, and the decide tier re-validates none of the propose-side conditions — so a
 * machine-applyable term is a record whose safety rests on a document-scale precondition
 * nothing re-checks when the next requirement arrives. `withheldBy` carries the write-time
 * refusal's own reasons, computed here so an author sees them before running the command
 * rather than after.
 */
export interface TermCandidate {
  readonly system: string
  /** The canonical noun phrase — the tail of the class's canonical member. */
  readonly canonical: string
  readonly aliases: readonly string[]
  /** The leading phrasing the members agree on, which is what makes this a NOUN split. */
  readonly sharedPrefix: string
  /**
   * Every atom in the document this entry would rewrite.
   *
   * The whole difference from a phrase entry, made reviewable. One record reaching many atoms
   * is the point and the risk, and an author cannot weigh a blast radius they cannot see.
   */
  readonly blastRadius: readonly string[]
  /** Non-empty means the fold would refuse this — shown BEFORE the command is run. */
  readonly withheldBy: readonly TermWithhold[]
  /** Runnable verbatim. Empty when withheld. */
  readonly commands: readonly string[]
  readonly consequence: string
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
  /**
   * Distinct GUARD bodies — `trig` and `pre` pooled, the kind dropped from the key.
   *
   * Pooled because the glossary key space is the BODY while the atom space is
   * `(scope, kind, body)`: a committed entry cannot distinguish a trigger from a
   * precondition, so a per-kind partition could produce two classes claiming one body under
   * two different canonicals — a cross-kind instance of `cross-system-conflict`, invisible to
   * the reconciliation counter. Pooling makes node identity match the granularity the decide
   * tier acts at. Aligning a trigger with a precondition does NOT merge their atoms; the kind
   * is in the atom name.
   *
   * `feat` is admitted by the filter but never occurs today — `encode` pushes only `pre`,
   * `trig`, and `resp`, and `feat` comes solely from the temporal mapper. Asserted, so the
   * day that changes is loud.
   */
  readonly guardNodes: number
  /** Must equal `responseNodes + guardNodes`, or the dedup is broken. */
  readonly embedded: number
  /** Total; equals `responsePairsCompared + guardPairsCompared`. */
  readonly pairsCompared: number
  readonly responsePairsCompared: number
  readonly guardPairsCompared: number
  /**
   * Raw RESPONSE phrases the current tables already folded onto a shared atom.
   *
   * Response-only on purpose. Its published meaning is "how much the committed glossary is
   * already doing", and for guards the number would be dominated by verbatim trigger
   * repetition — which is the authoring habit the craft guide explicitly instructs. Folding
   * that in would make a good habit read as table work.
   */
  readonly alreadyUnified: number
  /** The guard analogue, counted separately for the reason above. */
  readonly guardPhrasesFolded: number
  /**
   * Phrases occurring in BOTH slot families, so "no cross-slot withhold fired" is
   * distinguishable from "the check did not run".
   */
  readonly crossSlotPhrases: number
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
  /**
   * The slot family the applyable `ops` rewrite. Permanently `'response'` while guard
   * alignment is suggest-only, so nothing an agent branches on changes meaning — see
   * {@link vocabularies} for what the pass READ.
   */
  readonly vocabulary: GlossaryVocabulary
  /**
   * The slot families the pass looked at. Fixed rather than data-dependent, so an empty
   * document still reports that it examined both — the same found-nothing/did-not-look
   * discipline `pairsCompared` follows.
   */
  readonly vocabularies: readonly GlossaryVocabulary[]
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
   * GUARD-slot alignments — the highest-leverage suggestions the plan makes, and the only
   * ones that are never applyable. Weakest-first, withheld ones last.
   */
  readonly guardClasses: readonly GuardClass[]
  /**
   * NOUN-PHRASE generalizations of the proposed classes — one term instead of N phrase
   * aliases, and it keeps applying as the document grows. Never in `ops`.
   */
  readonly termCandidates: readonly TermCandidate[]
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
  readonly vocabulary: GlossaryVocabulary
  /**
   * The grouping key. For a response this is the atom NAME; for a guard the kind is dropped,
   * because a `trig` and a `pre` with the same text are two atoms but ONE glossary key.
   *
   * Keying guards by the atom name instead would surface them as two nodes with identical
   * bodies at cosine 1.0, and the emitted op would have `canonical === alias` — which
   * `applyGlossary` refuses with `ERR_USAGE`, failing the apply harness rather than merely
   * looking odd.
   */
  readonly atom: string
  /**
   * The REAL scoped atom names this node pooled, sorted.
   *
   * Separate from {@link atom} because that is a grouping key, and for a guard it is
   * synthetic — the kind is stripped, so it is not a name `check` ever prints. A payload field
   * documented as "the scoped atom name" must carry a name that exists in the document, so
   * `asMember` reports from here. For a response the two coincide.
   */
  readonly atomNames: readonly string[]
  readonly system: string
  readonly phrase: string
  readonly phrases: readonly string[]
  readonly requirementIds: readonly string[]
  /**
   * `normalize(phrase)` — the AUTHOR'S wording, and the key `glossaryIndex` looks up.
   *
   * Deliberately NOT the atom name's body. The atom body is post-canonicalization: an
   * antonym class is re-based on its lexicographically smallest member, so "seal the
   * vault" atomizes through the seed class `seal—unseal—expose—conceal` and arrives as
   * `conceal_the_vault`. Reading the head off the atom would tell an author to run
   * `symspec antonym close conceal` — naming a verb that appears nowhere in their
   * document. `findOppositionCandidates` reads the raw response for the same reason.
   */
  readonly body: string
  /**
   * The body the SHAPE checks read.
   *
   * For a response, identical to {@link body} — unchanged behavior. For a guard, the atom
   * body, which is the normalized phrase minus at most one copula token. That substitution is
   * legitimate for guards specifically because they get no antonym re-basing (`atomize` gates
   * that to `resp`), so the guard atom body only ever REMOVES: every token in it appears
   * verbatim in the author's phrase, which is what keeps a reported token honest. Comparing
   * stripped bodies is also what makes the check copula-insensitive without re-deriving the
   * engine's private `stripCopula`.
   */
  readonly shapeBody: string
}

/** What one `encodeIncluded` pass yields: both node families, their keys, and the counters. */
interface NodeScan {
  readonly responses: Node[]
  readonly guards: Node[]
  readonly alreadyUnified: number
  readonly guardPhrasesFolded: number
  /** Normalized slot texts per family — the two sets the cross-slot withhold intersects. */
  readonly responseKeys: ReadonlySet<string>
  readonly guardKeys: ReadonlySet<string>
  /** The encoded requirement count, so the corpus does not re-encode the document. */
  readonly requirements: number
  /** True if any guard row carried kind `feat`. Never today; asserted so a change is loud. */
  readonly sawFeatureSlot: boolean
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
 * Collapse the document's atoms into nodes — responses and guards, in ONE pass.
 *
 * One node per distinct key, carrying every raw phrase that landed on it, so the
 * already-folded counters can report how much the committed tables are already doing. One
 * `encodeIncluded` call because the counters must all describe ONE encoding, and because the
 * corpus used to re-encode the document a second time just to count requirements.
 */
const nodesOf = (doc: Doc): NodeScan => {
  const systemById = new Map(listRequirements(doc).map((r) => [r.id, normalize(r.systemName)]))
  type Bucket = {
    system: string
    phrases: Set<string>
    requirementIds: Set<string>
    atomNames: Set<string>
  }
  const buckets = new Map<string, { vocabulary: GlossaryVocabulary; bucket: Bucket }>()
  const responseKeys = new Set<string>()
  const guardKeys = new Set<string>()
  let responseRawPhrases = 0
  let guardRawPhrases = 0
  let sawFeatureSlot = false
  const encoded = encodeIncluded(doc)

  for (const enc of encoded) {
    for (const row of enc.atoms) {
      const isGuard = GUARD_KINDS.has(row.kind)
      if (row.kind !== 'resp' && !isGuard) continue
      const scope = systemById.get(enc.id) ?? ''
      if (row.kind === 'feat') sawFeatureSlot = true

      // The GROUPING key. Responses keep the atom name. Guards drop the kind, because
      // `glossaryIndex` is keyed on the body alone — see `Node.atom`.
      const key = isGuard
        ? `${scope}␟${row.atom.slice(renderAtom({ scope, kind: row.kind, body: '' }).length)}`
        : row.atom
      // A failed prefix strip can only ever UNDER-merge, never mis-merge.
      const safeKey =
        isGuard && !row.atom.startsWith(renderAtom({ scope, kind: row.kind, body: '' }))
          ? `${scope}␟${row.atom}`
          : key

      if (isGuard) {
        guardRawPhrases += 1
        guardKeys.add(normalize(row.slotText))
      } else {
        responseRawPhrases += 1
        responseKeys.add(normalize(row.slotText))
      }

      const existing = buckets.get(safeKey)
      const entry = existing ?? {
        vocabulary: (isGuard ? 'guard' : 'response') as GlossaryVocabulary,
        bucket: {
          system: scope,
          phrases: new Set<string>(),
          requirementIds: new Set<string>(),
          atomNames: new Set<string>(),
        },
      }
      entry.bucket.phrases.add(row.slotText)
      entry.bucket.requirementIds.add(enc.id)
      entry.bucket.atomNames.add(row.atom)
      if (existing === undefined) buckets.set(safeKey, entry)
    }
  }

  const build = (which: GlossaryVocabulary): Node[] =>
    [...buckets.entries()]
      .filter(([, v]) => v.vocabulary === which)
      .map(([atom, v]) => {
        const phrases = [...v.bucket.phrases].sort()
        const phrase = phrases[0] ?? ''
        const body = normalize(phrase)
        return {
          vocabulary: which,
          atom,
          atomNames: [...v.bucket.atomNames].sort(),
          system: v.bucket.system,
          phrase,
          phrases,
          requirementIds: [...v.bucket.requirementIds].sort(),
          body,
          // Guards read the copula-stripped atom body; responses read the author's wording.
          shapeBody: which === 'guard' ? (atom.split('␟')[1] ?? body) : body,
        }
      })
      .sort((a, b) => a.atom.localeCompare(b.atom))

  const responses = build('response')
  const guards = build('guard')
  return {
    responses,
    guards,
    alreadyUnified: responseRawPhrases - responses.length,
    guardPhrasesFolded: guardRawPhrases - guards.length,
    responseKeys,
    guardKeys,
    requirements: encoded.length,
    sawFeatureSlot,
  }
}

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

/**
 * Every pair of requirement ids that is CO-ACTIVE in some context group.
 *
 * A requirement is live in a group when every one of its guard atoms is asserted there, which
 * is precisely the condition `findContradictions` creates by `add()`ing the group's context
 * atoms. So this set is the set of pairs the contradiction tier can compare at all — and
 * `planContextGroups` is imported rather than re-derived, for the same reason the node set
 * comes from `encodeIncluded`: a second implementation of the grouping rule could drift from
 * the one that decides.
 *
 * Pure and Z3-free. `contradiction.ts` imports `getContext`, but `backend.ts` reaches
 * `z3-solver` through `await import(...)`, so nothing here boots the WASM module.
 */
const coactivePairs = (encoded: readonly EncodedRequirement[]): Set<string> => {
  const out = new Set<string>()
  for (const group of planContextGroups(encoded)) {
    const asserted = new Set(group.contextAtoms)
    const live = encoded
      .filter((e) => {
        const context = contextAtomsOf(e)
        return context.length > 0 && context.every((a) => asserted.has(a))
      })
      .map((e) => e.id)
      .sort()
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) out.add(`${live[i]}|${live[j]}`)
    }
  }
  return out
}

/**
 * The requirement ids that would newly become co-active if this guard class were committed.
 *
 * The payoff of a guard alignment, computed by actually doing it: re-encode with the candidate
 * entry appended to the document's glossary and diff the co-active sets. Deterministic, pure,
 * and it never mutates the caller's document.
 */
const unlocksFor = (doc: Doc, canonical: string, aliases: readonly string[]): readonly string[] => {
  if (aliases.length === 0) return []
  const before = coactivePairs(encodeIncluded(doc))
  const after = coactivePairs(
    encodeIncluded({
      ...doc,
      glossary: [...(doc.glossary ?? []), { canonical, aliases: [...aliases] }],
    }),
  )
  const ids = new Set<string>()
  for (const pair of after) {
    if (before.has(pair)) continue
    for (const id of pair.split('|')) ids.add(id)
  }
  return [...ids].sort()
}

/**
 * The NOUN split behind a phrase class, or `undefined` when there is not one.
 *
 * Returns the shared leading tokens plus each member's differing tail. Requires a non-empty
 * shared prefix (otherwise the members differ from the first word and there is no noun to
 * name) and a non-empty tail on every side (otherwise one phrase is a prefix of the other and
 * the "term" would be the empty string).
 */
const nounSplit = (
  bodies: readonly string[],
): { readonly prefix: readonly string[]; readonly tails: readonly string[] } | undefined => {
  if (bodies.length < 2) return undefined
  const lists = bodies.map((b) => b.split('_').filter((t) => t.length > 0))
  const shortest = Math.min(...lists.map((l) => l.length))
  let shared = 0
  while (shared < shortest - 1 && lists.every((l) => l[shared] === lists[0]?.[shared])) shared += 1
  if (shared === 0) return undefined
  const tails = lists.map((l) => l.slice(shared).join('_'))
  if (tails.some((t) => t.length === 0)) return undefined
  if (new Set(tails).size < 2) return undefined
  return { prefix: (lists[0] as string[]).slice(0, shared), tails }
}

/**
 * Derive the noun-phrase generalizations of the proposed classes.
 *
 * Every candidate reports the refusal the FOLD would raise, computed from the same two
 * lexicons `validateTerms` consults, so an author sees the verdict before running the command
 * rather than after. That duplication is deliberate and one-directional: the propose side may
 * be stricter than the write side without harm, and it must never be looser.
 */
const termCandidatesFor = (
  classes: readonly ProposedClass[],
  nodes: readonly Node[],
  antonyms: ReadonlyMap<string, AntonymEntry>,
): TermCandidate[] => {
  const out: TermCandidate[] = []
  for (const c of classes) {
    const members = [c.canonical, ...c.aliases]
    const split = nounSplit(members.map((m) => normalize(m)))
    if (split === undefined) continue
    const [canonicalTail, ...aliasTails] = split.tails
    if (canonicalTail === undefined) continue
    const unique = [...new Set(aliasTails.filter((t) => t !== canonicalTail))].sort()
    if (unique.length === 0) continue

    const withheldBy: TermWithhold[] = []
    for (const token of [canonicalTail, ...unique].flatMap((t) => t.split('_'))) {
      if (antonyms.has(deInflectHead(token))) {
        withheldBy.push({ token, reason: 'antonym-head' })
      } else if (ESTABLISH_VERBS.has(deInflectHead(token))) {
        withheldBy.push({ token, reason: 'state-bridge-verb' })
      }
    }

    // Every atom the entry would rewrite — read off the document's own nodes, so the number is
    // the real one rather than an estimate.
    const blastRadius = nodes
      .filter((n) =>
        unique.some((alias) => {
          const tokens = n.body.split('_')
          const needle = alias.split('_')
          for (let i = 0; i + needle.length <= tokens.length; i++) {
            if (needle.every((t, k) => tokens[i + k] === t)) return true
          }
          return false
        }),
      )
      .map((n) => n.atom)
      .sort()

    const readable = (t: string) => t.replace(/_/g, ' ')
    out.push({
      system: c.system,
      canonical: readable(canonicalTail),
      aliases: unique.map(readable),
      sharedPrefix: split.prefix.join(' '),
      blastRadius,
      withheldBy,
      commands:
        withheldBy.length > 0
          ? []
          : unique.map(
              (a) => `symspec term ${quoted(readable(canonicalTail))} ${quoted(readable(a))}`,
            ),
      consequence:
        withheldBy.length > 0
          ? `The fold will REFUSE this: "${withheldBy[0]?.token}" is a verb the formal tier reads, ` +
            'and substituting one inside a body moves the polarity the solver computes without ' +
            'moving the parse that recognises a state bridge. Commit the phrase merge instead.'
          : `One entry instead of ${unique.length} phrase alias(es), and it keeps applying: any ` +
            `requirement written later that says "${readable(unique[0] as string)}" lands on the ` +
            `same atom without a second commit. It rewrites ${blastRadius.length} atom(s) today.`,
    })
  }
  return out
}

/** Tokens that flip a guard's sense outright. */
const NEGATOR_TOKENS: ReadonlySet<string> = new Set(['not', 'never', 'no'])

/**
 * The deterministic signals that say two GUARD phrasings may be different conditions.
 *
 * Returns every signal that fires, not the first — a reader deciding whether to reword one of
 * two triggers wants all the evidence, and the cost of an extra line is a suggestion declined
 * rather than a contradiction manufactured.
 *
 * Reads `shapeBody` (the copula-stripped atom body), so "the door is locked" and "the door
 * locked" are one condition here, matching what `atomize` already did to them.
 */
const guardSignalsFor = (
  a: Node,
  b: Node,
  antonyms: ReadonlyMap<string, AntonymEntry>,
): readonly GuardSignal[] => {
  const ta = a.shapeBody.split('_').filter((t) => t !== '')
  const tb = b.shapeBody.split('_').filter((t) => t !== '')
  const found = new Set<GuardSignal>()

  // A single negator's worth of difference, in either direction.
  const negatorsOf = (t: readonly string[]) => t.filter((x) => NEGATOR_TOKENS.has(x)).length
  const strip = (t: readonly string[]) => t.filter((x) => !NEGATOR_TOKENS.has(x)).join('_')
  if (negatorsOf(ta) !== negatorsOf(tb) && strip(ta) === strip(tb)) found.add('negated-token')

  // Positionally aligned token pairs — only meaningful at equal length.
  if (ta.length === tb.length) {
    let differing = 0
    for (let i = 0; i < ta.length; i++) {
      const x = ta[i] as string
      const y = tb[i] as string
      if (x === y) continue
      differing += 1
      if (isNegatingPrefixPair(deInflectHead(x), deInflectHead(y))) {
        found.add('negating-prefix-token')
      }
      const ex = antonyms.get(deInflectHead(x))
      const ey = antonyms.get(deInflectHead(y))
      if (ex !== undefined && ey !== undefined && ex.canonical === ey.canonical) {
        found.add('antonym-token')
      }
    }
    // The guard analogue of `same-object-different-verb`: one token apart is not a paraphrase,
    // it is the same sentence with one thing changed — and that one thing is usually the point.
    if (differing === 1) found.add('single-token-difference')
  }
  return [...found].sort()
}

/**
 * The remedies for a guard pair, ordered SAFEST FIRST.
 *
 * `as-antonyms` is never offered. Antonym unification is gated `args.kind === 'resp'` in
 * `atomize`, so `symspec antonym a b` provably cannot change a guard atom: a guard opposition
 * is unprovable by construction, and offering the op would hand an agent a command that runs
 * clean and fixes nothing.
 */
const guardRemediesFor = (a: Node, b: Node, withheld: boolean): readonly Remedy[] => {
  const leaveDistinct: Remedy = {
    kind: 'leave-distinct',
    ops: [],
    commands: [],
    consequence:
      'These stay in separate context groups, so the contradiction tier never compares the ' +
      'requirements they guard. That is CORRECT when the two conditions are mutually ' +
      'exclusive, and it is the safe default.',
  }
  const realign: Remedy = {
    kind: 'realign-guards',
    ops: [],
    commands: [
      `symspec show ${a.requirementIds[0] ?? '<id>'}`,
      `symspec show ${b.requirementIds[0] ?? '<id>'}`,
    ],
    consequence:
      'Reword one guard so both name the same condition. That is what puts the requirements ' +
      'in one context group, and it does it in the document rather than in a side table, so ' +
      'the next reader sees why they are comparable.',
  }
  const asSynonyms: Remedy = {
    kind: 'as-synonyms',
    ops: [],
    commands: [`symspec glossary ${quoted(a.phrase)} ${quoted(b.phrase)}`],
    consequence:
      'Both guards collapse onto one atom, so every requirement guarded by either becomes ' +
      'live in one context group and their responses are compared for the first time. If the ' +
      'two conditions are NOT the same, this proves a conflict the document does not contain — ' +
      'no antonym op can undo it, because antonyms do not apply to guard slots.',
  }
  return withheld ? [leaveDistinct, realign, asSynonyms] : [realign, asSynonyms, leaveDistinct]
}

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
  const scan = nodesOf(doc)
  const nodes = scan.responses
  const guards = scan.guards
  const alreadyUnified = scan.alreadyUnified
  const antonyms = antonymIndexOf(doc)
  const committed = glossaryIndex(doc.glossary ?? [])
  const canonicalSet = new Set((doc.glossary ?? []).map((g) => normalize(g.canonical)))

  // ONE batched call, over distinct atoms rather than requirements, and over BOTH slot
  // families at once. The existing pairwise tiers embed every requirement's response —
  // including cross-system ones they then skip — and do not dedup despite a comment saying
  // they do. Responses first, so the response slice keeps its existing indices.
  const allPhrases = [...nodes.map((n) => n.phrase), ...guards.map((n) => n.phrase)]
  const allVectors = allPhrases.length > 0 ? await embedder(allPhrases) : []
  const vectors = allVectors.slice(0, nodes.length)
  const guardVectors = allVectors.slice(nodes.length)
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
  let guardPairsCompared = 0
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

  // ---- GUARD classes: suggested, never applied ----------------------------
  //
  // The same clustering, over the pooled trigger/precondition nodes. What differs is the
  // hazard direction, so what differs in the output is that there is no `ops` field to fill:
  // a wrong guard merge regroups contexts and can PROVE a conflict the document does not
  // contain, where a wrong response merge only hides one.
  const guardClasses: GuardClass[] = []
  {
    const guardBySystem = new Map<string, number[]>()
    for (const [i, node] of guards.entries()) {
      const bucket = guardBySystem.get(node.system)
      if (bucket === undefined) guardBySystem.set(node.system, [i])
      else bucket.push(i)
    }
    const guardEdges: [number, number][] = []
    const guardCosines = new Map<string, number>()
    for (const bucket of [...guardBySystem.values()]) {
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) {
          const i = bucket[x] as number
          const j = bucket[y] as number
          guardPairsCompared += 1
          const vi = guardVectors[i]
          const vj = guardVectors[j]
          const score = vi !== undefined && vj !== undefined ? cosine(vi, vj) : 0
          guardCosines.set(key(i, j), score)
          if (score >= threshold) guardEdges.push([i, j])
        }
      }
    }

    const guardRoots = partition(guards.length, guardEdges)
    const guardGroups = new Map<number, number[]>()
    for (const [i, root] of guardRoots.entries()) {
      const bucket = guardGroups.get(root)
      if (bucket === undefined) guardGroups.set(root, [i])
      else bucket.push(i)
    }

    for (const indices of [...guardGroups.values()].sort(
      (a, b) => (a[0] as number) - (b[0] as number),
    )) {
      if (indices.length < 2) continue
      const members = indices.map((i) => guards[i] as Node)
      const chosen = pickCanonical(members, new Set(), committed)
      const aliases = aliasesFor(members, chosen.canonical)
      if (aliases.length === 0) continue

      const withheldBy: GuardWithhold[] = []
      for (let x = 0; x < indices.length; x++) {
        for (let y = x + 1; y < indices.length; y++) {
          const i = indices[x] as number
          const j = indices[y] as number
          const a = guards[i] as Node
          const b = guards[j] as Node
          const score = Number((guardCosines.get(key(i, j)) ?? 0).toFixed(3))
          for (const signal of guardSignalsFor(a, b, antonyms)) {
            const phrases: readonly [string, string] =
              a.phrase.localeCompare(b.phrase) <= 0 ? [a.phrase, b.phrase] : [b.phrase, a.phrase]
            withheldBy.push({ signal, phrases, cosine: score })
          }
        }
      }

      const internal = pairwiseCosines(indices, guards, guardCosines, key)
      // A cross-slot collision is the ONE case where the entry would reach outside the guard
      // family, and `glossaryIndex` is kind-blind so nothing downstream would notice.
      const collides = [...members.flatMap((m) => m.phrases)].some((p) =>
        scan.responseKeys.has(normalize(p)),
      )
      if (collides) {
        withheldBy.push({
          signal: 'cross-slot-collision',
          phrases: [chosen.canonical, aliases[0] as string],
          cosine: internal.min,
        })
      }

      guardClasses.push({
        vocabulary: 'guard',
        system: members[0]?.system ?? '',
        canonical: chosen.canonical,
        aliases,
        members: members.map(asMember),
        minCosine: internal.min,
        weakestPair: internal.pair,
        transitive: internal.min < threshold,
        unlocks: withheldBy.length > 0 ? [] : unlocksFor(doc, chosen.canonical, aliases),
        withheldBy,
        remedies: guardRemediesFor(members[0] as Node, members[1] as Node, withheldBy.length > 0),
      })
    }
  }

  classes.sort((a, b) => a.minCosine - b.minCosine || a.canonical.localeCompare(b.canonical))
  unresolved.sort((a, b) => a.reason.localeCompare(b.reason) || a.system.localeCompare(b.system))
  // Suggestable first, then withheld; weakest-first within each, so the likeliest-wrong reads
  // before the likeliest-right in both halves.
  guardClasses.sort(
    (a, b) =>
      a.withheldBy.length - b.withheldBy.length ||
      a.minCosine - b.minCosine ||
      a.canonical.localeCompare(b.canonical),
  )
  oppositions.sort(
    (a, b) =>
      a.system.localeCompare(b.system) ||
      a.phrases[0].localeCompare(b.phrases[0]) ||
      a.phrases[1].localeCompare(b.phrases[1]),
  )

  return {
    // The slot the applyable `ops` rewrite — guard alignment is suggest-only, so this stays
    // `'response'` and no consumer branching on it changes meaning.
    vocabulary: 'response',
    vocabularies: ['response', 'guard'],
    threshold,
    oppositionCosineFloor: DEFAULT_OPPOSITION_COSINE_FLOOR,
    canonicalRule: 'lexicographic-smallest-normalized-body',
    embedderIsStub: options.embedderIsStub ?? false,
    corpus: {
      requirements: scan.requirements,
      systems: bySystem.size,
      responseNodes: nodes.length,
      guardNodes: guards.length,
      embedded: allVectors.length,
      pairsCompared: pairsCompared + guardPairsCompared,
      responsePairsCompared: pairsCompared,
      guardPairsCompared,
      alreadyUnified,
      guardPhrasesFolded: scan.guardPhrasesFolded,
      crossSlotPhrases: [...scan.guardKeys].filter((k) => scan.responseKeys.has(k)).length,
      oppositionSignals: signals.size,
    },
    classes,
    unresolved,
    guardClasses,
    termCandidates: termCandidatesFor(classes, nodes, antonyms),
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
  // A REAL atom name, never the synthetic guard grouping key — see `Node.atomNames`.
  atom: n.atomNames[0] ?? n.atom,
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
    case 'cross-slot-collision':
      return (
        `${phrases} cluster together, but at least one of those phrasings also appears in the ` +
        'OTHER slot family in this document. A glossary entry rewrites a phrase in EVERY slot — ' +
        'the committed table has no slot scope — so merging these would also move atoms in that ' +
        'family, changing which requirements the contradiction tier compares. The whole class is ' +
        'withheld. Reword one side so the two slots do not share a phrase, then re-run.'
      )
  }
}
