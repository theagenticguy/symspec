import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitSmt2 } from '../emit-smt2.js'
import type { Atomize, EncodableRequirement } from '../encode.js'
import { encode } from '../encode.js'

/**
 * AC-4-8 — portable SMT-LIB2 artifact.
 *
 * A deterministic stand-in atomizer, mirroring the same scoping shape the
 * other formal-tier tests use, so the emitted text is asserted without
 * booting the WASM solver. The `.smt2` correctness itself is proven against a
 * real standard SMT-LIB2 reader below (z3, shelled out — not the in-process
 * z3-solver WASM backend), which is exactly what a portable artifact must
 * survive: an independent, standard-conformant parser.
 */
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

/** True if `z3` is discoverable on PATH — the standard-reader smoke test degrades to a skip otherwise. */
function z3Available(): boolean {
  try {
    execFileSync('z3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Run z3 against an emitted `.smt2` string and return its stdout lines.
 *
 * Uses `spawnSync` rather than `execFileSync`: z3 exits non-zero when
 * `(get-unsat-core)` is invoked after a `sat` result (a core is only
 * available on `unsat`), which is standard, expected solver behavior — not a
 * defect in the emitted artifact — so a non-zero exit code must not fail the
 * assertion; only stdout content is checked.
 */
function runZ3(smt2: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'symspec-emit-smt2-'))
  const file = join(dir, 'artifact.smt2')
  writeFileSync(file, smt2, 'utf8')
  try {
    const result = spawnSync('z3', [file], { encoding: 'utf8' })
    return result.stdout.trim().split('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('emitSmt2 (AC-4-8): portable artifact contract', () => {
  it('declares (set-logic ALL) and never emits z3-only options', () => {
    const r1 = encode(
      req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x' }),
      fakeAtomize,
    )
    const text = emitSmt2([r1])

    expect(text).toContain('(set-logic ALL)')
    // The z3-only core-minimization knob (research-smt.md §1.3, §2.2) must never
    // appear in the portable emitted file, per AC-4-8 verbatim.
    expect(text).not.toContain('smt.core.minimize')
    expect(text).not.toContain(':smt.core')
    // Only the SMT-LIB2-standard unsat-core option is emitted.
    expect(text).toContain('(set-option :produce-unsat-cores true)')
  })

  it('is pure and deterministic for identical input', () => {
    const r1 = encode(
      req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x' }),
      fakeAtomize,
    )
    const r2 = encode(
      req({ id: 'REQ-002', patternType: 'event-driven', trigger: 'x', systemResponse: 'y' }),
      fakeAtomize,
    )
    const a = emitSmt2([r1, r2], { contextAtoms: ['sys__auth_service__trig__x'] })
    const b = emitSmt2([r2, r1], { contextAtoms: ['sys__auth_service__trig__x'] })
    expect(a).toBe(b) // input order does not matter — stable sort by req.id
    expect(a).toBe(emitSmt2([r1, r2], { contextAtoms: ['sys__auth_service__trig__x'] }))
  })

  it('declares one Bool per requirement guard and per atom-table entry', () => {
    const r1 = encode(
      req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x' }),
      fakeAtomize,
    )
    const text = emitSmt2([r1])

    expect(text).toContain('(declare-const |REQ-001| Bool)')
    expect(text).toContain('(declare-const |sys__auth_service__trig__x| Bool)')
    expect(text).toContain('(declare-const |sys__auth_service__resp__issue_a_session_token| Bool)')
  })

  it('emits check-sat-assuming over exactly the requirement guards', () => {
    const r1 = encode(req({ id: 'REQ-001' }), fakeAtomize)
    const r2 = encode(req({ id: 'REQ-002' }), fakeAtomize)
    const text = emitSmt2([r1, r2])

    expect(text).toContain('(check-sat-assuming (|REQ-001| |REQ-002|))')
    expect(text).toContain('(get-unsat-core)')
  })

  it.runIf(z3Available())(
    'emitted .smt2 parses under a standard SMT-LIB2 reader (z3 shelled out) and reproduces unsat/core',
    () => {
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
      const text = emitSmt2([r1, r2], { contextAtoms: ['sys__auth_service__trig__x'] })

      const [status, core] = runZ3(text)
      expect(status).toBe('unsat')
      expect(core).toBe('(REQ-001 REQ-002)')
    },
  )

  it.runIf(z3Available())(
    'a satisfiable spec parses cleanly and reports sat under a standard reader',
    () => {
      const r1 = encode(
        req({ id: 'REQ-001', patternType: 'event-driven', trigger: 'x', systemResponse: 'y' }),
        fakeAtomize,
      )
      const text = emitSmt2([r1], { contextAtoms: ['sys__auth_service__trig__x'] })

      const [status] = runZ3(text)
      expect(status).toBe('sat')
    },
  )

  it('sanitizes quoted-symbol delimiters so ids/atoms with `|` or `\\` never break the artifact', () => {
    const r1 = encode(req({ id: 'REQ|weird\\id' }), fakeAtomize)
    const text = emitSmt2([r1])
    expect(text).not.toMatch(/\|\|/) // no doubled/unescaped pipe from a raw id containing one
    expect(text).toContain('(declare-const |REQ_weird_id| Bool)')
  })
})
