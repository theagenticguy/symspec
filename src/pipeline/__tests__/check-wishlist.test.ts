/**
 * Wishlist features layered onto `runCheck` (see `pipeline/check.ts`):
 *
 *   #6 FND_NO_PAIRS_CHECKED — an info disclosure emitted when the formal tier
 *      compared zero candidate pairs on a doc that had ≥2 requirements to relate,
 *      so the coverage gap is visible in `findings[]` rather than only in the
 *      numeric `pairsChecked` field. Guarded by `requirements.length >= 2`.
 *
 *   #3 Waiver honoring — a committed `doc.waivers[]` entry drops matching findings
 *      from `findings[]` AND from `counts` (so the exit gate honors it) BEFORE
 *      tallying, incrementing the report's `waived` counter. Document-wide waivers
 *      bite every finding of the code; scoped waivers only bite findings that name
 *      the scoped requirement.
 *
 *   #5 filterReport — a presentation-only projection: `minSeverity` hides
 *      lower-severity noise (never an error, since `error` tops the order),
 *      `findingsOnly` drops the heavy `excluded` table, and NEITHER touches
 *      `counts`, so the exit code is invariant under filtering.
 *
 * These fixtures follow the same conventions as `check.test.ts` (a `req` builder
 * with rendered sentences, a `docOf` map builder, `byCode`). The docs are built
 * with deliberately disjoint vocabulary where a zero-pair formal tier is wanted,
 * and with a bare-number response where a deterministic GTWR_R6 error is wanted.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import { type CheckFinding, filterReport, runCheck } from '../check.js'

function req(partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement {
  const base: Requirement = {
    id: partial.id,
    patternType: partial.patternType ?? 'event-driven',
    systemName: partial.systemName ?? 'auth service',
    systemResponse: partial.systemResponse ?? 'issue a session token',
    negated: partial.negated ?? false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    ...(partial.trigger !== undefined ? { trigger: partial.trigger } : {}),
    ...(partial.preCondition !== undefined ? { preCondition: partial.preCondition } : {}),
    ...(partial.derives !== undefined ? { derives: partial.derives } : {}),
  }
  base.sentence = renderSentence(base)
  return base
}

function docOf(reqs: Requirement[]): RequirementsDoc {
  const doc = emptyDoc()
  for (const r of reqs) doc.requirements[r.id] = r
  return doc
}

function byCode(findings: CheckFinding[], code: string): CheckFinding[] {
  return findings.filter((f) => f.code === code)
}

/**
 * Deterministic fake embedder for tests that assert `verified: true` — the
 * hardened predicate demotes when the semantic/opposition tier did not run
 * (clause d), so those tests supply an embedder. Orthogonal-ish vectors keep
 * cosines low so no accidental FND_SIMILAR_SEMANTIC/opposition noise fires.
 */
const fakeEmbedder: import('../../formal/embed.js').Embedder = async (texts) =>
  texts.map((t, i) => {
    const v = new Float32Array(4)
    v[i % 4] = 1
    v[3] = t.length % 2 === 0 ? 0.01 : 0.02
    return v
  })
const withSemantic = { semantic: { embedder: fakeEmbedder } }

/** Two requirements with totally disjoint vocabulary → the formal tier compares 0 pairs. */
function disjointDoc(): { doc: RequirementsDoc; ids: { a: string; b: string } } {
  const ids = { a: randomUUID(), b: randomUUID() }
  const doc = docOf([
    req({
      id: ids.a,
      patternType: 'ubiquitous',
      systemName: 'alpha',
      systemResponse: 'emit a photon',
    }),
    req({
      id: ids.b,
      patternType: 'ubiquitous',
      systemName: 'beta',
      systemResponse: 'rotate the turbine',
    }),
  ])
  return { doc, ids }
}

/** A single requirement whose bare-number response deterministically fires GTWR_R6 (error). */
function bareNumberDoc(): { doc: RequirementsDoc; id: string } {
  const id = randomUUID()
  const doc = docOf([
    req({ id, patternType: 'ubiquitous', systemName: 'store', systemResponse: 'store 42 records' }),
  ])
  return { doc, id }
}

