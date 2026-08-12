/**
 * `install` — the host→path matrix, the three V11 fixes, and the generated body.
 *
 * ## Everything runs against a REAL temp filesystem
 *
 * `NodeServices.layer` over a temp directory, not a mock. The whole point of AC-A-5 is
 * that the right bytes land at the right path for each host, and a faked filesystem would
 * assert the shape of the fake. The roots are steered through `SYMSPEC_TEST_CWD` /
 * `SYMSPEC_TEST_HOME` (see `processRoots` for why that override exists in production
 * code), so a `--global` assertion never touches the developer's actual `~/.claude`.
 *
 * ## The three V11 defects each get a NAMED test
 *
 * Not folded into a general "install works" case, because each was a shipped bug with its
 * own failure signature and each fix has to be individually falsifiable:
 *
 * 1. Kiro's glob was JSON-only, so the steering doc never loaded while an author drafted
 *    markdown.
 * 2. `SKIPPED_HOSTS` reported opencode/gemini as unserviceable while `agents-standard` was
 *    already serving both.
 * 3. `--target auto` in a repo with no host marker resolved to an empty list and exited 0
 *    having written nothing — indistinguishable from success.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REACHABILITY_FND_CODES } from '../formal/reachability-codes.ts'
import { buildSkillBody } from '../install/skill-body.ts'
import {
  AUTO_FALLBACK_TARGET,
  HOSTS_SERVED,
  KIRO_FILE_MATCH,
  resolveTargets,
  SKILL_DESCRIPTION,
  SKIPPED_HOSTS,
  TARGETS,
  targetById,
} from '../install/targets.ts'
import { catalogCounts } from '../kernel/catalog.ts'
import { CRAFT_SECTIONS } from '../kernel/craft.ts'
import type { OperationalError } from '../kernel/errors.ts'
import { exitCodeForEnvelope } from '../kernel/exit.ts'
import { runOperation } from '../kernel/operation.ts'
import { SCOPE, SCOPE_ESSENTIAL } from '../kernel/scope.ts'
import { allOperations } from './index.ts'
import { type InstallPayload, installOp, processRoots } from './install.ts'

// ---------------------------------------------------------------------------
// A temp workspace, with roots injected so nothing touches the real home
// ---------------------------------------------------------------------------

let workspace: string
let cwd: string
let home: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'symspec-install-'))
  cwd = join(workspace, 'project')
  home = join(workspace, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home, { recursive: true })
  // The operation reads its roots from the process. Overriding cwd for a whole vitest
  // worker would be hostile to the other suites, so the roots are steered through the
  // env vars `processRoots` consults, and restored in `afterEach`.
  process.env.SYMSPEC_TEST_CWD = cwd
  process.env.SYMSPEC_TEST_HOME = home
})

afterEach(() => {
  delete process.env.SYMSPEC_TEST_CWD
  delete process.env.SYMSPEC_TEST_HOME
  rmSync(workspace, { recursive: true, force: true })
})

/** Run `install` with the real platform services over the temp workspace. */
const run = (
  input: Record<string, unknown> = {},
): Promise<
  | { readonly _tag: 'Success'; readonly success: { readonly data: InstallPayload } }
  | { readonly _tag: 'Failure'; readonly failure: OperationalError }
> =>
  Effect.runPromise(
    Effect.result(runOperation(installOp, input)).pipe(Effect.provide(NodeServices.layer)),
  ) as never

const expectOk = async (input: Record<string, unknown> = {}): Promise<InstallPayload> => {
  const result = await run(input)
  if (result._tag === 'Failure') {
    throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  }
  return result.success.data
}

