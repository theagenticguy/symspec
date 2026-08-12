/**
 * Curated seed antonym table for the formal atomizer (AC-4-2a).
 *
 * The single load-bearing purpose: unify polar-opposite response verbs onto ONE
 * Boolean atom with opposite polarity, so the SMT tier can actually detect the
 * common "grant vs revoke" style contradiction. Without this table that whole
 * class of conflict is a false negative and the minimal-unsat-core finding
 * (AC-4-4) is nearly vacuous (research-smt.md §4.2 rule 2; spec AC-4-2a).
 *
 * Scope and conservatism (research-smt.md §4.2, §4.3):
 *   - This is a small, HIGH-PRECISION, curated resource — NOT a thesaurus and
 *     NOT runtime fuzzy expansion. It ships the 15 seed pairs the spec pinned
 *     plus the adversarial-eval expansion (each pair below is an eval-confirmed
 *     real-world blind spot), and grows only by an explicit edit to this seed
 *     set (AC-4-12) or the doc-committed `antonym add` path. A bulk dictionary
 *     import was evaluated (2026-07) and rejected: WordNet's 477 verb-antonym
 *     pairs cover only 13 of the 32 pairs this table needs, contain odd
 *     polarity cycles that break the signed union-find, and merge classes this
 *     table deliberately keeps apart — curation IS the architecture here.
 *   - Unification requires the (de-inflected) leading verb to match AND the
 *     object remainder to be identical after normalization + the antonym-hit
 *     preposition drop (see atomize.ts): "grant access" unifies with
 *     "revoke access" but not with "revoke permission".
 *
 * Shared-member semantics (why a signed union-find, not a flat pair map):
 *   Some seed pairs share a member — `accept↔reject`, `approve↔reject`, and
 *   `accept↔decline` all touch `accept`/`reject`. A naive "verb → its pair's
 *   canonical" map would make `reject` ambiguous. Instead we treat each pair as
 *   an equality-up-to-sign constraint (`a` and `b` are opposite polarity) and
 *   compute signed equivalence classes: `accept`, `approve` (positive) and
 *   `reject`, `decline` (negative) collapse into one class whose canonical atom
 *   is the lexicographically smallest member (`accept`). This is the only
 *   deterministic, conflict-free way to resolve shared members, and it has the
 *   sensible consequence that near-synonyms on the same polarity side
 *   (`accept`/`approve`) unify too.
 */

/**
 * The seed antonym pairs (AC-4-2a; original 15 from the spec plus the
 * adversarial-eval expansion). Each `[a, b]` asserts that `a` and `b` are polar
 * opposites — a response led by `a` and one led by `b` (with the same object
 * remainder) resolve to the same atom with opposite polarity. Multiword heads
 * are underscore-joined in normalized form (`roll_back`); the atomizer probes
 * two-token heads before one.
 *
 * Append-only in spirit: the seed set is a documented contract surface. Grow it
 * by editing this array, do not silently reorder or drop pairs. The resolved
 * class → canonical map is snapshot-tested so any edit that silently merges or
 * re-canonicalizes classes fails loudly.
 *
 * Deliberate class merges (adversarial-eval driven, each a judgment call):
 *   - grant/allow/permit/authorize collapse into ONE positive authorization
 *     class against revoke/deny/forbid (via grant↔deny, permit↔deny,
 *     authorize↔deny): in the EARS response idiom these are interchangeable
 *     authorization verbs over an identical object remainder, and the
 *     remainder-must-match rule bounds the over-unification risk. The eval's
 *     grant-vs-deny blind spot (grant/revoke and allow/deny were disjoint
 *     classes) is closed by exactly this merge.
 *   - publish/extend transitively share a class via retract/withdraw
 *     (publish↔retract, extend↔retract, insert↔withdraw): acceptable under
 *     remainder-match ("publish the report" vs "extend the report" colliding
 *     requires identical remainders AND opposite intent — no observed case);
 *     kept because both pairs are eval-confirmed real-world conflicts.
 *   - The accept/approve/reject/decline class is deliberately NOT merged into
 *     the authorization class (proposal-acceptance ≠ access-authorization).
 */
