/**
 * THE UNIFIED CODE CATALOG — one lookup across every stable code (spec AC-A-3).
 *
 * ## The gap this closes
 *
 * G1 shipped `explain <code>` over the 21 `ERR_*` classes only, which was honest
 * for a build whose operations could not emit a finding. G2b then published all
 * three catalogs in the manifest (`errorCodes` / `findingCodes` / `lintCodes`,
 * commit 83d32b1) — so an agent could LIST `FND_CONTRADICTION` but not EXPLAIN it,
 * and the two codes families it actually branches on in a fix loop were exactly the
 * two `explain` did not know. Worse, a miss reported did-you-mean over 21 of the then-75
 * candidates, so `explain GTWR_R7_VAGU` answered with a list of `ERR_*` codes.
 *
 * This module is the single lookup: all three catalogs, one row shape, one
 * did-you-mean corpus. `explain` reads it and nothing else.
 *
 * ## Why the row carries `family`, `severity`, and `tier` and not just text
 *
 * An agent explaining a code is deciding what to DO about it, and those three
 * fields answer three different questions the description prose cannot:
 *
 * - `family` says which surface produced it — an `ERR_*` is an operational failure
 *   whose envelope replaces the result, an `FND_*` is a finding INSIDE a successful
 *   `check`, and a `GTWR_*` is a lint rule a `waive` op can suppress. Those have
 *   different remedies, and confusing them is the difference between fixing a
 *   document and fixing an invocation.
 * - `severity` says whether the code is BLOCKING. Only error-severity findings gate
 *   the exit code, and only an error-severity lint finding EXCLUDES its requirement
 *   from the formal tier — so "is this severity error" is the single most
 *   consequential fact about a `GTWR_*`/`FND_*` code.
 * - `tier` says which pipeline stage emitted it, which is what tells an agent
 *   whether fixing it can widen formal coverage.
 *
 * ## Severity is DERIVED, never restated — and where it is honestly UNKNOWN
 *
 * The `FND_*` corpus opens every description with its own severity (`'error — an
 * edge targets a nonexistent requirement UUID.'`), so severity is PARSED from the
 * one string the manifest publishes rather than duplicated in a second table that
 * could disagree with it. `FND_AMBIGUOUS_QUANTIFIER` genuinely says `warn/info`,
 * and that is preserved verbatim as `'warn/info'` rather than collapsed to a guess.
 *
 * `GTWR_*` severity is deliberately `null`, and that is the load-bearing honesty in
 * this module. `donor/lint/codes.ts` documents why: severity is decided PER FINDING
 * at emission time, because the legitimate-exception rules (R26/R32/R35/R16)
 * downgrade contextually — `GTWR_R26_ABSOLUTE` is `error` on a bare absolute and
 * `warn` when a conditional clause qualifies it. A per-code severity table for
 * `GTWR_*` would be a lie in exactly the cases an author most needs the truth, so
 * this reports `null` plus the reason, and points the reader at the finding's own
 * `severity` field.
 */

import { FND_CODES, FndCodeMeta } from '../../domain/engine/formal/codes.ts'
import { GTWR_CODES, GtwrCodeMeta } from '../../domain/engine/lint/codes.ts'
import {
  REACHABILITY_FND_CODES,
  ReachabilityFndCodeMeta,
} from '../../domain/reachability/reachability-codes.ts'
import { runnable } from './command-form.ts'
import { descriptionOf, ERR_CLASSES, tagOf } from './errors.ts'

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Which of the three catalogs a code belongs to. */
export type CodeFamily = 'ERR' | 'FND' | 'GTWR'

/**
 * One unified catalog row — everything `explain` reports about one code.
 *
 * `meaning` / `suggestions` / `example` are all PROJECTIONS of `description`, split
 * at the markers the donor corpora already carry. No second corpus exists, so a
 * description edit changes every field here at once and none of them can drift from
 * the manifest's published text.
 */
