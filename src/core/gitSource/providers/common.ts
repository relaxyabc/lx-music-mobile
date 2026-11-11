import { HttpError, isTransientError, requestJson, requestText, type RequestOptions } from '../request'

export { isTransientError }

/** 统一的 HTTP 错误构造，错误信息保持简短英文（UI 会再包一层提示） */
export const buildHttpError = (providerName: string, status: number, url: string): HttpError => {
  if (status === 401) return new HttpError(`${providerName} API unauthorized`, status, url)
  if (status === 403 || status === 429) return new HttpError(`${providerName} API rate limit exceeded`, status, url)
  if (status === 404) return new HttpError(`${providerName} resource not found`, status, url)
  return new HttpError(`${providerName} API error (HTTP ${status})`, status, url)
}

/** 请求 JSON，非 2xx 状态抛出可识别的 HttpError */
export const getJson = async <T = any>(providerName: string, url: string, options: RequestOptions = {}): Promise<T> => {
  const response = await requestJson<T>(url, options)
  if (!response.ok) throw buildHttpError(providerName, response.status, url)
  if (response.data == null) throw new HttpError(`${providerName} API returned an empty response`, response.status, url)
  return response.data
}

/** 请求 JSON，404 等 HTTP 错误返回 null（网络错误仍然抛出） */
export const tryGetJson = async <T = any>(providerName: string, url: string, options: RequestOptions = {}): Promise<T | null> => {
  const response = await requestJson<T>(url, options)
  return response.ok ? response.data : null
}

/** 请求文本，非 2xx 状态抛出可识别的 HttpError */
export const getText = async (providerName: string, url: string, options: RequestOptions = {}): Promise<string> => {
  const response = await requestText(url, options)
  if (!response.ok) throw buildHttpError(providerName, response.status, url)
  return response.text
}

interface CacheEntry {
  value: unknown
  time: number
}

const CACHE_TTL = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 400
const cache = new Map<string, CacheEntry>()

/** 带缓存的请求，避免同一次操作中对同一仓库重复请求（也用于减少 API 限额消耗） */
export const withCache = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.value as T
  const value = await loader()
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value
    if (firstKey != null) cache.delete(firstKey)
  }
  cache.set(key, { value, time: Date.now() })
  return value
}

/** 清空提供方缓存（测试或手动刷新时使用） */
export const clearProviderCache = () => {
  cache.clear()
}

/** 按仓库+分支生成缓存 key */
export const repoCacheKey = (host: string, repoPath: string, branch: string, scope: string) => {
  return `${host}/${repoPath}@${branch}:${scope}`
}

/** 逐段编码仓库内路径，保留 `/` 分隔符 */
export const encodePath = (path: string): string => {
  return path
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/** 在文件列表中找到 README（不区分大小写） */
export const findReadmePath = (files: Array<{ path: string }> | null | undefined, names: readonly string[]): string | null => {
  if (!files?.length) return null
  for (const name of names) {
    const target = files.find(file => file.path.toLowerCase() === name.toLowerCase())
    if (target) return target.path
  }
  return null
}

/** FNV-1a 32 位哈希，用于镜像兜底时生成内容指纹 */
export const simpleHash = (text: string): string => {
  let hash = 0x811C9DC5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
