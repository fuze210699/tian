import { promises as fs } from 'fs'
import { join } from 'path'

const TEXT_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'vue',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'json',
  'jsonc',
  'md',
  'mdx',
  'txt',
  'py',
  'rs',
  'go',
  'rb',
  'sh',
  'bash',
  'yml',
  'yaml',
  'toml',
  'xml',
  'sql',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'java',
  'kt',
  'swift',
  'php',
  'lua',
  'r',
  'scala',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'env',
  'makefile'
])

export interface SearchResult {
  path: string
  line: number
  text: string
}

export async function searchFilesInFolder(
  folderPath: string,
  query: string,
  maxResults = 200
): Promise<SearchResult[]> {
  const results: SearchResult[] = []
  if (!query.trim()) return results
  await searchInDir(folderPath, query.trim().toLowerCase(), results, maxResults)
  return results
}

async function searchInDir(
  dirPath: string,
  queryLower: string,
  results: SearchResult[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return

  let entries: import('fs').Dirent[]
  try {
    entries = (await fs.readdir(dirPath, { withFileTypes: true })) as import('fs').Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break

    const name = String(entry.name)
    const lowerName = name.toLowerCase()
    if (
      name.startsWith('.') &&
      !['gitignore', 'gitattributes', 'env'].some((item) => lowerName.includes(item))
    ) {
      continue
    }
    if (['node_modules', 'dist', 'out', '.git', 'build', '.cache', '.vite'].includes(name)) {
      continue
    }

    const fullPath = join(dirPath, name)
    if (entry.isDirectory()) {
      await searchInDir(fullPath, queryLower, results, maxResults)
      continue
    }

    const ext = name.split('.').at(-1)?.toLowerCase() ?? lowerName
    if (!TEXT_EXTS.has(ext)) continue

    try {
      const content = await fs.readFile(fullPath, 'utf-8')
      const lines = content.split('\n')
      for (let index = 0; index < lines.length && results.length < maxResults; index++) {
        if (lines[index].toLowerCase().includes(queryLower)) {
          results.push({ path: fullPath, line: index + 1, text: lines[index].trimEnd() })
        }
      }
    } catch {
      continue
    }
  }
}
