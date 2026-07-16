/**
 * `symspec` CLI (AC-6-9): the thin formatter over the library API.
 *
 * Every command follows the SAME spine, so the agent-facing contract is
 * uniform across the whole surface:
 *
 *   resolve doc path (`resolve-doc.ts`, AC-6-6)  — except init/manifest/parse
 *     → load + validate (`core/load.ts`, AC-1-4/1-9)
 *     → run the pure command core (add/update/check/parse/certify/…)
 *     → save on mutation (`core/storage.ts`, atomic, AC-1-11)
 *     → wrap in the typed envelope (`envelope.ts`, AC-6-2)
 *     → render (`output.ts` formatEnvelope + `dense.ts` when `--dense`, AC-6-2a/6-4)
 *     → exit (`exit.ts` exitCodeForEnvelope, AC-6-2b)
 *
 * No command prints prose via `console.log` and none hardcodes the version:
 * the JSON envelope is the zero-flag default (AC-6-2a), the version is
 * single-sourced from `version.ts` (AC-6-7), and bad arguments surface as an
 * `ERR_USAGE` (or a more specific `ERR_*`) envelope rather than a commander
 * stack trace (AC-6-10, via `program.exitOverride`).
 *
 * Command help text and the manifest summaries both read from the ONE
 * description corpus (`descriptions.ts`, AC-6-9), so the two agent surfaces
 * cannot drift. The inventory carries no upgrade/import command (SC-1/SC-2).
 *
 * Cite: AC-6-9 (command inventory + ported descriptions); AC-6-2/6-2a/6-2b
 * (envelope / default JSON / exit codes); AC-6-4 (`--dense`/`--evidence`);
 * AC-6-6 (doc-path resolution); AC-6-10 (typed usage errors); AC-6-7 (version);
 * SC-1/SC-2 (v2 on its own terms).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import type { z } from 'zod'
import { discoverLeanToolchain } from '../certify/discover.js'
import { sanitizeLeanName } from '../certify/emit.js'
import { certify as runCertify } from '../certify/run.js'
import { applyChange } from '../core/changes.js'
import { emptyDoc, listRequirements } from '../core/doc.js'
import { loadRequirementsDoc } from '../core/load.js'
import type { CreateRequirementAttrsSchema, RequirementsDoc } from '../core/schema.js'
import { writeDocFile } from '../core/storage.js'
import { exportSysml } from '../core/sysml-export.js'
import {
  BinaryBackendError,
  type BinaryCheckResult,
  discoverSolverBinary,
  runSolverBinary,
} from '../formal/binary-backend.js'
import { emitSmt2 } from '../formal/emit-smt2.js'
import { downloadModelAssets } from '../formal/model-cache.js'
import { SolverBudgetExceededError } from '../formal/needs-review.js'
import { DEFAULT_SEMANTIC_THRESHOLD } from '../formal/semantic.js'
import { parseBatch } from '../parse/batch.js'
import { type CheckSeverity, encodeIncluded, filterReport, runCheck } from '../pipeline/check.js'
import { runAdd } from './add.js'
import { APPLY_USAGE, runApply } from './apply.js'
import { denseEnvelope, densifyEnvelope, minifyJson } from './dense.js'
import { COMMAND_DESCRIPTIONS } from './descriptions.js'
import { type Envelope, failure, success } from './envelope.js'
import { parseRelation, requireRequirement, toErrorEnvelope, usageError } from './errors.js'
import { exitCodeForEnvelope } from './exit.js'
import { parseFieldPaths, projectFields } from './field.js'
import {
  antonymAdd,
  antonymList,
  antonymRemove,
  glossaryAdd,
  glossaryList,
  glossaryRemove,
} from './glossary.js'
import { runInstall } from './install/run.js'
import { buildManifestWithBackends } from './manifest.js'
import { formatEnvelope, type OutputFlags } from './output.js'
import { DocResolveError, docNotFoundEnvelope, resolveDoc } from './resolve-doc.js'
import { runUpdate, runUpdateBulk, runUpdateMany, UPDATE_USAGE } from './update.js'
import { VERSION } from './version.js'
import { waiveAdd, waiveList, waiveRemove } from './waive.js'

// ---------------------------------------------------------------------------
// Global output flags + emit/exit spine
// ---------------------------------------------------------------------------

/**
 * How to pass the requirements-document path — appended to every doc-path usage
 * error so an agent that guessed the wrong argument shape sees the fix inline
 * (rather than a bare "too many arguments" count with no remedy).
 */
const DOC_PATH_HINT =
  'Pass the document via --file <path> or the SYMSPEC_DOC env var (default ./requirements.json).'

/**
 * A read-only `list` subcommand (`glossary list` / `waive list` / `antonym
 * list`) takes NO positional argument — the document path is the `--file`
 * option. But an agent naturally tries `symspec glossary list ./requirements.json`;
 * without help, commander throws a generic ambiguous "too many arguments for
 * 'list'" that never names --file/SYMSPEC_DOC. So each list subcommand accepts a
 * stray positional and this guard rejects it with a specific, actionable
 * ERR_USAGE naming the offending argument and the doc-path convention.
 */
function rejectListPositional(group: string, stray: readonly string[], flags: GlobalFlags): void {
  if (stray.length === 0) return
  emit(
    usageError(
      `${group} list takes no positional argument (got "${stray.join(' ')}"); it is read-only and the document path is not positional here. ${DOC_PATH_HINT}`,
      `symspec ${group} list [--file <path>]`,
    ),
    flags,
  )
}

/** The output-shaping flags every command inherits (AC-6-2a / AC-6-4). */
interface GlobalFlags extends OutputFlags {
  /** `--dense` (AC-6-4): minified, default/null-omitting, evidence-elided JSON. */
  readonly dense?: boolean
  /** `--evidence` (AC-6-4): keep the heavy evidence/atom-table fields under `--dense`. */
  readonly evidence?: boolean
  /**
   * `--field <paths>`: comma-separated dotted paths projecting the envelope down
   * to just those values (jq-style), emitted as JSON. An OUTPUT projection only
   * — never changes data or the exit code. Unresolved paths are omitted.
   */
  readonly field?: string
}

/** Read the merged global flags off the commander program (root-level options). */
function globalFlags(cmd: Command): GlobalFlags {
  // Global options live on the root program; `optsWithGlobals` merges them in.
  return cmd.optsWithGlobals() as GlobalFlags
}

