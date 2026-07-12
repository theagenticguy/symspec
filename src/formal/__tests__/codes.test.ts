import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../core/analyze.js'
import { buildCodeCatalog } from '../../core/codes.js'
import type { EarsPattern, Requirement, RequirementsDoc } from '../../core/schema.js'
import { SCHEMA_VERSION } from '../../core/schema.js'
import { detectExactDuplicates } from '../../solvers/free/duplicates.js'
import type { ReqView } from '../../solvers/types.js'
import {
  certifiedToFndCode,
  type FndCode,
  FndCodeMeta,
  FndCodeSchema,
  FndCodes,
  solverKindToFndCode,
  structuralKindToFndCode,
} from '../codes.js'

/**
 * AC-6-3 — the FND_* enum is the third single-source code catalog. It must be
 * append-only, carry a per-code `.describe()` the manifest derives from, and
 * every documented code must be REACHABLE by a real emitter path.
 *
 * Reachability is established three ways, one per producer surface:
 *   - structural (Tier 0) codes: run `analyze()` over planted docs and map each
 *     finding's `kind` through the canonical `structuralKindToFndCode` bridge;
 *   - the free-tier exact-duplicate code: run `detectExactDuplicates()` and map
 *     through `solverKindToFndCode`;
 *   - the certify verdict codes: exercise `certifiedToFndCode(true|false)`;
 *   - the solver-backed formal codes + the completeness heuristic: assert the
 *     `code: 'FND_…'` emit literal is present at a producer site in
 *     `src/formal/*.ts` (their unsat/heuristic fixtures live in each detector's
 *     own test; here we prove the emitter exists so no code is orphaned).
 */

/**
 * Append-only snapshot (AC-6-3). Frozen shipped FND_* order. Appends allowed at
 * the tail; removals/renames/reorders fail the guard.
 */
const FND_CODES_SNAPSHOT = [
  'FND_DANGLING_REFERENCE',
  'FND_MISSING_TRIGGER',
  'FND_MISSING_PRECONDITION',
  'FND_CYCLE',
  'FND_ORPHAN',
  'FND_EXACT_DUPLICATE',
  'FND_CONTRADICTION',
  'FND_SUBSUMPTION',
  'FND_REDUNDANCY',
  'FND_VACUITY',
  'FND_SIMILAR_UNUNIFIED',
  'FND_NEEDS_REVIEW',
  'FND_INCOMPLETE',
  'FND_CERTIFIED',
  'FND_CERTIFY_FAILED',
] as const

const now = '2024-01-01T00:00:00.000Z'
const req = (
  id: string,
  patternType: EarsPattern,
  systemName: string,
  systemResponse: string,
  extras: Partial<Pick<Requirement, 'trigger' | 'preCondition' | 'derives' | 'refines'>> = {},
): Requirement => ({
  id,
  patternType,
  systemName,
  systemResponse,
  negated: false,
  sentence: `The ${systemName} shall ${systemResponse}.`,
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: now,
  updatedAt: now,
  ...extras,
})
const docOf = (...reqs: Requirement[]): RequirementsDoc => ({
  schemaVersion: SCHEMA_VERSION,
  requirements: Object.fromEntries(reqs.map((r) => [r.id, r])),
  glossary: [],
  waivers: [],
})
const view = (id: string, systemResponse: string): ReqView => ({
  id,
  patternType: 'ubiquitous',
  systemName: 'svc',
  systemResponse,
  negated: false,
  sentence: `The svc shall ${systemResponse}.`,
  priority: 'medium',
  status: 'draft',
})

describe('FndCodeSchema (AC-6-3 — append-only FND_* catalog)', () => {
  it('is append-only: no existing code was removed, renamed, or reordered', () => {
    expect(FndCodes.slice(0, FND_CODES_SNAPSHOT.length)).toEqual([...FND_CODES_SNAPSHOT])
    expect(FndCodes.length).toBeGreaterThanOrEqual(FND_CODES_SNAPSHOT.length)
  })

  it('every enum member has a matching described literal in FndCodeMeta', () => {
    for (const code of FndCodes) {
      const meta = FndCodeMeta[code]
      expect(meta, `FndCodeMeta is missing ${code}`).toBeDefined()
      expect(meta.value).toBe(code)
      expect((meta.description ?? '').length).toBeGreaterThan(0)
    }
  })

  it('FndCodeMeta describes exactly the enum members — no extras', () => {
    expect(Object.keys(FndCodeMeta).sort()).toEqual([...FndCodes].sort())
  })

  it('buildCodeCatalog reads live .describe() text (single-source for the manifest)', () => {
    const cat = buildCodeCatalog(FndCodes, FndCodeMeta)
    expect(cat.map((r) => r.code)).toEqual([...FndCodes])
    for (const row of cat) {
      expect(row.description).toBe(FndCodeMeta[row.code].description)
    }
  })
})

