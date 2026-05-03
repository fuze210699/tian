export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AiProviderConfig {
  provider: string
  model: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
}

export type ResolvedAiConfig = AiProviderConfig & { apiKey?: string }

export interface AiProvider {
  chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void>

  complete(
    prefix: string,
    suffix: string,
    config: AiProviderConfig,
    signal?: AbortSignal
  ): Promise<string>

  testConnection(config: AiProviderConfig): Promise<boolean>
}
