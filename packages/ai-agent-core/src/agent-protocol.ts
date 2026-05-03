import type { AiMessage } from './types'
import type { AiAgentToolSpec } from './tool-runner'

interface ParsedToolCall {
  tool: string
  input: Record<string, unknown>
}

export type ParsedAgentResponse =
  | {
      kind: 'tool_call'
      raw: string
      toolCall: ParsedToolCall
    }
  | {
      kind: 'final'
      raw: string
      text: string
    }

const TOOL_CALL_TAG = 'tool_call'
const FINAL_ANSWER_TAG = 'final_answer'

export function buildAgentSystemPrompt(args: {
  tools: AiAgentToolSpec[]
  currentFolder: string | null
}): string {
  const toolList = args.tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  input: ${tool.inputSchema}`)
    .join('\n')

  return [
    'You are Tian IDE chat agent.',
    args.currentFolder
      ? `The current workspace root is: ${args.currentFolder}`
      : 'There may be no workspace root available.',
    'You can either answer directly or call exactly one tool at a time.',
    'When you need a tool, respond with ONLY this XML block:',
    `<${TOOL_CALL_TAG}>`,
    '{"tool":"tool-name","input":{"key":"value"}}',
    `</${TOOL_CALL_TAG}>`,
    'When you are ready to answer the user, respond with ONLY this XML block:',
    `<${FINAL_ANSWER_TAG}>`,
    'Your final answer here',
    `</${FINAL_ANSWER_TAG}>`,
    'Do not wrap the XML block in markdown fences.',
    'Do not call tools for information you already have in the conversation.',
    'When proposing code edits, prefer unified diff fences so the UI can render review cards:',
    '```diff path=relative/path.ext',
    '--- a/relative/path.ext',
    '+++ b/relative/path.ext',
    '@@ -oldStart,oldCount +newStart,newCount @@',
    '-old line',
    '+new line',
    '```',
    'Use normal code fences only for examples that should not be applied.',
    'Available tools:',
    toolList
  ].join('\n')
}

export function buildAgentMessages(args: {
  messages: AiMessage[]
  systemPrompt: string
}): AiMessage[] {
  const systemMessages = args.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
  const nonSystemMessages = args.messages.filter((message) => message.role !== 'system')
  const combinedSystem = [...systemMessages, args.systemPrompt].filter(Boolean).join('\n\n')

  return combinedSystem
    ? [{ role: 'system', content: combinedSystem }, ...nonSystemMessages]
    : nonSystemMessages
}

export function parseAgentResponse(raw: string): ParsedAgentResponse {
  const toolCallPayload = extractTaggedBlock(raw, TOOL_CALL_TAG)
  if (toolCallPayload) {
    try {
      const parsed = JSON.parse(stripMarkdownCodeFence(toolCallPayload)) as ParsedToolCall
      if (
        parsed &&
        typeof parsed.tool === 'string' &&
        parsed.input &&
        typeof parsed.input === 'object'
      ) {
        return {
          kind: 'tool_call',
          raw,
          toolCall: parsed
        }
      }
    } catch {
      void 0
    }
  }

  const finalAnswer = extractTaggedBlock(raw, FINAL_ANSWER_TAG)
  return {
    kind: 'final',
    raw,
    text: (finalAnswer || raw).trim()
  }
}

export function buildToolResultMessage(toolName: string, result: string): AiMessage {
  return {
    role: 'user',
    content: [
      `Tool result for ${toolName}:`,
      '<tool_result>',
      result,
      '</tool_result>',
      'Decide whether you need another tool or can provide the final answer.'
    ].join('\n')
  }
}

function extractTaggedBlock(raw: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i')
  return raw.match(pattern)?.[1]?.trim() || null
}

function stripMarkdownCodeFence(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}
