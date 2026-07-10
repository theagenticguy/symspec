/**
 * `lean --json` invocation + NDJSON diagnostic parsing (AC-5-2), plus
 * certify-success provenance and retained-artifact handling (AC-5-3).
 *
 * The certify tier spawns `lean --json <file>` against a batched `.lean`
 * file produced by {@link emitLeanFile} (`src/certify/emit.ts`, AC-5-1),
 * reads newline-delimited JSON diagnostics off stdout, and maps the
 * process's exit code plus any `severity: "error"` diagnostic to a single
 * certified/failed verdict:
 *
 *   - exit code 0 AND no `severity: "error"` diagnostic  → certified
 *   - exit code non-zero OR any `severity: "error"` diagnostic → NOT certified
 *
 * (research-lean4.md §1.1: "`lean file.lean` exits 0 on success, 1 if any
 * `severity: "error"` message is produced" — both signals are checked so a
 * future Lean release that changes one without the other still fails safe.)
 *
 * The parsing/mapping logic ({@link parseLeanNdjson}, {@link mapLeanResult})
 * is split out as pure functions so it is unit-testable against recorded
 * NDJSON fixtures without spawning a real `lean` process or requiring the
 * Lean toolchain to be installed in CI. {@link runLean} is the thin,
 * process-spawning glue that calls both.
 *
 * {@link certify} is the higher-level AC-5-3 entry point: it appends
 * `#print axioms <name>` to every theorem so the run captures kernel-checked
 * axiom provenance (verified live: a passing `decide` theorem emits `'name'
 * does not depend on any axioms`; an `omega` theorem typically emits `'name'
 * depends on axioms: [propext, Quot.sound]` — both as `severity:
 * "information"` diagnostics, research-lean4.md §2.1), then — ONLY where
 * certification succeeds, per AC-5-3's "Where certification succeeds"
 * conditional wording — retains the generated `.lean` file plus an emitted
 * `lean-toolchain` pin in `options.outDir` as a re-checkable, committable
 * artifact. The run itself happens against a throwaway scratch file so a
 * failed/uncertified run never leaves a half-written artifact behind.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitLeanFile, type LeanTheoremSpec } from './emit.js'

/** One `lean --json` diagnostic line (research-lean4.md §1.1). */
export interface LeanDiagnostic {
  severity: 'error' | 'warning' | 'information' | (string & {})
  data: string
  caption?: string
  fileName?: string
  pos?: { line: number; column: number }
  endPos?: { line: number; column: number }
  isSilent?: boolean
  kind?: string
}

/** Result of running (or having already run) a batched `.lean` file through `lean --json`. */
export interface LeanRunResult {
  /** true iff exit code was 0 AND no diagnostic has `severity: "error"`. */
  certified: boolean
  /** Raw process exit code (null if the process was killed by a signal). */
  exitCode: number | null
  /** Every parsed diagnostic, in emission order. */
  diagnostics: LeanDiagnostic[]
  /** Subset of `diagnostics` with `severity: "error"` — the certification-failure witnesses. */
  errors: LeanDiagnostic[]
  /** Lines from stdout that failed to parse as JSON (defensive — should be empty in practice). */
  unparseable: string[]
}

/**
 * Parse `lean --json`'s stdout into an array of diagnostics. One JSON
 * object per non-blank line; blank lines are ignored. Lines that fail to
 * parse as JSON, or that parse but are not diagnostic-shaped objects, are
 * collected into `unparseable` rather than thrown — a malformed line from a
 * future Lean release should degrade to "unparsed noise", not crash certify.
 */
export function parseLeanNdjson(output: string): {
  diagnostics: LeanDiagnostic[]
  unparseable: string[]
} {
  const diagnostics: LeanDiagnostic[] = []
  const unparseable: string[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      unparseable.push(line)
      continue
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'severity' in parsed &&
      'data' in parsed &&
      typeof (parsed as { severity: unknown }).severity === 'string' &&
      typeof (parsed as { data: unknown }).data === 'string'
    ) {
      diagnostics.push(parsed as LeanDiagnostic)
    } else {
      unparseable.push(line)
    }
  }

  return { diagnostics, unparseable }
}

/**
 * Map a `lean --json` exit code and its parsed diagnostics to a single
 * certified/failed verdict. Pure — no process interaction, so it is the
 * unit under test for "exit-code mapping correct" (AC-5-2).
 */
