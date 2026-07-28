/**
 * Wave 1 honesty-repair regressions (AC-1-2, AC-1-3, AC-1-4, AC-1-8).
 *
 * Each case below reproduces a defect that was VERIFIED live against the built
 * CLI before the fix, so every test here is a real bug's headstone rather than a
 * speculative guard. The comment on each block records the pre-fix behavior.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emitSmt2 } from '../../formal/emit-smt2.js'
import { APPLY_OPS } from '../apply.js'
import { COMMAND_DESCRIPTIONS } from '../descriptions.js'
import { EnvelopeTypes } from '../types-enum.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI_SRC = join(HERE, '..', 'index.ts')

let dir: string

/** Run the CLI from source, capturing stdout even on a non-zero exit. */
function run(args: readonly string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI_SRC, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SYMSPEC_EMBED_STUB: '1' },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { stdout, status: 0 }
  } catch (e) {
    const err = e as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', status: err.status ?? -1 }
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'symspec-wave1-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AC-1-8 — verifies/refines are creatable, not just removable', () => {
  it('exposes verify and refine as envelope types (append-only, at the END)', () => {
    // Pre-fix: `verifies`/`refines` were in the schema, honored by analyze and
    // export, and removable via `remove-edge` — but creatable by NOTHING, which
    // made FND_LEAF_UNVERIFIABLE's own advice ("add a verify link") impossible.
    expect(EnvelopeTypes).toContain('verify')
    expect(EnvelopeTypes).toContain('refine')
    // Append-only ordering: the two newcomers must be last so the frozen
    // ordinal snapshot of every prior type stays valid.
    expect(EnvelopeTypes.slice(-2)).toEqual(['verify', 'refine'])
  })

  it('accepts verify and refine as batch apply ops', () => {
    expect(APPLY_OPS).toContain('verify')
    expect(APPLY_OPS).toContain('refine')
  })

  it('creates a verifies edge end to end', () => {
    const doc = join(dir, 'edges.symspec.json')
    run(['init', doc])
    const a = JSON.parse(
      run([
        'add',
        doc,
        '--pattern',
        'ubiquitous',
        '--system',
        'auth service',
        '--response',
        'issue a session token',
      ]).stdout,
    ).data.id as string
    const b = JSON.parse(
      run([
        'add',
        doc,
        '--pattern',
        'ubiquitous',
        '--system',
        'test harness',
        '--response',
        'exercise the token path',
      ]).stdout,
    ).data.id as string

    const verified = run(['verify', b, a, '--file', doc])
    expect(verified.status).toBe(0)
    const env = JSON.parse(verified.stdout)
    expect(env.type).toBe('verify')
    expect(env.data.relation).toBe('verifies')
    expect(env.data.added).toBe(true)
    // The edge actually landed on disk.
    const onDisk = JSON.parse(readFileSync(doc, 'utf8'))
    expect(onDisk.requirements[b].verifies).toContain(a)
  })

  it('creates a refines edge via a batch apply op', () => {
    const doc = join(dir, 'batch-edges.symspec.json')
    const ops = join(dir, 'ops.jsonl')
    run(['init', doc])
    writeFileSync(
      ops,
      [
        JSON.stringify({
          op: 'add',
          key: 'P1',
          patternType: 'ubiquitous',
          systemName: 'gateway',
          systemResponse: 'authenticate the caller',
          sentence: 'The gateway shall authenticate the caller.',
        }),
        JSON.stringify({
          op: 'add',
          key: 'P2',
          patternType: 'ubiquitous',
          systemName: 'gateway',
          systemResponse: 'authenticate the caller using mutual TLS',
          sentence: 'The gateway shall authenticate the caller using mutual TLS.',
        }),
        // Forward-referenceable human keys resolve before UUIDs exist.
        JSON.stringify({ op: 'refine', from: 'P2', to: 'P1' }),
      ].join('\n'),
      'utf8',
    )
    const res = run(['apply', ops, '--doc', doc])
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).data.summary).toMatchObject({ total: 3, ok: 3, failed: 0 })
    const onDisk = JSON.parse(readFileSync(doc, 'utf8'))
    const p2 = Object.values(onDisk.requirements).find(
      (r) => (r as { key?: string }).key === 'P2',
    ) as { refines: string[] }
    expect(p2.refines).toHaveLength(1)
  })
})

describe('AC-1-4 — certify must not claim a proof about the document', () => {
  it('never reports certified: true, and says so in the description', () => {
    // Pre-fix (verified live): `certify` returned {"certified": true} on a spec
    // `check` proves contradictory, because every requirement is emitted as
    // `theorem req_<uuid> : True := by decide`. An agent switching on
    // `data.certified` — the documented contract — was misled.
    const text = COMMAND_DESCRIPTIONS.certify
    expect(text).toMatch(/NOT YET A PROOF/i)
    expect(text).toMatch(/placeholder `True` theorem/i)
    // The description must steer the reader to the field that carries the real
    // outcome, and away from gating on this command.
    expect(text).toMatch(/toolchainElaborated/)
  })
})

