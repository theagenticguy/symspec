/**
 * Spawn-level CLI integration tests (AC-6-9).
 *
 * These drive the WHOLE command spine end-to-end by spawning the CLI as a real
 * process — the exact surface an agent invokes — and asserting on stdout
 * envelopes and process exit codes, rather than calling the pure cores in
 * isolation (those are covered by their own unit tests). They prove the wiring
 * `cli/index.ts` performs: resolve-doc → load → core → save → envelope → render
 * → exit.
 *
 * The suite runs against the BUILT `dist/cli.mjs` when present (the shipped
 * binary), else falls back to `tsx src/cli/index.ts` — so it works whether or
 * not `pnpm build` ran first. Coverage:
 *   - init → add → check happy path emitting valid `{apiVersion,type,data}`
 *     envelopes (AC-6-2/6-2a);
 *   - the exit-code contract 0 / 1 / 2 (AC-6-2b);
 *   - `--dense` round-trips to an equal object against the same schema (AC-6-4);
 *   - the `manifest` envelope's `data` validates against `ManifestSchema` (AC-6-1);
 *   - bad args → an `ERR_USAGE`/`ERR_*` envelope on stdout, never a stack trace
 *     (AC-6-10).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from '../envelope.js'
import { ManifestSchema } from '../manifest.js'

const execFileAsync = promisify(execFile)

// Resolve the CLI entry: prefer the built bundle, else run the TS source via tsx.
const DIST_CLI = fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))
const SRC_CLI = fileURLToPath(new URL('../index.ts', import.meta.url))
const USE_DIST = existsSync(DIST_CLI)

/** Run the CLI with `args`; capture stdout, stderr, and the exit code. */
async function runCli(
  args: string[],
  opts: { input?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const argv = USE_DIST ? [DIST_CLI, ...args] : ['tsx', SRC_CLI, ...args]
  const bin = USE_DIST ? 'node' : 'pnpm'
  const fullArgs = USE_DIST ? argv : ['exec', ...argv]
  try {
    const child = execFileAsync(bin, fullArgs, { encoding: 'utf8' })
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input)
    }
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
  }
}

/** Parse the last JSON object printed on stdout (commands emit exactly one). */
function lastJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  return JSON.parse(trimmed)
}

let dir: string
let docPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symspec-cli-it-'))
  docPath = join(dir, 'requirements.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI integration — init → add → check happy path (AC-6-2 / AC-6-2b)', () => {
  it('init emits a success envelope and exits 0', async () => {
    const { stdout, code } = await runCli(['init', docPath])
    expect(code).toBe(0)
    const env = lastJson(stdout) as { apiVersion: number; type: string; data: unknown }
    expect(() => SuccessEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.type).toBe('init')
    expect(existsSync(docPath)).toBe(true)
  })

  it('add mints a UUID, renders the sentence, and persists (exit 0)', async () => {
    await runCli(['init', docPath])
    const { stdout, code } = await runCli([
      'add',
      docPath,
      '--pattern',
      'ubiquitous',
      '--system',
      'auth service',
      '--response',
      'record an audit log entry',
    ])
    expect(code).toBe(0)
    const env = lastJson(stdout) as {
      type: string
      data: { id: string; requirement: { sentence: string } }
    }
    expect(env.type).toBe('add')
    expect(env.data.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(env.data.requirement.sentence).toBe('The auth service shall record an audit log entry.')
  })

  it('a clean spec → check exits 0 with a valid findings envelope', async () => {
    await runCli(['init', docPath])
    await runCli([
      'add',
      docPath,
      '--pattern',
      'ubiquitous',
      '--system',
      'auth service',
      '--response',
      'record an audit log entry',
    ])
    const { stdout, code } = await runCli(['check', docPath])
    expect(code).toBe(0)
    const env = lastJson(stdout) as { type: string; data: { findings: unknown[] } }
    expect(() => SuccessEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.type).toBe('check')
    expect(Array.isArray(env.data.findings)).toBe(true)
  })
})

describe('CLI integration — semantic tier is core, fail closed', () => {
  it('check without a model (stub off, empty cache, offline) → exit 2 ERR_EMBED_MODEL_MISSING', async () => {
    await runCli(['init', docPath])
    // Point the model cache at an empty dir, disable the test stub, forbid
    // remote fetch: the run must fail CLOSED before any tier executes.
    const emptyCache = join(dir, 'no-models-here')
    const argv = USE_DIST ? [DIST_CLI, 'check', docPath] : ['tsx', SRC_CLI, 'check', docPath]
    const bin = USE_DIST ? 'node' : 'pnpm'
    const fullArgs = USE_DIST ? argv : ['exec', ...argv]
    const result = await execFileAsync(bin, fullArgs, {
      encoding: 'utf8',
      env: {
        ...process.env,
        SYMSPEC_EMBED_STUB: '',
        SYMSPEC_MODEL_DIR: emptyCache,
        SYMSPEC_EMBED_ALLOW_REMOTE: '',
      },
    }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (e: { stdout?: string; stderr?: string; code?: number }) => ({
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        code: e.code ?? 1,
      }),
    )
    expect(result.code).toBe(2)
    const env = lastJson(result.stdout) as { type: string; code: string }
    expect(env.type).toBe('error')
    expect(env.code).toBe('ERR_EMBED_MODEL_MISSING')
  })
})

describe('CLI integration — exit-code contract (AC-6-2b)', () => {
  it('a spec with an error-severity finding → exit 1, envelope still on stdout', async () => {
    await runCli(['init', docPath])
    // "always" is an unachievable absolute (GTWR_R26_ABSOLUTE, error severity).
    await runCli([
      'add',
      docPath,
      '--pattern',
      'ubiquitous',
      '--system',
      'system',
      '--response',
      'always respond instantly',
    ])
    const { stdout, code } = await runCli(['check', docPath])
    expect(code).toBe(1)
    const env = lastJson(stdout) as { type: string; data: { findings: { severity: string }[] } }
    expect(env.type).toBe('check')
    expect(env.data.findings.some((f) => f.severity === 'error')).toBe(true)
  })

  it('a missing document → exit 2 with an ERR_DOC_NOT_FOUND error envelope', async () => {
    const { stdout, code } = await runCli(['check', join(dir, 'nope.json')])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { type: string; code: string }
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.type).toBe('error')
    expect(env.code).toBe('ERR_DOC_NOT_FOUND')
  })
})

