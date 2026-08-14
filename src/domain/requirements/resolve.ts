/**
 * REF RESOLUTION — the ONE place a `<ref>` becomes a requirement.
 *
 * ## Why exactly one chokepoint
 *
 * Donor lesson `stable-key-resolution-single-chokepoint`: symspec addresses
 * requirements by minted UUID, but authors want a stable human key ("G1",
 * "TX-B6") usable wherever a UUID is. The donor got that across its whole surface
 * from TWO small edits, because every id-taking command already funneled its raw
 * `<id>` through one guard. Extending THAT guard was O(1) commands instead of
 * O(n), and — the part that actually matters — made it impossible to apply
 * inconsistently.
 *
 * v5 keeps the property by construction: {@link resolveRef} and
 * {@link requireRequirement} are the only functions that turn a ref string into a
 * requirement, and every operation calls one of them. An operation that indexed
 * `doc.requirements[ref]` directly would work for UUIDs and mysteriously fail for
 * keys, which is precisely the inconsistency the single chokepoint prevents.
 *
 * ## UUID first, then key — and why the order is not arbitrary
 *
 * A raw ref is tried as a UUID in the O(1) map FIRST, then scanned for a matching
 * `key`. That order is what lets {@link KEY_PATTERN} stay simple: it does not have
 * to exclude UUID-shaped strings, because a UUID never reaches the key scan.
 *
 * ## The resolved UUID is what callers must persist
 *
 * {@link resolveRef} returns the requirement, whose `id` is the UUID. Every write
 * path must store THAT, never the raw ref: an edge recorded as `"TX-B6"` would
 * fail the document schema's UUID check, and even if it did not, it would break
 * the moment anything renamed. Keys are immutable and unique precisely so a key is
 * as safe to REFERENCE as a UUID — but the stored form is always the UUID.
 */

import { ErrNotFound } from '../../ports/errors.ts'
import type { Requirement, RequirementsDocument } from './document.ts'

/**
 * Resolve a ref (UUID or stable key) to its requirement, or `undefined`.
 *
 * The non-failing form, for callers that want to branch themselves (`init`
 * checking whether a key is already taken, for instance). Callers that want the
 * catalog error use {@link requireRequirement}.
 */
export const resolveRef = (doc: RequirementsDocument, ref: string): Requirement | undefined => {
  // UUID path first: an O(1) map hit, and trying it first is what keeps the key
  // pattern from having to exclude UUID-shaped strings.
  const byId = doc.requirements[ref]
  if (byId !== undefined) return byId
  for (const requirement of Object.values(doc.requirements)) {
    if (requirement.key === ref) return requirement
  }
  return undefined
}

/** Resolve a ref to its UUID, or `undefined`. The form a write path uses, since
 * what it must persist is the UUID and never the raw ref. */
export const resolveId = (doc: RequirementsDocument, ref: string): string | undefined =>
  resolveRef(doc, ref)?.id

/**
 * Every ref an agent could legally have meant, for a did-you-mean suggestion.
 *
 * Keys first (a human typed a key, overwhelmingly), then UUIDs, each sorted so the
 * suggestion list is DETERMINISTIC — these strings land in an envelope an agent
 * may diff between runs, so a stable order is part of the contract, not a nicety.
 */
export const knownRefs = (doc: RequirementsDocument): readonly string[] => {
  const keys: string[] = []
  const ids: string[] = []
  for (const requirement of Object.values(doc.requirements)) {
    if (requirement.key !== undefined) keys.push(requirement.key)
    ids.push(requirement.id)
  }
  return [...keys.sort(), ...ids.sort()]
}

/**
 * Refs closest to a miss, for a did-you-mean suggestion.
 *
 * Ranks by shared leading-prefix length then by case-insensitive equality, which
 * is deliberately cheap rather than a full edit distance: the common miss is a
 * case slip or a truncation (`tx-b6` for `TX-B6`, `TX-B` for `TX-B6`), and a
 * deterministic cheap ranking beats a clever nondeterministic one for a string
 * that goes on the wire. Mirrors `nearestCodes` in the error catalog so the
 * did-you-mean behavior is the same shape everywhere an agent meets it.
 */
export const nearestRefs = (
  doc: RequirementsDocument,
  ref: string,
  limit = 3,
): readonly string[] => {
  const target = ref.toLowerCase()
  const sharedPrefix = (a: string, b: string): number => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1
    return i
  }
  return knownRefs(doc)
    .map((candidate) => ({
      candidate,
      prefix: sharedPrefix(target, candidate.toLowerCase()),
      exactIgnoringCase: candidate.toLowerCase() === target ? 1 : 0,
    }))
    .filter((s) => s.prefix > 0)
    .sort(
      (a, b) =>
        b.exactIgnoringCase - a.exactIgnoringCase ||
        b.prefix - a.prefix ||
        a.candidate.localeCompare(b.candidate),
    )
    .slice(0, limit)
    .map((s) => s.candidate)
}

/**
 * Resolve a ref or fail with `ERR_NOT_FOUND` — THE guard every ref-taking
 * operation funnels through.
 *
 * The failure carries did-you-mean suggestions and a `repair.commands` entry an
 * agent can run verbatim: a near-miss becomes self-correcting rather than a dead
 * end, which is the same treatment `explain` gives an unknown code. On an empty
 * document the suggestion is to create something rather than to look harder, since
 * "did you mean" over zero candidates is noise.
 */
export const requireRequirement = (
  doc: RequirementsDocument,
  ref: string,
): Requirement | ErrNotFound => {
  const found = resolveRef(doc, ref)
  if (found !== undefined) return found

  const total = Object.keys(doc.requirements).length
  if (total === 0) {
    return new ErrNotFound({
      error: `No requirement matches "${ref}" — the document has no requirements at all.`,
      suggestions: [
        'Add a requirement first, or point at a different document.',
        'Run `symspec list` to confirm which document is being read.',
      ],
      repair: { ops: [], commands: ['symspec list'] },
    })
  }

  const near = nearestRefs(doc, ref)
  const suggestions = [
    ...(near.length > 0 ? [`Did you mean: ${near.join(', ')}?`] : []),
    `Run \`symspec list\` to see all ${total} requirement(s) with their keys and UUIDs.`,
  ]
  return new ErrNotFound({
    error: `No requirement matches "${ref}" (tried it as a UUID, then as a stable key).`,
    suggestions,
    repair: {
      ops: [],
      commands:
        near.length > 0 && near[0] !== undefined ? [`symspec show ${near[0]}`] : ['symspec list'],
    },
  })
}
