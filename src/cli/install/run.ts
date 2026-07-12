/**
 * The `install` command core: resolve target hosts, then install / uninstall /
 * preview symspec's skill file for each, returning a typed envelope. Pure-ish —
 * it touches the filesystem (writing skill files is the whole point) but never
 * a host's root instruction file, and it lifts every outcome into the envelope
 * rather than throwing.
 *
 * Modes (mutually exclusive, decided by the CLI wiring):
 *   - install (default): write the skill file for each resolved target.
 *   - uninstall: remove symspec's skill file for each resolved target.
 *   - check: report what WOULD be written and whether it is already current,
 *     without writing (exit non-clean when something is missing/stale).
 *   - print: emit the exact file content for one target, no write.
 */

import type { Envelope } from '../envelope.js'
import { success } from '../envelope.js'
import { usageError } from '../errors.js'
import { resolveTargets, SKIPPED_HOSTS, TARGETS, targetById } from './targets.js'
import type { InstallLocation, TargetResult } from './types.js'

/** The usage line install `ERR_USAGE` suggestions cite. */
export const INSTALL_USAGE =
  'symspec install [--global] [--target <auto|all|id,id>] [--uninstall | --check | --print <id>]'

/** Parsed install options (the CLI wiring maps flags to this). */
export interface InstallArgs {
  readonly location: InstallLocation
  readonly target?: string
  readonly uninstall?: boolean
  readonly check?: boolean
  readonly print?: string
  /** Roots, injected for testability (default cwd / os.homedir()). */
  readonly cwd: string
  readonly home: string
}

/** The `data` payload of an install envelope. */
export interface InstallData {
  readonly mode: 'install' | 'uninstall' | 'check'
  readonly location: InstallLocation
  readonly targets: TargetResult[]
  /** Hosts with no clean non-root surface, reported so the user knows why. */
  readonly skipped: { readonly host: string; readonly reason: string }[]
}

const skippedList = () => SKIPPED_HOSTS.map((s) => ({ host: s.id, reason: s.reason }))

/**
 * Run the install command. `--print <id>` short-circuits to a preview envelope
 * for one target. Otherwise resolve the target set (respecting `--target` and
 * per-host location support) and install / uninstall / check each.
 */
export async function runInstall(args: InstallArgs): Promise<Envelope> {
  const { location, cwd, home } = args

  // --print <id>: emit one target's exact file content, no write.
  if (args.print !== undefined) {
    const target = targetById(args.print)
    if (target === undefined) {
      const known = TARGETS.map((t) => t.id).join(', ')
      return usageError(`Unknown --print target "${args.print}". Known: ${known}.`, INSTALL_USAGE)
    }
    const { path, contents } = target.preview(location, cwd, home)
    return success('install', {
      mode: 'check',
      location,
      targets: [
        { host: target.id, location, files: [{ path, action: 'unchanged' }], note: contents },
      ],
      skipped: [],
    } satisfies InstallData)
  }

  const resolved = resolveTargets(args.target, location, cwd, home)
  if ('error' in resolved) return usageError(resolved.error, INSTALL_USAGE)

  // Drop targets that do not support the requested location, noting each.
  const results: TargetResult[] = []
  for (const target of resolved.targets) {
    if (!target.supportsLocation(location)) {
      results.push({
        host: target.id,
        location,
        files: [],
        note: `skipped — ${target.label} does not support a ${location} install`,
      })
      continue
    }
    if (args.uninstall === true) {
      results.push(target.uninstall(location, cwd, home))
    } else if (args.check === true) {
      const det = target.detect(location, cwd, home)
      results.push({
        host: target.id,
        location,
        files: [{ path: det.skillPath, action: det.alreadyConfigured ? 'unchanged' : 'created' }],
        note: det.alreadyConfigured ? 'present' : 'missing',
      })
    } else {
      results.push(await target.install(location, cwd, home))
    }
  }

  const mode = args.uninstall === true ? 'uninstall' : args.check === true ? 'check' : 'install'
  return success('install', {
    mode,
    location,
    targets: results,
    skipped: skippedList(),
  } satisfies InstallData)
}