describe('CLI integration — --dense round-trip (AC-6-4)', () => {
  it('--dense output is minified and validates/round-trips against the success schema', async () => {
    await runCli(['init', docPath])
    await runCli([
      'add',
      docPath,
      '--pattern',
      'ubiquitous',
      '--system',
      'auth service',
      '--response',
      'record an audit log entry',
    ])
    const dense = await runCli(['list', docPath, '--dense'])
    expect(dense.code).toBe(0)
    // Minified: no pretty-print newlines inside the single JSON object.
    expect(dense.stdout.trim()).not.toContain('\n')
    const denseEnv = lastJson(dense.stdout)
    expect(() => SuccessEnvelopeSchema.parse(denseEnv)).not.toThrow()

    // The dense envelope carries the same typed structure as the default JSON.
    const plain = await runCli(['list', docPath])
    const plainEnv = lastJson(plain.stdout) as { type: string; data: unknown }
    const de = denseEnv as { type: string; data: unknown }
    expect(de.type).toBe(plainEnv.type)
    expect(de.data).toEqual(plainEnv.data)
  })
})

describe('CLI integration — --field jq-style projection', () => {
  it('projects a single nested field to a nested object', async () => {
    await runCli(['init', docPath])
    const { stdout, code } = await runCli(['check', docPath, '--field', 'data.verified'])
    expect(code).toBe(0)
    expect(lastJson(stdout)).toEqual({ data: { verified: true } })
  })

  it('projects multiple fields, merged into one nested object', async () => {
    await runCli(['init', docPath])
    const { stdout } = await runCli(['check', docPath, '--field', 'type,data.verified'])
    expect(lastJson(stdout)).toEqual({ type: 'check', data: { verified: true } })
  })

  it('omits an unresolved path (no null); an all-miss projection is {}', async () => {
    await runCli(['init', docPath])
    const present = await runCli(['check', docPath, '--field', 'data.verified,data.nope'])
    expect(lastJson(present.stdout)).toEqual({ data: { verified: true } })
    const allMiss = await runCli(['check', docPath, '--field', 'data.nope,other.miss'])
    expect(lastJson(allMiss.stdout)).toEqual({})
  })

  it('composes with --dense (minified projection of the densified envelope)', async () => {
    await runCli(['init', docPath])
    const { stdout, code } = await runCli(['check', docPath, '--dense', '--field', 'data.verified'])
    expect(code).toBe(0)
    expect(stdout.trim()).not.toContain('\n ') // minified
    expect(lastJson(stdout)).toEqual({ data: { verified: true } })
  })
})

