import type { AiProvider } from './types'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { AnthropicProvider } from './providers/anthropic'
import { GeminiProvider } from './providers/gemini'
import { OllamaProvider } from './providers/ollama'

const openAiCompatible = new OpenAiCompatibleProvider()
const anthropic = new AnthropicProvider()
const gemini = new GeminiProvider()
const ollama = new OllamaProvider()

export function getProvider(providerName: string): AiProvider {
  switch (providerName) {
    case 'anthropic':
      return anthropic
    case 'gemini':
      return gemini
    case 'ollama':
      return ollama
    case 'openai':
    case 'groq':
    case 'openrouter':
    default:
      return openAiCompatible
  }
}
