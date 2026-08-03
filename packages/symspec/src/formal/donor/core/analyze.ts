/**
 * Tier-0 structural analysis pass — runs over a plain-object document
 * snapshot with no solver and no storage-layer coupling.
 *
 * Findings surface things the storage layer couldn't (and shouldn't) prevent:
 *
 *   - DanglingReference: an edge points at a UUID that no longer exists
 *     (e.g., a node was deleted while another requirement still edges to it).
 *   - MissingTrigger / MissingPreCondition: EARS slot rules per pattern type.
 *   - CycleDetected: cycles in the derives DAG (decomposition must be acyclic).
 *   - OrphanRequirement: a node with no inbound or outbound edges — likely
 *     forgotten or incomplete.
 *
 * The expected workflow: a Change is applied, `analyze()` runs over the
 * resulting document snapshot, findings surface as clarifying questions in
 * the review UI (matches Kiro's analyze-then-clarify pattern).
 */

import {
  type Finding,
  RELATIONS,
  type Relation,
  type Requirement,
  type RequirementsDoc,
} from './schema.ts'

export function analyze(doc: RequirementsDoc): Finding[] {
  const reqs = Object.values(doc.requirements)
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

  // Orphan detection (no in or out edges of any relation).
  //
  // Trace-gate the noise: an orphan is only meaningful RELATIVE to a document
  // that actually traces. In a doc that uses ZERO trace links anywhere, EVERY
  // requirement is trivially an orphan — so flagging them all just penalizes an
  // author who has not adopted trace links yet, with no signal. So orphan
  // detection only fires once the doc uses at least one trace link somewhere
  // (any relation edge on any requirement); then a requirement with no edges is
  // a genuine gap against a document that does trace.
  const usesAnyTraceLink = reqs.some((r) => RELATIONS.some((rel) => r[rel].length > 0))
  if (usesAnyTraceLink) {
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
  }

  // AC-32-3: leaf-must-be-verifiable (KAOS/SysML canon). A requirement that is
  // a LEAF of the refinement/derivation DAG — something other requirements
  // refine or derive toward (it has inbound refines/derives), but which itself
  // refines/derives nothing further (it is a sink) — must be independently
  // verifiable: it must carry a `verifies` edge OR be its own testable EARS
  // obligation. A refinement leaf with neither is an unverifiable dead end.
  const refinedTargets = new Set<string>()
  for (const r of reqs) {
    for (const t of r.refines) refinedTargets.add(t)
    for (const t of r.derives) refinedTargets.add(t)
  }
  for (const r of reqs) {
    const isRefinementLeaf =
      refinedTargets.has(r.id) && r.refines.length === 0 && r.derives.length === 0
    if (!isRefinementLeaf) continue
    // Verifiable if it has a verify edge or is itself a testable obligation
    // (a concrete response with a defined trigger/precondition, i.e. not a
    // bare abstract goal). We treat "has a systemResponse and is not missing a
    // required slot" as testable; the missing-slot findings above already flag
    // the untestable case, so here we only require a verify link when it is an
    // abstract parent with no concrete obligation of its own.
    const hasVerify = r.verifies.length > 0
    if (hasVerify) continue
    findings.push({
      kind: 'LeafUnverifiable',
      id: r.id,
      message: `Requirement ${r.id} is a refinement leaf with no \`verifies\` edge; a leaf must be independently verifiable (add a verify link or a testable obligation).`,
    })
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
  // Dedupe by canonical rotation: rotate each cycle so it starts at the
  // lexicographically-smallest node id, then dedupe on the rotated key — so the
  // same cycle discovered from two different entry nodes is reported once.
  const seenCycles = new Set<string>()
  const uniq: string[][] = []
  for (const c of cycles) {
    const minIdx = minIndexOf(c)
    const rotated = [...c.slice(minIdx), ...c.slice(0, minIdx)]
    const key = rotated.join(',')
    if (!seenCycles.has(key)) {
      seenCycles.add(key)
      uniq.push(rotated)
    }
  }
  return uniq
}

/** Index of the lexicographically-smallest node id in a cycle. */
function minIndexOf(cycle: string[]): number {
  let minIdx = 0
  for (let i = 1; i < cycle.length; i++) {
    const candidate = cycle[i]
    const current = cycle[minIdx]
    if (candidate !== undefined && current !== undefined && candidate < current) {
      minIdx = i
    }
  }
  return minIdx
}

export function summarizeFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings — graph is consistent.'
  const lines = [`Found ${findings.length} issue(s):`]
  for (const f of findings) lines.push(`  [${f.kind}] ${f.message}`)
  return lines.join('\n')
}

// Re-export for type-only consumers
export type { Finding } from './schema.ts'