describe('CLI integration — manifest validates against ManifestSchema (AC-6-1)', () => {
  it("manifest envelope's data parses through ManifestSchema", async () => {
    const { stdout, code } = await runCli(['manifest'])
    expect(code).toBe(0)
    const env = lastJson(stdout) as { type: string; data: unknown }
    expect(env.type).toBe('manifest')
    expect(() => ManifestSchema.parse(env.data)).not.toThrow()
    const manifest = ManifestSchema.parse(env.data)
    expect(manifest.commands.map((c) => c.name)).toContain('check')
    // No migrate command (SC-1/SC-2).
    expect(manifest.commands.map((c) => c.name)).not.toContain('migrate')
    // Backends report is present (AC-6-14): z3-wasm always available.
    expect(manifest.backends?.['z3-wasm'].available).toBe(true)
  })
})

describe('CLI integration — bad args → ERR_USAGE envelope, not a stack trace (AC-6-10)', () => {
  it('an unknown command yields an ERR_USAGE error envelope on stdout (exit 2)', async () => {
    const { stdout, stderr, code } = await runCli(['frobnicate'])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { type: string; code: string }
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.code).toBe('ERR_USAGE')
    // Never a raw Node stack trace.
    expect(stdout).not.toContain('at Object.')
    expect(stderr).not.toContain('at Object.')
  })

  it('an unknown relation on remove-edge yields ERR_INVALID_RELATION', async () => {
    await runCli(['init', docPath])
    const { stdout, code } = await runCli([
      'remove-edge',
      '--file',
      docPath,
      '11111111-1111-1111-1111-111111111111',
      'bogus',
      '22222222-2222-2222-2222-222222222222',
    ])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { code: string }
    expect(env.code).toBe('ERR_INVALID_RELATION')
  })

  it('show on a missing id yields ERR_NOT_FOUND', async () => {
    await runCli(['init', docPath])
    const { stdout, code } = await runCli([
      'show',
      '--file',
      docPath,
      '11111111-1111-1111-1111-111111111111',
    ])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { code: string }
    expect(env.code).toBe('ERR_NOT_FOUND')
  })

  it('a positional on `glossary list` names the stray arg and points at --file/SYMSPEC_DOC', async () => {
    await runCli(['init', docPath])
    // A natural mistake: passing the doc positionally to a read-only list
    // subcommand (which takes --file). The error must name the offending arg and
    // the doc-path remedy, not a bare "too many arguments" count.
    const { stdout, code } = await runCli(['glossary', 'list', docPath])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { code: string; error: string; suggestions: string[] }
    expect(env.code).toBe('ERR_USAGE')
    expect(env.error).toContain('glossary list takes no positional argument')
    expect(env.error).toContain(docPath)
    expect(env.error).toContain('--file')
    expect(env.error).toContain('SYMSPEC_DOC')
  })

  it('`waive list` and `antonym list` reject a stray positional the same way', async () => {
    await runCli(['init', docPath])
    for (const group of ['waive', 'antonym'] as const) {
      const { stdout, code } = await runCli([group, 'list', docPath])
      expect(code).toBe(2)
      const env = lastJson(stdout) as { code: string; error: string }
      expect(env.code).toBe('ERR_USAGE')
      expect(env.error).toContain(`${group} list takes no positional argument`)
      expect(env.error).toContain('--file')
    }
  })

  it('an arity error on `delete` (doc passed positionally) suggests --file/SYMSPEC_DOC', async () => {
    await runCli(['init', docPath])
    // `delete <id>` takes the doc via --file; passing <id> then a doc path
    // positionally is a too-many-arguments arity error. The suggestion must name
    // the doc-path remedy so the agent can correct the call.
    const { stdout, code } = await runCli([
      'delete',
      '11111111-1111-1111-1111-111111111111',
      docPath,
    ])
    expect(code).toBe(2)
    const env = lastJson(stdout) as { code: string; suggestions: string[] }
    expect(env.code).toBe('ERR_USAGE')
    expect(env.suggestions.some((s) => s.includes('--file') && s.includes('SYMSPEC_DOC'))).toBe(
      true,
    )
  })
})