describe('wishlist #6 — FND_NO_PAIRS_CHECKED info finding', () => {
  it('emits exactly one info/formal finding when ≥2 requirements share no atoms (pairsChecked === 0)', async () => {
    const { doc, ids } = disjointDoc()
    const report = await runCheck(doc)

    expect(report.pairsChecked).toBe(0)

    const coverage = byCode(report.findings, 'FND_NO_PAIRS_CHECKED')
    expect(coverage).toHaveLength(1)
    expect(coverage[0]!.severity).toBe('info')
    expect(coverage[0]!.tier).toBe('formal')
    // Names the whole uncompared set.
    expect([...coverage[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
  })

  it('does NOT emit FND_NO_PAIRS_CHECKED for a single-requirement doc (length < 2 guard)', async () => {
    // One requirement can never form a pair, but the >=2 guard means the
    // disclosure would be misleading noise, so it must stay silent.
    const doc = docOf([
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'alpha',
        systemResponse: 'emit a photon',
      }),
    ])
    const report = await runCheck(doc)

    expect(report.pairsChecked).toBe(0)
    expect(byCode(report.findings, 'FND_NO_PAIRS_CHECKED')).toHaveLength(0)
  })

  it('does NOT emit FND_NO_PAIRS_CHECKED when the formal tier actually compared a pair (pairsChecked > 0)', async () => {
    // Two requirements sharing a trigger + response atom form one candidate pair,
    // so the coverage gap does not exist and the disclosure must be absent.
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'not issue a session token' }),
    ])
    const report = await runCheck(doc)

    expect(report.pairsChecked).toBeGreaterThan(0)
    expect(byCode(report.findings, 'FND_NO_PAIRS_CHECKED')).toHaveLength(0)
  })

  it('suppresses FND_NO_PAIRS_CHECKED when a cross-requirement conflict fired despite pairsChecked === 0 (item 4)', async () => {
    // The numeric tier reasons over ALL requirements, independent of the
    // pairwise candidate filter that feeds pairsChecked. Two disjoint-vocabulary
    // responses ("within 2 seconds" vs "over 3000 ms") share no atom, so
    // pairsChecked === 0 — yet the numeric tier proves an FND_NUMERIC_CONTRADICTION
    // error across the two. Emitting "nothing was compared across requirements"
    // alongside that proven cross-requirement error is contradictory, so the
    // info disclosure must be suppressed.
    const ids = { a: randomUUID(), b: randomUUID() }
    const doc = docOf([
      req({
        id: ids.a,
        patternType: 'ubiquitous',
        systemName: 'api',
        systemResponse: 'respond within 2 seconds',
      }),
      req({
        id: ids.b,
        patternType: 'ubiquitous',
        systemName: 'api',
        systemResponse: 'respond over 3000 ms',
      }),
    ])
    const report = await runCheck(doc)

    // The cross-requirement error genuinely fired at pairsChecked === 0.
    expect(report.pairsChecked).toBe(0)
    const numeric = byCode(report.findings, 'FND_NUMERIC_CONTRADICTION')
    expect(numeric).toHaveLength(1)
    expect(numeric[0]!.requirementIds.length).toBeGreaterThanOrEqual(2)

    // The contradictory info disclosure is suppressed.
    expect(byCode(report.findings, 'FND_NO_PAIRS_CHECKED')).toHaveLength(0)
  })

  it('still emits FND_NO_PAIRS_CHECKED when only single-requirement findings fired (nothing cross-req)', async () => {
    // A bare-number response fires GTWR (lint) + FND_AMBIGUOUS/numeric-tolerance
    // findings that each name exactly ONE requirement. Since no finding spans ≥2
    // requirements and no cross-requirement conflict code fired, the disclosure
    // that truly nothing was compared across requirements must still appear.
    const { doc } = disjointDoc()
    const report = await runCheck(doc)

    expect(report.pairsChecked).toBe(0)
    // No finding OTHER than the disclosure itself spans ≥2 requirements, so
    // nothing cross-requirement fired and the disclosure is truthful.
    expect(
      report.findings
        .filter((f) => f.code !== 'FND_NO_PAIRS_CHECKED')
        .every((f) => f.requirementIds.length < 2),
    ).toBe(true)
    expect(byCode(report.findings, 'FND_NO_PAIRS_CHECKED')).toHaveLength(1)
  })
})

