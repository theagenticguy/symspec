/**
 * The concrete {@link AgentTarget}s + the registry.
 *
 * Every target writes ONE self-contained skill/rule file into a host's
 * dedicated config subdirectory — never the host's root instruction file. The
 * file body is the single-sourced {@link buildSkillBody}; only the frontmatter
 * dialect and the path differ per host, so a shared {@link makeSkillFileTarget}
 * factory carries all the logic and each host is just a config object.
 *
 * Hosts covered (each has a dedicated, auto-discoverable skill/rule dir):
 *   - agents-standard → `.agents/skills/symspec/SKILL.md` — the agentskills.io
 *     open standard read by Claude Code, Cursor, AND Codex CLI, so one file
 *     satisfies three hosts at once.
 *   - kiro     → `.kiro/steering/symspec.md`            (`inclusion: fileMatch`)
 *   - windsurf → `.windsurf/rules/symspec.md`           (`trigger: model_decision`)
 *   - copilot  → `.github/instructions/symspec.instructions.md` (`applyTo:` glob)
 *
 * Deliberately ABSENT: opencode and Gemini CLI have no dedicated always-on
 * rules dir — their only persistent instruction surface is AGENTS.md / GEMINI.md,
 * which install refuses to edit. The command reports them as skipped.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildSkillBody, SKILL_DESCRIPTION, SKILL_NAME } from './skill-content.js'
import type { AgentTarget, Detection, InstallLocation, TargetResult } from './types.js'
import { removeManagedFile, writeManagedFile } from './write-safety.js'

/** Hosts with no clean non-root install surface — reported, never written to. */
export const SKIPPED_HOSTS = [
  { id: 'opencode', reason: 'persistent rules live only in AGENTS.md (no dedicated rules dir)' },
  { id: 'gemini', reason: 'persistent context lives only in GEMINI.md (no dedicated rules dir)' },
] as const

/** Per-host config for {@link makeSkillFileTarget}. */
interface SkillFileSpec {
  readonly id: string
  readonly label: string
  /** Path of the skill file relative to the location root (cwd or home). */
  readonly relPath: (root: string) => string
  /** Any marker whose existence means "this host is present" (relative to root). */
  readonly detectMarkers: readonly string[]
  /** Wrap the shared body with this host's frontmatter dialect. */
  readonly frontmatter: (body: string) => string
  /** Global (home-dir) install supported? */
  readonly supportsGlobal: boolean
}

/** Root dir for a location: cwd for local, home for global. */
function rootFor(location: InstallLocation, cwd: string, home: string): string {
  return location === 'global' ? home : cwd
}

/** Build a target from a {@link SkillFileSpec} — all hosts share this logic. */
function makeSkillFileTarget(spec: SkillFileSpec): AgentTarget {
  const pathFor = (location: InstallLocation, cwd: string, home: string): string =>
    spec.relPath(rootFor(location, cwd, home))

  const contentsFor = (): string => spec.frontmatter(buildSkillBody())

  return {
    id: spec.id,
    label: spec.label,
    supportsLocation: (location) => (location === 'global' ? spec.supportsGlobal : true),
    detect(location, cwd, home): Detection {
      const root = rootFor(location, cwd, home)
      const skillPath = spec.relPath(root)
      const installed = spec.detectMarkers.some((m) => existsSync(join(root, m)))
      return { installed, alreadyConfigured: existsSync(skillPath), skillPath }
    },
    async install(location, cwd, home): Promise<TargetResult> {
      const file = await writeManagedFile(pathFor(location, cwd, home), contentsFor())
      return { host: spec.id, location, files: [file] }
    },
    uninstall(location, cwd, home): TargetResult {
      const file = removeManagedFile(pathFor(location, cwd, home))
      return { host: spec.id, location, files: [file] }
    },
    preview(location, cwd, home) {
      return { path: pathFor(location, cwd, home), contents: contentsFor() }
    },
  }
}

