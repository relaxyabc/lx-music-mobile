import {
  GITHUB_RAW_MIRRORS,
  JSDELIVR_DATA_API,
  META_REQUEST_TIMEOUT,
  README_FILE_NAMES,
  REQUEST_TIMEOUT,
} from '../constants'
import type {
  GitFileEntry,
  GitProvider,
  GitRelease,
  GitRepoAuth,
  GitRepoInfo,
  GitRepoRef,
} from '../types'
import { requestBinary, requestText, HttpError } from '../request'
import {
  buildHttpError,
  encodePath,
  findReadmePath,
  getJson,
  getText,
  isTransientError as isTransient,
  repoCacheKey,
  simpleHash,
  tryGetJson,
  withCache,
} from './common'

interface GitHubRepoResponse {
  default_branch?: string
  description?: string | null
  homepage?: string | null
}

interface GitHubTreeResponse {
  sha: string
  tree?: Array<{ path: string, type: string, size?: number }>
  truncated?: boolean
}

interface GitHubReleaseResponse {
  tag_name?: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  assets?: Array<{ id: number, name: string, size: number, url: string }>
}

interface JsDelivrFile {
  name: string
  size: number
  hash?: string
}

const TRUNCATED_ERROR = 'Repository file list is truncated (too many files)'

const getHeaders = (auth: GitRepoAuth): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`
  return headers
}

const getRawHeaders = (auth: GitRepoAuth): Record<string, string> => {
  const headers = getHeaders(auth)
  headers.Accept = 'application/vnd.github.raw'
  return headers
}

const getRepoApi = (ref: GitRepoRef) => {
  return `${ref.apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
}

const getCacheKey = (ref: GitRepoRef, scope: string, auth: GitRepoAuth) => {
  return `${repoCacheKey(ref.host, ref.repoPath, '', scope)}:${auth.token ? 'auth' : 'anon'}`
}

const getTreeSha = async (ref: GitRepoRef, auth: GitRepoAuth, branch: string): Promise<string> => {
  const repoApi = getRepoApi(ref)
  try {
    const tree = await getJson<GitHubTreeResponse>('GitHub', `${repoApi}/git/trees/${encodeURIComponent(branch)}`, {
      headers: getHeaders(auth),
      timeout: META_REQUEST_TIMEOUT,
    })
    if (tree.sha) return tree.sha
  } catch { /* 回退到 commits 接口 */ }
  const commit = await getJson<{ sha: string }>('GitHub', `${repoApi}/commits/${encodeURIComponent(branch)}`, {
    headers: getHeaders(auth),
    timeout: META_REQUEST_TIMEOUT,
  })
  return commit.sha
}

const getJsDelivrFiles = async (ref: GitRepoRef, branch: string): Promise<JsDelivrFile[]> => {
  return withCache(`${repoCacheKey(ref.host, ref.repoPath, branch, 'jsdelivr')}`, async() => {
    const url = `${JSDELIVR_DATA_API}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}@${encodeURIComponent(branch)}?structure=flat`
    const data = await getJson<{ files?: JsDelivrFile[] }>('jsDelivr', url, { timeout: META_REQUEST_TIMEOUT })
    if (!Array.isArray(data.files)) throw new Error('jsDelivr API returned unexpected data')
    return data.files
      .filter(file => typeof file?.name === 'string')
      .map(file => ({
        name: file.name.replace(/^\//, ''),
        size: typeof file.size === 'number' ? file.size : 0,
        hash: file.hash ?? '',
      }))
      .filter(file => file.name.length > 0)
  })
}

const getRepoInfoFromMirror = async (ref: GitRepoRef): Promise<GitRepoInfo> => {
  let lastError: unknown = null
  for (const branch of ['main', 'master']) {
    try {
      const files = await getJsDelivrFiles(ref, branch)
      const fingerprint = files
        .map(file => `${file.name}:${file.size}:${file.hash}`)
        .sort()
        .join('|')
      return {
        ref,
        defaultBranch: branch,
        headSha: `mirror:${simpleHash(fingerprint)}`,
        description: '',
        homepage: '',
      }
    } catch (error) {
      lastError = error
      if (!isTransient(error)) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to access GitHub repository')
}

const getRepoInfo: GitProvider['getRepoInfo'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'repo', auth), async() => {
    try {
      const repo = await getJson<GitHubRepoResponse>('GitHub', getRepoApi(ref), {
        headers: getHeaders(auth),
        timeout: META_REQUEST_TIMEOUT,
      })
      const defaultBranch = repo.default_branch || 'main'
      const headSha = await getTreeSha(ref, auth, defaultBranch)
      return {
        ref,
        defaultBranch,
        headSha,
        description: repo.description ?? '',
        homepage: repo.homepage ?? '',
      }
    } catch (error) {
      if (!isTransient(error)) throw error
      return getRepoInfoFromMirror(ref)
    }
  })
}

const mapRelease = (ref: GitRepoRef, release: GitHubReleaseResponse): GitRelease => {
  const repoApi = getRepoApi(ref)
  return {
    tag: release.tag_name ?? '',
    name: release.name ?? '',
    body: release.body ?? '',
    publishedAt: release.published_at ?? '',
    assets: (release.assets ?? []).map(asset => ({
      id: String(asset.id),
      name: asset.name ?? '',
      size: typeof asset.size === 'number' ? asset.size : 0,
      downloadUrl: asset.url || `${repoApi}/releases/assets/${asset.id}`,
    })),
  }
}

const getLatestRelease: GitProvider['getLatestRelease'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'release', auth), async() => {
    const repoApi = getRepoApi(ref)
    const headers = getHeaders(auth)
    try {
      const latest = await tryGetJson<GitHubReleaseResponse>('GitHub', `${repoApi}/releases/latest`, {
        headers,
        timeout: META_REQUEST_TIMEOUT,
      })
      if (latest) return mapRelease(ref, latest)

      const list = await tryGetJson<GitHubReleaseResponse[]>('GitHub', `${repoApi}/releases?per_page=1`, {
        headers,
        timeout: META_REQUEST_TIMEOUT,
      })
      if (Array.isArray(list) && list.length > 0) return mapRelease(ref, list[0])

      // 仓库没有任何 release 时不再请求 tags 接口（tags 仅在其它提供方作为兜底，节省 API 配额）
      return null
    } catch {
      // release 接口不可用时退化为 README/headSha 判断
      return null
    }
  })
}

