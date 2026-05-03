import OpenAI from 'openai'
import type { AiMessage, AiProvider, AiProviderConfig } from '../types'

export class OpenAiCompatibleProvider implements AiProvider {
  private getDefaultBaseUrl(provider: string): string {
    switch (provider) {
      case 'groq':
        return 'https://api.groq.com/openai/v1'
      case 'openrouter':
        return 'https://openrouter.ai/api/v1'
      default:
        return 'https://api.openai.com/v1'
    }
  }

  async chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const client = new OpenAI({
      apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || '',
      baseURL: config.baseUrl || this.getDefaultBaseUrl(config.provider),
      defaultHeaders:
        config.provider === 'openrouter'
          ? { 'HTTP-Referer': 'https://tian-ide.app', 'X-Title': 'Tian IDE' }
          : undefined
    })

    const stream = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        stream: true,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens })
      },
      { signal }
    )

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) onChunk(content)
    }
  }

  async complete(
    prefix: string,
    suffix: string,
    config: AiProviderConfig,
    signal?: AbortSignal
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || '',
      baseURL: config.baseUrl || this.getDefaultBaseUrl(config.provider)
    })

    const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    const response = await client.completions.create(
      {
        model: config.model,
        prompt,
        max_tokens: 256,
        stop: ['<|fim_middle|>', '<|endoftext|>']
      },
      { signal }
    )

    return response.choices[0]?.text || ''
  }

  async testConnection(config: AiProviderConfig): Promise<boolean> {
    try {
      const client = new OpenAI({
        apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || '',
        baseURL: config.baseUrl || this.getDefaultBaseUrl(config.provider)
      })
      await client.models.list()
      return true
    } catch {
      return false
    }
  }
}
