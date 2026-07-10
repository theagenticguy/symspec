/**
 * AC-6-8 wiring proof: `runCheck` returns structural + lint + formal findings
 * together in ONE `findings[]`, and the AC-3-7 exclusion gate keeps
 * error-severity statements out of the formal tier's input (verified via the
 * atom-table evidence — the excluded statement's id appears in no formal
 * finding and no formal atom table).
 *
 * The fixture plants one issue per tier:
 *   - structural: REQ-DANGLE carries a `derives` edge to a nonexistent UUID
 *     → FND_DANGLING_REFERENCE (Tier 0).
 *   - lint: REQ-WEASEL's response contains "as appropriate" → a GTWR_* error
 *     (R8 escape clause), which ALSO excludes it from symbolization (AC-3-7).
 *   - formal: REQ-A / REQ-B share a trigger with opposite-polarity responses
 *     ("issue a session token" vs "not issue a session token")
 *     → FND_CONTRADICTION with both ids in the minimal core (AC-4-4) and
 *     evidence attached (AC-4-6).
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runAdd } from '../../cli/add.js'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import { type CheckFinding, runCheck, toEncodable } from '../check.js'

/** Fake analyzer with no modal, so Tier 2 never loads wink-nlp in tests. */
const noModalOpts = () => ({
  load: async () => (text: string) =>
    text.split(/\s+/).map((value) => ({
      value,
      pos: 'NN',
      lemma: value.toLowerCase(),
      negationFlag: false,
    })),
})

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

const TRIGGER = 'the user submits valid credentials'

function plantedDoc(): { doc: RequirementsDoc; ids: Record<string, string> } {
  const ids = {
    a: randomUUID(),
    b: randomUUID(),
    dangle: randomUUID(),
    weasel: randomUUID(),
  }
  const doc = docOf([
    req({ id: ids.a, trigger: TRIGGER, systemResponse: 'issue a session token' }),
    req({ id: ids.b, trigger: TRIGGER, systemResponse: 'not issue a session token' }),
    req({
      id: ids.dangle,
      trigger: 'the session expires',
      systemResponse: 'revoke the session token',
      derives: [randomUUID()], // dangling target
    }),
    req({
      id: ids.weasel,
      trigger: 'the audit log fills',
      systemResponse: 'rotate the log as appropriate', // R8 escape clause → error severity
    }),
  ])
  return { doc, ids }
}

function byCode(findings: CheckFinding[], code: string): CheckFinding[] {
  return findings.filter((f) => f.code === code)
}

describe('runCheck — AC-6-8 all tiers in one findings[]', () => {
  it('returns structural + lint + formal findings together, gate honored', async () => {
    const { doc, ids } = plantedDoc()
    const report = await runCheck(doc)

    // Tier 0 structural: the dangling derives edge.
    const dangling = byCode(report.findings, 'FND_DANGLING_REFERENCE')
    expect(dangling).toHaveLength(1)
    expect(dangling[0]!.tier).toBe('structural')
    expect(dangling[0]!.requirementIds).toEqual([ids.dangle])

    // Lint: the escape clause fired with a span on the weasel requirement.
    const lintErrors = report.findings.filter(
      (f) => f.tier === 'lint' && f.requirementIds.includes(ids.weasel) && f.severity === 'error',
    )
    expect(lintErrors.length).toBeGreaterThan(0)
    expect(lintErrors[0]!.code).toMatch(/^GTWR_/)
    expect(lintErrors[0]!.span).toBeDefined()

    // Formal: the planted contradiction, exactly the two culprit ids.
    const contradictions = byCode(report.findings, 'FND_CONTRADICTION')
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]!.tier).toBe('formal')
    expect([...contradictions[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())

    // All three tiers are present in the ONE findings array.
    const tiers = new Set(report.findings.map((f) => f.tier))
    expect(tiers.has('structural')).toBe(true)
    expect(tiers.has('lint')).toBe(true)
    expect(tiers.has('formal')).toBe(true)

    // Severity counts are consistent with the array.
    const errors = report.findings.filter((f) => f.severity === 'error').length
    expect(report.counts.error).toBe(errors)
  })

  it('AC-4-6: every unsat-triggered formal finding carries evidence with core + atom table', async () => {
    const { doc, ids } = plantedDoc()
    const report = await runCheck(doc)

    const contradiction = byCode(report.findings, 'FND_CONTRADICTION')[0]!
    expect(contradiction.evidence).toBeDefined()
    expect(contradiction.evidence!.core).toBeDefined()
    expect([...contradiction.evidence!.core!].sort()).toEqual([ids.a, ids.b].sort())
    // The atom table shows the shared response atom at opposite polarity.
    const respRows = contradiction.evidence!.atomTable.filter((r) => r.kind === 'resp')
    expect(respRows.length).toBe(2)
    expect(new Set(respRows.map((r) => r.atom)).size).toBe(1)
    expect(new Set(respRows.map((r) => r.negated)).size).toBe(2)
  })

  it('AC-3-7: the error-severity statement is excluded from the formal tier entirely', async () => {
    const { doc, ids } = plantedDoc()
    const report = await runCheck(doc)

    // Reported as excluded, with its blocking findings as evidence.
    const exclusion = report.excluded.find((e) => e.id === ids.weasel)
    expect(exclusion).toBeDefined()
    expect(exclusion!.reason).toBe('blocking-surface-check')
    expect(exclusion!.findings.length).toBeGreaterThan(0)

    // No formal finding names it, and no formal atom table contains any atom
    // derived from it (its trigger/response text is unique to the fixture).
    const formalFindings = report.findings.filter((f) => f.tier === 'formal')
    for (const f of formalFindings) {
      expect(f.requirementIds).not.toContain(ids.weasel)
      if (f.evidence !== undefined) {
        for (const row of f.evidence.atomTable) {
          expect(row.slotText).not.toMatch(/audit log|rotate the log/)
        }
      }
    }
  })

  it('clean two-requirement doc yields no error findings and pairsChecked >= 0', async () => {
    const doc = docOf([
      req({
        id: randomUUID(),
        trigger: 'the user logs out',
        systemResponse: 'invalidate the session token',
      }),
      req({
        id: randomUUID(),
        patternType: 'state-driven',
        preCondition: 'maintenance mode is active',
        systemResponse: 'reject new login attempts',
        systemName: 'gateway',
      }),
    ])
    const report = await runCheck(doc)
    const errors = report.findings.filter((f) => f.severity === 'error')
    // Orphan warns are fine; no errors and no exclusions on a clean doc.
    expect(errors).toEqual([])
    expect(report.excluded).toEqual([])
    expect(report.pairsChecked).toBeGreaterThanOrEqual(0)
  })
})

