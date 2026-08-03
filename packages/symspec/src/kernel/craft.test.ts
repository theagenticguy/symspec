/**
 * The craft corpus, GROUNDED — every claim re-run against the live detectors.
 *
 * ## Why this file has to exist
 *
 * A craft section is prose about behavior, and prose about behavior rots. The donor
 * shipped `GTWR_R20_PURPOSE` telling authors to "move rationale to a separate
 * attribute" — a field that did not exist — and nothing failed, because no test
 * connected the advice to the tool.
 *
 * So every anti-pattern's `fires` array is re-derived here by running the ACTUAL
 * detector on the ACTUAL example text. A rule that stops firing, starts firing on the
 * "good" rewrite, or changes severity is a test failure. And the three claims that
 * contradict the obvious guess (`quickly` fires nothing; a compound fires R19 not R18;
 * R33 fires even WITH a tolerance) get their own named assertions, because those are
 * the ones a future reader is most likely to "correct".
 *
 * The worked example is re-run end to end against a real Z3 boot, so its two measured
 * outcomes — a clean check over a flat contradiction, then a proven
 * `FND_CONTRADICTION` after one antonym op — cannot decay into a plausible fiction.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { emptyDocument, type RequirementsDocument } from '../core/document.ts'
import { DocPath, DocStore, makeDocPath } from '../core/store.ts'
import type { Requirement as DonorRequirement } from '../donor/core/schema.ts'
import { detectAmbiguity } from '../donor/formal/ambiguity.ts'
import { checkGtWRules, checkGtWRulesSet } from '../donor/lint/gtwr.ts'
import { asView } from '../donor/solvers/types.ts'
import { embedderLayerOf, stubEmbedder } from '../formal/embedder.ts'
import { solverServiceLayer } from '../formal/solver-service.ts'
import { ErrDocNotFound } from '../kernel/errors.ts'
import { runOperation } from '../kernel/operation.ts'
import { type CheckPayload, checkOp } from '../operations/check.ts'
import { applyOpDefinition } from '../operations/mutation.ts'
import { parseOp } from '../operations/parse.ts'
import { StreamSource } from '../operations/stream.ts'
import { lookupCode } from './catalog.ts'
import { ANTI_PATTERNS, CRAFT_SECTIONS, craftCodes, craftContents, renderCraft } from './craft.ts'

// ---------------------------------------------------------------------------
// Running a sentence through the real lint tier
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z'

/**
 * A donor-shaped requirement carrying `sentence`, for the lint detectors.
 *
 * The lint tier reads the RENDERED sentence, so the slots only have to be
 * structurally valid — what is under test is the text.
 */
const linted = (sentence: string): DonorRequirement =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    patternType: 'event-driven',
    trigger: 'the operator confirms the plan',
    systemName: 'scheduler',
    systemResponse: 'enqueue the job',
    negated: false,
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: TS,
    updatedAt: TS,
    sentence,
  }) as DonorRequirement

/** Every GtWR code one sentence provokes, deduplicated, in emission order. */
const gtwrCodes = (sentence: string): readonly string[] => [
  ...new Set(checkGtWRules(linted(sentence), sentence).map((f) => f.code)),
]

/** Every ambiguity-tier code one sentence provokes. */
const ambiguityCodes = (sentence: string): readonly string[] => [
  ...new Set(detectAmbiguity([asView(linted(sentence))]).map((f) => f.code)),
]

// ---------------------------------------------------------------------------
// The corpus's own invariants
// ---------------------------------------------------------------------------

