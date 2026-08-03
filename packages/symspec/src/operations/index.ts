/**
 * THE OPERATIONS TABLE. Every agent- and human-facing surface is a projection of
 * the {@link OPERATIONS} array at the bottom of this file.
 *
 * G1 ships seven operations in two groups.
 *
 * The three SELF-DESCRIPTION operations, chosen because together they exercise the
 * whole kernel end-to-end rather than because they are easy:
 *
 * - `manifest` — the self-description projection. Proves the table can describe
 *   itself, including its own row.
 * - `explain <code>` — the success AND failure paths, over the real 21-code
 *   catalog, with did-you-mean suggestions on an unknown code.
 * - `version` — the minimal op: no input fields at all, which is its own edge
 *   case for the flag-derivation and manifest projections.
 *
 * And the four DOCUMENT operations (`../core/`-backed, defined in `./document.ts`
 * and `./import.ts`):
 *
 * - `init` — create an empty v3 document, refusing to clobber an existing one.
 * - `import` — consume a donor reproduce-op stream into a v3 document. The whole
 *   v2 migration story.
 * - `list` / `show <ref>` — the reads, resolving a ref through the one chokepoint.
 *
 * G2b adds the AUTHORING surface — `parse` (prose in, apply-ready ops out) and the
 * mutation ops. `parse` is listed with the document lifecycle rather than with the
 * analysis ops because it is where a document COMES FROM.
 *
 * Appending an operation here is the ONLY edit needed to make it appear in the
 * manifest and in `--help`. (The CLI tree also needs one `Command.make` in
 * `../cli.ts`, because nothing in a JSON Schema says whether a field should be a
 * flag or a positional argument — that seam is guarded by
 * `{onExcessProperty:'error'}` and by a drift test asserting the two lists agree.)
 */

import { Effect, Schema } from 'effect'
import { API_VERSION, ok } from '../kernel/envelope.ts'
import { ErrNotFound, errCodeCatalog, explainCode, nearestCodes } from '../kernel/errors.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  EXIT_OPERATIONAL_ERROR,
} from '../kernel/exit.ts'
import {
  type AnyOperation,
  buildManifest,
  defineOperation,
  type Manifest,
} from '../kernel/operation.ts'
import { VERSION } from '../kernel/version.ts'
import { checkOp } from './check.ts'
import { initOp, listOp, showOp } from './document.ts'
import { importOp } from './import.ts'
import { parseOp } from './parse.ts'

export { checkOp } from './check.ts'
export { initOp, listOp, showOp } from './document.ts'
export { importOp } from './import.ts'
export { parseOp } from './parse.ts'
export { StreamSource, streamSourceLayer } from './stream.ts'

/**
 * The exit-code table the manifest publishes, single-sourced from the exit
 * module's constants so a code cannot be documented as a number it is not.
 */
const EXIT_CODE_TABLE = [
  {
    code: EXIT_CLEAN,
    meaning: 'Clean — the operation completed with no error-severity finding.',
  },
  {
    code: EXIT_FINDINGS_FAILURE,
    meaning:
      'Findings failure — the operation completed but at least one error-severity finding is present. A valid success envelope is still emitted.',
  },
  {
    code: EXIT_OPERATIONAL_ERROR,
    meaning: 'Operational failure — an ERR_* error. The error envelope is emitted.',
  },
  {
    code: EXIT_INCONCLUSIVE,
    meaning:
      'Inconclusive — an opt-in strict coverage gate tripped on a run with no error-severity finding.',
  },
] as const

/**
 * `manifest` — emit the whole agent-facing contract.
 *
 * ## Self-description, including itself
 *
 * The handler is defined BEFORE `OPERATIONS` exists but reads it at CALL time via
 * {@link allOperations}, so the manifest includes its own row. A module-level
 * capture would hit the temporal dead zone; a lazy read is both correct and the
 * reason `manifest` needs no special-casing in the table.
 */
