/**
 * AC-9-3 flagship: a paraphrased contradiction is INVISIBLE with lexical
 * atomization alone, but becomes a provable FND_CONTRADICTION once the glossary
 * unifies the synonymous phrasings — the whole point of the semantic tier.
 * This is the deterministic DECIDE path; no embedding model is involved here.
 *
 * AC-9-5: the PROPOSE path — `check --semantic` with an injected fake embedder
 * emits FND_SIMILAR_SEMANTIC for the same pair BEFORE a glossary exists.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { GlossaryEntry, Requirement, RequirementsDoc } from '../../core/schema.js'
import type { Embedder } from '../../formal/embed.js'
import { DEFAULT_SEMANTIC_THRESHOLD } from '../../formal/semantic.js'
import { runCheck } from '../check.js'

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
  }
  base.sentence = renderSentence(base)
  return base
}

const TRIGGER = 'the user submits valid credentials'

/** Two reqs under one trigger: one issues a "session token", the other refuses
 *  a "login credential" — a real conflict IFF the two phrasings are one atom. */
function paraphrasedConflictDoc(glossary: GlossaryEntry[] = []): {
  doc: RequirementsDoc
  ids: { a: string; b: string }
} {
  const ids = { a: randomUUID(), b: randomUUID() }
  const doc = emptyDoc()
  doc.requirements[ids.a] = req({
    id: ids.a,
    trigger: TRIGGER,
    systemResponse: 'issue a session token',
  })
  doc.requirements[ids.b] = req({
    id: ids.b,
    trigger: TRIGGER,
    systemResponse: 'issue a login credential',
    negated: true,
  })
  doc.glossary = glossary
  return { doc, ids }
}

describe('AC-9-3 — glossary bridges a paraphrased contradiction', () => {
  it('WITHOUT a glossary: distinct atoms, so NO contradiction', async () => {
    const { doc } = paraphrasedConflictDoc()
    const report = await runCheck(doc)
    const codes = report.findings.map((f) => f.code)
    expect(codes).not.toContain('FND_CONTRADICTION')
  })

  it('WITH a glossary merge: one atom, so FND_CONTRADICTION with both ids', async () => {
    const { doc, ids } = paraphrasedConflictDoc([
      { canonical: 'issue a session token', aliases: ['issue a login credential'] },
    ])
    const report = await runCheck(doc)
    const contradictions = report.findings.filter((f) => f.code === 'FND_CONTRADICTION')
    expect(contradictions).toHaveLength(1)
    expect([...contradictions[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
  })
})

describe('AC-9-5 — --semantic proposes the merge (propose-only)', () => {
  const fakeEmbedder: Embedder = async (texts) =>
    texts.map((t) => {
      // Both "issue ..." phrasings map to near-parallel vectors; anything else orthogonal.
      const v: [number, number] = t.startsWith('issue ') ? [1, 0.03] : [0, 1]
      const n = Math.hypot(v[0], v[1])
      return Float32Array.from([v[0] / n, v[1] / n])
    })

  it('emits FND_SIMILAR_SEMANTIC for the unmerged paraphrase pair, not a verdict', async () => {
    const { doc, ids } = paraphrasedConflictDoc() // no glossary yet
    const report = await runCheck(doc, {
      semantic: { embedder: fakeEmbedder, threshold: DEFAULT_SEMANTIC_THRESHOLD },
    })
    const semantic = report.findings.filter((f) => f.code === 'FND_SIMILAR_SEMANTIC')
    expect(semantic).toHaveLength(1)
    expect(semantic[0]!.severity).toBe('info')
    expect([...semantic[0]!.requirementIds].sort()).toEqual([ids.a, ids.b].sort())
    // Propose-only: still NO contradiction verdict without the glossary.
    expect(report.findings.map((f) => f.code)).not.toContain('FND_CONTRADICTION')
  })

  it('once the glossary merge is confirmed, --semantic stops proposing it and check finds the conflict', async () => {
    const { doc } = paraphrasedConflictDoc([
      { canonical: 'issue a session token', aliases: ['issue a login credential'] },
    ])
    const report = await runCheck(doc, {
      semantic: { embedder: fakeEmbedder, threshold: DEFAULT_SEMANTIC_THRESHOLD },
    })
    expect(report.findings.map((f) => f.code)).not.toContain('FND_SIMILAR_SEMANTIC')
    expect(report.findings.map((f) => f.code)).toContain('FND_CONTRADICTION')
  })
})
