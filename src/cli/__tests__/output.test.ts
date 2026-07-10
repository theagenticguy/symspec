import { describe, expect, it } from 'vitest'
import { API_VERSION, failure, success } from '../envelope.js'
import { formatEnvelope, renderEnvelope, resolveOutputMode } from '../output.js'

/**
 * AC-6-2a: the typed JSON envelope is the DEFAULT output for every command with
 * no flags; `--pretty` (alias `--human`) opts into human prose; `--json` is a
 * no-op compatibility alias that produces byte-identical output to no flag.
 */

describe('resolveOutputMode (AC-6-2a)', () => {
  it('defaults to json with no flags', () => {
    expect(resolveOutputMode()).toBe('json')
    expect(resolveOutputMode({})).toBe('json')
  })

  it('treats --json as a no-op alias for the default json mode', () => {
    expect(resolveOutputMode({ json: true })).toBe('json')
  })

  it('selects pretty for --pretty and its --human alias', () => {
    expect(resolveOutputMode({ pretty: true })).toBe('pretty')
    expect(resolveOutputMode({ human: true })).toBe('pretty')
  })

  it('prefers pretty when both --json and --pretty are passed', () => {
    expect(resolveOutputMode({ json: true, pretty: true })).toBe('pretty')
  })
})

describe('zero-flag check emits a valid JSON envelope (AC-6-2a)', () => {
  it('renders the default success envelope as pretty-printed JSON', () => {
    const env = success('check', { findings: [] })
    const out = formatEnvelope(env)
    const parsed = JSON.parse(out) as typeof env
    expect(parsed.apiVersion).toBe(API_VERSION)
    expect(parsed.type).toBe('check')
    expect(parsed.data).toEqual({ findings: [] })
  })

  it('the default json output is 2-space pretty-printed', () => {
    const env = success('check', { findings: [] })
    expect(formatEnvelope(env)).toBe(JSON.stringify(env, null, 2))
  })
})

describe('--json produces byte-identical output to no flag (AC-6-2a)', () => {
  it('success envelope', () => {
    const env = success('list', [{ id: 'a' }, { id: 'b' }])
    expect(formatEnvelope(env, { json: true })).toBe(formatEnvelope(env))
  })

  it('error envelope', () => {
    const env = failure({ error: 'no doc', code: 'ERR_DOC_NOT_FOUND', suggestions: ['init it'] })
    expect(formatEnvelope(env, { json: true })).toBe(formatEnvelope(env))
  })
})

describe('--pretty produces human prose, not JSON (AC-6-2a)', () => {
  it('success prose is not valid JSON and mentions the type', () => {
    const env = success('check', { findings: [] })
    const prose = formatEnvelope(env, { pretty: true })
    expect(() => JSON.parse(prose)).toThrow()
    expect(prose).toContain('check')
    expect(prose).toContain(String(API_VERSION))
  })

  it('--human is the same prose as --pretty', () => {
    const env = success('show', { id: 'abc', priority: 'high' })
    expect(formatEnvelope(env, { human: true })).toBe(formatEnvelope(env, { pretty: true }))
  })

  it('error prose surfaces the code, message, and suggestions', () => {
    const env = failure({
      error: 'no such document',
      code: 'ERR_DOC_NOT_FOUND',
      suggestions: ['create it with `symspec init`'],
    })
    const prose = formatEnvelope(env, { pretty: true })
    expect(() => JSON.parse(prose)).toThrow()
    expect(prose).toContain('ERR_DOC_NOT_FOUND')
    expect(prose).toContain('no such document')
    expect(prose).toContain('create it with `symspec init`')
  })

  it('renders nested data payloads without throwing', () => {
    const env = success('analyze', {
      findings: [{ code: 'FND_X', ids: ['a', 'b'], evidence: { atoms: ['p', 'q'] } }],
      counts: { error: 0, warn: 1 },
    })
    const prose = formatEnvelope(env, { pretty: true })
    expect(prose).toContain('findings')
    expect(prose).toContain('FND_X')
    expect(prose).toContain('counts')
  })
})

describe('renderEnvelope mode default (AC-6-2a)', () => {
  it('defaults to json when no mode is given', () => {
    const env = success('parse', { patternType: 'ubiquitous' })
    expect(renderEnvelope(env)).toBe(JSON.stringify(env, null, 2))
  })
})