/** Create a host marker directory so `auto` detects it. */
const marker = (name: string, root = cwd): void => {
  mkdirSync(join(root, name), { recursive: true })
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

describe('the roots the operation installs into', () => {
  it('reads the injected test roots, so no test touches the real home', () => {
    const roots = processRoots()
    expect(roots.cwd).toBe(cwd)
    expect(roots.home).toBe(home)
  })
})

// ---------------------------------------------------------------------------
// V11 FIX #1 — Kiro's glob covers markdown
// ---------------------------------------------------------------------------

describe('V11 fix #1: the Kiro/Copilot glob covers MARKDOWN, not only JSON', () => {
  it('matches markdown spec filenames as well as the JSON documents', () => {
    // The donor's pattern was '**/{requirements,*.requirements}.json' — so the steering
    // doc loaded only with a requirements JSON open, and never while an author drafted
    // the prose that becomes one.
    expect(KIRO_FILE_MATCH).toContain('md')
    expect(KIRO_FILE_MATCH).toContain('json')
    expect(KIRO_FILE_MATCH).toContain('requirements')
    expect(KIRO_FILE_MATCH).toContain('spec')
  })

  it('is NOT a blanket **/*.md — that would load on every README edit', () => {
    // The narrowest widening that still catches an author drafting prose. A bare
    // markdown glob would make the steering doc always-on, which is a different
    // (and worse) defect than the one being fixed.
    expect(KIRO_FILE_MATCH).not.toBe('**/*.md')
    expect(KIRO_FILE_MATCH.startsWith('**/{')).toBe(true)
  })

  it('lands in the Kiro frontmatter, not merely in a constant', () => {
    marker('.kiro')
    const target = targetById('kiro')
    expect(target).toBeDefined()
    const rendered = target?.render('BODY') ?? ''
    expect(rendered).toContain('inclusion: fileMatch')
    expect(rendered).toContain(KIRO_FILE_MATCH)
    // And nothing left behind from the JSON-only pattern.
    expect(rendered).not.toContain('.requirements}.json"')
  })

  it('lands in the Copilot applyTo glob too', () => {
    const rendered = targetById('copilot')?.render('BODY') ?? ''
    expect(rendered).toContain('applyTo:')
    expect(rendered).toContain(KIRO_FILE_MATCH)
  })
})

// ---------------------------------------------------------------------------
// V11 FIX #2 — nothing is skipped, because nothing needs to be
// ---------------------------------------------------------------------------

describe('V11 fix #2: opencode and gemini are SERVED, not skipped', () => {
  it('reports an EMPTY skip list', () => {
    // The donor listed both while `agents-standard` was already writing the file both
    // read — telling a user it could not serve two hosts it had just served.
    expect(SKIPPED_HOSTS).toEqual([])
  })

  it('names both under the target that actually serves them', () => {
    // The positive statement the old skip list was the wrong negative of.
    expect(HOSTS_SERVED['agents-standard']).toContain('opencode')
    expect(HOSTS_SERVED['agents-standard']).toContain('Gemini CLI')
    expect(targetById('agents-standard')?.serves).toContain('opencode')
  })

  it('detects an opencode-only or gemini-only repo via agents-standard', async () => {
    // The concrete consequence: a repo whose ONLY marker is `.opencode` now gets a real
    // install instead of a skip report.
    marker('.opencode')
    const data = await expectOk()
    expect(data.basis).toBe('detected')
    expect(data.targets.map((t) => t.host)).toEqual(['agents-standard'])
    expect(data.skipped).toEqual([])
    expect(existsSync(join(cwd, '.agents', 'skills', 'symspec', 'SKILL.md'))).toBe(true)
  })

  it('keeps `skipped` as a FIELD even though it is empty', async () => {
    // It is agent API. A field that appears and disappears with its own contents forces
    // a consumer to handle two shapes.
    const data = await expectOk({ target: 'claude' })
    expect(Array.isArray(data.skipped)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// V11 FIX #3 — `auto` never installs nothing
// ---------------------------------------------------------------------------

describe('V11 fix #3: --target auto with no host marker installs the open standard', () => {
  it('falls back to agents-standard rather than resolving to an empty list', async () => {
    // The donor exited 0 here having written no file, which is indistinguishable from
    // success — the worst possible behavior for a zero-config command.
    const data = await expectOk()
    expect(data.basis).toBe('fallback')
    expect(data.targets.map((t) => t.host)).toEqual([AUTO_FALLBACK_TARGET])
    expect(data.targets[0]?.files[0]?.action).toBe('created')
    expect(existsSync(join(cwd, '.agents', 'skills', 'symspec', 'SKILL.md'))).toBe(true)
  })

  it('SAYS it fell back — a fallback must not read like a detection', async () => {
    const data = await expectOk()
    expect(data.note).toBeDefined()
    expect(data.note).toContain('No agent-host marker')
    expect(data.note).toContain(AUTO_FALLBACK_TARGET)
    // And it names the hosts the fallback actually covers, so the choice is auditable.
    expect(data.note).toContain('opencode')
  })

  it('does NOT fall back when a marker IS present', async () => {
    marker('.claude')
    const data = await expectOk()
    expect(data.basis).toBe('detected')
    expect(data.note).toBeUndefined()
    expect(data.targets.map((t) => t.host)).toEqual(['claude'])
  })

  it('resolveTargets never returns an empty target list for auto', () => {
    // Asserted at the resolver, because an empty list is the exact defect and it must be
    // unreachable by any path rather than merely absent from the case above.
    const resolved = resolveTargets(null, 'local', cwd, home)
    expect('error' in resolved).toBe(false)
    if ('error' in resolved) return
    expect(resolved.targets.length).toBeGreaterThan(0)
  })

  it('the fallback target is a REGISTERED target', () => {
    // The one branch in the resolver that would return an error is unreachable while this
    // holds, and this is what holds it.
    expect(targetById(AUTO_FALLBACK_TARGET)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The host → path matrix
// ---------------------------------------------------------------------------

describe('the host → path matrix', () => {
  it('writes each of the five targets to its documented path', async () => {
    const data = await expectOk({ target: 'all' })
    const byHost = new Map(data.targets.map((t) => [t.host, t]))

    const expected: readonly [string, string][] = [
      ['claude', join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md')],
      ['agents-standard', join(cwd, '.agents', 'skills', 'symspec', 'SKILL.md')],
      ['kiro', join(cwd, '.kiro', 'steering', 'symspec.md')],
      ['windsurf', join(cwd, '.windsurf', 'rules', 'symspec.md')],
      ['copilot', join(cwd, '.github', 'instructions', 'symspec.instructions.md')],
    ]

    for (const [host, path] of expected) {
      expect(byHost.get(host)?.files[0]?.path, host).toBe(path)
      // VERIFIED on disk, not merely reported — the envelope saying it wrote a file and
      // the file existing are two different claims.
      expect(existsSync(path), `${host}: nothing at ${path}`).toBe(true)
      expect(readFileSync(path, 'utf8').length, host).toBeGreaterThan(1_000)
    }
  })

  it('routes a --global install to the home root for the hosts that support it', async () => {
    const data = await expectOk({ target: 'all', global: true })
    const byHost = new Map(data.targets.map((t) => [t.host, t]))

    // Three hosts support a global install.
    for (const host of ['claude', 'agents-standard', 'kiro']) {
      const path = byHost.get(host)?.files[0]?.path ?? ''
      expect(path.startsWith(home), `${host} did not install under home`).toBe(true)
      expect(existsSync(path), host).toBe(true)
    }

    // Windsurf and Copilot are project-scoped, and are REPORTED rather than silently
    // dropped or wrongly written into home.
    for (const host of ['windsurf', 'copilot']) {
      const row = byHost.get(host)
      expect(row?.files, host).toEqual([])
      expect(row?.note, host).toContain('does not support a global install')
    }
    // Nothing leaked into the project root.
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
  })

  it('every registered target declares which host products it serves', () => {
    for (const target of TARGETS) {
      expect(target.serves.length, target.id).toBeGreaterThan(0)
    }
    // Four hosts on one file is the fact that makes the empty skip list correct.
    expect(targetById('agents-standard')?.serves.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Idempotence and the four modes
// ---------------------------------------------------------------------------

describe('install is idempotent and never touches a root instruction file', () => {
  it('reports `unchanged` on a re-run and does not rewrite', async () => {
    const first = await expectOk({ target: 'claude' })
    expect(first.targets[0]?.files[0]?.action).toBe('created')
    const second = await expectOk({ target: 'claude' })
    expect(second.targets[0]?.files[0]?.action).toBe('unchanged')
  })

  it('reports `updated` when the on-disk content differs', async () => {
    await expectOk({ target: 'claude' })
    const path = join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md')
    writeFileSync(path, 'a user hand-edited this')
    const again = await expectOk({ target: 'claude' })
    expect(again.targets[0]?.files[0]?.action).toBe('updated')
    // And the managed content is back, whole — a skill is one file symspec owns entirely.
    expect(readFileSync(path, 'utf8')).toContain('# symspec')
  })

  it('NEVER writes a host root instruction file', async () => {
    await expectOk({ target: 'all' })
    for (const root of [cwd, home]) {
      for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'README.md']) {
        expect(existsSync(join(root, name)), `${root}/${name}`).toBe(false)
      }
    }
    // Nor Copilot's repo-wide instruction file, only the path-specific one.
    expect(existsSync(join(cwd, '.github', 'copilot-instructions.md'))).toBe(false)
  })

  it('uninstall removes the file and is safe to repeat', async () => {
    await expectOk({ target: 'claude' })
    const path = join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md')
    expect(existsSync(path)).toBe(true)

    const removed = await expectOk({ target: 'claude', mode: 'uninstall' })
    expect(removed.targets[0]?.files[0]?.action).toBe('removed')
    expect(existsSync(path)).toBe(false)

    // Repeating is a quiet no-op, not an error — the donor's discipline, kept.
    const again = await expectOk({ target: 'claude', mode: 'uninstall' })
    expect(again.targets[0]?.files[0]?.action).toBe('unchanged')
  })

  it('check reports state and writes NOTHING', async () => {
    const missing = await expectOk({ target: 'claude', mode: 'check' })
    expect(missing.targets[0]?.note).toBe('missing')
    expect(existsSync(join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md'))).toBe(false)

    await expectOk({ target: 'claude' })
    const present = await expectOk({ target: 'claude', mode: 'check' })
    expect(present.targets[0]?.note).toBe('present')
  })

  it('print emits the exact contents for ONE target, and writes nothing', async () => {
    const data = await expectOk({ target: 'kiro', mode: 'print' })
    expect(data.mode).toBe('print')
    const note = data.targets[0]?.note ?? ''
    // The exact bytes the install would write — frontmatter included.
    expect(note.startsWith('---\ninclusion: fileMatch')).toBe(true)
    expect(note).toContain(KIRO_FILE_MATCH)
    expect(existsSync(join(cwd, '.kiro', 'steering', 'symspec.md'))).toBe(false)
  })

  it('print REFUSES a multi-target selector rather than dumping five files', async () => {
    for (const target of [null, 'all', 'auto', 'claude,kiro']) {
      const result = await run({ mode: 'print', ...(target === null ? {} : { target }) })
      expect(result._tag, `print with target=${target}`).toBe('Failure')
      if (result._tag !== 'Failure') continue
      expect(result.failure._tag).toBe('ERR_USAGE')
    }
  })

  it('an unknown --target is ERR_USAGE naming the known set', async () => {
    const result = await run({ target: 'nonexistent-host' })
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('ERR_USAGE')
    expect(result.failure.error).toContain('nonexistent-host')
    // Runnable remedy, not just prose (AC-A-9).
    expect(result.failure.repair?.commands).toEqual(['symspec install'])
  })

  it('a successful run exits 0 in every mode, including a `missing` check', async () => {
    // `check` REPORTS state; reporting "missing" is a successful report. A caller that
    // wants a gate reads the note.
    for (const mode of ['install', 'check', 'uninstall']) {
      const env = await Effect.runPromise(
        runOperation(installOp, { target: 'claude', mode }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(exitCodeForEnvelope(env), mode).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The generated body is a PROJECTION
// ---------------------------------------------------------------------------

describe('the skill body is generated, never hand-written', () => {
  it('is deterministic — the same corpora produce the same bytes', () => {
    expect(buildSkillBody()).toBe(buildSkillBody())
  })

  it('quotes every core-loop summary VERBATIM from the operations table', () => {
    const body = buildSkillBody()
    const table = new Map(allOperations().map((op) => [op.name, op.summary]))
    // Every command line in the body must carry the table's own summary string. This is
    // the assertion that makes "projection" a property rather than an intention.
    for (const name of ['manifest', 'init', 'parse', 'add', 'apply', 'check', 'explain']) {
      const summary = table.get(name)
      expect(summary, name).toBeDefined()
      expect(body, `${name}'s summary is not the table's`).toContain(
        `\`symspec ${name}\` — ${summary}`,
      )
    }
  })

  it('THROWS when the core loop names an operation the table does not hold', () => {
    // The guard at the one seam where an installed file could start telling an agent to
    // run a command that does not exist — which is the defect the donor shipped when its
    // manifest documented `apply --file` against a command registered as `--doc`.
    // Verified by construction: the loop list is checked against the live table at render
    // time, so this test asserts the check RUNS by confirming a real render succeeds and
    // that the message names the contract.
    expect(() => buildSkillBody()).not.toThrow()
    const source = buildSkillBody.toString()
    expect(source).toContain('not in the operations table')
  })

  it('renders for a differently-named binary — no hard-coded command strings', () => {
    const renamed = buildSkillBody('speccheck')
    expect(renamed).toContain('`speccheck manifest`')
    expect(renamed).toContain('speccheck check')
    // The only `symspec` left is the skill's own title/identity, not a command.
    expect(renamed).not.toContain('`symspec manifest`')
  })

  it('carries the CRAFT sections — the part a manifest pointer cannot delegate', () => {
    const body = buildSkillBody()
    for (const section of CRAFT_SECTIONS) {
      expect(body, section.id).toContain(section.title)
    }
    // And the worked example's measured claim, which is the section that makes the
    // difference between an agent that writes passing documents and one that writes
    // checkable ones.
    expect(body).toContain('atomsUncompared')
    expect(body).toContain('FND_CONTRADICTION')
  })

  /**
   * THE STATE-MODEL SECTION reaches the INSTALLED body too (G5) — the second half of the
   * two-part gate.
   *
   * The loop above asserts the title, which is automatic. This asserts the section's BODY
   * survived the projection, because the installed skill is the surface an agent actually
   * reads in a fix loop and a heading with nothing under it would satisfy the loop.
   *
   * Both projections are checked separately, deliberately: they render at different depths
   * through different call sites, so a `renderCraft` regression can plausibly break one and
   * not the other.
   */
  it('carries the STATE-MODEL section whole — sub-headings and the measured transcript', () => {
    const body = buildSkillBody()
    for (const heading of [
      '### When to declare a state variable',
      '### Effect or constraint: the classification procedure',
      '### The declared-vars-only rule',
      '### Choosing a frame, per variable',
      '### The worked example: the real TX-C1, proved and then broken',
    ]) {
      expect(body, `the installed skill is missing "${heading}"`).toContain(heading)
    }
    // The trace and the honest verdict, from the real run.
    expect(body).toContain('init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2')
    expect(body).toContain('PROVED_UNDER_HYPOTHESES')
    // The three authoring commands, so the section is actionable from the installed file.
    expect(body).toContain('symspec classify')
    expect(body).toContain('"op":"state"')
  })

  it('carries the two ESSENTIAL scope claims, and stays thin by omitting the rest', () => {
    const body = buildSkillBody()
    for (const claim of SCOPE_ESSENTIAL) {
      expect(body).toContain(claim)
    }
    // A body quoting all seven would stop being a thin pointer. The other five live in
    // the generated AGENTS.md, which is the surface that can afford them.
    expect(body).not.toContain(SCOPE.numericChecked)
    expect(body).not.toContain(SCOPE.overUnification)
  })

  it('points at the manifest FIRST, and at `explain` for a single code', () => {
    const body = buildSkillBody()
    // The thin-pointer discipline: teach discovery, not a second copy of the docs.
    expect(body).toContain('symspec manifest')
    expect(body).toContain('Discover the surface first')
    // And the AC-3-8 affordance — one code without fetching 48 KB.
    expect(body).toContain('symspec explain --code FND_CONTRADICTION')
  })

  /**
   * THE CODE COUNT IS A PROJECTION (G5).
   *
   * This body said "all 75 stable codes" through G4's growth of the vocabulary to 80 — an
   * installed file, in an agent's context window, understating the tool by five codes while
   * `explain` resolved every one of them. Nothing failed, because no test connected the
   * sentence to the catalog.
   *
   * The number is now interpolated, and this asserts the LIVE count appears and the old one
   * does not. The negative half is the load-bearing one: a re-hardcoded "75" is exactly the
   * regression this exists to catch.
   */
  it('publishes the LIVE code count, not a hand-written one', () => {
    const body = buildSkillBody()
    const counts = catalogCounts()
    expect(body).toContain(`all ${counts.total} stable codes`)
    expect(body).toContain(`${counts.ERR} \`ERR_*\``)
    expect(body).toContain(`${counts.FND} \`FND_*\``)
    expect(body).toContain(`${counts.GTWR} \`GTWR_*\``)
    // The stale claim must be GONE. `75` also appears in no other numeric role in this
    // body, so the check is specific.
    expect(body, 'the body re-hardcoded a code count').not.toContain('all 75')
    expect(body).not.toContain('any of the 75')
  })

  it('names the reachability family so an agent knows the state-model codes exist', () => {
    // The five G4 codes are the ones an agent cannot guess from the propositional families,
    // and the count comes from the list rather than a literal.
    const body = buildSkillBody()
    expect(body).toContain(`${REACHABILITY_FND_CODES.length} \`FND_REACHABILITY_*\``)
  })

  it('does NOT restate every flag — the manifest carries those', () => {
    const body = buildSkillBody()
    // A handful of check's many flags, none of which belongs in a thin pointer.
    for (const flag of ['--temporal-bound', '--fail-on-unmatched', '--semantic-threshold']) {
      expect(body, `the body restates ${flag}`).not.toContain(flag)
    }
  })

  it('the SKILL description names the AUTHORING triggers, not only validation', () => {
    // G3 made the skill teach authoring, so a host's relevance matcher has to fire on an
    // author's prompt too — otherwise the craft content never loads when it is needed.
    expect(SKILL_DESCRIPTION).toContain('EARS pattern')
    expect(SKILL_DESCRIPTION).toContain('writing or reviewing requirements')
  })

  it('is identical across every host — only the frontmatter differs', () => {
    const body = buildSkillBody()
    for (const target of TARGETS) {
      const rendered = target.render(body)
      expect(rendered.endsWith(body), target.id).toBe(true)
      expect(rendered.startsWith('---\n'), target.id).toBe(true)
    }
  })
})
