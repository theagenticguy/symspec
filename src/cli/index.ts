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
import { parseBatch } from '../parse/batch.js'
import { encodeIncluded, runCheck } from '../pipeline/check.js'
import { runAdd } from './add.js'
import { denseEnvelope } from './dense.js'
import { COMMAND_DESCRIPTIONS } from './descriptions.js'
import { type Envelope, failure, success } from './envelope.js'
import { parseRelation, requireRequirement, toErrorEnvelope, usageError } from './errors.js'
import { exitCodeForEnvelope } from './exit.js'
import { glossaryAdd, glossaryList, glossaryRemove } from './glossary.js'
import { buildManifestWithBackends } from './manifest.js'
import { formatEnvelope, type OutputFlags } from './output.js'
import { DocResolveError, docNotFoundEnvelope, resolveDoc } from './resolve-doc.js'
import { runUpdate } from './update.js'
import { VERSION } from './version.js'

// ---------------------------------------------------------------------------
// Global output flags + emit/exit spine
// ---------------------------------------------------------------------------

/** The output-shaping flags every command inherits (AC-6-2a / AC-6-4). */
interface GlobalFlags extends OutputFlags {
  /** `--dense` (AC-6-4): minified, default/null-omitting, evidence-elided JSON. */
  readonly dense?: boolean
  /** `--evidence` (AC-6-4): keep the heavy evidence/atom-table fields under `--dense`. */
  readonly evidence?: boolean
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

const program = new Command()

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
program
  .command('update')
  .description(COMMAND_DESCRIPTIONS.update)
  .argument('<id>', 'UUID of the requirement to update')
  .argument('<attr>', 'attribute to set')
  .argument('[value]', 'new value (omit and pass --clear to remove an optional attr)')
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .option('--clear', 'clear (remove) an optional attribute instead of setting a value')
  .action(
    async (
      id: string,
      attr: string,
      value: string | undefined,
      opts: { file?: string; clear?: boolean },
      cmd: Command,
    ) => {
      const flags = globalFlags(cmd)
      const loaded = await loadResolved(opts.file)
      if ('envelope' in loaded) emit(loaded.envelope, flags)
      const { doc, path } = loaded

      const result = runUpdate(doc, {
        id,
        attr,
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
    'opt-in: embed responses (local BGE-ONNX model) to PROPOSE glossary merges for paraphrased conflicts (AC-9-5)',
  )
  .option('--semantic-threshold <n>', 'cosine threshold for --semantic (default 0.82)')
  .option(
    '--temporal',
    'opt-in: bounded LTL→SMT temporal-ordering conflict detection (FND_TEMPORAL_CONTRADICTION, AC-33-2)',
  )
  .option('--temporal-bound <k>', 'trace bound k for --temporal (default 10)')
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

      // AC-9-5: opt-in semantic pass. Load the embedding model lazily and only
      // when --semantic is set, so the default check never touches it. A
      // missing/unloadable model surfaces as ERR_EMBED_MODEL_MISSING BEFORE the
      // run rather than blocking the SMT/lint tiers.
      if (opts.semantic === true) {
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
      }

      // AC-33-2: opt-in bounded temporal tier. No model — pure Z3-WASM — so it
      // just flips on with an optional trace bound.
      if (opts.temporal === true) {
        const bound = opts.temporalBound !== undefined ? Number(opts.temporalBound) : undefined
        checkOpts.temporal = bound !== undefined && Number.isFinite(bound) ? { bound } : {}
      }

      try {
        const report = await runCheck(doc, checkOpts)

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
  .option('--file <path>', 'path to the requirements document (overrides SYMSPEC_DOC / default)')
  .action(async (opts: { file?: string }, cmd: Command) => {
    const flags = globalFlags(cmd)
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
  if (typeof opts.fromParse === 'string') {
    // --from-parse determines polarity itself (the parse tier's AC-2-4 flag);
    // an explicit --negated here would be redundant/ambiguous, so it is ignored
    // on the prose path.
    return {
      ...(typeof opts.id === 'string' ? { id: opts.id } : {}),
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
  if (pattern !== undefined) slots.patternType = pattern
  if (system !== undefined) slots.systemName = system
  if (response !== undefined) slots.systemResponse = response
  if (opts.negated === true) slots.negated = true
  if (typeof opts.trigger === 'string') slots.trigger = opts.trigger
  if (pre !== undefined) slots.preCondition = pre
  if (typeof opts.priority === 'string') slots.priority = opts.priority
  if (typeof opts.status === 'string') slots.status = opts.status
  if (verification !== undefined) slots.verificationMethod = verification
  // Slots pass through to applyChange's ChangeSchema.parse, which rejects a bad
  // shape as a typed envelope (never a stack trace) — so no flag-layer Zod here.
  return {
    ...(typeof opts.id === 'string' ? { id: opts.id } : {}),
    slots: slots as z.infer<typeof CreateRequirementAttrsSchema>,
  }
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
    const env = usageError(
      message.length > 0 ? message : 'invalid command or arguments',
      'symspec <command> [args] — run `symspec manifest` for the full command surface',
    )
    process.stdout.write(`${formatEnvelope(env)}\n`)
    process.exit(exitCodeForEnvelope(env))
  }
}

void main()
