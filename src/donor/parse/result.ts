/**
 * `ParseResult` — the per-line discriminated union the parse ladder emits, with
 * the donor's `proposedSplits`/`proposedOps` SPLIT resolved (spec AC-A-4).
 *
 * ## Why this file is EDITED rather than copied verbatim
 *
 * One of the transplant's materially-edited files, for two reasons that both come
 * down to a name.
 *
 * The mechanical reason: the donor original is Zod (nine exported schemas, all
 * consumed only by the donor's own tests) plus hand-written interfaces. The
 * greenfield is Effect Schema native and the spec explicitly does not port Zod, so
 * the schemas go and the interfaces stay. Nothing else in the ladder imports them —
 * measured: `ParseSlotsSchema`, `ParseResultSchema`, and friends have exactly zero
 * non-test consumers in the donor.
 *
 * ## THE NAME FIX (spec AC-A-4) — one `proposedOps` everywhere
 *
 * The donor carried the SAME data under TWO names across a layer boundary:
 *
 * - `parse/tier2.ts` produced `ProposedSplit[]` (generic slot shape, no CLI
 *   vocabulary) and `parse/tier3.ts` + `parse/result.ts` forwarded it as
 *   `proposedSplits`;
 * - `cli/add.ts` mapped each split to a `ProposedAddOp` and re-published the array
 *   as `proposedOps` on the error envelope.
 *
 * The rename was deliberate layering — "src/parse/ stays CLI-agnostic" — and it
 * produced a real defect the donor's own AC-3-9 recorded: tier3's suggestion text
 * says "`proposedOps` carries the ready-to-apply `add` ops", but the object tier3
 * returns has no `proposedOps` field. It has `proposedSplits`. So an agent that
 * read the suggestion and looked for the field it named found nothing, on the one
 * error code whose whole point is being machine-actionable.
 *
 * v5 fixes it by construction, and the fix is the opposite of a rename: the layering
 * premise was wrong. `src/parse/` avoided "CLI vocabulary" because in the donor an
 * `add` op WAS CLI vocabulary — `apply`'s JSONL shape lived in `cli/apply.ts`. In
 * v5 the op vocabulary is `core/ops.ts`, a CORE module the CLI is merely one
 * projection of. So the parse ladder emitting `AddOp` records is not a layer
 * violation; it is the ladder speaking the document's own language, and there is
 * nothing left to rename at the boundary.
 *
 * Concretely: {@link ParseErrorResult.proposedOps} carries `AddOp` records, tier3's
 * suggestion text names `proposedOps`, and the field it names is the field that
 * exists. `parse.test.ts` asserts that correspondence directly — a suggestion
 * mentioning a backticked field name must name a field the result actually has.
 *
 * ## Everything else is the donor's, unchanged
 *
 * The three outcomes and the rules that assign them are verbatim in substance:
 *
 * - `ok` — Tier 1 or Tier 2 produced a usable slot set.
 * - `skipped` — no-modal prose (a bullet, a heading, a rationale sentence). NOT an
 *   error, because an agent batch-feeding a whole `requirements.md` must not be
 *   spammed with errors for every non-requirement line.
 * - `error` — a Tier-3 failure with a stable `ERR_PARSE_*` code, the best-effort
 *   `partial` skeleton, and mechanical rewrite suggestions.
 *
 * And the two resolution rules that are easy to get backwards:
 *
 * - a `compound-conjunction` trigger forces `error` with `ERR_PARSE_COMPOUND` EVEN
 *   OVER a nominal Tier-1/Tier-2 success, because a low-confidence guess at which
 *   half of "shall X and Y" was meant is worse than a punt. The recovered slots
 *   still surface in `partial`.
 * - `ERR_PARSE_NO_MODAL` becomes `skipped`, every other code stays `error`. This
 *   module is where that boundary is drawn; tier3 classifies every hard failure
 *   into a code and does not know about the distinction.
 */

import type { AddOp } from '../../core/ops.ts'
import type { Confidence, Tier1Ok, Tier1Slots } from './tier1.ts'
import type { ProposedSplit, Tier2Loader, Tier2Ok, Tier2Options, Tier2Outcome } from './tier2.ts'
import { defaultTier2Loader, runTier2 } from './tier2.ts'
import type { ParseErrorCode, Tier3Envelope } from './tier3.ts'
import { makeTier3Envelope } from './tier3.ts'

export type { ParseErrorCode } from './tier3.ts'
export { PARSE_ERROR_CODES } from './tier3.ts'

// ---------------------------------------------------------------------------
// The three outcomes
// ---------------------------------------------------------------------------