/**
 * Render an envelope to stdout honoring the output flags, then exit with the
 * AC-6-2b code. `--dense` (with optional `--evidence`) minifies; otherwise the
 * default is pretty JSON, with `--pretty`/`--human` opting into prose. The
 * envelope is ALWAYS written regardless of exit code; flags never change it.
 */
function emit(env: Envelope, flags: GlobalFlags): never {
  // `--field` projection (jq-style): reduce the envelope to just the requested
  // dotted paths and emit that as JSON. Applied AFTER densify resolution so a
  // `--dense --field data.verified` projects the densified envelope; the
  // projection operates on the envelope OBJECT (never prose), so it composes
  // with `--dense` but ignores `--pretty` (a field selection is inherently
  // machine output). Unresolved paths are omitted; no path matching ⇒ `{}`.
  if (flags.field !== undefined && flags.field.trim().length > 0) {
    const base =
      flags.dense === true
        ? densifyEnvelope(env, undefined, { keepEvidence: flags.evidence === true })
        : env
    const projected = projectFields(base, parseFieldPaths(flags.field))
    const rendered =
      flags.dense === true ? minifyJson(projected) : JSON.stringify(projected, null, 2)
    process.stdout.write(`${rendered}\n`)
    process.exit(exitCodeForEnvelope(env))
  }
  const rendered =
    flags.dense === true
      ? denseEnvelope(env, undefined, { keepEvidence: flags.evidence === true })
      : formatEnvelope(env, flags)
  process.stdout.write(`${rendered}\n`)
  process.exit(exitCodeForEnvelope(env))
}

/**
 * Load + validate the document at the AC-6-6-resolved path. Returns the doc and
 * its absolute path on success, or the ready-to-emit error envelope on any
 * failure (missing path → ERR_DOC_NOT_FOUND, bad JSON/schema → ERR_DOC_PARSE,
 * stale version → ERR_SCHEMA_VERSION), lifted so nothing escapes as a trace.
 */
