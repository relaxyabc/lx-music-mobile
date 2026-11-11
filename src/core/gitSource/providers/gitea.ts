import { META_REQUEST_TIMEOUT, README_FILE_NAMES, REQUEST_TIMEOUT } from '../constants'
import { base64ToUtf8, buildBasicAuth, requestBinary, requestText } from '../request'
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
  if (auth.username) headers.Authorization = buildBasicAuth(auth.username, auth.token ?? '')
  else if (auth.token) headers.Authorization = `token ${auth.token}`
  return headers
}

const getRepoApi = (ref: GitRepoRef) => {
  return `${ref.apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
}

const getCacheKey = (ref: GitRepoRef, scope: string, auth: GitRepoAuth) => {
  return `${repoCacheKey(ref.host, ref.repoPath, '', scope)}:${auth.token || auth.username ? 'auth' : 'anon'}`
}

const getRepoInfo: GitProvider['getRepoInfo'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'repo', auth), async() => {
    const repo = await getJson<{ default_branch?: string, description?: string | null, website?: string | null }>(
      'Gitea',
      getRepoApi(ref),
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const defaultBranch = repo.default_branch || 'main'
    let headSha = ''
    try {
      const tree = await getJson<{ sha?: string }>(
        'Gitea',
        `${getRepoApi(ref)}/git/trees/${encodeURIComponent(defaultBranch)}`,
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      headSha = tree.sha ?? ''
    } catch { /* 回退到分支接口 */ }
    if (!headSha) {
      const branchInfo = await getJson<{ commit?: { id?: string } }>(
        'Gitea',
        `${getRepoApi(ref)}/branches/${encodeURIComponent(defaultBranch)}`,
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      headSha = branchInfo.commit?.id ?? ''
    }
    if (!headSha) throw new Error('Gitea API returned an empty head sha')
    return {
      ref,
      defaultBranch,
      headSha,
      description: repo.description ?? '',
      homepage: repo.website ?? '',
    }
  })
}

interface GiteaReleaseResponse {
  tag_name?: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  assets?: Array<{ id?: number, name?: string, size?: number, browser_download_url?: string }>
}

const mapRelease = (release: GiteaReleaseResponse): GitRelease => {
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
      const list = await tryGetJson<GiteaReleaseResponse[]>(
        'Gitea',
        `${repoApi}/releases?limit=1&page=1`,
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (Array.isArray(list) && list.length > 0) return mapRelease(list[0])

      const tags = await tryGetJson<Array<{ name?: string }>>(
        'Gitea',
        `${repoApi}/tags?limit=1`,
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (Array.isArray(tags) && tags.length > 0 && tags[0].name) {
        return { tag: tags[0].name, name: tags[0].name, body: '', publishedAt: '', assets: [] }
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
        'Gitea',
        `${getRepoApi(ref)}/git/trees/${encodeURIComponent(branch)}?recursive=true&per_page=${perPage}&page=${page}`,
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
      const data = await getJson<{ content?: string, encoding?: string }>(
        'Gitea',
        `${getRepoApi(ref)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
        { headers: getHeaders(auth), timeout: REQUEST_TIMEOUT },
      )
      if (typeof data.content === 'string' && data.content) {
        if (data.encoding === 'base64') return base64ToUtf8(data.content)
        return data.content
      }
      throw new Error('Gitea contents API returned an empty file')
    } catch {
      // 内容接口不可用（大文件、路径含特殊字符等）时使用 raw 地址兜底
      return getText(
        'Gitea',
        `${getRepoApi(ref)}/raw/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
        { headers: getHeaders(auth), timeout: REQUEST_TIMEOUT },
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
  return url.toLowerCase().includes(`//${ref.host.toLowerCase()}/`) ? headers : { Accept: headers.Accept }
}

const appendToken = (url: string, token: string) => {
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

const downloadAsset = async(ref: GitRepoRef, auth: GitRepoAuth, asset: { downloadUrl: string }, binary: boolean) => {
  const headers = downloadHeaders(ref, auth, asset.downloadUrl)
  const load = async(target: string) => {
    return binary
      ? requestBinary(target, { headers, timeout: REQUEST_TIMEOUT })
      : requestText(target, { headers, timeout: REQUEST_TIMEOUT })
  }
  try {
    const result = await load(asset.downloadUrl)
    if (binary) return result as Uint8Array
    const response = result as Awaited<ReturnType<typeof requestText>>
    if (!response.ok) throw buildHttpError('Gitea', response.status, asset.downloadUrl)
    return response.text
  } catch (error) {
    // 私有仓库的下载地址可能需要通过 token 查询参数认证
    if (!auth.token) throw error
    const target = appendToken(asset.downloadUrl, auth.token)
    const result = await load(target)
    if (binary) return result as Uint8Array
    return (result as Awaited<ReturnType<typeof requestText>>).text
  }
}

const downloadReleaseAsset: GitProvider['downloadReleaseAsset'] = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset:${asset.id}`, auth), async() => {
    return downloadAsset(ref, auth, asset, false) as Promise<string>
  })
}

const downloadReleaseAssetBinary: NonNullable<GitProvider['downloadReleaseAssetBinary']> = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset-bin:${asset.id}`, auth), async() => {
    return downloadAsset(ref, auth, asset, true) as Promise<Uint8Array>
  })
}

export const giteaProvider: GitProvider = {
  id: 'gitea',
  getRepoInfo,
  getLatestRelease,
  listFiles,
  readFile,
  readReadme,
  downloadReleaseAsset,
  downloadReleaseAssetBinary,
}
