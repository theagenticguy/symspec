import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_VERSION, ErrorEnvelopeSchema } from '../envelope.js'
import {
  DEFAULT_DOC_PATH,
  DOC_ENV_VAR,
  DocResolveError,
  docNotFoundEnvelope,
  resolveDoc,
  resolveDocPath,
} from '../resolve-doc.js'

/**
 * AC-6-6: document path resolves positional `<file>` → `SYMSPEC_DOC` env →
 * default `./requirements.json`, unified across commands; a resolved-but-
 * nonexistent path returns ERR_DOC_NOT_FOUND with `symspec init` /
 * `SYMSPEC_DOC` suggestions.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symspec-resolve-doc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveDocPath precedence (AC-6-6)', () => {
  it('positional wins over env and default', () => {
    const resolved = resolveDocPath({
      positional: 'from-arg.json',
      env: { [DOC_ENV_VAR]: 'from-env.json' },
      cwd: dir,
    })
    expect(resolved.source).toBe('positional')
    expect(resolved.path).toBe(resolve(dir, 'from-arg.json'))
  })

  it('SYMSPEC_DOC wins when no positional is supplied', () => {
    const resolved = resolveDocPath({
      env: { [DOC_ENV_VAR]: 'from-env.json' },
      cwd: dir,
    })
    expect(resolved.source).toBe('env')
    expect(resolved.path).toBe(resolve(dir, 'from-env.json'))
  })

  it('falls back to the default ./requirements.json when nothing is supplied', () => {
    const resolved = resolveDocPath({ env: {}, cwd: dir })
    expect(resolved.source).toBe('default')
    expect(resolved.path).toBe(resolve(dir, DEFAULT_DOC_PATH))
    expect(resolved.path.endsWith('requirements.json')).toBe(true)
  })

  it('treats an empty positional as absent and falls through to env', () => {
    const resolved = resolveDocPath({
      positional: '',
      env: { [DOC_ENV_VAR]: 'from-env.json' },
      cwd: dir,
    })
    expect(resolved.source).toBe('env')
  })

  it('treats a whitespace-only SYMSPEC_DOC as absent and falls through to default', () => {
    const resolved = resolveDocPath({ env: { [DOC_ENV_VAR]: '   ' }, cwd: dir })
    expect(resolved.source).toBe('default')
  })

  it('keeps absolute paths untouched', () => {
    const abs = join(dir, 'nested', 'doc.json')
    const resolved = resolveDocPath({ positional: abs, cwd: '/somewhere/else' })
    expect(resolved.path).toBe(abs)
    expect(resolved.source).toBe('positional')
  })

  it('reads SYMSPEC_DOC from process.env by default', () => {
    const prev = process.env[DOC_ENV_VAR]
    process.env[DOC_ENV_VAR] = join(dir, 'ambient.json')
    try {
      const resolved = resolveDocPath({ cwd: dir })
      expect(resolved.source).toBe('env')
      expect(resolved.path).toBe(join(dir, 'ambient.json'))
    } finally {
      if (prev === undefined) delete process.env[DOC_ENV_VAR]
      else process.env[DOC_ENV_VAR] = prev
    }
  })
})

describe('resolveDoc existence gate (AC-6-6)', () => {
  it('returns the resolved path when the document exists', () => {
    const path = join(dir, 'requirements.json')
    writeFileSync(path, '{}\n')
    const resolved = resolveDoc({ env: {}, cwd: dir })
    expect(resolved).toEqual({ path, source: 'default' })
  })

  it('resolves an existing positional file', () => {
    const path = join(dir, 'custom.json')
    writeFileSync(path, '{}\n')
    const resolved = resolveDoc({ positional: 'custom.json', env: {}, cwd: dir })
    expect(resolved).toEqual({ path, source: 'positional' })
  })

  it('throws ERR_DOC_NOT_FOUND for a nonexistent positional path', () => {
    let caught: unknown
    try {
      resolveDoc({ positional: 'missing.json', env: {}, cwd: dir })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DocResolveError)
    const err = caught as DocResolveError
    expect(err.code).toBe('ERR_DOC_NOT_FOUND')
    expect(err.path).toBe(join(dir, 'missing.json'))
    expect(err.source).toBe('positional')
  })

  it('throws ERR_DOC_NOT_FOUND when SYMSPEC_DOC points at a missing file', () => {
    expect(() => resolveDoc({ env: { [DOC_ENV_VAR]: 'gone.json' }, cwd: dir })).toThrowError(
      DocResolveError,
    )
  })

  it('throws ERR_DOC_NOT_FOUND when the default path does not exist', () => {
    let caught: unknown
    try {
      resolveDoc({ env: {}, cwd: dir })
    } catch (err) {
      caught = err
    }
    const err = caught as DocResolveError
    expect(err.code).toBe('ERR_DOC_NOT_FOUND')
    expect(err.source).toBe('default')
  })

  it('treats a directory at the resolved path as not found', () => {
    // `dir` itself exists but is a directory, not a document.
    expect(() => resolveDoc({ positional: dir, env: {}, cwd: dir })).toThrowError(DocResolveError)
  })

  it('carries the Appendix-A suggestions: symspec init and SYMSPEC_DOC', () => {
    let caught: DocResolveError | undefined
    try {
      resolveDoc({ env: {}, cwd: dir })
    } catch (err) {
      caught = err as DocResolveError
    }
    expect(caught).toBeDefined()
    const suggestions = caught?.suggestions.join('\n') ?? ''
    expect(suggestions).toContain('symspec init')
    expect(suggestions).toContain(DOC_ENV_VAR)
  })
})

describe('docNotFoundEnvelope (AC-6-6 → AC-6-2)', () => {
  function makeError(): DocResolveError {
    try {
      resolveDoc({ positional: 'nope.json', env: {}, cwd: dir })
    } catch (err) {
      return err as DocResolveError
    }
    throw new Error('expected resolveDoc to throw')
  }

  it('lifts the error into a valid typed error envelope', () => {
    const env = docNotFoundEnvelope(makeError())
    expect(() => ErrorEnvelopeSchema.parse(env)).not.toThrow()
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('error')
    expect(env.code).toBe('ERR_DOC_NOT_FOUND')
  })

  it('omits partial entirely (never a partial: undefined key)', () => {
    const env = docNotFoundEnvelope(makeError())
    expect('partial' in env).toBe(false)
  })

  it('round-trips through JSON with suggestions intact', () => {
    const env = docNotFoundEnvelope(makeError())
    const round = JSON.parse(JSON.stringify(env)) as typeof env
    expect(round).toEqual(env)
    expect(round.suggestions.length).toBeGreaterThan(0)
    expect(round.error).toContain('nope.json')
  })
})