describe('C1 regression — prose negation survives persistence end-to-end', () => {
  // The adversarial critic's exact repro: adding two contradictory requirements
  // via `--from-parse` must yield FND_CONTRADICTION, NOT FND_EXACT_DUPLICATE.
  // Before the C1 fix, the parse tier's `negated` flag was dropped on persist,
  // so both requirements stored the same positive sentence and collapsed to a
  // duplicate — the semantic inverse of user intent.
  it('two --from-parse adds (X / not X) produce FND_CONTRADICTION not FND_EXACT_DUPLICATE', async () => {
    let doc = emptyDoc()

    const positive = await runAdd(
      doc,
      {
        fromParse:
          'When the user submits valid credentials, the auth service shall issue a session token.',
      },
      noModalOpts(),
    )
    if (!('next' in positive))
      throw new Error(`positive add failed: ${JSON.stringify(positive.envelope)}`)
    doc = positive.next

    const negative = await runAdd(
      doc,
      {
        fromParse:
          'When the user submits valid credentials, the auth service shall not issue a session token.',
      },
      noModalOpts(),
    )
    if (!('next' in negative))
      throw new Error(`negative add failed: ${JSON.stringify(negative.envelope)}`)
    doc = negative.next

    const report = await runCheck(doc)
    const codes = new Set(report.findings.map((f) => f.code))
    expect(codes.has('FND_CONTRADICTION')).toBe(true)
    expect(codes.has('FND_EXACT_DUPLICATE')).toBe(false)

    // And the negated requirement is stored with positive text + the flag,
    // rendering "shall not" — never the inverted positive sentence.
    const stored = Object.values(doc.requirements)
    const negated = stored.find((r) => r.negated === true)
    expect(negated).toBeDefined()
    expect(negated?.systemResponse).toBe('issue a session token')
    expect(negated?.sentence).toContain('shall not issue a session token')
  })
})

describe('toEncodable — stored-text negation derivation', () => {
  // A hand-authored doc that baked "not" into the response text WITHOUT
  // setting the negated flag — the fallback leading-negator scan path.
  const view = {
    id: 'x',
    patternType: 'event-driven' as const,
    trigger: 't',
    systemName: 's',
    systemResponse: 'not issue a session token',
    negated: false,
    sentence: '',
    priority: 'medium' as const,
    status: 'draft' as const,
  }

  it('strips the leading negator and sets negated: true', () => {
    const enc = toEncodable(view)
    expect(enc.negated).toBe(true)
    expect(enc.systemResponse).toBe('issue a session token')
  })

  it('leaves positive responses untouched (negated stays false)', () => {
    const enc = toEncodable({ ...view, systemResponse: 'issue a session token' })
    expect(enc.negated).toBe(false)
    expect(enc.systemResponse).toBe('issue a session token')
  })

  it('handles "does not" and "never" forms', () => {
    expect(toEncodable({ ...view, systemResponse: 'does not store plaintext' })).toMatchObject({
      negated: true,
      systemResponse: 'store plaintext',
    })
    expect(toEncodable({ ...view, systemResponse: 'never store plaintext' })).toMatchObject({
      negated: true,
      systemResponse: 'store plaintext',
    })
  })

  it('does not strip mid-sentence "not"', () => {
    const enc = toEncodable({ ...view, systemResponse: 'log why access is not granted' })
    expect(enc.negated).toBe(false)
    expect(enc.systemResponse).toBe('log why access is not granted')
  })
})
