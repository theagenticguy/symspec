/**
 * `install` — write symspec's skill file into every agent host present (spec AC-A-5).
 *
 * ## What this operation is
 *
 * v4's install surface, ported through the kernel with the three V11 defects fixed
 * (see `../install/targets.ts` for each fix and why porting a known defect would be the
 * wrong call). The body it writes is GENERATED from the operations table, the craft
 * corpus, and the scope corpus, so an installed skill can never teach an agent something
 * the manifest contradicts.
 *
 * ## Four modes on one operation, not four operations
 *
 * `install` / `uninstall` / `check` / `print` are one table entry with a `mode` field
 * rather than four, because they share the whole target-resolution surface and differ only
 * in what they do with a resolved path. Four operations would mean four manifest rows
 * publishing four copies of `--target`'s semantics — and v4's own defect at this
 * seam (a manifest row describing `--file` for a command registered as `--doc`) is what
 * that duplication costs.
 *
 * `mode` is a closed literal set, so an invalid value is a decode failure naming the legal
 * ones rather than a silent no-op.
 *
 * ## Why the write goes through the platform FileSystem
 *
 * `../install/write-safety.ts` records the full reasoning; the short version is that it
 * makes the host→path matrix testable against an in-memory filesystem. A test that had to
 * write into the developer's real `~/.claude` to prove the global path is correct would be
 * either skipped or dangerous, and the matrix is exactly what AC-A-5 asks to be verified.
 */

import { Effect, type FileSystem, type Path, Schema } from 'effect'
import { type ErrIo, ErrUsage } from '../../ports/errors.ts'
import { buildSkillBody } from '../install/skill-body.ts'
import {
  type AgentTarget,
  type InstallLocation,
  knownTargets,
  resolveTargets,
  SKILL_NAME,
  SKIPPED_HOSTS,
  TARGETS,
  targetById,
} from '../install/targets.ts'
import { type FileResult, removeManagedFile, writeManagedFile } from '../install/write-safety.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

// ---------------------------------------------------------------------------
// The roots service
// ---------------------------------------------------------------------------

/**
 * Where "local" and "global" resolve to.
 *
 * A plain argument threaded through rather than a service, because unlike the document
 * store there is no I/O to fake here — the roots are two strings, and taking them as
 * parameters is what lets every path assertion run against a temp directory. The
 * composition root supplies the real ones.
 */
export interface InstallRoots {
  readonly cwd: string
  readonly home: string
}

/**
 * The roots this process installs into: its cwd and the user's home.
 *
 * ## The two test overrides, and why they are in production code
 *
 * `SYMSPEC_TEST_CWD` / `SYMSPEC_TEST_HOME` exist so the test suite can assert the
 * host→path matrix — including the `--global` paths — against a temp directory instead of
 * the developer's real `~/.claude`. Without them the only ways to test a global install
 * would be to mutate `process.cwd()`/`$HOME` for a whole vitest worker (hostile to every
 * other suite in the same process) or to write into the real home (either skipped, or
 * genuinely dangerous the first time someone runs the suite with a populated `.claude`).
 *
 * Deliberately NOT documented as user-facing configuration, and deliberately not the
 * general `SYMSPEC_DOC`-style convention: the names say `TEST`, they are read only here,
 * and an ordinary invocation never sets them. The alternative — an `InstallRoots` service
 * threaded through a Layer — is what `DocPath` does and would be the right shape if the
 * roots had any production variability. They do not: there is exactly one cwd and one
 * home, so a service would be ceremony around two strings, and the honest minimum is an
 * override that says out loud what it is for.
 */
export const processRoots = (): InstallRoots => ({
  cwd: process.env.SYMSPEC_TEST_CWD ?? process.cwd(),
  home:
    process.env.SYMSPEC_TEST_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
})

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** One host's outcome. */
export interface TargetResult {
  readonly host: string
  readonly label: string
  /** The host products this one file serves — the positive form of the old skip list. */
  readonly serves: readonly string[]
  readonly location: InstallLocation
  readonly files: readonly FileResult[]
  /** A human note: why a location was unsupported, or the previewed contents. */
  readonly note?: string
}

