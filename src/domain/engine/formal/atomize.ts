/**
 * The load-bearing atomization contract (AC-4-2a).
 *
 * `atomize` is the SINGLE pure function that turns an EARS slot's text into a
 * Boolean SMT atom. Every formal finding — contradiction (AC-4-4), subsumption
 * / redundancy (AC-4-5), vacuity, incompleteness (AC-4-5a) — is only as sound
 * as this function, because two requirements "conflict" in the solver exactly
 * when their responses resolve to the SAME atom with opposite polarity. That
 * makes this the spec's designated load-bearing component (research-smt.md §4;
 * spec AC-4-2a, AC-4-11 "sound modulo atomization").
 *
 * The four invariants this module guarantees, each directly tested:
 *
 *   1. PURITY / DETERMINISM. `atomize` depends only on its arguments and the
 *      frozen seed antonym table. No clock, no randomness, no mutation of its
 *      inputs, no module-level mutable state. Same input → byte-identical
 *      output, always. Downstream unsat-core minimization and the "exactly two
 *      IDs" contradiction test (AC-4-4) rely on this.
 *
 *   2. CONSERVATIVE, NEAR-EXACT NORMALIZATION. The pipeline is EXACTLY:
 *        lowercase → strip leading articles (a|an|the) → strip punctuation
 *        → collapse whitespace → underscore-join → glossary rewrite →
 *        copula strip (guard slots only) → leading-verb de-inflection +
 *        antonym rewrite (response slots only).
 *      It MUST NOT stem, lemmatize, or strip stopwords from the REMAINDER of a
 *      slot. Three closed, deterministic head/token rules are the whole
 *      exception surface (each below, each tested):
 *        - the LEADING RESPONSE VERB is de-inflected by a closed third-person
 *          -s rule ({@link deInflectHead}), so "shall opens the valve" and
 *          "shall open the valve" collide on one atom;
 *        - GUARD slots ({@link GUARD_KINDS}: pre/trig/feat) drop a single copula
 *          token ({@link stripCopula}), so "the session is authenticated" and
 *          "the session authenticated" name one guard state;
 *        - when (and only when) an ANTONYM head-flip fires, one preposition
 *          token is dropped from the remainder ({@link canonicalizeAntonymRest}),
 *          so "include X in the view" / "exclude X from the view" unify.
 *      Everything else stays near-exact: aggressive normalization is the one
 *      false-positive risk class (AC-4-11), so we buy only what closed rules
 *      can honestly deliver.
 *
 *   3. PER-systemName SCOPING. Every atom is prefixed `sys__<system>__<kind>__`
 *      (rendered by {@link renderAtom}, the one place that format is written).
 *      Identical response text under two different systems therefore yields two
 *      distinct atoms and can never unify into a spurious cross-system
 *      contradiction (spec AC-4-2a; research-smt.md §4.1 — "scope atoms per
 *      systemName ... keep that").
 *
 *   4. NEGATION-ON-THE-SAME-ATOM. The response negation from AC-2-4 (the
 *      `negated` flag on the Tier-1 parse) is consumed as the atom's POLARITY,
 *      not baked into the atom text. "shall not store plaintext" and "shall
 *      store plaintext" produce the SAME atom with opposite polarity, so the
 *      solver sees `R` vs `¬R` and can find the conflict — the whole point of
 *      extracting negation as a flag rather than leaving "not" in the string.
 *      The curated seed antonym table (antonyms.ts) extends this to lexical
 *      opposites: "grant access" / "revoke access" unify to one atom, opposite
 *      polarity, so the common grant-vs-revoke conflict is detectable rather
 *      than a false negative (spec AC-4-2a; research-smt.md §4.2).
 *
 * ## ONE atomizer for BOTH tiers (AC-2-7)
 *
 * This module is the SINGLE atomizer for the propositional tier (`encode.ts`)
 * AND the bounded-temporal tier (`temporal-patterns.ts`). It did not used to be:
 * `temporal-patterns.ts` carried a private normalizer that diverged from this one
 * in nine measured ways (punctuation class, copula strip, glossary, antonym
 * unification, de-inflection, a fourth `feat` kind, `not` baked into the atom
 * NAME, empty-slot atoms, and a different requirement population). The
 * consequence was that `--temporal` was blind to every glossary/antonym
 * commitment — structurally, because `earsToTemporal` took no such parameter.
 *
 * The divergences are resolved in favour of the semantics BELOW in every case:
 * this is the tier whose behavior is pinned by `atomize.test.ts` and whose
 * conservatism argument (invariant 2) is the documented one. `earsToTemporal`
 * now takes an injected {@link Atomize} — the SAME function instance the
 * propositional encoder receives — so the two tiers cannot drift again without a
 * signature change.
 *
 * **Propose/decide note.** Nothing in this pipeline is a propose-only leniency
 * being promoted into a decide key (the trap
 * `.erpaval/solutions/architecture/normalization-for-a-propose-signal-must-not-touch-the-decide-key.md`
 * records). The glossary and antonym indexes are DOC-COMMITTED artifacts — the
 * decide half of propose/decide — and the copula strip, leading-verb
 * de-inflection and antonym-remainder rule are closed deterministic rules that
 * were already in the propositional DECIDE key before AC-2-7. Unification makes
 * two decide tiers agree; it does not make either one looser than it was.
 */

