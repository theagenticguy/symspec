/**
 * THE AGENT-HOST TARGET REGISTRY — one skill file per host, and the three V11 defects
 * FIXED (spec AC-A-5, v4 AC-3-7).
 *
 * ## The shape, carried over from v4
 *
 * Every target writes ONE self-contained skill/rule file into a host's dedicated config
 * subdirectory, and NEVER a host's root instruction file (`CLAUDE.md` / `AGENTS.md` /
 * `GEMINI.md`). Only the frontmatter dialect and the path differ per host, so a shared
 * {@link makeTarget} factory carries all the logic and each host is a config object. That
 * design is the `agent-host-skill-install-dirs` lesson and it survives unchanged.
 *
 * ## The three V11 defects, and what each fix actually changes
 *
 * All three were VERIFIED defects in v4 (spec 003 finding V11 + AC-3-7). They are
 * fixed here rather than ported, because porting a known defect into a greenfield is how
 * a rewrite inherits a bug it already paid to find.
 *
 * **1. Kiro's glob was JSON-only.** v4 wrote
 * `fileMatchPattern: '**\/{requirements,*.requirements}.json'` (`targets.ts:135`), so the
 * steering doc loaded only when a `.json` requirements document was open. But an author
 * works in MARKDOWN: a spec, a design doc, a PR description. The one moment the guidance
 * is most valuable — someone writing requirements prose before any document exists — was
 * exactly when it did not load. {@link KIRO_FILE_MATCH} now covers markdown AND the JSON
 * documents.
 *
 * **2. `SKIPPED_HOSTS` listed two hosts symspec already serves.** v4 skipped
 * `opencode` and `gemini` for "no dedicated rules dir" — and both read `.agents/skills`,
 * which the `agents-standard` target ALREADY writes. So install reported two hosts as
 * unsupported while having just configured them. The list is now EMPTY, and kept as a
 * named export so the envelope field stays stable and a genuinely unserviceable host has
 * somewhere to go.
 *
 * **3. `--target auto` installed NOTHING in a repo with no host marker.** v4's
 * `auto` filtered to hosts whose marker directory exists (`targets.ts:197-199`), so a
 * fresh checkout — no `.claude`, no `.agents`, no `.kiro` — resolved to an empty target
 * list and install exited successfully having written nothing. That is the worst possible
 * behavior for a zero-config command: it looks like it worked. {@link resolveTargets} now
 * falls back to `agents-standard`, which is the open standard three hosts read, so `auto`
 * always produces a working install.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The skill identity
// ---------------------------------------------------------------------------

/** The skill's stable identifier — its directory/file name across every host. */
export const SKILL_NAME = 'symspec'

/**
 * The one-line description hosts match on to decide relevance (Claude/Cursor/Codex
 * `description`, Windsurf `model_decision`, Kiro auto).
 *
 * Names the concrete triggers — EARS, requirements, spec conflicts — so a host's
 * relevance matcher fires on the right prompts rather than on every mention of "check".
 * Extended past v4's version with the AUTHORING triggers, because G3's whole point
 * is that the skill now teaches authoring: an agent about to write a requirement should
 * load this, not only an agent about to validate one.
 */
export const SKILL_DESCRIPTION =
  'Author, validate, and lint EARS software-requirements specs with symspec — a ' +
  'deterministic CLI that parses requirements, runs INCOSE GtWR lint, and formally proves ' +
  'contradictions/subsumption/redundancy via Z3 SMT with unsat-core evidence. Use when ' +
  'writing or reviewing requirements, choosing an EARS pattern, splitting a compound ' +
  'requirement, checking a requirements document (requirements.json) for conflicts, or ' +
  'deciding whether two requirements contradict each other.'

// ---------------------------------------------------------------------------
// V11 fix #1 — the Kiro glob covers markdown
// ---------------------------------------------------------------------------

/**
 * Kiro's `fileMatchPattern`, covering MARKDOWN as well as the JSON documents.
 *
 * v4's `'**\/{requirements,*.requirements}.json'` is the V11 defect: it loads the
 * steering doc only when a requirements JSON is open. Requirements are DRAFTED in
 * markdown — a spec, a design doc, an RFC — and the guidance is most valuable before the
 * JSON document exists at all.
 *
 * A brace alternation over both extensions rather than a bare `**\/*.md`, because
 * matching every markdown file in a repository would load the steering doc on every
 * README edit. The markdown half is scoped to filenames that name the subject
 * (`requirements.md`, `auth.requirements.md`, `spec.md`, `SPEC.md`), which is the
 * narrowest pattern that still catches an author drafting prose.
 */
