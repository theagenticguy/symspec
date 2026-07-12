/**
 * Formal-coverage disclosure (wishlist #6).
 *
 * The formal tier only performs cross-requirement conflict/subsumption analysis
 * on candidate PAIRS — two requirements that share at least one atom. A document
 * whose requirements share no vocabulary produces `pairsChecked: 0`, meaning the
 * SMT layer proved nothing about consistency ACROSS requirements. That silence
 * reads exactly like a clean pass to a careless reader, which is the one place
 * the tool's honesty gap actually bites.
 *
 * `noPairsCheckedFinding` turns that silent zero into a loud `info` finding so
 * the coverage gap is visible in `findings[]` rather than only in a numeric
 * field an agent has to remember to print. It is emitted by the `check`
 * pipeline (see `pipeline/check.ts`) exactly when `pairsChecked === 0` on a
 * document that actually had ≥2 requirements to relate.
 */

import type { FndCode } from './codes.js'

/** The shape the `check` pipeline pushes into its normalized `findings[]`. */
export interface CoverageFinding {
  readonly code: FndCode
  readonly severity: 'info'
  readonly requirementIds: readonly string[]
  readonly message: string
}

/**
 * Build the `FND_NO_PAIRS_CHECKED` info finding. Names every requirement id so a
 * reader can see the whole set that went uncompared. Info severity, so it never
 * moves the exit gate — it is a disclosure, not a defect.
 */
export function noPairsCheckedFinding(requirementIds: readonly string[]): CoverageFinding {
  return {
    code: 'FND_NO_PAIRS_CHECKED',
    severity: 'info',
    requirementIds: [...requirementIds],
    message:
      'The formal tier evaluated 0 candidate pairs: no two requirements shared an atom, so no ' +
      'cross-requirement contradiction/subsumption analysis ran. This is NOT a consistency ' +
      'certificate — consider adding glossary entries to align vocabulary so related ' +
      'requirements share atoms and can be compared.',
  }
}
