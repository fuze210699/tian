import type { AiChatEvent } from './events'

export interface AiToolRunContext {
  requestId: string
  messageId: string
  sendEvent: (event: AiChatEvent) => void
  signal?: AbortSignal
}

export interface AiToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  description?: string
  inputSchema?: string
  agentEnabled?: boolean
  run: (input: TInput, context: AiToolRunContext) => Promise<TOutput>
  summarizeStart?: (input: TInput) => string | undefined
  summarizeEnd?: (output: TOutput, input: TInput) => string | undefined
  details?: (output: TOutput, input: TInput) => string | undefined
  formatResult?: (output: TOutput, input: TInput) => string
  isSuccess?: (output: TOutput, input: TInput) => boolean
}

export interface AiAgentToolSpec {
  name: string
  description: string
  inputSchema: string
}

export class AiToolRunner {
  private readonly tools = new Map<string, AiToolDefinition>()

  constructor(tools: ReadonlyArray<AiToolDefinition>) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  async run<TInput, TOutput>(
    name: string,
    input: TInput,
    context: AiToolRunContext
  ): Promise<TOutput> {
    const tool = this.tools.get(name) as AiToolDefinition<TInput, TOutput> | undefined
    if (!tool) {
      throw new Error(`Unknown AI tool: ${name}`)
    }

    const startSummary = tool.summarizeStart?.(input)
    context.sendEvent({
      type: 'tool-call-started',
      requestId: context.requestId,
      messageId: context.messageId,
      toolName: name,
      summary: startSummary
    })

    try {
      const output = await tool.run(input, context)
      const endSummary = tool.summarizeEnd?.(output, input) ?? startSummary
      const details = tool.details?.(output, input)
      context.sendEvent({
        type: 'tool-call-completed',
        requestId: context.requestId,
        messageId: context.messageId,
        toolName: name,
        summary: endSummary,
        details,
        success: tool.isSuccess?.(output, input) ?? true
      })
      return output
    } catch (error) {
      context.sendEvent({
        type: 'tool-call-completed',
        requestId: context.requestId,
        messageId: context.messageId,
        toolName: name,
        summary: startSummary,
        success: false
      })
      throw error
    }
  }

  getAgentTools(): AiAgentToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => tool.agentEnabled)
      .map((tool) => ({
        name: tool.name,
        description: tool.description || 'No description provided.',
        inputSchema: tool.inputSchema || '{}'
      }))
  }

  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  isAgentEnabled(name: string): boolean {
    return Boolean(this.tools.get(name)?.agentEnabled)
  }

  formatResult<TInput, TOutput>(name: string, output: TOutput, input: TInput): string {
    const tool = this.tools.get(name) as AiToolDefinition<TInput, TOutput> | undefined
    if (!tool) {
      throw new Error(`Unknown AI tool: ${name}`)
    }
    return tool.formatResult?.(output, input) ?? JSON.stringify(output, null, 2)
  }
}
