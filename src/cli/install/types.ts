/**
 * The `AgentTarget` plugin interface — one implementation per coding-agent host,
 * so adding a host is one new file plus one registry line (the extensible shape
 * codegraph's installer uses). Each target knows how to detect its host, and to
 * write / remove / preview its own skill-or-rule file in that host's dedicated
 * config dir. `symspec install` never touches a host's ROOT instruction file
 * (CLAUDE.md / AGENTS.md / GEMINI.md); a host with no dedicated skill/rule dir
 * (opencode, Gemini CLI) is intentionally absent from the registry.
 */

import type { FileResult } from './write-safety.js'

/** Where to install: the project (cwd) or the user's home config. */
export type InstallLocation = 'local' | 'global'

/** What `detect` learned about a host on this machine. */
export interface Detection {
  /** Best-effort "this host's config dir/marker exists" for the given location. */
  readonly installed: boolean
  /** True when symspec's skill file is already present (drives created vs unchanged). */
  readonly alreadyConfigured: boolean
  /** The absolute path symspec would write for this host + location. */
  readonly skillPath: string
}

/** One host's install/uninstall/preview result. */
export interface TargetResult {
  readonly host: string
  readonly location: InstallLocation
  readonly files: FileResult[]
  /** Optional human note (e.g. why a location was unsupported). */
  readonly note?: string
}

/** One coding-agent host symspec can install a skill into. */
export interface AgentTarget {
  /** Stable id used by `--target=<id>` and in the envelope (`claude`, `cursor`, …). */
  readonly id: string
  /** Human label for messages. */
  readonly label: string
  /** Whether this host supports the given location (some are global-only, etc.). */
  supportsLocation(location: InstallLocation): boolean
  /** Probe the filesystem for this host at `location` — never throws. */
  detect(location: InstallLocation, cwd: string, home: string): Detection
  /** Write the skill file; returns the per-file actions. */
  install(location: InstallLocation, cwd: string, home: string): Promise<TargetResult>
  /** Remove symspec's skill file; a no-op when absent. */
  uninstall(location: InstallLocation, cwd: string, home: string): TargetResult
  /** The exact file content symspec would write (for `--print`, no write). */
  preview(location: InstallLocation, cwd: string, home: string): { path: string; contents: string }
}
