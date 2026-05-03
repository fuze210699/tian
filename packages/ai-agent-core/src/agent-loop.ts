import type {
  AiChatExecutionContext,
  PrepareAiContextInput,
  PreparedAiContext
} from './context-types'
import type { AiChatEvent } from './events'
import { getProvider } from './get-provider'
import {
  buildAgentMessages,
  buildAgentSystemPrompt,
  buildToolResultMessage,
  parseAgentResponse
} from './agent-protocol'
import type { AiMessage, AiProviderConfig, ResolvedAiConfig } from './types'
import type { AiToolRunContext, AiToolRunner } from './tool-runner'

const MAX_AGENT_STEPS = 6
const RESPONSE_CHUNK_SIZE = 160

interface AgentLoopContext {
  requestId: string
  messageId: string
  sendEvent: (event: AiChatEvent) => void
  signal?: AbortSignal
}

interface ChatAgentLoopArgs extends AgentLoopContext {
  messages: AiMessage[]
  config: AiProviderConfig
  executionContext?: AiChatExecutionContext
  toolRunner: AiToolRunner
}

interface ContextAgentLoopArgs extends PrepareAiContextInput {
  sendEvent: (event: AiChatEvent) => void
  toolRunner: AiToolRunner
}

export async function runChatAgentLoop(args: ChatAgentLoopArgs): Promise<void> {
  const {
    requestId,
    messageId,
    messages,
    config,
    sendEvent,
    signal,
    executionContext,
    toolRunner
  } = args
  const toolContext = { requestId, messageId, sendEvent, signal }

  sendEvent({ type: 'response-started', requestId, messageId })

  sendEvent({ type: 'status-update', requestId, messageId, label: 'Resolving credentials' })
  const resolvedConfig = await toolRunner.run<{ config: AiProviderConfig }, ResolvedAiConfig>(
    'credentials.lookup',
    { config },
    toolContext
  )

  sendEvent({ type: 'status-update', requestId, messageId, label: 'Selecting provider' })
  const provider = getProvider(resolvedConfig.provider)
  const toolPrompt = buildAgentSystemPrompt({
    tools: toolRunner.getAgentTools(),
    currentFolder: executionContext?.currentFolder || null
  })
  const workingMessages = buildAgentMessages({
    messages,
    systemPrompt: toolPrompt
  })

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    sendEvent({
      type: 'status-update',
      requestId,
      messageId,
      label: step === 0 ? 'Planning response' : `Planning step ${step + 1}`
    })

    const rawResponse = await collectAssistantResponse({
      provider,
      messages: workingMessages,
      config: resolvedConfig,
      signal
    })
    const parsedResponse = parseAgentResponse(rawResponse)

    if (parsedResponse.kind === 'final') {
      sendEvent({ type: 'status-update', requestId, messageId, label: 'Streaming response' })
      emitResponseText(parsedResponse.text, { requestId, messageId, sendEvent })
      sendEvent({ type: 'response-completed', requestId, messageId })
      return
    }

    const toolName = parsedResponse.toolCall.tool
    if (!toolRunner.hasTool(toolName) || !toolRunner.isAgentEnabled(toolName)) {
      workingMessages.push({ role: 'assistant', content: rawResponse })
      workingMessages.push(
        buildToolResultMessage(
          toolName,
          `Tool "${toolName}" is not available. Available tools: ${toolRunner
            .getAgentTools()
            .map((tool) => tool.name)
            .join(', ')}`
        )
      )
      continue
    }

    workingMessages.push({ role: 'assistant', content: rawResponse })
    try {
      const result = await runAgentTool({
        toolName,
        input: parsedResponse.toolCall.input,
        currentFolder: executionContext?.currentFolder || null,
        toolRunner,
        toolContext
      })
      workingMessages.push(buildToolResultMessage(toolName, result))
    } catch (error) {
      workingMessages.push(
        buildToolResultMessage(
          toolName,
          `Tool "${toolName}" failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
  }

  const fallbackMessage =
    'I could not complete the request within the current step limit. Please refine the request or try again.'
  sendEvent({ type: 'status-update', requestId, messageId, label: 'Reached step limit' })
  emitResponseText(fallbackMessage, { requestId, messageId, sendEvent })
  sendEvent({ type: 'response-completed', requestId, messageId })
}

export async function runContextAgentLoop(args: ContextAgentLoopArgs): Promise<PreparedAiContext> {
  const { requestId, messageId, currentFolder, sendEvent, toolRunner } = args
  let content = args.content
  const contextBadges: string[] = []
  const toolContext: AiToolRunContext = { requestId, messageId, sendEvent }

  sendEvent({ type: 'status-update', requestId, messageId, label: 'Preparing context' })

  const workspaceMatch = content.match(/@workspace\s+(.*)/s)
  if (workspaceMatch) {
    const workspaceQuery = workspaceMatch[1].trim() || content
    const workspaceResults: { query: string; content: string } = await toolRunner.run(
      'workspace-search',
      {
        currentFolder,
        query: workspaceQuery
      },
      toolContext
    )
    if (workspaceResults.content) {
      contextBadges.push('@workspace')
      content = `Workspace search results for "${workspaceResults.query}":\n\`\`\`\n${workspaceResults.content}\n\`\`\`\n\n${content}`
    }
  }

  if (content.includes('@selection')) {
    const selectionResult: { content: string; hasSelection: boolean } = await toolRunner.run(
      'attach-selection',
      { selection: args.selection },
      toolContext
    )
    content = content.replace('@selection', selectionResult.content)
    if (selectionResult.hasSelection) {
      contextBadges.push('@selection')
    }
  }

  if ((args.contextFiles?.length || 0) > 0) {
    const filesResult: { content: string; summary: string } = await toolRunner.run(
      'attach-files',
      { files: args.contextFiles },
      toolContext
    )
    content = `${filesResult.content}\n\n${content}`
    contextBadges.push(filesResult.summary)
  }

  if (content.includes('@git')) {
    const diffResult: { content: string } = await toolRunner.run(
      'git-diff',
      { currentFolder },
      toolContext
    )
    if (diffResult.content) {
      contextBadges.push('@git')
    }
    content = content.replace(
      '@git',
      diffResult.content
        ? `[Git changes]\n\`\`\`diff\n${diffResult.content}\n\`\`\``
        : '[no git changes]'
    )
  }

  sendEvent({ type: 'status-update', requestId, messageId, label: 'Context ready' })

  return {
    content,
    contextBadges
  }
}

async function collectAssistantResponse(args: {
  provider: ReturnType<typeof getProvider>
  messages: AiMessage[]
  config: ResolvedAiConfig
  signal?: AbortSignal
}): Promise<string> {
  let response = ''
  await args.provider.chatStream(
    args.messages,
    args.config,
    (chunk) => {
      response += chunk
    },
    args.signal
  )
  return response.trim()
}

async function runAgentTool(args: {
  toolName: string
  input: Record<string, unknown>
  currentFolder: string | null
  toolRunner: AiToolRunner
  toolContext: AiToolRunContext
}): Promise<string> {
  const { toolRunner, toolContext } = args
  switch (args.toolName) {
    case 'search-workspace': {
      const result: { query: string; content: string } = await toolRunner.run(
        'search-workspace',
        {
          currentFolder: args.currentFolder,
          query: String(args.input.query || '')
        },
        toolContext
      )
      return toolRunner.formatResult('search-workspace', result, {
        currentFolder: args.currentFolder,
        query: String(args.input.query || '')
      })
    }
    case 'read-file': {
      const result: { path: string; content: string } = await toolRunner.run(
        'read-file',
        {
          path: String(args.input.path || ''),
          currentFolder: args.currentFolder
        },
        toolContext
      )
      return toolRunner.formatResult('read-file', result, {
        path: String(args.input.path || ''),
        currentFolder: args.currentFolder
      })
    }
    case 'git-diff': {
      const result: { content: string } = await toolRunner.run(
        'git-diff',
        { currentFolder: args.currentFolder },
        toolContext
      )
      return toolRunner.formatResult('git-diff', result, {
        currentFolder: args.currentFolder
      })
    }
    default:
      throw new Error(`Unsupported agent tool: ${args.toolName}`)
  }
}

function emitResponseText(
  text: string,
  args: {
    requestId: string
    messageId: string
    sendEvent: (event: AiChatEvent) => void
  }
): void {
  const chunks = chunkResponse(text, RESPONSE_CHUNK_SIZE)
  if (chunks.length === 0) {
    args.sendEvent({
      type: 'response-delta',
      requestId: args.requestId,
      messageId: args.messageId,
      delta: ''
    })
    return
  }

  for (const chunk of chunks) {
    args.sendEvent({
      type: 'response-delta',
      requestId: args.requestId,
      messageId: args.messageId,
      delta: chunk
    })
  }
}

function chunkResponse(text: string, size: number): string[] {
  if (!text) return []
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}