const yamlFrontmatter = (fields: Record<string, string>, body: string): string => {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/**
 * agentskills.io open standard: `.agents/skills/<name>/SKILL.md`, read by Claude
 * Code, Cursor, and Codex CLI. `name` + `description` frontmatter; the host's
 * model auto-loads the body when the description matches the task.
 */
const agentsStandard = makeSkillFileTarget({
  id: 'agents-standard',
  label: 'Claude Code / Cursor / Codex (.agents/skills)',
  relPath: (root) => join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md'),
  detectMarkers: ['.agents', '.claude', '.cursor', '.codex', '.agents/skills'],
  supportsGlobal: true,
  frontmatter: (body) =>
    yamlFrontmatter({ name: SKILL_NAME, description: quote(SKILL_DESCRIPTION) }, body),
})

/**
 * Kiro steering doc: `.kiro/steering/symspec.md` with `inclusion: fileMatch` so
 * it loads only when a requirements JSON is in play, not on every prompt.
 */
const kiro = makeSkillFileTarget({
  id: 'kiro',
  label: 'Kiro (.kiro/steering)',
  relPath: (root) => join(root, '.kiro', 'steering', `${SKILL_NAME}.md`),
  detectMarkers: ['.kiro'],
  supportsGlobal: true,
  frontmatter: (body) =>
    yamlFrontmatter(
      { inclusion: 'fileMatch', fileMatchPattern: quote('**/{requirements,*.requirements}.json') },
      body,
    ),
})

/**
 * Windsurf rule: `.windsurf/rules/symspec.md` with `trigger: model_decision` so
 * the model pulls it in by description when a spec task is at hand.
 */
const windsurf = makeSkillFileTarget({
  id: 'windsurf',
  label: 'Windsurf (.windsurf/rules)',
  relPath: (root) => join(root, '.windsurf', 'rules', `${SKILL_NAME}.md`),
  detectMarkers: ['.windsurf'],
  supportsGlobal: false,
  frontmatter: (body) =>
    yamlFrontmatter({ trigger: 'model_decision', description: quote(SKILL_DESCRIPTION) }, body),
})

/**
 * GitHub Copilot path-specific instructions: `.github/instructions/
 * symspec.instructions.md` with an `applyTo:` glob — leaves the repo-wide
 * `.github/copilot-instructions.md` untouched.
 */
const copilot = makeSkillFileTarget({
  id: 'copilot',
  label: 'GitHub Copilot (.github/instructions)',
  relPath: (root) => join(root, '.github', 'instructions', `${SKILL_NAME}.instructions.md`),
  detectMarkers: ['.github'],
  supportsGlobal: false,
  frontmatter: (body) =>
    yamlFrontmatter({ applyTo: quote('**/*.requirements.json,**/requirements.json') }, body),
})

/** Double-quote a YAML scalar and escape embedded quotes/backslashes. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The registry, in install order. */
export const TARGETS: readonly AgentTarget[] = [agentsStandard, kiro, windsurf, copilot]

/** Look up a target by id. */
export function targetById(id: string): AgentTarget | undefined {
  return TARGETS.find((t) => t.id === id)
}

/**
 * Resolve a `--target` flag value to concrete targets:
 *   - `auto` (default): every target whose host `detect().installed` is true.
 *   - `all`: every registered target.
 *   - a CSV of ids: exactly those (unknown id → error string).
 * Returns the target list, or an `{ error }` for an unknown id.
 */
export function resolveTargets(
  flag: string | undefined,
  location: InstallLocation,
  cwd: string,
  home: string,
): { targets: AgentTarget[] } | { error: string } {
  const value = flag ?? 'auto'
  if (value === 'all') return { targets: [...TARGETS] }
  if (value === 'auto') {
    return { targets: TARGETS.filter((t) => t.detect(location, cwd, home).installed) }
  }
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const targets: AgentTarget[] = []
  for (const id of ids) {
    const t = targetById(id)
    if (t === undefined) {
      const known = TARGETS.map((x) => x.id).join(', ')
      return { error: `Unknown --target "${id}". Known targets: ${known}, all, auto.` }
    }
    targets.push(t)
  }
  return { targets }
}
