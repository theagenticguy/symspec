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
 *     NOT stemming/lemmatization. It ships with exactly the 15 seed pairs the
 *     spec pins and is meant to grow only by an explicit edit to this seed set
 *     (AC-4-12), never by fuzzy expansion at runtime.
 *   - Unification requires the leading verb to match AND the object remainder to
 *     be identical after normalization (see atomize.ts): "grant access" unifies
 *     with "revoke access" but not with "revoke permission".
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
 * The 15 seed antonym pairs (AC-4-2a). Each `[a, b]` asserts that `a` and `b`
 * are polar opposites — a response led by `a` and one led by `b` (with the same
 * object remainder) resolve to the same atom with opposite polarity.
 *
 * Append-only in spirit: the seed set is a documented contract surface. Grow it
 * by editing this array, do not silently reorder or drop pairs.
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