export interface CodeEntry {
  /** The stable code an agent switches on. */
  readonly code: string
  /** Which catalog it came from. */
  readonly family: CodeFamily
  /**
   * The finding severity, when the code has ONE.
   *
   * `null` for every `ERR_*` (an operational failure has no finding severity — it
   * has an exit code, which is always 2) and for every `GTWR_*` (contextual per
   * finding; see the module header). A string for `FND_*`, verbatim from the corpus
   * — including the genuine `'warn/info'` of `FND_AMBIGUOUS_QUANTIFIER`.
   */
  readonly severity: string | null
  /** Which pipeline stage emits it, or `null` when the code is not a finding. */
  readonly tier: string | null
  /** The full single-sourced catalog text, verbatim. The manifest's own bytes. */
  readonly description: string
  /** `description` minus the severity prefix and the `Suggestion:` tail. */
  readonly meaning: string
  /**
   * The remediation clauses. Empty when the text carries none — which is itself
   * informative: `FND_CONTRADICTION` has no suggestion because the remedy is to
   * change the document's meaning, not to run a command.
   */
  readonly suggestions: readonly string[]
  /**
   * A worked micro-example, when the catalog text carries one. Absent (not an empty
   * string) otherwise, so a consumer can tell "no example exists" from "the example
   * is blank". 11 codes carry one; see {@link extractExample}.
   */
  readonly example?: string
  /** Every runnable `symspec …` invocation the text names, in order. */
  readonly commands: readonly string[]
  /** Why `severity` is `null`, when it is and the reason is not simply "not a
   * finding". Present only for `GTWR_*`. */
  readonly severityNote?: string
}

// ---------------------------------------------------------------------------
// The description parsers
// ---------------------------------------------------------------------------

/**
 * The `FND_*` severity prefix: `'error — …'`, `'warn — …'`, `'info — …'`, or the
 * one genuine `'warn/info — …'`.
 *
 * An em dash, not a hyphen — the corpus uses U+2014, and a hyphen-only pattern
 * matches nothing (probed against every FND_* description: all parse, which is what
 * makes this safe to rely on rather than a best effort).
 */
const FND_SEVERITY_PREFIX = /^(error|warn|info|warn\/info)\s+—\s+/

/** The remediation marker every ERR_* description carries. */
const SUGGESTION_MARKER = /\s*Suggestion:\s*/

