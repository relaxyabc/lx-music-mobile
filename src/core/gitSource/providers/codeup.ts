import { META_REQUEST_TIMEOUT, README_FILE_NAMES, REQUEST_TIMEOUT } from '../constants'
import { base64ToUtf8 } from '../request'
import type {
  GitFileEntry,
  GitProvider,
  GitRelease,
  GitRepoAuth,
  GitRepoInfo,
  GitRepoRef,
} from '../types'
import {
  buildHttpError,
  findReadmePath,
  getJson,
  repoCacheKey,
  tryGetJson,
  withCache,
} from './common'

/**
 * 阿里云 Codeup（云效代码管理）提供方。
 *
 * - 企业专属域名（*.devops.aliyuncs.com）为 Region 版：无需 organizationId
 * - 认证方式：请求头 `x-yunxiao-token: <个人访问令牌>`（pt- 开头）
 * - 仓库通过 `repositories?search=` 列表匹配 httpUrlToRepo 解析出数字 ID
 * - 版本号依赖 README/清单（Codeup 暂无通用 Release 查询接口），标签可作版本兜底
 */

const getHeaders = (auth: GitRepoAuth): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth.token) headers['x-yunxiao-token'] = auth.token
  return headers
}

const getCacheKey = (ref: GitRepoRef, scope: string, auth: GitRepoAuth) => {
  return `${repoCacheKey(ref.host, ref.repoPath, '', scope)}:${auth.token ? 'auth' : 'anon'}`
}

interface CodeupRepository {
  id?: number | string
  name?: string
  path?: string
  pathWithNamespace?: string
  httpUrlToRepo?: string
  defaultBranch?: string
  description?: string | null
  visibility?: string
}

interface CodeupBranchResponse {
  commit?: { id?: string } | null
  name?: string
}

interface CodeupTreeEntry {
  path?: string
  type?: string
  size?: number
}

const normalizeUrl = (url: string) => {
  return url.trim().toLowerCase().replace(/\.git$/i, '').replace(/\/+$/, '')
}

/** 解析出可直接调用的仓库标识（数字 ID）与默认分支等信息 */
const resolveRepo = async(ref: GitRepoRef, auth: GitRepoAuth): Promise<CodeupRepository> => {
  return withCache(getCacheKey(ref, 'resolve', auth), async() => {
    if (!auth.token) {
      throw new Error('Codeup 仓库需要在认证信息中填写个人访问令牌（个人设置 > 个人访问令牌）')
    }
    const headers = getHeaders(auth)
    const base = ref.apiBase

    // 1. 直接按完整路径尝试（路径与 URL 命名空间一致的自建/企业仓库）
    const byPath = await tryGetJson<CodeupRepository>(
      'Codeup',
      `${base}/repositories/${encodeURIComponent(ref.repoPath)}`,
      { headers, timeout: META_REQUEST_TIMEOUT },
    ).catch(() => null)
    if (byPath && byPath.id != null && byPath.defaultBranch) return byPath

    // 2. 按仓库名搜索，并用 httpUrlToRepo 与用户输入精确匹配
    const keyword = ref.repo || ref.repoPath.split('/').pop() || ''
    const list = await tryGetJson<CodeupRepository[]>(
      'Codeup',
      `${base}/repositories?search=${encodeURIComponent(keyword)}&pageSize=100&page=1`,
      { headers, timeout: META_REQUEST_TIMEOUT },
    ).catch(() => null)
    const target = normalizeUrl(ref.url)
    const matched = (Array.isArray(list) ? list : []).find(item => {
      if (!item.httpUrlToRepo) return false
      if (normalizeUrl(item.httpUrlToRepo) === target) return true
      // 兜底：协议不同（http/https）时比较主机与路径
      return normalizeUrl(item.httpUrlToRepo).replace(/^https?:\/\//, '') === target.replace(/^https?:\/\//, '')
    })
    if (!matched?.id) {
      throw new Error('未在 Codeup 中找到匹配的仓库，请检查仓库地址以及令牌是否具有该代码库的只读权限')
    }

    const detail = await getJson<CodeupRepository>(
      'Codeup',
      `${base}/repositories/${matched.id}`,
      { headers, timeout: META_REQUEST_TIMEOUT },
    )
    if (detail?.id == null) throw new Error('Codeup 仓库详情返回异常')
    return detail
  })
}

const getRepoInfo: GitProvider['getRepoInfo'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'repo', auth), async() => {
    const repo = await resolveRepo(ref, auth)
    const defaultBranch = repo.defaultBranch || 'master'
    const branch = await getJson<CodeupBranchResponse>(
      'Codeup',
      `${ref.apiBase}/repositories/${repo.id}/branches/${encodeURIComponent(defaultBranch)}`,
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const headSha = branch?.commit?.id ?? ''
    if (!headSha) throw new Error('Codeup API returned an empty head sha')
    return {
      ref,
      defaultBranch,
      headSha,
      description: repo.description ?? '',
      homepage: '',
    }
  })
}