describe('wishlist #5b — residualRisk rolled-up summary', () => {
  it('reports a clean summary (all zero, pairsChecked>0) when a pair was compared', async () => {
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
    ])
    const report = await runCheck(doc)

    expect(report.residualRisk.pairsChecked).toBe(report.pairsChecked)
    expect(report.residualRisk.pairsChecked).toBeGreaterThan(0)
    expect(report.residualRisk.noPairsChecked).toBe(false)
    expect(report.residualRisk.excludedRequirements).toBe(0)
    expect(report.residualRisk.similarUnunifiedPairs).toBe(0)
    expect(report.residualRisk.semanticSuggestions).toBe(0)
  })

  it('mirrors pairsChecked, noPairsChecked, and unmatchedAtoms for a disjoint doc', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc)

    expect(report.residualRisk.pairsChecked).toBe(0)
    expect(report.residualRisk.noPairsChecked).toBe(true)
    // Two requirements, totally disjoint vocabulary → every atom is a singleton.
    // Each ubiquitous requirement contributes exactly one response atom, and the
    // two atoms differ, so both are unmatched.
    expect(report.residualRisk.unmatchedAtoms).toBe(2)
    expect(report.residualRisk.semanticSuggestions).toBe(0)
  })

  it('counts FND_SIMILAR_UNUNIFIED findings in similarUnunifiedPairs', async () => {
    // Two near-synonym responses ("log the failure" / "record the failure") on
    // the same system + trigger stay on distinct atoms: the Jaccard reporter
    // emits FND_SIMILAR_UNUNIFIED, which the summary must tally.
    // Rule-3 near-duplicate: triggers differ (so Rule 1 does not pre-empt) but
    // the sentences are lexically near-identical (Jaccard ≥ 0.7), and the
    // responses "log" vs "record" stay on distinct atoms → FND_SIMILAR_UNUNIFIED.
    const doc = docOf([
      req({
        id: randomUUID(),
        systemName: 'billing service',
        trigger: 'a payment fails during checkout',
        systemResponse: 'log the payment failure for audit purposes across every region',
      }),
      req({
        id: randomUUID(),
        systemName: 'billing service',
        trigger: 'a payment fails during retry',
        systemResponse: 'record the payment failure for audit purposes across every region',
      }),
    ])
    const report = await runCheck(doc)

    const ununified = byCode(report.findings, 'FND_SIMILAR_UNUNIFIED')
    expect(report.residualRisk.similarUnunifiedPairs).toBe(ununified.length)
    expect(report.residualRisk.similarUnunifiedPairs).toBeGreaterThanOrEqual(1)
  })

  it('reflects gate exclusions in excludedRequirements', async () => {
    // An error-severity escape-clause lint finding excludes that statement from
    // the formal tier, so it appears in `excluded` and the summary counter.
    const doc = docOf([
      req({
        id: randomUUID(),
        trigger: 'the audit log fills',
        systemResponse: 'rotate the log as appropriate',
      }),
      req({
        id: randomUUID(),
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
    ])
    const report = await runCheck(doc)

    expect(report.residualRisk.excludedRequirements).toBe(report.excluded.length)
    expect(report.residualRisk.excludedRequirements).toBeGreaterThan(0)
  })

  it('drops a waived residual-risk finding from the summary too', async () => {
    // Waiving FND_SIMILAR_UNUNIFIED document-wide removes it from findings[] AND
    // from the residual-risk tally — a reviewed baseline reads as lower risk.
    const reqs = [
      req({
        id: randomUUID(),
        systemName: 'billing service',
        trigger: 'a payment fails during checkout',
        systemResponse: 'log the payment failure for audit purposes across every region',
      }),
      req({
        id: randomUUID(),
        systemName: 'billing service',
        trigger: 'a payment fails during retry',
        systemResponse: 'record the payment failure for audit purposes across every region',
      }),
    ]
    const before = await runCheck(docOf(reqs))
    expect(before.residualRisk.similarUnunifiedPairs).toBeGreaterThanOrEqual(1)

    const waivedDoc: RequirementsDoc = {
      ...docOf(reqs),
      waivers: [{ code: 'FND_SIMILAR_UNUNIFIED', reason: 'accepted for this fixture' }],
    }
    const after = await runCheck(waivedDoc)
    expect(byCode(after.findings, 'FND_SIMILAR_UNUNIFIED')).toHaveLength(0)
    expect(after.residualRisk.similarUnunifiedPairs).toBe(0)
  })
})