async function loadResolved(
  positional: string | undefined,
): Promise<{ doc: RequirementsDoc; path: string } | { envelope: Envelope }> {
  let path: string
  try {
    path = resolveDoc(positional !== undefined ? { positional } : {}).path
  } catch (e) {
    if (e instanceof DocResolveError) return { envelope: docNotFoundEnvelope(e) }
    return { envelope: toErrorEnvelope(e, 'ERR_DOC_NOT_FOUND') }
  }
  try {
    const doc = await loadRequirementsDoc(path)
    return { doc, path }
  } catch (e) {
    return { envelope: toErrorEnvelope(e, 'ERR_DOC_PARSE') }
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

/**
 * The commander program — every command's `.argument()`/`.option()`
 * registration. Exported (not merely module-local) so the manifest round-trip
 * test can introspect each command's accepted flags/args and assert they match
 * what the manifest documents, catching a manifest/parser drift (e.g. the
 * `apply --doc` vs `--file` bug) without spawning a process. Importing this
 * module does NOT parse argv — {@link main} runs only when the module is the
 * process entry (guarded below), so a test can import `program` side-effect-free.
 */
export const program = new Command()

program
  .name('symspec')
  .description(
    'EARS requirements linter for coding agents — parse, lint, and formally check a requirements document.',
  )
  .version(VERSION)
  // Global output flags (AC-6-2a / AC-6-4), inherited by every subcommand.
  .option('--json', 'no-op alias for the default JSON envelope output (AC-6-2a)')
  .option('--pretty', 'render human-readable prose instead of the default JSON envelope')
  .option('--human', 'alias of --pretty')
  .option('--dense', 'minified, default/null-omitting, evidence-elided JSON (AC-6-4)')
  .option('--evidence', 'keep the heavy evidence/atom-table fields under --dense')
  .option(
    '--field <paths>',
    'project the envelope to just these comma-separated dotted paths (e.g. data.verified,data.coverage.demotions); JSON output, unresolved paths omitted',
  )
  // AC-6-10: never let commander print a usage string + exit as a bare process
  // failure; we translate every commander error into an ERR_USAGE envelope.
  .exitOverride()
  .configureOutput({
    // Silence commander's own error prose on stderr — the catch in `main`
    // emits the typed ERR_USAGE envelope instead, so no usage string/stack
    // trace ever reaches the agent. `writeOut` is left at its default so
    // `--version` and `--help` still print (AC-6-7 version test spawns the
    // built binary and asserts `--version` prints package.json's version).
    writeErr: () => {},
  })
  .showHelpAfterError(false)

// --- manifest --------------------------------------------------------------
program
  .command('manifest')
  .description(COMMAND_DESCRIPTIONS.manifest)
  .action(async (_opts, cmd: Command) => {
    const manifest = await buildManifestWithBackends()
    emit(success('manifest', manifest), globalFlags(cmd))
  })

// --- init ------------------------------------------------------------------
program
  .command('init')
  .description(COMMAND_DESCRIPTIONS.init)
  .argument('[file]', 'path to the requirements document to create')
  .option('--force', 'overwrite an existing document instead of refusing (MN4)')
  .action(async (file: string | undefined, opts: { force?: boolean }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const { path } = resolvePathForWrite(file)
    // Non-destructive by default (MN4): refuse to clobber an existing document
    // unless the operator opts in with --force, so an agent retrying `init`
    // after an unrelated error can never silently erase authored requirements.
    if (opts.force !== true && existsSync(path)) {
      emit(
        failure({
          error: `A requirements document already exists at ${path}.`,
          code: 'ERR_DOC_EXISTS',
          suggestions: [
            'Pass --force to overwrite it (this erases its contents).',
            'Or choose a different path — the existing file is left intact.',
          ],
        }),
        flags,
      )
    }
    try {
      await writeDocFile(path, emptyDoc())
    } catch (e) {
      emit(toErrorEnvelope(e, 'ERR_IO'), flags)
    }
    emit(success('init', { path, created: true }), flags)
  })

// --- add -------------------------------------------------------------------
program
  .command('add')
  .description(COMMAND_DESCRIPTIONS.add)
  .argument('[file]', 'path to the requirements document')
  .option('--id <uuid>', 'explicit requirement UUID (default: auto-minted)')
  .option(
    '--key <slug>',
    'stable human key (e.g. G1, AUTH-3) usable in place of the UUID everywhere',
  )
  .option(
    '--dry-run',
    'preview the rendered sentence + lint findings the create would trigger; write nothing',
  )
  .option('--from-parse <prose>', 'a single line of prose to parse into EARS slots')
  .option(
    '--pattern <p>',
    'EARS pattern type (ubiquitous|event-driven|state-driven|optional-feature|unwanted-behavior)',
  )
  .option('--system <s>', "system name (the X in 'the X shall ...')")
  .option('--response <r>', 'system response (what the system shall do)')
  .option('--negated', 'prohibition: render "shall not <response>" (keep --response positive)')
  .option('--trigger <t>', 'trigger clause (event-driven / unwanted-behavior)')
  .option('--pre <p>', 'pre-condition clause (state-driven / optional-feature)')
  .option('--priority <p>', 'priority (low|medium|high|critical)')
  .option('--status <s>', 'status (draft|approved|implemented|verified)')
  .option('--verification <m>', 'verification method (test|inspection|analysis|demonstration)')
  .option(
    '--verification-note <t>',
    'free-text verification-plan note (companion to --verification)',
  )
  // Aliases matching the manifest's argument field names, so an agent that
  // derives flags from `symspec manifest` gets a working call (F1).
  .option('--pattern-type <p>', 'alias of --pattern (manifest field name)')
  .option('--system-name <s>', 'alias of --system (manifest field name)')
  .option('--system-response <r>', 'alias of --response (manifest field name)')
  .option('--pre-condition <p>', 'alias of --pre (manifest field name)')
  .option('--verification-method <m>', 'alias of --verification (manifest field name)')
  .action(async (file: string | undefined, opts: Record<string, string>, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded

    const args = buildAddArgs(opts)
    const result = await runAdd(doc, args)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

// --- update ----------------------------------------------------------------
// Three surfaces on one command (M2 doc-path stays an option):
//   single    update <ref> <attr> <value> | update <ref> <attr> --clear
//   multi (#7) update <ref> attr=val attr2=val2 …
//   bulk (#8)  update --all --where <attr>=<value> <setAttr> <setValue>
// A <ref> accepts a stable key or a UUID (resolved by requireRequirement).
program
  .command('update')
  .description(COMMAND_DESCRIPTIONS.update)
  .argument('[ref]', 'requirement to update — stable key or UUID (omit only in --all bulk mode)')
  .argument(
    '[rest...]',
    'either <attr> <value>, one or more attr=value pairs, or in --all mode the <setAttr> <setValue>',
  )
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .option('--clear', 'clear (remove) an optional attribute instead of setting a value')
  .option('--all', 'bulk mode: apply the set transition to every requirement matching --where')
  .option('--where <attr=value>', 'bulk-mode filter: only requirements whose <attr> equals <value>')
  .action(
    async (
      ref: string | undefined,
      rest: string[],
      opts: { file?: string; clear?: boolean; all?: boolean; where?: string },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const loaded = await loadResolved(opts.file)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc, path } = loaded

      const positionals = ref !== undefined ? [ref, ...rest] : [...rest]

      // --- bulk (#8): --all --where <attr>=<value> <setAttr> <setValue> ------
      if (opts.all === true) {
        const where = parseKeyValue(opts.where)
        if (where === undefined) {
          emit(usageError('--all requires --where <attr>=<value>', UPDATE_USAGE), flags)
        }
        // The set is the two remaining positionals (setAttr setValue) or one
        // attr=value pair.
        const setPair =
          positionals.length === 1
            ? parseKeyValue(positionals[0])
            : { attr: positionals[0] ?? '', value: positionals[1] ?? '' }
        if (setPair === undefined || setPair.attr.length === 0) {
          emit(
            usageError('--all bulk mode requires a <setAttr> <setValue> to apply', UPDATE_USAGE),
            flags,
          )
        }
        const result = runUpdateBulk(doc, where, setPair)
        if ('next' in result) await saveOrEmit(result.next, path, flags)
        emit(result.envelope, flags)
      }

      if (ref === undefined) {
        emit(usageError('update requires a <ref> (key or UUID)', UPDATE_USAGE), flags)
      }

      // --- multi-attr (#7): the first post-ref token is an attr=value pair ---
      if (rest.length >= 1 && rest[0]?.includes('=') === true) {
        const assignments = rest.map((tok) => parseKeyValue(tok))
        if (assignments.some((a) => a === undefined)) {
          emit(
            usageError(
              `every argument must be an attr=value pair; got "${rest.join(' ')}"`,
              UPDATE_USAGE,
            ),
            flags,
          )
        }
        const result = runUpdateMany(
          doc,
          ref as string,
          assignments as { attr: string; value: string }[],
        )
        if ('next' in result) await saveOrEmit(result.next, path, flags)
        emit(result.envelope, flags)
      }

      // --- single-attr (back-compat): <attr> [value] | <attr> --clear -------
      const attr = rest[0]
      const value = rest[1]
      if (attr === undefined) {
        emit(usageError('update requires an <attr>', UPDATE_USAGE), flags)
      }
      const result = runUpdate(doc, {
        id: ref as string,
        attr: attr as string,
        ...(value !== undefined ? { value } : {}),
        ...(opts.clear === true ? { clear: true } : {}),
      })
      if ('next' in result) await saveOrEmit(result.next, path, flags)
      emit(result.envelope, flags)
    },
  )

// --- parse -----------------------------------------------------------------
program
  .command('parse')
  .description(COMMAND_DESCRIPTIONS.parse)
  .argument('[text]', 'a single requirement sentence to parse (one-element batch)')
  .option('--file <path>', 'read requirement lines (one per line) from a file')
  .option('--stdin', 'read requirement lines (one per line) from stdin')
  .action(
    async (text: string | undefined, opts: { file?: string; stdin?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      let inputText: string
      try {
        inputText = await resolveParseInput(text, opts)
      } catch (e) {
        emit(toErrorEnvelope(e, 'ERR_USAGE'), flags)
      }
      const batch = await parseBatch(inputText)
      emit(success('parse', batch), flags)
    },
  )

// --- check -----------------------------------------------------------------
program
  .command('check')
  .description(COMMAND_DESCRIPTIONS.check)
  .argument('[file]', 'path to the requirements document')
  .option('--similarity-threshold <n>', 'pairwise lexical-similarity threshold (0..1)')
  .option('--timeout-ms <n>', 'per-group solver timeout in ms (default 2000)')
  .option('--solver-budget-ms <n>', 'whole-run solver budget in ms')
  .option(
    '--emit-smt2 <path>',
    'also write the portable SMT-LIB2 artifact for the included requirements (AC-4-8)',
  )
  .option(
    '--solver <backend>',
    'formal backend: z3-wasm (default, in-process) | z3-bin | cvc5 (external binary cross-check, AC-4-9)',
  )
  .option('--solver-path <path>', 'explicit path to an external z3/cvc5 binary (AC-4-9)')
  .option(
    '--semantic',
    'deprecated no-op: the semantic tier (local BGE-ONNX model) is always on — it PROPOSES glossary merges and opposition candidates on every check (AC-9-5)',
  )
  .option(
    '--semantic-threshold <n>',
    `cosine threshold for the semantic paraphrase tier (default ${DEFAULT_SEMANTIC_THRESHOLD})`,
  )
  .option(
    '--temporal',
    'opt-in: bounded LTL→SMT temporal-ordering conflict detection (FND_TEMPORAL_CONTRADICTION, AC-33-2)',
  )
  .option('--temporal-bound <k>', 'trace bound k for --temporal (default 10)')
  .option(
    '--min-severity <sev>',
    'output filter: drop findings below <sev> (error|warn|info); never changes the exit code (#5)',
  )
  .option(
    '--findings-only',
    'output filter: return only findings[], dropping the excluded table (#5)',
  )
  .option(
    '--strict',
    'gate: fail (exit 3) when data.verified=false — any uncovered requirement, untriaged opposition candidate, or absent decide-tier comparison; data.coverage.demotions lists the exact discharging ops (#4)',
  )
  .option(
    '--fail-on-unmatched <n>',
    'gate: fail (exit 3) when more than <n> atoms went uncompared (residualRisk.unmatchedAtoms); 0 fails on any (#4)',
  )
  .action(
    async (
      file: string | undefined,
      opts: {
        similarityThreshold?: string
        timeoutMs?: string
        solverBudgetMs?: string
        emitSmt2?: string
        solver?: string
        solverPath?: string
        semantic?: boolean
        semanticThreshold?: string
        temporal?: boolean
        temporalBound?: string
        minSeverity?: string
        findingsOnly?: boolean
        strict?: boolean
        failOnUnmatched?: string
      },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const loaded = await loadResolved(file)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc } = loaded

      // AC-4-9: route to the optional external-binary backend when the operator
      // asks for it (--solver z3-bin|cvc5, or an explicit --solver-path). A
      // discovery miss surfaces as an ERR_SOLVER_MISSING envelope carrying the
      // backend's exact mise-install suggestion, BEFORE any check runs.
      const wantsBinary =
        opts.solverPath !== undefined || opts.solver === 'z3-bin' || opts.solver === 'cvc5'
      if (opts.solver !== undefined && !['z3-wasm', 'z3-bin', 'cvc5'].includes(opts.solver)) {
        emit(
          usageError(
            `Unknown --solver backend "${opts.solver}"`,
            'symspec check [file] --solver <z3-wasm|z3-bin|cvc5>',
          ),
          flags,
        )
      }

      const checkOpts = buildCheckOptions(opts)

      // The semantic tier is CORE (post-adversarial-eval hardening): every
      // `check` loads the embedding model and runs the paraphrase/opposition/
      // graph passes — their findings stay propose-only, but the opposition
      // detector is part of the certification surface (an untriaged candidate
      // demotes `verified`), so skipping it silently would make `--strict`
      // gameable by omission. A missing/unloadable model fails the run CLOSED:
      // ERR_EMBED_MODEL_MISSING (exit 2) BEFORE any tier runs. Pre-warm with
      // `symspec download-model`; air-gapped hosts keep working offline once
      // the sha256-pinned cache is provisioned. `--semantic` is retained as a
      // deprecated no-op alias so existing agent scripts don't break.
      try {
        const { loadEmbedder } = await import('../formal/embed.js')
        const embedder = await loadEmbedder()
        const threshold =
          opts.semanticThreshold !== undefined ? Number(opts.semanticThreshold) : undefined
        checkOpts.semantic = {
          embedder,
          ...(threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {}),
        }
      } catch (e) {
        emit(toErrorEnvelope(e, 'ERR_EMBED_MODEL_MISSING'), flags)
      }

      // AC-33-2: opt-in bounded temporal tier. No model — pure Z3-WASM — so it
      // just flips on with an optional trace bound.
      if (opts.temporal === true) {
        const bound = opts.temporalBound !== undefined ? Number(opts.temporalBound) : undefined
        checkOpts.temporal = bound !== undefined && Number.isFinite(bound) ? { bound } : {}
      }

      // Wishlist #5: validate --min-severity up front so a typo is a clean
      // usage error rather than a silently-ignored filter.
      if (opts.minSeverity !== undefined && !['error', 'warn', 'info'].includes(opts.minSeverity)) {
        emit(
          usageError(
            `Unknown --min-severity "${opts.minSeverity}"`,
            'symspec check [file] --min-severity <error|warn|info>',
          ),
          flags,
        )
      }

      // Wishlist #4: opt-in strict coverage gate. --strict fails an inconclusive
      // run; --fail-on-unmatched <n> fails when too many atoms went uncompared.
      // Validate the threshold up front (a non-negative integer) so a typo is a
      // clean usage error rather than a silently-disabled gate.
      if (opts.strict === true) checkOpts.strict = true
      if (opts.failOnUnmatched !== undefined) {
        const n = Number(opts.failOnUnmatched)
        if (!Number.isInteger(n) || n < 0) {
          emit(
            usageError(
              `--fail-on-unmatched expects a non-negative integer, got "${opts.failOnUnmatched}"`,
              'symspec check [file] --fail-on-unmatched <n>',
            ),
            flags,
          )
        }
        checkOpts.failOnUnmatched = n
      }

      try {
        const fullReport = await runCheck(doc, checkOpts)

        // Wishlist #5: shape the output (never the exit code) for a fix loop.
        const report =
          opts.minSeverity !== undefined || opts.findingsOnly === true
            ? filterReport(fullReport, {
                ...(opts.minSeverity !== undefined
                  ? { minSeverity: opts.minSeverity as CheckSeverity }
                  : {}),
                ...(opts.findingsOnly === true ? { findingsOnly: true } : {}),
              })
            : fullReport

        // AC-4-8: export the portable .smt2 artifact for the included set.
        let emittedSmt2: string | undefined
        if (opts.emitSmt2 !== undefined) {
          const smt2 = emitSmt2(encodeIncluded(doc))
          const { writeFile } = await import('node:fs/promises')
          await writeFile(opts.emitSmt2, smt2, 'utf8')
          emittedSmt2 = opts.emitSmt2
        }

        // AC-4-9: run the same included-requirement artifact through the
        // discovered external binary as a cross-check.
        let binaryCrossCheck: (BinaryCheckResult & { solver: string; version: string }) | undefined
        if (wantsBinary) {
          const discovered = discoverSolverBinary(
            opts.solverPath !== undefined ? { solverPath: opts.solverPath } : {},
          )
          const smt2 = emitSmt2(encodeIncluded(doc))
          const timeoutMs = checkOpts?.timeoutMs
          const result = runSolverBinary(
            smt2,
            discovered,
            timeoutMs !== undefined ? { timeoutMs } : {},
          )
          binaryCrossCheck = { ...result, solver: discovered.bin, version: discovered.version }
        }

        emit(
          success('check', {
            ...report,
            ...(emittedSmt2 !== undefined ? { emittedSmt2 } : {}),
            ...(binaryCrossCheck !== undefined ? { binaryCrossCheck } : {}),
          }),
          flags,
        )
      } catch (e) {
        // AC-4-10: a binary-backend discovery miss is a typed ERR_SOLVER_MISSING
        // envelope (with the mise-install suggestion the backend produces).
        if (e instanceof BinaryBackendError) {
          emit(failure({ error: e.message, code: e.code, suggestions: e.suggestions }), flags)
        }
        if (e instanceof SolverBudgetExceededError) {
          emit(failure({ error: e.message, code: e.code, suggestions: e.suggestions }), flags)
        }
        emit(toErrorEnvelope(e, 'ERR_SOLVER_INCONCLUSIVE'), flags)
      }
    },
  )

// --- certify ---------------------------------------------------------------
program
  .command('certify')
  .description(COMMAND_DESCRIPTIONS.certify)
  .argument('[file]', 'path to the requirements document')
  .option('--out-dir <path>', 'directory for the retained .lean artifact on success')
  .action(async (file: string | undefined, opts: { outDir?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc } = loaded

    // certify is the ONLY command touching src/certify/*. Discover the Lean
    // toolchain first — a missing toolchain is ERR_LEAN_TOOLCHAIN_MISSING and
    // never affects any prior SMT result (AC-5-4/5-5).
    try {
      discoverLeanToolchain()
    } catch (e) {
      emit(toErrorEnvelope(e, 'ERR_LEAN_TOOLCHAIN_MISSING'), flags)
    }

    const theorems = docToTheorems(doc)
    try {
      const result = await runCertify(
        theorems,
        opts.outDir !== undefined ? { outDir: opts.outDir } : {},
      )
      const finding = result.certified
        ? {
            code: 'FND_CERTIFIED' as const,
            severity: 'info' as const,
            message:
              'Lean kernel-checked the batched spec file. NOTE (v2 scope): each ' +
              'requirement is emitted as a placeholder `True` theorem, so this ' +
              'certificate attests only that the Lean toolchain ran and the file ' +
              'elaborates — it does NOT yet encode requirement semantics. A ' +
              'semantic EARS→Lean encoding is a planned successor; the SMT `check` ' +
              'tier is the load-bearing conflict detector today.',
            axioms: result.axioms,
            ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
          }
        : {
            code: 'FND_CERTIFY_FAILED' as const,
            severity: 'error' as const,
            message: 'Lean reported an error-severity diagnostic; the spec did not certify.',
            diagnostics: result.errors,
          }
      emit(success('certify', { certified: result.certified, findings: [finding] }), flags)
    } catch (e) {
      // A spawn failure that slipped past discovery still maps to the missing
      // toolchain code rather than escaping as a stack trace.
      emit(toErrorEnvelope(e, 'ERR_LEAN_TOOLCHAIN_MISSING'), flags)
    }
  })

// --- list ------------------------------------------------------------------
program
  .command('list')
  .description(COMMAND_DESCRIPTIONS.list)
  .argument('[file]', 'path to the requirements document')
  .action(async (file: string | undefined, _opts, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc } = loaded

    const requirements = listRequirements(doc).map((r) => ({
      id: r.id,
      patternType: r.patternType,
      priority: r.priority,
      status: r.status,
      sentence: r.sentence,
    }))
    emit(success('list', { requirements }), flags)
  })

// --- show ------------------------------------------------------------------
program
  .command('show')
  .description(COMMAND_DESCRIPTIONS.show)
  .argument('<id>', 'UUID of the requirement to show')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (id: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc } = loaded

    const found = requireRequirement(doc, id)
    if (!found.ok) emit(found.envelope, flags)
    emit(success('show', { requirement: found.value }), flags)
  })