const getLatestRelease: GitProvider['getLatestRelease'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'release', auth), async() => {
    try {
      const repo = await resolveRepo(ref, auth)
      const tags = await tryGetJson<Array<{ name?: string, message?: string | null, createdAt?: string | null }>>(
        'Codeup',
        `${ref.apiBase}/repositories/${repo.id}/tags`,
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      if (Array.isArray(tags) && tags.length > 0 && tags[0]?.name) {
        return { tag: tags[0].name, name: tags[0].name, body: tags[0].message ?? '', publishedAt: tags[0].createdAt ?? '', assets: [] }
      }
      return null
    } catch {
      return null
    }
  })
}

const listFiles: GitProvider['listFiles'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `tree:${branch}`, auth), async() => {
    const repo = await resolveRepo(ref, auth)
    const data = await getJson<CodeupTreeEntry[]>(
      'Codeup',
      `${ref.apiBase}/repositories/${repo.id}/files/tree?ref=${encodeURIComponent(branch)}&type=RECURSIVE`,
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const tree = Array.isArray(data) ? data : []
    const files: GitFileEntry[] = []
    const seen = new Set<string>()
    for (const item of tree) {
      if (item.type !== 'blob' || !item.path || seen.has(item.path)) continue
      seen.add(item.path)
      files.push({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 })
    }
    return files
  })
}

const readFile: GitProvider['readFile'] = async(ref, auth, path, branch) => {
  return withCache(getCacheKey(ref, `file:${branch}:${path}`, auth), async() => {
    const repo = await resolveRepo(ref, auth)
    // filePath 位于请求路径中，需要整体 URL 编码（含斜杠 %2F）
    const data = await getJson<{ content?: string, encoding?: string }>(
      'Codeup',
      `${ref.apiBase}/repositories/${repo.id}/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
      { headers: getHeaders(auth), timeout: REQUEST_TIMEOUT },
    )
    if (typeof data.content === 'string' && data.content) {
      if (data.encoding === 'base64') return base64ToUtf8(data.content)
      return data.content
    }
    throw new Error('Codeup file API returned an empty file')
  })
}

const readReadme: GitProvider['readReadme'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `readme:${branch}`, auth), async() => {
    for (const name of ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README']) {
      try {
        const content = await readFile(ref, auth, name, branch)
        if (content) return { path: name, content }
      } catch { /* 尝试下一个文件名 */ }
    }
    const files = await listFiles(ref, auth, branch).catch(() => null)
    const path = findReadmePath(files, README_FILE_NAMES)
    if (path) {
      const content = await readFile(ref, auth, path, branch).catch(() => null)
      if (content != null) return { path, content }
    }
    return null
  })
}

const downloadReleaseAsset: GitProvider['downloadReleaseAsset'] = async(ref, auth, asset) => {
  // Codeup 无通用 Release 附件，getLatestRelease 恒返回空 assets，不会走到这里
  void ref
  void auth
  void asset
  throw buildHttpError('Codeup', 404, 'Codeup release asset')
}

export const codeupProvider: GitProvider = {
  id: 'codeup',
  getRepoInfo,
  getLatestRelease,
  listFiles,
  readFile,
  readReadme,
  downloadReleaseAsset,
}
