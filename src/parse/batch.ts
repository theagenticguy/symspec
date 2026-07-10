/**
 * Batch parse over multi-line input (AC-2-9).
 *
 * An agent "overwhelmingly feeds bullet lists" and multi-sentence input rather
 * than one requirement at a time (research-nlparse.md §1.5, §6; agent-ux
 * critique). This module is the pure core of `symspec parse --file <path>` /
 * `--stdin`: it takes the already-read TEXT (the CLI integrator owns reading a
 * file or draining stdin) and returns the AC-2-9 payload — one
 * {@link ParseResult} per requirement line plus a `{ ok, skipped, error }`
 * summary count. Single-string parse (a positional argument) is just the
 * one-element case of this contract, so the CLI can route both shapes here.
 *
 * ## Line handling (research-nlparse.md §1.5)
 *
 * Input is split on newlines and each non-empty line is treated as one
 * candidate requirement. Two classes of line carry no requirement and are
 * DROPPED entirely (they never appear in `results` and never move a summary
 * counter):
 *
 *   - **blank lines** — whitespace-only separators between requirements;
 *   - **comment lines** — a line whose first non-whitespace character is `#`
 *     (shell-style annotations and Markdown headings an agent leaves in a
 *     `requirements.md`).
 *
 * Every remaining line has its leading list marker stripped (`- `, `* `, `+ `,
 * or an ordered `1.`/`1)` marker — agents feed bullet lists) and is handed to
 * {@link parseLine}. The per-line outcome is exactly the AC-2-8 union: `ok`
 * (a usable slot set), `skipped` (a no-modal prose bullet — a requirement-shaped
 * line that carries no obligation, distinct from an error), or `error` (a
 * Tier-3 `ERR_PARSE_*` failure). The distinction matters: dropped comment/blank
 * lines are structure, whereas a no-modal BULLET is content the agent wrote and
 * so is reported as `skipped` so it is not silently lost.
 *
 * ## Scope boundary
 *
 * Pure and I/O-free: no file reads, no stdin, no envelope wrapping. The CLI
 * integrator (AC-2-9 CLI wiring) reads `--file`/`--stdin` into a string, calls
 * {@link parseBatch}, and wraps the returned `{ results, summary }` in the
 * AC-6-2 `{ apiVersion, type, data }` success envelope. This module owns only
 * the line-splitting policy and the fan-out over {@link parseLine}.
 *
 * Cite: AC-2-9 (batch `results[] + summary`); AC-2-8 (per-line `ParseResult`);
 * research-nlparse.md §1.5 (list-marker/one-line-per-requirement), §6
 * (no-modal → skipped, not error).
 */

import { z } from 'zod'
import { type ParseResult, ParseResultSchema, parseLine } from './result.js'
import type { Tier2Options } from './tier2.js'

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Per-outcome tallies over a batch's `results`. Every result increments exactly one field. */
export const BatchSummarySchema = z.object({
  /** Count of `outcome: 'ok'` results. */
  ok: z.number().int().nonnegative(),
  /** Count of `outcome: 'skipped'` (no-modal prose) results. */
  skipped: z.number().int().nonnegative(),
  /** Count of `outcome: 'error'` (Tier-3 `ERR_PARSE_*`) results. */
  error: z.number().int().nonnegative(),
})

/** The AC-2-9 payload: the ordered per-line results and their summary counts. */
export const BatchParseResultSchema = z.object({
  results: z.array(ParseResultSchema),
  summary: BatchSummarySchema,
})

/** Per-outcome tallies over a batch's `results`. */
export interface BatchSummary {
  readonly ok: number
  readonly skipped: number
  readonly error: number
}

/**
 * The AC-2-9 batch payload — the `data` an agent receives from
 * `symspec parse --file`/`--stdin`. `results` preserves input line order (blank
 * and comment lines excluded); `summary` is a tally over `results`.
 */
export interface BatchParseResult {
  readonly results: readonly ParseResult[]
  readonly summary: BatchSummary
}

// ---------------------------------------------------------------------------
// Line policy (pure helpers)
// ---------------------------------------------------------------------------

/** A whitespace-only line — a separator, not a requirement. */
function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** A comment/heading line (first non-space char is `#`) — dropped, not parsed. */
function isComment(line: string): boolean {
  return line.trimStart().startsWith('#')
}

/**
 * A leading list marker: an unordered bullet (`-`, `*`, `+`) or an ordered
 * marker (`1.`, `2)`), each followed by whitespace OR ending the line (a lone
 * marker). Requiring whitespace/end keeps a bare requirement ID like `3.1.4)`
 * (whose `.`/`)` is followed by more digits, not a space) out — REQ-ID stripping
 * is `preprocess`'s job inside the ladder, not a list marker here.
 */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])(?:\s+|$)/

/** Strip one leading list marker from a line, leaving the requirement text. */
export function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER, '')
}

/**
 * Split raw batch text into the candidate requirement lines to parse. Blank
 * and comment lines are dropped; every survivor has its list marker stripped.
 * A line that is nothing BUT a marker (e.g. a lone `-`) reduces to blank and is
 * likewise dropped. Pure and deterministic.
 */
export function candidateLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !isBlank(line) && !isComment(line))
    .map(stripListMarker)
    .filter((line) => !isBlank(line))
}

/** Tally a list of results by `outcome`. */
export function summarize(results: readonly ParseResult[]): BatchSummary {
  const summary = { ok: 0, skipped: 0, error: 0 }
  for (const result of results) summary[result.outcome] += 1
  return summary
}

// ---------------------------------------------------------------------------
// The batch driver
// ---------------------------------------------------------------------------

/**
 * Parse multi-line batch text into the AC-2-9 `{ results, summary }` payload.
 *
 * Each requirement line (blank and comment lines dropped, list markers
 * stripped) is run through the full Tier-1 → Tier-2 → Tier-3 ladder via
 * {@link parseLine}, in input order. `opts` is threaded to every line so tests
 * inject a fake Tier-2 loader and the AC-2-6 clean-path gate is preserved.
 * Lines are parsed sequentially so the wink-nlp model (when a line escalates)
 * loads at most once and results stay deterministically ordered.
 *
 * @example
 * const { results, summary } = await parseBatch(
 *   'The API shall reject expired tokens\n- improve responsiveness\nThe API shall log and audit',
 * )
 * // results.length === 3; summary === { ok: 1, skipped: 1, error: 1 }
 */
export async function parseBatch(text: string, opts: Tier2Options = {}): Promise<BatchParseResult> {
  const lines = candidateLines(text)
  const results: ParseResult[] = []
  for (const line of lines) {
    results.push(await parseLine(line, opts))
  }
  return { results, summary: summarize(results) }
}