import { ANTONYM_INDEX, type AntonymEntry } from './antonyms.ts'
import { deInflectHead } from './lemma.ts'

export { deInflectHead } from './lemma.ts'

/**
 * Which EARS slot an atom was derived from (research-smt.md §4.1). The SINGLE
 * declaration of this union: `encode.ts` used to declare a structurally
 * identical copy, which is exactly the kind of duplication that let the two
 * tiers drift (AC-2-7). `encode.ts` now imports this type.
 *
 * `feat` is produced ONLY by the temporal tier's `optional-feature` mapping
 * (`temporal-patterns.ts`); the propositional encoder never emits one, so no
 * propositional consumer's behavior changes by its presence in the union. Its
 * survival is a live semantic question — see the `feat` note on
 * {@link GUARD_KINDS}.
 */
export type AtomKind = 'trig' | 'pre' | 'resp' | 'feat'

/**
 * The GUARD kinds — the slot kinds that describe a condition rather than a
 * response, and therefore the kinds the copula strip applies to.
 *
 * `feat` is in this set because an `optional-feature` requirement's `feat` atom
 * is derived from the very same `preCondition` slot a `state-driven`
 * requirement's `pre` atom comes from; treating the two slots differently under
 * normalization would be a divergence of exactly the kind AC-2-7 removes.
 *
 * **Open semantic question, deliberately NOT resolved here (AC-2-7 note (a)).**
 * Whether `feat` should exist at all: one slot yielding two different atom
 * namespaces depending on `patternType` is arguably wrong, and collapsing
 * `feat` → `pre` is arguably more correct. It is NOT a refactor — collapsing it
 * makes an `optional-feature` precondition share an atom with a `state-driven`
 * precondition of the same text, which can only INCREASE unification and
 * therefore increase error-severity findings. The conservative choice (keep the
 * namespaces separate, exactly as shipped) is what is implemented, because the
 * other direction moves in the false-positive direction and needs a human.
 */
export const GUARD_KINDS: ReadonlySet<AtomKind> = new Set<AtomKind>(['pre', 'trig', 'feat'])

/**
 * The STRUCTURED identity of an atom, before it is rendered to a name.
 *
 * The whole reason this exists (AC-2-7): an atom used to be nothing but a
 * pre-joined string, so any consumer that wanted to know an atom's KIND had to
 * look for `__resp__` as an embedded substring of the name. That is a parse of a
 * rendering — it cannot distinguish a real kind marker from body text, and it
 * silently answers a well-formed question wrongly. Carrying `{scope, kind, body}`
 * and rendering on demand makes kind a field, so the question is answered by a
 * lookup that cannot be fooled.
 *
 * `scope` and `body` are ALREADY {@link normalize}d; `renderAtom` only joins.
 */
export interface AtomRef {
  /** The normalized `systemName` the atom is scoped under (invariant 3). */
  readonly scope: string
  /** Which EARS slot the atom came from. */
  readonly kind: AtomKind
  /**
   * The normalized slot body, post-glossary / copula / antonym rewriting. Empty
   * exactly when the slot was absent or normalized away to nothing — which is
   * what lets a caller OMIT the slot rather than emit a well-formed-but-empty
   * atom that two unrelated malformed requirements would then share.
   */
  readonly body: string
}

/**
 * Render an {@link AtomRef} to its scoped atom name. The ONE place the name
 * format `sys__<system>__<kind>__<body>` is written down, so both tiers'
 * atom names are byte-identical by construction rather than by comment.
 */
