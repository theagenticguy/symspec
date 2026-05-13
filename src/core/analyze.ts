/**
 * Analysis pass over a converged document.
 *
 * Findings are intentionally separate from the data layer — the CRDT keeps
 * the graph eventually consistent, and the analysis runs over the converged
 * snapshot to surface things the CRDT couldn't (and shouldn't) prevent:
 *
 *   - DanglingReference: an edge points at a UUID that no longer exists
 *     (e.g., one replica deleted a node while another added an edge to it).
 *   - MissingTrigger / MissingPreCondition: EARS slot rules per pattern type.
 *   - CycleDetected: cycles in the derives DAG (decomposition must be acyclic).
 *   - OrphanRequirement: a node with no inbound or outbound edges — likely
 *     forgotten or incomplete.
 *
 * The expected workflow: agent/user makes a Commit, replicas merge, analyze()
 * runs, findings surface as clarifying questions in the review UI (matches
 * Kiro's analyze-then-clarify pattern).
 */

import { type Doc, listRequirements, snapshot } from './doc.js'
import { type Finding, RELATIONS, type Relation, type Requirement } from './schema.js'

export function analyze(doc: Doc): Finding[] {
  const snap = snapshot(doc)
  const reqs = Object.values(snap.requirements)
  const ids = new Set(reqs.map((r) => r.id))
  const findings: Finding[] = []

  for (const r of reqs) {
    // Dangling references
    for (const relation of RELATIONS) {
      for (const target of r[relation]) {
        if (!ids.has(target)) {
          findings.push({
            kind: 'DanglingReference',
            from: r.id,
            relation,
            to: target,
            message: `Requirement "${r.systemName} shall ${r.systemResponse}" has a ${relation} edge to ${target}, which no longer exists.`,
          })
        }
      }
    }

    // EARS slot rules
    if ((r.patternType === 'event-driven' || r.patternType === 'unwanted-behavior') && !r.trigger) {
      findings.push({
        kind: 'MissingTrigger',
        id: r.id,
        patternType: r.patternType,
        message: `${r.patternType} requirement ${r.id} is missing a trigger.`,
      })
    }
    if (
      (r.patternType === 'state-driven' || r.patternType === 'optional-feature') &&
      !r.preCondition
    ) {
      findings.push({
        kind: 'MissingPreCondition',
        id: r.id,
        patternType: r.patternType,
        message: `${r.patternType} requirement ${r.id} is missing a pre-condition.`,
      })
    }
  }

  // Cycle detection on the derives DAG
  const cycles = findCycles(reqs, 'derives')
  for (const c of cycles) {
    findings.push({
      kind: 'CycleDetected',
      nodes: c,
      relation: 'derives',
      message: `Derive-cycle: ${c.join(' -> ')} -> ${c[0]}`,
    })
  }

  // Orphan detection (no in or out edges of any relation)
  const inboundCount = new Map<string, number>()
  for (const r of reqs) {
    for (const relation of RELATIONS) {
      for (const target of r[relation]) {
        inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1)
      }
    }
  }
  for (const r of reqs) {
    const outbound = RELATIONS.reduce((acc, rel) => acc + r[rel].length, 0)
    const inbound = inboundCount.get(r.id) ?? 0
    if (outbound === 0 && inbound === 0 && reqs.length > 1) {
      findings.push({
        kind: 'OrphanRequirement',
        id: r.id,
        message: `Requirement ${r.id} has no inbound or outbound edges.`,
      })
    }
  }

  return findings
}

function findCycles(reqs: Requirement[], relation: Relation): string[][] {
  const adj = new Map<string, string[]>()
  for (const r of reqs) adj.set(r.id, [...r[relation]])

  const cycles: string[][] = []
  const seen = new Set<string>()

  function dfs(node: string, stack: string[], onStack: Set<string>) {
    if (onStack.has(node)) {
      const start = stack.indexOf(node)
      if (start >= 0) cycles.push(stack.slice(start))
      return
    }
    if (seen.has(node)) return
    seen.add(node)
    onStack.add(node)
    stack.push(node)
    for (const next of adj.get(node) ?? []) {
      dfs(next, stack, onStack)
    }
    stack.pop()
    onStack.delete(node)
  }

  for (const r of reqs) dfs(r.id, [], new Set())
  // Dedupe by canonical rotation
  const seenCycles = new Set<string>()
  const uniq: string[][] = []
  for (const c of cycles) {
    const min = Math.min(...c.map((_, i) => i))
    const rotated = [...c.slice(min), ...c.slice(0, min)]
    const key = rotated.join(',')
    if (!seenCycles.has(key)) {
      seenCycles.add(key)
      uniq.push(rotated)
    }
  }
  return uniq
}

export function summarizeFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings — graph is consistent.'
  const lines = [`Found ${findings.length} issue(s):`]
  for (const f of findings) lines.push(`  [${f.kind}] ${f.message}`)
  return lines.join('\n')
}

// Re-export for type-only consumers
export type { Finding } from './schema.js'
// Avoid unused-import warning when only types are imported elsewhere
export const _listRequirements = listRequirements
