/**
 * Batch parse over multi-line input — the pure core of `parse --file` / stdin.
 *
 * ## Why this file is EDITED rather than copied verbatim
 *
 * Same reason as `./result.ts`: v4 original's only non-verbatim content is
 * two Zod schemas (`BatchSummarySchema`, `BatchParseResultSchema`) with no non-test
 * consumers, and the greenfield does not port Zod. The line policy — the part that
 * actually decides what gets parsed — is carried over exactly, because it encodes
 * how agents really write requirement files.
 *
 * ## The line policy, and why each rule earns its place
 *
 * An agent "overwhelmingly feeds bullet lists" rather than one requirement at a
 * time, so the policy is about surviving a real `requirements.md`:
 *
 * - **Blank lines are DROPPED entirely** — separators, not content. They never
 *   appear in `results` and never move a counter.
 * - **Comment lines (`#`) are DROPPED entirely** — shell annotations and Markdown
 *   headings an agent leaves in place.
 * - **A leading list marker is STRIPPED** (`- `, `* `, `+ `, `1.`, `1)`), because
 *   the bullet is formatting and the text after it is the requirement.
 * - **A no-modal BULLET is `skipped`, not dropped.** This is the distinction that
 *   is easy to collapse and costly to get wrong: a dropped line is STRUCTURE (the
 *   author did not write a requirement there), whereas a bullet carrying prose is
 *   CONTENT the author wrote. Reporting it as `skipped` means an agent can see "you
 *   wrote 12 bullets and 3 of them are not requirements" instead of silently
 *   getting 9 results for 12 lines.
 *
 * The marker regex requires whitespace-or-end after the marker, which is what keeps
 * a bare requirement ID like `3.1.4)` out of it (its `.`/`)` is followed by digits,
 * not a space). REQ-ID stripping is `preprocess`'s job inside the ladder.
 *
 * Pure and I/O-free: no file reads, no stdin, no envelope. The operation reads the
 * text and wraps the result; this module owns only the splitting policy and the
 * fan-out.
 */

import { type ParseResult, parseLine } from './result.ts'
import { defaultTier2Loader, type Tier2Loader, type Tier2Options } from './tier2.ts'

/** Per-outcome tallies over a batch's `results`. Every result increments exactly
 * one field, so `ok + skipped + error === results.length` always. */
export interface BatchSummary {
  readonly ok: number
  readonly skipped: number
  readonly error: number
}

/** The batch payload: the ordered per-line results and their summary counts. */
export interface BatchParseResult {
  readonly results: readonly ParseResult[]
  readonly summary: BatchSummary
}

/** A whitespace-only line — a separator, not a requirement. */
const isBlank = (line: string): boolean => line.trim() === ''

/** A comment/heading line (first non-space char is `#`) — dropped, not parsed. */
const isComment = (line: string): boolean => line.trimStart().startsWith('#')

/**
 * A leading list marker: an unordered bullet (`-`, `*`, `+`) or an ordered marker
 * (`1.`, `2)`), each followed by whitespace OR ending the line (a lone marker).
 * Requiring whitespace-or-end keeps a bare requirement ID like `3.1.4)` out.
 */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])(?:\s+|$)/

/** Strip one leading list marker, leaving the requirement text. */
export const stripListMarker = (line: string): string => line.replace(LIST_MARKER, '')

/**
 * Split raw batch text into the candidate requirement lines to parse. Blank and
 * comment lines are dropped; every survivor has its marker stripped. A line that is
 * nothing BUT a marker (a lone `-`) reduces to blank and is likewise dropped.
 */
export const candidateLines = (text: string): readonly string[] =>
  text
    .split(/\r?\n/)
    .filter((line) => !isBlank(line) && !isComment(line))
    .map(stripListMarker)
    .filter((line) => !isBlank(line))

/** Tally a list of results by `outcome`. */
export const summarize = (results: readonly ParseResult[]): BatchSummary => {
  const summary = { ok: 0, skipped: 0, error: 0 }
  for (const result of results) summary[result.outcome] += 1
  return summary
}

/**
 * Load the wink analyzer AT MOST ONCE for a whole batch — a DONOR BUG FIX, and the
 * one behavioral change in this file.
 *
 * ## The bug, measured
 *
 * `runTier2` calls `opts.load ?? defaultTier2Loader` PER LINE, and
 * `defaultTier2Loader` constructs a fresh `winkNLP(model)` every call. v4's
 * header claims the model "loads at most once" — but nothing memoizes it, and per
 * line was fine only because no v4 test ever escalated more than a handful of
 * lines in one process.
 *
 * `winkNLP(model)` accumulates state that is never released. Probed directly:
 *
 *   for (let i = 1; i <= 200; i++) winkNLP(model)
 *   // => RangeError: Invalid string length, at load 21
 *
 * (inside `wink-eng-lite-web-model`'s `load-cer-meta-model.js`, which appends to a
 * string that eventually exceeds V8's maximum length). So v4's `parse --file`
 * DIES on the 21st escalating line of a real requirements file — and the failure is
 * a `RangeError` from inside a dependency, not a parse error, so it aborts the whole
 * batch with no per-line report. A 42-requirement spec with 21 passive sentences is
 * an entirely ordinary input.
 *
 * Confirmed against LIVE v4, not just reasoned about: 30 escalating lines
 * through v4's own `parseBatch` never completes (the loads slow
 * superlinearly as the leaked string grows, then throw).
 *
 * ## The fix, and why it is sound rather than merely effective
 *
 * Resolve the loader ONCE per batch and hand every line the SAME analyzer. Sound
 * because a wink analyzer is stateless with respect to `readDoc` — probed: 500
 * sequential `readDoc` calls on one shared analyzer produce correct tags with no
 * degradation, in 22ms total versus ~62ms for a single fresh load. So sharing is
 * both the correctness fix and a ~3x speedup on the escalating path.
 *
 * Still LAZY: the analyzer is resolved on the FIRST line that actually escalates, so
 * a batch of clean sentences loads nothing. That is v4's gating contract, and
 * `parse.test.ts` asserts it by counting loader invocations — which is also how it
 * asserts the "at most once" half that v4 only claimed.
 *
 * A caller that injects `opts.load` gets the same memoization, so a test fake is
 * called once per batch too. That is what makes the invocation count assertable at
 * all.
 */
const memoizedLoader = (load: Tier2Loader): Tier2Loader => {
  // The PROMISE is cached, not the resolved analyzer, so two concurrent escalating
  // lines cannot both start a load. (The loop below is sequential, so this is belt
  // and braces — but a future concurrent caller would otherwise reintroduce the leak
  // silently, which is exactly how this bug got here.)
  let inflight: ReturnType<Tier2Loader> | undefined
  return () => {
    inflight ??= load()
    return inflight
  }
}

/**
 * Parse multi-line batch text into the `{results, summary}` payload.
 *
 * Lines are parsed SEQUENTIALLY, not concurrently, and that is deliberate twice
 * over: results stay in input order so a caller can map result `i` back to the line
 * it came from, and the wink model is a single-instance resource (see
 * {@link memoizedLoader}) rather than something to contend over.
 */
export const parseBatch = async (
  text: string,
  opts: Tier2Options = {},
): Promise<BatchParseResult> => {
  // ONE loader for the whole batch. See `memoizedLoader` for v4 bug this
  // closes.
  const load = memoizedLoader(opts.load ?? defaultTier2Loader)
  const results: ParseResult[] = []
  for (const line of candidateLines(text)) {
    results.push(await parseLine(line, { ...opts, load }))
  }
  return { results, summary: summarize(results) }
}
