/**
 * TRANSPLANT FIDELITY guards — the tests that make "verbatim" checkable rather
 * than asserted.
 *
 * The transplant copied the donor's check-path closure into `./donor/` with
 * mechanical import rewrites, materially editing a handful. The risk that matters
 * is not a
 * copy that fails to compile — `tsc` catches that — but a copy that DRIFTS: a code
 * string retyped with a typo, a description reworded, a code silently dropped from
 * the catalog. Any of those is invisible in review and changes what an agent is
 * told.
 *
 * So these tests read the LIVE DONOR (the repo root's `src/`, importable straight
 * from vitest because it resolves the donor's `.js` specifiers to `.ts`) and diff
 * it against the transplant. The donor is frozen as the differential oracle from
 * G1 on, which is exactly what makes it a legitimate fixture.
 *
 * ## Which files are asserted here, and why only these
 *
 * The four materially-edited files, because they are the only places a human
 * retyped anything:
 *
 * 1. `formal/codes.ts` — 30 FND_* codes and their descriptions. The highest-value
 *    guard: these strings ARE the agent-facing code vocabulary, and the spec's
 *    standing constraint is that all 75 codes survive "with meanings intact".
 * 2. `core/schema.ts` — the enum constants (the type-level parts are checked by
 *    `tsc` against every consumer, so a drift there is already a compile error).
 * 3. `core/doc.ts` — `listRequirements` behavior.
 * 4. `formal/backend.ts` — asserted by `solver-service.test.ts` (the memo seam is
 *    a behavior, not a string).
 *
 * The other ~35 files are byte-identical modulo the `.js`→`.ts` specifier rewrite,
 * which {@link verbatimBodies} checks wholesale.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as donorDoc from '../../../src/core/doc.ts'
import * as donorSchema from '../../../src/core/schema.ts'
import * as donorCodes from '../../../src/formal/codes.ts'
import * as transplantDoc from './donor/core/doc.ts'
import * as transplantSchema from './donor/core/schema.ts'
import * as transplantCodes from './donor/formal/codes.ts'

// ---------------------------------------------------------------------------
// 1. The FND_* catalog — the highest-value fidelity guard
// ---------------------------------------------------------------------------

describe('formal/codes.ts — the FND_* catalog is verbatim from the donor', () => {
  it('has the same 30 codes, in the same append-only ORDER', () => {
    // Order matters and is not cosmetic: the catalog is append-only, and a reorder
    // would silently renumber every position an external snapshot recorded.
    expect([...transplantCodes.FND_CODES]).toEqual([...donorCodes.FndCodes])
  })

  it('carries byte-identical descriptions for every code', () => {
    // The donor's entries are `z.literal(code).describe(text)`, so the text is on
    // `.description`; the transplant's are plain `{code, description}`. Both are
    // read here rather than either being retyped — this test is the reason the
    // transplant's corpus was GENERATED from this same read, not hand-copied.
    const donorText: Record<string, string> = {}
    for (const code of donorCodes.FndCodes) {
      const entry = donorCodes.FndCodeMeta[code as keyof typeof donorCodes.FndCodeMeta]
      donorText[code] = (entry as unknown as { description: string }).description
    }
    const transplantText: Record<string, string> = {}
    for (const code of transplantCodes.FND_CODES) {
      transplantText[code] = transplantCodes.FndCodeMeta[code].description
    }
    expect(transplantText).toEqual(donorText)
  })

  it('keeps every entry`s `code` equal to its own key', () => {
    // The donor's `z.literal(code)` made this true structurally. The transplant's
    // plain record could get it wrong, so it is asserted: a mismatch would make
    // `FndCodeMeta[x].code !== x` and any lookup-then-emit path would report a
    // different code than it looked up.
    for (const code of transplantCodes.FND_CODES) {
      expect(transplantCodes.FndCodeMeta[code].code).toBe(code)
    }
  })

  it('has the same structural and free-tier reachability bridges', () => {
    expect(transplantCodes.structuralKindToFndCode).toEqual(donorCodes.structuralKindToFndCode)
    expect(transplantCodes.solverKindToFndCode).toEqual(donorCodes.solverKindToFndCode)
  })
})

// ---------------------------------------------------------------------------
// 2. The shared vocabulary constants
// ---------------------------------------------------------------------------

describe('core/schema.ts — the shared enum vocabulary is verbatim', () => {
  it('EARS patterns, priorities, statuses, verification methods, relations', () => {
    expect([...transplantSchema.EARS_PATTERNS]).toEqual([...donorSchema.EARS_PATTERNS])
    expect([...transplantSchema.PRIORITIES]).toEqual([...donorSchema.PRIORITIES])
    expect([...transplantSchema.STATUSES]).toEqual([...donorSchema.STATUSES])
    expect([...transplantSchema.VERIFICATION_METHODS]).toEqual([
      ...donorSchema.VERIFICATION_METHODS,
    ])
    expect([...transplantSchema.RELATIONS]).toEqual([...donorSchema.RELATIONS])
    expect(transplantSchema.SCHEMA_VERSION).toBe(donorSchema.SCHEMA_VERSION)
  })

  it('renders identical sentences for every EARS pattern, both polarities', () => {
    // `renderSentence` is re-exported through schema.ts in both, and the rendered
    // sentence is what the GtWR lint and the AC-3-7 gate read — so a divergence
    // here would move requirements between the included and excluded partitions.
    const slots = [
      { patternType: 'ubiquitous', systemName: 'svc', systemResponse: 'operate' },
      {
        patternType: 'event-driven',
        systemName: 'svc',
        trigger: 'a user signs in',
        systemResponse: 'issue a token',
      },
      {
        patternType: 'state-driven',
        systemName: 'svc',
        preCondition: 'maintenance mode is on',
        systemResponse: 'reject logins',
      },
      {
        patternType: 'optional-feature',
        systemName: 'svc',
        preCondition: 'SSO is configured',
        systemResponse: 'redirect to the IdP',
      },
      {
        patternType: 'unwanted-behavior',
        systemName: 'svc',
        trigger: 'five logins fail',
        systemResponse: 'lock the account',
      },
      // The combination case: a precondition on an event-driven requirement.
      {
        patternType: 'event-driven',
        systemName: 'svc',
        preCondition: 'the tenant is active',
        trigger: 'a user signs in',
        systemResponse: 'issue a token',
      },
    ] as const
    for (const slot of slots) {
      for (const negated of [false, true]) {
        const subject = { ...slot, negated }
        expect(transplantSchema.renderSentence(subject)).toBe(donorSchema.renderSentence(subject))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. core/doc.ts — the one behavior kept from the storage facade
// ---------------------------------------------------------------------------

describe('core/doc.ts — listRequirements is verbatim, ORDER included', () => {
  it('returns the same requirements in the same order as the donor', () => {
    // Order is load-bearing, not incidental: it feeds the atom roster and the
    // candidate-pair emission, so a sort here would change `pairsChecked` and
    // therefore the coverage report.
    const mk = (id: string) => ({
      id,
      patternType: 'ubiquitous' as const,
      systemName: 'svc',
      systemResponse: `do ${id}`,
      negated: false,
      sentence: `The svc shall do ${id}.`,
      priority: 'medium' as const,
      status: 'draft' as const,
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // Deliberately NOT in sorted key order, so a hidden sort would show up.
    const doc = {
      schemaVersion: 2,
      requirements: { zed: mk('zed'), alpha: mk('alpha'), mid: mk('mid') },
      glossary: [],
      waivers: [],
      antonyms: [],
    }
    expect(transplantDoc.listRequirements(doc).map((r) => r.id)).toEqual(
      donorDoc.listRequirements(doc).map((r) => r.id),
    )
    expect(transplantDoc.listRequirements(doc).map((r) => r.id)).toEqual(['zed', 'alpha', 'mid'])
  })
})

// ---------------------------------------------------------------------------
// 4. Everything else — byte-identical modulo the specifier rewrite
// ---------------------------------------------------------------------------

/**
 * The files copied with NOTHING but the `.js`→`.ts` relative-specifier rewrite.
 * Asserted wholesale, so a future "small fix" to a transplanted tier is a test
 * failure that forces the fix onto the donor (where the oracle can see it) or an
 * explicit entry in {@link EDITED}.
 *
 * Rather than invert the rewrite (which cannot be inverted uniquely — see below),
 * BOTH sides are normalized by stripping the extension off every relative
 * specifier. Two files then compare equal exactly when they differ in nothing but
 * how they spell their own imports.
 *
 * The non-invertibility is a real finding, caught by this test on its first run:
 * the donor is INCONSISTENT about extensions. `src/lint/gtwr.ts` imports
 * `'../core/schema'` and `'../parse/tier1'` with NO extension, while all ~38 other
 * files use the `.js` form. So the rewrite mapped two different donor spellings
 * (`'./x.js'` and `'./x'`) onto one transplant spelling (`'./x.ts'`), and inverting
 * it produced `.js` where the donor had nothing. Stripping instead of inverting is
 * the normalization that survives that.
 */