export const SEED_ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['accept', 'reject'],
  ['enable', 'disable'],
  ['grant', 'revoke'],
  ['allow', 'deny'],
  ['permit', 'forbid'],
  ['approve', 'reject'],
  ['lock', 'unlock'],
  ['open', 'close'],
  ['activate', 'deactivate'],
  ['connect', 'disconnect'],
  ['include', 'exclude'],
  ['add', 'remove'],
  ['start', 'stop'],
  ['show', 'hide'],
  ['accept', 'decline'],
  // --- adversarial-eval expansion (Run 1–3 confirmed blind spots) ---
  ['grant', 'deny'],
  ['permit', 'deny'],
  ['authorize', 'deny'],
  ['commit', 'roll_back'],
  ['commit', 'rollback'],
  ['seal', 'unseal'],
  ['seal', 'expose'],
  ['expose', 'conceal'],
  ['quarantine', 'release'],
  ['publish', 'retract'],
  ['suspend', 'resume'],
  ['engage', 'disengage'],
  ['raise', 'lower'],
  ['insert', 'withdraw'],
  ['flood', 'drain'],
  ['energize', 'de_energize'],
  ['extend', 'retract'],
]

/** A resolved antonym-class membership for one verb. */
export interface AntonymEntry {
  /** The lexicographically-smallest member of the verb's signed equivalence class. */
  canonical: string
  /** True when this verb sits on the OPPOSITE polarity side of `canonical`. */
  negated: boolean
}

/**
 * Build the signed equivalence-class index from a list of antonym pairs.
 *
 * Pure and deterministic. Treats the pairs as an undirected graph whose edges
 * flip polarity, 2-colours each connected component by BFS, then re-bases each
 * component so its lexicographically-smallest member is the positive canonical.
 *
 * Throws if the pairs contain an odd (inconsistent) polarity cycle — impossible
 * for the fixed seeds, but a guard against a future edit that would make
 * atomization non-deterministic.
 */
export function buildAntonymIndex(
  pairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, AntonymEntry> {
  // Adjacency: each verb -> the verbs asserted opposite to it.
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const list = adj.get(a)
    if (list) list.push(b)
    else adj.set(a, [b])
  }
  for (const pair of pairs) {
    const a = pair[0]
    const b = pair[1]
    link(a, b)
    link(b, a)
  }

  // BFS 2-colouring: sign[v] = false (positive) | true (negative) within a run.
  const sign = new Map<string, boolean>()
  const componentOf = new Map<string, string[]>()

  for (const start of adj.keys()) {
    if (sign.has(start)) continue
    const members: string[] = []
    sign.set(start, false)
    const queue: string[] = [start]
    while (queue.length > 0) {
      const v = queue.shift() as string
      members.push(v)
      const vSign = sign.get(v) as boolean
      for (const w of adj.get(v) ?? []) {
        const wSign = sign.get(w)
        if (wSign === undefined) {
          sign.set(w, !vSign)
          queue.push(w)
        } else if (wSign === vSign) {
          throw new Error(
            `Inconsistent antonym pairs: "${v}" and "${w}" resolve to the same polarity`,
          )
        }
      }
    }
    for (const m of members) componentOf.set(m, members)
  }

  const index = new Map<string, AntonymEntry>()
  for (const [verb, members] of componentOf) {
    const canonical = [...members].sort()[0] as string
    // Re-base sign relative to the canonical (which we pin to positive).
    const negated = (sign.get(verb) as boolean) !== (sign.get(canonical) as boolean)
    index.set(verb, { canonical, negated })
  }
  return index
}

/**
 * The resolved index over the shipped seed pairs. This is the concrete table
 * the atomizer consults; it is computed once at module load and never mutated.
 */
export const ANTONYM_INDEX: ReadonlyMap<string, AntonymEntry> =
  buildAntonymIndex(SEED_ANTONYM_PAIRS)

/**
 * Build the resolved antonym index the atomizer consults from the code-committed
 * seed pairs PLUS a document's agent-confirmed pairs (#1). The two sources are
 * concatenated and handed to {@link buildAntonymIndex}, so a doc pair that
 * bridges two seed classes (or that shares a member with one) is resolved into
 * the same signed union-find as the seeds — the correct, deterministic
 * semantics, not a naive overlay.
 *
 * Returns {@link ANTONYM_INDEX} unchanged when there are no doc pairs, so the
 * default path pays nothing. Throws (via `buildAntonymIndex`) if a doc pair
 * introduces an inconsistent polarity cycle; callers that cannot tolerate a
 * throw at check time should validate the pair set at write time (the CLI does)
 * and fall back to the seed-only index.
 */
export function buildAntonymIndexWithDoc(
  docPairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, AntonymEntry> {
  if (docPairs.length === 0) return ANTONYM_INDEX
  return buildAntonymIndex([...SEED_ANTONYM_PAIRS, ...docPairs])
}
