import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_SUMMARIES } from '../../descriptions.js'
import { SuccessEnvelopeSchema } from '../../envelope.js'
import { SCOPE } from '../../scope-text.js'
import type { InstallData } from '../run.js'
import { runInstall } from '../run.js'
import { buildSkillBody } from '../skill-content.js'
import { resolveTargets, SKIPPED_HOSTS, TARGETS } from '../targets.js'

/**
 * `install` drops a single-sourced skill file into each host's dedicated dir,
 * never touching a root instruction file, idempotently, and reports the two
 * root-doc-only hosts as skipped.
 */

let dir: string
const HOME = '/nonexistent-home-for-tests'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symspec-install-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const data = (env: { type: string; data?: unknown }): InstallData => {
  if (env.type === 'error') throw new Error('expected success envelope')
  return env.data as InstallData
}

describe('skill body — single-sourced from the description + scope corpora', () => {
  it('embeds command summaries and the honest-scope caveat verbatim', () => {
    const body = buildSkillBody()
    // Manifest-first instruction is present.
    expect(body).toContain('symspec manifest')
    // A command summary is quoted verbatim from the single-source corpus.
    expect(body).toContain(COMMAND_SUMMARIES.check)
    // The load-bearing honesty caveat comes from scope-text.ts verbatim.
    expect(body).toContain(SCOPE.silence)
  })
})

describe('resolveTargets', () => {
  it('all → every registered target', () => {
    const res = resolveTargets('all', 'local', dir, HOME)
    expect('targets' in res).toBe(true)
    if ('targets' in res) expect(res.targets).toHaveLength(TARGETS.length)
  })

  it('auto → only hosts whose marker dir exists', () => {
    mkdirSync(join(dir, '.kiro'), { recursive: true })
    const res = resolveTargets('auto', 'local', dir, HOME)
    if ('targets' in res) {
      const ids = res.targets.map((t) => t.id)
      expect(ids).toContain('kiro')
      expect(ids).not.toContain('copilot') // no .github present
    }
  })

  it('a csv of ids resolves exactly those', () => {
    const res = resolveTargets('kiro,windsurf', 'local', dir, HOME)
    if ('targets' in res) expect(res.targets.map((t) => t.id)).toEqual(['kiro', 'windsurf'])
  })

  it('an unknown id is an error', () => {
    const res = resolveTargets('bogus', 'local', dir, HOME)
    expect('error' in res).toBe(true)
  })
})