export function renderAtom(ref: AtomRef): string {
  return `sys__${ref.scope}__${ref.kind}__${ref.body}`
}

/** A single Boolean atom: its fully-scoped name plus the polarity to assert. */
export interface Atom {
  /**
   * The scoped atom name, e.g. `sys__auth_service__resp__issue_a_session_token`.
   * Two slot texts collide iff they produce the same `name`. Always exactly
   * `renderAtom(ref)`.
   */
  name: string
  /** When true, the formula asserts `¬name` rather than `name`. */
  negated: boolean
  /** The structured identity `name` renders from (see {@link AtomRef}). */
  ref: AtomRef
}

/**
 * A Boolean atom paired with its polarity, as the injected {@link Atomize}
 * contract returns it. `negated: true` means the requirement asserts `¬atom` (an
 * explicit `shall not` per AC-2-4, or a polar-opposite unified via the antonym
 * table). The atom name is the *positive* atom in both cases, so `shall X` and
 * `shall not X` share one atom with opposite polarity.
 *
 * Declared HERE rather than in `encode.ts` (AC-2-7): the atomization contract
 * belongs to the atomizer, and having the encoder own a second copy of the atom
 * vocabulary is what let the temporal tier grow a third.
 */
export interface AtomLit {
  atom: string
  negated: boolean
  /**
   * The structured identity, when the atomizer supplied one. OPTIONAL because
   * unit tests legitimately inject a hand-written atomizer that returns only a
   * name; a consumer that needs the structure must handle its absence rather
   * than fall back to parsing `atom` (see {@link AtomRef}).
   */
  ref?: AtomRef
}

/**
 * The atom-table function (AC-4-2a), INJECTED into both the propositional
 * encoder (`encode`) and the temporal mapper (`earsToTemporal`) so the two tiers
 * provably share one atomizer: they receive the same function instance from
 * `src/pipeline/check.ts`, and neither can be called without one.
 *
 * Given a slot kind, the raw slot text, the owning `systemName` (for per-system
 * scoping so identical response text under two systems yields two distinct atoms
 * — invariant 3), and the parse-time `negated` flag (AC-2-4), it returns the
 * scoped atom name and its polarity.
 *
 * Context slots (`trig`/`pre`/`feat`) pass `negated = false`; only the response
 * slot threads the requirement's `negated` flag.
 */
export type Atomize = (
  kind: AtomKind,
  slotText: string,
  systemName: string,
  negated: boolean,
) => AtomLit

/**
 * Build the injected {@link Atomize} both tiers consume, closing over an optional
 * glossary index (AC-9-2) so agent-confirmed synonyms canonicalize to one atom,
 * and an optional doc-augmented antonym index (#1) so agent-confirmed opposites
 * collapse to one atom at opposite polarity. With neither, behavior is
 * byte-identical to the pre-feature run.
 *
 * This lives here rather than in the pipeline (AC-2-7) precisely so the temporal
 * tier can be handed the same closure the propositional tier gets — the previous
 * arrangement (a private adapter inside `check.ts`) is what made the temporal
 * tier's blindness structural.
 */
export function makeAtomize(
  glossary?: ReadonlyMap<string, string>,
  antonyms?: ReadonlyMap<string, AntonymEntry>,
): Atomize {
  return (kind, slotText, systemName, negated) => {
    const a = atomize({
      kind,
      text: slotText,
      systemName,
      negated,
      ...(glossary !== undefined ? { glossary } : {}),
      ...(antonyms !== undefined ? { antonyms } : {}),
    })
    return { atom: a.name, negated: a.negated, ref: a.ref }
  }
}