describe('FND_* reachability (AC-6-3 — every documented code is reachable)', () => {
  // Accumulate every code proven reachable across the checks below, then
  // assert the union equals the full enum with nothing left orphaned.
  const reached = new Set<FndCode>()

  it('structural Tier-0 codes are produced by analyze() (via the kind bridge)', () => {
    const doc = docOf(
      // dangling edge → FND_DANGLING_REFERENCE
      req('a', 'ubiquitous', 'svc', 'do A', { derives: ['missing'] }),
      // event-driven, no trigger → FND_MISSING_TRIGGER
      req('b', 'event-driven', 'svc', 'do B'),
      // state-driven, no precondition → FND_MISSING_PRECONDITION
      req('c', 'state-driven', 'svc', 'do C'),
      // self-loop cycle → FND_CYCLE
      req('d', 'ubiquitous', 'svc', 'do D', { derives: ['d'] }),
      // isolated node in a >1 doc → FND_ORPHAN
      req('e', 'ubiquitous', 'svc', 'do E'),
      // a parent 'p' that refines leaf 'g'; 'g' is a refinement leaf with no
      // verify edge → FND_LEAF_UNVERIFIABLE (AC-32-3)
      req('p', 'ubiquitous', 'svc', 'do P', { refines: ['g'] }),
      req('g', 'ubiquitous', 'svc', 'do G'),
    )
    for (const f of analyze(doc)) {
      const code = structuralKindToFndCode[f.kind as keyof typeof structuralKindToFndCode]
      expect(code, `no FND bridge for structural kind ${f.kind}`).toBeDefined()
      reached.add(code)
    }
    for (const c of [
      'FND_DANGLING_REFERENCE',
      'FND_MISSING_TRIGGER',
      'FND_MISSING_PRECONDITION',
      'FND_CYCLE',
      'FND_ORPHAN',
      'FND_LEAF_UNVERIFIABLE',
    ] as const) {
      expect(reached.has(c), `${c} not reached via analyze()`).toBe(true)
    }
  })

  it('the exact-duplicate code is produced by detectExactDuplicates() (via the kind bridge)', () => {
    const findings = detectExactDuplicates([
      view('x', 'reject expired tokens'),
      view('y', 'reject expired tokens'),
    ])
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      const code = solverKindToFndCode[f.kind as keyof typeof solverKindToFndCode]
      expect(code, `no FND bridge for solver kind ${f.kind}`).toBeDefined()
      reached.add(code)
    }
    expect(reached.has('FND_EXACT_DUPLICATE')).toBe(true)
  })

  it('the certify verdict codes are produced by certifiedToFndCode()', () => {
    reached.add(certifiedToFndCode(true))
    reached.add(certifiedToFndCode(false))
    expect(certifiedToFndCode(true)).toBe('FND_CERTIFIED')
    expect(certifiedToFndCode(false)).toBe('FND_CERTIFY_FAILED')
  })

  it('every solver-backed / heuristic code has a real emit literal at a producer site', () => {
    // These codes only fire on planted unsat/heuristic fixtures (covered in each
    // detector's own test). Here we prove the emitter exists — that the code is
    // not an orphan in the enum with no producer — by scanning the formal source
    // for its `code: 'FND_…'` emit literal.
    const here = dirname(fileURLToPath(import.meta.url))
    const formalDir = dirname(here)
    const sources = readdirSync(formalDir)
      .filter((n) => n.endsWith('.ts'))
      .map((n) => readFileSync(join(formalDir, n), 'utf8'))
      .join('\n')

    for (const code of [
      'FND_CONTRADICTION',
      'FND_SUBSUMPTION',
      'FND_REDUNDANCY',
      'FND_VACUITY',
      'FND_SIMILAR_UNUNIFIED',
      'FND_NEEDS_REVIEW',
      'FND_INCOMPLETE',
      'FND_SIMILAR_SEMANTIC',
      'FND_NUMERIC_CONTRADICTION',
      'FND_MISSING_TRACE_LINK',
      'FND_DUPLICATE_CLUSTER',
      'FND_AMBIGUOUS_VAGUE',
      'FND_AMBIGUOUS_QUANTIFIER',
      'FND_AMBIGUOUS_REFERENCE',
      'FND_AMBIGUITY_NEEDS_JUDGMENT',
      'FND_TEMPORAL_CONTRADICTION',
      'FND_NO_PAIRS_CHECKED',
    ] as const) {
      expect(sources.includes(`code: '${code}'`), `no emit literal for ${code}`).toBe(true)
      reached.add(code)
    }
  })

  it('the union of reachable codes equals the full FND_* enum (no orphan codes)', () => {
    const missing = FndCodes.filter((c) => !reached.has(c))
    expect(missing, `unreachable FND codes: ${missing.join(', ')}`).toEqual([])
    // And nothing reached outside the enum.
    for (const c of reached) expect(FndCodeSchema.options).toContain(c)
  })
})
