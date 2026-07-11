/**
 * AC-30-3 end-to-end: a numeric contradiction surfaces through the full
 * `runCheck` pipeline as FND_NUMERIC_CONTRADICTION with both ids + evidence.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import { runCheck } from '../check.js'

function req(partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement {
  const base: Requirement = {
    id: partial.id,
    patternType: partial.patternType ?? 'ubiquitous',
    systemName: partial.systemName ?? 'api',
    systemResponse: partial.systemResponse ?? 'respond',
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
  }
  base.sentence = renderSentence(base)
  return base
}

function numericDoc(): { doc: RequirementsDoc; ids: { a: string; b: string } } {
  const ids = { a: randomUUID(), b: randomUUID() }
  const doc = emptyDoc()
  doc.requirements[ids.a] = req({ id: ids.a, systemResponse: 'respond within 2 seconds' })
  doc.requirements[ids.b] = req({ id: ids.b, systemResponse: 'respond over 3000 ms' })
  return { doc, ids }
}

describe('AC-30-3 — numeric contradiction through runCheck', () => {
  it('emits FND_NUMERIC_CONTRADICTION naming both ids with numeric evidence', async () => {
    const { doc, ids } = numericDoc()
    const report = await runCheck(doc)
    const numeric = report.findings.filter((f) => f.code === 'FND_NUMERIC_CONTRADICTION')
    expect(numeric).toHaveLength(1)
    expect(numeric[0]!.severity).toBe('error')
    expect(new Set(numeric[0]!.requirementIds)).toEqual(new Set([ids.a, ids.b]))
    expect(numeric[0]!.evidence?.numeric?.predicates.length).toBeGreaterThanOrEqual(2)
  })

  it('stays silent on satisfiable numeric bounds', async () => {
    const doc = emptyDoc()
    const a = randomUUID()
    const b = randomUUID()
    doc.requirements[a] = req({ id: a, systemResponse: 'respond within 500 ms' })
    doc.requirements[b] = req({ id: b, systemResponse: 'respond over 100 ms' })
    const report = await runCheck(doc)
    expect(report.findings.some((f) => f.code === 'FND_NUMERIC_CONTRADICTION')).toBe(false)
  })
})
