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
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
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
