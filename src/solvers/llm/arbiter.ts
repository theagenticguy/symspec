/**
 * Claude Opus 4.7 arbiter for ensemble disagreements.
 *
 * When the primary and secondary judges disagree about a candidate pair, we
 * escalate to Claude Opus 4.7 with extended thinking ("xhigh") via Bedrock's
 * InvokeModel + Anthropic Messages API. The arbiter sees the full requirement
 * pair, the free-tier flag reason, and both prior judgments verbatim (model
 * id, judgment, confidence, rationale). It returns one structured verdict.
 *
 * Design choices:
 *   - InvokeModel (not Converse): the Anthropic Messages format is the native
 *     surface for Claude, and it's what gives us first-class control over the
 *     `thinking` parameter, `output_config.effort`, and the signed thinking
 *     blocks coming back in the response. Converse abstracts those away.
 *   - Adaptive thinking + xhigh effort: Opus 4.7's only supported thinking mode
 *     is `thinking: { type: "adaptive" }`; the older manual `enabled` +
 *     `budget_tokens` shape is rejected with a 400. Thinking depth is now
 *     controlled by the `output_config.effort` enum — we default to "xhigh",
 *     Anthropic's recommended starting point for agentic/coding workloads and
 *     the level designed for long-horizon arbitration.
 *   - Forced tool use: `tool_choice: { type: "tool", name: "report_arbitration" }`
 *     guarantees the model emits structured JSON conforming to our schema.
 *   - XML-tagged user message: per Anthropic's Claude prompting conventions,
 *     each input chunk lives inside semantic XML tags (<requirement_a>,
 *     <prior_judgment model="...">, <free_tier_reason>, <task>, <instructions>).
 *     This dramatically improves the model's ability to attend to the right
 *     piece at the right moment.
 *   - Critical instructions appear at the *top* of the system prompt AND at
 *     the *bottom* of the user message, which Anthropic guidance flags as the
 *     two locations the model reliably attends to.
 *   - `thinking.display: "summarized"` — Opus 4.7 defaults to "omitted" (empty
 *     `thinking` field, signature only). We opt back into summarized so the
 *     audit trail can include the arbiter's reasoning summary.
 *
 * Model id: defaults to the global cross-region inference profile for Opus 4.7,
 * overridable via BEDROCK_ARBITER_MODEL. Effort overridable via
 * BEDROCK_ARBITER_EFFORT (one of low | medium | high | xhigh | max).
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import type { CandidatePair, ReqView } from '../types.js'
import type { PairJudgment } from './judge-pair.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArbitrationInput = {
  a: ReqView
  b: ReqView
  pair: CandidatePair
  primaryModelId: string
  primaryJudgment: PairJudgment
  secondaryModelId: string
  secondaryJudgment: PairJudgment
}

export type ArbitrationVerdict = {
  finalJudgment: 'contradiction' | 'subsumption' | 'redundant' | 'compatible'
  whichOf: 'a' | 'b' | null
  confidence: 'high' | 'low'
  /** Which prior model's conclusion the arbiter sided with (or "neither"). */
  agreedWith: 'primary' | 'secondary' | 'neither'
  rationale: string
  caveat?: string
  /** Opaque signed extended-thinking block, returned for audit if present. */
  thinkingSignature?: string
}

export type CallArbiter = (input: ArbitrationInput) => Promise<ArbitrationVerdict>

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_REGION = process.env.AWS_REGION ?? 'us-east-1'

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof VALID_EFFORTS)[number]

function parseEffort(raw: string | undefined, fallback: Effort): Effort {
  if (!raw) return fallback
  return (VALID_EFFORTS as readonly string[]).includes(raw) ? (raw as Effort) : fallback
}

export const ARBITER = {
  modelId: process.env.BEDROCK_ARBITER_MODEL ?? 'global.anthropic.claude-opus-4-7-v1:0',
  /**
   * Effort level passed to Opus 4.7's adaptive-thinking pipeline. Defaults to
   * "xhigh" — the level designed for long-horizon agentic work and the
   * recommended starting point for arbitration over a disagreement.
   */
  effort: parseEffort(process.env.BEDROCK_ARBITER_EFFORT, 'xhigh'),
  /**
   * Hard ceiling on output tokens. At xhigh/max, Anthropic recommends starting
   * at 64k so the model has room to think *and* emit the tool call.
   */
  maxTokens: Number.parseInt(process.env.BEDROCK_ARBITER_MAX_TOKENS ?? '64000', 10),
} as const