export function mapLeanResult(
  exitCode: number | null,
  parsed: { diagnostics: LeanDiagnostic[]; unparseable: string[] },
): LeanRunResult {
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error')
  const certified = exitCode === 0 && errors.length === 0
  return {
    certified,
    exitCode,
    diagnostics: parsed.diagnostics,
    errors,
    unparseable: parsed.unparseable,
  }
}

/**
 * `#print axioms <name>` provenance for one theorem, parsed from an
 * `information` diagnostic (AC-5-3). `axioms` is `[]` when Lean reported
 * "does not depend on any axioms" — i.e. the theorem rests on nothing
 * beyond the kernel itself.
 */
export interface AxiomProvenance {
  /** Theorem name the `#print axioms` line refers to. */
  name: string
  /** Axiom names the theorem depends on (empty array = depends on none). */
  axioms: string[]
}

/** Matches Lean's `'<name>' does not depend on any axioms` info line. */
const AXIOM_NONE_RE = /^'([^']+)' does not depend on any axioms$/
/** Matches Lean's `'<name>' depends on axioms: [a, b, ...]` info line. */
const AXIOM_DEPENDS_RE = /^'([^']+)' depends on axioms: \[(.*)\]$/

/**
 * Parse `#print axioms` provenance out of a run's diagnostics. Only
 * `severity: "information"` diagnostics matching one of Lean's two
 * `#print axioms` output shapes are recognized — everything else (proof
 * errors, unrelated info lines) is ignored. Pure; unit-testable against
 * recorded diagnostic fixtures (research-lean4.md §2.1, verified live:
 * `'t_ok' does not depend on any axioms` / `'t2' depends on axioms:
 * [propext, Quot.sound]`).
 */
export function extractAxiomProvenance(diagnostics: readonly LeanDiagnostic[]): AxiomProvenance[] {
  const provenance: AxiomProvenance[] = []
  for (const d of diagnostics) {
    if (d.severity !== 'information') continue

    const noneMatch = AXIOM_NONE_RE.exec(d.data)
    if (noneMatch) {
      provenance.push({ name: noneMatch[1]!, axioms: [] })
      continue
    }

    const dependsMatch = AXIOM_DEPENDS_RE.exec(d.data)
    if (dependsMatch) {
      const rawList = dependsMatch[2]!.trim()
      const axioms = rawList.length === 0 ? [] : rawList.split(',').map((a) => a.trim())
      provenance.push({ name: dependsMatch[1]!, axioms })
    }
  }
  return provenance
}

/**
 * Append one `#print axioms <name>` command per theorem to an already-
 * emitted `.lean` source string, so a subsequent `lean --json` run also
 * captures axiom provenance for each theorem alongside its proof result
 * (AC-5-3). Pure; operates on the string {@link emitLeanFile} already
 * produced rather than re-implementing batching.
 */
export function withAxiomPrints(source: string, theorems: readonly LeanTheoremSpec[]): string {
  if (theorems.length === 0) return source
  const trimmed = source.replace(/\n+$/, '\n')
  const prints = theorems.map((t) => `#print axioms ${t.name}\n`).join('')
  return `${trimmed}${prints}`
}

export interface RunLeanOptions {
  /** Override the `lean` executable path/name (defaults to `"lean"` on PATH). */
  leanBin?: string
  /** Working directory for the spawned process. */
  cwd?: string
}

/**
 * Spawn `lean --json <filePath>`, collect stdout, and return the mapped
 * verdict via {@link parseLeanNdjson} + {@link mapLeanResult}. Never throws
 * on a non-zero Lean exit code (that is the expected "certification failed"
 * path) — it only rejects if the process itself cannot be spawned (e.g. the
 * `lean` binary is not on PATH), which callers should catch and translate to
 * `ERR_LEAN_TOOLCHAIN_MISSING` (AC-5-4).
 */
export async function runLean(
  filePath: string,
  options: RunLeanOptions = {},
): Promise<LeanRunResult> {
  const bin = options.leanBin ?? 'lean'

  const { exitCode, stdout } = await new Promise<{ exitCode: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(bin, ['--json', filePath], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let spawnError: Error | undefined

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', (err) => {
        spawnError = err
      })
      child.on('close', (code) => {
        if (spawnError) {
          reject(spawnError)
          return
        }
        resolve({ exitCode: code, stdout })
      })
    },
  )

  return mapLeanResult(exitCode, parseLeanNdjson(stdout))
}