export const manifestOp = defineOperation({
  name: 'manifest',
  summary: 'Emit the machine-readable manifest of every operation, exit code, and error code',
  type: 'manifest',
  input: Schema.Struct({}),
  handler: (): Effect.Effect<ReturnType<typeof manifestEnvelope>> =>
    Effect.sync(() => manifestEnvelope()),
})

/** Build the manifest success envelope from the live table. */
const manifestEnvelope = () =>
  ok(
    'manifest',
    buildManifest({
      operations: allOperations(),
      apiVersion: API_VERSION,
      version: VERSION,
      exitCodes: EXIT_CODE_TABLE,
      errorCodes: errCodeCatalog(),
    }),
  )

/**
 * `explain <code>` — what one stable code means and what to do about it.
 *
 * The agent-loop primitive: an error envelope carries a `code`, and this turns
 * that code back into its meaning without the agent needing an out-of-band table.
 * On an unknown code it fails with {@link ErrNotFound} carrying DID-YOU-MEAN
 * suggestions, so a typo is self-correcting rather than a dead end.
 */
export const explainOp = defineOperation({
  name: 'explain',
  summary: 'Explain one stable diagnostic code: its meaning and its suggested remedy',
  type: 'codeExplanation',
  input: Schema.Struct({
    code: Schema.String.annotate({
      description: 'A stable diagnostic code, such as ERR_NOT_FOUND or ERR_SOLVER_MISSING',
    }),
  }),
  handler: (input) => {
    const explanation = explainCode(input.code)
    if (explanation === undefined) {
      const near = nearestCodes(input.code)
      return Effect.fail(
        new ErrNotFound({
          error: `Unknown code: ${input.code}`,
          suggestions: [
            ...(near.length > 0 ? [`Did you mean: ${near.join(', ')}?`] : []),
            'Run `symspec manifest` to list every known code.',
          ],
          // The remedy is a command an agent can run verbatim (AC-A-9). For a
          // near-miss the repair is the corrected invocation itself.
          repair: {
            ops: [],
            commands:
              near.length > 0 && near[0] !== undefined
                ? [`symspec explain --code ${near[0]}`]
                : ['symspec manifest'],
          },
        }),
      )
    }
    return Effect.succeed(ok('codeExplanation', explanation))
  },
})

/**
 * `version` — the package version and the envelope contract version.
 *
 * Reports BOTH numbers because they answer different questions and are
 * deliberately independent: `version` moves every release, `apiVersion` only when
 * the envelope shape changes in a way an agent must negotiate.
 */
export const versionOp = defineOperation({
  name: 'version',
  summary: 'Report the package version and the envelope API version',
  type: 'version',
  input: Schema.Struct({}),
  handler: () => Effect.succeed(ok('version', { version: VERSION, apiVersion: API_VERSION })),
})

/**
 * THE TABLE. Every surface is a projection of this array; appending here is the
 * only edit an operation needs to become visible everywhere.
 *
 * Order is the order `--help` and the manifest list them, so it is chosen for a
 * reader: the document lifecycle first (`init` → `import` → `list` → `show`), then
 * `check` — the operation the whole tool exists for, and the one an agent runs in a
 * loop — then the self-description operations an agent uses to orient (`manifest`,
 * `explain`, `version`). Nothing depends on this order mechanically — it is
 * presentation, and the drift tests are order-agnostic.
 */
export const OPERATIONS = [
  initOp,
  importOp,
  parseOp,
  listOp,
  showOp,
  checkOp,
  manifestOp,
  explainOp,
  versionOp,
] as const

/**
 * The table as the existential array the iteration sites consume.
 *
 * A FUNCTION rather than a constant so `manifest`'s handler — defined above
 * `OPERATIONS` — can read it at call time instead of capturing it during module
 * initialization, where it would still be in the temporal dead zone.
 */
export const allOperations = (): readonly AnyOperation[] => OPERATIONS

/** The manifest object, for tests and the drift checks. */
export const currentManifest = (): Manifest => manifestEnvelope().data