// --- derive ----------------------------------------------------------------
program
  .command('derive')
  .description(COMMAND_DESCRIPTIONS.derive)
  .argument('<fromId>', 'source requirement UUID (decomposes into the target)')
  .argument('<toId>', 'target requirement UUID')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (fromId: string, toId: string, opts: { file?: string }, cmd: Command) => {
    await runEdgeAdd(opts.file, fromId, 'derives', toId, 'derive', cmd)
  })

// --- satisfy ---------------------------------------------------------------
program
  .command('satisfy')
  .description(COMMAND_DESCRIPTIONS.satisfy)
  .argument('<fromId>', 'source requirement UUID (satisfies the target goal)')
  .argument('<toId>', 'target requirement UUID')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (fromId: string, toId: string, opts: { file?: string }, cmd: Command) => {
    await runEdgeAdd(opts.file, fromId, 'satisfies', toId, 'satisfy', cmd)
  })

// --- remove-edge -----------------------------------------------------------
program
  .command('remove-edge')
  .description(COMMAND_DESCRIPTIONS['remove-edge'])
  .argument('<fromId>', 'source requirement UUID')
  .argument('<relation>', 'edge relation (derives|satisfies|verifies|refines)')
  .argument('<toId>', 'target requirement UUID')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(
    async (
      fromId: string,
      relation: string,
      toId: string,
      opts: { file?: string },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const rel = parseRelation(relation)
      if (!rel.ok) emit(rel.envelope, flags)

      const loaded = await loadResolved(opts.file)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc, path } = loaded

      try {
        const next = applyChange(doc, {
          kind: 'RemoveRelationship',
          from: fromId,
          relation: rel.value,
          to: toId,
        })
        await saveOrEmit(next, path, flags)
        emit(
          success('remove-edge', { from: fromId, relation: rel.value, to: toId, removed: true }),
          flags,
        )
      } catch (e) {
        emit(toErrorEnvelope(e), flags)
      }
    },
  )