/** Fallback `lean-toolchain` pin used if `lean --version` can't be parsed (AC-5-3). */
const DEFAULT_LEAN_TOOLCHAIN_PIN = 'leanprover/lean4:v4.31.0'

/** Matches `lean --version`'s `Lean (version 4.31.0, ...)` output. */
const LEAN_VERSION_RE = /version\s+(\d+\.\d+\.\d+)/

/**
 * Build a `lean-toolchain` file's contents (`leanprover/lean4:v<version>`)
 * from `lean --version`'s stdout. Pure — takes the version string rather
 * than spawning, so it's unit-testable. Falls back to
 * {@link DEFAULT_LEAN_TOOLCHAIN_PIN} (the version verified live in
 * research-lean4.md §1.3) if the version can't be parsed, so a pin is
 * always emitted even against an unexpected `lean --version` format.
 */
export function buildLeanToolchainPin(versionOutput: string): string {
  const match = LEAN_VERSION_RE.exec(versionOutput)
  if (!match) return DEFAULT_LEAN_TOOLCHAIN_PIN
  return `leanprover/lean4:v${match[1]}`
}

/** Best-effort `lean --version` probe for the toolchain pin; never throws. */
function probeLeanToolchainPin(leanBin: string): string {
  const result = spawnSync(leanBin, ['--version'], { encoding: 'utf8' })
  if (result.error || typeof result.stdout !== 'string') return DEFAULT_LEAN_TOOLCHAIN_PIN
  return buildLeanToolchainPin(result.stdout)
}

export interface CertifyOptions extends RunLeanOptions {
  /**
   * Directory the `.lean` artifact and `lean-toolchain` pin are written into
   * on a successful certification. Created if missing. Defaults to a
   * `certify` subdirectory of the current working directory.
   */
  outDir?: string
  /** Base filename (without extension) for the retained `.lean` artifact. Defaults to `"batch"`. */
  fileBaseName?: string
  /** Extra header comment lines passed through to {@link emitLeanFile}. */
  headerComment?: readonly string[]
}

/** Result of a full certify run: verdict, axiom provenance, and (if certified) the retained artifact paths. */
export interface CertifyResult extends LeanRunResult {
  /** `#print axioms` provenance for every theorem, parsed off the run's `information` diagnostics. */
  axioms: AxiomProvenance[]
  /**
   * Paths of the retained `.lean` file and `lean-toolchain` pin — present
   * only when `certified` is true, per AC-5-3's "Where certification
   * succeeds" conditional. Omitted (not `undefined`) on a failed run.
   */
  artifact?: { leanFile: string; toolchainFile: string }
}

/**
 * Full AC-5-3 certify pipeline: emit the batched `.lean` file (with
 * `#print axioms` appended per theorem), run it through `lean --json`, and
 * — only where certification succeeds — retain the `.lean` file plus an
 * emitted `lean-toolchain` pin in `options.outDir` as a re-checkable,
 * committable artifact. The run itself always happens against a scratch
 * temp file first, so an uncertified run never leaves a half-written
 * artifact in `outDir`.
 */
export async function certify(
  theorems: readonly LeanTheoremSpec[],
  options: CertifyOptions = {},
): Promise<CertifyResult> {
  const leanBin = options.leanBin ?? 'lean'
  const baseSource = emitLeanFile(
    theorems,
    options.headerComment ? { headerComment: options.headerComment } : {},
  )
  const source = withAxiomPrints(baseSource, theorems)

  const scratchDir = mkdtempSync(join(tmpdir(), 'symspec-certify-'))
  const scratchFile = join(scratchDir, 'batch.lean')
  writeFileSync(scratchFile, source, 'utf8')

  let runResult: LeanRunResult
  try {
    runResult = await runLean(
      scratchFile,
      options.cwd ? { leanBin, cwd: options.cwd } : { leanBin },
    )
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }

  const axioms = extractAxiomProvenance(runResult.diagnostics)
  const result: CertifyResult = { ...runResult, axioms }

  if (runResult.certified) {
    const outDir = options.outDir ?? join(process.cwd(), 'certify')
    const baseName = options.fileBaseName ?? 'batch'
    mkdirSync(outDir, { recursive: true })

    const leanFile = join(outDir, `${baseName}.lean`)
    const toolchainFile = join(outDir, 'lean-toolchain')
    writeFileSync(leanFile, source, 'utf8')
    writeFileSync(toolchainFile, `${probeLeanToolchainPin(leanBin)}\n`, 'utf8')

    result.artifact = { leanFile, toolchainFile }
  }

  return result
}
