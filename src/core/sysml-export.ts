/**
 * Export internal model to a SysML-v2-flavored JSON shape.
 *
 * This is a *flavored* export — it mirrors the structure of SysML v2's
 * Requirement and Relationship elements rather than reproducing the full
 * KerML/SysML v2 JSON-LD payload, which would require a real implementation
 * stack. The point is to show how the internal nodes translate cleanly:
 *   - each Requirement becomes a `RequirementUsage`-shaped element
 *   - each outbound edge becomes a typed relationship element
 *   - EARS slots map to typed attributes; the sentence is the documentation
 *
 * If you wanted to push this to a real SysML v2 server, you'd swap the
 * shape below for the OpenAPI-generated Element + Relationship payloads
 * defined by the Systems Modeling API spec (Part 3, OMG).
 */

import { type Doc, snapshot } from './doc.js'
import { RELATIONS } from './schema.js'

type SysmlElement = {
  '@id': string
  '@type': 'RequirementUsage'
  declaredName: string
  documentation: string
  attributes: Record<string, string | undefined>
}

type SysmlRelationship = {
  '@id': string
  '@type': 'DeriveRequirement' | 'Satisfy' | 'Verify' | 'Refine'
  source: string
  target: string
}

type SysmlExport = {
  '@context': 'https://www.omg.org/spec/SysML/v2'
  schemaVersion: number
  elements: SysmlElement[]
  relationships: SysmlRelationship[]
}

const RELATION_TO_SYSML: Record<(typeof RELATIONS)[number], SysmlRelationship['@type']> = {
  derives: 'DeriveRequirement',
  satisfies: 'Satisfy',
  verifies: 'Verify',
  refines: 'Refine',
}

export function exportSysml(doc: Doc): SysmlExport {
  const snap = snapshot(doc)
  const elements: SysmlElement[] = []
  const relationships: SysmlRelationship[] = []

  for (const r of Object.values(snap.requirements)) {
    elements.push({
      '@id': r.id,
      '@type': 'RequirementUsage',
      declaredName: `${r.patternType}_${r.id.slice(0, 8)}`,
      documentation: r.sentence,
      attributes: {
        patternType: r.patternType,
        preCondition: r.preCondition,
        trigger: r.trigger,
        systemName: r.systemName,
        systemResponse: r.systemResponse,
        priority: r.priority,
        status: r.status,
        verificationMethod: r.verificationMethod,
      },
    })

    for (const relation of RELATIONS) {
      for (const target of r[relation]) {
        relationships.push({
          '@id': `${r.id}->${relation}->${target}`,
          '@type': RELATION_TO_SYSML[relation],
          source: r.id,
          target,
        })
      }
    }
  }

  return {
    '@context': 'https://www.omg.org/spec/SysML/v2',
    schemaVersion: snap.schemaVersion,
    elements,
    relationships,
  }
}
