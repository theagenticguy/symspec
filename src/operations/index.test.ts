/**
 * The three G1 operations, tested through the kernel rather than through the
 * process. The SHIPPED-BUNDLE behavior (real argv, real exit codes, real streams)
 * is covered separately by the drift/CLI suite, which spawns `dist/cli.mjs`.
 */

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { REACHABILITY_FND_CODES } from '../formal/reachability-codes.ts'
import { API_VERSION } from '../kernel/envelope.ts'
import { ERR_CODES, errCodeCatalog, toErrorEnvelope } from '../kernel/errors.ts'
import { exitCodeForEnvelope } from '../kernel/exit.ts'
import { runOperation } from '../kernel/operation.ts'
import { SCOPE, SCOPE_KEYS } from '../kernel/scope.ts'
import { VERSION } from '../kernel/version.ts'
import {
  allOperations,
  currentManifest,
  explainOp,
  manifestOp,
  OPERATIONS,
  versionOp,
} from './index.ts'

describe('the table', () => {
  /**
   * Pins the shipped operation set and its ORDER, since the order is what `--help`
   * and the manifest present to a reader — the document lifecycle first, then the
   * self-description operations an agent uses to orient.
   *
   * This is a deliberate snapshot, not a coincidence: adding an operation is
   * supposed to require exactly one edit to `OPERATIONS`, and this test makes that
   * edit visible in review rather than letting the agent-facing surface grow
   * silently.
   */
  it('holds the shipped operations, in presentation order', () => {
    expect(OPERATIONS.map((op) => op.name)).toEqual([
      'init',
      'import',
      // G2b: `parse` sits with the document lifecycle rather than with the analysis
      // ops, because it is where a document COMES FROM — prose in, apply-ready ops
      // out. It reads no document and writes none.
      'parse',
      // G2b AUTHORING, in the order an agent uses them: create, edit, relate, delete,
      // then the three committed side tables, then the batch that does any of it in
      // bulk. All twelve fold the SAME op vocabulary through the same `foldOps`, so
      // this list is a presentation choice and not a capability boundary.
      'add',
      'update',
      'link',
      'delete',
      'waive',
      'glossary',
      'antonym',
      // G4 REACHABILITY AUTHORING, after the side tables and before `apply` because
      // that is the order an agent uses them: declare the state variables, set the
      // model-wide initial predicate, classify the responses that touch them.
      // Three operations rather than one because they are scoped differently — two
      // document-scoped, one requirement-scoped (the donor's "two tables, not one").
      'state',
      'state-initial',
      'classify',
      'apply',
      'list',
      'show',
      // G2a: `check`, the operation the tool exists for, placed after the document
      // lifecycle and before the self-description ops.
      'check',
      'manifest',
      'explain',
      'version',
      // G3: `install` sits with the self-description ops rather than the document
      // lifecycle, because it acts on the developer's machine rather than on a document —
      // it is how the tool describes itself to a HOST, which is the job `manifest` does
      // for an agent.
      'install',
      // The model pre-warm, last: a one-time setup step rather than part of any loop.
      'download-model',
    ])
  })

  it('gives every operation a name, a summary and a non-error type', () => {
    for (const op of allOperations()) {
      expect(op.name).toMatch(/^[a-z][a-z-]*$/)
      expect(op.summary.length).toBeGreaterThan(0)
      expect(op.type.length).toBeGreaterThan(0)
      // `'error'` is the failure envelope's reserved discriminant.
      expect(op.type).not.toBe('error')
    }
  })

  it('has unique names and unique success types', () => {
    const names = allOperations().map((op) => op.name)
    const types = allOperations().map((op) => op.type)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(types).size).toBe(types.length)
  })
})

