import * as vscode from 'vscode'
import type { AiProviderConfig } from '../../../packages/ai-agent-core/src/index'

export function getTianAiProviderConfigFromWorkspace(): AiProviderConfig {
  const cfg = vscode.workspace.getConfiguration('tian-ai')
  const httpProxyRaw = cfg.get<string>('httpProxy', '')
  const httpProxy = httpProxyRaw?.trim()
  return {
    provider: cfg.get<string>('provider', 'openai'),
    model: cfg.get<string>('model', 'gpt-4o-mini'),
    baseUrl: cfg.get<string>('baseUrl', '') || undefined,
    ...(httpProxy ? { httpProxy } : {}),
    temperature: cfg.get<number | null>('temperature') ?? undefined,
    maxTokens: cfg.get<number | null>('maxTokens') ?? undefined
  }
}