const listFiles: GitProvider['listFiles'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `tree:${branch}`, auth), async() => {
    let truncated = false
    try {
      const data = await getJson<GitHubTreeResponse>(
        'GitHub',
        `${getRepoApi(ref)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      if (data.truncated) {
        truncated = true
      } else {
        return (data.tree ?? [])
          .filter(item => item.type === 'blob')
          .map(item => ({ path: item.path, size: item.size ?? 0 }))
      }
    } catch (error) {
      if (!isTransient(error)) throw error
    }
    if (truncated) throw new Error(TRUNCATED_ERROR)
    // API 不可达时使用 jsDelivr 文件清单兜底
    const files = await getJsDelivrFiles(ref, branch)
    return files.map(file => ({ path: file.name, size: file.size }))
  })
}

const readFileFromMirror = async (ref: GitRepoRef, path: string, branch: string): Promise<string> => {
  let lastError: unknown = null
  for (const mirror of GITHUB_RAW_MIRRORS) {
    const url = `${mirror}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}@${encodeURIComponent(branch)}/${encodePath(path)}`
    try {
      return await getText('GitHub mirror', url, { timeout: REQUEST_TIMEOUT })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to read file from GitHub')
}

const readFile: GitProvider['readFile'] = async(ref, auth, path, branch) => {
  return withCache(`${getCacheKey(ref, `file:${branch}:${path}`, auth)}`, async() => {
    try {
      return await getText(
        'GitHub',
        `${getRepoApi(ref)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
        { headers: getRawHeaders(auth), timeout: REQUEST_TIMEOUT },
      )
    } catch (error) {
      if (!isTransient(error)) throw error
      return readFileFromMirror(ref, path, branch)
    }
  })
}

const readReadme: GitProvider['readReadme'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `readme:${branch}`, auth), async() => {
    try {
      const response = await requestText(`${getRepoApi(ref)}/readme`, {
        headers: getRawHeaders(auth),
        timeout: META_REQUEST_TIMEOUT,
      })
      if (response.ok && response.text) return { path: 'README.md', content: response.text }
    } catch { /* 走文件列表/镜像兜底 */ }

    const files = await listFiles(ref, auth, branch).catch(() => null)
    const readmePath = findReadmePath(files, README_FILE_NAMES)
    if (readmePath) {
      const content = await readFile(ref, auth, readmePath, branch).catch(() => null)
      if (content != null) return { path: readmePath, content }
    }

    // 文件列表也不可用时，直接尝试常见 README 文件名（镜像兜底）
    for (const name of ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README']) {
      try {
        const content = await readFileFromMirror(ref, name, branch)
        if (content) return { path: name, content }
      } catch { /* 尝试下一个文件名 */ }
    }
    return null
  })
}

const downloadReleaseAsset: GitProvider['downloadReleaseAsset'] = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset:${asset.id}`, auth), async() => {
    const headers = { ...getHeaders(auth), Accept: 'application/octet-stream' }
    const response = await requestText(asset.downloadUrl, { headers, timeout: REQUEST_TIMEOUT })
    if (!response.ok) throw buildHttpError('GitHub', response.status, asset.downloadUrl)
    return response.text
  })
}

/**
 * 下载 release 资源的二进制内容（用于 .zip 资源）。
 * 注意：不能复用文本下载，zip 数据被 UTF-8 解码后会损坏。
 */
const downloadReleaseAssetBinary: NonNullable<GitProvider['downloadReleaseAssetBinary']> = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset-bin:${asset.id}`, auth), async() => {
    try {
      return await requestBinary(asset.downloadUrl, {
        headers: { ...getHeaders(auth), Accept: 'application/octet-stream' },
        timeout: REQUEST_TIMEOUT,
      })
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new Error(`GitHub asset download failed: ${(error as Error)?.message ?? String(error)}`)
    }
  })
}

export const githubProvider: GitProvider = {
  id: 'github',
  getRepoInfo,
  getLatestRelease,
  listFiles,
  readFile,
  readReadme,
  downloadReleaseAsset,
  downloadReleaseAssetBinary,
}