// --- delete ----------------------------------------------------------------
program
  .command('delete')
  .description(COMMAND_DESCRIPTIONS.delete)
  .argument('<id>', 'UUID of the requirement to delete')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (id: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded

    try {
      const next = applyChange(doc, { kind: 'DeleteRequirement', id })
      await saveOrEmit(next, path, flags)
      emit(success('delete', { id, deleted: true }), flags)
    } catch (e) {
      emit(toErrorEnvelope(e), flags)
    }
  })

// --- export ----------------------------------------------------------------
program
  .command('export')
  .description(COMMAND_DESCRIPTIONS.export)
  .argument('[file]', 'path to the requirements document')
  .action(async (file: string | undefined, _opts, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc } = loaded
    emit(success('export', exportSysml(doc)), flags)
  })

// --- glossary --------------------------------------------------------------
// AC-9-6: manage the committed synonym glossary the formal tier canonicalizes
// through (AC-9-2). The DECIDE half of the semantic tier.
const glossaryCmd = program.command('glossary').description(COMMAND_DESCRIPTIONS.glossary)

glossaryCmd
  .command('add')
  .description('Add an alias phrasing under a canonical phrase (idempotent).')
  .argument('<canonical>', 'the canonical response phrasing')
  .argument('<alias>', 'a synonymous phrasing to merge into the canonical')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (canonical: string, alias: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded
    const result = glossaryAdd(doc, canonical, alias)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

glossaryCmd
  .command('remove')
  .description('Remove an alias from a canonical group (no-op if absent).')
  .argument('<canonical>', 'the canonical response phrasing')
  .argument('<alias>', 'the alias phrasing to remove')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (canonical: string, alias: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded
    const result = glossaryRemove(doc, canonical, alias)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

glossaryCmd
  .command('list')
  .description('List the committed synonym groups (read-only).')
  // Accept-and-reject a stray positional so a mistaken `glossary list <doc>`
  // yields a specific ERR_USAGE naming --file/SYMSPEC_DOC, not commander's
  // generic "too many arguments" (the doc path is the --file option here).
  .argument('[stray...]', 'not accepted — the document path is the --file option')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (stray: string[], opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    rejectListPositional('glossary', stray, flags)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    emit(glossaryList(loaded.doc).envelope, flags)
  })

// --- download-model --------------------------------------------------------
// AC-9-4 pre-warm: fetch + sha256-verify the semantic tier's embedding model so
// `check --semantic` runs fully offline afterward. No document is touched.
program
  .command('download-model')
  .description(COMMAND_DESCRIPTIONS['download-model'])
  .action(async (_opts, cmd: Command) => {
    const flags = globalFlags(cmd)
    try {
      const report = await downloadModelAssets()
      emit(success('download-model', report), flags)
    } catch (e) {
      emit(toErrorEnvelope(e, 'ERR_EMBED_MODEL_MISSING'), flags)
    }
  })

// --- apply -----------------------------------------------------------------
// Wishlist #1: apply a JSONL op stream in one process + one atomic save.
program
  .command('apply')
  .description(COMMAND_DESCRIPTIONS.apply)
  .argument('[file]', 'path to a JSONL op file (one {op,...} record per line)')
  .option('--doc <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .option('--stdin', 'read the JSONL op stream from stdin instead of a file')
  .option(
    '--continue-on-error',
    'best-effort: apply the ops that succeed and save once, instead of aborting on the first error',
  )
  .action(
    async (
      file: string | undefined,
      opts: { doc?: string; stdin?: boolean; continueOnError?: boolean },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const loaded = await loadResolved(opts.doc)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc, path } = loaded

      // The op stream comes from --stdin or the [file] positional. The document
      // path is the separate --doc option, so the positional is unambiguously
      // the op file (never mistaken for the doc).
      let opsText: string
      try {
        if (opts.stdin === true) {
          opsText = await readStdin()
        } else if (file !== undefined) {
          const { readFile } = await import('node:fs/promises')
          opsText = await readFile(file, 'utf8')
        } else {
          emit(usageError('apply requires an ops [file] or --stdin', APPLY_USAGE), flags)
        }
      } catch (e) {
        emit(toErrorEnvelope(e, 'ERR_IO'), flags)
      }

      const result = runApply(
        doc,
        opsText,
        opts.continueOnError === true ? { continueOnError: true } : {},
      )
      if ('next' in result) await saveOrEmit(result.next, path, flags)
      emit(result.envelope, flags)
    },
  )

// --- waive -----------------------------------------------------------------
// Wishlist #3: manage committed finding waivers `check` honors.
const waiveCmd = program.command('waive').description(COMMAND_DESCRIPTIONS.waive)

waiveCmd
  .command('add')
  .description('Record a reviewed waiver suppressing a finding code (idempotent).')
  .argument('<code>', 'the finding code to waive (e.g. GTWR_R6_MISSING_UNITS)')
  .requiredOption('--reason <why>', 'why this finding is waived (the audit trail)')
  .option('--ref <keyOrId>', 'scope the waiver to one requirement (stable key or UUID)')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(
    async (code: string, opts: { reason: string; ref?: string; file?: string }, cmd: Command) => {
      const flags = globalFlags(cmd)
      const loaded = await loadResolved(opts.file)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc, path } = loaded
      const result = waiveAdd(doc, code, opts.reason, opts.ref)
      if ('next' in result) await saveOrEmit(result.next, path, flags)
      emit(result.envelope, flags)
    },
  )