describe('wishlist #3 — committed waivers drop findings from findings[] and counts', () => {
  it('a document-wide waiver removes the finding, increments `waived`, and clears its count', async () => {
    const { doc } = bareNumberDoc()

    // Baseline: the bare-number GTWR_R6 error is present and counted.
    const before = await runCheck(doc)
    const baseline = byCode(before.findings, 'GTWR_R6_MISSING_UNITS')
    expect(baseline).toHaveLength(1)
    expect(baseline[0]!.severity).toBe('error')
    expect(before.counts.error).toBeGreaterThanOrEqual(1)
    expect(before.waived).toBe(0)

    // Waive it document-wide.
    const waivedDoc: RequirementsDoc = {
      ...doc,
      waivers: [{ code: 'GTWR_R6_MISSING_UNITS', reason: 'accepted for this fixture' }],
    }
    const after = await runCheck(waivedDoc)

    // (a) gone from findings[]
    expect(byCode(after.findings, 'GTWR_R6_MISSING_UNITS')).toHaveLength(0)
    // (b) waived incremented by the number dropped
    expect(after.waived).toBe(before.waived + baseline.length)
    // (c) counts no longer tallies it — a waived ERROR drops the error count,
    //     proving the exit gate honors the waiver.
    expect(after.counts.error).toBe(before.counts.error - baseline.length)
  })

  it('a requirement-scoped waiver drops the finding only when it names that requirement', async () => {
    const { doc, id } = bareNumberDoc()
    const before = await runCheck(doc)
    const baseline = byCode(before.findings, 'GTWR_R6_MISSING_UNITS')
    expect(baseline).toHaveLength(1)

    // Scoped to the requirement that actually carries the finding → drops it.
    const matchingScope: RequirementsDoc = {
      ...doc,
      waivers: [{ code: 'GTWR_R6_MISSING_UNITS', requirementId: id, reason: 'scoped to this req' }],
    }
    const matched = await runCheck(matchingScope)
    expect(byCode(matched.findings, 'GTWR_R6_MISSING_UNITS')).toHaveLength(0)
    expect(matched.waived).toBe(baseline.length)
    expect(matched.counts.error).toBe(before.counts.error - baseline.length)

    // Scoped to a DIFFERENT requirement id → must NOT drop it.
    const otherScope: RequirementsDoc = {
      ...doc,
      waivers: [
        { code: 'GTWR_R6_MISSING_UNITS', requirementId: randomUUID(), reason: 'scoped elsewhere' },
      ],
    }
    const untouched = await runCheck(otherScope)
    expect(byCode(untouched.findings, 'GTWR_R6_MISSING_UNITS')).toHaveLength(1)
    expect(untouched.waived).toBe(0)
    expect(untouched.counts.error).toBe(before.counts.error)
  })
})

