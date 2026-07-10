/**
 * Fixture "consumer module" for T-AC-6-5 (AC-6-5).
 *
 * Deliberately imports ONLY from the public library entry (`../index.js`),
 * never reaching into `core/`, `parse/`, `lint/`, `formal/`, `pipeline/`,
 * `certify/`, or `solvers/` directly — proving that `src/index.ts` alone is
 * sufficient for a downstream consumer to build a requirement, mutate it,
 * and analyze it without any CLI subprocess round-trip.
 */
import {
  analyze,
  applyChange,
  emptyDoc,
  type Finding,
  getRequirement,
  listRequirements,
  newId,
  type RequirementsDoc,
} from '../index.js'

/** Build a tiny one-requirement document entirely through the library API. */
export function buildSampleDoc(): { doc: RequirementsDoc; id: string } {
  const id = newId()
  const doc = applyChange(emptyDoc(), {
    kind: 'CreateRequirement',
    id,
    attrs: {
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every authentication attempt',
    },
  })
  return { doc, id }
}

/** Run the library's structural analysis over a document built via the library API. */
export function analyzeSampleDoc(): { findings: Finding[]; sentence: string } {
  const { doc, id } = buildSampleDoc()
  const r = getRequirement(doc, id)
  if (!r) throw new Error('fixture invariant violated: created requirement missing')
  return { findings: analyze(doc), sentence: r.sentence }
}

/** Re-export for the test file's reference-identity assertions. */
export { listRequirements }
