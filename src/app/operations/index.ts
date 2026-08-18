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
 * - `explain <code>` — the success AND failure paths, over every code in the
 *   three catalogs (G3), with did-you-mean suggestions on an unknown code.
 * - `version` — the minimal op: no input fields at all, which is its own edge
 *   case for the flag-derivation and manifest projections.
 *
 * And the four DOCUMENT operations (`../core/`-backed, defined in `./document.ts`
 * and `./import.ts`):
 *
 * - `init` — create an empty v3 document, refusing to clobber an existing one.
 * - `import` — consume a v4 reproduce-op stream into a v3 document. The whole
 *   v2 migration story.
 * - `list` / `show <ref>` — the reads, resolving a ref through the one chokepoint.
 *
 * G2b adds the AUTHORING surface — `parse` (prose in, apply-ready ops out) and the
 * mutation ops. `parse` is listed with the document lifecycle rather than with the
 * analysis ops because it is where a document COMES FROM.
 *
 * G4 adds the REACHABILITY authoring surface — `state` (declare a state variable),
 * `state-initial` (the model-wide initial predicate), and `classify` (label a
 * requirement's response as an effect or a constraint, with its expression). Three
 * operations rather than one because they are scoped differently: two are
 * document-scoped and one is requirement-scoped, which is v4's own "two tables,
 * not one" finding. They are the only way to author the input the Spacer reachability
 * tier reads, and every one of them validates references against the DECLARED
 * variables — so an undeclared name is an `ERR_USAGE` here rather than an unkillable
 * solver hang inside `check`.
 *
 * Appending an operation here is the ONLY edit needed to make it appear in the
 * manifest and in `--help`. (The CLI tree also needs one `Command.make` in
 * `../cli.ts`, because nothing in a JSON Schema says whether a field should be a
 * flag or a positional argument — that seam is guarded by
 * `{onExcessProperty:'error'}` and by a drift test asserting the two lists agree.)
 */

import { Effect, Schema } from 'effect'
import { FND_CODES, FndCodeMeta } from '../../domain/engine/formal/codes.ts'
import { GTWR_CODES, GtwrCodeMeta } from '../../domain/engine/lint/codes.ts'
import {
  REACHABILITY_FND_CODES,
  ReachabilityFndCodeMeta,
} from '../../domain/reachability/reachability-codes.ts'
import {
  TERMINOLOGY_FND_CODES,
  TerminologyFndCodeMeta,
} from '../../domain/terminology/terminology-codes.ts'
import { ErrNotFound, errCodeCatalog } from '../../ports/errors.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  EXIT_OPERATIONAL_ERROR,
} from '../../ports/exit.ts'
import { catalogCounts, lookupCode, nearestCodesAll } from '../runtime/catalog.ts'
import { API_VERSION, ok } from '../runtime/envelope.ts'
import {
  type AnyOperation,
  buildManifest,
  defineOperation,
  type Manifest,
} from '../runtime/operation.ts'
import { SCOPE } from '../runtime/scope.ts'
import { VERSION } from '../runtime/version.ts'
import { checkOp } from './check.ts'
import { initOp, listOp, showOp } from './document.ts'
import { importOp } from './import.ts'
import { installOp } from './install.ts'
import { downloadModelOp } from './model.ts'
import {
  addOp,
  antonymOp,
  applyOpDefinition,
  classifyOp,
  deleteOp,
  glossaryOp,
  linkOp,
  stateInitialOp,
  stateOp,
  termOp,
  updateOp,
  waiveOp,
} from './mutation.ts'
import { parseOp } from './parse.ts'
import { proposeGlossaryOp } from './propose-glossary.ts'

export { StreamSource } from '../../ports/stream.ts'
export { checkOp } from './check.ts'
export { initOp, listOp, showOp } from './document.ts'
export { importOp } from './import.ts'
export { installOp } from './install.ts'
export { downloadModelOp } from './model.ts'
export {
  addOp,
  antonymOp,
  applyOpDefinition,
  classifyOp,
  deleteOp,
  glossaryOp,
  linkOp,
  stateInitialOp,
  stateOp,
  termOp,
  updateOp,
  waiveOp,
} from './mutation.ts'
export { parseOp } from './parse.ts'
export { proposeGlossaryOp } from './propose-glossary.ts'

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
      // All THREE code catalogs, each a projection of its own transplanted
      // description corpus. See `Manifest` for why publishing only ERR_* was a gap
      // rather than a scope choice.
      errorCodes: errCodeCatalog(),
      // EVERY FND source, in provenance order — the engine's transplanted corpus, then the
      // greenfield ones. A count here would rot; the arrays are the source of truth.
      // Published as ONE `findingCodes` array because an agent switches on a code, not on
      // which file it came from.
      findingCodes: [
        ...FND_CODES.map((code) => ({ code, description: FndCodeMeta[code].description })),
        ...REACHABILITY_FND_CODES.map((code) => ({
          code,
          description: ReachabilityFndCodeMeta[code].description,
        })),
        ...TERMINOLOGY_FND_CODES.map((code) => ({
          code,
          description: TerminologyFndCodeMeta[code].description,
        })),
      ],
      lintCodes: GTWR_CODES.map((code) => ({
        code,
        description: GtwrCodeMeta[code].description,
      })),
      // The honest-scope corpus, verbatim and claim by claim. An agent is told to read the
      // manifest to learn the surface, so the boundary of what a verdict MEANS has to be in
      // it — a disclosure that lives only in prose is one the agent following instructions
      // never sees.
      scope: SCOPE,
    }),
  )