export const KIRO_FILE_MATCH = '**/{requirements,*.requirements,spec,SPEC,*.spec}.{md,json}'

// ---------------------------------------------------------------------------
// V11 fix #2 — nothing is skipped, because nothing needs to be
// ---------------------------------------------------------------------------

/**
 * Hosts with no serviceable install surface — now EMPTY, which is the V11 fix.
 *
 * v4 listed `opencode` ("persistent rules live only in AGENTS.md") and `gemini`
 * ("persistent context lives only in GEMINI.md") and reported both as skipped on every
 * run. Both read `.agents/skills`, which the `agents-standard` target writes, so install
 * was telling a user it could not serve two hosts it had just served.
 *
 * Kept as a named export rather than deleted, for two reasons. The envelope's `skipped`
 * field is agent API and should not appear and disappear with the list's contents; and a
 * future host genuinely without a non-root surface needs a documented place to be
 * recorded rather than silently dropped.
 */
export const SKIPPED_HOSTS: readonly { readonly id: string; readonly reason: string }[] = []

/**
 * Which host ids each target actually serves, published in the envelope.
 *
 * This is the positive statement v4's `SKIPPED_HOSTS` was the negative,
 * wrong version of. `agents-standard` writes ONE file that four hosts read, and saying so
 * explicitly is what makes the empty skip list legible: a user who wonders "what about
 * opencode?" can see it named under the target that covers it.
 */
export const HOSTS_SERVED = {
  claude: ['Claude Code'],
  'agents-standard': ['Cursor', 'Codex CLI', 'opencode', 'Gemini CLI'],
  kiro: ['Kiro'],
  windsurf: ['Windsurf'],
  copilot: ['GitHub Copilot'],
} as const

// ---------------------------------------------------------------------------
// The target shape
// ---------------------------------------------------------------------------

/** Where to install: the project (cwd) or the user's home config. */
export type InstallLocation = 'local' | 'global'

/** What a probe learned about a host on this machine. */
export interface Detection {
  /** Best-effort "this host's config dir/marker exists" for the given location. */
  readonly installed: boolean
  /** True when symspec's skill file is already present. */
  readonly alreadyConfigured: boolean
  /** The path symspec would write for this host + location. */
  readonly skillPath: string
}

/** One host symspec can install a skill into. */
export interface AgentTarget {
  /** Stable id used by `--target <id>` and reported in the envelope. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /** The host products this one file serves. */
  readonly serves: readonly string[]
  /** Whether this host supports the given location. */
  readonly supportsLocation: (location: InstallLocation) => boolean
  /** The path this target writes, for a location and a pair of roots. */
  readonly pathFor: (location: InstallLocation, cwd: string, home: string) => string
  /** Probe the filesystem — never throws. */
  readonly detect: (location: InstallLocation, cwd: string, home: string) => Detection
  /** The exact bytes this target would write, given the shared body. */
  readonly render: (body: string) => string
}

/** Per-host config for {@link makeTarget}. */
interface TargetSpec {
  readonly id: string
  readonly label: string
  readonly serves: readonly string[]
  /** Path of the skill file relative to the location root. */
  readonly relPath: (root: string) => string
  /** Any marker whose existence means "this host is present", relative to root. */
  readonly detectMarkers: readonly string[]
  /** Wrap the shared body with this host's frontmatter dialect. */
  readonly frontmatter: (body: string) => string
  /** Global (home-dir) install supported? */
  readonly supportsGlobal: boolean
}

/** Root dir for a location: cwd for local, home for global. */
const rootFor = (location: InstallLocation, cwd: string, home: string): string =>
  location === 'global' ? home : cwd

