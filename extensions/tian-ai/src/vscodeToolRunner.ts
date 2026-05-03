import { promises as fs } from 'fs'
import { spawnSync } from 'child_process'
import { isAbsolute, relative, resolve } from 'path'
import type { SecretStorage } from 'vscode'
import {
  AiToolRunner,
  type AiProviderConfig,
  type AiToolDefinition,
  type ResolvedAiConfig,
  type PrepareAiContextFile,
  type PrepareAiSelectionContext
} from '../../../packages/ai-agent-core/src/index'
import { searchFilesInFolder } from './workspaceSearch'

const SECRET_PREFIX = 'tian-ai.api-key'
const MAX_TOOL_OUTPUT_CHARS = 12000
const MAX_TOOL_DETAIL_CHARS = 400

async function resolveAiConfig(
  secrets: SecretStorage,
  config: AiProviderConfig
): Promise<ResolvedAiConfig> {
  if ('apiKey' in config && typeof (config as { apiKey?: string }).apiKey === 'string') {
    return config as ResolvedAiConfig
  }
  const apiKey = (await secrets.get(`${SECRET_PREFIX}.${config.provider}`)) || ''
  return { ...config, apiKey }
}

function getGitDiffText(cwd: string | null): string {
  if (!cwd) return ''
  const result = spawnSync('git', ['diff', '--no-color'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 2 * 1024 * 1024
  })
  if (result.error || result.status === null) return ''
  return truncateToolContent(result.stdout || '')
}

function truncateToolContent(content: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= limit) return content
  return `${content.slice(0, limit)}\n\n[truncated ${content.length - limit} chars]`
}

function summarizeDetails(content: string): string | undefined {
  const normalized = content.trim()
  if (!normalized) return undefined
  if (normalized.length <= MAX_TOOL_DETAIL_CHARS) return normalized
  return `${normalized.slice(0, MAX_TOOL_DETAIL_CHARS)}...`
}

function formatFileSummary(files: PrepareAiContextFile[]): string {
  return `${files.length} file${files.length > 1 ? 's' : ''}`
}

function getCodeLanguage(path: string): string {
  const ext = path.split('.').pop() || ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    vue: 'vue',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    md: 'markdown',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    c: 'c',
    cpp: 'cpp'
  }
  return map[ext] || ext
}

function resolveWorkspacePath(targetPath: string, currentFolder: string | null): string {
  const resolvedPath = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(currentFolder || '', targetPath)

  if (!currentFolder) {
    return resolvedPath
  }

  const rel = relative(resolve(currentFolder), resolvedPath)
  if (rel.startsWith('..') || rel.includes(':')) {
    throw new Error('Path must stay inside the current workspace')
  }

  return resolvedPath
}

async function getWorkspaceContext(
  currentFolder: string | null,
  query: string
): Promise<string> {
  if (!currentFolder) return ''
  const results = await searchFilesInFolder(currentFolder, query, 10)
  if (results.length === 0) return ''
  return results.map((r) => `[${r.path}:${r.line}] ${r.text.trim()}`).join('\n')
}

interface CredentialsLookupInput {
  config: AiProviderConfig
}

interface WorkspaceSearchInput {
  currentFolder: string | null
  query: string
}

interface WorkspaceSearchResult {
  query: string
  content: string
}

interface ReadFileInput {
  path: string
  currentFolder: string | null
}

interface ReadFileResult {
  path: string
  content: string
}

interface AttachSelectionInput {
  selection?: PrepareAiSelectionContext | null
}

interface AttachSelectionResult {
  content: string
  hasSelection: boolean
  summary: string
}

interface AttachFilesInput {
  files?: PrepareAiContextFile[]
}

interface AttachFilesResult {
  content: string
  summary: string
}

interface GitDiffInput {
  currentFolder: string | null
}

interface GitDiffResult {
  content: string
}

