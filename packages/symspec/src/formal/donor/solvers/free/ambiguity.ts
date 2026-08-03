/**
 * Free solver: lexical scan for weasel words and vague quantifiers.
 *
 * Catches the obvious ambiguity cases without an LLM call: things like
 * "fast", "robust", "appropriate", "as needed", "etc.". Not exhaustive —
 * the LLM judge handles the contextual cases this misses. But this pass is
 * free and cleans up the easy wins.
 *
 * The list is curated from the INCOSE Guide for Writing Requirements and
 * the IEEE 830 / ISO 29148 ambiguity lists. We deliberately keep it short
 * and high-precision — false positives here would train authors to ignore
 * the linter.
 */

import type { ReqView, SolverFinding } from '../types.ts'

const WEASEL_PHRASES = [
  // Speed / performance hand-waving
  'fast',
  'quickly',
  'rapid',
  'slow',
  'as quickly as possible',
  // Quality hand-waving
  'robust',
  'user-friendly',
  'easy to use',
  'intuitive',
  'appropriate',
  'adequate',
  'reasonable',
  'acceptable',
  'sufficient',
  // Open-ended scope
  'etc.',
  'and so on',
  'and the like',
  'where applicable',
  'as needed',
  'as appropriate',
  'as necessary',
  // Vague quantifiers
  'many',
  'some',
  'several',
  'various',
  'most',
  'few',
  'minimal',
  'minimum',
  'maximum',
  // Subjective absolutes (need numeric bound)
  'always',
  'never',
  'all',
  'every',
] as const

const SUGGESTED_REWRITES: Partial<Record<(typeof WEASEL_PHRASES)[number], string>> = {
  fast: "specify a numeric latency bound, e.g. 'within 200 ms'",
  quickly: "specify a numeric latency bound, e.g. 'within 200 ms'",
  rapid: "specify a numeric latency bound, e.g. 'within 200 ms'",
  robust: 'name the specific failure modes the system must survive',
  'user-friendly': 'specify measurable usability acceptance criteria',
  appropriate: 'name the criterion that determines what is appropriate',
  adequate: 'specify a numeric threshold',
  'etc.': 'enumerate the cases explicitly',
  'as needed': 'name the condition that triggers the action',
  many: "specify a numeric bound, e.g. 'at least 100'",
  minimal: 'specify a numeric bound',
  minimum: 'specify a numeric bound',
  always: 'if literal, leave as-is; otherwise list the conditions',
}

function findPhrases(
  text: string,
  phrases: readonly string[],
): { phrase: string; start: number }[] {
  const hits: { phrase: string; start: number }[] = []
  const lower = text.toLowerCase()
  for (const phrase of phrases) {
    let from = 0
    // word-boundary check at start of match
    while (true) {
      const idx = lower.indexOf(phrase, from)
      if (idx < 0) break
      const before = idx === 0 ? ' ' : (lower[idx - 1] ?? '')
      const afterIdx = idx + phrase.length
      const after = afterIdx >= lower.length ? ' ' : (lower[afterIdx] ?? '')
      const isWordChar = (c: string) => /[a-z0-9]/.test(c)
      if (!isWordChar(before) && !isWordChar(after)) {
        hits.push({ phrase, start: idx })
      }
      from = idx + phrase.length
    }
  }
  return hits
}

export function detectAmbiguity(reqs: ReqView[]): SolverFinding[] {
  const findings: SolverFinding[] = []
  for (const r of reqs) {
    const haystack = [r.preCondition ?? '', r.trigger ?? '', r.systemResponse].join(' ␟ ')
    const hits = findPhrases(haystack, WEASEL_PHRASES)
    if (hits.length === 0) continue
    const uniquePhrases = Array.from(new Set(hits.map((h) => h.phrase)))
    const rewrites = uniquePhrases
      .map((p) => SUGGESTED_REWRITES[p as keyof typeof SUGGESTED_REWRITES])
      .filter((v): v is string => Boolean(v))
    const finding: SolverFinding = {
      kind: 'Ambiguity',
      id: r.id,
      phrases: uniquePhrases,
      source: 'free.weasel-words',
      confidence: 'high',
      message: `Vague phrase${uniquePhrases.length > 1 ? 's' : ''}: ${uniquePhrases.map((p) => `"${p}"`).join(', ')}`,
    }
    if (rewrites.length) finding.suggestedRewrites = rewrites
    findings.push(finding)
  }
  return findings
}
