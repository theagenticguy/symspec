/**
 * The `budgetHint` CALIBRATION PROBE — measure this pipeline's own cost curve.
 *
 * `data.budgetHint` (spec AC-A-8) must recommend a `--solver-budget-ms` derived
 * from measurements taken on THIS pipeline, not from the donor's numbers (donor
 * scale data: N=10 → 2.7s … N=100 → 79.2s). Those are prior art for the SHAPE of
 * the curve — clean O(N²) on two axes — and nothing more: the greenfield runs the
 * transplanted tier through a Layer-owned WASM module rather than the donor's
 * module-level memo, and the machine is not the donor's machine.
 *
 * So this script sweeps N over synthetic documents whose requirements share a
 * trigger (so the pairwise tiers actually have candidate pairs to compare) and
 * reports, per N:
 *
 *   - requirements, atoms (the run's own `residualRisk`-adjacent tallies),
 *   - the UNBOUNDED wall-clock solver time, which is the number a budget has to
 *     exceed for a run to be complete,
 *   - and the truncation behavior at a fraction of that time, so the demotion
 *     path is exercised rather than assumed.
 *
 * REPORT ONLY. Nothing in the build depends on it; `budget-hint.ts` carries the
 * constants this probe justifies, and `budget-hint.test.ts` asserts the SHAPE of
 * the recommendation (monotone, above the measured cost) rather than the exact
 * milliseconds — a number that would be a machine artifact.
 *
 * Usage:
 *   pnpm tsx scripts/budget-curve.ts            # default sweep
 *   NS=5,10,20,40 pnpm tsx scripts/budget-curve.ts
 */

import { Effect, Layer } from 'effect'
import { embedderLayerOf, stubEmbedder } from '../src/adapters/embedding/embedder.ts'
import { DocPath, DocStore, makeDocPath } from '../src/adapters/fs/store.ts'
import { solverServiceLayer } from '../src/adapters/z3/solver-service.ts'
import { type CheckPayload, checkOp } from '../src/app/operations/check.ts'
import { ErrDocNotFound } from '../src/app/runtime/errors.ts'
import { runOperation } from '../src/app/runtime/operation.ts'
import {
  emptyDocument,
  type Requirement,
  type RequirementsDocument,
} from '../src/domain/requirements/document.ts'

const TS = '2026-01-01T00:00:00.000Z'

/**
 * Distinct response OBJECTS, spelled as words rather than digits.
 *
 * The first version of this probe wrote `enqueue the batch ${i}` and measured a
 * FLAT curve — 110ms at every N. The reason was not that the pipeline is fast: a
 * bare number with no unit fires `GTWR_R6_MISSING_UNITS` at error severity, the
 * AC-3-7 gate then EXCLUDED every requirement from the formal tier, and the sweep
 * measured lint on N sentences with `pairsChecked: 0` at every point. The tell was
 * in the probe's own output (`atoms 0, pairs 0, demotions N+1`), which is why those
 * columns are printed rather than just the milliseconds.
 *
 * So the object phrases are word-spelled and drawn from a fixed pool, cycling with
 * a word-spelled suffix past the pool's size. Nothing here may trip an
 * error-severity lint rule, or the probe measures the wrong thing again.
 */
const OBJECTS = [
  'the primary queue',
  'the standby queue',
  'the audit log',
  'the retry ledger',
  'the dispatch table',
  'the operator console',
  'the archive shard',
  'the replay buffer',
] as const

const SUFFIXES = [
  '',
  ' alpha',
  ' beta',
  ' gamma',
  ' delta',
  ' epsilon',
  ' zeta',
  ' eta',
  ' theta',
  ' iota',
] as const

const objectPhrase = (i: number): string => {
  const base = OBJECTS[i % OBJECTS.length] as string
  const suffix = SUFFIXES[Math.floor(i / OBJECTS.length) % SUFFIXES.length] as string
  return `${base}${suffix}`
}

/**
 * A synthetic document of `n` requirements that SHARE one system and one trigger,
 * so every pair is a candidate pair (`same-system-same-trigger-different-response`)
 * and the pairwise tiers do real work. A document of disjoint requirements would
 * sweep to zero pairs and measure only the parse/lint cost, which is not what a
 * solver budget bounds.
 */
const syntheticDoc = (n: number): RequirementsDocument => {
  const requirements: Requirement[] = []
  for (let i = 0; i < n; i++) {
    const hex = i.toString(16).padStart(8, '0')
    const response = `update ${objectPhrase(i)}`
    requirements.push({
      id: `${hex}-1111-4111-8111-111111111111`,
      patternType: 'event-driven',
      trigger: 'the operator confirms the plan',
      systemName: 'scheduler',
      systemResponse: response,
      negated: false,
      priority: 'medium',
      status: 'draft',
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
      createdAt: TS,
      updatedAt: TS,
      sentence: `When the operator confirms the plan, the scheduler shall ${response}.`,
    })
  }
  return {
    ...emptyDocument(),
    requirements: Object.fromEntries(requirements.map((r) => [r.id, r])),
  }
}

const layerFor = (document: RequirementsDocument) =>
  Layer.mergeAll(
    Layer.succeed(DocStore)(
      DocStore.of({
        load: (path) =>
          path === 'doc.json'
            ? Effect.succeed({ document, unknownKeys: {}, diagnostics: [] })
            : Effect.fail(new ErrDocNotFound({ error: `no document at ${path}`, suggestions: [] })),
        save: () => Effect.void,
        exists: () => Effect.succeed(true),
      }),
    ),
    Layer.succeed(DocPath)(makeDocPath({})),
    solverServiceLayer,
    embedderLayerOf(stubEmbedder()),
  )

const run = async (
  document: RequirementsDocument,
  input: Record<string, unknown>,
): Promise<{ readonly ms: number; readonly payload: CheckPayload | undefined }> => {
  const started = performance.now()
  const result = await Effect.runPromise(
    Effect.result(runOperation(checkOp, { file: 'doc.json', ...input })).pipe(
      Effect.provide(layerFor(document)),
    ),
  )
  const ms = performance.now() - started
  if (result._tag === 'Failure') return { ms, payload: undefined }
  return { ms, payload: result.success.data as CheckPayload }
}

const NS = (process.env.NS ?? '5,10,20,30,40,60').split(',').map((s) => Number(s.trim()))

console.error(`node ${process.version}, loadavg ${(await import('node:os')).loadavg().join(' ')}`)
console.error('N\tencoded\tatoms\tpairs\tunbounded_ms\ttruncated@25%\tdemotions')

for (const n of NS) {
  const document = syntheticDoc(n)
  const unbounded = await run(document, {})
  if (unbounded.payload === undefined) {
    console.error(`${n}\tFAILED`)
    continue
  }
  const atoms = unbounded.payload.coverage.requirements.reduce(
    (sum, r) => sum + r.unmatchedAtoms.length,
    0,
  )
  // A budget deliberately BELOW the measured cost, so the truncation path runs.
  const tight = Math.max(1, Math.round(unbounded.ms * 0.25))
  const bounded = await run(document, { solverBudgetMs: tight })
  const truncated =
    bounded.payload?.coverage.demotions.some((d) => d.reason === 'solver-budget-exhausted') ?? false
  console.error(
    [
      n,
      unbounded.payload.coverage.encoded,
      atoms,
      unbounded.payload.pairsChecked,
      unbounded.ms.toFixed(0),
      truncated ? `yes(${tight}ms)` : `no(${tight}ms)`,
      unbounded.payload.coverage.demotions.length,
    ].join('\t'),
  )
}
