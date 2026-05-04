import { GoogleGenerativeAI } from '@google/generative-ai'
import { createFetchWithOptionalProxy } from '../http/proxyFetch'
import type { AiMessage, AiProvider, AiProviderConfig, ResolvedAiConfig } from '../types'

const DEFAULT_GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com'

function geminiApiRoot(config: AiProviderConfig): string {
  const raw = config.baseUrl?.trim()
  if (raw) {
    return raw.replace(/\/$/, '')
  }
  return DEFAULT_GEMINI_ORIGIN
}

function toGeminiContents(messages: AiMessage[]): {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>
  systemInstruction?: { parts: Array<{ text: string }> }
} {
  const systemMsg = messages.find((m) => m.role === 'system')
  const tail = messages.filter((m) => m.role !== 'system')
  const contents = tail.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }))
  return {
    contents,
    ...(systemMsg?.content ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {})
  }
}

function extractGeminiStreamText(chunk: Record<string, unknown>): string {
  const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined
  if (!candidates?.length) return ''
  const content = candidates[0].content as Record<string, unknown> | undefined
  const parts = content?.parts as Array<Record<string, unknown>> | undefined
  if (!parts?.length) return ''
  return parts.map((p) => String(p.text ?? '')).join('')
}

async function consumeGeminiSse(
  response: Response,
  onChunk: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.body) return
  const reader = response.body.pipeThrough(new TextDecoderStream('utf-8')).getReader()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (signal?.aborted) break
    buffer += value
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const block = buffer.slice(0, sep).trim()
      buffer = buffer.slice(sep + 2)
      const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'))
      if (dataLine) {
        const raw = dataLine.slice(5).trim()
        if (raw && raw !== '[DONE]') {
          try {
            const obj = JSON.parse(raw) as Record<string, unknown>
            const t = extractGeminiStreamText(obj)
            if (t) onChunk(t)
          } catch {
            // ignore malformed json
          }
        }
      }
      sep = buffer.indexOf('\n\n')
    }
  }
}

async function geminiRestChatStream(
  messages: AiMessage[],
  config: AiProviderConfig,
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const resolved = config as ResolvedAiConfig
  const apiKey = resolved.apiKey || ''
  const fetchImpl = createFetchWithOptionalProxy(resolved.httpProxy)
  const root = geminiApiRoot(config)
  const { contents, systemInstruction } = toGeminiContents(messages)
  const url = `${root}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig: {
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(config.maxTokens !== undefined && { maxOutputTokens: config.maxTokens })
    }
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 500)}`)
  }
  await consumeGeminiSse(response, onChunk, signal)
}

async function geminiRestComplete(
  prefix: string,
  suffix: string,
  config: AiProviderConfig,
  signal?: AbortSignal
): Promise<string> {
  const resolved = config as ResolvedAiConfig
  const apiKey = resolved.apiKey || ''
  const fetchImpl = createFetchWithOptionalProxy(resolved.httpProxy)
  const root = geminiApiRoot(config)
  const prompt = `Complete this code. Return only the completion:\n\n${prefix}[CURSOR]${suffix}`
  const url = `${root}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 256 }
    }),
    signal
  })
  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 500)}`)
  }
  const json = (await response.json()) as Record<string, unknown>
  const cands = json.candidates as Array<Record<string, unknown>> | undefined
  const content = cands?.[0]?.content as Record<string, unknown> | undefined
  const parts = content?.parts as Array<Record<string, unknown>> | undefined
  return parts?.map((p) => String(p.text ?? '')).join('') ?? ''
}

async function geminiRestPing(config: AiProviderConfig): Promise<boolean> {
  const resolved = config as ResolvedAiConfig
  const apiKey = resolved.apiKey || ''
  if (!apiKey) return false
  const fetchImpl = createFetchWithOptionalProxy(resolved.httpProxy)
  const root = geminiApiRoot(config)
  const response = await fetchImpl(`${root}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`)
  return response.ok
}

export class GeminiProvider implements AiProvider {
  private useRest(config: AiProviderConfig): boolean {
    return Boolean((config as ResolvedAiConfig).httpProxy?.trim())
  }

  async chatStream(
    messages: AiMessage[],
    config: AiProviderConfig,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.useRest(config)) {
      await geminiRestChatStream(messages, config, onChunk, signal)
      return
    }

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
    if (this.useRest(config)) {
      return geminiRestComplete(prefix, suffix, config, signal)
    }

    const genAI = new GoogleGenerativeAI(
      (config as AiProviderConfig & { apiKey?: string }).apiKey || ''
    )
    const model = genAI.getGenerativeModel({ model: config.model })
    const prompt = `Complete this code. Return only the completion:\n\n${prefix}[CURSOR]${suffix}`
    const result = await model.generateContent(prompt)
    return result.response.text()
  }

  async testConnection(config: AiProviderConfig): Promise<boolean> {
    if (this.useRest(config)) {
      return geminiRestPing(config)
    }
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
