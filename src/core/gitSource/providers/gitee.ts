import { META_REQUEST_TIMEOUT, README_FILE_NAMES, REQUEST_TIMEOUT } from '../constants'
import { base64ToUtf8, requestBinary, requestText } from '../request'
import type {
  GitFileEntry,
  GitProvider,
  GitRelease,
  GitRepoAuth,
  GitRepoInfo,
  GitRepoRef,
} from '../types'
import { isTransientError } from '../request'
import {
  buildHttpError,
  encodePath,
  findReadmePath,
  getJson,
  getText,
  repoCacheKey,
  tryGetJson,
  withCache,
} from './common'

const getHeaders = (auth: GitRepoAuth): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth.token) headers.Authorization = `token ${auth.token}`
  return headers
}

/** Gitee 部分场景不支持 Authorization 头，额外通过 access_token 查询参数兜底 */
const withToken = (url: string, auth: GitRepoAuth) => {
  if (!auth.token) return url
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(auth.token)}`
}

const getRepoApi = (ref: GitRepoRef) => {
  return `${ref.apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
}

const getCacheKey = (ref: GitRepoRef, scope: string, auth: GitRepoAuth) => {
  return `${repoCacheKey(ref.host, ref.repoPath, '', scope)}:${auth.token ? 'auth' : 'anon'}`
}

