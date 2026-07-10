/**
 * The `add` command core (AC-2-10): the CLI create path that auto-mints a UUID
 * and accepts EITHER structured EARS slots OR a single line of prose parsed
 * through the Tier-1..3 ladder.
 *
 * ## What AC-2-10 pins down
 *
 * `add` is the agent-ergonomic convenience over the library's
 * `CreateRequirement` Change — which is caller-owned-UUID (contract-map §6). At
 * the CLI:
 *
 *   - **UUID is auto-minted** (via {@link newId}) and returned in the success
 *     envelope's `data.id`, UNLESS the caller supplies an explicit `--id <uuid>`.
 *     The auto-generated path therefore cannot collide; `ERR_DUPLICATE_ID`
 *     (AC-1-8) fires only when a caller-supplied `--id` already exists in the
 *     document. Detection is delegated to `applyChange`, which throws the typed
 *     `ChangeError('ERR_DUPLICATE_ID', …)` — lifted here to an envelope via
 *     {@link toErrorEnvelope} (no code re-derivation), exactly as `update` does.
 *
 *   - **Two input modes, mutually exclusive.** Either `slots` (structured EARS
 *     attributes, already the `CreateRequirementAttrsSchema` shape) OR
 *     `fromParse` (one line of prose). Supplying both, or neither, is a usage
 *     error (`ERR_USAGE`) — the two intents cannot be mixed.
 *
 *   - **`--from-parse` runs the parse ladder first.** The prose is sent through
 *     {@link parseLine} (AC-2-8). An `ok` outcome's `slots` feed
 *     `CreateRequirement` directly (they satisfy `CreateRequirementAttrsSchema`
 *     by construction). An `error` outcome (Tier-3, AC-2-7) is surfaced VERBATIM
 *     as the `ERR_PARSE_*` error envelope, carrying its `partial` slot skeleton
 *     and mechanical rewrite `suggestions` — the agent gets the same structured
 *     punt it would from `symspec parse`, never a half-created requirement. A
 *     `skipped` outcome (no-modal prose — a bullet or rationale line) likewise
 *     cannot become a requirement, so it is reported as an `ERR_PARSE_NO_MODAL`
 *     error envelope rather than silently creating nothing.
 *
 * ## Shape (mirrors `cli/update.ts`)
 *
 * {@link runAdd} is the pure, Commander-agnostic command core: it takes the
 * loaded document and the parsed arguments and returns `{ next?, envelope }` —
 * the updated document (present only on success) plus the typed envelope to
 * emit (AC-6-2). It performs no filesystem I/O; the command wiring
 * (AC-6-8/6-9) loads, calls, saves on success, and emits. It is `async` ONLY
 * because the parse ladder is async (Tier-2 lazy-imports wink-nlp on
 * escalation, AC-2-6); the slots path resolves without awaiting any loader.
 *
 * Cite: AC-2-10 (`add` auto-UUID / `--id` / `--from-parse`); AC-1-8
 * (`ERR_DUPLICATE_ID`); AC-2-7/AC-2-8 (Tier-3 error + `ParseResult`); AC-6-2
 * (typed envelope); AC-6-10 (error lifting, never a stack trace); contract-map
 * §6 (library UUID ownership); orchestrator decision 7.
 */

import type { z } from 'zod'
import { applyChange } from '../core/changes.js'
import { newId } from '../core/doc.js'
import type { CreateRequirementAttrsSchema, Requirement, RequirementsDoc } from '../core/schema.js'
import { parseLine } from '../parse/result.js'
import type { Tier2Options } from '../parse/tier2.js'
import type { Envelope } from './envelope.js'
import { failure, success } from './envelope.js'
import { toErrorEnvelope, usageError } from './errors.js'

/** The usage line `ERR_USAGE` suggestions cite for this command. */
export const ADD_USAGE = 'symspec add [--id <uuid>] (--from-parse "<prose>" | <EARS slots>)'

/** Structured EARS slots a caller may supply to `add` (the create-attrs shape). */
export type AddSlots = z.infer<typeof CreateRequirementAttrsSchema>

/**
 * Parsed `add` arguments. Exactly one of `slots` / `fromParse` must be present.
 * `id` is the OPTIONAL explicit UUID; when omitted, {@link runAdd} mints a fresh
 * one. Every optional field is absent (never `undefined`-assigned) when unset,
 * per `exactOptionalPropertyTypes`.
 */
export interface AddArgs {
  /** Explicit UUID (`--id`). Omitted ⇒ auto-minted, and the create cannot collide. */
  readonly id?: string
  /** Structured EARS slots (mutually exclusive with `fromParse`). */
  readonly slots?: AddSlots
  /** A single line of prose to parse through the ladder (mutually exclusive with `slots`). */
  readonly fromParse?: string
}

/** Parse provenance echoed back on the `--from-parse` create path. */
export interface AddParseMeta {
  /** Which ladder rung produced the parse (Tier 3 never succeeds). */
  readonly tier: 1 | 2
  readonly confidence: 'high' | 'medium' | 'low'
  /** True when the prose carried an explicit negator; `systemResponse` is the positive atom. */
  readonly negated: boolean
  readonly pattern: Requirement['patternType']
}

