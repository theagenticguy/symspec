/**
 * T-AC-6-5 / AC-6-5 — importable library + exports map + `dts:true`; CLI thin formatter.
 *
 * Verification (per spec.md AC-6-5): "unit test (import the library API in a
 * consumer module; CLI calls the same functions)". Two things are proven here:
 *
 *   1. A separate module (`library-consumer-fixture.ts`) can import the whole
 *      requirement-authoring + analysis workflow through `../index.js` alone
 *      — no reach-through into `core/`, `parse/`, `lint/`, `formal/`,
 *      `pipeline/`, `certify/`, or `solvers/` internals.
 *   2. The CLI (`src/cli/index.ts`) imports its `analyze`/`applyChange`/
 *      `emptyDoc`/`getRequirement`/`exportSysml` bindings from the exact same
 *      underlying modules `src/index.ts` re-exports — i.e. the library entry
 *      is not a parallel/forked implementation, it is the same functions the
 *      CLI already calls, so "CLI as thin formatter over the library API"
 *      holds by construction, not by convention.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportSysml } from '../core/sysml-export.js'
import * as lib from '../index.js'
import { analyzeSampleDoc, buildSampleDoc, listRequirements } from './library-consumer-fixture.js'

describe('T-AC-6-5: importable library entry (src/index.ts)', () => {
  it('a consumer module can build + mutate a document through the library API alone', () => {
    const { doc, id } = buildSampleDoc()
    const reqs = listRequirements(doc)
    expect(reqs).toHaveLength(1)
    expect(reqs[0]?.id).toBe(id)
    expect(reqs[0]?.sentence).toBe('The auth service shall log every authentication attempt.')
  })

  it('a consumer module can run analyze() over a library-built document', () => {
    const { findings, sentence } = analyzeSampleDoc()
    // A single well-formed ubiquitous requirement has no structural findings.
    expect(findings).toEqual([])
    expect(sentence).toContain('shall log every authentication attempt')
  })

  it('re-exports the exact same function identity the CLI imports', async () => {
    // Import the underlying module the CLI itself imports from
    // (`src/core/analyze.js`) and assert `lib.analyze` is the SAME function
    // reference, not a re-implementation — this is what makes the CLI a
    // "thin formatter over the library API" rather than a parallel codepath.
    const coreAnalyze = await import('../core/analyze.js')
    expect(lib.analyze).toBe(coreAnalyze.analyze)
    expect(lib.summarizeFindings).toBe(coreAnalyze.summarizeFindings)

    const coreDoc = await import('../core/doc.js')
    expect(lib.applyChange).toBe(coreDoc.applyChange)
    expect(lib.emptyDoc).toBe(coreDoc.emptyDoc)
    expect(lib.loadDoc).toBe(coreDoc.loadDoc)
    expect(lib.saveDoc).toBe(coreDoc.saveDoc)
    expect(lib.getRequirement).toBe(coreDoc.getRequirement)
    expect(lib.listRequirements).toBe(coreDoc.listRequirements)

    const coreSysml = await import('../core/sysml-export.js')
    expect(lib.exportSysml).toBe(coreSysml.exportSysml)
    expect(lib.exportSysml).toBe(exportSysml)
  })

  it('CLI source imports its core functions from the same modules src/index.ts re-exports', () => {
    // Static-source check (no subprocess spawn): the CLI's import specifiers
    // resolve to the exact same relative modules `src/index.ts` re-exports
    // via `export *`, so a change to the library entry's underlying modules
    // and the CLI's behavior can never silently diverge.
    // The v2 CLI routes the analysis pass through `pipeline/check.ts`
    // (`runCheck`) rather than importing `core/analyze.js` directly, but every
    // command core it drives (`core/doc.js`, `core/changes.js`,
    // `core/sysml-export.js`, `pipeline/check.js`) is one of the exact modules
    // `src/index.ts` re-exports — so the "thin formatter over the library"
    // invariant holds by construction.
    const cliSource = readFileSync(resolve(__dirname, '../cli/index.ts'), 'utf-8')
    expect(cliSource).toContain("from '../core/doc.js'")
    expect(cliSource).toContain("from '../core/changes.js'")
    expect(cliSource).toContain("from '../core/sysml-export.js'")
    expect(cliSource).toContain("from '../pipeline/check.js'")

    const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8')
    expect(indexSource).toContain("export * from './core/analyze.js'")
    expect(indexSource).toContain("export * from './core/doc.js'")
    expect(indexSource).toContain("export * from './core/schema.js'")
    expect(indexSource).toContain("export * from './core/sysml-export.js'")
  })

  it('exports the full public surface with no TS2308 (ambiguous re-export) collisions', () => {
    // If src/index.ts had an unresolved `export *` ambiguity, `tsc --noEmit`
    // (run separately in CI) would fail with TS2308 before this test file
    // ever executes — this test documents the invariant and doubles as a
    // smoke check that every named export below is actually reachable at
    // runtime from the compiled barrel.
    expect(typeof lib.analyze).toBe('function')
    expect(typeof lib.applyChange).toBe('function')
    expect(typeof lib.renderSentence).toBe('function')
    expect(typeof lib.checkGtWRules).toBe('function')
    expect(typeof lib.atomize).toBe('function')
    expect(typeof lib.encode).toBe('function')
    expect(typeof lib.asView).toBe('function')
    expect(typeof lib.runSolvers).toBe('function')
    expect(lib.SCHEMA_VERSION).toBe(2)
  })
})