/** A backticked `symspec …` invocation. */
const SYMSPEC_COMMAND = /`(symspec [^`]+)`/g

/**
 * A parenthesized `(e.g. …)` illustration, or a `such as "x" / "y"` enumeration.
 *
 * These are the two shapes the donor corpora actually use, verified by probing all
 * 80 descriptions: 11 carry one (3 `FND_*` with `e.g.`, 1 `GTWR_*` with `e.g.`, 7
 * `GTWR_*` with `such as`) and the rest carry none. A third shape does not exist,
 * so this is exhaustive rather than a sample — and a future description that
 * invents one loses its example silently, which is why `catalog.test.ts` pins the
 * COUNT of codes carrying an example.
 *
 * ## The `etc.` trap, caught by that count
 *
 * `EXAMPLE_SUCH_AS` was first written to stop at the sentence period with a
 * `[^.(]+?` body. That made ONE entry unreachable — `GTWR_R9_OPEN_ENDED`, whose
 * example is `"including but not limited to" / "etc."`, i.e. an example that ENDS in
 * a period. The extractor found 10 of 11 and nothing threw. This is the same species
 * as the `lexicon-entries-need-per-entry-reachability-tests` lesson (a trailing `\b`
 * after an entry ending in `.` can never match, which killed R9's canonical INCOSE
 * exemplar in the donor), and it landed on the SAME rule.
 *
 * The fix anchors on the description's TAIL instead: every `GTWR_*` description ends
 * with its `(R<n>).` citation, so the example is everything between `such as` and
 * that citation — which terminates on structure rather than on a character class the
 * content may legitimately contain.
 */
const EXAMPLE_PARENTHETICAL = /\(e\.g\.,?\s*([^)]+)\)/
const EXAMPLE_SUCH_AS = /\bsuch as\s+(.+?)\s*(?:\(R\d+\)\.?\s*$|$)/

/** Pull the worked example out of a description, or `undefined` when it has none. */
const extractExample = (description: string): string | undefined => {
  const parenthetical = EXAMPLE_PARENTHETICAL.exec(description)
  if (parenthetical?.[1] !== undefined) return parenthetical[1].trim()
  const suchAs = EXAMPLE_SUCH_AS.exec(description)
  if (suchAs?.[1] !== undefined) return suchAs[1].trim()
  return undefined
}

/**
 * Every runnable `symspec …` invocation in a description, in order, deduplicated.
 *
 * Normalized through {@link runnable} because this list is published as `commands` —
 * the field `symspec explain` hands an agent that does not recognise a code, which is
 * the one moment it is least able to tell a working invocation from a broken one. The
 * vendored descriptions spell the three side tables with `import`'s `add`; see
 * `kernel/command-form.ts`. Deduplication happens AFTER the rewrite, so two spellings
 * of one command collapse to a single entry.
 */
const extractCommands = (description: string): readonly string[] => {
  const found: string[] = []
  for (const match of description.matchAll(SYMSPEC_COMMAND)) {
    const command = match[1]
    if (command === undefined) continue
    const normalized = runnable(command)
    if (!found.includes(normalized)) found.push(normalized)
  }
  return found
}

/**
 * Split a description into its meaning and its `Suggestion:` clauses.
 *
 * The same split `explainCode` has always applied to `ERR_*`, hoisted here so all
 * three families go through one parser. A description with no marker yields the
 * whole text as the meaning and no suggestions, which is the correct outcome for
 * most of the `FND_*`/`GTWR_*` corpus.
 */
const splitSuggestions = (
  description: string,
): { readonly meaning: string; readonly suggestions: readonly string[] } => {
  const [meaning, ...rest] = description.split(SUGGESTION_MARKER)
  return {
    meaning: (meaning ?? '').trim(),
    suggestions: rest.map((s) => s.trim()).filter((s) => s.length > 0),
  }
}

/**
 * Assemble the shared projections of one description into a row's tail.
 *
 * `meaning`, `suggestions` and `example` stay VERBATIM. Only `commands` is normalized to
 * the runnable form (see {@link extractCommands}), and the asymmetry is deliberate:
 * `description` is byte-pinned to the vendored corpus by `catalog.test.ts`, so rewriting the
 * prose here would leave `meaning` disagreeing with the `description` beside it in the same
 * `explain` output. Prose quotes the corpus; `commands` is the field an agent runs.
 */
const projectionsOf = (
  description: string,
): Pick<CodeEntry, 'meaning' | 'suggestions' | 'commands'> & { readonly example?: string } => {
  const { meaning, suggestions } = splitSuggestions(description)
  const example = extractExample(description)
  return {
    meaning,
    suggestions,
    commands: extractCommands(description),
    // ABSENT, not `undefined` — `exactOptionalPropertyTypes` distinguishes them and
    // an absent key is what "this code has no example" should serialize as.
    ...(example !== undefined ? { example } : {}),
  }
}

// ---------------------------------------------------------------------------
// The FND tier map — the one place a code's producing stage is recorded
// ---------------------------------------------------------------------------

/**
 * Which `CheckTier` emits each `FND_*` code, read off the pipeline's own emission
 * sites (`donor/pipeline/check.ts`).
 *
 * Hand-mapped and `satisfies`-bound rather than derived, because the pipeline
 * assigns `tier` as a literal at each `findings.push` site and there is no runtime
 * artifact to read it from without running a check. The bound makes it EXHAUSTIVE:
 * appending an `FND_*` code without deciding its tier does not compile.
 *
 * Two entries are worth reading twice, because both look wrong and are right:
 *
 * - `FND_EXACT_DUPLICATE` is `'lint'`, not `'formal'`. The free-tier duplicate
 *   detector runs before symbolization, and the pipeline tags its projection
 *   `tier: 'lint'` (check.ts:1160).
 * - `FND_EXCLUDED_FROM_FORMAL` is `'structural'`, not `'formal'`. It is a GATE-phase
 *   coverage disclosure about a requirement the solver never saw — tagging it
 *   `'formal'` would imply the SMT layer reasoned about it, which is the opposite of
 *   what the code means (check.ts:1186 says so explicitly).
 *
 * The four ambiguity codes are `'lint'` because `detectAmbiguity` runs on the
 * default path alongside GtWR, before the gate.
 */
const FND_TIER = {
  FND_DANGLING_REFERENCE: 'structural',
  FND_MISSING_TRIGGER: 'structural',
  FND_MISSING_PRECONDITION: 'structural',
  FND_CYCLE: 'structural',
  FND_ORPHAN: 'structural',
  FND_EXACT_DUPLICATE: 'lint',
  FND_CONTRADICTION: 'formal',
  FND_SUBSUMPTION: 'formal',
  FND_REDUNDANCY: 'formal',
  FND_VACUITY: 'formal',
  FND_SIMILAR_UNUNIFIED: 'formal',
  FND_NEEDS_REVIEW: 'formal',
  FND_INCOMPLETE: 'formal',
  FND_CERTIFIED: 'formal',
  FND_CERTIFY_FAILED: 'formal',
  FND_SIMILAR_SEMANTIC: 'formal',
  FND_NUMERIC_CONTRADICTION: 'formal',
  FND_LEAF_UNVERIFIABLE: 'structural',
  FND_MISSING_TRACE_LINK: 'formal',
  FND_DUPLICATE_CLUSTER: 'formal',
  FND_AMBIGUOUS_VAGUE: 'lint',
  FND_AMBIGUOUS_QUANTIFIER: 'lint',
  FND_AMBIGUOUS_REFERENCE: 'lint',
  FND_AMBIGUITY_NEEDS_JUDGMENT: 'lint',
  FND_TEMPORAL_CONTRADICTION: 'formal',
  FND_NO_PAIRS_CHECKED: 'formal',
  FND_OPPOSITION_CANDIDATE: 'formal',
  FND_EXCLUDED_FROM_FORMAL: 'structural',
  FND_QUANTITY_ALIAS_CANDIDATE: 'formal',
  FND_RELATIONAL_UNCHECKED: 'formal',
} as const satisfies Record<(typeof FND_CODES)[number], 'structural' | 'lint' | 'formal'>

/**
 * The G4 reachability codes' tier — all `'formal'`, because the reachability tier IS the
 * formal tier's unbounded half: it runs Z3 over the document's declared semantics.
 *
 * A separate table from {@link FND_TIER} rather than an extension of it, because the two
 * families have different PROVENANCE: `FND_TIER` is keyed on the engine's
 * `FND_CODES` (whose `satisfies` bound makes it exhaustive over a transplanted list), and
 * widening that key would break the exhaustiveness guarantee that makes it useful.
 */
const REACHABILITY_TIER = {
  FND_REACHABILITY_VIOLATED: 'formal',
  FND_REACHABILITY_PROVED: 'formal',
  FND_REACHABILITY_UNDER_HYPOTHESES: 'formal',
  FND_REACHABILITY_UNKNOWN: 'formal',
  FND_REACHABILITY_NOT_CHECKED: 'formal',
  FND_REACHABILITY_VACUOUS_INITIAL: 'formal',
} as const satisfies Record<(typeof REACHABILITY_FND_CODES)[number], 'formal'>

/**
 * Why a `GTWR_*` row reports no severity. Single-sourced here so `explain`, the
 * craft corpus, and the generated AGENTS.md all quote ONE sentence.
 */
export const GTWR_SEVERITY_NOTE =
  'GtWR severity is decided PER FINDING at emission time, not per code: the ' +
  'legitimate-exception rules (R16/R26/R32/R35) downgrade contextually — an absolute ' +
  'qualified by a conditional clause is `warn` where a bare one is `error`. Read the ' +
  "finding's own `severity` field; only error-severity findings gate the exit code and " +
  'exclude their requirement from the formal tier.'

// ---------------------------------------------------------------------------
// Building the three families
// ---------------------------------------------------------------------------

/** The 21 `ERR_*` rows. Severity is `null`: an operational failure has an EXIT
 * CODE (always 2), not a finding severity. */
const errRows = (): readonly CodeEntry[] =>
  ERR_CLASSES.map((cls) => {
    const description = descriptionOf(cls)
    return {
      code: tagOf(cls),
      family: 'ERR' as const,
      severity: null,
      tier: null,
      description,
      ...projectionsOf(description),
    }
  })

/** The 30 `FND_*` rows, with severity PARSED from the corpus text. */
const fndRows = (): readonly CodeEntry[] =>
  FND_CODES.map((code) => {
    const description = FndCodeMeta[code].description
    const prefix = FND_SEVERITY_PREFIX.exec(description)
    // Every one of the 30 parses (pinned in `catalog.test.ts`), so a null here means
    // a new code broke the corpus convention — reported as an honest `null` rather
    // than a defaulted 'info', which would understate a real error-severity code.
    const severity = prefix?.[1] ?? null
    const projections = projectionsOf(
      // Strip the severity prefix before splitting, so `meaning` is the sentence and
      // not `'error — the sentence'` with the severity said twice.
      description.replace(FND_SEVERITY_PREFIX, ''),
    )
    return {
      code,
      family: 'FND' as const,
      severity,
      tier: FND_TIER[code],
      // The FULL text, prefix included — this is the manifest's own bytes and must
      // stay verbatim.
      description,
      ...projections,
    }
  })

/** The 24 `GTWR_*` rows. Severity is `null` WITH a reason; see the module header. */
const gtwrRows = (): readonly CodeEntry[] =>
  GTWR_CODES.map((code) => {
    const description = GtwrCodeMeta[code].description
    return {
      code,
      family: 'GTWR' as const,
      severity: null,
      severityNote: GTWR_SEVERITY_NOTE,
      tier: 'lint',
      description,
      ...projectionsOf(description),
    }
  })

/**
 * The 5 G4 `FND_REACHABILITY_*` rows, parsed by the SAME parsers as the transplanted
 * families.
 *
 * That shared parsing is why `reachability-codes.ts` writes its descriptions in the
 * donor's format (severity prefix with an em dash, trailing `Suggestion:`): one parser
 * over one convention, rather than a second corpus with its own reader that could
 * disagree about what a description means.
 */
const reachabilityRows = (): readonly CodeEntry[] =>
  REACHABILITY_FND_CODES.map((code) => {
    const description = ReachabilityFndCodeMeta[code].description
    const prefix = FND_SEVERITY_PREFIX.exec(description)
    const severity = prefix?.[1] ?? null
    return {
      code,
      family: 'FND' as const,
      severity,
      tier: REACHABILITY_TIER[code],
      description,
      ...projectionsOf(description.replace(FND_SEVERITY_PREFIX, '')),
    }
  })

/**
 * Every code, in FAMILY order (`ERR_*`, then `FND_*`, then `GTWR_*`), each family in
 * its own append-only order.
 *
 * A FUNCTION, not a module-level constant: it calls `tagOf`/`descriptionOf`, and an
 * eagerly-evaluated const calling those would sit in the temporal dead zone across
 * the module boundary — a `ReferenceError` at import that `tsc --noEmit` does not
 * catch (G1 delta #13, which cost a vitest import crash).
 */
export const allCodes = (): readonly CodeEntry[] => [
  ...errRows(),
  // The two FND sources in provenance order: the engine's transplanted 30, then v5's own 5.
  // Both report `family: 'FND'`, so an agent sees ONE finding-code vocabulary and cannot
  // tell (or need to tell) which file the bytes live in.
  ...fndRows(),
  ...reachabilityRows(),
  ...gtwrRows(),
]

/** Every code string, in the same order. The did-you-mean corpus. */
export const allCodeStrings = (): readonly string[] => allCodes().map((row) => row.code)

/**
 * Look one code up across all three catalogs. `undefined` for an unknown code —
 * the caller decides whether that is an `ErrNotFound`.
 *
 * Case-SENSITIVE, deliberately: the codes are the wire vocabulary, and silently
 * accepting `err_io` would teach an agent a spelling the envelope never uses.
 */
export const lookupCode = (code: string): CodeEntry | undefined =>
  allCodes().find((row) => row.code === code)

/**
 * Codes closest to a misspelling, across ALL 80 — the did-you-mean corpus.
 *
 * Same deterministic ranking `nearestCodes` used over the 21: shared leading prefix
 * first (so `GTWR_R7_VAGU` suggests `GTWR_R7_VAGUE` before anything else), then
 * shared `_`-token overlap, then a stable alphabetical tiebreak. Determinism matters
 * because these strings land in an envelope an agent may diff.
 *
 * The FAMILY PREFIX is what makes widening the corpus safe rather than noisy: a
 * misspelled `FND_*` shares 4 leading characters with every other `FND_*` and 0 with
 * any `ERR_*`, so cross-family suggestions only appear when nothing in the right
 * family is close at all.
 */
export const nearestCodesAll = (code: string, limit = 3): readonly string[] => {
  const target = code.toUpperCase()
  const tokens = new Set(target.split('_').filter((t) => t.length > 0))
  const sharedPrefix = (a: string, b: string): number => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  return allCodeStrings()
    .map((candidate) => ({
      candidate,
      prefix: sharedPrefix(target, candidate),
      overlap: candidate.split('_').filter((t) => tokens.has(t)).length,
    }))
    .filter((s) => s.prefix > 0 || s.overlap > 0)
    .sort(
      (a, b) =>
        b.prefix - a.prefix || b.overlap - a.overlap || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, limit)
    .map((s) => s.candidate)
}

/** How many codes the catalog holds, per family — for the manifest's own assertion
 * and for the tests that pin the per-family split. */
export const catalogCounts = (): {
  readonly ERR: number
  readonly FND: number
  readonly GTWR: number
  readonly total: number
} => {
  const rows = allCodes()
  const count = (family: CodeFamily) => rows.filter((r) => r.family === family).length
  return {
    ERR: count('ERR'),
    FND: count('FND'),
    GTWR: count('GTWR'),
    total: rows.length,
  }
}
