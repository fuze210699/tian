import { fetch as undiciFetch, ProxyAgent } from 'undici'

type UndiciFetch = typeof undiciFetch

const agentCache = new Map<string, ProxyAgent>()

export function createFetchWithOptionalProxy(httpProxy?: string): typeof globalThis.fetch {
  const trimmed = httpProxy?.trim()
  if (!trimmed) {
    return globalThis.fetch.bind(globalThis)
  }
  let agent = agentCache.get(trimmed)
  if (!agent) {
    agent = new ProxyAgent(trimmed)
    agentCache.set(trimmed, agent)
  }
  const dispatcher = agent
  return ((input: Parameters<UndiciFetch>[0], init?: Parameters<UndiciFetch>[1]) =>
    undiciFetch(input, {
      ...init,
      dispatcher
    })) as typeof globalThis.fetch
}
