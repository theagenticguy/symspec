/**
 * Envelope contract tests — the wire shape an agent parses.
 *
 * These assert the SHAPE, not the implementation: v4's
 * `{apiVersion,type,data}` / `{apiVersion,type:'error',error,code,suggestions,
 * partial?,repair?}` is preserved API, so a test here failing means an agent in
 * the field breaks.
 */

import { describe, expect, it } from 'vitest'
import {
  API_VERSION,
  type Envelope,
  failure,
  isErrorEnvelope,
  ok,
  renderEnvelope,
} from './envelope.ts'

describe('API_VERSION', () => {
  it('is the integer 1 — the envelope-contract version', () => {
    expect(API_VERSION).toBe(1)
  })
})

describe('ok() — success envelope', () => {
  it('is exactly {apiVersion, type, data} — no extra keys on the wire', () => {
    const env = ok('manifest', { operations: [] })
    expect(Object.keys(env).sort()).toEqual(['apiVersion', 'data', 'type'])
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('manifest')
    expect(env.data).toEqual({ operations: [] })
  })

  it('carries the operation type through as a literal in the TYPE, not just the value', () => {
    const env = ok('codeExplanation', { code: 'ERR_IO' })
    // Type-level: `env.type` is the literal 'codeExplanation', so a handler's
    // return type names its own discriminant.
    const t: 'codeExplanation' = env.type
    expect(t).toBe('codeExplanation')
  })

  it('passes an arbitrary data payload through untouched', () => {
    const payload = { nested: { deep: [1, 2, 3] }, nul: null }
    expect(ok('x', payload).data).toBe(payload)
  })
})

describe('failure() — error envelope', () => {
  it('is {apiVersion, type:"error", error, code, suggestions} at minimum', () => {
    const env = failure({ error: 'boom', code: 'ERR_IO' })
    expect(Object.keys(env).sort()).toEqual(['apiVersion', 'code', 'error', 'suggestions', 'type'])
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('error')
    expect(env.error).toBe('boom')
    expect(env.code).toBe('ERR_IO')
  })

  it('always presents suggestions, defaulting to [] so an agent never tests for the key', () => {
    expect(failure({ error: 'e', code: 'ERR_IO' }).suggestions).toEqual([])
    expect(failure({ error: 'e', code: 'ERR_IO', suggestions: ['a', 'b'] }).suggestions).toEqual([
      'a',
      'b',
    ])
  })

  it('names the message field `error` (v4 wire field), never `message`', () => {
    const env = failure({ error: 'the message', code: 'ERR_IO' })
    expect(env.error).toBe('the message')
    expect(env).not.toHaveProperty('message')
  })

  describe('optional keys are ABSENT, never undefined', () => {
    it('omits `partial` entirely when not supplied', () => {
      const env = failure({ error: 'e', code: 'ERR_IO' })
      expect('partial' in env).toBe(false)
      expect(JSON.stringify(env)).not.toContain('partial')
    })

    it('omits `partial` when supplied EMPTY (no information to carry)', () => {
      const env = failure({ error: 'e', code: 'ERR_IO', partial: {} })
      expect('partial' in env).toBe(false)
    })

    it('includes `partial` when it recovered something', () => {
      const env = failure({
        error: 'e',
        code: 'ERR_PARSE_AMBIGUOUS_CLAUSES',
        partial: { systemName: 'the gateway' },
      })
      expect(env.partial).toEqual({ systemName: 'the gateway' })
    })

    it('omits `repair` entirely when not supplied', () => {
      const env = failure({ error: 'e', code: 'ERR_IO' })
      expect('repair' in env).toBe(false)
      expect(JSON.stringify(env)).not.toContain('repair')
    })

    it('omits `repair` when both arrays are empty (meaningless remedy)', () => {
      const env = failure({ error: 'e', code: 'ERR_IO', repair: { ops: [], commands: [] } })
      expect('repair' in env).toBe(false)
    })
  })

  /**
   * AC-A-9 — `repair: {ops, commands}` exists from day one. The PRODUCERS land
   * in G3, but the field and its plumbing ship now so no agent has to negotiate
   * an envelope-shape change later.
   */
  describe('repair (AC-A-9) — structured remedy present from day one', () => {
    it('carries ops-only repair', () => {
      const env = failure({
        error: 'compound requirement',
        code: 'ERR_PARSE_COMPOUND',
        repair: { ops: [{ op: 'add', systemResponse: 'a' }], commands: [] },
      })
      expect(env.repair).toEqual({ ops: [{ op: 'add', systemResponse: 'a' }], commands: [] })
    })

    it('carries commands-only repair', () => {
      const env = failure({
        error: 'no solver',
        code: 'ERR_SOLVER_MISSING',
        repair: { ops: [], commands: ['mise use github:Z3Prover/z3@z3-4.16.0'] },
      })
      expect(env.repair?.commands).toEqual(['mise use github:Z3Prover/z3@z3-4.16.0'])
      expect(env.repair?.ops).toEqual([])
    })

    it('survives a JSON round-trip with both arrays intact', () => {
      const env = failure({
        error: 'e',
        code: 'ERR_IO',
        repair: { ops: [{ op: 'add' }, { op: 'link' }], commands: ['symspec init doc.json'] },
      })
      const round = JSON.parse(renderEnvelope(env)) as typeof env
      expect(round.repair).toEqual(env.repair)
    })
  })
})

describe('isErrorEnvelope()', () => {
  it('is true for the error branch and false for every success', () => {
    expect(isErrorEnvelope(failure({ error: 'e', code: 'ERR_IO' }))).toBe(true)
    expect(isErrorEnvelope(ok('manifest', {}))).toBe(false)
    // A success whose type merely CONTAINS 'error' is still a success.
    expect(isErrorEnvelope(ok('errorReport', { findings: [] }))).toBe(false)
  })

  it('narrows both branches at the type level', () => {
    const env: Envelope = ok('x', { n: 1 })
    if (isErrorEnvelope(env)) {
      // Narrowed to ErrorEnvelope: `code` is reachable.
      expect(typeof env.code).toBe('string')
    } else {
      // Narrowed to OkEnvelope: `data` is reachable WITHOUT a cast. This is the
      // property that `exitCodeForEnvelope` depends on.
      expect(env.data).toEqual({ n: 1 })
    }
  })
})

describe('renderEnvelope()', () => {
  it('is one line of compact JSON — no pretty-printing, no trailing newline', () => {
    const line = renderEnvelope(ok('manifest', { operations: [] }))
    expect(line).toBe('{"apiVersion":1,"type":"manifest","data":{"operations":[]}}')
    expect(line).not.toContain('\n')
  })

  it('round-trips a success envelope byte-for-byte', () => {
    const env = ok('codeExplanation', { code: 'ERR_IO', description: 'x' })
    expect(renderEnvelope(JSON.parse(renderEnvelope(env)) as Envelope)).toBe(renderEnvelope(env))
  })

  it('renders the error envelope with keys in the documented order', () => {
    const line = renderEnvelope(failure({ error: 'boom', code: 'ERR_IO', suggestions: ['s'] }))
    expect(line).toBe(
      '{"apiVersion":1,"type":"error","error":"boom","code":"ERR_IO","suggestions":["s"]}',
    )
  })
})