/**
 * `explain <code>` — what one stable code means and what to do about it.
 *
 * The agent-loop primitive: an envelope carries a `code`, and this turns that code
 * back into its meaning without the agent needing an out-of-band table AND WITHOUT
 * FETCHING THE MANIFEST (spec AC-A-3 / v4 AC-3-8 — the manifest is ~48 KB of
 * JSON to answer a question about one string).
 *
 * ## G3: all THREE catalogs, not one
 *
 * G1 reached only the 21 `ERR_*` classes, which was right for a build that could
 * not yet emit a finding. G2b published `FND_*` and `GTWR_*` in the manifest, and
 * that made the gap visible from the agent's side: the codes an agent branches on
 * inside a fix loop were exactly the two families `explain` could not resolve, and
 * a miss ranked did-you-mean over 21 of the then-75 candidates — so `explain GTWR_R7_VAGU`
 * answered with a list of `ERR_*` codes.
 *
 * Both halves now go through `../kernel/catalog.ts`: {@link lookupCode} over the whole catalog,
 * {@link nearestCodesAll} over the whole catalog. The payload gains `family`, `severity`,
 * `tier`, the runnable `commands` the text names, and a worked `example` where the
 * catalogs carry one — each read from the same description bytes the manifest
 * publishes, never a second corpus.
 *
 * On an unknown code it fails with {@link ErrNotFound} carrying DID-YOU-MEAN
 * suggestions, so a typo is self-correcting rather than a dead end.
 */
export const explainOp = defineOperation({
  name: 'explain',
  summary:
    'Explain one stable diagnostic code (ERR_*, FND_*, or GTWR_*): its severity, meaning, and remedy',
  type: 'codeExplanation',
  input: Schema.Struct({
    code: Schema.String.annotate({
      // The COUNTS ARE INTERPOLATED from the catalog, never written out. This exact
      // sentence said "all 75" through G4's vocabulary growth to 80 — a manifest telling
      // an agent the tool has 75 codes while `explain` resolved 80 of them. A number that
      // has to be hand-updated on every append is a number that will be wrong.
      description: `A stable diagnostic code from any of the three catalogs — an operational error (ERR_SOLVER_MISSING), a check finding (FND_CONTRADICTION), or a GtWR lint rule (GTWR_R7_VAGUE). Case-sensitive; an unknown code returns ERR_NOT_FOUND with did-you-mean suggestions ranked across all ${catalogCounts().total} (${catalogCounts().ERR} ERR_*, ${catalogCounts().FND} FND_*, ${catalogCounts().GTWR} GTWR_*).`,
    }),
  }),
  handler: (input) => {
    const entry = lookupCode(input.code)
    if (entry === undefined) {
      // Ranked across the WHOLE catalog now. The family prefix keeps this from becoming noise:
      // a misspelled FND_* shares 4 leading characters with every other FND_* and
      // none with any ERR_*, so a cross-family suggestion only appears when nothing
      // in the right family is close.
      const near = nearestCodesAll(input.code)
      const counts = catalogCounts()
      return Effect.fail(
        new ErrNotFound({
          error: `Unknown code: ${input.code}`,
          suggestions: [
            ...(near.length > 0 ? [`Did you mean: ${near.join(', ')}?`] : []),
            `Run \`symspec manifest\` to list every known code (${counts.ERR} ERR_*, ${counts.FND} FND_*, ${counts.GTWR} GTWR_*).`,
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
    return Effect.succeed(ok('codeExplanation', entry))
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
  // G2b AUTHORING: the mutation ops, in the order an agent uses them — create, then
  // edit, then relate, then delete, then the three committed side tables, then the
  // batch that does any of it in bulk.
  addOp,
  updateOp,
  linkOp,
  deleteOp,
  waiveOp,
  // The PROPOSE half, immediately before the two DECIDE commands it feeds: it is what
  // makes `glossary`/`antonym` usable at document scale rather than one pair at a time.
  proposeGlossaryOp,
  glossaryOp,
  antonymOp,
  // The compositional half of the glossary: one entry aligns a noun everywhere it appears,
  // where `glossary` aligns one whole phrasing against another.
  termOp,
  // G4 REACHABILITY AUTHORING, listed after the side tables and before `apply`
  // because that is the order an agent uses them: declare the variables, classify the
  // responses that touch them, then batch the rest.
  stateOp,
  stateInitialOp,
  classifyOp,
  applyOpDefinition,
  listOp,
  showOp,
  checkOp,
  manifestOp,
  explainOp,
  versionOp,
  // G3: `install` sits LAST, with the self-description ops rather than the document
  // lifecycle, because it acts on the developer's machine rather than on a document — it
  // is how the tool describes itself to a HOST, which is the same job `manifest` does for
  // an agent.
  installOp,
  // The pre-warm, LAST: like `install` it acts on the developer's machine rather than on
  // a document, and unlike everything above it, it is a one-time setup step rather than
  // part of any loop.
  downloadModelOp,
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
