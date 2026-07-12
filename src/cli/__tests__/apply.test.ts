import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { runApply } from '../apply.js'
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from '../envelope.js'

/**
 * Wishlist #1: batch `apply` folds a JSONL op stream in one process and one
 * save. Atomic by default (any error → nothing written + failing op index),
 * `--continue-on-error` best-effort. Requirement refs resolve by stable key or
 * UUID, and an `add` op's key is referenceable by LATER ops in the same batch.
 */

const jsonl = (...ops: object[]): string => ops.map((o) => JSON.stringify(o)).join('\n')

describe('apply — happy path with intra-batch key references', () => {
  it('adds by key then references that key in later ops, one save', () => {
    const doc = emptyDoc()
    const text = jsonl(
      {
        op: 'add',
        key: 'G1',
        patternType: 'ubiquitous',
        systemName: 'auth service',
        systemResponse: 'log every attempt',
      },
      {
        op: 'add',
        key: 'S3',
        patternType: 'ubiquitous',
        systemName: 'auth service',
        systemResponse: 'store the audit record',
      },
      { op: 'update', ref: 'G1', attr: 'status', value: 'approved' },
      { op: 'derive', from: 'G1', to: 'S3' },
    )
    const res = runApply(doc, text)
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.summary).toEqual({ total: 4, ok: 4, failed: 0 })
    }
    // Both requirements exist; G1 is approved and derives S3.
    const reqs = Object.values(res.next.requirements)
    const g1 = reqs.find((r) => r.key === 'G1')
    const s3 = reqs.find((r) => r.key === 'S3')
    expect(g1?.status).toBe('approved')
    expect(s3).toBeDefined()
    expect(g1?.derives).toContain(s3?.id)
  })

  it('skips blank lines and #-comments', () => {
    const doc = emptyDoc()
    const text = [
      '# a comment',
      '',
      JSON.stringify({
        op: 'add',
        key: 'G1',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do a',
      }),
      '   ',
    ].join('\n')
    const res = runApply(doc, text)
    expect('next' in res).toBe(true)
    if ('next' in res && res.envelope.type !== 'error') {
      expect(res.envelope.data.summary.total).toBe(1)
    }
  })
})

describe('apply — atomic by default', () => {
  it('aborts on the first failing op and writes nothing', () => {
    const doc = emptyDoc()
    const text = jsonl(
      {
        op: 'add',
        key: 'G1',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do a',
      },
      { op: 'update', ref: 'NOPE', attr: 'status', value: 'approved' }, // unknown ref
      {
        op: 'add',
        key: 'G2',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do b',
      },
    )
    const res = runApply(doc, text)
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(res.envelope.code).toBe('ERR_NOT_FOUND')
      // Names the failing op index (1) so the caller can fix the exact line.
      expect(res.envelope.error).toContain('op 1')
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })

  it('an invalid JSON line aborts atomically', () => {
    const doc = emptyDoc()
    const text = [
      '{ not json',
      JSON.stringify({
        op: 'add',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do a',
      }),
    ].join('\n')
    const res = runApply(doc, text)
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
  })

  it('does not mutate the input document on abort', () => {
    const doc = emptyDoc()
    runApply(doc, jsonl({ op: 'delete', ref: 'NOPE' }))
    expect(Object.keys(doc.requirements)).toHaveLength(0)
  })
})

describe('apply — continue-on-error', () => {
  it('applies the ops that succeed, tallies failures, and saves once', () => {
    const doc = emptyDoc()
    const text = jsonl(
      {
        op: 'add',
        key: 'G1',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do a',
      },
      { op: 'update', ref: 'NOPE', attr: 'status', value: 'approved' }, // fails
      {
        op: 'add',
        key: 'G2',
        patternType: 'ubiquitous',
        systemName: 'svc',
        systemResponse: 'do b',
      },
    )
    const res = runApply(doc, text, { continueOnError: true })
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.summary).toEqual({ total: 3, ok: 2, failed: 1 })
      const failed = res.envelope.data.results.find((r) => !r.ok)
      expect(failed?.index).toBe(1)
      expect(failed?.code).toBe('ERR_NOT_FOUND')
    }
    // Both adds landed.
    expect(Object.keys(res.next.requirements)).toHaveLength(2)
  })

  it('a run with zero successful ops writes nothing but reports failures', () => {
    const doc = emptyDoc()
    const res = runApply(doc, jsonl({ op: 'delete', ref: 'NOPE' }), { continueOnError: true })
    expect('next' in res).toBe(false)
    if (res.envelope.type !== 'error') {
      expect(res.envelope.data.summary.ok).toBe(0)
    }
  })
})

describe('apply — usage errors', () => {
  it('empty / comment-only input is ERR_USAGE', () => {
    const res = runApply(emptyDoc(), '# nothing here\n\n')
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })

  it('an unknown op verb is a per-op ERR_USAGE', () => {
    const res = runApply(emptyDoc(), jsonl({ op: 'frobnicate', ref: 'x' }))
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })
})