/** The `data` payload of a successful `add` envelope. */
export interface AddData {
  /** The requirement's UUID — the auto-minted one, or the supplied `--id`. */
  readonly id: string
  /** The fully materialized requirement (rendered sentence, defaults filled). */
  readonly requirement: Requirement
  /** Present ONLY on the `--from-parse` path: how the prose was parsed. */
  readonly parse?: AddParseMeta
}

/**
 * Result of {@link runAdd}: the envelope to emit, plus the updated document
 * when (and only when) the create succeeded. `next` is OMITTED on failure —
 * the caller persists nothing.
 */
export type AddResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<AddData> }
  | { readonly envelope: Envelope<AddData> }

/**
 * Execute an `add` against a loaded document. Pure: returns a new document (via
 * `applyChange`'s structuredClone) and never mutates the input, never throws,
 * never touches the filesystem.
 *
 * @param opts Parse-ladder options forwarded to {@link parseLine} on the
 *   `--from-parse` path (e.g. an injected Tier-2 analyzer loader for tests).
 *   Unused on the structured-slots path.
 */
export async function runAdd(
  doc: RequirementsDoc,
  args: AddArgs,
  opts: Tier2Options = {},
): Promise<AddResult> {
  const hasSlots = args.slots !== undefined
  const hasProse = args.fromParse !== undefined

  if (hasSlots && hasProse) {
    return {
      envelope: usageError(
        '--from-parse and structured slots are mutually exclusive: pass prose to parse OR the EARS slots, not both',
        ADD_USAGE,
      ),
    }
  }
  if (!hasSlots && !hasProse) {
    return {
      envelope: usageError(
        'add requires either --from-parse "<prose>" or structured EARS slots',
        ADD_USAGE,
      ),
    }
  }

  // Resolve the create attrs from whichever mode was chosen. The parse path may
  // punt (Tier-3 error) or skip (no-modal prose) before we ever mint an id.
  let attrs: AddSlots
  let parseMeta: AddParseMeta | undefined
  if (hasProse) {
    const result = await parseLine(args.fromParse as string, opts)
    if (result.outcome === 'error') {
      // Surface the Tier-3 punt verbatim: stable ERR_PARSE_* code, the recovered
      // `partial` skeleton, and mechanical rewrite suggestions (AC-2-7).
      return {
        envelope: failure({
          error: result.error,
          code: result.code,
          suggestions: result.suggestions,
          ...(result.partial !== undefined ? { partial: result.partial } : {}),
        }),
      }
    }
    if (result.outcome === 'skipped') {
      // No-modal prose carries no obligation, so it cannot become a
      // requirement. Report it as ERR_PARSE_NO_MODAL rather than creating
      // nothing silently (AC-2-8 skipped/error boundary).
      return {
        envelope: failure({
          error: `Input is not a requirement (no modal/obligation): "${result.text}"`,
          code: 'ERR_PARSE_NO_MODAL',
          suggestions: [
            'Phrase it as an obligation: "the <system> shall <response>".',
            'Or add the requirement with structured slots instead of --from-parse.',
          ],
        }),
      }
    }
    // ok: the recovered slots satisfy CreateRequirementAttrsSchema by
    // construction (ParseSlotsSchema is a .pick() of it). The parse tier
    // reports response polarity as a top-level `negated` flag (AC-2-4) with
    // `slots.systemResponse` left POSITIVE — thread that flag into the create
    // attrs so it is persisted, not dropped (C1). A false flag is omitted to
    // keep the create payload minimal (exactOptionalPropertyTypes).
    attrs = result.negated ? { ...result.slots, negated: true } : result.slots
    parseMeta = {
      tier: result.tier,
      confidence: result.confidence,
      negated: result.negated,
      pattern: result.pattern,
    }
  } else {
    // Structured-slots path: `negated` may arrive via --negated in the create
    // attrs (CreateRequirementAttrs carries it); passed straight through.
    attrs = args.slots as AddSlots
  }

  // Auto-mint unless an explicit --id was supplied. The minted UUID cannot
  // collide; a supplied duplicate is caught by applyChange below.
  const id = args.id ?? newId()

  try {
    const next = applyChange(doc, { kind: 'CreateRequirement', id, attrs })
    const created = next.requirements[id]
    if (created === undefined) {
      // Unreachable: applyChange just created this id. Guard for
      // noUncheckedIndexedAccess without a non-null assertion.
      return { envelope: toErrorEnvelope(new Error(`add failed to persist requirement ${id}`)) }
    }
    const data: AddData = {
      id,
      requirement: created,
      ...(parseMeta !== undefined ? { parse: parseMeta } : {}),
    }
    return { next, envelope: success('add', data) }
  } catch (e) {
    // ChangeError (ERR_DUPLICATE_ID on a supplied --id) and any other coded
    // core error — or a ChangeSchema Zod rejection (bad --id / invalid slots) —
    // lift to an envelope; nothing escapes as a stack trace (AC-6-10).
    return { envelope: toErrorEnvelope(e) }
  }
}