describe('manifest', () => {
  it('emits a success envelope typed `manifest`', async () => {
    const env = await Effect.runPromise(runOperation(manifestOp, {}))
    expect(env.apiVersion).toBe(API_VERSION)
    expect(env.type).toBe('manifest')
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('describes ITSELF — the table can project its own row', () => {
    const names = currentManifest().operations.map((op) => op.name)
    expect(names).toContain('manifest')
    expect(names).toEqual([...OPERATIONS.map((op) => op.name)])
  })

  it('publishes each operation summary verbatim from the table', () => {
    for (const row of currentManifest().operations) {
      const op = allOperations().find((o) => o.name === row.name)
      expect(row.summary).toBe(op?.summary)
    }
  })

  it('publishes the version and the envelope apiVersion', () => {
    const m = currentManifest()
    expect(m.version).toBe(VERSION)
    expect(m.apiVersion).toBe(API_VERSION)
  })

  it('publishes all four exit codes with meanings', () => {
    expect(currentManifest().exitCodes.map((e) => e.code)).toEqual([0, 1, 2, 3])
    for (const row of currentManifest().exitCodes) {
      expect(row.meaning.length).toBeGreaterThan(0)
    }
  })

  it('publishes all 21 error codes, single-sourced from the catalog', () => {
    expect(currentManifest().errorCodes).toEqual([...errCodeCatalog()])
    expect(currentManifest().errorCodes.map((e) => e.code)).toEqual([...ERR_CODES])
  })

  /**
   * The manifest is where an agent is TOLD to learn the surface, so the boundary of what a
   * verdict means has to be in it.
   *
   * This gap shipped once: the corpus reached the generated `AGENTS.md` and the installed
   * skill, but not the manifest — while the README claimed it did. An agent that followed
   * the documented path read every code and never read the one sentence that says a clean
   * `check` means "no conflict was proven" rather than "this spec is consistent".
   */
  it('publishes the honest-scope corpus, verbatim and claim by claim', () => {
    const scope = currentManifest().scope
    expect(Object.keys(scope).sort()).toEqual([...SCOPE_KEYS].sort())
    for (const key of SCOPE_KEYS) {
      expect(scope[key], `${key} was not published verbatim`).toBe(SCOPE[key])
    }
  })

  it('publishes the claim that changes what an agent may CONCLUDE', () => {
    // Named individually because the loop above passes on an empty corpus paired with an
    // empty key list. `silence` is the load-bearing one: without it, a clean run reads as
    // proof of consistency.
    const scope = currentManifest().scope
    expect(scope.silence).toContain('silence is not a consistency certificate')
    expect(scope.soundness).toContain('sound modulo atomization')
    expect(scope.reachabilityModelScoped).toContain('STATE MODEL you declared')
  })

  it('publishes an honest input schema for every operation', () => {
    for (const row of currentManifest().operations) {
      // Never the object-or-array lowering an empty struct produces raw.
      expect(JSON.stringify(row.input)).not.toContain('"array"')
      expect(row.input).toMatchObject({ type: 'object' })
    }
  })

  it('is JSON-serializable and stable across calls', () => {
    expect(JSON.stringify(currentManifest())).toBe(JSON.stringify(currentManifest()))
  })
})

describe('explain — success', () => {
  it('explains a known code with meaning and suggestions', async () => {
    const env = await Effect.runPromise(runOperation(explainOp, { code: 'ERR_SOLVER_MISSING' }))
    expect(env.type).toBe('codeExplanation')
    expect(env.data.code).toBe('ERR_SOLVER_MISSING')
    expect(env.data.meaning).toContain('binary solver backend')
    expect(env.data.suggestions.length).toBeGreaterThan(0)
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('resolves EVERY code in the catalog', async () => {
    for (const code of ERR_CODES) {
      const env = await Effect.runPromise(runOperation(explainOp, { code }))
      expect(env.data.code).toBe(code)
      expect(env.data.description.length).toBeGreaterThan(0)
    }
  })
})

/**
 * AC-A-3 — the OPERATION reaches all three catalogs, not just the kernel function.
 *
 * `catalog.test.ts` covers the lookup exhaustively. What these add is the seam: the
 * operation actually calls it, so the 54 codes G1's `explain` could not resolve now
 * come back through a real `codeExplanation` envelope with exit 0. Before G3 every
 * one of these was an `ERR_NOT_FOUND` at exit 2 — an agent holding an
 * `FND_CONTRADICTION` from `check` could list it in the manifest and not explain it.
 */
describe('explain — AC-A-3: every code through the operation', () => {
  it('resolves every code the MANIFEST publishes, across all three catalogs', async () => {
    const manifest = currentManifest()
    const published = [...manifest.errorCodes, ...manifest.findingCodes, ...manifest.lintCodes].map(
      (row) => row.code,
    )
    expect(published).toHaveLength(81)

    for (const code of published) {
      const env = await Effect.runPromise(runOperation(explainOp, { code }))
      expect(env.data.code, code).toBe(code)
      // The description an agent gets from `explain` is byte-identical to the one the
      // manifest published — the single-source claim, asserted at the seam where it
      // would break.
      const row = published.includes(code)
        ? [...manifest.errorCodes, ...manifest.findingCodes, ...manifest.lintCodes].find(
            (r) => r.code === code,
          )
        : undefined
      expect(env.data.description, code).toBe(row?.description)
      expect(exitCodeForEnvelope(env), code).toBe(0)
    }
  })

  it('explains a FINDING code with its severity and tier', async () => {
    const env = await Effect.runPromise(runOperation(explainOp, { code: 'FND_CONTRADICTION' }))
    expect(env.data.family).toBe('FND')
    expect(env.data.severity).toBe('error')
    expect(env.data.tier).toBe('formal')
    expect(env.data.meaning).toContain('unsat')
  })

  it('explains a LINT code with the honest null severity and the reason', async () => {
    const env = await Effect.runPromise(runOperation(explainOp, { code: 'GTWR_R26_ABSOLUTE' }))
    expect(env.data.family).toBe('GTWR')
    // NOT a guess: R26 is error on a bare absolute and warn when a conditional
    // qualifies it, so a per-code severity would be wrong exactly when it matters.
    expect(env.data.severity).toBeNull()
    expect(env.data.severityNote).toContain('PER FINDING')
    expect(env.data.tier).toBe('lint')
  })

  it('carries the worked micro-example where the catalog has one', async () => {
    const env = await Effect.runPromise(
      runOperation(explainOp, { code: 'FND_OPPOSITION_CANDIDATE' }),
    )
    expect(env.data.example).toBe('"open the valve" vs "shut the valve"')
    // And the runnable discharge, lifted out of the same description text.
    expect(env.data.commands).toEqual(['symspec antonym add <verbA> <verbB>'])
  })

  it('did-you-mean now ranks across every family, not the 21 ERR_* codes', async () => {
    // The G1 miss this closes: a GTWR_* typo returned a list of ERR_* codes.
    const r = await Effect.runPromise(
      Effect.result(runOperation(explainOp, { code: 'GTWR_R7_VAGU' })),
    )
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.suggestions.join(' ')).toContain('GTWR_R7_VAGUE')
      expect(env.repair?.commands).toEqual(['symspec explain --code GTWR_R7_VAGUE'])
      // And it says how many codes exist, so an agent knows the corpus size. 36 FND_*:
      // the donor's frozen 30 plus the 6 `FND_REACHABILITY_*`. Read from
      // `catalogCounts()` at runtime rather than hardcoded in the message, which is why
      // this number moves on its own when the vocabulary grows.
      expect(env.suggestions.join(' ')).toContain('36 FND_*')
    }
  })

  /**
   * THE REACHABILITY CODES, named individually (G5).
   *
   * The all-codes loop above covers them by construction, which is the right way to make
   * growth automatic and the wrong way to be sure. These are the newest family and the one an
   * agent is most likely to hold without a manifest — a `check` run over a state model hands
   * back `FND_REACHABILITY_VIOLATED` and the agent's next call is `explain`.
   *
   * So each is asserted with its own severity and remedy, because the ONE fact that decides
   * what an agent does about a reachability finding is whether it gates the build, and the
   * ONE fact that decides how it fixes it is which knob the remedy names.
   */
  it('explains all six FND_REACHABILITY_* codes with the right severity', async () => {
    expect(REACHABILITY_FND_CODES).toHaveLength(6)
    for (const code of REACHABILITY_FND_CODES) {
      const env = await Effect.runPromise(runOperation(explainOp, { code }))
      expect(env.data.code, code).toBe(code)
      expect(env.data.family, code).toBe('FND')
      expect(env.data.tier, code).toBe('formal')
      // VIOLATED and VACUOUS_INITIAL can fail a build; the other four demote instead. A
      // vacuous initial state earns error severity because it MASKS proven violations —
      // every constraint holds over an empty reachable set — rather than merely failing
      // to prove one.
      const gating = ['FND_REACHABILITY_VIOLATED', 'FND_REACHABILITY_VACUOUS_INITIAL']
      expect(env.data.severity, code).toBe(gating.includes(code) ? 'error' : 'info')
      expect(env.data.meaning.length, code).toBeGreaterThan(80)
      expect(exitCodeForEnvelope(env), code).toBe(0)
    }
  })

  it('the UNKNOWN remedy names the TIER`S OWN timeout flag, and the undecidable alternative', async () => {
    // The distinction that keeps an agent out of a tuning loop: budget exhaustion and
    // undecidability need opposite remedies, and the solver cannot be asked which applies
    // (a timed-out Spacer query reports its reason as the literal string "ok").
    const env = await Effect.runPromise(
      runOperation(explainOp, { code: 'FND_REACHABILITY_UNKNOWN' }),
    )
    const text = [env.data.meaning, ...env.data.suggestions].join(' ')
    // The tier's own flag (G5), NOT the shared `--timeout-ms`.
    expect(text).toContain('--reachability-timeout-ms')
    expect(text).toContain('bound the integer domains')
    expect(text).toContain('more time will not help')
  })

  it('the NOT_CHECKED remedy names the two SUPPLYING commands, in order', async () => {
    // The established pattern for a coverage demotion: say what is missing and which
    // command supplies it. Declaring variables is the first half and classifying responses
    // is the second, and naming only one would leave an agent stuck after step 1.
    const env = await Effect.runPromise(
      runOperation(explainOp, { code: 'FND_REACHABILITY_NOT_CHECKED' }),
    )
    const text = [env.data.meaning, ...env.data.suggestions].join(' ')
    expect(text).toContain('symspec state')
    expect(text).toContain('symspec classify')
    // And it says what it IS, so a reader does not mistake a disclosure for a defect.
    expect(text).toContain('coverage DISCLOSURE')
  })

  it('needs NO manifest fetch — the answer is one code, not 48 KB of JSON', async () => {
    // AC-3-8's actual requirement, asserted structurally: the explanation is small
    // and self-contained, so an agent in a fix loop never pays for the whole contract
    // to learn what one code means.
    const one = await Effect.runPromise(runOperation(explainOp, { code: 'FND_VACUITY' }))
    const explainBytes = JSON.stringify(one).length
    const manifestBytes = JSON.stringify(currentManifest()).length
    expect(explainBytes).toBeLessThan(2_000)
    expect(explainBytes * 20).toBeLessThan(manifestBytes)
  })
})

describe('explain — unknown code', () => {
  const run = (code: string) => Effect.runPromise(Effect.result(runOperation(explainOp, { code })))

  it('fails with ERR_NOT_FOUND and exit 2', async () => {
    const r = await run('ERR_BOGUS')
    expect(r._tag).toBe('Failure')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.code).toBe('ERR_NOT_FOUND')
      expect(env.error).toContain('ERR_BOGUS')
      expect(exitCodeForEnvelope(env)).toBe(2)
    }
  })

  it('offers DID-YOU-MEAN suggestions for a near miss', async () => {
    const r = await run('ERR_SOLVER_MISSNG')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.suggestions.join(' ')).toContain('ERR_SOLVER_MISSING')
    }
  })

  it('always points at the manifest as the exhaustive list', async () => {
    const r = await run('TOTALLY_UNRELATED')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.suggestions.join(' ')).toContain('manifest')
    }
  })

  /** AC-A-9: the remedy is machine-actionable, not just prose. */
  it('carries a runnable repair command', async () => {
    const r = await run('ERR_SOLVER_MISSNG')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.repair?.commands).toEqual(['symspec explain --code ERR_SOLVER_MISSING'])
    }
  })

  it('falls back to `symspec manifest` when nothing is close', async () => {
    const r = await run('TOTALLY_UNRELATED')
    if (r._tag === 'Failure') {
      const env = toErrorEnvelope(r.failure as Parameters<typeof toErrorEnvelope>[0])
      expect(env.repair?.commands).toEqual(['symspec manifest'])
    }
  })

  it('is case-sensitive — a lowercase code is unknown, not silently coerced', async () => {
    const r = await run('err_io')
    expect(r._tag).toBe('Failure')
  })
})

describe('version', () => {
  it('reports the package version and the envelope apiVersion', async () => {
    const env = await Effect.runPromise(runOperation(versionOp, {}))
    expect(env.type).toBe('version')
    expect(env.data).toEqual({ version: VERSION, apiVersion: API_VERSION })
    expect(exitCodeForEnvelope(env)).toBe(0)
  })

  it('keeps the two version numbers independent', () => {
    // They answer different questions: one moves every release, the other only
    // on a breaking envelope change. Asserting they are different KINDS of value
    // guards against someone "simplifying" by making apiVersion the package one.
    expect(typeof VERSION).toBe('string')
    expect(typeof API_VERSION).toBe('number')
  })
})
