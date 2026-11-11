import { META_REQUEST_TIMEOUT, README_FILE_NAMES, REQUEST_TIMEOUT } from '../constants'
import { requestBinary, requestJson, requestText } from '../request'
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
  withCache,
} from './common'

const getHeaders = (auth: GitRepoAuth): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth.token) headers['PRIVATE-TOKEN'] = auth.token
  return headers
}

const getProjectApi = (ref: GitRepoRef) => {
  return `${ref.apiBase}/projects/${encodeURIComponent(ref.repoPath)}`
}

const getCacheKey = (ref: GitRepoRef, scope: string, auth: GitRepoAuth) => {
  return `${repoCacheKey(ref.host, ref.repoPath, '', scope)}:${auth.token ? 'auth' : 'anon'}`
}

const getRepoInfo: GitProvider['getRepoInfo'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'repo', auth), async() => {
    const project = await getJson<{ default_branch?: string, description?: string | null, web_url?: string }>(
      'GitLab',
      getProjectApi(ref),
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const defaultBranch = project.default_branch || 'main'
    const branchInfo = await getJson<{ commit?: { id?: string } }>(
      'GitLab',
      `${getProjectApi(ref)}/repository/branches/${encodeURIComponent(defaultBranch)}`,
      { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
    )
    const headSha = branchInfo.commit?.id ?? ''
    if (!headSha) throw new Error('GitLab API returned an empty head sha')
    return {
      ref,
      defaultBranch,
      headSha,
      description: project.description ?? '',
      homepage: project.web_url ?? '',
    }
  })
}

interface GitLabReleaseResponse {
  tag_name?: string
  name?: string | null
  description?: string | null
  released_at?: string | null
  assets?: {
    links?: Array<{ id?: number, name?: string, url?: string }>
  }
}

const mapRelease = (release: GitLabReleaseResponse): GitRelease => {
  const links = release.assets?.links ?? []
  return {
    tag: release.tag_name ?? '',
    name: release.name ?? '',
    body: release.description ?? '',
    publishedAt: release.released_at ?? '',
    assets: links
      .filter(link => !!link.url)
      .map(link => ({
        id: String(link.id ?? link.name ?? link.url),
        name: link.name ?? '',
        size: 0,
        downloadUrl: link.url as string,
      })),
  }
}

const getLatestRelease: GitProvider['getLatestRelease'] = async(ref, auth) => {
  return withCache(getCacheKey(ref, 'release', auth), async() => {
    const headers = getHeaders(auth)
    try {
      const releases = await requestJson<GitLabReleaseResponse[]>(
        `${getProjectApi(ref)}/releases?per_page=1`,
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (releases.ok && Array.isArray(releases.data) && releases.data.length > 0 && releases.data[0].tag_name) {
        return mapRelease(releases.data[0])
      }
      const tags = await requestJson<Array<{ name?: string }>>(
        `${getProjectApi(ref)}/repository/tags?per_page=1`,
        { headers, timeout: META_REQUEST_TIMEOUT },
      )
      if (tags.ok && Array.isArray(tags.data) && tags.data.length > 0 && tags.data[0].name) {
        return { tag: tags.data[0].name, name: tags.data[0].name, body: '', publishedAt: '', assets: [] }
      }
      return null
    } catch {
      return null
    }
  })
}

const listFiles: GitProvider['listFiles'] = async(ref, auth, branch) => {
  return withCache(getCacheKey(ref, `tree:${branch}`, auth), async() => {
    const perPage = 100
    const files: GitFileEntry[] = []
    const seen = new Set<string>()
    let page = 1
    for (let index = 0; index < 20; index++) {
      const response = await requestJson<Array<{ path?: string, type?: string }>>(
        `${getProjectApi(ref)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=${perPage}&page=${page}`,
        { headers: getHeaders(auth), timeout: META_REQUEST_TIMEOUT },
      )
      if (!response.ok) throw buildHttpError('GitLab', response.status, response.url)
      const items = Array.isArray(response.data) ? response.data : []
      if (!items.length) break
      let added = 0
      for (const item of items) {
        if (item.type !== 'blob' || !item.path || seen.has(item.path)) continue
        seen.add(item.path)
        files.push({ path: item.path, size: 0 })
        added++
      }
      if (added === 0) break
      const nextPage = response.headers['x-next-page']
      if (nextPage) {
        const parsed = parseInt(nextPage, 10)
        if (!parsed || parsed <= page) break
        page = parsed
      } else if (items.length < perPage) {
        break
      } else {
        page++
      }
    }
    return files
  })
}

const readFile: GitProvider['readFile'] = async(ref, auth, path, branch) => {
  return withCache(getCacheKey(ref, `file:${branch}:${path}`, auth), async() => {
    return getText(
      'GitLab',
      `${getProjectApi(ref)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`,
      { headers: getHeaders(auth), timeout: REQUEST_TIMEOUT },
    )
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

const downloadReleaseAsset: GitProvider['downloadReleaseAsset'] = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset:${asset.id}`, auth), async() => {
    const response = await requestText(asset.downloadUrl, {
      headers: downloadHeaders(ref, auth, asset.downloadUrl),
      timeout: REQUEST_TIMEOUT,
    })
    if (!response.ok) throw buildHttpError('GitLab', response.status, asset.downloadUrl)
    return response.text
  })
}

const downloadReleaseAssetBinary: NonNullable<GitProvider['downloadReleaseAssetBinary']> = async(ref, auth, asset) => {
  return withCache(getCacheKey(ref, `asset-bin:${asset.id}`, auth), async() => {
    return requestBinary(asset.downloadUrl, {
      headers: downloadHeaders(ref, auth, asset.downloadUrl),
      timeout: REQUEST_TIMEOUT,
    })
  })
}

export const gitlabProvider: GitProvider = {
  id: 'gitlab',
  getRepoInfo,
  getLatestRelease,
  listFiles,
  readFile,
  readReadme,
  downloadReleaseAsset,
  downloadReleaseAssetBinary,
}
