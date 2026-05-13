/**
 * Bedrock client wrapper using the Converse API + forced tool-use for
 * schema-validated structured output.
 *
 * Why Converse instead of native model APIs:
 *   - Single message/response shape across Nova, Anthropic, Mistral, GLM,
 *     etc. — model swap is a config change, not a code change.
 *   - Uniform toolConfig surface, so the same "report_judgment" tool spec
 *     works against every supported model.
 *
 * Why forced tool-use:
 *   - The model is *forced* to call our reporting tool, and the tool's
 *     inputSchema is a JSON Schema we author. The Bedrock service validates
 *     the tool input on its side, so the JSON we get back is guaranteed-shaped
 *     (modulo network failures + retries). This eliminates a whole class of
 *     "model returned prose when I asked for JSON" failure modes.
 *
 * The exported `callModel` type is the surface the judges depend on; tests
 * pass a mock implementation, production wires up Bedrock.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime'

export type CallModelArgs = {
  modelId: string
  systemPrompt: string
  userPrompt: string
  toolName: string
  toolDescription: string
  /** JSON Schema (draft-07 compatible) describing the expected tool input. */
  toolInputSchema: Record<string, unknown>
  /** 0 by default — judges should be deterministic. */
  temperature?: number
  /** Default 1024. */
  maxTokens?: number
}

/**
 * A pluggable "call this model with this prompt, give me schema-validated JSON"
 * function. Real implementation hits Bedrock; tests swap in a stub.
 */
export type CallModel = (args: CallModelArgs) => Promise<{
  output: Record<string, unknown>
  rawText?: string
}>

const DEFAULT_REGION = process.env.AWS_REGION ?? 'us-east-1'

let _client: BedrockRuntimeClient | null = null
function bedrock(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: DEFAULT_REGION })
  return _client
}

export const bedrockCallModel: CallModel = async ({
  modelId,
  systemPrompt,
  userPrompt,
  toolName,
  toolDescription,
  toolInputSchema,
  temperature = 0,
  maxTokens = 1024,
}) => {
  const messages: Message[] = [{ role: 'user', content: [{ text: userPrompt }] }]
  const tool: Tool = {
    toolSpec: {
      name: toolName,
      description: toolDescription,
      inputSchema: { json: toolInputSchema as never },
    },
  }

  const response = await bedrock().send(
    new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: { maxTokens, temperature },
      toolConfig: {
        tools: [tool],
        toolChoice: { tool: { name: toolName } },
      },
    }),
  )

  const blocks = response.output?.message?.content ?? []
  // Find the tool_use block — that's the structured answer.
  const toolUse = blocks
    .map((b) => b.toolUse)
    .find((b): b is ToolUseBlock => Boolean(b && b.name === toolName))
  if (!toolUse?.input) {
    const text = blocks.map((b) => b.text ?? '').join('')
    throw new Error(`Model ${modelId} did not call ${toolName}. Raw text: ${text.slice(0, 200)}`)
  }
  const rawText = blocks.map((b) => b.text ?? '').join('')
  return {
    output: toolUse.input as Record<string, unknown>,
    ...(rawText ? { rawText } : {}),
  }
}

/**
 * Model IDs. Defaults match the user's chosen ensemble; override with env vars
 * so the same code runs against any pair of Bedrock-hosted models.
 */
export const MODELS = {
  primary: process.env.BEDROCK_MODEL_PRIMARY ?? 'amazon.nova-2-lite-v1:0',
  secondary: process.env.BEDROCK_MODEL_SECONDARY ?? 'zai.glm-5-v1:0',
} as const