describe('wishlist #5 — filterReport presentation projection', () => {
  // A disjoint doc with one planted dangling reference gives findings of ALL
  // three severities: error (FND_DANGLING_REFERENCE), warn (orphan/lint), and
  // info (FND_NO_PAIRS_CHECKED) — the mix filterReport needs to exercise.
  async function mixedReport() {
    const { ids } = disjointDoc()
    const doc = docOf([
      req({
        id: ids.a,
        patternType: 'ubiquitous',
        systemName: 'alpha',
        systemResponse: 'emit a photon',
        derives: [randomUUID()], // dangling → FND_DANGLING_REFERENCE (error)
      }),
      req({
        id: ids.b,
        patternType: 'ubiquitous',
        systemName: 'beta',
        systemResponse: 'rotate the turbine',
      }),
    ])
    return runCheck(doc)
  }

  it('minSeverity:"error" keeps only error findings, drops warn/info, and never touches counts', async () => {
    const report = await mixedReport()
    // Sanity: the fixture really is mixed-severity.
    expect(report.counts.error).toBeGreaterThanOrEqual(1)
    expect(report.counts.warn).toBeGreaterThanOrEqual(1)
    expect(report.counts.info).toBeGreaterThanOrEqual(1)
    const errorCount = report.findings.filter((f) => f.severity === 'error').length

    const filtered = filterReport(report, { minSeverity: 'error' })

    // Only error-severity findings survive.
    expect(filtered.findings.every((f) => f.severity === 'error')).toBe(true)
    expect(filtered.findings.filter((f) => f.severity === 'warn')).toHaveLength(0)
    expect(filtered.findings.filter((f) => f.severity === 'info')).toHaveLength(0)
    // CRITICAL: never drops an error finding.
    expect(filtered.findings.filter((f) => f.severity === 'error')).toHaveLength(errorCount)
    // CRITICAL: counts is the FULL post-waiver tally, untouched by filtering.
    expect(filtered.counts).toEqual(report.counts)
  })

  it('minSeverity:"info" (and the no-filter default) keeps every finding', async () => {
    const report = await mixedReport()

    const explicit = filterReport(report, { minSeverity: 'info' })
    expect(explicit.findings).toEqual(report.findings)

    const noFilter = filterReport(report, {})
    expect(noFilter.findings).toEqual(report.findings)
    expect(noFilter.counts).toEqual(report.counts)
  })

  it('findingsOnly:true empties excluded but leaves findings and counts untouched', async () => {
    // A doc with an error-severity lint finding (escape clause) excludes that
    // statement from the formal tier, populating `excluded`.
    const doc = docOf([
      req({
        id: randomUUID(),
        trigger: 'the audit log fills',
        systemResponse: 'rotate the log as appropriate',
      }),
      req({
        id: randomUUID(),
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
    ])
    const report = await runCheck(doc)
    expect(report.excluded.length).toBeGreaterThan(0)

    const filtered = filterReport(report, { findingsOnly: true })

    expect(filtered.excluded).toEqual([])
    expect(filtered.findings).toEqual(report.findings)
    expect(filtered.counts).toEqual(report.counts)
  })
})

describe('wishlist #5 — data.verified (conclusive vs inconclusive)', () => {
  it('verified:false for an inconclusive run (≥2 reqs, pairsChecked 0, nothing cross-req fired)', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc)

    expect(report.pairsChecked).toBe(0)
    expect(report.verified).toBe(false)
    // The boolean and the disclosure finding never disagree.
    expect(byCode(report.findings, 'FND_NO_PAIRS_CHECKED')).toHaveLength(1)
  })

  it('verified:true when a real pair was compared (semantic tier supplied)', async () => {
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
    ])
    const report = await runCheck(doc, withSemantic)

    expect(report.pairsChecked).toBeGreaterThan(0)
    expect(report.verified).toBe(true)
    expect(report.coverage.demotions).toEqual([])
  })

  it('verified:false WITHOUT the semantic tier — the opposition detector is part of certification', async () => {
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
    ])
    const report = await runCheck(doc)
    expect(report.verified).toBe(false)
    expect(report.coverage.demotions.map((d) => d.reason)).toContain('semantic-tier-skipped')
  })

  it('verified:true (vacuously) for a single-requirement doc — nothing to cross-check', async () => {
    const { doc } = bareNumberDoc()
    const report = await runCheck(doc)
    expect(report.verified).toBe(true)
  })

  it('verified:true when a cross-requirement conflict fired despite pairsChecked 0', async () => {
    // Numeric contradiction across two disjoint-vocabulary reqs at pairsChecked 0
    // still counts as "something was verified across requirements".
    const doc = docOf([
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'api',
        systemResponse: 'respond within 2 seconds',
      }),
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'api',
        systemResponse: 'respond over 3000 ms',
      }),
    ])
    const report = await runCheck(doc, withSemantic)
    expect(report.pairsChecked).toBe(0)
    expect(byCode(report.findings, 'FND_NUMERIC_CONTRADICTION').length).toBeGreaterThan(0)
    expect(report.verified).toBe(true)
  })
})

describe('wishlist #4 — strict coverage gate (strictGate)', () => {
  it('strictGate undefined when no gate was requested (default contract untouched)', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc)
    expect(report.verified).toBe(false)
    expect(report.strictGate).toBeUndefined()
  })

  it('--strict fails (strictGate:fail) on an inconclusive run', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc, { strict: true })
    expect(report.verified).toBe(false)
    expect(report.strictGate).toBe('fail')
  })

  it('--strict passes (strictGate:pass) on a verified run', async () => {
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
    ])
    const report = await runCheck(doc, { strict: true, ...withSemantic })
    expect(report.verified).toBe(true)
    expect(report.strictGate).toBe('pass')
  })

  it('--fail-on-unmatched fails when unmatchedAtoms exceeds the threshold', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc, { failOnUnmatched: 0 })
    // A disjoint doc has multiple singleton atoms → over the 0 threshold.
    expect(report.residualRisk.unmatchedAtoms).toBeGreaterThan(0)
    expect(report.strictGate).toBe('fail')
  })

  it('--fail-on-unmatched passes when unmatchedAtoms is within the threshold', async () => {
    const { doc } = disjointDoc()
    const report = await runCheck(doc, { failOnUnmatched: 1000 })
    expect(report.residualRisk.unmatchedAtoms).toBeLessThanOrEqual(1000)
    expect(report.strictGate).toBe('pass')
  })

  it('either gate tripping fails the run (strict pass + unmatched fail → fail)', async () => {
    // Craft a verified run (strict alone would pass) that still trips the
    // unmatched-atom gate at threshold 0.
    const trigger = 'the user submits valid credentials'
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
    ])
    const report = await runCheck(doc, { strict: true, failOnUnmatched: 0, ...withSemantic })
    expect(report.verified).toBe(true)
    // The two responses are distinct atoms owned by one req each → unmatched > 0.
    expect(report.residualRisk.unmatchedAtoms).toBeGreaterThan(0)
    expect(report.strictGate).toBe('fail')
  })
})

