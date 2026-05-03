import type { AiChatEvent } from './events'
import type {
  AiChatExecutionContext,
  PrepareAiContextInput,
  PreparedAiContext
} from './context-types'
import { runChatAgentLoop, runContextAgentLoop } from './agent-loop'
import { getProvider } from './get-provider'
import type { AiToolRunner } from './tool-runner'
import type { AiMessage, AiProviderConfig } from './types'

interface ChatRequestArgs {
  requestId: string
  messageId: string
  messages: AiMessage[]
  config: AiProviderConfig
  executionContext?: AiChatExecutionContext
  sendEvent: (event: AiChatEvent) => void
  signal?: AbortSignal
  toolRunner: AiToolRunner
}

interface CompletionRequestArgs {
  prefix: string
  suffix: string
  config: AiProviderConfig
  signal?: AbortSignal
  resolveConfig: (config: AiProviderConfig) => Promise<AiProviderConfig & { apiKey?: string }>
}

interface PrepareContextArgs extends PrepareAiContextInput {
  sendEvent: (event: AiChatEvent) => void
  toolRunner: AiToolRunner
}

interface TestConnectionArgs {
  config: AiProviderConfig
  resolveConfig: (config: AiProviderConfig) => Promise<AiProviderConfig & { apiKey?: string }>
}

export async function runChatRequest(args: ChatRequestArgs): Promise<void> {
  return runChatAgentLoop(args)
}

export async function runCompletionRequest(args: CompletionRequestArgs): Promise<string> {
  const resolvedConfig = await args.resolveConfig(args.config)
  const provider = getProvider(resolvedConfig.provider)
  return provider.complete(args.prefix, args.suffix, resolvedConfig, args.signal)
}

export async function testAiConnection(args: TestConnectionArgs): Promise<boolean> {
  const resolvedConfig = await args.resolveConfig(args.config)
  const provider = getProvider(resolvedConfig.provider)
  return provider.testConnection(resolvedConfig)
}

export async function prepareContextRequest(args: PrepareContextArgs): Promise<PreparedAiContext> {
  return runContextAgentLoop(args)
}
