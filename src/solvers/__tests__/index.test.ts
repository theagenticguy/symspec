/**
 * Orchestrator tests (T-AC-8-3 / AC-8-3).
 *
 * Pins the reshaped `runSolvers` contract:
 *   - the free tier always runs (exact dups, ambiguity, candidate pairs);
 *   - the formal tier is opt-in via an injected runner and, when present,
 *     its findings are merged and its `pairsChecked` count surfaces on the
 *     report (the formal-pair counter that replaced v1's `llmPairsRun`);
 *   - no LLM-era shapes survive (`formal.smt` is the only non-`free.*` source).
 */

import { describe, expect, it } from 'vitest'
import type { Doc } from '../../core/doc.js'
import type { Requirement } from '../../core/schema.js'
import type { FormalTier, SolverFinding } from '../index.js'
import { runSolvers, summarize } from '../index.js'

const req = (overrides: Partial<Requirement> & { id: string }): Requirement => ({
  patternType: 'event-driven',
  trigger: 'the user submits credentials',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  sentence: 'When the user submits credentials, the auth service shall issue a session token.',
  priority: 'medium',
  status: 'draft',
  ...overrides,
})

const docOf = (...reqs: Requirement[]): Doc => ({
  schemaVersion: 1,
  requirements: Object.fromEntries(reqs.map((r) => [r.id, r])),
})

describe('runSolvers — free tier (always runs)', () => {
  it('reports exact duplicates and a zero pair count with no formal tier', async () => {
    const doc = docOf(req({ id: 'r1' }), req({ id: 'r2' }))
    const report = await runSolvers(doc)

    expect(report.findings.some((f) => f.kind === 'ExactDuplicate')).toBe(true)
    expect(report.pairsChecked).toBe(0)
  })

  it('flags weasel words via the ambiguity solver', async () => {
    const doc = docOf(
      req({
        id: 'r1',
        systemResponse: 'respond quickly',
        sentence: 'When the user submits credentials, the auth service shall respond quickly.',
      }),
    )
    const report = await runSolvers(doc)
    expect(report.findings.some((f) => f.kind === 'Ambiguity')).toBe(true)
  })

  it('emits candidate pairs the formal tier could escalate', async () => {
    const doc = docOf(
      req({ id: 'r1', systemResponse: 'issue a session token' }),
      req({ id: 'r2', systemResponse: 'reject the request' }),
    )
    const report = await runSolvers(doc)
    // same system + same trigger + different response → candidate pair
    expect(report.candidatePairs.length).toBeGreaterThan(0)
  })
})

describe('runSolvers — formal tier (opt-in, injected)', () => {
  it('routes candidate pairs to the injected formal tier and surfaces pairsChecked', async () => {
    const doc = docOf(
      req({ id: 'r1', systemResponse: 'issue a session token' }),
      req({ id: 'r2', systemResponse: 'reject the request' }),
    )

    let received: number | undefined
    const formalFinding: SolverFinding = {
      kind: 'Subsumption',
      moreGeneral: 'r1',
      moreSpecific: 'r2',
      source: 'formal.smt',
      confidence: 'high',
      message: 'r1 subsumes r2',
    }
    const formal: FormalTier = async ({ reqs, pairs }) => {
      received = pairs.length
      // whole-spec checks see every requirement view
      expect(reqs.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
      return { findings: [formalFinding], pairsChecked: pairs.length }
    }

    const report = await runSolvers(doc, { formal })

    expect(received).toBe(report.candidatePairs.length)
    expect(report.pairsChecked).toBe(report.candidatePairs.length)
    expect(report.pairsChecked).toBeGreaterThan(0)
    expect(report.findings).toContainEqual(formalFinding)
  })

  it('does not invoke the formal tier when none is injected', async () => {
    const doc = docOf(req({ id: 'r1', systemResponse: 'issue a session token' }))
    const report = await runSolvers(doc)
    expect(report.pairsChecked).toBe(0)
    expect(report.findings.every((f) => f.source !== 'formal.smt')).toBe(true)
  })
})

describe('summarize', () => {
  it('renders the formal-pair count, not an LLM-call count', async () => {
    const doc = docOf(
      req({ id: 'r1', systemResponse: 'issue a session token' }),
      req({ id: 'r2', systemResponse: 'reject the request' }),
    )
    const formal: FormalTier = async ({ pairs }) => ({ findings: [], pairsChecked: pairs.length })
    const report = await runSolvers(doc, { formal })
    const text = summarize(report)
    expect(text).toContain('formal pair check(s)')
    expect(text).not.toMatch(/LLM/i)
  })
})
