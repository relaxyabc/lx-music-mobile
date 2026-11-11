import {
  MANIFEST_FILE_NAMES,
  MAX_ASSET_SIZE,
  MAX_GIT_SOURCE_COUNT,
  MAX_SCRIPT_SIZE,
  MAX_TREE_SCAN_FILES,
  REQUEST_TIMEOUT,
  TREE_IGNORE_PATHS,
} from './constants'
import { extractSourceLinksFromMarkdown, parseManifestDocument, type GitSourceLink } from './manifest'
import { getProvider } from './providers'
import { bytesToUtf8, mergeAuth, requestText } from './request'
import type {
  GitBundleOrigin,
  GitFileEntry,
  GitRelease,
  GitReleaseAsset,
  GitRepoAuth,
  GitRepoInfo,
  GitRepoRef,
  GitSourceBundle,
  GitSourceCheckResult,
  GitSourceConfig,
  GitSourceScript,
  GitProvider,
} from './types'
import { parseGitRepoUrl } from './url'
import { normalizeSources } from './validate'
import { compareGitVersion, parseVersionFromReadme, parseVersionFromRelease } from './version'
import { extractZip } from './zip'

export interface FetchBundleOptions {
  /** 补充的仓库认证信息（仓库地址中携带的认证信息会自动合并） */
  auth?: GitRepoAuth
  onProgress?: (progress: import('./types').GitProgress) => void
}

interface LoadItem {
  path: string
  load: () => Promise<string>
}

interface LoadedScripts {
  scripts: GitSourceScript[]
  /** 读取/下载失败的脚本数量 */
  failed: number
}

interface ReadmeResult {
  version: string | null
  bundle: GitSourceBundle | null
}

type PoolResult<T> =
  | { ok: true, value: T }
  | { ok: false, error: unknown }

/** 同时下载的脚本数量（串行下载 20+ 个文件太慢，并发过高又容易被限流） */
const SCRIPT_FETCH_CONCURRENCY = 4

const reportProgress = (onProgress: FetchBundleOptions['onProgress'], progress: import('./types').GitProgress) => {
  if (!onProgress) return
  try {
    onProgress(progress)
  } catch { /* 进度回调异常不影响主流程 */ }
}

const runPool = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (index: number) => void,
): Promise<Array<PoolResult<R>>> => {
  const results: Array<PoolResult<R>> = new Array(items.length)
  if (!items.length) return results
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async() => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await worker(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
      onSettled?.(index)
    }
  })
  await Promise.all(runners)
  return results
}

const loadScripts = async(items: LoadItem[], onProgress: FetchBundleOptions['onProgress']): Promise<LoadedScripts> => {
  const total = items.length
  let completed = 0
  reportProgress(onProgress, { stage: 'files', current: 0, total })
  const results = await runPool(items, SCRIPT_FETCH_CONCURRENCY, async(item) => {
    const script = await item.load()
    if (typeof script !== 'string') throw new Error(`Failed to read source script: ${item.path}`)
    if (script.length > MAX_SCRIPT_SIZE) throw new Error(`Source script is too large: ${item.path}`)
    return script
  }, () => {
    completed++
    reportProgress(onProgress, { stage: 'files', current: completed, total })
  })

  const scripts: GitSourceScript[] = []
  let failed = 0
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.ok) scripts.push({ path: items[index].path, script: result.value })
    else failed++
  }
  return { scripts, failed }
}

/** 读取链接列表对应的脚本内容（仓库内路径通过 API 读取，外部直链直接请求） */
const loadLinks = async(
  links: GitSourceLink[],
  provider: GitProvider,
  ref: GitRepoRef,
  auth: GitRepoAuth,
  branch: string,
  onProgress: FetchBundleOptions['onProgress'],
): Promise<LoadedScripts> => {
  const items: LoadItem[] = links.map(link => {
    if (link.kind === 'repoPath') {
      return {
        path: link.path,
        load: () => provider.readFile(ref, auth, link.path, branch),
      }
    }
    return {
      path: link.url,
      load: async() => {
        const response = await requestText(link.url, { timeout: REQUEST_TIMEOUT })
        if (!response.ok) throw new Error(`Failed to download source script (HTTP ${response.status})`)
        return response.text
      },
    }
  })
  return loadScripts(items, onProgress)
}

const finalize = (
  loaded: LoadedScripts,
  info: GitRepoInfo,
  origin: GitBundleOrigin,
  version: string | null,
): GitSourceBundle | null => {
  if (!loaded.scripts.length) return null
  const normalized = normalizeSources(loaded.scripts, MAX_GIT_SOURCE_COUNT)
  if (!normalized.sources.length) return null
  return {
    version,
    headSha: info.headSha,
    repo: info,
    origin,
    sources: normalized.sources,
    skipped: normalized.skipped + loaded.failed,
  }
}