waiveCmd
  .command('remove')
  .description('Retract a waiver (no-op if absent).')
  .argument('<code>', 'the finding code whose waiver to remove')
  .option(
    '--ref <keyOrId>',
    'the requirement scope of the waiver to remove (omit for document-wide)',
  )
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (code: string, opts: { ref?: string; file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded
    const result = waiveRemove(doc, code, opts.ref)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

waiveCmd
  .command('list')
  .description('List the committed finding waivers (read-only).')
  // Accept-and-reject a stray positional (see glossary list above).
  .argument('[stray...]', 'not accepted — the document path is the --file option')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (stray: string[], opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    rejectListPositional('waive', stray, flags)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    emit(waiveList(loaded.doc).envelope, flags)
  })

// --- antonym ---------------------------------------------------------------
// #1: manage committed antonym pairs — the opposition analogue of `glossary`.
// An `antonym add open shut` collapses open/shut onto one atom at opposite
// polarity so the SMT contradiction tier can prove the conflict. The DECIDE
// half for opposition, mirroring glossary's DECIDE half for synonymy.
const antonymCmd = program.command('antonym').description(COMMAND_DESCRIPTIONS.antonym)

antonymCmd
  .command('add')
  .description('Assert two response verb-heads are polar opposites (idempotent).')
  .argument('<a>', 'one response verb-head, e.g. open')
  .argument('<b>', 'the polar-opposite response verb-head, e.g. shut')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (a: string, b: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded
    const result = antonymAdd(doc, a, b)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

antonymCmd
  .command('remove')
  .description('Retract an antonym pair (no-op if absent; matches either order).')
  .argument('<a>', 'one response verb-head of the pair to remove')
  .argument('<b>', 'the other response verb-head of the pair to remove')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (a: string, b: string, opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    const { doc, path } = loaded
    const result = antonymRemove(doc, a, b)
    if ('next' in result) await saveOrEmit(result.next, path, flags)
    emit(result.envelope, flags)
  })

antonymCmd
  .command('list')
  .description('List the committed antonym pairs (read-only).')
  // Accept-and-reject a stray positional (see glossary list above).
  .argument('[stray...]', 'not accepted — the document path is the --file option')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (stray: string[], opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
    rejectListPositional('antonym', stray, flags)
    const loaded = await loadResolved(opts.file)
    if ('envelope' in loaded) emit(loaded.envelope, flags)
    emit(antonymList(loaded.doc).envelope, flags)
  })

