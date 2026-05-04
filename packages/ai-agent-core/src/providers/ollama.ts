import { createFetchWithOptionalProxy } from '../http/proxyFetch'
import type { AiMessage, AiProvider, AiProviderConfig, ResolvedAiConfig } from '../types'

export class OllamaProvider implements AiProvider {
  private getBaseUrl(config: AiProviderConfig): string {
    return config.baseUrl || 'http://localhost:11434'
  }

  private getFetch(config: AiProviderConfig) {
    return createFetchWithOptionalProxy((config as ResolvedAiConfig).httpProxy)
  }

  async chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const fetchImpl = this.getFetch(config)
    const baseUrl = this.getBaseUrl(config)
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        options: {
          ...(config.temperature !== undefined && { temperature: config.temperature }),
          ...(config.maxTokens !== undefined && { num_predict: config.maxTokens })
        }
      }),
      signal
    })

    if (!response.ok) throw new Error(`Ollama error: ${response.statusText}`)
    if (!response.body) return

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const json = JSON.parse(line) as { message?: { content?: string } }
          if (json.message?.content) onChunk(json.message.content)
        } catch {
          // skip malformed line
        }
      }
    }
  }

  async complete(
    prefix: string,
    suffix: string,
    config: AiProviderConfig,
    signal?: AbortSignal
  ): Promise<string> {
    const fetchImpl = this.getFetch(config)
    const baseUrl = this.getBaseUrl(config)
    const response = await fetchImpl(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: prefix,
        suffix,
        stream: false,
        options: { num_predict: 128 }
      }),
      signal
    })

    if (!response.ok) throw new Error(`Ollama error: ${response.statusText}`)
    const json = (await response.json()) as { response?: string }
    return json.response ?? ''
  }

  async testConnection(config: AiProviderConfig): Promise<boolean> {
    try {
      const fetchImpl = this.getFetch(config)
      const baseUrl = this.getBaseUrl(config)
      const response = await fetchImpl(`${baseUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }
}