/** Arguments to {@link atomize}. */
export interface AtomizeArgs {
  /** The EARS slot kind this text came from. */
  kind: AtomKind
  /** The raw slot text (trigger / precondition / response). */
  text: string
  /** The requirement's `systemName`; the atom is scoped under its normalization. */
  systemName: string
  /**
   * Response negation from AC-2-4. Consumed as the atom's polarity so `¬R`
   * lands on the SAME atom as `R`. Callers pass this only for `resp` slots;
   * omitted elsewhere. Never `undefined`-widened (exactOptionalPropertyTypes).
   */
  negated?: boolean
  /**
   * Optional glossary (AC-9-2): a map from a NORMALIZED alias phrase to its
   * NORMALIZED canonical phrase. When the normalized slot text matches an
   * alias, the canonical phrase is atomized instead, so agent-confirmed
   * synonyms ("issue a session token" ≡ "issue a login credential") collide on
   * one atom and a paraphrased contradiction becomes provable. Omitted ⇒
   * behavior is byte-identical to a glossary-free run. Built by
   * {@link glossaryIndex} from the document's committed glossary — the fuzzy
   * embedding step only PROPOSES entries; this deterministic lookup is what
   * actually merges them.
   */
  glossary?: ReadonlyMap<string, string>
  /**
   * Optional antonym index (#1): the resolved signed equivalence classes the
   * `resp` leading-verb unification consults. When omitted, the code-committed
   * seed table ({@link ANTONYM_INDEX}) is used, so behavior is byte-identical to
   * the pre-feature path. Callers that have doc-committed antonym pairs pass a
   * merged index (built by `buildAntonymIndexWithDoc`) so an agent-confirmed
   * pair like open/shut unifies exactly like a seed pair. Consulted only for
   * `resp` slots, after the glossary rewrite.
   */
  antonyms?: ReadonlyMap<string, AntonymEntry>
}

/**
 * Build the normalized alias→canonical lookup {@link atomize} consumes from a
 * document's committed glossary entries (AC-9-1). Both sides are run through
 * {@link normalize} so a glossary authored in natural phrasing matches the
 * normalized slot body. A canonical mapped to itself is harmless (idempotent).
 */
export function glossaryIndex(
  entries: ReadonlyArray<{ canonical: string; aliases: readonly string[] }>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const { canonical, aliases } of entries) {
    const canon = normalize(canonical)
    for (const alias of aliases) index.set(normalize(alias), canon)
  }
  return index
}

/**
 * The conservative, near-exact normalization pipeline (AC-4-2a). Pure.
 *
 * Order is normative and load-bearing:
 *   1. lowercase
 *   2. strip a single LEADING article (`a`/`an`/`the`) — internal articles
 *      ("issue a session token") are preserved deliberately
 *   3. strip punctuation (any non-alphanumeric, non-space char → space); this
 *      also normalizes input underscores so `auth_service` is idempotent
 *   4. collapse whitespace and underscore-join the surviving word tokens
 *
 * No stemming, no lemmatization, no stopword removal beyond the leading article.
 */
export function normalize(text: string): string {
  const lowered = text.toLowerCase()
  const deArticled = lowered.replace(/^(?:a|an|the)\s+/, '')
  const dePunct = deArticled.replace(/[^a-z0-9\s]+/g, ' ')
  return dePunct.split(/\s+/).filter(Boolean).join('_')
}

/**
 * The copula tokens a GUARD (pre/trig) body drops — exactly one, the first
 * occurrence — so "the session is authenticated" and "the session
 * authenticated" (the state a bridge like "mark the session as authenticated"
 * establishes) atomize identically. This both lets guard-implication bridges
 * (#2) match guards naturally and soundly merges copula/non-copula phrasings of
 * the same real-world condition into one context group.
 */
const COPULA_TOKENS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'becomes',
  'remains',
])

/** Strip the FIRST standalone copula token from an underscore-joined guard body. */
function stripCopula(body: string): string {
  const tokens = body.split('_')
  const i = tokens.findIndex((t) => COPULA_TOKENS.has(t))
  if (i === -1) return body
  tokens.splice(i, 1)
  return tokens.join('_')
}

/**
 * Prepositions dropped from an antonym-flipped response remainder (A4). Fires
 * ONLY after an antonym head hit, and drops exactly ONE token — the first
 * preposition appearing after at least one non-preposition token — so
 * "exclude that tile from the default gallery view" and "include that tile in
 * the default gallery view" unify at opposite polarity. Direction within an
 * antonym class is carried by the HEAD (include vs exclude), never by the
 * preposition, which is what makes this sound; verbs outside the antonym
 * table ("move X to A" / "move X from A") are never touched, and differing
 * landing sites ("…gallery A" vs "…gallery B") still produce distinct atoms
 * because only the preposition itself is dropped, never the noun phrase.
 */
const REST_PREPOSITIONS: ReadonlySet<string> = new Set([
  'in',
  'into',
  'from',
  'within',
  'inside',
  'to',
  'onto',
  'at',
  'on',
])

