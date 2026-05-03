export type AiChatEvent =
  | {
      type: 'response-started'
      requestId: string
      messageId: string
    }
  | {
      type: 'response-delta'
      requestId: string
      messageId: string
      delta: string
    }
  | {
      type: 'response-completed'
      requestId: string
      messageId: string
    }
  | {
      type: 'response-aborted'
      requestId: string
      messageId: string
    }
  | {
      type: 'response-error'
      requestId: string
      messageId: string
      error: string
    }
  | {
      type: 'status-update'
      requestId: string
      messageId: string
      label: string
    }
  | {
      type: 'tool-call-started'
      requestId: string
      messageId: string
      toolName: string
      summary?: string
    }
  | {
      type: 'tool-call-completed'
      requestId: string
      messageId: string
      toolName: string
      summary?: string
      details?: string
      success: boolean
    }