/** The `install` payload. */
export interface InstallPayload {
  readonly mode: 'install' | 'uninstall' | 'check' | 'print'
  readonly location: InstallLocation
  /** How the target set was chosen. `fallback` means no host marker was found. */
  readonly basis: 'detected' | 'fallback' | 'explicit'
  readonly targets: readonly TargetResult[]
  /**
   * Hosts with no serviceable surface.
   *
   * EMPTY as of the V11 fix — v4 listed opencode and gemini here while
   * `agents-standard` was already serving both. Kept as a field because it is agent API
   * and should not appear and disappear with its own contents.
   */
  readonly skipped: readonly { readonly host: string; readonly reason: string }[]
  /** Present when `basis` is `fallback`: what was chosen with no evidence, and why. */
  readonly note?: string
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const lines = (...xs: readonly string[]): string => xs.join('\n')

const MODES = ['install', 'uninstall', 'check', 'print'] as const

const InstallInput = Schema.Struct({
  // NOTE the `readonly` in the type argument — `Schema.Literals` infers its tuple as
  // readonly, and omitting it is a TS2345 at the `withDecodingDefaultKey` call rather
  // than at the `Literals` call (beta.102 delta #22).
  mode: Schema.withDecodingDefaultKey<Schema.Literals<typeof MODES>>(Effect.succeed('install'))(
    Schema.Literals(MODES).annotate({
      default: 'install',
      description: lines(
        'What to do with each resolved target:',
        '  - install (the default): write the skill file.',
        '  - uninstall: remove symspec`s skill file. Safe to repeat; an absent file is `unchanged`.',
        '  - check: report what WOULD be written and whether it is already current. No writes.',
        '  - print: emit the exact file contents for review. No writes.',
        'install and uninstall are idempotent: a byte-identical file is reported `unchanged` and',
        'not rewritten, so re-running is a quiet no-op.',
      ),
    }),
  ),
  target: Schema.withDecodingDefaultKey<Schema.NullOr<Schema.String>>(Effect.succeed(null))(
    Schema.NullOr(Schema.String).annotate({
      default: null,
      description: lines(
        'Which hosts to act on. Omit for `auto`.',
        '  - auto (the default): every host whose config directory exists — and when NONE does,',
        '    the `agents-standard` skill (.agents/skills), which Cursor, Codex CLI, opencode, and',
        '    Gemini CLI all read. `auto` therefore never installs nothing; `data.basis` reports',
        '    `fallback` when it had no evidence to go on.',
        '  - all: every registered target.',
        `  - a comma-separated list of ids: ${knownTargets()}.`,
        'symspec NEVER edits a host`s root instruction file (CLAUDE.md / AGENTS.md / GEMINI.md);',
        'each target owns one file in a dedicated skill or rules directory.',
      ),
    }),
  ),
  global: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
    Schema.Boolean.annotate({
      default: false,
      description: lines(
        'Install into the user`s home config instead of the project. Not every host supports a',
        'global install (Windsurf and Copilot are project-scoped); an unsupported host is reported',
        'with a note rather than silently skipped.',
      ),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Per-mode work
// ---------------------------------------------------------------------------

/** The rendered bytes one target writes. */
const contentsFor = (target: AgentTarget): string => target.render(buildSkillBody())

/**
 * The skip list, projected onto the envelope's `{host, reason}` shape.
 *
 * The registry keys it as `id` (matching a target's own `id`) while the wire field is
 * `host` — v4's shipped name, preserved because it is agent API. One projection
 * rather than two spellings of the same list.
 */
const skippedList = (): readonly { readonly host: string; readonly reason: string }[] =>
  SKIPPED_HOSTS.map((entry) => ({ host: entry.id, reason: entry.reason }))

/** Act on one target, in one mode. */
const runTarget = (
  target: AgentTarget,
  mode: (typeof MODES)[number],
  location: InstallLocation,
  roots: InstallRoots,
): Effect.Effect<TargetResult, ErrIo, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const base = {
      host: target.id,
      label: target.label,
      serves: target.serves,
      location,
    } as const

    // A host that does not support the requested location is REPORTED, never written to a
    // location it cannot read. The note says which, so `--global` against a
    // project-scoped host is legible rather than a silent omission.
    if (!target.supportsLocation(location)) {
      return {
        ...base,
        files: [],
        note: `skipped — ${target.label} does not support a ${location} install`,
      }
    }

    const path = target.pathFor(location, roots.cwd, roots.home)

    if (mode === 'print') {
      return { ...base, files: [{ path, action: 'unchanged' }], note: contentsFor(target) }
    }

    if (mode === 'check') {
      const detection = target.detect(location, roots.cwd, roots.home)
      return {
        ...base,
        // `created` is what WOULD happen — the mode reports intent, and the `note` says
        // which of the two it is so a reader never has to infer it from the action name.
        files: [{ path, action: detection.alreadyConfigured ? 'unchanged' : 'created' }],
        note: detection.alreadyConfigured ? 'present' : 'missing',
      }
    }

    if (mode === 'uninstall') {
      const file = yield* removeManagedFile(path)
      return { ...base, files: [file] }
    }

    const file = yield* writeManagedFile(path, contentsFor(target))
    return { ...base, files: [file] }
  })

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * `install` — put the symspec skill where each agent host will find it.
 *
 * Always exit 0 on a successful run, including a `check` mode that found a missing file:
 * `check` REPORTS state, and reporting "missing" is a successful report. A caller that
 * wants a gate reads `data.targets[].note`, which is the same discipline the rest of the
 * envelope follows — the operation puts facts in the payload and the exit contract reads
 * the payload, so nothing here needs to smuggle a status out of band.
 */
export const installOp = defineOperation({
  name: 'install',
  summary: 'Install the symspec agent skill into every detected coding-agent host',
  type: 'install',
  input: InstallInput,
  handler: (input) =>
    Effect.gen(function* () {
      const roots = processRoots()
      const location: InstallLocation = input.global ? 'global' : 'local'

      // `print` acts on exactly ONE target, because emitting five files' contents into one
      // envelope field is not a preview anyone can read. Resolved before the general path
      // so the error message can name the actual constraint.
      if (input.mode === 'print') {
        const id = input.target
        if (id === null || id.includes(',') || id === 'all' || id === 'auto') {
          return yield* Effect.fail(
            new ErrUsage({
              error:
                '--mode print needs exactly one --target id: it emits that target`s file contents, ' +
                'and five files in one field is not a preview.',
              suggestions: [`Known targets: ${knownTargets()}.`],
              repair: {
                ops: [],
                commands: [`symspec install --mode print --target ${TARGETS[0]?.id ?? SKILL_NAME}`],
              },
            }),
          )
        }
        const target = targetById(id)
        if (target === undefined) {
          return yield* Effect.fail(
            new ErrUsage({
              error: `Unknown --target "${id}".`,
              suggestions: [`Known targets: ${knownTargets()}.`],
              repair: {
                ops: [],
                commands: [`symspec install --mode print --target ${TARGETS[0]?.id ?? SKILL_NAME}`],
              },
            }),
          )
        }
        const result = yield* runTarget(target, 'print', location, roots)
        // Annotated `: InstallPayload` rather than `satisfies`, deliberately. `satisfies`
        // preserves the literal type, so this arm inferred `mode: 'print'` while the arm
        // below inferred `mode: 'install' | 'uninstall' | 'check'` — two different payload
        // types, which made the handler's return a UNION the operation's declared type
        // could not accept (TS2375). Widening each arm to the payload type at the point of
        // construction is the fix, and it is also the honest statement: both arms produce
        // the same published shape.
        const payload: InstallPayload = {
          mode: 'print',
          location,
          basis: 'explicit',
          targets: [result],
          skipped: skippedList(),
        }
        return ok('install', payload)
      }

      const resolved = resolveTargets(input.target, location, roots.cwd, roots.home)
      if ('error' in resolved) {
        return yield* Effect.fail(
          new ErrUsage({
            error: resolved.error,
            suggestions: [
              `Known targets: ${knownTargets()}.`,
              'Omit --target for `auto`, which installs the .agents/skills standard when no host marker is found.',
            ],
            repair: { ops: [], commands: ['symspec install'] },
          }),
        )
      }

      const results: TargetResult[] = []
      for (const target of resolved.targets) {
        results.push(yield* runTarget(target, input.mode, location, roots))
      }

      const payload: InstallPayload = {
        mode: input.mode,
        location,
        basis: resolved.basis,
        targets: results,
        skipped: skippedList(),
        // The fallback NOTE is only present when the fallback fired. A fallback that read
        // like a detection would be the same dishonesty as the V11 bug it replaces.
        ...(resolved.note !== undefined ? { note: resolved.note } : {}),
      }
      return ok('install', payload)
    }),
})