/** A successful parse. `slots` feeds an `add` op directly. */
export interface ParseOkResult {
  readonly outcome: 'ok'
  readonly pattern: Tier1Slots['patternType']
  readonly slots: Tier1Slots
  /** True when the modal carried an explicit negator; `slots.systemResponse` is the
   * POSITIVE atom. Never fold the negation into the response text — that is what
   * lets `shall X` and `shall not X` share one atom at opposite polarity. */
  readonly negated: boolean
  readonly confidence: Confidence
  /** Which ladder rung produced the parse. Tier 3 never succeeds. */
  readonly tier: 1 | 2
  /** Provenance notes (e.g. `nonstandard-modal`, `tier2-repaired-event`). */
  readonly notes: readonly string[]
  /**
   * The ready-to-apply `add` op this parse became — the SUCCESS half of AC-A-4.
   *
   * The donor emitted ops only on the COMPOUND failure path, so an agent that
   * parsed a line successfully still had to assemble the op itself from `slots`
   * plus the top-level `negated` flag (and `cli/add.ts` was the only code that knew
   * to thread that flag, which is exactly the kind of knowledge that gets lost).
   * Emitting the op on the success path too means `parse` output pipes straight into
   * `apply` with no per-field transcription anywhere.
   */
  readonly proposedOp: AddOp
}

/** No-modal prose, ignored as a non-requirement line — NOT an error. */
export interface ParseSkippedResult {
  readonly outcome: 'skipped'
  readonly reason: 'no-modal'
  /** The original input line, trimmed, so a batch caller can map it back. */
  readonly text: string
}

/** A Tier-3 parse failure, projected into the per-line union. */
export interface ParseErrorResult {
  readonly outcome: 'error'
  readonly code: ParseErrorCode
  /** Human-readable description of why parsing failed. */
  readonly error: string
  /** Best-effort slot skeleton — OMITTED (never `undefined`) when nothing was
   * salvaged, so absence is genuinely absence on the wire. */
  readonly partial?: {
    readonly patternType?: Tier1Slots['patternType']
    readonly systemName?: string
    readonly systemResponse?: string
    readonly preCondition?: string
    readonly trigger?: string
  }
  /** Mechanical rewrite suggestions — always at least one. */
  readonly suggestions: readonly string[]
  /**
   * For `ERR_PARSE_COMPOUND` only: the confidently-split single requirements, AS
   * READY-TO-APPLY `add` OPS.
   *
   * ONE NAME (spec AC-A-4). The donor called this `proposedSplits` here and
   * `proposedOps` on the envelope, and tier3's own suggestion text named the latter
   * — so the field the suggestion told an agent to read did not exist on the object
   * the agent had. Absent (not `undefined`) when the split was not confident or the
   * code is not COMPOUND.
   */
  readonly proposedOps?: readonly AddOp[]
}

export type ParseResult = ParseOkResult | ParseSkippedResult | ParseErrorResult

// ---------------------------------------------------------------------------
// Slots → op
// ---------------------------------------------------------------------------

/**
 * Project parsed slots plus a polarity flag onto an `add` op.
 *
 * `id` is deliberately ABSENT so the fold mints a fresh UUID per op — which keeps a
 * proposal deterministic (the same parse always produces the same op bytes) and
 * keeps two applications of one proposal from colliding on an id. `negated` is
 * carried only when TRUE, so the common case produces a minimal record.
 */
export const slotsToAddOp = (slots: Tier1Slots, negated: boolean): AddOp => ({
  op: 'add',
  patternType: slots.patternType,
  systemName: slots.systemName,
  systemResponse: slots.systemResponse,
  ...(negated ? { negated: true } : {}),
  ...(slots.preCondition !== undefined ? { preCondition: slots.preCondition } : {}),
  ...(slots.trigger !== undefined ? { trigger: slots.trigger } : {}),
})

/** Project one compound-split proposal onto an `add` op. The split carries its OWN
 * polarity, so "shall not X and Y" splits its polarity per half. */
const splitToAddOp = (split: ProposedSplit): AddOp =>
  slotsToAddOp(
    {
      patternType: split.patternType,
      systemName: split.systemName,
      systemResponse: split.systemResponse,
      ...(split.preCondition !== undefined ? { preCondition: split.preCondition } : {}),
      ...(split.trigger !== undefined ? { trigger: split.trigger } : {}),
    },
    split.negated,
  )

// ---------------------------------------------------------------------------
// Projections from the ladder's internal shapes
// ---------------------------------------------------------------------------

/** Lift a Tier-1 or Tier-2 success into the `ok` variant. */
export const fromTierOk = (ok: Tier1Ok | Tier2Ok): ParseOkResult => ({
  outcome: 'ok',
  pattern: ok.pattern,
  slots: ok.slots,
  negated: ok.negated,
  confidence: ok.confidence,
  tier: ok.tier,
  notes: ok.notes,
  proposedOp: slotsToAddOp(ok.slots, ok.negated),
})

