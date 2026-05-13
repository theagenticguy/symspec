/**
 * Single-requirement ambiguity LLM judge. Complements the lexical weasel-word
 * scan by catching contextual ambiguity — e.g., "the system shall handle high
 * load" doesn't trip on any word in the weasel list, but "handle" + "high
 * load" are domain-vague.
 */

import type { ReqView } from '../types.js'
import type { CallModel } from './bedrock-client.js'

export type AmbiguityJudgment = {
  ambiguous: boolean
  phrases: string[]
  suggestedRewrites: string[]
  rationale: string
}

const SYSTEM_PROMPT = [
  'You are an expert in requirements engineering using the EARS (Easy Approach to Requirements Syntax) notation.',
  'You evaluate a single requirement for ambiguity — phrases that could be interpreted differently by different engineers.',
  "You ignore weasel words that are already covered by a lexical scan (e.g., 'fast', 'robust', 'etc.', 'as needed').",
  'You focus on contextual ambiguity: domain-vague verbs, unspecified subjects of comparison, missing units, unclear scope.',
  'You always answer by calling the report_ambiguity tool — never plain prose.',
].join('\n')

const AMBIGUITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ambiguous: {
      type: 'boolean',
      description:
        'True iff the requirement contains contextual ambiguity that would lead two engineers to disagree about what it requires.',
    },
    phrases: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The specific phrases in the requirement that are ambiguous. Empty when ambiguous=false.',
    },
    suggestedRewrites: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Concrete suggested rewrites that resolve the ambiguity, one per ambiguous phrase. May be empty if the fix is obvious.',
    },
    rationale: {
      type: 'string',
      description:
        'One or two sentences explaining the judgment. If not ambiguous, briefly justify why.',
    },
  },
  required: ['ambiguous', 'phrases', 'suggestedRewrites', 'rationale'],
}

function buildAmbiguityPrompt(r: ReqView): string {
  return [
    `Requirement (id=${r.id}):`,
    `  patternType:     ${r.patternType}`,
    `  preCondition:    ${r.preCondition ?? '(none)'}`,
    `  trigger:         ${r.trigger ?? '(none)'}`,
    `  systemName:      ${r.systemName}`,
    `  systemResponse:  ${r.systemResponse}`,
    `  rendered:        ${r.sentence}`,
    '',
    'Call report_ambiguity with your evaluation.',
  ].join('\n')
}

export async function judgeAmbiguity(
  call: CallModel,
  modelId: string,
  r: ReqView,
): Promise<AmbiguityJudgment> {
  const { output } = await call({
    modelId,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildAmbiguityPrompt(r),
    toolName: 'report_ambiguity',
    toolDescription: 'Report whether this single requirement is contextually ambiguous.',
    toolInputSchema: AMBIGUITY_SCHEMA,
  })
  return output as AmbiguityJudgment
}
