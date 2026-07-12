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