export function createVsCodeAiToolRunner(secrets: SecretStorage): AiToolRunner {
  const credentialsLookupTool: AiToolDefinition<CredentialsLookupInput, ResolvedAiConfig> = {
    name: 'credentials.lookup',
    summarizeStart: ({ config }) => config.provider,
    run: async ({ config }) => resolveAiConfig(secrets, config)
  }

  const workspaceSearchTool: AiToolDefinition<WorkspaceSearchInput, WorkspaceSearchResult> = {
    name: 'workspace-search',
    summarizeStart: ({ query }) => query,
    summarizeEnd: ({ query }) => query,
    details: ({ content }) => summarizeDetails(content),
    isSuccess: ({ content }) => Boolean(content),
    formatResult: ({ query, content }) =>
      content ? content : `No workspace matches found for "${query}".`,
    run: async ({ currentFolder, query }) => ({
      query,
      content: await getWorkspaceContext(currentFolder, query)
    })
  }

  const searchWorkspaceTool: AiToolDefinition<WorkspaceSearchInput, WorkspaceSearchResult> = {
    name: 'search-workspace',
    description: 'Search text across the current workspace and return matching lines.',
    inputSchema: '{"query":"string"}',
    agentEnabled: true,
    summarizeStart: ({ query }) => query,
    summarizeEnd: ({ query }) => query,
    details: ({ content }) => summarizeDetails(content),
    isSuccess: ({ content }) => Boolean(content),
    formatResult: ({ query, content }) =>
      content
        ? `Search results for "${query}":\n${content}`
        : `No workspace matches found for "${query}".`,
    run: async ({ currentFolder, query }) => ({
      query,
      content: await getWorkspaceContext(currentFolder, query)
    })
  }

  const attachSelectionTool: AiToolDefinition<AttachSelectionInput, AttachSelectionResult> = {
    name: 'attach-selection',
    summarizeEnd: ({ summary }) => summary,
    isSuccess: ({ hasSelection }) => hasSelection,
    run: async ({ selection }) => {
      const hasSelection = Boolean(selection?.content.trim())
      return {
        content: hasSelection
          ? `[Selected code]\n\`\`\`${selection?.language || 'text'}\n${selection!.content}\n\`\`\``
          : '[no selection active]',
        hasSelection,
        summary: hasSelection ? selection?.language || 'text' : 'no selection'
      }
    }
  }

  const attachFilesTool: AiToolDefinition<AttachFilesInput, AttachFilesResult> = {
    name: 'attach-files',
    summarizeStart: ({ files }) => formatFileSummary(files ?? []),
    summarizeEnd: ({ summary }) => summary,
    details: ({ content }) => summarizeDetails(content),
    formatResult: ({ content }) => content,
    run: async ({ files }) => ({
      content: (files ?? [])
        .map(
          (file) =>
            `\`\`\`${getCodeLanguage(file.path)}\n// File: ${file.path}\n${file.content}\n\`\`\``
        )
        .join('\n\n'),
      summary: formatFileSummary(files ?? [])
    })
  }

  const gitDiffTool: AiToolDefinition<GitDiffInput, GitDiffResult> = {
    name: 'git-diff',
    description: 'Read the current git diff for the open workspace.',
    inputSchema: '{}',
    agentEnabled: true,
    details: ({ content }) => summarizeDetails(content),
    formatResult: ({ content }) =>
      content ? `[Git changes]\n\`\`\`diff\n${content}\n\`\`\`` : '[no git changes]',
    isSuccess: ({ content }) => Boolean(content),
    run: async ({ currentFolder }) => ({
      content: getGitDiffText(currentFolder)
    })
  }

  const readFileTool: AiToolDefinition<ReadFileInput, ReadFileResult> = {
    name: 'read-file',
    description: 'Read a file from the current workspace by relative or absolute path.',
    inputSchema: '{"path":"string"}',
    agentEnabled: true,
    summarizeStart: ({ path }) => path,
    summarizeEnd: ({ path }) => path,
    details: ({ content }) => summarizeDetails(content),
    formatResult: ({ path, content }) =>
      `File: ${path}\n\`\`\`${getCodeLanguage(path)}\n${content}\n\`\`\``,
    run: async ({ path, currentFolder }) => {
      const resolvedPath = resolveWorkspacePath(path, currentFolder)
      const content = truncateToolContent(await fs.readFile(resolvedPath, 'utf-8'))
      return { path: resolvedPath, content }
    }
  }

  return new AiToolRunner(
    [
      credentialsLookupTool,
      workspaceSearchTool,
      searchWorkspaceTool,
      attachSelectionTool,
      attachFilesTool,
      gitDiffTool,
      readFileTool
    ] as ReadonlyArray<AiToolDefinition>
  )
}