const isJsAsset = (asset: GitReleaseAsset) => /\.js$/i.test(asset.name) && (asset.size === 0 || asset.size <= MAX_SCRIPT_SIZE)
const isZipAsset = (asset: GitReleaseAsset) => /\.zip$/i.test(asset.name) && (asset.size === 0 || asset.size <= MAX_ASSET_SIZE)
const isJsonAsset = (asset: GitReleaseAsset) => /\.json$/i.test(asset.name) && (asset.size === 0 || asset.size <= MAX_SCRIPT_SIZE)

/** 策略 A：使用最新 release 中提供的脚本 / 压缩包 / 清单 */
const fetchFromRelease = async(
  provider: GitProvider,
  ref: GitRepoRef,
  auth: GitRepoAuth,
  branch: string,
  release: GitRelease,
  info: GitRepoInfo,
  version: string | null,
  onProgress: FetchBundleOptions['onProgress'],
): Promise<GitSourceBundle | null> => {
  const assets = release.assets
  const jsAssets = assets.filter(isJsAsset).slice(0, MAX_GIT_SOURCE_COUNT)
  const zipAssets = assets.filter(isZipAsset).slice(0, 3)
  const jsonAssets = assets.filter(isJsonAsset).slice(0, 3)

  if (jsAssets.length > 0) {
    const loaded = await loadScripts(jsAssets.map(asset => ({
      path: asset.name,
      load: () => provider.downloadReleaseAsset(ref, auth, asset),
    })), onProgress)
    const bundle = finalize(loaded, info, 'release', version)
    if (bundle) return bundle
  }

  if (zipAssets.length > 0 && provider.downloadReleaseAssetBinary) {
    for (const asset of zipAssets) {
      try {
        const buffer = await provider.downloadReleaseAssetBinary(ref, auth, asset)
        const entries = extractZip(buffer)
        const candidates: GitSourceScript[] = entries
          .filter(entry => /\.js$/i.test(entry.name))
          .map(entry => ({
            path: `${asset.name}#${entry.name}`,
            script: bytesToUtf8(entry.data),
          }))
        reportProgress(onProgress, { stage: 'files', current: candidates.length, total: candidates.length })
        const bundle = finalize({ scripts: candidates, failed: 0 }, info, 'release', version)
        if (bundle) return bundle
      } catch { /* 尝试下一个压缩包 */ }
    }
  }

  if (jsonAssets.length > 0) {
    for (const asset of jsonAssets) {
      try {
        const manifestText = await provider.downloadReleaseAsset(ref, auth, asset)
        const document = parseManifestDocument(manifestText, ref)
        if (!document.links.length) continue
        const loaded = await loadLinks(document.links, provider, ref, auth, branch, onProgress)
        const bundle = finalize(loaded, info, 'release', version ?? document.version)
        if (bundle) return bundle
      } catch { /* 尝试下一个清单文件 */ }
    }
  }

  return null
}

const isIgnoredPath = (path: string) => {
  const lower = path.toLowerCase()
  return TREE_IGNORE_PATHS.some(prefix => lower.startsWith(prefix) || lower.includes(`/${prefix}`))
}

const findManifestPath = (files: GitFileEntry[]): string | null => {
  const rootFiles = files.filter(file => !file.path.includes('/'))
  for (const name of MANIFEST_FILE_NAMES) {
    const target = rootFiles.find(file => file.path.toLowerCase() === name.toLowerCase())
    if (target) return target.path
  }
  return null
}

/** 策略 B：仓库根目录的音源清单 */
const fetchFromManifest = async(
  provider: GitProvider,
  ref: GitRepoRef,
  auth: GitRepoAuth,
  branch: string,
  files: GitFileEntry[] | null,
  info: GitRepoInfo,
  version: string | null,
  onProgress: FetchBundleOptions['onProgress'],
): Promise<GitSourceBundle | null> => {
  if (!files?.length) return null
  const manifestPath = findManifestPath(files)
  if (!manifestPath) return null

  let manifestText: string
  try {
    manifestText = await provider.readFile(ref, auth, manifestPath, branch)
  } catch {
    return null
  }
  const document = parseManifestDocument(manifestText, ref)
  if (!document.links.length) return null
  const loaded = await loadLinks(document.links, provider, ref, auth, branch, onProgress)
  return finalize(loaded, info, 'manifest', version ?? document.version)
}

/** 策略 C：从 README 中提取在线导入链接 */
const fetchFromReadme = async(
  provider: GitProvider,
  ref: GitRepoRef,
  auth: GitRepoAuth,
  branch: string,
  info: GitRepoInfo,
  version: string | null,
  onProgress: FetchBundleOptions['onProgress'],
): Promise<ReadmeResult> => {
  const readme = await provider.readReadme(ref, auth, branch).catch(() => null)
  if (!readme) return { version, bundle: null }
  const readmeVersion = parseVersionFromReadme(readme.content)
  const nextVersion = version ?? readmeVersion
  const links = extractSourceLinksFromMarkdown(readme.content, ref)
  if (!links.length) return { version: nextVersion, bundle: null }
  const loaded = await loadLinks(links, provider, ref, auth, branch, onProgress)
  return { version: nextVersion, bundle: finalize(loaded, info, 'readme', nextVersion) }
}