// --- install ---------------------------------------------------------------
// Drop the symspec skill into each detected agent host's dedicated dir; never
// edits a host's root instruction file.
program
  .command('install')
  .description(COMMAND_DESCRIPTIONS.install)
  .option('--global', 'install into your home config instead of the current project')
  .option('--target <sel>', 'hosts to target: auto (default) | all | csv of ids')
  .option('--uninstall', "remove symspec's skill file from each target host")
  .option('--check', 'report what would be written (present/missing) without writing')
  .option('--print <id>', 'print one host’s exact skill-file content and exit; write nothing')
  .action(
    async (
      opts: {
        global?: boolean
        target?: string
        uninstall?: boolean
        check?: boolean
        print?: string
      },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const { homedir } = await import('node:os')
      const env = await runInstall({
        location: opts.global === true ? 'global' : 'local',
        ...(opts.target !== undefined ? { target: opts.target } : {}),
        ...(opts.uninstall === true ? { uninstall: true } : {}),
        ...(opts.check === true ? { check: true } : {}),
        ...(opts.print !== undefined ? { print: opts.print } : {}),
        cwd: process.cwd(),
        home: homedir(),
      })
      emit(env, flags)
    },
  )

// ---------------------------------------------------------------------------
// Shared command helpers
// ---------------------------------------------------------------------------

/** Resolve the write-target path for `init` (path need not exist yet). */
function resolvePathForWrite(file: string | undefined): { path: string } {
  // `resolveDoc` requires existence; init creates the file, so use the pure
  // precedence resolver instead by catching the not-found and reusing its path.
  try {
    return { path: resolveDoc(file !== undefined ? { positional: file } : {}).path }
  } catch (e) {
    if (e instanceof DocResolveError) return { path: e.path }
    throw e
  }
}

/** Map raw `add` slot flags to the {@link runAdd} argument shape (AC-2-10). */
function buildAddArgs(opts: Record<string, string | boolean>): Parameters<typeof runAdd>[1] {
  const dryRun = opts.dryRun === true ? { dryRun: true as const } : {}
  if (typeof opts.fromParse === 'string') {
    // --from-parse determines polarity itself (the parse tier's AC-2-4 flag);
    // an explicit --negated here would be redundant/ambiguous, so it is ignored
    // on the prose path. --key/--dry-run still apply.
    return {
      ...(typeof opts.id === 'string' ? { id: opts.id } : {}),
      ...dryRun,
      fromParse: opts.fromParse,
    }
  }
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined
  const slots: Record<string, unknown> = {}
  // Short flags and their manifest-field-name aliases (F1); short flag wins.
  const pattern = str(opts.pattern) ?? str(opts.patternType)
  const system = str(opts.system) ?? str(opts.systemName)
  const response = str(opts.response) ?? str(opts.systemResponse)
  const pre = str(opts.pre) ?? str(opts.preCondition)
  const verification = str(opts.verification) ?? str(opts.verificationMethod)
  if (typeof opts.key === 'string') slots.key = opts.key
  if (pattern !== undefined) slots.patternType = pattern
  if (system !== undefined) slots.systemName = system
  if (response !== undefined) slots.systemResponse = response
  if (opts.negated === true) slots.negated = true
  if (typeof opts.trigger === 'string') slots.trigger = opts.trigger
  if (pre !== undefined) slots.preCondition = pre
  if (typeof opts.priority === 'string') slots.priority = opts.priority
  if (typeof opts.status === 'string') slots.status = opts.status
  if (verification !== undefined) slots.verificationMethod = verification
  if (typeof opts.verificationNote === 'string') slots.verificationNote = opts.verificationNote
  // Slots pass through to applyChange's ChangeSchema.parse, which rejects a bad
  // shape as a typed envelope (never a stack trace) — so no flag-layer Zod here.
  return {
    ...(typeof opts.id === 'string' ? { id: opts.id } : {}),
    ...dryRun,
    slots: slots as z.infer<typeof CreateRequirementAttrsSchema>,
  }
}

/**
 * Split an `attr=value` token into its parts, or `undefined` when it carries no
 * `=`. The value may itself contain `=` (split on the FIRST only), and both
 * sides are used verbatim — an empty attr (leading `=`) yields `undefined` so a
 * malformed pair is rejected upstream. Shared by `update`'s multi-attr (#7) and
 * bulk `--where`/set (#8) paths.
 */
function parseKeyValue(token: string | undefined): { attr: string; value: string } | undefined {
  if (token === undefined) return undefined
  const eq = token.indexOf('=')
  if (eq <= 0) return undefined
  return { attr: token.slice(0, eq), value: token.slice(eq + 1) }
}

