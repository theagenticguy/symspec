/**
 * The `glossary` command core (AC-9-6): manage the document's committed synonym
 * groups — the DECIDE half of the semantic tier. Agent-confirmed merges live
 * here, in the doc, so the deterministic SMT verdict path canonicalizes
 * response atoms through them (AC-9-2/9-3).
 *
 * Pure and I/O-free like the other command cores (`add`/`update`): each op
 * takes the loaded document and returns `{next?, envelope}` — the mutated
 * document (only on a mutating success) plus the typed envelope to emit. The
 * command wiring loads, calls, saves on `next`, and emits.
 *
 * `add` is idempotent (adding an existing alias is a no-op success); `remove`
 * of an absent alias is a no-op success; `list` never mutates. Aliases are
 * grouped under a canonical phrase; adding an alias to a new canonical creates
 * the group.
 */

import type { GlossaryEntry, RequirementsDoc } from '../core/schema.js'
import type { Envelope } from './envelope.js'
import { success } from './envelope.js'
import { usageError } from './errors.js'

/** The usage line glossary `ERR_USAGE` suggestions cite. */
export const GLOSSARY_USAGE = 'symspec glossary <add|remove|list> [canonical] [alias]'

/** `data` payload of a glossary envelope. */
export interface GlossaryData {
  readonly action: 'added' | 'removed' | 'listed' | 'noop'
  readonly glossary: GlossaryEntry[]
}

/** Result of a glossary op: envelope always, `next` only on a mutating success. */
export type GlossaryResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<GlossaryData> }
  | { readonly envelope: Envelope<GlossaryData> }

/** Deep-copy the glossary so a returned `next` never aliases the input's array. */
function cloneGlossary(glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  return glossary.map((e) => ({ canonical: e.canonical, aliases: [...e.aliases] }))
}

/** List the glossary (no mutation). */
export function glossaryList(doc: RequirementsDoc): GlossaryResult {
  return {
    envelope: success('glossary', { action: 'listed', glossary: cloneGlossary(doc.glossary) }),
  }
}

/**
 * Add `alias` under `canonical`. Idempotent: if the alias already sits under
 * that canonical, it is a no-op success. Creates the canonical group if absent.
 */
export function glossaryAdd(
  doc: RequirementsDoc,
  canonical: string,
  alias: string,
): GlossaryResult {
  const c = canonical.trim()
  const a = alias.trim()
  if (c.length === 0 || a.length === 0) {
    return {
      envelope: usageError(
        'glossary add requires a non-empty <canonical> and <alias>',
        GLOSSARY_USAGE,
      ) as Envelope<GlossaryData>,
    }
  }

  const glossary = cloneGlossary(doc.glossary)
  const entry = glossary.find((e) => e.canonical === c)
  if (entry !== undefined) {
    if (entry.aliases.includes(a)) {
      return { envelope: success('glossary', { action: 'noop', glossary }) }
    }
    entry.aliases.push(a)
  } else {
    glossary.push({ canonical: c, aliases: [a] })
  }
  return {
    next: { ...doc, glossary },
    envelope: success('glossary', { action: 'added', glossary }),
  }
}

/**
 * Remove `alias` from `canonical`'s group. No-op success if the canonical or
 * alias is absent. An emptied group (no aliases left) is dropped entirely.
 */
export function glossaryRemove(
  doc: RequirementsDoc,
  canonical: string,
  alias: string,
): GlossaryResult {
  const c = canonical.trim()
  const a = alias.trim()
  const glossary = cloneGlossary(doc.glossary)
  const entry = glossary.find((e) => e.canonical === c)
  if (entry === undefined || !entry.aliases.includes(a)) {
    return { envelope: success('glossary', { action: 'noop', glossary }) }
  }
  entry.aliases = entry.aliases.filter((x) => x !== a)
  const pruned = glossary.filter((e) => e.aliases.length > 0)
  return {
    next: { ...doc, glossary: pruned },
    envelope: success('glossary', { action: 'removed', glossary: pruned }),
  }
}
