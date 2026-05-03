import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AiMessage, AiProvider, AiProviderConfig } from '../types'

export class GeminiProvider implements AiProvider {
  async chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const genAI = new GoogleGenerativeAI(
      (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
    )
    const systemMsg = messages.find((message) => message.role === 'system')
    const model = genAI.getGenerativeModel({
      model: config.model,
      ...(systemMsg?.content ? { systemInstruction: systemMsg.content } : {}),
      generationConfig: {
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { maxOutputTokens: config.maxTokens })
      }
    })

    const history = messages
      .filter((m) => m.role !== 'system')
      .slice(0, -1)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))

    const lastMessage = messages.filter((m) => m.role !== 'system').at(-1)
    if (!lastMessage) return

    const chat = model.startChat({ history })
    const result = await chat.sendMessageStream(lastMessage.content)

    for await (const chunk of result.stream) {
      if (signal?.aborted) break
      const text = chunk.text()
      if (text) onChunk(text)
    }
  }

  async complete(
    prefix: string,
    suffix: string,
    config: AiProviderConfig,
    signal?: AbortSignal
  ): Promise<string> {
    void signal
    const genAI = new GoogleGenerativeAI(
      (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
    )
    const model = genAI.getGenerativeModel({ model: config.model })
    const prompt = `Complete this code. Return only the completion:\n\n${prefix}[CURSOR]${suffix}`
    const result = await model.generateContent(prompt)
    return result.response.text()
  }

  async testConnection(config: AiProviderConfig): Promise<boolean> {
    try {
      const genAI = new GoogleGenerativeAI(
        (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
      )
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
      await model.generateContent('ping')
      return true
    } catch {
      return false
    }
  }
}