/** 策略 D：扫描仓库中的 .js 文件 */
const fetchFromTree = async(
  provider: GitProvider,
  ref: GitRepoRef,
  auth: GitRepoAuth,
  branch: string,
  files: GitFileEntry[],
  info: GitRepoInfo,
  version: string | null,
  onProgress: FetchBundleOptions['onProgress'],
): Promise<GitSourceBundle | null> => {
  const candidates = files.filter(file => {
    if (!/\.js$/i.test(file.path)) return false
    if (file.size > 0 && file.size > MAX_SCRIPT_SIZE) return false
    return !isIgnoredPath(file.path)
  })
  if (!candidates.length) return null
  if (candidates.length > MAX_TREE_SCAN_FILES) {
    throw new Error('Too many .js files in repository, cannot identify music sources automatically. Please provide online import links in README or source files in Release')
  }
  const loaded = await loadScripts(candidates.map(file => ({
    path: file.path,
    load: () => provider.readFile(ref, auth, file.path, branch),
  })), onProgress)
  return finalize(loaded, info, 'tree', version)
}

/**
 * 从一个 Git 仓库获取最新音源。
 *
 * 策略优先级：release 资源 → 仓库清单 → README 在线导入链接 → 仓库文件扫描，
 * 前一个策略没有可用音源时才进入下一个策略。全部失败时抛出明确错误。
 */
export const fetchGitSourceBundle = async(input: string, options: FetchBundleOptions = {}): Promise<GitSourceBundle> => {
  const ref = parseGitRepoUrl(input)
  if (!ref) throw new Error('Invalid Git repository URL')
  const provider = getProvider(ref.provider)
  const auth = mergeAuth(ref, options.auth)
  const { onProgress } = options

  reportProgress(onProgress, { stage: 'repo' })
  const info = await provider.getRepoInfo(ref, auth)
  const branch = info.defaultBranch

  reportProgress(onProgress, { stage: 'release' })
  const release = await provider.getLatestRelease(ref, auth).catch(() => null)
  let version = release ? parseVersionFromRelease(release) : null

  let filesPromise: Promise<GitFileEntry[] | null> | null = null
  let listFilesError: unknown = null
  const getFiles = (): Promise<GitFileEntry[] | null> => {
    filesPromise ??= provider.listFiles(ref, auth, branch)
      .then(files => files)
      .catch((error: unknown) => {
        listFilesError = error
        return null
      })
    return filesPromise
  }

  if (release?.assets?.length) {
    const bundle = await fetchFromRelease(provider, ref, auth, branch, release, info, version, onProgress)
    if (bundle?.sources.length) return bundle
  }

  const files = await getFiles()
  const manifestBundle = await fetchFromManifest(provider, ref, auth, branch, files, info, version, onProgress)
  if (manifestBundle?.sources.length) return manifestBundle

  const readmeResult = await fetchFromReadme(provider, ref, auth, branch, info, version, onProgress)
  if (readmeResult.bundle?.sources.length) return readmeResult.bundle
  version = readmeResult.version

  if (!files) {
    if (listFilesError) throw listFilesError instanceof Error ? listFilesError : new Error('Failed to list repository files')
    throw new Error('Failed to list repository files')
  }

  const treeBundle = await fetchFromTree(provider, ref, auth, branch, files, info, version, onProgress)
  if (treeBundle?.sources.length) return treeBundle

  throw new Error('No music source script found in repository')
}

/**
 * 检查仓库是否有更新。
 *
 * 有远端版本号时按版本号比较；无法解析版本号时退化为比较 headSha。
 * 网络/解析错误直接抛出（由调用方静默处理）。
 */
export const checkGitSourceUpdate = async(
  config: GitSourceConfig,
  options: FetchBundleOptions = {},
): Promise<GitSourceCheckResult> => {
  const ref = parseGitRepoUrl(config.url)
  if (!ref) throw new Error('Invalid Git repository URL')
  const provider = getProvider(ref.provider)
  const auth = mergeAuth(ref, {
    token: config.token,
    username: config.username,
    ...(options.auth ?? {}),
  })

  const info = await provider.getRepoInfo(ref, auth)
  const release = await provider.getLatestRelease(ref, auth).catch(() => null)
  let version = release ? parseVersionFromRelease(release) : null
  if (!version) {
    const readme = await provider.readReadme(ref, auth, info.defaultBranch).catch(() => null)
    if (readme) version = parseVersionFromReadme(readme.content)
  }

  let available: boolean
  if (version && config.version) available = compareGitVersion(version, config.version) > 0
  else if (version) available = true
  else available = info.headSha !== config.headSha

  return {
    available,
    version,
    headSha: info.headSha,
    repo: info,
    currentVersion: config.version,
  }
}
