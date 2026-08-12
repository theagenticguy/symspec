/**
 * Preprocessing: strip IDs, normalize quotes/whitespace, drop trailing punctuation (AC-2-5).
 *
 * Runs before the Tier-1 cascade classification to normalize prose into a canonical form.
 * REQ-ID patterns include `REQ-042:`, `SYS-12.`, and dot-delimited `3.1.4)`.
 *
 * Steps (in order):
 *   1. Smart quotes → ASCII quotes (‘ ’ → ', “ ” → ")
 *   2. Requirement IDs stripped from the leading position
 *   3. Consecutive whitespace collapsed to single spaces
 *   4. Trailing punctuation (. or ;) removed
 *   5. Final trim
 */

/**
 * Normalize requirement prose by stripping leading IDs, normalizing unicode quotes,
 * collapsing whitespace, and dropping trailing punctuation.
 *
 * @example
 * preprocess('REQ-042:  “THE_SERVICEright_DOUBLE shall log.')
 * // → '“THE_SERVICEright_DOUBLE shall log'
 *
 * @example
 * preprocess('3.1.4) The system shall boot')
 * // → 'The system shall boot'
 */
export function preprocess(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^\s*(?:REQ[-_ ]?\d+[.:)]?|[A-Z]{2,}-\d+[.:)]?|\d+(?:\.\d+)*[.:)])\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[.;]\s*$/, '')
    .trim()
}
