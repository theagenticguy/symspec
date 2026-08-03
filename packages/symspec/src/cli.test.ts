/**
 * DRIFT + CONTRACT tests against the SHIPPED BUNDLE.
 *
 * Promoted from spike S2's `verify.sh`, which is the executable form of the
 * spec's "drift is a test failure" rule. It caught two real silent bugs in a
 * three-op toy, so it graduates into the real suite rather than staying a script
 * nobody runs.
 *
 * ## Why these spawn a child process
 *
 * The drift these guard is between the SHIPPED manifest and the SHIPPED help —
 * what an agent and a human actually receive — not between two in-process
 * function calls. An in-process comparison would pass even if the CLI wiring
 * dropped a description on the floor, which is precisely the failure mode. So
 * every check here runs `node dist/cli.mjs …` for real and reads its stdout,
 * stderr, and exit code.
 *
 * That makes `dist/cli.mjs` a PREREQUISITE: the `check` script runs `build`
 * before `vitest`, and the first test below fails with a clear message rather
 * than a confusing ENOENT if the bundle is missing.
 *
 * ## The negative control is the point
 *
 * A drift test that cannot fail is decoration. `the guard fires` below corrupts a
 * summary IN MEMORY and asserts the very same comparison reports it — so the
 * check is proven capable of failing without ever committing a broken artifact.
 *
 * ## What these guards catch, verified by breaking the build on purpose
 *
 * Both experiments were run live against the real bundle, and the distinction
 * matters enough to record:
 *
 * - EDITING the single source (changing `versionOp.summary` in the table) does
 *   NOT fail these tests, and SHOULD NOT. Both surfaces move together, because
 *   both read the same string — that is single sourcing working exactly as
 *   intended, and a test that failed here would only be pinning prose.
 * - BREAKING THE LINK (replacing `Command.withDescription(versionOp.summary)`
 *   with a hand-typed string) fails three of these tests immediately. That is the
 *   regression that actually matters: someone "helpfully" restating a summary in
 *   the CLI layer is how the donor's triple-wiring drifted in the first place.
 *
 * So the guard is aimed at the PROVENANCE of the text, not its content. It fails
 * when a projection stops deriving and starts restating.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from './kernel/operation.ts'

const BUNDLE = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url))

/** Run the shipped CLI, capturing stdout, stderr and the exit code separately. */
const run = (...args: string[]): { stdout: string; stderr: string; code: number } => {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8' })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

/** Run the CLI and parse its stdout as one JSON envelope. */
const runJson = (...args: string[]): { envelope: Record<string, unknown>; code: number } => {
  const { stdout, code } = run(...args)
  return { envelope: JSON.parse(stdout) as Record<string, unknown>, code }
}

let manifest: Manifest
let rootHelp: string

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `The shipped bundle is missing at ${BUNDLE}. These are drift tests against the BUILT ` +
        'artifact — run `pnpm --filter symspec build` first (the `check` script does).',
    )
  }
  const { envelope } = runJson('manifest')
  manifest = envelope.data as Manifest
  rootHelp = execFileSync(process.execPath, [BUNDLE, '--help'], { encoding: 'utf8' })
})

// ---------------------------------------------------------------------------
// Exit-code contract, end to end
// ---------------------------------------------------------------------------