describe('the craft corpus is well-formed', () => {
  it('ships the five sections the spec names, in author order', () => {
    expect(CRAFT_SECTIONS.map((s) => s.id)).toEqual([
      'ears-pattern-selection',
      'vocabulary-alignment-first',
      'decomposition',
      'anti-patterns',
      'worked-example',
    ])
  })

  it('gives every section a title, a summary, and a substantial body', () => {
    for (const section of CRAFT_SECTIONS) {
      expect(section.title.length, section.id).toBeGreaterThan(10)
      expect(section.summary.length, section.id).toBeGreaterThan(20)
      // A section shorter than this is a heading with a sentence under it, which is
      // what the ~85%-reference-tables assessment was complaining about.
      expect(section.body.length, section.id).toBeGreaterThan(600)
    }
  })

  /**
   * THE `GTWR_R20_PURPOSE` GUARD: the donor taught authors to use a field that did not
   * exist. A craft section naming a code the tool cannot emit is the same defect, and
   * this is what makes it impossible.
   */
  it('names only codes that EXIST in the unified catalog', () => {
    const codes = craftCodes()
    expect(codes.length).toBeGreaterThan(15)
    for (const code of codes) {
      expect(lookupCode(code), `craft names ${code}, which no catalog holds`).toBeDefined()
    }
  })

  it('renders at both heading depths without leaking the wrong level', () => {
    const atTwo = renderCraft(2)
    const atThree = renderCraft(3)
    expect(atTwo).toContain('## Choosing an EARS pattern')
    expect(atThree).toContain('### Choosing an EARS pattern')
    // The anti-pattern body carries its own sub-headings; they must sit one level
    // under whatever depth the caller asked for, in BOTH renderings.
    expect(atTwo).toContain('### Compound requirement')
    expect(atThree).toContain('#### Compound requirement')
    // And no stray `##` heading survives at the deeper depth.
    expect(/^## /m.test(atThree), 'depth-3 render leaked a depth-2 heading').toBe(false)
  })

  it('is deterministic — the same corpus renders the same bytes', () => {
    expect(renderCraft(2)).toBe(renderCraft(2))
  })

  it('exposes a contents projection covering every section', () => {
    expect(craftContents()).toHaveLength(CRAFT_SECTIONS.length)
    for (const row of craftContents()) {
      expect(row.title.length).toBeGreaterThan(0)
      expect(row.summary.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The anti-pattern catalog, re-derived from the live detectors
// ---------------------------------------------------------------------------

describe('every anti-pattern`s `fires` list matches the LIVE detectors', () => {
  it('covers fifteen smells', () => {
    expect(ANTI_PATTERNS).toHaveLength(15)
    for (const p of ANTI_PATTERNS) {
      expect(p.bad.length, p.name).toBeGreaterThan(20)
      expect(p.good.length, p.name).toBeGreaterThan(20)
      expect(p.note.length, p.name).toBeGreaterThan(80)
      // The rewrite must actually differ, or the row teaches nothing.
      expect(p.good, p.name).not.toBe(p.bad)
    }
  })

  /**
   * The load-bearing assertion in this file. Each `fires` array is compared against
   * what the GtWR tier ACTUALLY emits on that exact sentence — so the catalog cannot
   * claim a code the detector does not produce, and cannot omit one it does.
   *
   * Two entries are set-level or ambiguity-tier rather than per-statement lint, and
   * they are handled by their own named tests below; here they are compared on their
   * per-statement lint codes only, which is what `fires` documents.
   */
  for (const pattern of ANTI_PATTERNS) {
    it(`${pattern.name}: fires exactly what it claims`, () => {
      expect(gtwrCodes(pattern.bad), pattern.name).toEqual([...pattern.fires])
    })
  }

  /**
   * The three claims that contradict the obvious guess get their own assertions, so a
   * future reader who "corrects" one of them breaks a test that names the reason.
   */
  it('CLAIM 1: `quickly` fires NOTHING — the vague check is a lexicon, not a judgment', () => {
    // The single most misleading thing about the lint tier: a clean result on a
    // performance claim does not mean the claim is measurable.
    expect(gtwrCodes('When the request arrives, the api gateway shall respond quickly.')).toEqual(
      [],
    )
    for (const silent of ['rapidly', 'promptly', 'efficiently', 'easily']) {
      expect(
        gtwrCodes(
          `When the operator confirms the plan, the scheduler shall enqueue the job ${silent}.`,
        ),
        silent,
      ).toEqual([])
    }
    // While these DO fire, at error severity — the asymmetry is the point.
    for (const caught of ['fast', 'robust', 'timely', 'minimal', 'adequate', 'flexible']) {
      expect(
        gtwrCodes(
          `When the operator confirms the plan, the scheduler shall enqueue the job ${caught}.`,
        ),
        caught,
      ).toContain('GTWR_R7_VAGUE')
    }
  })

  it('CLAIM 2: a compound fires R19_COMBINATOR at warn, NOT R18_MULTIPLE_SHALL', () => {
    const compound =
      'When the user submits the order, the checkout service shall reserve the inventory and charge the payment method.'
    const findings = checkGtWRules(linted(compound), compound)
    const codes = findings.map((f) => f.code)
    expect(codes).toContain('GTWR_R19_COMBINATOR')
    // R18 needs TWO `shall`s. The common compound has one, so the error-severity lint
    // signal an author might expect is simply not there.
    expect(codes).not.toContain('GTWR_R18_MULTIPLE_SHALL')
    // And nothing here is error severity, which is why the section routes authors to
    // the PARSE path instead of relying on lint to stop them.
    expect(findings.every((f) => f.severity !== 'error')).toBe(true)

    // Two `shall`s DOES fire R18, at error — the contrast that makes the claim precise.
    const twoShalls =
      'The auth service shall issue a token and the audit log shall record the grant.'
    const two = checkGtWRules(linted(twoShalls), twoShalls)
    expect(two.some((f) => f.code === 'GTWR_R18_MULTIPLE_SHALL' && f.severity === 'error')).toBe(
      true,
    )
  })

  it('CLAIM 3: R33_MISSING_TOLERANCE fires even WITH a range or a tolerance', () => {
    // So it cannot be silenced by adding one — it is a prompt, not an absence check.
    for (const sentence of [
      'When the request arrives, the api gateway shall respond within 500 ms.',
      'When the request arrives, the api gateway shall respond within 400 ms to 600 ms.',
      'When the request arrives, the api gateway shall respond within 500 ms plus or minus 50 ms.',
    ]) {
      expect(gtwrCodes(sentence), sentence).toContain('GTWR_R33_MISSING_TOLERANCE')
    }
  })

  /**
   * The "good" rewrites have to be better, and "better" has to be checked rather than
   * asserted. Not "fires nothing" — several legitimate rewrites still carry the R33
   * tolerance PROMPT and the R5 article warning, and demanding a clean result would
   * push the catalog toward advice that games the linter instead of improving the
   * requirement.
   *
   * The real property is that no rewrite fires an ERROR, because error severity is what
   * gates the exit code and excludes the requirement from formal analysis.
   */
  it('no `good` rewrite fires an ERROR-severity lint finding', () => {
    for (const pattern of ANTI_PATTERNS) {
      const errors = checkGtWRules(linted(pattern.good), pattern.good).filter(
        (f) => f.severity === 'error',
      )
      expect(
        errors.map((f) => f.code),
        `${pattern.name}: the rewrite still errors`,
      ).toEqual([])
    }
  })

  it('each `good` rewrite clears the specific ERROR its `bad` form raised', () => {
    // The narrower claim, per row: whatever error-severity code the anti-pattern
    // provoked must be gone from the rewrite. (Rows whose smell is only warn/info have
    // nothing to clear, and that is fine.)
    for (const pattern of ANTI_PATTERNS) {
      const badErrors = new Set(
        checkGtWRules(linted(pattern.bad), pattern.bad)
          .filter((f) => f.severity === 'error')
          .map((f) => f.code),
      )
      const goodCodes = new Set(gtwrCodes(pattern.good))
      for (const code of badErrors) {
        expect(goodCodes.has(code), `${pattern.name}: rewrite still fires ${code}`).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The claims that live outside the per-statement lint tier
// ---------------------------------------------------------------------------

describe('the set-level and ambiguity-tier claims', () => {
  it('R40_DECIMAL_FORMAT is a SET property — invisible one requirement at a time', () => {
    // The unit-mixing section says precision consistency cannot be seen per-statement.
    const one = 'When the request arrives, the api gateway shall respond within 1.5 seconds.'
    expect(gtwrCodes(one)).not.toContain('GTWR_R40_DECIMAL_FORMAT')

    const two = 'When the batch starts, the scheduler shall finish within 2.25 seconds.'
    const setFindings = checkGtWRulesSet([
      { requirement: linted(one), sentence: one },
      {
        requirement: { ...linted(two), id: '22222222-2222-4222-8222-222222222222' },
        sentence: two,
      },
    ])
    expect(setFindings.map((f) => f.code)).toContain('GTWR_R40_DECIMAL_FORMAT')
  })

  it('the "and/or" row`s ambiguity-tier claim holds', () => {
    // The section says an un-parenthesized coordination also reaches the ambiguity
    // tier. Asserted separately from `fires`, which documents the lint tier only.
    const s =
      'When the operator confirms the plan, the scheduler shall enqueue the job and defer the audit or log the error.'
    expect(ambiguityCodes(s)).toContain('FND_AMBIGUOUS_QUANTIFIER')
  })

  it('the vague-lexicon row`s ambiguity-tier claim holds for `fast`', () => {
    const s = 'When the operator confirms the plan, the scheduler shall enqueue the job fast.'
    expect(ambiguityCodes(s)).toContain('FND_AMBIGUOUS_VAGUE')
    // And NOT for `quickly` — the ambiguity tier has the same lexicon blind spot, so
    // the claim "nothing catches it" is true across BOTH tiers.
    const quiet =
      'When the operator confirms the plan, the scheduler shall enqueue the job quickly.'
    expect(ambiguityCodes(quiet)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The compound-split claim: the parse path really does hand back the ops
// ---------------------------------------------------------------------------

describe('the compound section`s routing advice is real', () => {
  it('`parse` returns ERR_PARSE_COMPOUND WITH apply-ready split ops', async () => {
    // The section tells an author to route a compound through `parse` because lint only
    // warns. That advice is only useful if the parse path actually produces the split.
    const text =
      'When the user submits the order, the checkout service shall reserve the inventory and charge the payment method.'
    // `parseOp` declares a `StreamSource` requirement for its `--file` batch path, so it
    // has to be provided even on the single-sentence path that never reads it. Supplying
    // a reader that throws makes that explicit: this assertion is about the ARGUMENT
    // path, and a version of it that started reading a file would fail loudly rather
    // than silently testing something else.
    const env = await Effect.runPromise(
      runOperation(parseOp, { text, file: null }).pipe(
        Effect.provideService(
          StreamSource,
          StreamSource.of({
            read: () => Effect.die('the argument path must not read a stream'),
          }),
        ),
      ),
    )
    const result = env.data.results[0]
    expect(result?.outcome).toBe('error')
    if (result?.outcome !== 'error') return
    expect(result.code).toBe('ERR_PARSE_COMPOUND')
    // TWO ready-to-apply `add` ops, with the shared trigger carried onto both.
    expect(result.proposedOps).toHaveLength(2)
    expect(env.data.ops).toHaveLength(2)
    for (const op of env.data.ops) {
      expect(op).toMatchObject({ op: 'add', systemName: 'checkout service' })
    }
    // And the responses really are the two halves, not the compound repeated.
    const responses = env.data.ops.map((op) => (op as { systemResponse: string }).systemResponse)
    expect(responses).toEqual(['reserve the inventory', 'charge the payment method'])
  })
})

// ---------------------------------------------------------------------------
// The worked example, re-run end to end
// ---------------------------------------------------------------------------

/**
 * The worked example's two measured outcomes, re-derived against a real Z3 boot.
 *
 * This is the assertion that keeps the most instructive section in the corpus honest.
 * Its whole claim is that a document with a flat contradiction can check CLEAN, and that
 * one antonym op turns the same document into a proven `FND_CONTRADICTION`. If either
 * half stopped being true, the section would be teaching a fiction — and it is the
 * section an author is most likely to trust, because it comes with numbers.
 */
describe('the worked example produces the outcomes it claims', () => {
  const run = async () => {
    let document: RequirementsDocument = emptyDocument()
    let pending = ''

    const layer = Layer.mergeAll(
      Layer.succeed(DocStore)(
        DocStore.of({
          load: (path) =>
            path === 'doc.json'
              ? Effect.succeed({ document, unknownKeys: {}, diagnostics: [] })
              : Effect.fail(
                  new ErrDocNotFound({ error: `no document at ${path}`, suggestions: [] }),
                ),
          save: (_path, input) =>
            Effect.sync(() => {
              document = input.document
            }),
          exists: () => Effect.succeed(true),
        }),
      ),
      Layer.succeed(DocPath)(makeDocPath({})),
      solverServiceLayer,
      embedderLayerOf(stubEmbedder()),
      Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed(pending) })),
    )

    const apply = (ops: readonly Record<string, unknown>[]) => {
      pending = ops.map((op) => JSON.stringify(op)).join('\n')
      return Effect.runPromise(
        runOperation(applyOpDefinition, {
          ops: 'plan.jsonl',
          file: 'doc.json',
          continueOnError: false,
          dryRun: false,
        }).pipe(Effect.provide(layer)),
      )
    }
    const check = (): Promise<CheckPayload> =>
      Effect.runPromise(
        runOperation(checkOp, { file: 'doc.json' }).pipe(Effect.provide(layer)),
      ).then((env) => env.data)

    // STEP 1 — the two contradictory requirements from the section, verbatim.
    await apply([
      {
        op: 'add',
        patternType: 'event-driven',
        trigger: 'the operator confirms the plan',
        systemName: 'scheduler',
        systemResponse: 'start the nightly run',
      },
      {
        op: 'add',
        patternType: 'event-driven',
        trigger: 'the operator confirms the plan',
        systemName: 'scheduler',
        systemResponse: 'halt the nightly run',
      },
    ])
    const before = await check()

    // STEP 2 — the one op that makes the conflict provable.
    await apply([{ op: 'antonym', a: 'start', b: 'halt' }])
    const after = await check()

    return { before, after }
  }

  it('step 1 checks CLEAN over a flat contradiction — the silence trap', async () => {
    const { before } = await run()
    expect(before.counts.error, 'the section claims zero errors before the antonym').toBe(0)
    expect(before.findings).toEqual([])
    expect(before.verified).toBe(true)
    // The ONLY visible tell, and the number the section points at.
    expect(before.progress.atomsUncompared).toBe(2)
    expect(before.pairsChecked).toBe(1)
  }, 60_000)

  it('step 2 PROVES the contradiction after one antonym op', async () => {
    const { after } = await run()
    const contradictions = after.findings.filter((f) => f.code === 'FND_CONTRADICTION')
    expect(contradictions.length, 'the section claims a proven contradiction').toBeGreaterThan(0)
    expect(after.counts.error).toBe(1)
    // Both culprits named — the section says so, and a finding naming one would be a
    // localization regression.
    expect(new Set(contradictions.flatMap((f) => f.requirementIds)).size).toBe(2)
    // The atoms unified, which is the mechanism the section explains.
    expect(after.progress.atomsUncompared).toBe(0)
    expect(after.progress.openFindings).toBe(1)
    // `verified` stays TRUE, and the section explains why: it answers "was consistency
    // CHECKED", not "is the document clean".
    expect(after.verified).toBe(true)
  }, 60_000)
})