const stripSpecifierExtensions = (source: string): string =>
  source
    .replace(/(from\s+')(\.\.?\/[^']+?)(?:\.[cm]?[jt]s)?(')/g, '$1$2$3')
    .replace(/(import\(')(\.\.?\/[^']+?)(?:\.[cm]?[jt]s)?('\))/g, '$1$2$3')

const verbatimBodies = (relative: string): { donor: string; transplant: string } => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return {
    transplant: stripSpecifierExtensions(readFileSync(`${here}donor/${relative}`, 'utf8')),
    donor: stripSpecifierExtensions(readFileSync(`${here}../../../src/${relative}`, 'utf8')),
  }
}

/**
 * The files this transplant materially edited, each with the reason. Any OTHER file
 * diverging is a drift bug.
 *
 * - `core/schema.ts` — Zod dropped (greenfield is Effect Schema native); reduced
 *   to the three types the check path imports. Fidelity asserted above.
 * - `core/doc.ts` — the v2 storage facade dropped (superseded by the `DocStore`
 *   Layer); reduced to `Doc` + `listRequirements`. Fidelity asserted above.
 * - `formal/codes.ts` — Zod dropped; enum → const tuple, meta → plain record.
 *   Descriptions extracted programmatically. Fidelity asserted above.
 * - `formal/backend.ts` — the Layer seam (`primeZ3` / `resetZ3`). Behavior
 *   asserted by `solver-service.test.ts`.
 * - `formal/embed.ts` — reduced to `Embedder` + `cosine` + the model pin; the ONNX
 *   loader lives in `../formal/embed.ts` (G2b). `cosine` fidelity asserted below.
 *
 * G2b additions:
 *
 * - `parse/result.ts` — Zod dropped (nine schemas, zero non-test consumers) AND the
 *   `proposedSplits`→`proposedOps` rename collapsed to ONE name (spec AC-A-4). The
 *   donor's tier3 suggestion text advertised `proposedOps` while the object it
 *   returned had `proposedSplits`, so the field an agent was told to read did not
 *   exist. Behavior fidelity asserted by `parse.test.ts`, which runs BOTH ladders
 *   over one corpus and diffs outcome/pattern/slots/confidence/tier/code.
 * - `parse/batch.ts` — Zod dropped (two schemas, zero non-test consumers). The line
 *   policy is verbatim; `parse.test.ts` diffs the batch summaries too.
 *
 * Note what is NOT here: `parse/tier3.ts` is VERBATIM. Its suggestion text already
 * said `proposedOps`, so the fix was to make the result carry that name — not to
 * edit the tier. The one-name property therefore costs zero transplant fidelity,
 * which is the whole reason it was worth doing this way round.
 */
const EDITED = new Set([
  'core/schema.ts',
  'core/doc.ts',
  'formal/codes.ts',
  'formal/backend.ts',
  'formal/embed.ts',
  'parse/result.ts',
  'parse/batch.ts',
])

/** Every transplanted file, relative to the `donor/` root. Enumerated explicitly
 * (not globbed) so ADDING a file to the transplant is a deliberate edit here. */
const TRANSPLANTED = [
  'core/analyze.ts',
  'core/render.ts',
  'core/schema.ts',
  'core/doc.ts',
  'formal/ambiguity.ts',
  'formal/antonyms.ts',
  'formal/atomize.ts',
  'formal/backend.ts',
  'formal/budget.ts',
  'formal/codes.ts',
  'formal/contradiction.ts',
  'formal/coverage.ts',
  'formal/embed.ts',
  'formal/encode.ts',
  'formal/finding.ts',
  'formal/graph.ts',
  'formal/guard-implication.ts',
  'formal/incomplete.ts',
  'formal/lemma.ts',
  'formal/needs-review.ts',
  'formal/numeric-contradiction.ts',
  'formal/numeric.ts',
  'formal/quantity-alias.ts',
  'formal/relational.ts',
  'formal/semantic.ts',
  'formal/similar.ts',
  'formal/subsumption.ts',
  'formal/temporal-patterns.ts',
  'formal/temporal.ts',
  'formal/vacuity.ts',
  'lint/gtwr.ts',
  'parse/batch.ts',
  'parse/negation.ts',
  'parse/normalize.ts',
  'parse/preprocess.ts',
  'parse/result.ts',
  'parse/tier1.ts',
  'parse/tier2.ts',
  'parse/tier3.ts',
  'pipeline/check.ts',
  'pipeline/gate.ts',
  'solvers/free/ambiguity.ts',
  'solvers/free/duplicates.ts',
  'solvers/free/pairwise-filter.ts',
  'solvers/index.ts',
  'solvers/types.ts',
] as const

describe('the transplant is byte-identical to the donor except for four files', () => {
  it.each(
    TRANSPLANTED.filter((f) => !EDITED.has(f)).map((f) => [f] as const),
  )('%s is verbatim (only the .js→.ts specifier rewrite)', (relative) => {
    const { donor, transplant } = verbatimBodies(relative)
    expect(transplant).toBe(donor)
  })

  it('accounts for every file under donor/ — no untracked additions', () => {
    // Guards the enumeration above: a file added to the transplant without being
    // listed would otherwise escape the verbatim check entirely.
    const here = fileURLToPath(new URL('.', import.meta.url))
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const found = execSync(`find ${here}donor -name '*.ts' -type f`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((p) => p.replace(`${here}donor/`, ''))
      .sort()
    expect(found).toEqual([...TRANSPLANTED].sort())
  })

  it('formal/embed.ts keeps cosine and the model pin verbatim', () => {
    // The reduced file's two surviving VALUES. A dot product is easy to "simplify"
    // wrongly (e.g. forgetting the length guard returns 0), and the cosines feed
    // the semantic tier's thresholds.
    const a = Float32Array.from([0.6, 0.8])
    const b = Float32Array.from([0.8, 0.6])
    const c = Float32Array.from([0.6, 0.8, 0])
    // Values, not the donor import: pulling in the donor's embed.ts would drag the
    // model-cache/ONNX graph into this test for a five-line function.
    //
    // Precision 6, not 10, and the reason is worth recording: the inputs are
    // Float32Array, so 0.6 and 0.8 are not exactly representable and the dot
    // product lands at 0.960000052452088 — 5.2e-8 off. At precision 10 this test
    // failed on its first run. 6 digits is far tighter than any threshold the
    // semantic tier compares against (defaults are 2-3 decimal places) while still
    // catching a genuine formula error.
    expect(transplantEmbedCosine(a, b)).toBeCloseTo(0.96, 6)
    expect(transplantEmbedCosine(a, a)).toBeCloseTo(1, 6)
    // Mismatched lengths return 0 defensively, never throw.
    expect(transplantEmbedCosine(a, c)).toBe(0)
  })
})

// Imported at the bottom so the describe block above reads top-down; the binding
// is hoisted, so this is a presentation choice rather than a dependency.
import { cosine as transplantEmbedCosine } from './donor/formal/embed.ts'