/** Build a target from a spec — every host shares this logic. */
const makeTarget = (spec: TargetSpec): AgentTarget => ({
  id: spec.id,
  label: spec.label,
  serves: spec.serves,
  supportsLocation: (location) => (location === 'global' ? spec.supportsGlobal : true),
  pathFor: (location, cwd, home) => spec.relPath(rootFor(location, cwd, home)),
  detect: (location, cwd, home) => {
    const root = rootFor(location, cwd, home)
    const skillPath = spec.relPath(root)
    return {
      installed: spec.detectMarkers.some((marker) => existsSync(join(root, marker))),
      alreadyConfigured: existsSync(skillPath),
      skillPath,
    }
  },
  render: (body) => spec.frontmatter(body),
})

/** Double-quote a YAML scalar and escape embedded quotes/backslashes. */
const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Render YAML frontmatter above a body. */
const yamlFrontmatter = (fields: Record<string, string>, body: string): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n${body}`

// ---------------------------------------------------------------------------
// The five targets
// ---------------------------------------------------------------------------

/**
 * Claude Code: `.claude/skills/<name>/SKILL.md`.
 *
 * Needs its OWN target even though the frontmatter is identical to the open standard,
 * because Claude Code reads `.claude/skills/` and NOT `.agents/skills/` — verified against
 * a live install, and v4's lesson records shipping `agents-standard` alone and
 * having Claude Code see nothing.
 */
const claude = makeTarget({
  id: 'claude',
  label: 'Claude Code (.claude/skills)',
  serves: HOSTS_SERVED.claude,
  relPath: (root) => join(root, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
  detectMarkers: ['.claude'],
  supportsGlobal: true,
  frontmatter: (body) =>
    yamlFrontmatter({ name: SKILL_NAME, description: quote(SKILL_DESCRIPTION) }, body),
})

/**
 * The agentskills.io OPEN STANDARD: `.agents/skills/<name>/SKILL.md`.
 *
 * One file, four hosts: Cursor, Codex CLI, opencode, and Gemini CLI all read it. That is
 * the V11 fix expressed as a fact rather than a skip reason — v4 listed the last
 * two as unserviceable while this target was already serving them.
 *
 * Also the `--target auto` fallback (V11 fix #3), for exactly this reason: it is the
 * single target with the widest reach, so a repo with no host marker gets a working
 * install rather than nothing.
 */
const agentsStandard = makeTarget({
  id: 'agents-standard',
  label: 'Cursor / Codex / opencode / Gemini (.agents/skills)',
  serves: HOSTS_SERVED['agents-standard'],
  relPath: (root) => join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md'),
  detectMarkers: ['.agents', '.cursor', '.codex', '.opencode', '.gemini'],
  supportsGlobal: true,
  frontmatter: (body) =>
    yamlFrontmatter({ name: SKILL_NAME, description: quote(SKILL_DESCRIPTION) }, body),
})

/**
 * Kiro steering doc: `.kiro/steering/symspec.md` with `inclusion: fileMatch`.
 *
 * The glob is {@link KIRO_FILE_MATCH} — V11 fix #1, covering markdown as well as JSON.
 */
const kiro = makeTarget({
  id: 'kiro',
  label: 'Kiro (.kiro/steering)',
  serves: HOSTS_SERVED.kiro,
  relPath: (root) => join(root, '.kiro', 'steering', `${SKILL_NAME}.md`),
  detectMarkers: ['.kiro'],
  supportsGlobal: true,
  frontmatter: (body) =>
    yamlFrontmatter({ inclusion: 'fileMatch', fileMatchPattern: quote(KIRO_FILE_MATCH) }, body),
})

/**
 * Windsurf rule: `.windsurf/rules/symspec.md` with `trigger: model_decision`, so the
 * model pulls it in by description when a spec task is at hand.
 */
const windsurf = makeTarget({
  id: 'windsurf',
  label: 'Windsurf (.windsurf/rules)',
  serves: HOSTS_SERVED.windsurf,
  relPath: (root) => join(root, '.windsurf', 'rules', `${SKILL_NAME}.md`),
  detectMarkers: ['.windsurf'],
  supportsGlobal: false,
  frontmatter: (body) =>
    yamlFrontmatter({ trigger: 'model_decision', description: quote(SKILL_DESCRIPTION) }, body),
})

/**
 * GitHub Copilot path-specific instructions:
 * `.github/instructions/symspec.instructions.md` with an `applyTo:` glob — leaving the
 * repo-wide `.github/copilot-instructions.md` untouched.
 *
 * The glob gets the same markdown widening as Kiro's, for the same reason: v4's
 * JSON-only pattern missed the author drafting prose.
 */
const copilot = makeTarget({
  id: 'copilot',
  label: 'GitHub Copilot (.github/instructions)',
  serves: HOSTS_SERVED.copilot,
  relPath: (root) => join(root, '.github', 'instructions', `${SKILL_NAME}.instructions.md`),
  detectMarkers: ['.github'],
  supportsGlobal: false,
  frontmatter: (body) => yamlFrontmatter({ applyTo: quote(KIRO_FILE_MATCH) }, body),
})

/** The registry, in install order. */
export const TARGETS: readonly AgentTarget[] = [claude, agentsStandard, kiro, windsurf, copilot]

/** Look one target up by id. */
export const targetById = (id: string): AgentTarget | undefined =>
  TARGETS.find((target) => target.id === id)

// ---------------------------------------------------------------------------
// V11 fix #3 — `auto` never resolves to nothing
// ---------------------------------------------------------------------------

/**
 * The target `auto` falls back to when NO host marker is present.
 *
 * `agents-standard` because it is the open standard four hosts read, so one file is the
 * highest-value guess available with no evidence. Named as a constant so the fallback is
 * a documented decision rather than an index into an array.
 */
export const AUTO_FALLBACK_TARGET = 'agents-standard'

/** How `auto` reached its answer — reported so the choice is never silent. */
export type AutoBasis = 'detected' | 'fallback' | 'explicit'

/** A resolved target set, plus how it was chosen. */
export interface ResolvedTargets {
  readonly targets: readonly AgentTarget[]
  readonly basis: AutoBasis
  /** Present only for `fallback`: why nothing was detected and what was chosen. */
  readonly note?: string
}

/**
 * Resolve a `--target` value to concrete targets.
 *
 * - `auto` (the default): every host whose marker directory exists — and when NONE does,
 *   {@link AUTO_FALLBACK_TARGET} rather than an empty list. That is V11 fix #3: v4
 *   returned nothing here, so `symspec install` in a fresh checkout exited 0 having
 *   written no file, which is indistinguishable from success.
 * - `all`: every registered target.
 * - a CSV of ids: exactly those. An unknown id is an error naming the known set.
 *
 * The `basis` is returned rather than inferred by the caller, so the envelope can SAY it
 * fell back. A fallback that looked like a detection would be the same class of dishonesty
 * as the bug it replaces.
 */
export const resolveTargets = (
  flag: string | null,
  location: InstallLocation,
  cwd: string,
  home: string,
): ResolvedTargets | { readonly error: string } => {
  const value = flag ?? 'auto'

  if (value === 'all') return { targets: [...TARGETS], basis: 'explicit' }

  if (value === 'auto') {
    const detected = TARGETS.filter((target) => target.detect(location, cwd, home).installed)
    if (detected.length > 0) return { targets: detected, basis: 'detected' }
    const fallback = targetById(AUTO_FALLBACK_TARGET)
    // Unreachable while AUTO_FALLBACK_TARGET names a registered target, and `install.test.ts`
    // pins that. Handled rather than asserted because an empty result here is the exact
    // defect being fixed, and it must not be reachable by any path.
    if (fallback === undefined) {
      return { error: `The auto fallback target "${AUTO_FALLBACK_TARGET}" is not registered.` }
    }
    return {
      targets: [fallback],
      basis: 'fallback',
      note:
        `No agent-host marker directory was found, so --target auto installed the ` +
        `${AUTO_FALLBACK_TARGET} skill (.agents/skills), which ${fallback.serves.join(', ')} ` +
        'all read. Pass --target <id> or --target all to choose explicitly.',
    }
  }

  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (ids.length === 0) {
    return { error: `--target was empty. Known targets: ${knownTargets()}.` }
  }
  const targets: AgentTarget[] = []
  for (const id of ids) {
    const target = targetById(id)
    if (target === undefined) {
      return { error: `Unknown --target "${id}". Known targets: ${knownTargets()}.` }
    }
    targets.push(target)
  }
  return { targets, basis: 'explicit' }
}

/** The known-target list, for a usage message. */
export const knownTargets = (): string => `${TARGETS.map((t) => t.id).join(', ')}, all, auto`