let _client: BedrockRuntimeClient | null = null
function bedrock(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: DEFAULT_REGION })
  return _client
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Claude, an expert arbiter for requirements-engineering disputes that use the EARS (Easy Approach to Requirements Syntax) notation.

Your role is to break ties between two specialist models that disagreed about the relationship between a pair of EARS requirements. You receive the full requirements, the free-tier heuristic flag that surfaced them as a candidate, and both prior judgments verbatim. You produce one final verdict.

## How to reason
- Read both requirements carefully, slot by slot. The EARS slots are: patternType, preCondition, trigger, systemName, systemResponse.
- Determine whether the trigger or preCondition overlap is total, partial, or coincidental.
- Determine whether the systemResponse fields are compatible, mutually exclusive, or one is a strict special case of the other.
- Weigh the two prior rationales side by side: which is more rigorous, considers more cases, catches a subtle distinction the other missed?
- Be conservative. When evidence is weak or domain context is missing, prefer "compatible" over forcing a conflict label, and set confidence to "low".

## How to decide each label
- contradiction: A and B cannot both be satisfied by any conforming implementation. Typically same systemName + same/overlapping trigger or state + responses that exclude each other.
- subsumption: One requirement is a strict special case of the other. The "more general" requirement applies in a superset of the cases that the "more specific" one applies in, and their responses are consistent within that overlap. Set whichOf to "a" if A is the more general one, "b" if B is.
- redundant: A and B say the same thing in materially different words — no special case, no extra precondition, just two restatements. Set whichOf to null.
- compatible: No conflict. The free-tier flag was a false positive, or the apparent overlap is benign.

## Output discipline
- You MUST call the report_arbitration tool exactly once with your verdict.
- You MUST NOT emit prose outside the tool call.
- The rationale field must reference specific slots or phrases from <requirement_a> or <requirement_b>.
- Set agreedWith to "primary" or "secondary" to credit whichever prior model reached the same verdict you did; set "neither" if your verdict differs from both.
- If something genuinely cannot be resolved without external information, set confidence to "low" and explain the gap in caveat.

## Input shape conventions
- <requirement_a> and <requirement_b> wrap the two requirements with one inner tag per EARS slot.
- <free_tier_reason> wraps the heuristic flag that escalated this pair.
- <prior_judgment model="..."> wraps each prior model's verdict and rationale.
- <task> and <instructions> wrap your charge.