describe('#1 — doc-committed antonym pairs make opposite-word conflicts provable', () => {
  it('open/shut is a FALSE NEGATIVE without the antonym pair (distinct atoms)', async () => {
    const trigger = 'the operator presses the button'
    const doc = docOf([
      req({
        id: randomUUID(),
        systemName: 'valve',
        trigger,
        systemResponse: 'open the bypass valve',
      }),
      req({
        id: randomUUID(),
        systemName: 'valve',
        trigger,
        systemResponse: 'shut the bypass valve',
      }),
    ])
    const report = await runCheck(doc)
    // "open"/"shut" are not in the seed antonym table, so the two responses
    // atomize to DISTINCT atoms and no contradiction is proven.
    expect(byCode(report.findings, 'FND_CONTRADICTION')).toHaveLength(0)
  })

  it('committing `antonym open shut` flips it into a proven FND_CONTRADICTION', async () => {
    const trigger = 'the operator presses the button'
    const ids = { a: randomUUID(), b: randomUUID() }
    const doc = docOf([
      req({ id: ids.a, systemName: 'valve', trigger, systemResponse: 'open the bypass valve' }),
      req({ id: ids.b, systemName: 'valve', trigger, systemResponse: 'shut the bypass valve' }),
    ])
    // The agent-confirmed opposition, committed to the doc.
    doc.antonyms = [{ a: 'open', b: 'shut' }]

    const report = await runCheck(doc)
    const contradictions = byCode(report.findings, 'FND_CONTRADICTION')
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]!.severity).toBe('error')
    expect([...contradictions[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
  })

  it('the same object remainder is required — different objects do NOT unify', async () => {
    const trigger = 'the operator presses the button'
    const doc = docOf([
      req({
        id: randomUUID(),
        systemName: 'valve',
        trigger,
        systemResponse: 'open the bypass valve',
      }),
      req({
        id: randomUUID(),
        systemName: 'valve',
        trigger,
        systemResponse: 'shut the intake port',
      }),
    ])
    doc.antonyms = [{ a: 'open', b: 'shut' }]
    const report = await runCheck(doc)
    // open/shut unify on the verb head, but "bypass valve" ≠ "intake port", so
    // no contradiction — the conservative object-remainder rule holds.
    expect(byCode(report.findings, 'FND_CONTRADICTION')).toHaveLength(0)
  })

  it('a doc antonym pair sharing a member with the seeds folds into one class', async () => {
    // The seeds have grant↔revoke. Committing deny↔grant makes deny share the
    // grant/revoke class: deny lands on the same polarity side as revoke.
    const trigger = 'the request arrives'
    const ids = { a: randomUUID(), b: randomUUID() }
    const doc = docOf([
      req({ id: ids.a, systemName: 'gateway', trigger, systemResponse: 'grant the request' }),
      req({ id: ids.b, systemName: 'gateway', trigger, systemResponse: 'deny the request' }),
    ])
    doc.antonyms = [{ a: 'grant', b: 'deny' }]
    const report = await runCheck(doc)
    const contradictions = byCode(report.findings, 'FND_CONTRADICTION')
    expect(contradictions).toHaveLength(1)
    expect([...contradictions[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
  })
})

describe('#3 — quantity aliases make same-quantity-two-ways numeric conflicts provable', () => {
  it('"keep valid for ≤3600s" vs "expire after ≥7200s" is a FALSE NEGATIVE without a quantity alias', async () => {
    const doc = docOf([
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'keep valid for at most 3600 s',
      }),
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'expire after at least 7200 s',
      }),
    ])
    const report = await runCheck(doc)
    // Distinct quantity labels ("keep valid" vs "expire after") ⇒ different keys
    // ⇒ the LIA/LRA solver never compares them.
    expect(byCode(report.findings, 'FND_NUMERIC_CONTRADICTION')).toHaveLength(0)
  })

  it('a committed glossary alias collapses them onto one quantity and proves FND_NUMERIC_CONTRADICTION', async () => {
    const ids = { a: randomUUID(), b: randomUUID() }
    const doc = docOf([
      req({
        id: ids.a,
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'keep valid for at most 3600 s',
      }),
      req({
        id: ids.b,
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'expire after at least 7200 s',
      }),
    ])
    // Agent confirms the two phrasings name the same quantity (canonical "keep
    // valid", alias "expire after"). Unit normalization already handles s↔ms;
    // the alias is what makes the two predicates share a Real variable.
    doc.glossary = [{ canonical: 'keep valid', aliases: ['expire after'] }]

    const report = await runCheck(doc)
    const numeric = byCode(report.findings, 'FND_NUMERIC_CONTRADICTION')
    expect(numeric).toHaveLength(1)
    expect(numeric[0]!.severity).toBe('error')
    expect([...numeric[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
  })

  it('unit drift across the alias still normalizes (≤3600s vs ≥2h are consistent, not a conflict)', async () => {
    // 3600 s = 3,600,000 ms; 2 h = 7,200,000 ms. "at most 3600 s" and "at least
    // 2 h" over one quantity are 3.6M ms <= q and q >= 7.2M ms → UNSAT.
    const ids = { a: randomUUID(), b: randomUUID() }
    const doc = docOf([
      req({
        id: ids.a,
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'keep valid for at most 3600 s',
      }),
      req({
        id: ids.b,
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'expire after at least 2 h',
      }),
    ])
    doc.glossary = [{ canonical: 'keep valid', aliases: ['expire after'] }]
    const report = await runCheck(doc)
    // Confirms unit normalization composes with the alias: the conflict is still
    // proven across the s↔h drift.
    expect(byCode(report.findings, 'FND_NUMERIC_CONTRADICTION')).toHaveLength(1)
  })

  it('a non-conflicting same-quantity pair via the alias does NOT fire', async () => {
    const doc = docOf([
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'keep valid for at most 7200 s',
      }),
      req({
        id: randomUUID(),
        patternType: 'ubiquitous',
        systemName: 'token',
        systemResponse: 'expire after at least 3600 s',
      }),
    ])
    doc.glossary = [{ canonical: 'keep valid', aliases: ['expire after'] }]
    const report = await runCheck(doc)
    // q <= 7.2M ms AND q >= 3.6M ms is SATISFIABLE → no contradiction.
    expect(byCode(report.findings, 'FND_NUMERIC_CONTRADICTION')).toHaveLength(0)
  })
})

describe('#5 hardening — a propose-only fuzzy finding must NOT flip verified (adversarial review)', () => {
  it('an opposition candidate (info) leaves verified:false when nothing decide-tier fired', async () => {
    // Two same-system responses sharing an object, different non-antonym verbs,
    // DIFFERENT triggers so no lexical candidate pair forms (pairsChecked 0).
    // The opposition proposal spans 2 ids but is propose-only — it must NOT
    // count as a verification, so the run stays inconclusive.
    const fake: import('../../formal/embed.js').Embedder = async (texts) =>
      texts.map(() => Float32Array.from([1, 0.1]))
    const doc = docOf([
      req({
        id: randomUUID(),
        systemName: 'gate',
        trigger: 'the token is valid',
        systemResponse: 'admit the request',
      }),
      req({
        id: randomUUID(),
        systemName: 'gate',
        trigger: 'the account is suspended',
        systemResponse: 'block the request',
      }),
    ])
    const report = await runCheck(doc, { semantic: { embedder: fake } })
    // The proposal fired...
    expect(byCode(report.findings, 'FND_OPPOSITION_CANDIDATE').length).toBeGreaterThan(0)
    expect(report.pairsChecked).toBe(0)
    // ...but it is propose-only, so the run is NOT verified.
    expect(report.verified).toBe(false)
  })

  it('--strict still fails (exit-inconclusive) when only a propose-only finding fired', async () => {
    const fake: import('../../formal/embed.js').Embedder = async (texts) =>
      texts.map(() => Float32Array.from([1, 0.1]))
    const doc = docOf([
      req({
        id: randomUUID(),
        systemName: 'gate',
        trigger: 'the token is valid',
        systemResponse: 'admit the request',
      }),
      req({
        id: randomUUID(),
        systemName: 'gate',
        trigger: 'the account is suspended',
        systemResponse: 'block the request',
      }),
    ])
    const report = await runCheck(doc, { semantic: { embedder: fake }, strict: true })
    expect(report.strictGate).toBe('fail')
  })
})

describe('coverage — full-demotion verified predicate (Run 3 adversarial hardening)', () => {
  it('a vocabulary-disjoint requirement demotes verified even when other pairs were checked', async () => {
    // The Run 3 winning shape in miniature: two requirements form a checked
    // pair (old predicate: verified=true for the whole doc), while a third is a
    // vocabulary island the decide tier never constrained.
    const trigger = 'the user submits valid credentials'
    const island = randomUUID()
    const doc = docOf([
      req({ id: randomUUID(), trigger, systemResponse: 'issue a session token' }),
      req({ id: randomUUID(), trigger, systemResponse: 'grant elevated access' }),
      req({
        id: island,
        patternType: 'ubiquitous',
        systemName: 'telemetry',
        systemResponse: 'rotate the flux capacitor',
      }),
    ])
    const report = await runCheck(doc, withSemantic)
    expect(report.pairsChecked).toBeGreaterThan(0)
    expect(report.verified).toBe(false)
    const uncovered = report.coverage.demotions.filter((d) => d.reason === 'uncovered-requirement')
    expect(uncovered).toHaveLength(1)
    expect(uncovered[0]!.requirementIds).toEqual([island])
    expect(uncovered[0]!.action).toContain('glossary add')
    const row = report.coverage.requirements.find((r) => r.id === island)
    expect(row?.participates).toBe(false)
    expect(row?.unmatchedAtoms.length).toBeGreaterThan(0)
    expect(report.residualRisk.uncoveredRequirements).toBe(1)
  })

  it('an open opposition candidate demotes verified; waiving it discharges the demotion (agent loop)', async () => {
    // Same-trigger pair (so a candidate pair IS checked) whose responses share
    // an object with different non-antonym verbs → opposition candidate fires.
    const trigger = 'the operator presses the button'
    const fake: import('../../formal/embed.js').Embedder = async (texts) =>
      texts.map(() => Float32Array.from([1, 0.1]))
    const build = () =>
      docOf([
        req({ id: randomUUID(), trigger, systemName: 'gate', systemResponse: 'admit the request' }),
        req({ id: randomUUID(), trigger, systemName: 'gate', systemResponse: 'block the request' }),
      ])

    const before = await runCheck(build(), { semantic: { embedder: fake } })
    expect(byCode(before.findings, 'FND_OPPOSITION_CANDIDATE')).toHaveLength(1)
    expect(before.verified).toBe(false)
    const opp = before.coverage.demotions.filter((d) => d.reason === 'open-opposition-candidate')
    expect(opp).toHaveLength(1)
    expect(opp[0]!.action).toContain('antonym add')
    expect(opp[0]!.action).toContain('waive')

    // Discharge by waiver: a triaged candidate stops demoting.
    const waivedDoc = build()
    waivedDoc.waivers = [{ code: 'FND_OPPOSITION_CANDIDATE', reason: 'reviewed: not opposites' }]
    const after = await runCheck(waivedDoc, { semantic: { embedder: fake } })
    expect(byCode(after.findings, 'FND_OPPOSITION_CANDIDATE')).toHaveLength(0)
    expect(after.waived).toBeGreaterThan(0)
    expect(
      after.coverage.demotions.filter((d) => d.reason === 'open-opposition-candidate'),
    ).toHaveLength(0)
    expect(after.verified).toBe(true)
  })

  it('demotion-only: verified never true when the OLD predicate said false (monotone)', async () => {
    // The old predicate: inconclusive when pairsChecked=0 ∧ ≥2 reqs ∧ nothing
    // decide-tier fired. The new predicate must be at least as strict.
    const { doc } = disjointDoc()
    const report = await runCheck(doc, withSemantic)
    expect(report.pairsChecked).toBe(0)
    expect(report.verified).toBe(false)
    expect(report.coverage.demotions.some((d) => d.reason === 'no-decide-tier-comparison')).toBe(
      true,
    )
  })

  it('coverage rows enumerate per-requirement singleton atoms (the rewrite targets)', async () => {
    const { doc, ids } = disjointDoc()
    const report = await runCheck(doc, withSemantic)
    const rowA = report.coverage.requirements.find((r) => r.id === ids.a)
    expect(rowA?.participates).toBe(false)
    expect(rowA?.unmatchedAtoms.some((a) => a.includes('emit_a_photon'))).toBe(true)
    expect(rowA?.suggestion).toContain('Rewrite')
  })

  it('vacuously verified single-requirement doc has empty demotions', async () => {
    const { doc } = bareNumberDoc()
    const report = await runCheck(doc)
    expect(report.verified).toBe(true)
    expect(report.coverage.demotions).toEqual([])
  })
})