describe('CLI integration — parse + edge ops (AC-6-9 inventory)', () => {
  it('parse of a single sentence returns an ok ParseResult in a batch envelope', async () => {
    const { stdout, code } = await runCli([
      'parse',
      'When the user logs in, the auth service shall issue a token',
    ])
    expect(code).toBe(0)
    const env = lastJson(stdout) as {
      type: string
      data: { results: { outcome: string }[]; summary: { ok: number } }
    }
    expect(env.type).toBe('parse')
    expect(env.data.results[0]?.outcome).toBe('ok')
    expect(env.data.summary.ok).toBe(1)
  })

  it('derive adds an edge between two requirements and persists', async () => {
    await runCli(['init', docPath])
    const a = lastJson(
      (
        await runCli([
          'add',
          docPath,
          '--pattern',
          'ubiquitous',
          '--system',
          'system',
          '--response',
          'do a',
        ])
      ).stdout,
    ) as { data: { id: string } }
    const b = lastJson(
      (
        await runCli([
          'add',
          docPath,
          '--pattern',
          'ubiquitous',
          '--system',
          'system',
          '--response',
          'do b',
        ])
      ).stdout,
    ) as { data: { id: string } }

    const { stdout, code } = await runCli(['derive', '--file', docPath, a.data.id, b.data.id])
    expect(code).toBe(0)
    const env = lastJson(stdout) as { type: string; data: { added: boolean } }
    expect(env.type).toBe('derive')
    expect(env.data.added).toBe(true)

    // The edge is persisted: show the source and confirm the derives array.
    const shown = lastJson((await runCli(['show', '--file', docPath, a.data.id])).stdout) as {
      data: { requirement: { derives: string[] } }
    }
    expect(shown.data.requirement.derives).toContain(b.data.id)
  })
})

describe('CLI integration — edge commands accept a stable key wherever a UUID works', () => {
  // `keyDescription` (core/schema.ts) promises every id-taking command accepts a
  // key wherever it accepts a UUID, and `apply`'s batch AddRelationship op has
  // always honored that. The single-command edge surface did not: it validated the
  // SOURCE through requireRequirement (which resolves keys) and then passed the
  // RAW refs to applyChange, whose ChangeSchema demands UUIDs — so `derive G1 S3`
  // died with a raw Zod uuid-format dump and an empty suggestions array, and
  // `remove-edge` never resolved either endpoint. Both endpoints of all five
  // commands now resolve before applyChange sees them.
  async function seedTwo(): Promise<void> {
    await runCli(['init', docPath])
    for (const [key, response] of [
      ['G1', 'issue a token'],
      ['S3', 'log the event'],
    ] as const) {
      await runCli([
        'add',
        docPath,
        '--key',
        key,
        '--pattern',
        'ubiquitous',
        '--system',
        'system',
        '--response',
        response,
      ])
    }
  }

  for (const type of ['derive', 'satisfy', 'verify', 'refine'] as const) {
    it(`\`${type}\` resolves both endpoints from stable keys`, async () => {
      await seedTwo()
      const { stdout, code } = await runCli([type, '--file', docPath, 'G1', 'S3'])
      expect(code).toBe(0)
      const env = lastJson(stdout) as {
        type: string
        data: { from: string; to: string; added: boolean }
      }
      expect(env.type).toBe(type)
      expect(env.data.added).toBe(true)
      // The envelope reports RESOLVED UUIDs, never the keys it was handed.
      expect(env.data.from).toMatch(/^[0-9a-f-]{36}$/)
      expect(env.data.to).toMatch(/^[0-9a-f-]{36}$/)
    })
  }

  it('`remove-edge` resolves both endpoints from stable keys', async () => {
    await seedTwo()
    expect((await runCli(['derive', '--file', docPath, 'G1', 'S3'])).code).toBe(0)

    const { stdout, code } = await runCli(['remove-edge', '--file', docPath, 'G1', 'derives', 'S3'])
    expect(code).toBe(0)
    const env = lastJson(stdout) as { type: string; data: { removed: boolean } }
    expect(env.type).toBe('remove-edge')
    expect(env.data.removed).toBe(true)

    const shown = lastJson((await runCli(['show', '--file', docPath, 'G1'])).stdout) as {
      data: { requirement: { derives: string[] } }
    }
    expect(shown.data.requirement.derives).toEqual([])
  })

  it('an unknown ref gives ERR_NOT_FOUND with an actionable suggestion, not a Zod dump', async () => {
    await seedTwo()
    const { stdout, code } = await runCli(['derive', '--file', docPath, 'G1', 'NOPE'])
    expect(code).not.toBe(0)
    const env = lastJson(stdout) as { code: string; error: string; suggestions: string[] }
    expect(env.code).toBe('ERR_NOT_FOUND')
    expect(env.error).toContain('NOPE')
    // The defect surfaced a raw Zod issue array and no suggestions at all.
    expect(env.error).not.toContain('invalid_format')
    expect(env.suggestions.length).toBeGreaterThan(0)
  })
})
