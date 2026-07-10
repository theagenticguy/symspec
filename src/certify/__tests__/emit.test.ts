import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitLeanFile, type LeanTheoremSpec, sanitizeLeanName } from '../emit.js'

/** True if `lean` is discoverable on PATH — the smoke test degrades to a skip otherwise. */
function leanAvailable(): boolean {
  try {
    execFileSync('lean', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('emitLeanFile', () => {
  it('is pure/deterministic for identical input', () => {
    const theorems: LeanTheoremSpec[] = [
      { name: 't1', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
    ]
    expect(emitLeanFile(theorems)).toBe(emitLeanFile(theorems))
  })

  it('imports nothing for decide/omega/grind-only files', () => {
    const out = emitLeanFile([
      { name: 't1', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
      {
        name: 't2',
        statement: 'a + b ≥ 0',
        tactic: 'omega',
        binders: '(a b : Nat) (h : a ≤ 10)',
      },
      { name: 't3', statement: 'True', tactic: 'grind' },
    ])
    expect(out).not.toContain('import')
  })

  it('imports Std.Tactic.BVDecide exactly once when a bv_decide theorem is present', () => {
    const out = emitLeanFile([
      { name: 't1', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
      { name: 't2', statement: 'x + 0 = x', tactic: 'bv_decide', binders: '(x : BitVec 8)' },
      { name: 't3', statement: 'y = y', tactic: 'bv_decide', binders: '(y : BitVec 4)' },
    ])
    const occurrences = out.split('import Std.Tactic.BVDecide').length - 1
    expect(occurrences).toBe(1)
  })

  it('never imports Mathlib or emits a lakefile marker', () => {
    const out = emitLeanFile([
      { name: 't1', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
      { name: 't2', statement: 'x + 0 = x', tactic: 'bv_decide', binders: '(x : BitVec 8)' },
    ])
    expect(out).not.toMatch(/import Mathlib/)
    expect(out).not.toMatch(/import Lake/)
  })

  it('throws on duplicate theorem names', () => {
    expect(() =>
      emitLeanFile([
        { name: 'dup', statement: 'True', tactic: 'decide' },
        { name: 'dup', statement: 'True', tactic: 'decide' },
      ]),
    ).toThrow(/duplicate/i)
  })

  it('throws on an invalid Lean identifier', () => {
    expect(() =>
      emitLeanFile([{ name: '7-bad name', statement: 'True', tactic: 'decide' }]),
    ).toThrow(/not a valid Lean identifier/)
  })

  it('batches many theorems into exactly one file (single header, no repeated import blocks)', () => {
    const theorems: LeanTheoremSpec[] = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      statement: '(1:Nat) + 1 = 2',
      tactic: 'decide' as const,
    }))
    const out = emitLeanFile(theorems)
    expect(out.match(/^theorem /gm)?.length).toBe(10)
  })
})

describe('sanitizeLeanName', () => {
  it('replaces non-identifier characters with underscores', () => {
    expect(sanitizeLeanName('7a1b2c3d-e29b-41d4-a716')).toBe('_7a1b2c3d_e29b_41d4_a716')
  })

  it('prefixes a leading digit', () => {
    expect(sanitizeLeanName('123abc')).toBe('_123abc')
  })

  it('leaves an already-valid identifier untouched', () => {
    expect(sanitizeLeanName('req_conflict_ok')).toBe('req_conflict_ok')
  })

  it('is deterministic', () => {
    const raw = 'REQ-42/foo.bar'
    expect(sanitizeLeanName(raw)).toBe(sanitizeLeanName(raw))
  })
})

describe('smoke: generated file elaborates under bare `lean`, no lake', () => {
  it.runIf(leanAvailable())(
    'a batched decide/omega/bv_decide/grind file exits 0 under `lean --json`',
    () => {
      const theorems: LeanTheoremSpec[] = [
        { name: 't_decide', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
        {
          name: 't_omega',
          statement: 'a + b ≥ 0',
          tactic: 'omega',
          binders: '(a b : Nat) (h : a ≤ 10)',
        },
        {
          name: 't_bv',
          statement: 'x + 0 = x',
          tactic: 'bv_decide',
          binders: '(x : BitVec 8)',
        },
        { name: 't_grind', statement: 'True', tactic: 'grind' },
      ]
      const source = emitLeanFile(theorems, { headerComment: ['smoke test fixture'] })

      const dir = mkdtempSync(join(tmpdir(), 'symspec-certify-'))
      const file = join(dir, 'batch.lean')
      writeFileSync(file, source, 'utf8')
      try {
        // No lake project, no lakefile — bare `lean` on a single generated file (AC-5-1).
        const output = execFileSync('lean', ['--json', file], { encoding: 'utf8' })
        const diagnostics = output
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as { severity: string })
        expect(diagnostics.every((d) => d.severity !== 'error')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
