/**
 * The three G1 operations, tested through the kernel rather than through the
 * process. The SHIPPED-BUNDLE behavior (real argv, real exit codes, real streams)
 * is covered separately by the drift/CLI suite, which spawns `dist/cli.mjs`.
 */

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { API_VERSION } from '../kernel/envelope.ts'
import { ERR_CODES, errCodeCatalog, toErrorEnvelope } from '../kernel/errors.ts'
import { exitCodeForEnvelope } from '../kernel/exit.ts'
import { runOperation } from '../kernel/operation.ts'
import { VERSION } from '../kernel/version.ts'
import {
  allOperations,
  currentManifest,
  explainOp,
  manifestOp,
  OPERATIONS,
  versionOp,
} from './index.ts'

describe('the table', () => {
  /**
   * Pins the shipped operation set and its ORDER, since the order is what `--help`
   * and the manifest present to a reader — the document lifecycle first, then the
   * self-description operations an agent uses to orient.
   *
   * This is a deliberate snapshot, not a coincidence: adding an operation is
   * supposed to require exactly one edit to `OPERATIONS`, and this test makes that
   * edit visible in review rather than letting the agent-facing surface grow
   * silently.
   */
  it('holds the shipped operations, in presentation order', () => {
    expect(OPERATIONS.map((op) => op.name)).toEqual([
      'init',
      'import',
      // G2b: `parse` sits with the document lifecycle rather than with the analysis
      // ops, because it is where a document COMES FROM — prose in, apply-ready ops
      // out. It reads no document and writes none.
      'parse',
      'list',
      'show',
      // G2a: `check`, the operation the tool exists for, placed after the document
      // lifecycle and before the self-description ops.
      'check',
      'manifest',
      'explain',
      'version',
    ])
  })

  it('gives every operation a name, a summary and a non-error type', () => {
    for (const op of allOperations()) {
      expect(op.name).toMatch(/^[a-z][a-z-]*$/)
      expect(op.summary.length).toBeGreaterThan(0)
      expect(op.type.length).toBeGreaterThan(0)
      // `'error'` is the failure envelope's reserved discriminant.
      expect(op.type).not.toBe('error')
    }
  })

  it('has unique names and unique success types', () => {
    const names = allOperations().map((op) => op.name)
    const types = allOperations().map((op) => op.type)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(types).size).toBe(types.length)
  })
})

describe('manifest', () => {
  it('emits a success envelope typed `manifest`', async () => {
    const env = await Effect.runPromise(runOperation(manifestOp, {}))
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('manifest')
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('describes ITSELF — the table can project its own row', () => {
    const names = currentManifest().operations.map((op) => op.name)
    expect(names).toContain('manifest')
    expect(names).toEqual([...OPERATIONS.map((op) => op.name)])
  })

  it('publishes each operation summary verbatim from the table', () => {
    for (const row of currentManifest().operations) {
      const op = allOperations().find((o) => o.name === row.name)
      expect(row.summary).toBe(op?.summary)
    }
  })

  it('publishes the version and the envelope apiVersion', () => {
    const m = currentManifest()
    expect(m.version).toBe(VERSION)
    expect(m.apiVersion).toBe(API_VERSION)
  })

  it('publishes all four exit codes with meanings', () => {
    expect(currentManifest().exitCodes.map((e) => e.code)).toEqual([0, 1, 2, 3])
    for (const row of currentManifest().exitCodes) {
      expect(row.meaning.length).toBeGreaterThan(0)
    }
  })

  it('publishes all 21 error codes, single-sourced from the catalog', () => {
    expect(currentManifest().errorCodes).toEqual([...errCodeCatalog()])
    expect(currentManifest().errorCodes.map((e) => e.code)).toEqual([...ERR_CODES])
  })

  it('publishes an honest input schema for every operation', () => {
    for (const row of currentManifest().operations) {
      // Never the object-or-array lowering an empty struct produces raw.
      expect(JSON.stringify(row.input)).not.toContain('"array"')
      expect(row.input).toMatchObject({ type: 'object' })
    }
  })

  it('is JSON-serializable and stable across calls', () => {
    expect(JSON.stringify(currentManifest())).toBe(JSON.stringify(currentManifest()))
  })
})

describe('explain — success', () => {
  it('explains a known code with meaning and suggestions', async () => {
    const env = await Effect.runPromise(runOperation(explainOp, { code: 'ERR_SOLVER_MISSING' }))
    expect(env.type).toBe('codeExplanation')
    expect(env.data.code).toBe('ERR_SOLVER_MISSING')
    expect(env.data.meaning).toContain('binary solver backend')
    expect(env.data.suggestions.length).toBeGreaterThan(0)
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('resolves EVERY code in the catalog', async () => {
    for (const code of ERR_CODES) {
      const env = await Effect.runPromise(runOperation(explainOp, { code }))
      expect(env.data.code).toBe(code)
      expect(env.data.description.length).toBeGreaterThan(0)
    }
  })
})

describe('explain — unknown code', () => {
  const run = (code: string) => Effect.runPromise(Effect.result(runOperation(explainOp, { code })))

  it('fails with ERR_NOT_FOUND and exit 2', async () => {
    const r = await run('ERR_BOGUS')
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.code).toBe('ERR_NOT_FOUND')
      expect(env.error).toContain('ERR_BOGUS')
      expect(exitCodeForEnvelope(env)).toBe(2)
    }
  })

  it('offers DID-YOU-MEAN suggestions for a near miss', async () => {
    const r = await run('ERR_SOLVER_MISSNG')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.suggestions.join(' ')).toContain('ERR_SOLVER_MISSING')
    }
  })

  it('always points at the manifest as the exhaustive list', async () => {
    const r = await run('TOTALLY_UNRELATED')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.suggestions.join(' ')).toContain('manifest')
    }
  })

  /** AC-A-9: the remedy is machine-actionable, not just prose. */
  it('carries a runnable repair command', async () => {
    const r = await run('ERR_SOLVER_MISSNG')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.repair?.commands).toEqual(['symspec explain --code ERR_SOLVER_MISSING'])
    }
  })

  it('falls back to `symspec manifest` when nothing is close', async () => {
    const r = await run('TOTALLY_UNRELATED')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.repair?.commands).toEqual(['symspec manifest'])
    }
  })

  it('is case-sensitive — a lowercase code is unknown, not silently coerced', async () => {
    const r = await run('err_io')
    expect(r._tag).toBe('Failure')
  })
})

describe('version', () => {
  it('reports the package version and the envelope apiVersion', async () => {
    const env = await Effect.runPromise(runOperation(versionOp, {}))
    expect(env.type).toBe('version')
    expect(env.data).toEqual({ version: VERSION, apiVersion: API_VERSION })
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('keeps the two version numbers independent', () => {
    // They answer different questions: one moves every release, the other only
    // on a breaking envelope change. Asserting they are different KINDS of value
    // guards against someone "simplifying" by making apiVersion the package one.
    expect(typeof VERSION).toBe('string')
    expect(typeof API_VERSION).toBe('number')
  })
})