Critical: always emit the verdict via report_arbitration. Do not write commentary. Do not refuse. If genuinely uncertain, return compatible with confidence=low and explain in caveat.`

function xml(tag: string, body: string, attrs?: Record<string, string>): string {
  const attrStr = attrs
    ? ' ' +
      Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
        .join(' ')
    : ''
  return `<${tag}${attrStr}>\n${body}\n</${tag}>`
}

function escapeAttr(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function escapeText(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))
}

function renderRequirement(label: 'a' | 'b', r: ReqView): string {
  const inner = [
    `  <patternType>${escapeText(r.patternType)}</patternType>`,
    `  <preCondition>${escapeText(r.preCondition ?? '(none)')}</preCondition>`,
    `  <trigger>${escapeText(r.trigger ?? '(none)')}</trigger>`,
    `  <systemName>${escapeText(r.systemName)}</systemName>`,
    `  <systemResponse>${escapeText(r.systemResponse)}</systemResponse>`,
    `  <rendered>${escapeText(r.sentence)}</rendered>`,
  ].join('\n')
  return `<requirement_${label} id="${escapeAttr(r.id)}">\n${inner}\n</requirement_${label}>`
}

function renderPriorJudgment(
  modelId: string,
  role: 'primary' | 'secondary',
  j: PairJudgment,
): string {
  const inner = [
    `  <judgment>${escapeText(j.judgment)}</judgment>`,
    `  <which_of>${escapeText(String(j.whichOf ?? 'null'))}</which_of>`,
    `  <confidence>${escapeText(j.confidence)}</confidence>`,
    `  <rationale>${escapeText(j.rationale)}</rationale>`,
  ].join('\n')
  return `<prior_judgment role="${role}" model="${escapeAttr(modelId)}">\n${inner}\n</prior_judgment>`
}

function buildUserMessage(input: ArbitrationInput): string {
  return [
    xml(
      'task',
      'Arbitrate the relationship between requirement A and requirement B. The two specialist models disagreed; produce the final verdict.',
    ),
    renderRequirement('a', input.a),
    renderRequirement('b', input.b),
    xml('free_tier_reason', escapeText(input.pair.reason)),
    renderPriorJudgment(input.primaryModelId, 'primary', input.primaryJudgment),
    renderPriorJudgment(input.secondaryModelId, 'secondary', input.secondaryJudgment),
    xml(
      'instructions',
      [
        'Think step-by-step inside your private reasoning. Identify the strongest argument from each prior judgment. Decide whether either is correct, or whether you reach a different conclusion entirely.',
        'Then call report_arbitration with the final verdict. Reference specific slots or phrases when you justify your choice.',
        'Do not write any text outside the tool call.',
      ].join('\n'),
    ),
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// Tool schema for forced-tool-use output
// ---------------------------------------------------------------------------

const ARBITRATION_TOOL = {
  name: 'report_arbitration',
  description:
    'Report the final arbitration verdict for the requirement pair. Always call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      finalJudgment: {
        type: 'string',
        enum: ['contradiction', 'subsumption', 'redundant', 'compatible'],
        description:
          'Final classification of the relationship between requirement A and requirement B.',
      },
      whichOf: {
        type: ['string', 'null'],
        enum: ['a', 'b', null],
        description:
          "Only meaningful when finalJudgment='subsumption'. Set to 'a' if requirement A is the more general one, 'b' if requirement B is. Use null in all other cases.",
      },
      confidence: {
        type: 'string',
        enum: ['high', 'low'],
        description:
          "Your confidence in the final verdict. Use 'low' when external domain context could change the answer.",
      },
      agreedWith: {
        type: 'string',
        enum: ['primary', 'secondary', 'neither'],
        description:
          "Which prior model's conclusion you ultimately endorsed. 'neither' if your verdict differs from both prior models.",
      },
      rationale: {
        type: 'string',
        description:
          'One short paragraph justifying the verdict, referencing specific EARS slots or phrases.',
      },
      caveat: {
        type: 'string',
        description:
          'Optional. Anything genuinely uncertain or dependent on external information. Omit if there is nothing material to flag.',
      },
    },
    required: ['finalJudgment', 'confidence', 'agreedWith', 'rationale'],
  },
} as const

// ---------------------------------------------------------------------------
// Bedrock implementation
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

type AnthropicResponse = {
  content: AnthropicContentBlock[]
  stop_reason?: string
}

export const bedrockArbiter: CallArbiter = async (input) => {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: ARBITER.maxTokens,
    // Opus 4.7: adaptive thinking is the only supported mode; effort lives in
    // output_config. display="summarized" opts back into Anthropic-summarized
    // reasoning text for the audit trail (4.7 defaults to "omitted").
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: ARBITER.effort },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: buildUserMessage(input) }],
      },
    ],
    tools: [ARBITRATION_TOOL],
    tool_choice: { type: 'tool', name: ARBITRATION_TOOL.name },
  }

  const response = await bedrock().send(
    new InvokeModelCommand({
      modelId: ARBITER.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(body)),
    }),
  )

  const text = new TextDecoder().decode(response.body)
  const parsed = JSON.parse(text) as AnthropicResponse

  const toolUse = parsed.content.find(
    (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === ARBITRATION_TOOL.name,
  )
  if (!toolUse) {
    const raw = parsed.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    throw new Error(
      `Arbiter ${ARBITER.modelId} did not call ${ARBITRATION_TOOL.name}. Raw: ${raw.slice(0, 300)}`,
    )
  }
  const verdict = toolUse.input as Omit<ArbitrationVerdict, 'thinkingSignature'>
  const thinking = parsed.content.find(
    (b): b is Extract<AnthropicContentBlock, { type: 'thinking' }> => b.type === 'thinking',
  )
  const result: ArbitrationVerdict = {
    ...verdict,
    whichOf: verdict.whichOf ?? null,
  }
  if (thinking?.signature) result.thinkingSignature = thinking.signature
  return result
}
