/**
 * The closed, append-only enum of envelope `type` discriminants (AC-6-13): the
 * single field an agent switches on to tell one command result from another.
 *
 * ## Why a closed enum
 *
 * Every success envelope carries `{ apiVersion, type, data }` and every failure
 * `{ apiVersion, type:'error', … }` (AC-6-2, `cli/envelope.ts`). The `type`
 * field is a discriminant an agent branches on — exactly like the `ERR_*`,
 * `GTWR_*`, and `FND_*` catalogs it now reaches parity with (AC-6-3). Those
 * three code sets are closed, append-only, snapshot-guarded Zod enums; before
 * AC-6-13 the envelope `type` was a bare `z.string()` with no closed table an
 * agent could enumerate ahead of time. This module supplies that table.
 *
 * ## One `type` per result-bearing command + `'error'`
 *
 * The success `type` of a command IS its command name — the convention the
 * wired emitters already follow (`success('check', …)`, `success('parse', …)`,
 * `success('update', …)`). So the closed set is exactly the AC-6-1 command
 * inventory (`COMMAND_SPECS` in `cli/manifest.ts`) plus the reserved literal
 * `'error'` for the failure envelope. Keeping the discriminant identical to the
 * command name is what makes the enum and the manifest impossible to drift:
 * `types-enum.test.ts` asserts every `COMMAND_SPECS` name is a member here and
 * that every non-`'error'` member is a real command, so adding a command
 * without adding its `type` (or vice versa) fails a test.
 *
 * ## Append-only (same guard as the code catalogs)
 *
 * Never remove or rename a `type` once shipped — an agent may already switch on
 * it. New types append to the END. `types-enum.test.ts` carries the same
 * append-only snapshot guard as `core/__tests__/codes.test.ts`: it fails if any
 * existing member is removed, renamed, or reordered.
 *
 * ## Manifest derivation
 *
 * The manifest (AC-6-1) exposes this enum as its `types` table, derived from
 * {@link EnvelopeTypes} — never a parallel hand-list — so an agent reads the
 * full discriminant set from the same self-describing blob that carries the
 * command inventory and the code catalogs.
 *
 * Cite: AC-6-13 (closed append-only envelope `type` enum, manifest-derived);
 * AC-6-2 (the envelopes whose `type` this closes over); AC-6-3 (the append-only
 * snapshot pattern this mirrors).
 */

import { z } from 'zod'

/**
 * The closed, append-only set of envelope `type` discriminants. Members are the
 * result-bearing command names (their success `type` equals the command name)
 * plus the reserved `'error'` literal every failure envelope carries.
 * Append-only: never renumber or remove; new types append to the END.
 */
export const EnvelopeTypeSchema = z.enum([
  // One per result-bearing command — the success `type` IS the command name.
  'manifest',
  'init',
  'add',
  'update',
  'parse',
  'check',
  'certify',
  'list',
  'show',
  'derive',
  'satisfy',
  'remove-edge',
  'delete',
  'export',
  // The failure envelope's reserved discriminant (AC-6-2).
  'error',
  // Semantic glossary management (appended after the frozen snapshot — AC-9-6).
  'glossary',
])

/** A single envelope `type` discriminant. */
export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>

/** The inner tuple, for the manifest `types` table and the snapshot guard. */
export const EnvelopeTypes = EnvelopeTypeSchema.options

/**
 * The reserved failure discriminant. Exported so callers assert against the ONE
 * constant rather than a re-typed string literal.
 */
export const ERROR_ENVELOPE_TYPE = 'error' as const satisfies EnvelopeType

/**
 * Type guard: is `t` a known envelope `type`? Lets a command's success `type`
 * be validated against the closed set before it is stamped on an envelope.
 */
export function isEnvelopeType(t: string): t is EnvelopeType {
  return (EnvelopeTypes as readonly string[]).includes(t)
}