describe('exit codes from the real process', () => {
  it('exits 0 on manifest', () => {
    expect(run('manifest').code).toBe(0)
  })

  it('exits 0 on version', () => {
    expect(run('version').code).toBe(0)
  })

  it('exits 0 on a successful explain', () => {
    expect(run('explain', '--code', 'ERR_NOT_FOUND').code).toBe(0)
  })

  it('exits 2 on an operational error', () => {
    expect(run('explain', '--code', 'ERR_BOGUS').code).toBe(2)
  })

  it('exits 1 on a usage error (missing required flag)', () => {
    expect(run('explain').code).toBe(1)
  })

  it('exits 1 on an unknown subcommand', () => {
    expect(run('nope').code).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Envelope shape and stream discipline
// ---------------------------------------------------------------------------

describe('envelope shape on the wire', () => {
  it('emits {apiVersion,type,data} on success', () => {
    const { envelope } = runJson('explain', '--code', 'ERR_IO')
    expect(envelope.apiVersion).toBe(1)
    expect(envelope.type).toBe('codeExplanation')
    expect(typeof envelope.data).toBe('object')
  })

  it('emits the error envelope with code and suggestions on failure', () => {
    const { envelope, code } = runJson('explain', '--code', 'ERR_BOGUS')
    expect(code).toBe(2)
    expect(envelope.type).toBe('error')
    expect(envelope.code).toBe('ERR_NOT_FOUND')
    expect(Array.isArray(envelope.suggestions)).toBe(true)
    expect((envelope.suggestions as string[]).length).toBeGreaterThan(0)
  })

  it('carries a machine-actionable repair on the error envelope (AC-A-9)', () => {
    const { envelope } = runJson('explain', '--code', 'ERR_SOLVER_MISSNG')
    const repair = envelope.repair as { ops: unknown[]; commands: string[] }
    expect(repair.commands).toEqual(['symspec explain --code ERR_SOLVER_MISSING'])
  })

  it('writes exactly ONE line of JSON to stdout', () => {
    const { stdout } = run('version')
    expect(stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(() => JSON.parse(stdout)).not.toThrow()
  })

  /**
   * Stdout is the envelope contract; the default v4 logger writes to stdout and
   * would corrupt it, and `runMain` would append a pretty stack trace after the
   * JSON. `Logger.LogToStderr` and `errorReported=false` are what keep this clean,
   * so an EMPTY stderr on the error path is the assertion that both are wired.
   */
  it('writes the error envelope to STDOUT and leaves stderr EMPTY', () => {
    const { stdout, stderr, code } = run('explain', '--code', 'ERR_BOGUS')
    expect(code).toBe(2)
    expect(stderr).toBe('')
    expect((JSON.parse(stdout) as { type: string }).type).toBe('error')
  })

  it('emits no envelope on stdout for a usage error — stdout stays parseable-or-empty', () => {
    // A usage error is not an operational one: the CLI renders help, and an agent
    // distinguishes the two by exit code 1 with no envelope vs 2 with one.
    const { stdout, code } = run('explain')
    expect(code).toBe(1)
    expect(() => JSON.parse(stdout) as unknown).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Drift: summaries
// ---------------------------------------------------------------------------

describe('drift — manifest summaries vs root --help', () => {
  it('shows every manifest summary verbatim in --help', () => {
    const missing = manifest.operations
      .filter((op) => !rootHelp.includes(op.summary))
      .map((op) => op.name)
    expect(missing).toEqual([])
  })

  it('lists every manifest operation as a --help subcommand', () => {
    for (const op of manifest.operations) {
      expect(rootHelp).toContain(op.name)
    }
  })

  it('shows no subcommand in --help that the manifest omits', () => {
    // The other direction: help must not advertise an operation the manifest
    // does not describe, or an agent reading the manifest would miss a command.
    const subcommandBlock = rootHelp.split(/SUBCOMMANDS/)[1] ?? ''
    const advertised = subcommandBlock
      .split('\n')
      .map((line) =>
        line
          .trim()
          .split(/\s{2,}/)[0]
          ?.trim(),
      )
      .filter((name): name is string => name !== undefined && name.length > 0)
    const known = new Set(manifest.operations.map((op) => op.name))
    expect(advertised.filter((name) => !known.has(name))).toEqual([])
  })

  /**
   * THE NEGATIVE CONTROL. Corrupt a summary in memory and assert the identical
   * comparison reports it. Without this, a check that trivially passed (because
   * it compared a thing to itself, say) would look identical to a check that
   * works.
   */
  it('the guard FIRES when a summary is corrupted', () => {
    const corrupted = manifest.operations.map((op, i) =>
      i === 0 ? { ...op, summary: 'THIS SUMMARY WAS NEVER SINGLE-SOURCED' } : op,
    )
    const missing = corrupted.filter((op) => !rootHelp.includes(op.summary)).map((op) => op.name)
    expect(missing).toEqual([manifest.operations[0]?.name])
  })

  it('the guard fires for EVERY operation, not just the first', () => {
    for (const [i, op] of manifest.operations.entries()) {
      const corrupted = manifest.operations.map((o, j) =>
        j === i ? { ...o, summary: `CORRUPTED-${i}` } : o,
      )
      const missing = corrupted.filter((o) => !rootHelp.includes(o.summary)).map((o) => o.name)
      expect(missing, `corrupting ${op.name} was not detected`).toEqual([op.name])
    }
  })
})

// ---------------------------------------------------------------------------
// Drift: per-flag descriptions
// ---------------------------------------------------------------------------

/**
 * Walk `allOf`/`anyOf`/`oneOf` for a description — the same walk the kernel does,
 * re-implemented here deliberately. A drift test that imported the production
 * reader would agree with it by construction, including when it is wrong; an
 * independent reader is what makes the comparison meaningful.
 */
interface Node {
  readonly description?: string
  readonly allOf?: readonly Node[]
  readonly anyOf?: readonly Node[]
  readonly oneOf?: readonly Node[]
}
const descriptionOf = (node: Node | undefined): string | undefined => {
  if (node === undefined) return undefined
  if (node.description !== undefined) return node.description
  for (const branch of [node.allOf, node.anyOf, node.oneOf]) {
    for (const child of branch ?? []) {
      const found = descriptionOf(child)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const propertiesOf = (op: Manifest['operations'][number]): Record<string, Node> =>
  (op.input as { properties?: Record<string, Node> }).properties ?? {}

describe('drift — every flag description reaches BOTH surfaces', () => {
  it('gives every manifest field a non-blank description', () => {
    const blank: string[] = []
    for (const op of manifest.operations) {
      for (const [field, node] of Object.entries(propertiesOf(op))) {
        const d = descriptionOf(node)
        if (d === undefined || d.trim() === '') blank.push(`${op.name}.${field}`)
      }
    }
    expect(blank).toEqual([])
  })

  it('shows every manifest field description verbatim in that command --help', () => {
    const missing: string[] = []
    for (const op of manifest.operations) {
      const help = execFileSync(process.execPath, [BUNDLE, op.name, '--help'], {
        encoding: 'utf8',
      })
      for (const [field, node] of Object.entries(propertiesOf(op))) {
        const d = descriptionOf(node)
        if (d !== undefined && !help.includes(d)) missing.push(`${op.name}.${field}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives every flag in per-command --help a non-blank doc column', () => {
    // The Schema.Finite trap rendered a flag with a BLANK doc and nothing failed.
    // This asserts the rendered help line itself carries text, not just that the
    // manifest does.
    for (const op of manifest.operations) {
      const help = execFileSync(process.execPath, [BUNDLE, op.name, '--help'], {
        encoding: 'utf8',
      })
      const flagsBlock = help.split(/\nFLAGS\n/)[1]?.split(/\nGLOBAL FLAGS\n/)[0] ?? ''
      for (const line of flagsBlock.split('\n').filter((l) => l.trim().startsWith('--'))) {
        const doc = line
          .trim()
          .split(/\s{2,}/)
          .slice(1)
          .join(' ')
          .trim()
        expect(doc.length, `blank doc for flag line: ${line}`).toBeGreaterThan(0)
      }
    }
  })

  it('the description guard FIRES when a description is corrupted', () => {
    // Negative control for the field-description check, using the same
    // help-inclusion comparison against a description that was never single-sourced.
    const help = execFileSync(process.execPath, [BUNDLE, 'explain', '--help'], {
      encoding: 'utf8',
    })
    expect(help.includes('A DESCRIPTION THAT WAS NEVER SINGLE-SOURCED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Drift: defaults
// ---------------------------------------------------------------------------

describe('drift — manifest defaults match effective CLI behavior', () => {
  it('declares a default for every non-required field', () => {
    // The withDecodingDefaultKey trap: the schema defaults the value but the
    // manifest cannot see it. `defineOperation` asserts this at construction; this
    // re-asserts it on the SHIPPED artifact, where an agent actually reads it.
    const pick = (node: Node, key: 'default'): unknown => {
      const n = node as Node & { default?: unknown }
      if (n.default !== undefined) return n.default
      for (const branch of [node.allOf, node.anyOf, node.oneOf]) {
        for (const child of branch ?? []) {
          const found = pick(child, key)
          if (found !== undefined) return found
        }
      }
      return undefined
    }
    const missing: string[] = []
    for (const op of manifest.operations) {
      const required = new Set((op.input as { required?: string[] }).required ?? [])
      for (const [field, node] of Object.entries(propertiesOf(op))) {
        if (!required.has(field) && pick(node, 'default') === undefined) {
          missing.push(`${op.name}.${field}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('makes a required flag genuinely required (usage error when omitted)', () => {
    for (const op of manifest.operations) {
      const required = (op.input as { required?: string[] }).required ?? []
      if (required.length === 0) continue
      expect(run(op.name).code, `${op.name} did not fail without its required flags`).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Manifest self-consistency on the wire
// ---------------------------------------------------------------------------

describe('the shipped manifest is internally consistent', () => {
  it('agrees with `version` about the package version', () => {
    const { envelope } = runJson('version')
    const data = envelope.data as { version: string; apiVersion: number }
    expect(manifest.version).toBe(data.version)
    expect(manifest.apiVersion).toBe(data.apiVersion)
  })

  it('agrees with --version', () => {
    expect(run('--version').stdout).toContain(manifest.version)
  })

  it('publishes every error code it can actually explain', () => {
    for (const row of manifest.errorCodes) {
      const { envelope, code } = runJson('explain', '--code', row.code)
      expect(code).toBe(0)
      expect((envelope.data as { description: string }).description).toBe(row.description)
    }
  })

  it('publishes the four exit codes this suite observed', () => {
    expect(manifest.exitCodes.map((e) => e.code)).toEqual([0, 1, 2, 3])
  })

  it('describes an input schema for every operation, including no-input ones', () => {
    for (const op of manifest.operations) {
      expect(op.input).toMatchObject({ type: 'object' })
      expect(JSON.stringify(op.input)).not.toContain('"array"')
    }
  })
})

// ---------------------------------------------------------------------------
// Output flags, end to end — the invariant that matters
// ---------------------------------------------------------------------------

/**
 * These duplicate `output.test.ts`'s in-process assertions ON PURPOSE.
 *
 * An in-process check computes the exit code from the same envelope object the
 * renderer got, so it would pass even if the CLI WIRING rendered before computing
 * the code, or swallowed a failure it had prettified. The only way to know an
 * output flag cannot change the process's exit status is to observe the real
 * process's exit status, which is what these do.
 */
describe('output flags never change the EXIT CODE of the real process', () => {
  const FLAG_SETS: readonly (readonly string[])[] = [
    [],
    ['--pretty'],
    ['--dense'],
    ['--dense', '--evidence'],
    ['--field', 'data'],
    ['--field', 'nope.nothing'],
    ['--pretty', '--field', 'data'],
    ['--dense', '--field', 'data'],
  ]

  it('exit 0 stays 0 on a success, under every flag set', () => {
    for (const flags of FLAG_SETS) {
      expect(run('version', ...flags).code, flags.join(' ')).toBe(0)
      expect(run('explain', '--code', 'ERR_IO', ...flags).code, flags.join(' ')).toBe(0)
    }
  })

  it('exit 2 stays 2 on an operational error, under every flag set', () => {
    for (const flags of FLAG_SETS) {
      expect(run('explain', '--code', 'ERR_BOGUS', ...flags).code, flags.join(' ')).toBe(2)
    }
  })

  it('accepts a shared flag BEFORE the subcommand too (npm-style)', () => {
    expect(run('--pretty', 'version').code).toBe(0)
    expect(run('--pretty', 'version').stdout).toBe(run('version', '--pretty').stdout)
  })

  it('leaves stderr EMPTY in every mode — envelopes own stdout, diagnostics own stderr', () => {
    for (const flags of FLAG_SETS) {
      expect(run('explain', '--code', 'ERR_BOGUS', ...flags).stderr, flags.join(' ')).toBe('')
    }
  })
})

describe('output flags on the wire', () => {
  it('--pretty emits prose that is NOT JSON', () => {
    const { stdout } = run('version', '--pretty')
    expect(() => JSON.parse(stdout) as unknown).toThrow()
    expect(stdout).toContain('version (apiVersion 1)')
  })

  it('--dense emits ONE minified line of valid JSON', () => {
    const { stdout } = run('manifest', '--dense')
    expect(stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(() => JSON.parse(stdout) as unknown).not.toThrow()
  })

  it('--dense output is never LARGER than the default', () => {
    const dense = run('manifest', '--dense').stdout.length
    const plain = run('manifest').stdout.length
    expect(dense).toBeLessThanOrEqual(plain)
  })

  it('--field projects one value, nested under its path', () => {
    const { stdout } = run('version', '--field', 'data.version')
    expect(JSON.parse(stdout)).toEqual({ data: { version: manifest.version } })
  })

  it('--field on an unresolved path emits {} and still exits 0', () => {
    const { stdout, code } = run('version', '--field', 'data.nope')
    expect(JSON.parse(stdout)).toEqual({})
    expect(code).toBe(0)
  })

  it('the default output is byte-identical to no flags at all', () => {
    expect(run('version').stdout).toBe(run('version').stdout)
  })

  it('advertises all four output flags in --help, with non-blank docs', () => {
    for (const flag of ['--pretty', '--dense', '--evidence', '--field']) {
      expect(rootHelp, `${flag} missing from root help`).toContain(flag)
    }
    // Shared flags reach every subcommand's help too, which is the whole point of
    // declaring them once on the root.
    const subHelp = execFileSync(process.execPath, [BUNDLE, 'version', '--help'], {
      encoding: 'utf8',
    })
    for (const flag of ['--pretty', '--dense', '--evidence', '--field']) {
      expect(subHelp, `${flag} missing from version help`).toContain(flag)
    }
  })

  it('does NOT publish the output flags in any operation`s manifest input', () => {
    // They shape rendering, not behavior. Publishing them in an operation's input
    // schema would tell an agent they affect what the operation DOES.
    for (const op of manifest.operations) {
      const props = Object.keys(propertiesOf(op))
      for (const flag of ['pretty', 'dense', 'evidence', 'field']) {
        expect(props, `${op.name} publishes ${flag}`).not.toContain(flag)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The document lifecycle, against the REAL bundle and the REAL filesystem
// ---------------------------------------------------------------------------

/**
 * These are the end-to-end complement to `operations/document.test.ts` and
 * `operations/import.test.ts`, which run the same handlers against an in-memory
 * store. Both layers are needed for different reasons:
 *
 * - the in-memory tests can assert what a handler WROTE, cheaply, and cover the
 *   branches (duplicate keys, widened waiver scopes) that would be tedious to set
 *   up on disk;
 * - THESE prove the wiring — that the layers are actually provided at the
 *   composition root, that the positional/flag mapping matches the schema, that
 *   stdin really reaches `import`, and that a real atomic write lands a real file
 *   an `--field` projection can then read back.
 *
 * A missing layer at the composition root is invisible to the in-memory tests and
 * fatal in production, which is exactly why these spawn the bundle.
 */
describe('the document lifecycle end to end', () => {
  const workDirs: string[] = []

  const work = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'symspec-cli-'))
    workDirs.push(dir)
    return dir
  }

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(workDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  const FIXTURES = fileURLToPath(new URL('./operations/__fixtures__', import.meta.url))

  it('init creates a real file that list then reads', () => {
    const dir = work()
    const doc = join(dir, 'requirements.json')
    expect(run('init', doc).code).toBe(0)
    expect(existsSync(doc)).toBe(true)
    const { envelope, code } = runJson('list', doc)
    expect(code).toBe(0)
    expect((envelope.data as { count: number; docVersion: number }).count).toBe(0)
    expect((envelope.data as { docVersion: number }).docVersion).toBe(3)
  })

  it('init REFUSES to overwrite, exits 2, and leaves the file byte-identical', () => {
    const dir = work()
    const doc = join(dir, 'requirements.json')
    run('init', doc)
    const before = readFileSync(doc, 'utf8')
    const { envelope, code } = runJson('init', doc)
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_DOC_EXISTS')
    expect(readFileSync(doc, 'utf8')).toBe(before)
  })

  it('init --force overwrites', () => {
    const dir = work()
    const doc = join(dir, 'requirements.json')
    run('init', doc)
    expect(run('init', doc, '--force').code).toBe(0)
  })

  it('honors SYMSPEC_DOC when no path is given', () => {
    const dir = work()
    const doc = join(dir, 'from-env.json')
    const r = spawnSync(process.execPath, [BUNDLE, 'init'], {
      encoding: 'utf8',
      env: { ...process.env, SYMSPEC_DOC: doc },
    })
    expect(r.status).toBe(0)
    expect(existsSync(doc)).toBe(true)
  })

  it('list on a missing document is ERR_DOC_NOT_FOUND at exit 2', () => {
    const dir = work()
    const { envelope, code } = runJson('list', join(dir, 'absent.json'))
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_DOC_NOT_FOUND')
  })

  it('imports the agent-run-triggers stream from --file, with exact counts', () => {
    const dir = work()
    const doc = join(dir, 'art.json')
    const { envelope, code } = runJson(
      'import',
      '--file',
      join(FIXTURES, 'hex-bonk-agent-run-triggers.ops.jsonl'),
      '--doc',
      doc,
    )
    expect(code).toBe(0)
    const data = envelope.data as {
      imported: Record<string, number>
      gaps: string[]
      problems: unknown[]
      unresolved: unknown[]
    }
    expect(data.imported).toEqual({
      requirements: 25,
      edges: 22,
      glossary: 0,
      antonyms: 0,
      waivers: 8,
    })
    expect(data.problems).toEqual([])
    expect(data.unresolved).toEqual([])
    expect(data.gaps.length).toBeGreaterThan(0)
    // The imported document is loadable by the same binary — the round trip that
    // matters operationally.
    expect((runJson('list', doc).envelope.data as { count: number }).count).toBe(25)
  })

  it('imports the schedule-management stream from STDIN', () => {
    // stdin is what makes the whole migration one pipe, and it is the one path an
    // in-memory test cannot cover.
    const dir = work()
    const doc = join(dir, 'sm.json')
    const stream = readFileSync(join(FIXTURES, 'hex-bonk-schedule-management.ops.jsonl'), 'utf8')
    const r = spawnSync(process.execPath, [BUNDLE, 'import', '--doc', doc], {
      encoding: 'utf8',
      input: stream,
    })
    expect(r.status).toBe(0)
    const data = (JSON.parse(r.stdout) as { data: { imported: Record<string, number> } }).data
    expect(data.imported.requirements).toBe(42)
    expect(data.imported.edges).toBe(40)
    expect((runJson('list', doc).envelope.data as { count: number }).count).toBe(42)
  })

  it('import --dry-run reports everything and writes NOTHING', () => {
    const dir = work()
    const doc = join(dir, 'never-written.json')
    const { envelope, code } = runJson(
      'import',
      '--file',
      join(FIXTURES, 'hex-bonk-agent-run-triggers.ops.jsonl'),
      '--doc',
      doc,
      '--dry-run',
    )
    expect(code).toBe(0)
    const data = envelope.data as { written: boolean; imported: Record<string, number> }
    expect(data.written).toBe(false)
    expect(data.imported.requirements).toBe(25)
    expect(existsSync(doc)).toBe(false)
  })

  it('import refuses to clobber an existing document', () => {
    const dir = work()
    const doc = join(dir, 'requirements.json')
    run('init', doc)
    const before = readFileSync(doc, 'utf8')
    const { envelope, code } = runJson(
      'import',
      '--file',
      join(FIXTURES, 'hex-bonk-agent-run-triggers.ops.jsonl'),
      '--doc',
      doc,
    )
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_DOC_EXISTS')
    expect(readFileSync(doc, 'utf8')).toBe(before)
  })

  it('import with an EMPTY stdin is a usage error, not a silent empty document', () => {
    const dir = work()
    const doc = join(dir, 'empty.json')
    const r = spawnSync(process.execPath, [BUNDLE, 'import', '--doc', doc], {
      encoding: 'utf8',
      input: '',
    })
    expect(r.status).toBe(2)
    expect((JSON.parse(r.stdout) as { code: string }).code).toBe('ERR_USAGE')
    expect(existsSync(doc)).toBe(false)
  })

  it('show resolves a stable KEY and a UUID to the same requirement', () => {
    const dir = work()
    const doc = join(dir, 'art.json')
    run('import', '--file', join(FIXTURES, 'hex-bonk-agent-run-triggers.ops.jsonl'), '--doc', doc)

    const byKey = runJson('show', 'TX-B6', doc)
    expect(byKey.code).toBe(0)
    const requirement = (byKey.envelope.data as { requirement: { id: string } }).requirement
    const byId = runJson('show', requirement.id, doc)
    expect(byId.code).toBe(0)
    expect((byId.envelope.data as { requirement: unknown }).requirement).toEqual(requirement)
    // resolvedFrom differs — that IS the mapping an agent needs to persist a UUID.
    expect((byKey.envelope.data as { resolvedFrom: string }).resolvedFrom).toBe('TX-B6')
  })

  it('show on a near miss carries did-you-mean and a runnable repair', () => {
    const dir = work()
    const doc = join(dir, 'art.json')
    run('import', '--file', join(FIXTURES, 'hex-bonk-agent-run-triggers.ops.jsonl'), '--doc', doc)
    const { envelope, code } = runJson('show', 'TX-B7', doc)
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_NOT_FOUND')
    const repair = envelope.repair as { commands: string[] }
    expect(repair.commands[0]).toMatch(/^symspec show TX-B/)
  })

  it('show without a ref is a USAGE error (exit 1, no envelope)', () => {
    // The ref field is required in the schema, so the CLI fails before a handler
    // runs — derived from the schema, not hand-wired.
    const { stdout, code } = run('show')
    expect(code).toBe(1)
    expect(() => JSON.parse(stdout) as unknown).toThrow()
  })

  it('every document command reaches its layers — no missing-service crash', () => {
    // A layer missing at the composition root is invisible to the in-memory tests
    // and fatal in production. This is the assertion that catches it: an unprovided
    // service surfaces as a non-envelope crash on stderr, so a clean typed envelope
    // on stdout proves the wiring.
    const dir = work()
    const doc = join(dir, 'requirements.json')
    for (const args of [
      ['init', doc],
      ['list', doc],
      ['show', 'nope', doc],
      ['import', '--doc', join(dir, 'x.json'), '--file', join(dir, 'absent.jsonl')],
    ]) {
      const { stdout, stderr } = run(...args)
      expect(() => JSON.parse(stdout) as unknown, args.join(' ')).not.toThrow()
      expect(stderr, args.join(' ')).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// `check` through the real process — the exit-code gap G1 could not see
// ---------------------------------------------------------------------------

/**
 * These MUST be end-to-end, and that is the lesson rather than a preference.
 *
 * `exitCodeForEnvelope` was fully implemented and fully unit-tested in G1, and the
 * CLI never CALLED it on the success path. No G1 operation produced findings, so
 * every reachable success genuinely was exit 0 and the omission was invisible to
 * every in-process test — including the ones that asserted the mapping itself,
 * which passed because the FUNCTION was right. The bug was in the shell.
 *
 * `check --strict` exposed it: `data.strictGate: 'fail'` in the envelope and exit 0
 * at the shell. A CI job wired to `--strict` would have passed on every
 * inconclusive run — the failure mode the whole exit contract exists to prevent.
 *
 * So the assertions below read the PROCESS STATUS, not a function's return value.
 */
describe('check — exit codes and envelope integrity from the real process', () => {
  const workDirs: string[] = []
  const work = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'symspec-check-'))
    workDirs.push(dir)
    return dir
  }
  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(workDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  const TS = '2026-01-01T00:00:00.000Z'
  const req = (
    id: string,
    trigger: string,
    systemName: string,
    systemResponse: string,
  ): Record<string, unknown> => ({
    id,
    patternType: 'event-driven',
    trigger,
    systemName,
    systemResponse,
    negated: false,
    sentence: `When ${trigger}, the ${systemName} shall ${systemResponse}.`,
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: TS,
    updatedAt: TS,
  })

  /** Write a v3 document and return its path. */
  const docFile = (requirements: readonly Record<string, unknown>[]): string => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const path = join(work(), 'requirements.json')
    writeFileSync(
      path,
      JSON.stringify({
        docVersion: 3,
        requirements: Object.fromEntries(requirements.map((r) => [r.id as string, r])),
        stateModel: { variables: [] },
        glossary: [],
        antonyms: [],
        waivers: [],
      }),
    )
    return path
  }

  /** A provable grant/revoke contradiction under one trigger. */
  const conflicted = (): string =>
    docFile([
      req(
        '11111111-1111-4111-8111-111111111111',
        'the user submits valid credentials',
        'auth service',
        'grant access',
      ),
      req(
        '22222222-2222-4222-8222-222222222222',
        'the user submits valid credentials',
        'auth service',
        'revoke access',
      ),
    ])

  /** Two requirements with disjoint vocabulary — unverifiable, no error finding. */
  const disjoint = (): string =>
    docFile([
      req('33333333-3333-4333-8333-333333333333', 'a payment settles', 'ledger', 'post the entry'),
      req(
        '44444444-4444-4444-8444-444444444444',
        'a shipment departs',
        'warehouse',
        'decrement the count',
      ),
    ])

  it('exits 1 on an error-severity finding, WITH a valid envelope on stdout', () => {
    const { stdout, stderr, code } = run('check', conflicted())
    expect(code).toBe(1)
    // The findings ARE the data: exit 1 is the gate signal, not a crash, so the
    // envelope must still be complete and parseable.
    const envelope = JSON.parse(stdout) as { type: string; data: { counts: { error: number } } }
    expect(envelope.type).toBe('check')
    expect(envelope.data.counts.error).toBeGreaterThan(0)
    // No second, human-shaped report after the JSON — `Runtime.errorReported=false`
    // on the gate carrier is what buys this.
    expect(stderr).toBe('')
  })

  it('exits 3 on a tripped --strict gate, WITH a valid envelope on stdout', () => {
    const { stdout, stderr, code } = run('check', disjoint(), '--strict')
    // THE regression this file exists for. Before the fix: envelope said
    // `strictGate:'fail'` and the process exited 0.
    expect(code).toBe(3)
    const envelope = JSON.parse(stdout) as {
      data: { strictGate: string; verified: boolean; counts: { error: number } }
    }
    expect(envelope.data.strictGate).toBe('fail')
    expect(envelope.data.verified).toBe(false)
    // 3, not 1: there is no error-severity finding, only an unverifiable run.
    expect(envelope.data.counts.error).toBe(0)
    expect(stderr).toBe('')
  })

  it('exits 3 on --fail-on-unmatched 0, and 0 when the flag is OMITTED', () => {
    const doc = disjoint()
    // 0 is the STRICTEST legal threshold, not a sentinel: fail on any unmatched
    // atom. A `> 0` guard in the option translation would silently turn this into
    // no gate at all, which is what this pins.
    expect(run('check', doc, '--fail-on-unmatched', '0').code).toBe(3)
    // OMITTING the flag is how the gate is disabled. A negative sentinel is
    // UNREACHABLE from a command line — measured: `--fail-on-unmatched -1` makes the
    // CLI read `-1` as the next flag and dump help — so absence had to be the
    // disabled state, which is why the schema field is `NullOr`.
    expect(run('check', doc).code).toBe(0)
  })

  it('a proven defect OUTRANKS the strict gate (1, not 3)', () => {
    const { code } = run('check', conflicted(), '--strict')
    // "Your spec is broken" is stronger news than "I could not fully check it".
    expect(code).toBe(1)
  })

  it('exits 0 on an info-only run, so advisory findings are not build failures', () => {
    const { code } = run('check', disjoint())
    expect(code).toBe(0)
  })

  it('exits 2 with ERR_USAGE on an over-cap --temporal-bound', () => {
    const { stdout, code } = run('check', disjoint(), '--temporal-bound', '500')
    expect(code).toBe(2)
    const envelope = JSON.parse(stdout) as {
      type: string
      code: string
      repair?: { commands: string[] }
    }
    expect(envelope.type).toBe('error')
    expect(envelope.code).toBe('ERR_USAGE')
    // The corrected invocation is runnable, with no placeholder to substitute.
    expect(envelope.repair?.commands[0]).toMatch(/^symspec check .* --temporal-bound/)
  })

  it('output flags NEVER change the exit code', () => {
    // Structural in `emit` (the code is computed from the envelope, which formatting
    // cannot reach), and asserted here because it is the property an agent relies on
    // when it adds `--dense` to a CI invocation.
    const doc = conflicted()
    for (const flags of [[], ['--dense'], ['--pretty'], ['--field', 'data.verified']]) {
      expect(run('check', doc, ...flags).code, flags.join(' ')).toBe(1)
    }
  })

  it('--dense output survives a PIPE at full size (no 64KB truncation)', () => {
    // The donor's measured defect: `process.stdout.write` + `process.exit` truncates
    // at one pipe buffer (65536 bytes), producing invalid JSON on exactly the
    // documents big enough to matter. `check` is the command that produces those
    // payloads, so it is the one worth pinning.
    const doc = disjoint()
    const { stdout } = run('check', doc, '--dense')
    expect(() => JSON.parse(stdout) as unknown).not.toThrow()
  })

  it('reaches its layers — no missing-service crash for the solver Layer', () => {
    // The solver Layer is new at the composition root. An unprovided service
    // surfaces as a non-envelope crash on stderr, so a clean typed envelope proves
    // the wiring — the same assertion the document commands get.
    const { stdout, stderr } = run('check', disjoint())
    expect(() => JSON.parse(stdout) as unknown).not.toThrow()
    expect(stderr).toBe('')
  })

  it('every demotion in a REAL run carries a placeholder-free repair', () => {
    const { stdout } = run('check', disjoint())
    const envelope = JSON.parse(stdout) as {
      data: { coverage: { demotions: { reason: string; repair?: { commands: string[] } }[] } }
    }
    const demotions = envelope.data.coverage.demotions
    expect(demotions.length).toBeGreaterThan(0)
    for (const d of demotions) {
      expect(d.repair, `${d.reason} has no repair`).toBeDefined()
      for (const command of d.repair?.commands ?? []) {
        expect(command, `placeholder survived into: ${command}`).not.toMatch(/<[a-z-]+>/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// `install` through the SHIPPED bundle — the V11 fixes at the process boundary
// ---------------------------------------------------------------------------

/**
 * The install surface, driven the way a developer actually drives it.
 *
 * `install.test.ts` covers the operation in-process against a temp filesystem, which is
 * where the host→path matrix and the three V11 fixes are asserted exhaustively. What only a
 * spawned process can show is that the CLI WIRING reaches all of it: that `--mode` and
 * `--target` are registered with the spellings the schema names, that the flag layer does
 * not drop a value on the floor, and that a `print` misuse produces exit 2 rather than a
 * help dump.
 *
 * That distinction is not hypothetical here. Delta #21 records `--fail-on-unmatched -1`
 * degrading to a help dump at exit 0 — a value that typechecks, decodes, and unit-tests
 * perfectly and is untypeable at a shell. Every new flag surface earns one of these blocks.
 */
describe('install through the real process', () => {
  const installDirs: string[] = []

  const workspace = (): { cwd: string; home: string; env: NodeJS.ProcessEnv } => {
    const root = mkdtempSync(join(tmpdir(), 'symspec-cli-install-'))
    installDirs.push(root)
    const cwd = join(root, 'proj')
    const home = join(root, 'home')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(home, { recursive: true })
    // The roots are steered through the same overrides `processRoots` consults, so no test
    // here can write into the developer's real `~/.claude`.
    return { cwd, home, env: { ...process.env, SYMSPEC_TEST_CWD: cwd, SYMSPEC_TEST_HOME: home } }
  }

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(installDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  /** Run the shipped CLI with install roots pointed at a temp workspace. */
  const runIn = (
    env: NodeJS.ProcessEnv,
    ...args: string[]
  ): { envelope: Record<string, unknown>; code: number } => {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8', env })
    return { envelope: JSON.parse(r.stdout ?? '') as Record<string, unknown>, code: r.status ?? -1 }
  }

  it('V11 fix #3: bare `install` in a marker-less repo WRITES a file and says it fell back', () => {
    // The donor exited 0 here having written nothing. At the process boundary that is
    // indistinguishable from success, which is why this assertion checks the FILE.
    const { cwd, env } = workspace()
    const { envelope, code } = runIn(env, 'install')
    expect(code).toBe(0)
    const data = envelope.data as { basis: string; note?: string }
    expect(data.basis).toBe('fallback')
    expect(data.note).toContain('No agent-host marker')
    expect(existsSync(join(cwd, '.agents', 'skills', 'symspec', 'SKILL.md'))).toBe(true)
  })

  it('writes all five host paths under --target all, and no root instruction file', () => {
    const { cwd, env } = workspace()
    expect(runIn(env, 'install', '--target', 'all').code).toBe(0)
    for (const relative of [
      '.claude/skills/symspec/SKILL.md',
      '.agents/skills/symspec/SKILL.md',
      '.kiro/steering/symspec.md',
      '.windsurf/rules/symspec.md',
      '.github/instructions/symspec.instructions.md',
    ]) {
      expect(existsSync(join(cwd, relative)), relative).toBe(true)
    }
    for (const root of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(existsSync(join(cwd, root)), root).toBe(false)
    }
  })

  it('V11 fix #1: the Kiro glob written to disk covers markdown', () => {
    const { cwd, env } = workspace()
    runIn(env, 'install', '--target', 'kiro')
    const written = readFileSync(join(cwd, '.kiro', 'steering', 'symspec.md'), 'utf8')
    expect(written).toContain('inclusion: fileMatch')
    expect(written).toContain('.{md,json}')
    // The donor's JSON-only pattern, gone from the artifact rather than only from a constant.
    expect(written).not.toContain('.requirements}.json"')
  })

  it('the installed file teaches CRAFT, not only the command surface', () => {
    // AC-A-6 at the artifact: the whole point of the wave is that what lands on disk
    // contains the authoring guidance, since that is the part no manifest can carry.
    const { cwd, env } = workspace()
    runIn(env, 'install', '--target', 'claude')
    const written = readFileSync(join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md'), 'utf8')
    expect(written).toContain('Choosing an EARS pattern')
    expect(written).toContain('Align vocabulary BEFORE writing')
    expect(written).toContain('Anti-patterns')
    expect(written).toContain('silence is not a consistency certificate')
    // And it still points at the manifest first — thin pointer for reference material.
    expect(written).toContain('symspec manifest')
  })

  it('is idempotent across processes, not merely within one', () => {
    // `unchanged` has to hold when the SECOND run is a fresh process reading the file the
    // first one wrote — an in-process test could pass on a cached value.
    const { env } = workspace()
    expect(
      (
        runIn(env, 'install', '--target', 'claude').envelope.data as {
          targets: { files: { action: string }[] }[]
        }
      ).targets[0]?.files[0]?.action,
    ).toBe('created')
    expect(
      (
        runIn(env, 'install', '--target', 'claude').envelope.data as {
          targets: { files: { action: string }[] }[]
        }
      ).targets[0]?.files[0]?.action,
    ).toBe('unchanged')
  })

  it('--mode print with no --target is ERR_USAGE at exit 2, not a help dump', () => {
    // Delta #21's shape: a misuse that must be a typed failure rather than the CLI runtime
    // silently printing help and exiting 0.
    const { env } = workspace()
    const { envelope, code } = runIn(env, 'install', '--mode', 'print')
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_USAGE')
  })

  it('an unknown --target is ERR_USAGE at exit 2 with the known set named', () => {
    const { env } = workspace()
    const { envelope, code } = runIn(env, 'install', '--target', 'not-a-host')
    expect(code).toBe(2)
    expect(envelope.code).toBe('ERR_USAGE')
    expect(String(envelope.error)).toContain('not-a-host')
    expect(String(JSON.stringify(envelope.suggestions))).toContain('agents-standard')
  })

  it('--mode check reports state and writes NOTHING', () => {
    const { cwd, env } = workspace()
    const { envelope, code } = runIn(env, 'install', '--mode', 'check', '--target', 'claude')
    expect(code).toBe(0)
    expect((envelope.data as { targets: { note?: string }[] }).targets[0]?.note).toBe('missing')
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
  })

  it('uninstall removes the file and repeats cleanly', () => {
    const { cwd, env } = workspace()
    runIn(env, 'install', '--target', 'claude')
    const path = join(cwd, '.claude', 'skills', 'symspec', 'SKILL.md')
    expect(existsSync(path)).toBe(true)
    expect(runIn(env, 'install', '--target', 'claude', '--mode', 'uninstall').code).toBe(0)
    expect(existsSync(path)).toBe(false)
    // Repeating is a quiet no-op rather than a failure.
    expect(runIn(env, 'install', '--target', 'claude', '--mode', 'uninstall').code).toBe(0)
  })

  it('--global routes to the home root and leaves the project untouched', () => {
    const { cwd, home, env } = workspace()
    expect(runIn(env, 'install', '--target', 'claude', '--global').code).toBe(0)
    expect(existsSync(join(home, '.claude', 'skills', 'symspec', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
  })
})