/**
 * Project a Tier-3 envelope into the union, drawing the skipped/error boundary:
 * `ERR_PARSE_NO_MODAL` becomes `skipped` (no-modal prose is not an error), every
 * other code stays `error`.
 */
export const fromTier3 = (
  env: Tier3Envelope,
  text: string,
): ParseSkippedResult | ParseErrorResult => {
  if (env.code === 'ERR_PARSE_NO_MODAL') {
    return { outcome: 'skipped', reason: 'no-modal', text: text.trim() }
  }
  const ops = env.proposedSplits?.map(splitToAddOp)
  return {
    outcome: 'error',
    code: env.code,
    error: env.error,
    ...(env.partial !== undefined ? { partial: env.partial } : {}),
    suggestions: env.suggestions,
    // ONE NAME. The tier3 envelope's internal field is still `proposedSplits`
    // (that file is byte-identical to the donor's); the rename happens exactly
    // here, once, on the way into the union agents read.
    ...(ops !== undefined && ops.length > 0 ? { proposedOps: ops } : {}),
  }
}

/**
 * Resolve a completed `Tier2Outcome` into the final per-line `ParseResult`. Pure and
 * deterministic in its inputs.
 *
 * Resolution order, verbatim from the donor:
 *   1. a `compound-conjunction` trigger forces `ERR_PARSE_COMPOUND` even over a
 *      nominal Tier-1/Tier-2 success (the recovered slots surface in `partial`);
 *   2. otherwise prefer the Tier-2 repair when it succeeded, then a usable Tier-1
 *      parse (soft triggers ride on it as downgraded confidence);
 *   3. otherwise Tier 3, split into `skipped` (no-modal) or `error`.
 */
export const resolveParseResult = (text: string, outcome: Tier2Outcome): ParseResult => {
  const compound = outcome.triggers.includes('compound-conjunction')
  if (!compound) {
    if (outcome.tier2?.ok) return fromTierOk(outcome.tier2)
    if (outcome.tier1.ok) return fromTierOk(outcome.tier1)
  }
  return fromTier3(makeTier3Envelope(text, outcome), text)
}

// ---------------------------------------------------------------------------
// The ladder driver
// ---------------------------------------------------------------------------

/**
 * The PROCESS-WIDE memo for the real wink analyzer — a DONOR BUG FIX.
 *
 * `defaultTier2Loader` constructs a fresh `winkNLP(model)` on every call, and that
 * constructor leaks: probed, the 21st construction throws `RangeError: Invalid string
 * length` from inside `wink-eng-lite-web-model`. `runTier2` calls the loader per
 * line, so ANY caller that parses more than ~20 escalating lines in one process dies
 * — with a dependency-internal `RangeError`, not a parse error, so the whole run
 * aborts instead of reporting per-line results. Verified against the live donor:
 * 30 escalating lines through its own `parseBatch` never completes.
 *
 * `parseBatch` memoizes per BATCH (see `./batch.ts`), which is the more precise
 * scope. This memo covers the OTHER route: a caller looping over `parseLine`
 * directly. Both are needed, and they compose — a batch's own memo shadows this one,
 * so injecting a fake loader for a batch still yields exactly one invocation.
 *
 * Module-scoped rather than passed in, because the resource it guards IS
 * process-global: the leak is in the dependency's own module state, so no amount of
 * caller-side scoping avoids it. Sharing one analyzer is sound — probed: 500
 * sequential `readDoc` calls on one instance produce correct tags with no
 * degradation, and are ~3x faster than one fresh load.
 *
 * ONLY the default loader is memoized. An INJECTED `opts.load` is called as given, so
 * a test that wants to count invocations or return a different fake per call still
 * can, and this memo cannot make one test's fake leak into another's.
 */
let sharedAnalyzer: ReturnType<Tier2Loader> | undefined

/** The memoized real loader. Lazy: nothing loads until a line actually escalates. */
const memoizedDefaultLoader: Tier2Loader = () => {
  sharedAnalyzer ??= defaultTier2Loader()
  return sharedAnalyzer
}

/**
 * Parse one input line through the full Tier-1 → Tier-2 → Tier-3 ladder.
 *
 * Tier 2 (and the ~4.5 MB wink-nlp model) is invoked ONLY on escalation: a clean
 * sentence never loads it. `opts.load` injects an analyzer, which is what lets the
 * gating itself be tested (assert the loader was NOT called) rather than assumed.
 */
export const parseLine = async (input: string, opts: Tier2Options = {}): Promise<ParseResult> =>
  resolveParseResult(
    input,
    await runTier2(input, { ...opts, load: opts.load ?? memoizedDefaultLoader }),
  )
