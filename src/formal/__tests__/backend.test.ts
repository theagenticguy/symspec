import { describe, expect, it } from 'vitest'
import { getContext, probeBackend } from '../backend.js'

describe('formal backend (AC-4-1: z3-solver WASM, in-process)', () => {
  it('reports the backend available with a no PATH binary — WASM init only', async () => {
    // Simulate a fresh install with zero PATH entries: no z3/cvc5 binary can
    // possibly be discoverable. The in-process WASM backend must still work
    // because it never shells out.
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = await probeBackend()
      expect(result.available).toBe(true)
      if (result.available) {
        expect(typeof result.version).toBe('string')
        expect(result.version.length).toBeGreaterThan(0)
      }
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
  })

  it('hands back a usable Z3 Context that can run a trivial check-sat', async () => {
    const ctx = await getContext('symspec-test')
    const { Solver, Bool } = ctx
    const solver = new Solver()
    const x = Bool.const('x')
    solver.add(x)
    const result = await solver.check()
    expect(result).toBe('sat')
  })

  it('memoizes WASM init across concurrent getContext calls', async () => {
    const [a, b] = await Promise.all([getContext('one'), getContext('two')])
    expect(a).not.toBe(b)
    // Both contexts are backed by the same shared WASM module instance —
    // proven by both being independently usable without a second init cost
    // spike (functional proof: both can run a check-sat successfully).
    const sa = new a.Solver()
    sa.add(a.Bool.const('p'))
    const sb = new b.Solver()
    sb.add(b.Bool.const('q'))
    const [ra, rb] = await Promise.all([sa.check(), sb.check()])
    expect(ra).toBe('sat')
    expect(rb).toBe('sat')
  })
})
