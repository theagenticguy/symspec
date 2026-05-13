/**
 * Pairwise LLM judge. Given two EARS requirements and a "reason this pair was
 * flagged" hint from the free tier, classify the relationship between them.
 *
 * Output is one of:
 *   - contradiction:   both cannot be simultaneously satisfied
 *   - subsumption:     one is a special case of the other
 *   - redundant:       they say the same thing in different words
 *   - compatible:      no conflict; the free-tier flag was a false positive
 */

import type { CandidatePair, ReqView } from '../types.js'
import type { CallModel } from './bedrock-client.js'

export type PairJudgment = {
  judgment: 'contradiction' | 'subsumption' | 'redundant' | 'compatible'
  /** When judgment is "subsumption", whichOf is which of a|b is more general. */
  whichOf?: 'a' | 'b' | null
  confidence: 'low' | 'medium' | 'high'
  rationale: string
}

const SYSTEM_PROMPT = [
  'You are an expert in requirements engineering using the EARS (Easy Approach to Requirements Syntax) notation.',
  'You analyze pairs of requirements and decide whether they can coexist or are in conflict.',
  "You are precise, conservative, and prefer 'compatible' when the evidence is weak.",
  'You always answer by calling the report_pair_judgment tool — never plain prose.',
].join('\n')

const JUDGMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    judgment: {
      type: 'string',
      enum: ['contradiction', 'subsumption', 'redundant', 'compatible'],
      description:
        'Relationship between requirement A and requirement B. ' +
        "'contradiction': both cannot be simultaneously satisfied. " +
        "'subsumption': one is a strict special case of the other (set whichOf to 'a' or 'b' to indicate which is more general). " +
        "'redundant': both say the same thing in materially different words. " +
        "'compatible': no conflict; the pair was flagged but is fine.",
    },
    whichOf: {
      type: ['string', 'null'],
      enum: ['a', 'b', null],
      description:
        "Only used when judgment is 'subsumption'. Set to the letter of the more general requirement; null otherwise.",
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        "Your confidence in the judgment. Use 'low' when domain context is missing or interpretation could swing the answer.",
    },
    rationale: {
      type: 'string',
      description:
        'One or two sentences explaining the judgment. Cite the specific slot or phrase that drove the decision.',
    },
  },
  required: ['judgment', 'confidence', 'rationale'],
}

function buildPairPrompt(a: ReqView, b: ReqView, reason: CandidatePair['reason']): string {
  return [
    `Requirement A (id=${a.id}):`,
    `  patternType:     ${a.patternType}`,
    `  preCondition:    ${a.preCondition ?? '(none)'}`,
    `  trigger:         ${a.trigger ?? '(none)'}`,
    `  systemName:      ${a.systemName}`,
    `  systemResponse:  ${a.systemResponse}`,
    `  rendered:        ${a.sentence}`,
    '',
    `Requirement B (id=${b.id}):`,
    `  patternType:     ${b.patternType}`,
    `  preCondition:    ${b.preCondition ?? '(none)'}`,
    `  trigger:         ${b.trigger ?? '(none)'}`,
    `  systemName:      ${b.systemName}`,
    `  systemResponse:  ${b.systemResponse}`,
    `  rendered:        ${b.sentence}`,
    '',
    `Free-tier flag reason: ${reason}`,
    '',
    'Decide the relationship between A and B and call report_pair_judgment.',
  ].join('\n')
}

export async function judgePair(
  call: CallModel,
  modelId: string,
  a: ReqView,
  b: ReqView,
  pair: CandidatePair,
): Promise<PairJudgment> {
  const { output } = await call({
    modelId,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildPairPrompt(a, b, pair.reason),
    toolName: 'report_pair_judgment',
    toolDescription: 'Report the relationship between requirement A and requirement B.',
    toolInputSchema: JUDGMENT_SCHEMA,
  })
  return output as PairJudgment
}