/** Drop the first mid-remainder preposition token (antonym-hit responses only). */
function canonicalizeAntonymRest(rest: string): string {
  if (rest === '') return rest
  const tokens = rest.split('_')
  for (let i = 1; i < tokens.length; i++) {
    if (REST_PREPOSITIONS.has(tokens[i] as string)) {
      tokens.splice(i, 1)
      return tokens.join('_')
    }
  }
  return rest
}

/**
 * Turn one EARS slot into a scoped Boolean {@link Atom}. Pure and deterministic.
 *
 * For `resp` slots, the leading verb is checked against the seed antonym table:
 * on a hit the verb is rewritten to its class canonical and the polarity is
 * flipped, so polar-opposite responses land on one atom. The AC-2-4 `negated`
 * flag and any antonym flip compose by XOR.
 */
export function atomize(args: AtomizeArgs): Atom {
  const scope = normalize(args.systemName)
  let body = normalize(args.text)
  let negated = args.negated ?? false

  // Glossary canonicalization (AC-9-2) runs FIRST, before antonym unification,
  // so an agent-confirmed synonym is rewritten to its canonical phrasing and
  // then participates in the same antonym/atom logic as any native phrase.
  // A no-op when no glossary is supplied or the body is not an alias.
  if (args.glossary !== undefined) {
    const canonical = args.glossary.get(body)
    if (canonical !== undefined) body = canonical
  }

  // Copula strip applies only to GUARD slots (pre/trig/feat), AFTER the glossary
  // rewrite so committed glossary entries keyed on the natural phrasing keep
  // matching. "the session is authenticated" ⇒ "session_authenticated", the
  // same atom the guard-implication tier derives from a "mark the session as
  // authenticated" bridge — the copula was the byte gap that dropped those
  // bridges as inert (Run 2/3 adversarial escape).
  //
  // AC-2-7: `feat` joins this set. It is derived from the same `preCondition`
  // slot as `pre`, so leaving it un-stripped would keep exactly the divergence
  // this AC removes (the temporal tier's `optional-feature` guard previously kept
  // its copula while every propositional guard dropped one).
  if (GUARD_KINDS.has(args.kind)) {
    body = stripCopula(body)
  }

  // Antonym unification applies only to responses (spec AC-4-2a: "polar-opposite
  // responses"). The leading verb is de-inflected (closed 3sg rule) and looked
  // up longest-prefix-first — two tokens ("roll_back") before one ("roll") — so
  // multiword opposites like commit/roll-back resolve. On a hit the head is
  // rewritten to the class canonical, polarity flips, and one remainder
  // preposition is dropped (see canonicalizeAntonymRest); the rest of the
  // remainder must still be byte-identical, so "grant access"/"revoke access"
  // unify but "grant access"/"revoke permission" do not. On a miss the
  // de-inflected head still replaces the surface head, so "opens the valve"
  // and "open the valve" collide even outside any antonym class.
  if (args.kind === 'resp' && body.length > 0) {
    const tokens = body.split('_')
    const tok1 = deInflectHead(tokens[0] as string)
    // Consult the doc-augmented antonym index when supplied (#1), else the
    // code-committed seed table — same lookup shape, so an agent-confirmed pair
    // (open/shut) unifies exactly like a seed pair (grant/revoke).
    const index = args.antonyms ?? ANTONYM_INDEX
    // Longest-prefix probe: try the de-inflected two-token head first (so
    // "rolls back" → "roll_back" matches a multiword class member), then one.
    const twoTok = tokens.length >= 2 ? `${tok1}_${tokens[1] as string}` : undefined
    const twoEntry = twoTok !== undefined ? index.get(twoTok) : undefined
    const entry = twoEntry ?? index.get(tok1)
    const headLen = twoEntry !== undefined ? 2 : 1
    if (entry) {
      const rest = tokens.slice(headLen).join('_')
      const canonRest = canonicalizeAntonymRest(rest)
      body = canonRest === '' ? entry.canonical : `${entry.canonical}_${canonRest}`
      negated = negated !== entry.negated // XOR: compose AC-2-4 negation with the antonym flip
    } else if (tok1 !== tokens[0]) {
      tokens[0] = tok1
      body = tokens.join('_')
    }
  }

  const ref: AtomRef = { scope, kind: args.kind, body }
  return { name: renderAtom(ref), negated, ref }
}
