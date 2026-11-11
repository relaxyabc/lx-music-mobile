import type { GitRepoRef } from './types'
import { parseHttpUrl, type ParsedHttpUrl } from './url'
import { normalizeGitVersion } from './version'

export type GitSourceLink =
  | { kind: 'repoPath', path: string }
  | { kind: 'url', url: string }

export interface ManifestDocument {
  /** 清单声明的版本号（可选） */
  version: string | null
  links: GitSourceLink[]
}

const MANIFEST_LIST_KEYS = ['sources', 'list', 'apis', 'data'] as const
const MANIFEST_ITEM_KEYS = ['url', 'href', 'link', 'src', 'file', 'path'] as const
const MAX_README_LINKS = 100

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const splitPath = (path: string) => path.split('/').filter(segment => segment.length > 0)

const isJsPath = (path: string) => /\.js$/i.test(path.replace(/[?#].*$/, ''))

const sameRepo = (ref: GitRepoRef, owner: string, repo: string) => {
  return owner.toLowerCase() === ref.owner.toLowerCase() && repo.toLowerCase() === ref.repo.toLowerCase()
}

const joinPathSegments = (segments: string[]) => {
  return segments.map(safeDecode).filter(segment => segment.length > 0).join('/')
}

interface RepoPathParts {
  owner: string
  repo: string
  rest: string[]
}

/** 从 GitHub/JSDelivr 的文件地址中拆出 owner/repo/剩余路径 */
const extractGitHubPath = (parsed: ParsedHttpUrl): RepoPathParts | null => {
  const segments = splitPath(parsed.path)
  const host = parsed.hostname

  // https://raw.githubusercontent.com/{o}/{r}/{branch}/{path}
  if (host === 'raw.githubusercontent.com') {
    if (segments.length < 4) return null
    return { owner: segments[0], repo: segments[1], rest: segments.slice(3) }
  }

  // https://github.com/{o}/{r}/(blob|raw)/{branch}/{path}
  if (host === 'github.com' || host === 'www.github.com') {
    if (segments.length < 5) return null
    if (segments[2] !== 'blob' && segments[2] !== 'raw') return null
    return { owner: segments[0], repo: segments[1], rest: segments.slice(4) }
  }

  // https://{jsDelivr 镜像}/gh/{o}/{r}@{branch}/{path}
  if (host.endsWith('jsdelivr.net') || host.endsWith('jsdmirror.com') || host.endsWith('onmicrosoft.cn')) {
    if (segments[0] !== 'gh' || segments.length < 4) return null
    const repoWithVersion = segments[2]
    const atIndex = repoWithVersion.lastIndexOf('@')
    if (atIndex < 0) return null
    return {
      owner: segments[1],
      repo: repoWithVersion.slice(0, atIndex),
      rest: segments.slice(3),
    }
  }

  // https://raw.gitmirror.com/{o}/{r}/{branch}/{path}
  if (host === 'raw.gitmirror.com') {
    if (segments.length < 4) return null
    return { owner: segments[0], repo: segments[1], rest: segments.slice(3) }
  }

  return null
}

/** 从任意包含 raw.githubusercontent.com/github.com 路径的代理地址中拆出仓库路径 */
const extractProxiedPath = (parsed: ParsedHttpUrl): RepoPathParts | null => {
  const segments = splitPath(parsed.path)

  const rawIndex = segments.indexOf('raw.githubusercontent.com')
  if (rawIndex >= 0) {
    const rest = segments.slice(rawIndex + 1)
    if (rest.length < 4) return null
    return { owner: rest[0], repo: rest[1], rest: rest.slice(3) }
  }

  const githubIndex = segments.indexOf('github.com')
  if (githubIndex >= 0) {
    const rest = segments.slice(githubIndex + 1)
    if (rest.length < 5) return null
    if (rest[2] !== 'blob' && rest[2] !== 'raw') return null
    return { owner: rest[0], repo: rest[1], rest: rest.slice(4) }
  }

  // Gitee raw 地址（可能被代理）
  const giteeIndex = segments.indexOf('gitee.com')
  if (giteeIndex >= 0) {
    const rest = segments.slice(giteeIndex + 1)
    if (rest.length < 5 || rest[2] !== 'raw') return null
    return { owner: rest[0], repo: rest[1], rest: rest.slice(4) }
  }

  return null
}

/** 尝试把绝对地址解析为本仓库内的文件路径（返回 null 表示不是本仓库的地址） */
const matchRepoPath = (ref: GitRepoRef, parsed: ParsedHttpUrl): string | null => {
  // Gitee: https://gitee.com/{o}/{r}/raw/{branch}/{path}
  const giteeSegments = splitPath(parsed.path)
  if (parsed.hostname === 'gitee.com') {
    if (giteeSegments.length >= 5 && giteeSegments[2] === 'raw' && sameRepo(ref, giteeSegments[0], giteeSegments[1])) {
      return joinPathSegments(giteeSegments.slice(4))
    }
  }

  const parts = extractGitHubPath(parsed) ?? extractProxiedPath(parsed)
  if (!parts) return null
  if (!sameRepo(ref, parts.owner, parts.repo)) return null
  const path = joinPathSegments(parts.rest)
  return path || null
}

const cleanRelativePath = (raw: string): string | null => {
  let path = raw.split(/[?#]/)[0]
  path = path.replace(/\\/g, '/')
  path = path.replace(/^\.\//, '')
  path = path.replace(/^\/+/, '')
  if (!path) return null
  if (path.includes('..')) return null
  return safeDecode(path)
}

const resolveLink = (raw: string, ref: GitRepoRef): GitSourceLink | null => {
  let value = raw.trim()
  if (!value) return null
  value = value.replace(/^<(.*)>$/, '$1').replace(/^`(.*)`$/, '$1').trim()
  if (!value) return null

  if (value.startsWith('//')) value = `https:${value}`

  if (/^https?:\/\//i.test(value)) {
    const parsed = parseHttpUrl(value)
    if (!parsed) return null
    const path = matchRepoPath(ref, parsed)
    if (path) return { kind: 'repoPath', path }
    return { kind: 'url', url: value }
  }

  const path = cleanRelativePath(value)
  return path ? { kind: 'repoPath', path } : null
}

const dedupeLinks = (links: GitSourceLink[], max: number): GitSourceLink[] => {
  const seen = new Set<string>()
  const result: GitSourceLink[] = []
  for (const link of links) {
    const key = link.kind === 'repoPath' ? `repo:${link.path}` : `url:${link.url}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(link)
    if (result.length >= max) break
  }
  return result
}

const getManifestItems = (root: unknown): unknown[] => {
  if (Array.isArray(root)) return root
  if (!root || typeof root !== 'object') return []
  for (const key of MANIFEST_LIST_KEYS) {
    const value = (root as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value
  }
  return []
}

const getManifestVersion = (root: unknown): string | null => {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const value = (root as Record<string, unknown>).version
  if (typeof value !== 'string' && typeof value !== 'number') return null
  return normalizeGitVersion(String(value))
}

const getManifestItemValue = (item: unknown): string | null => {
  if (typeof item === 'string') {
    const value = item.trim()
    return value || null
  }
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  if (record.enabled === false) return null
  for (const key of MANIFEST_ITEM_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * 解析仓库根目录的音源清单（JSON）。
 * 兼容顶层数组、顶层对象包含 sources/list/apis/data 数组等形态。
 */
export const parseManifestDocument = (jsonText: string, ref: GitRepoRef): ManifestDocument => {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return { version: null, links: [] }
  }

  const links: GitSourceLink[] = []
  for (const item of getManifestItems(root)) {
    const value = getManifestItemValue(item)
    if (!value) continue
    const link = resolveLink(value, ref)
    if (link) links.push(link)
  }

  return {
    version: getManifestVersion(root),
    links: dedupeLinks(links, MAX_README_LINKS),
  }
}

/** 解析仓库根目录的音源清单，只要链接列表 */
export const parseManifest = (jsonText: string, ref: GitRepoRef): GitSourceLink[] => {
  return parseManifestDocument(jsonText, ref).links
}

/** 解析音源清单中声明的版本号 */
export const parseManifestVersion = (jsonText: string): string | null => {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return null
  }
  return getManifestVersion(root)
}

/**
 * 从 README 中提取属于本仓库的音源导入链接。
 *
 * 支持 pdone 风格（代码块中每行一个 raw.githubusercontent / gh-proxy 链接）、
 * Markdown 链接与相对路径；只接受本仓库的链接，忽略 README 中提到的其它项目。
 */
export const extractSourceLinksFromMarkdown = (readme: string, ref: GitRepoRef): GitSourceLink[] => {
  if (typeof readme !== 'string' || !readme) return []
  const text = readme.replace(/\r\n/g, '\n')
  const candidates: Array<{ value: string, index: number }> = []

  // Markdown 链接 [text](url)
  const markdownRxp = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g
  let match: RegExpExecArray | null
  while ((match = markdownRxp.exec(text)) != null) candidates.push({ value: match[1], index: match.index })

  // 单独成行的链接/路径（pdone 风格）
  let lineStart = 0
  for (const rawLine of text.split('\n')) {
    const lineIndex = lineStart
    lineStart += rawLine.length + 1
    let value = rawLine.trim()
    if (!value) continue
    value = value.replace(/^[-*+]\s+/, '').trim()
    value = value.replace(/^`+/, '').replace(/`+$/, '').trim()
    if (!value || /\s/.test(value)) continue
    if (!/^https?:\/\//i.test(value) && !/\.js(?:[?#]\S*)?$/i.test(value)) continue
    candidates.push({ value, index: lineIndex + rawLine.indexOf(value) })
  }

  // 按文档出现顺序处理，保证音源顺序与 README 一致
  candidates.sort((a, b) => a.index - b.index)

  const links: GitSourceLink[] = []
  for (const candidate of candidates) {
    if (links.length >= MAX_README_LINKS) break
    let value = candidate.value.trim()
    if (!value) continue
    if (value.startsWith('//')) value = `https:${value}`

    if (/^https?:\/\//i.test(value)) {
      const parsed = parseHttpUrl(value)
      if (!parsed) continue
      if (!isJsPath(parsed.path)) continue
      const path = matchRepoPath(ref, parsed)
      // README 中只接受指向本仓库的链接
      if (path) links.push({ kind: 'repoPath', path })
      continue
    }

    if (!isJsPath(value)) continue
    const path = cleanRelativePath(value)
    if (path) links.push({ kind: 'repoPath', path })
  }

  return dedupeLinks(links, MAX_README_LINKS)
}