const getRepoInfo: GitProvider['getRepoInfo'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'repo', auth), async() => {
    const repo = await getJson<{ default_branch?: string, description?: string | null, homepage?: string | null }>(
      'Gitee',
      withToken(getRepoApi(ref), auth),
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const defaultBranch = repo.default_branch || 'master'
    let headSha = ''
    try {
      const branchInfo = await getJson<{ commit?: { sha?: string } }>(
        'Gitee',
        withToken(`${getRepoApi(ref)}/branches/${encodeURIComponent(defaultBranch)}`, auth),
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      headSha = branchInfo.commit?.sha ?? ''
    } catch { /* 回退到 tree 接口 */ }
    if (!headSha) {
      const tree = await getJson<{ sha?: string }>(
        'Gitee',
        withToken(`${getRepoApi(ref)}/git/trees/${encodeURIComponent(defaultBranch)}`, auth),
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      headSha = tree.sha ?? ''
    }
    if (!headSha) throw new Error('Gitee API returned an empty head sha')
    return {
      ref,
      defaultBranch,
      headSha,
      description: repo.description ?? '',
      homepage: repo.homepage ?? '',
    }
  })
}

interface GiteeReleaseResponse {
  tag_name?: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  assets?: Array<{ id?: number, name?: string, size?: number, browser_download_url?: string }>
}

const mapRelease = (release: GiteeReleaseResponse): GitRelease => {
  return {
    tag: release.tag_name ?? '',
    name: release.name ?? '',
    body: release.body ?? '',
    publishedAt: release.published_at ?? '',
    assets: (release.assets ?? []).map(asset => ({
      id: String(asset.id ?? asset.name ?? ''),
      name: asset.name ?? '',
      size: typeof asset.size === 'number' ? asset.size : 0,
      downloadUrl: asset.browser_download_url ?? '',
    })).filter(asset => !!asset.downloadUrl),
  }
}

const getLatestRelease: GitProvider['getLatestRelease'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'release', auth), async() => {
    const repoApi = getRepoApi(ref)
    const headers = getHeaders(auth)
    try {
      const latest = await tryGetJson<GiteeReleaseResponse>(
        'Gitee',
        withToken(`${repoApi}/releases/latest`, auth),
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (latest && (latest.tag_name || latest.name)) return mapRelease(latest)

      const list = await tryGetJson<GiteeReleaseResponse[]>(
        'Gitee',
        withToken(`${repoApi}/releases?page=1&per_page=1`, auth),
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (Array.isArray(list) && list.length > 0) return mapRelease(list[0])

      const tags = await tryGetJson<Array<{ name?: string }>>(
        'Gitee',
        withToken(`${repoApi}/tags?page=1&per_page=1`, auth),
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (Array.isArray(tags) && tags.length > 0) {
        const tag = tags[0].name ?? ''
        if (tag) return { tag, name: tag, body: '', publishedAt: '', assets: [] }
      }
      return null
    } catch {
      return null
    }
  })
}

const listFiles: GitProvider['listFiles'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `tree:${branch}`, auth), async() => {
    const perPage = 1000
    const files: GitFileEntry[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 10; page++) {
      const data = await getJson<{ tree?: Array<{ path?: string, type?: string, size?: number }>, truncated?: boolean }>(
        'Gitee',
        withToken(`${getRepoApi(ref)}/git/trees/${encodeURIComponent(branch)}?recursive=1&page=${page}&per_page=${perPage}`, auth),
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      if (data.truncated) throw new Error('Repository file list is truncated (too many files)')
      const tree = Array.isArray(data.tree) ? data.tree : []
      if (!tree.length) break
      let added = 0
      for (const item of tree) {
        if (item.type !== 'blob' || !item.path || seen.has(item.path)) continue
        seen.add(item.path)
        files.push({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 })
        added++
      }
      if (added === 0 || tree.length < perPage) break
    }
    return files
  })
}

const readFile: GitProvider['readFile'] = async(ref, auth, path, branch) => {
  return withCache(getCacheKey(ref, `file:${branch}:${path}`, auth), async() => {
    try {
      const data = await getJson<{ content?: string, encoding?: string } | Array<unknown>>(
        'Gitee',
        withToken(`${getRepoApi(ref)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, auth),
        { headers: getHeaders(auth), timeout: REQUEST_TIMEOUT },
      )
      if (Array.isArray(data)) throw new Error('Gitee path is a directory')
      if (typeof data.content === 'string') {
        if (data.encoding === 'base64') return base64ToUtf8(data.content)
        return data.content
      }
      throw new Error('Gitee contents API returned unexpected data')
    } catch (error) {
      if (!isTransientError(error)) throw error
      // 公开仓库直接走 raw 地址兜底
      return getText(
        'Gitee',
        `https://gitee.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/raw/${encodeURIComponent(branch)}/${encodePath(path)}`,
        { timeout: REQUEST_TIMEOUT },
      )
    }
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

const downloadHeaders = (ref: GitRepoRef, auth: GitRepoAuth, url: string): Record<string, string> => {
  const headers = getHeaders(auth)
  // 仅对本服务地址携带认证信息，避免把 token 泄漏给外部下载地址
  return url.toLowerCase().includes(`//${ref.host.toLowerCase()}/`) ? headers : { Accept: headers.Accept }
}

const downloadReleaseAsset: GitProvider['downloadReleaseAsset'] = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset:${asset.id}`, auth), async() => {
    const response = await requestText(asset.downloadUrl, {
      headers: downloadHeaders(ref, auth, asset.downloadUrl),
      timeout: REQUEST_TIMEOUT,
    })
    if (!response.ok) throw buildHttpError('Gitee', response.status, asset.downloadUrl)
    return response.text
  })
}

const downloadReleaseAssetBinary: NonNullable<GitProvider['downloadReleaseAssetBinary']> = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset-bin:${asset.id}`, auth), async() => {
    try {
      return await requestBinary(asset.downloadUrl, {
        headers: downloadHeaders(ref, auth, asset.downloadUrl),
        timeout: REQUEST_TIMEOUT,
      })
    } catch (error) {
      if (error instanceof Error && 'status' in error) throw error
      throw new Error(`Gitee asset download failed: ${(error as Error)?.message ?? String(error)}`)
    }
  })
}

export const giteeProvider: GitProvider = {
  id: 'gitee',
  getRepoInfo,
  getLatestRelease,
  listFiles,
  readFile,
  readReadme,
  downloadReleaseAsset,
  downloadReleaseAssetBinary,
}