describe('install → files written into dedicated dirs, root docs untouched', () => {
  it('writes the .agents/skills SKILL.md with name+description frontmatter', async () => {
    const env = await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    expect(() => SuccessEnvelopeSchema.parse(env)).not.toThrow()
    const skill = join(dir, '.agents', 'skills', 'symspec', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    const content = readFileSync(skill, 'utf8')
    expect(content.startsWith('---\nname: symspec\n')).toBe(true)
    expect(content).toContain('description:')
  })

  it('writes the Claude Code skill into .claude/skills (its native dir, not .agents)', async () => {
    await runInstall({ location: 'local', target: 'claude', cwd: dir, home: HOME })
    const skill = join(dir, '.claude', 'skills', 'symspec', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf8').startsWith('---\nname: symspec\n')).toBe(true)
    // Targeting claude alone must NOT also write the .agents/skills variant.
    expect(existsSync(join(dir, '.agents', 'skills', 'symspec', 'SKILL.md'))).toBe(false)
  })

  it('writes each host into its own dedicated path', async () => {
    await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    expect(existsSync(join(dir, '.claude', 'skills', 'symspec', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '.kiro', 'steering', 'symspec.md'))).toBe(true)
    expect(existsSync(join(dir, '.windsurf', 'rules', 'symspec.md'))).toBe(true)
    expect(existsSync(join(dir, '.github', 'instructions', 'symspec.instructions.md'))).toBe(true)
  })

  it('NEVER writes a root instruction file (CLAUDE.md / AGENTS.md / GEMINI.md)', async () => {
    await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    for (const root of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', join('.claude', 'CLAUDE.md')]) {
      expect(existsSync(join(dir, root)), `${root} must not be created`).toBe(false)
    }
  })

  it('preserves a pre-existing root doc byte-for-byte', async () => {
    const agents = join(dir, 'AGENTS.md')
    writeFileSync(agents, '# my agents doc\nuntouched\n')
    await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    expect(readFileSync(agents, 'utf8')).toBe('# my agents doc\nuntouched\n')
  })

  it('reports opencode + gemini as skipped, not written', async () => {
    const env = await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    const skipped = data(env).skipped.map((s) => s.host)
    expect(skipped).toEqual(SKIPPED_HOSTS.map((s) => s.id))
    expect(existsSync(join(dir, 'GEMINI.md'))).toBe(false)
  })
})

describe('idempotency + modes', () => {
  it('a second install is entirely unchanged', async () => {
    await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    const env = await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    for (const t of data(env).targets) expect(t.files[0]?.action).toBe('unchanged')
  })

  it('editing the installed file, then re-installing, updates it back', async () => {
    await runInstall({ location: 'local', target: 'kiro', cwd: dir, home: HOME })
    const p = join(dir, '.kiro', 'steering', 'symspec.md')
    writeFileSync(p, 'tampered\n')
    const env = await runInstall({ location: 'local', target: 'kiro', cwd: dir, home: HOME })
    expect(data(env).targets[0]?.files[0]?.action).toBe('updated')
    expect(readFileSync(p, 'utf8')).not.toBe('tampered\n')
  })

  it('--uninstall removes the files and is a no-op when already gone', async () => {
    await runInstall({ location: 'local', target: 'all', cwd: dir, home: HOME })
    const first = await runInstall({
      location: 'local',
      target: 'all',
      uninstall: true,
      cwd: dir,
      home: HOME,
    })
    for (const t of data(first).targets) expect(t.files[0]?.action).toBe('removed')
    expect(existsSync(join(dir, '.kiro', 'steering', 'symspec.md'))).toBe(false)

    const second = await runInstall({
      location: 'local',
      target: 'all',
      uninstall: true,
      cwd: dir,
      home: HOME,
    })
    for (const t of data(second).targets) expect(t.files[0]?.action).toBe('unchanged')
  })

  it('--check reports present/missing without writing', async () => {
    const before = await runInstall({
      location: 'local',
      target: 'kiro',
      check: true,
      cwd: dir,
      home: HOME,
    })
    expect(data(before).targets[0]?.note).toBe('missing')
    expect(existsSync(join(dir, '.kiro', 'steering', 'symspec.md'))).toBe(false)

    await runInstall({ location: 'local', target: 'kiro', cwd: dir, home: HOME })
    const after = await runInstall({
      location: 'local',
      target: 'kiro',
      check: true,
      cwd: dir,
      home: HOME,
    })
    expect(data(after).targets[0]?.note).toBe('present')
  })

  it('--print emits content and writes nothing', async () => {
    const env = await runInstall({ location: 'local', print: 'windsurf', cwd: dir, home: HOME })
    const note = data(env).targets[0]?.note ?? ''
    expect(note).toContain('trigger: model_decision')
    expect(existsSync(join(dir, '.windsurf', 'rules', 'symspec.md'))).toBe(false)
  })

  it('windsurf/copilot do not support a --global install (reported, not written)', async () => {
    const env = await runInstall({ location: 'global', target: 'windsurf', cwd: dir, home: dir })
    const t = data(env).targets[0]
    expect(t?.files).toHaveLength(0)
    expect(t?.note).toContain('does not support')
  })

  it('an unknown --target is a usage error', async () => {
    const env = await runInstall({ location: 'local', target: 'nope', cwd: dir, home: HOME })
    expect(env.type).toBe('error')
    if (env.type === 'error') expect(env.code).toBe('ERR_USAGE')
  })
})
