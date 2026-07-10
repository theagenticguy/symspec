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
 *        → collapse whitespace → underscore-join.
 *      It MUST NOT stem, lemmatize, or strip stopwords beyond a single leading
 *      article. "issues" and "issue" stay distinct atoms. Aggressive
 *      normalization is the one false-positive risk class (AC-4-11), so we buy
 *      only what regex can honestly deliver.
 *
 *   3. PER-systemName SCOPING. Every atom is prefixed `sys__<system>__<kind>__`.
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
 */

import { ANTONYM_INDEX } from './antonyms.js'

/** Which EARS slot an atom was derived from (research-smt.md §4.1). */
export type AtomKind = 'trig' | 'pre' | 'resp'

/** A single Boolean atom: its fully-scoped name plus the polarity to assert. */
export interface Atom {
  /**
   * The scoped atom name, e.g. `sys__auth_service__resp__issue_a_session_token`.
   * Two slot texts collide iff they produce the same `name`.
   */
  name: string
  /** When true, the formula asserts `¬name` rather than `name`. */
  negated: boolean
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

  // Antonym unification applies only to responses (spec AC-4-2a: "polar-opposite
  // responses"). Requires a leading-verb match; the object remainder must be
  // byte-identical after normalization, so "grant access"/"revoke access" unify
  // but "grant access"/"revoke permission" do not.
  if (args.kind === 'resp' && body.length > 0) {
    const sep = body.indexOf('_')
    const head = sep === -1 ? body : body.slice(0, sep)
    const rest = sep === -1 ? '' : body.slice(sep) // keeps the leading '_'
    const entry = ANTONYM_INDEX.get(head)
    if (entry) {
      body = entry.canonical + rest
      negated = negated !== entry.negated // XOR: compose AC-2-4 negation with the antonym flip
    }
  }

  return { name: `sys__${scope}__${args.kind}__${body}`, negated }
}