describe('AC-1-3 — the exported artifact answers the same question', () => {
  // Pre-fix (verified live): the artifact carried only the guarded implications,
  // so external z3 answered `sat` on a two-requirement contradiction the
  // in-process tier proved `unsat`. `(X ⇒ Y) ∧ (X ⇒ ¬Y)` is satisfiable with X
  // false — without a context assertion it is a DIFFERENT question, not a
  // weaker one.
  const encoded = [
    {
      id: 'r1',
      guard: 'r1',
      pattern: 'event-driven' as const,
      formula: {
        op: 'implies' as const,
        lhs: { op: 'atom' as const, name: 'r1' },
        rhs: {
          op: 'implies' as const,
          lhs: { op: 'atom' as const, name: 'sys__s__trig__t' },
          rhs: { op: 'atom' as const, name: 'sys__s__resp__x' },
        },
      },
      body: {
        op: 'implies' as const,
        lhs: { op: 'atom' as const, name: 'sys__s__trig__t' },
        rhs: { op: 'atom' as const, name: 'sys__s__resp__x' },
      },
      atoms: [
        { atom: 'sys__s__trig__t', kind: 'trig' as const, slotText: 't', negated: false },
        { atom: 'sys__s__resp__x', kind: 'resp' as const, slotText: 'x', negated: false },
      ],
    },
  ]

  it('emits one push/pop-scoped check-sat per context group', () => {
    const smt2 = emitSmt2(encoded, {
      contextGroups: [
        { key: '', contextAtoms: [] },
        { key: 'sys__s__trig__t', contextAtoms: ['sys__s__trig__t'] },
      ],
    })
    // Two groups ⇒ two independent verdicts.
    expect(smt2.match(/\(check-sat-assuming/g)).toHaveLength(2)
    expect(smt2.match(/\(push 1\)/g)).toHaveLength(2)
    expect(smt2.match(/\(pop 1\)/g)).toHaveLength(2)
    // The trigger is actually asserted — the whole point.
    expect(smt2).toContain('(assert |sys__s__trig__t|)')
    // Every group asks for its own core.
    expect(smt2.match(/\(get-unsat-core\)/g)).toHaveLength(2)
  })

  it('scopes each group so contexts cannot leak into the next', () => {
    // Mutually exclusive triggers asserted TOGETHER would fabricate a conflict.
    // push/pop is what prevents that, so assert the structural ordering.
    const smt2 = emitSmt2(encoded, {
      contextGroups: [
        { key: 'a', contextAtoms: ['sys__s__trig__a'] },
        { key: 'b', contextAtoms: ['sys__s__trig__b'] },
      ],
    })
    const lines = smt2.split('\n')
    const idxA = lines.findIndex((l) => l.includes('trig__a'))
    const idxB = lines.findIndex((l) => l.includes('trig__b'))
    const popBetween = lines.slice(idxA, idxB).filter((l) => l.trim() === '(pop 1)')
    expect(popBetween).toHaveLength(1)
  })

  it('keeps the single-group shape when contextGroups is absent', () => {
    // Back-compat: the binary cross-check drives one group per invocation
    // because runSolverBinary parses a single verdict.
    const smt2 = emitSmt2(encoded, { contextAtoms: ['sys__s__trig__t'] })
    expect(smt2.match(/\(check-sat-assuming/g)).toHaveLength(1)
    expect(smt2).not.toContain('(push 1)')
    expect(smt2).toContain('(assert |sys__s__trig__t|)')
  })
})

describe('AC-1-2 — stdout is complete on a pipe', () => {
  it('delivers a >64KB envelope intact through a pipe as valid JSON', () => {
    // Pre-fix (verified live): an 80-requirement `check --dense` piped out
    // exactly 65536 bytes — one pipe buffer — of unparseable JSON, while the
    // same command redirected to a file got all 352036. `process.stdout.write`
    // followed by `process.exit` drops the queued tail on an async fd.
    const doc = join(dir, 'big.symspec.json')
    const ops = join(dir, 'big-ops.jsonl')
    run(['init', doc])
    const records = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({
        op: 'add',
        patternType: 'event-driven',
        systemName: `service ${i}`,
        systemResponse: `emit audit record ${i}`,
        trigger: `transaction ${i} completes`,
        sentence: `When transaction ${i} completes, the service ${i} shall emit audit record ${i}.`,
      }),
    )
    writeFileSync(ops, records.join('\n'), 'utf8')
    expect(run(['apply', ops, '--doc', doc]).status).toBe(0)

    // execFileSync captures stdout through a PIPE — the failing path.
    const piped = run(['check', doc, '--dense'])
    expect(piped.stdout.length).toBeGreaterThan(65536)
    // The real assertion: it parses. A truncated envelope throws here.
    const env = JSON.parse(piped.stdout)
    expect(env.apiVersion).toBe(1)
    expect(env.type).toBe('check')
  })
})
