import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import {
  BinaryBackendError,
  discoverSolverBinary,
  probeSolverBinary,
  runSolverBinary,
} from '../binary-backend.js'
import { emitSmt2 } from '../emit-smt2.js'
import type { Atomize, EncodableRequirement } from '../encode.js'
import { encode } from '../encode.js'

/** A deterministic stand-in atomizer, mirroring the sibling emit-smt2 tests. */
const fakeAtomize: Atomize = (kind, slotText, systemName, negated) => ({
  atom: `sys__${systemName.replace(/\s+/g, '_')}__${kind}__${slotText.replace(/\s+/g, '_')}`,
  negated,
})

const req = (overrides: Partial<EncodableRequirement>): EncodableRequirement => ({
  id: 'REQ-1',
  patternType: 'ubiquitous',
  systemName: 'auth_service',
  systemResponse: 'issue a session token',
  sentence: '',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

/** True if `z3` is discoverable on PATH — the cross-check smoke degrades to a skip otherwise. */
function z3Available(): boolean {
  try {
    execFileSync('z3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A bare-minimum env (no PATH at all) so no real binary can possibly be discoverable. */
const NO_BINARY_ENV: NodeJS.ProcessEnv = {}

describe('discoverSolverBinary — discovery order (AC-4-9)', () => {
  it('honors an explicit --solver-path over everything else', () => {
    if (!z3Available()) return
    const resolved = discoverSolverBinary({ solverPath: 'z3', env: process.env })
    expect(resolved.source).toBe('solver-path')
    expect(resolved.bin).toBe('z3')
    expect(resolved.kind).toBe('z3')
    expect(resolved.version.length).toBeGreaterThan(0)
  })

  it('throws ERR_SOLVER_MISSING (not falling through to PATH) when --solver-path is bogus', () => {
    // A bogus --solver-path is an operator misconfiguration, not a cue to try
    // SYMSPEC_Z3/PATH — the first *supplied* source is authoritative.
    expect(() =>
      discoverSolverBinary({
        solverPath: '/definitely/not/a/real/solver/binary-xyz',
        env: process.env,
      }),
    ).toThrow(BinaryBackendError)
  })

  it('falls back to SYMSPEC_Z3 when no --solver-path is supplied', () => {
    if (!z3Available()) return
    const resolved = discoverSolverBinary({ env: { ...process.env, SYMSPEC_Z3: 'z3' } })
    expect(resolved.source).toBe('SYMSPEC_Z3')
    expect(resolved.bin).toBe('z3')
  })

  it('throws ERR_SOLVER_MISSING (not falling through to PATH) when SYMSPEC_Z3 is bogus', () => {
    expect(() =>
      discoverSolverBinary({
        env: { ...process.env, SYMSPEC_Z3: '/definitely/not/a/real/solver/binary-xyz' },
      }),
    ).toThrow(BinaryBackendError)
  })

  it('falls back to PATH (z3 then cvc5) when neither --solver-path nor SYMSPEC_Z3 is supplied', () => {
    if (!z3Available()) return
    const resolved = discoverSolverBinary({ env: process.env })
    expect(resolved.source).toBe('PATH')
    expect(resolved.bin).toBe('z3')
  })

  it('throws ERR_SOLVER_MISSING with the exact mise install suggestion when nothing resolves', () => {
    let threw: unknown
    try {
      discoverSolverBinary({ env: NO_BINARY_ENV })
    } catch (err) {
      threw = err
    }
    expect(threw).toBeInstanceOf(BinaryBackendError)
    const err = threw as BinaryBackendError
    expect(err.code).toBe('ERR_SOLVER_MISSING')
    expect(err.suggestions).toEqual(
      expect.arrayContaining([expect.stringContaining('mise use github:Z3Prover/z3@z3-4.16.0')]),
    )
  })
})

describe('probeSolverBinary — non-throwing sibling (AC-6-14 manifest support)', () => {
  it('reports available:true with a resolved path/version when a binary is present', () => {
    if (!z3Available()) return
    const result = probeSolverBinary({ env: process.env })
    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.bin).toBe('z3')
      expect(result.version.length).toBeGreaterThan(0)
    }
  })

  it('reports available:false (never throws) when no binary is discoverable', () => {
    const result = probeSolverBinary({ env: NO_BINARY_ENV })
    expect(result.available).toBe(false)
    if (!result.available) {
      expect(result.error.length).toBeGreaterThan(0)
    }
  })
})

describe.runIf(z3Available())(
  'runSolverBinary — cross-check reproduces the WASM verdict (AC-4-9 smoke)',
  () => {
    it('unsat + core reproduces the in-process WASM verdict for a planted 2-way conflict', async () => {
      const r1 = encode(
        req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x', systemResponse: 'y' }),
        fakeAtomize,
      )
      const r2 = encode(
        req({
          id: 'REQ-002',
          patternType: 'event-driven',
          trigger: 'x',
          systemResponse: 'y',
          negated: true,
        }),
        fakeAtomize,
      )
      const smt2 = emitSmt2([r1, r2], { contextAtoms: ['sys__auth_service__trig__x'] })

      // In-process WASM verdict (the ground truth this cross-check must reproduce).
      const ctx = await getContext('symspec-binary-backend-crosscheck')
      const solver = new ctx.Solver()
      const g1 = ctx.Bool.const('REQ-001')
      const g2 = ctx.Bool.const('REQ-002')
      solver.add(
        ctx.Implies(
          g1,
          ctx.Implies(
            ctx.Bool.const('sys__auth_service__trig__x'),
            ctx.Bool.const('sys__auth_service__resp__y'),
          ),
        ),
      )
      solver.add(
        ctx.Implies(
          g2,
          ctx.Implies(
            ctx.Bool.const('sys__auth_service__trig__x'),
            ctx.Not(ctx.Bool.const('sys__auth_service__resp__y')),
          ),
        ),
      )
      solver.add(ctx.Bool.const('sys__auth_service__trig__x'))
      const wasmVerdict = await solver.check(g1, g2)
      expect(wasmVerdict).toBe('unsat')

      // Binary cross-check against the exact same emitted artifact.
      const discovered = discoverSolverBinary({ env: process.env })
      const binaryResult = runSolverBinary(smt2, discovered)

      expect(binaryResult.status).toBe(wasmVerdict)
      expect(binaryResult.core.sort()).toEqual(['REQ-001', 'REQ-002'])
    })

    it('sat verdict reproduces the in-process WASM verdict for a consistent spec', async () => {
      const r1 = encode(
        req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x', systemResponse: 'y' }),
        fakeAtomize,
      )
      const smt2 = emitSmt2([r1], { contextAtoms: ['sys__auth_service__trig__x'] })

      const ctx = await getContext('symspec-binary-backend-crosscheck-sat')
      const solver = new ctx.Solver()
      const g1 = ctx.Bool.const('REQ-001')
      solver.add(
        ctx.Implies(
          g1,
          ctx.Implies(
            ctx.Bool.const('sys__auth_service__trig__x'),
            ctx.Bool.const('sys__auth_service__resp__y'),
          ),
        ),
      )
      solver.add(ctx.Bool.const('sys__auth_service__trig__x'))
      const wasmVerdict = await solver.check(g1)
      expect(wasmVerdict).toBe('sat')

      const discovered = discoverSolverBinary({ env: process.env })
      const binaryResult = runSolverBinary(smt2, discovered)
      expect(binaryResult.status).toBe(wasmVerdict)
      expect(binaryResult.core).toEqual([])
    })
  },
)