/** Build the {@link runCheck} options from the raw string flags (AC-6-8 wiring). */
function buildCheckOptions(opts: {
  similarityThreshold?: string
  timeoutMs?: string
  solverBudgetMs?: string
}): NonNullable<Parameters<typeof runCheck>[1]> {
  const out: NonNullable<Parameters<typeof runCheck>[1]> = {}
  if (opts.similarityThreshold !== undefined) {
    const n = Number(opts.similarityThreshold)
    if (Number.isFinite(n)) out.similarityThreshold = n
  }
  if (opts.timeoutMs !== undefined) {
    const n = Number(opts.timeoutMs)
    if (Number.isFinite(n)) out.timeoutMs = n
  }
  if (opts.solverBudgetMs !== undefined) {
    const n = Number(opts.solverBudgetMs)
    if (Number.isFinite(n)) out.solverBudgetMs = n
  }
  return out
}

/** Read `--file`/`--stdin`/positional text into one batch string (AC-2-9). */
async function resolveParseInput(
  text: string | undefined,
  opts: { file?: string; stdin?: boolean },
): Promise<string> {
  if (opts.file !== undefined) {
    const { readFile } = await import('node:fs/promises')
    return readFile(opts.file, 'utf8')
  }
  if (opts.stdin === true) {
    return readStdin()
  }
  if (text !== undefined) return text
  throw new Error('parse requires a <text> argument, --file <path>, or --stdin')
}

/** Drain stdin to a string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build one core-Lean theorem per requirement for the certify tier. No doc→Lean
 * semantic encoder exists in the codebase (none is assigned by any AC), so each
 * requirement maps to a trivial kernel-decidable placeholder proposition keyed
 * by its sanitized UUID. The load-bearing certify contracts (batched single
 * file, `#print axioms` provenance, ERR_LEAN_TOOLCHAIN_MISSING) hold regardless
 * of the proposition body.
 */
function docToTheorems(doc: RequirementsDoc): Parameters<typeof runCertify>[0] {
  // v2 SCOPE LIMITATION (validate-critic M3): each requirement maps to a
  // placeholder `True` theorem. This exercises the full Lean toolchain path
  // (batched file emission, elaboration, `#print axioms` provenance, artifact
  // retention) but does NOT encode requirement semantics — a real EARS→Lean
  // encoding is planned successor work (see .erpaval/specs/001-symspec-v2/
  // followups.md). The certify finding message discloses this to the caller,
  // and the SMT `check` tier remains the actual conflict detector.
  return listRequirements(doc).map((r) => ({
    name: `req_${sanitizeLeanName(r.id)}`,
    statement: 'True',
    tactic: 'decide' as const,
  }))
}

/**
 * Add a typed edge from `fromId` to `toId`. Shared by `derive`/`satisfy`.
 * Resolves + loads the doc, applies the AddRelationship Change (idempotent),
 * saves, and emits — lifting any coded core error (e.g. missing source →
 * ERR_NOT_FOUND-shaped) to an envelope.
 */
async function runEdgeAdd(
  file: string | undefined,
  fromId: string,
  relation: 'derives' | 'satisfies',
  toId: string,
  type: 'derive' | 'satisfy',
  cmd: Command,
): Promise<never> {
  const flags = globalFlags(cmd)
  const loaded = await loadResolved(file)
  if ('envelope' in loaded) emit(loaded.envelope, flags)
  const { doc, path } = loaded

  // Fail fast with ERR_NOT_FOUND if the source requirement is absent, rather
  // than surfacing applyChange's untyped "not found" throw (AC-6-10).
  const source = requireRequirement(doc, fromId)
  if (!source.ok) emit(source.envelope, flags)

  try {
    const next = applyChange(doc, { kind: 'AddRelationship', from: fromId, relation, to: toId })
    await saveOrEmit(next, path, flags)
    emit(success(type, { from: fromId, relation, to: toId, added: true }), flags)
  } catch (e) {
    emit(toErrorEnvelope(e), flags)
  }
}

/** Persist a mutated document atomically; emit an ERR_IO envelope on failure. */
async function saveOrEmit(next: RequirementsDoc, path: string, flags: GlobalFlags): Promise<void> {
  try {
    await writeDocFile(path, next)
  } catch (e) {
    emit(toErrorEnvelope(e, 'ERR_IO'), flags)
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse argv and dispatch. Commander's `exitOverride` turns a usage error
 * (unknown command, missing required arg, unknown option) into a thrown
 * `CommanderError`; we translate it into an `ERR_USAGE` envelope on stdout
 * (AC-6-10) rather than letting a stack trace or bare exit escape. The
 * `--version`/`--help` "errors" are commander's normal control flow and exit 0.
 */
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (e) {
    const code = (e as { code?: string }).code
    // commander uses these codes for the help/version fast-exit paths.
    if (
      code === 'commander.helpDisplayed' ||
      code === 'commander.version' ||
      code === 'commander.help'
    ) {
      process.exit(0)
    }
    const message = e instanceof Error ? e.message : String(e)
    // An arity error (too many / missing positional) most often means an agent
    // passed the requirements-document path positionally on a command that takes
    // it via --file (delete/derive/satisfy/remove-edge/waive/…). Commander's
    // message already names the expected-vs-got count; append the concrete
    // remedy so the error is actionable rather than just a count.
    const isArityError =
      code === 'commander.excessArguments' || code === 'commander.missingArgument'
    const extra = isArityError ? [DOC_PATH_HINT] : []
    const env = usageError(
      message.length > 0 ? message : 'invalid command or arguments',
      'symspec <command> [args] — run `symspec manifest` for the full command surface',
      extra,
    )
    process.stdout.write(`${formatEnvelope(env)}\n`)
    process.exit(exitCodeForEnvelope(env))
  }
}

// Run the CLI only when this module IS the process — i.e. spawned as the binary
// (`node dist/cli.mjs …`, `tsx src/cli/index.ts …`, or the `bin/symspec.mjs`
// wrapper in production) — and never when a vitest unit test merely imports it
// to introspect `program`. Production has no VITEST env, so `!underVitest` runs
// main there; integration tests spawn the module AS the entry, so `isEntry`
// runs it; only a unit-test dependency import (under vitest, not the entry
// module) is suppressed, keeping `import { program }` side-effect-free.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url)
const underVitest = process.env.VITEST !== undefined
if (isEntry || !underVitest) {
  void main()
}
