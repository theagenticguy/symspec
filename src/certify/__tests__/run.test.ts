import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitLeanFile, type LeanTheoremSpec } from '../emit.js'
import {
  buildLeanToolchainPin,
  certify,
  extractAxiomProvenance,
  type LeanDiagnostic,
  mapLeanResult,
  parseLeanNdjson,
  runLean,
  withAxiomPrints,
} from '../run.js'

/** True if `lean` is discoverable on PATH — smoke tests degrade to a skip otherwise. */
function leanAvailable(): boolean {
  try {
    execFileSync('lean', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A recorded `lean --json` NDJSON fixture: one `information` line, one `error` line. */
const FIXTURE_NDJSON = [
  JSON.stringify({
    caption: '',
    data: "'thm' depends on axioms: [propext, Quot.sound]",
    endPos: { column: 20, line: 1 },
    fileName: 'Batch.lean',
    isSilent: false,
    kind: '[anonymous]',
    pos: { column: 0, line: 1 },
    severity: 'information',
  }),
  JSON.stringify({
    caption: '',
    data: 'Tactic `decide` proved that the proposition\n  1 = 2\nis false',
    endPos: { column: 43, line: 5 },
    fileName: 'Batch.lean',
    isSilent: false,
    kind: '[anonymous]',
    pos: { column: 37, line: 5 },
    severity: 'error',
  }),
].join('\n')

describe('parseLeanNdjson', () => {
  it('parses a fixture NDJSON stream into diagnostics', () => {
    const { diagnostics, unparseable } = parseLeanNdjson(FIXTURE_NDJSON)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]?.severity).toBe('information')
    expect(diagnostics[1]?.severity).toBe('error')
    expect(unparseable).toHaveLength(0)
  })

  it('ignores blank lines between JSON objects', () => {
    const withBlanks = `\n${FIXTURE_NDJSON.split('\n').join('\n\n')}\n\n`
    const { diagnostics } = parseLeanNdjson(withBlanks)
    expect(diagnostics).toHaveLength(2)
  })

  it('collects malformed lines as unparseable rather than throwing', () => {
    const { diagnostics, unparseable } = parseLeanNdjson('not json\n{"severity":"error"}\n')
    // second line parses as JSON but lacks a `data` field, so it is diagnostic-shaped-invalid too
    expect(diagnostics).toHaveLength(0)
    expect(unparseable).toHaveLength(2)
  })

  it('returns empty arrays for empty output', () => {
    expect(parseLeanNdjson('')).toEqual({ diagnostics: [], unparseable: [] })
  })
})

describe('mapLeanResult (exit-code mapping)', () => {
  it('maps exit 0 + no error diagnostics to certified', () => {
    const parsed = parseLeanNdjson(
      JSON.stringify({ severity: 'information', data: 'depends on axioms: [propext]' }),
    )
    const result = mapLeanResult(0, parsed)
    expect(result.certified).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('maps exit 0 + a severity:"error" diagnostic to NOT certified', () => {
    // Mirrors research-lean4.md §1.1: lean can in principle emit an error
    // diagnostic; the mapping must not trust exit code alone.
    const parsed = parseLeanNdjson(JSON.stringify({ severity: 'error', data: 'proved false' }))
    const result = mapLeanResult(0, parsed)
    expect(result.certified).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  it('maps a non-zero exit code to NOT certified even with no error diagnostics', () => {
    const parsed = parseLeanNdjson('')
    const result = mapLeanResult(1, parsed)
    expect(result.certified).toBe(false)
  })

  it('maps a null exit code (killed by signal) to NOT certified', () => {
    const parsed = parseLeanNdjson('')
    const result = mapLeanResult(null, parsed)
    expect(result.certified).toBe(false)
    expect(result.exitCode).toBeNull()
  })

  it('using the fixture NDJSON: exit 1 + one error diagnostic → NOT certified, exactly one error captured', () => {
    const parsed = parseLeanNdjson(FIXTURE_NDJSON)
    const result = mapLeanResult(1, parsed)
    expect(result.certified).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.data).toContain('is false')
    expect(result.diagnostics).toHaveLength(2)
  })
})

describe('extractAxiomProvenance (AC-5-3)', () => {
  it('parses a "does not depend on any axioms" info line', () => {
    const diagnostics: LeanDiagnostic[] = [
      { severity: 'information', data: "'t_ok' does not depend on any axioms" },
    ]
    expect(extractAxiomProvenance(diagnostics)).toEqual([{ name: 't_ok', axioms: [] }])
  })

  it('parses a "depends on axioms: [...]" info line into a name+axioms list', () => {
    const diagnostics: LeanDiagnostic[] = [
      { severity: 'information', data: "'t2' depends on axioms: [propext, Quot.sound]" },
    ]
    expect(extractAxiomProvenance(diagnostics)).toEqual([
      { name: 't2', axioms: ['propext', 'Quot.sound'] },
    ])
  })

  it('ignores non-#print-axioms information diagnostics and error diagnostics', () => {
    const diagnostics: LeanDiagnostic[] = [
      { severity: 'information', data: 'some unrelated info line' },
      { severity: 'error', data: "'t_bad' depends on axioms: [sorryAx]" },
    ]
    expect(extractAxiomProvenance(diagnostics)).toEqual([])
  })

  it('captures provenance for multiple theorems in emission order', () => {
    const diagnostics: LeanDiagnostic[] = [
      { severity: 'information', data: "'t1' does not depend on any axioms" },
      { severity: 'information', data: "'t2' depends on axioms: [propext, Quot.sound]" },
    ]
    expect(extractAxiomProvenance(diagnostics)).toEqual([
      { name: 't1', axioms: [] },
      { name: 't2', axioms: ['propext', 'Quot.sound'] },
    ])
  })
})

describe('withAxiomPrints', () => {
  it('appends one #print axioms line per theorem, in order', () => {
    const theorems: LeanTheoremSpec[] = [
      { name: 't1', statement: 'True', tactic: 'decide' },
      { name: 't2', statement: 'True', tactic: 'decide' },
    ]
    const source = emitLeanFile(theorems)
    const withPrints = withAxiomPrints(source, theorems)
    expect(withPrints).toContain('#print axioms t1\n')
    expect(withPrints).toContain('#print axioms t2\n')
    expect(withPrints.indexOf('#print axioms t1')).toBeLessThan(
      withPrints.indexOf('#print axioms t2'),
    )
  })

  it('is a no-op for an empty theorem list', () => {
    const source = emitLeanFile([])
    expect(withAxiomPrints(source, [])).toBe(source)
  })
})

describe('buildLeanToolchainPin', () => {
  it('parses a `lean --version` output into a leanprover/lean4 pin', () => {
    const versionOutput =
      'Lean (version 4.31.0, x86_64-unknown-linux-gnu, commit 68218e876d2a, Release)'
    expect(buildLeanToolchainPin(versionOutput)).toBe('leanprover/lean4:v4.31.0')
  })

  it('falls back to the verified-live default pin on unparseable version output', () => {
    expect(buildLeanToolchainPin('garbage, no version here')).toBe('leanprover/lean4:v4.31.0')
  })
})

describe('smoke: runLean spawns `lean --json` and maps the real result', () => {
  it.runIf(leanAvailable())('a passing batched file → certified: true, exitCode 0', async () => {
    const theorems: LeanTheoremSpec[] = [
      { name: 't_ok', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
    ]
    const source = emitLeanFile(theorems)
    const dir = mkdtempSync(join(tmpdir(), 'symspec-certify-run-'))
    const file = join(dir, 'batch.lean')
    writeFileSync(file, source, 'utf8')
    try {
      const result = await runLean(file)
      expect(result.certified).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(result.errors).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(leanAvailable())(
    'a failing batched file → certified: false, at least one error diagnostic',
    async () => {
      const theorems: LeanTheoremSpec[] = [
        { name: 't_bad', statement: '(1:Nat) = 2', tactic: 'decide' },
      ]
      const source = emitLeanFile(theorems)
      const dir = mkdtempSync(join(tmpdir(), 'symspec-certify-run-fail-'))
      const file = join(dir, 'batch.lean')
      writeFileSync(file, source, 'utf8')
      try {
        const result = await runLean(file)
        expect(result.certified).toBe(false)
        expect(result.errors.length).toBeGreaterThan(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('smoke: certify() — success path emits .lean + lean-toolchain, axioms captured (AC-5-3)', () => {
  it.runIf(leanAvailable())(
    'certified run retains the .lean artifact + lean-toolchain pin and captures axiom provenance',
    async () => {
      const theorems: LeanTheoremSpec[] = [
        { name: 't_ok', statement: '(2:Nat) + 2 = 4', tactic: 'decide' },
        {
          name: 't_omega',
          statement: 'a + b ≥ 0',
          tactic: 'omega',
          binders: '(a b : Nat) (h : a ≤ 10)',
        },
      ]
      const outDir = mkdtempSync(join(tmpdir(), 'symspec-certify-artifact-'))
      try {
        const result = await certify(theorems, { outDir, fileBaseName: 'batch' })

        expect(result.certified).toBe(true)
        expect(result.exitCode).toBe(0)
        expect(result.errors).toHaveLength(0)

        // #print axioms provenance captured for every theorem (AC-5-3).
        expect(result.axioms).toHaveLength(2)
        const byName = new Map(result.axioms.map((a) => [a.name, a.axioms]))
        expect(byName.get('t_ok')).toEqual([])
        expect(byName.get('t_omega')?.length).toBeGreaterThan(0)

        // Retained, re-checkable artifact (AC-5-3): .lean file + lean-toolchain pin.
        expect(result.artifact).toBeDefined()
        const leanFile = result.artifact?.leanFile
        const toolchainFile = result.artifact?.toolchainFile
        expect(leanFile).toBe(join(outDir, 'batch.lean'))
        expect(toolchainFile).toBe(join(outDir, 'lean-toolchain'))
        expect(existsSync(leanFile ?? '')).toBe(true)
        expect(existsSync(toolchainFile ?? '')).toBe(true)

        const toolchainContents = readFileSync(toolchainFile ?? '', 'utf8').trim()
        expect(toolchainContents).toMatch(/^leanprover\/lean4:v\d+\.\d+\.\d+$/)

        const leanContents = readFileSync(leanFile ?? '', 'utf8')
        expect(leanContents).toContain('#print axioms t_ok')
        expect(leanContents).toContain('#print axioms t_omega')
      } finally {
        rmSync(outDir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(leanAvailable())(
    'a failing run does NOT retain an artifact (certified: false, artifact undefined)',
    async () => {
      const theorems: LeanTheoremSpec[] = [
        { name: 't_bad', statement: '(1:Nat) = 2', tactic: 'decide' },
      ]
      const outDir = mkdtempSync(join(tmpdir(), 'symspec-certify-artifact-fail-'))
      try {
        const result = await certify(theorems, { outDir, fileBaseName: 'batch' })

        expect(result.certified).toBe(false)
        expect(result.artifact).toBeUndefined()
        expect(existsSync(join(outDir, 'batch.lean'))).toBe(false)
        expect(existsSync(join(outDir, 'lean-toolchain'))).toBe(false)
      } finally {
        rmSync(outDir, { recursive: true, force: true })
      }
    },
  )
})
