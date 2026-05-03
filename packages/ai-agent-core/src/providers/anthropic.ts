import Anthropic from '@anthropic-ai/sdk'
import type { AiMessage, AiProvider, AiProviderConfig } from '../types'

export class AnthropicProvider implements AiProvider {
  async chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const client = new Anthropic({
      apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
    })

    const systemMsg = messages.find((m) => m.role === 'system')
    const chatMessages = messages.filter((m) => m.role !== 'system')

    const stream = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxTokens || 4096,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        system: systemMsg?.content,
        messages: chatMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
        stream: true
      },
      { signal }
    )

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onChunk(event.delta.text)
      }
    }
  }

  async complete(
    prefix: string,
    suffix: string,
    config: AiProviderConfig,
    signal?: AbortSignal
  ): Promise<string> {
    const client = new Anthropic({
      apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
    })

    const response = await client.messages.create(
      {
        model: config.model,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `Complete the following code. Return only the completion, no explanation.\n\nPrefix:\n${prefix}\n\nSuffix:\n${suffix}\n\nCompletion:`
          }
        ]
      },
      { signal }
    )

    const block = response.content[0]
    return block.type === 'text' ? block.text : ''
  }

  async testConnection(config: AiProviderConfig): Promise<boolean> {
    try {
      const client = new Anthropic({
        apiKey: (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
      })
      await client.models.list()
      return true
    } catch {
      return false
    }
  }
}
