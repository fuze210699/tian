export interface PrepareAiContextFile {
  path: string
  content: string
}

export interface PrepareAiSelectionContext {
  content: string
  language?: string
}

export interface PrepareAiContextInput {
  requestId: string
  messageId: string
  content: string
  currentFolder: string | null
  selection?: PrepareAiSelectionContext | null
  contextFiles?: PrepareAiContextFile[]
}

export interface PreparedAiContext {
  content: string
  contextBadges: string[]
}

export interface AiChatExecutionContext {
  currentFolder: string | null
}
