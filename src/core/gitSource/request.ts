import { REQUEST_TIMEOUT } from './constants'
import type { GitRepoAuth, GitRepoRef } from './types'

/** 所有请求默认携带的 User-Agent（GitHub API 强制要求） */
export const USER_AGENT = 'lx-music-mobile'

export interface RequestOptions {
  headers?: Record<string, string | undefined>
  timeout?: number
  method?: string
}

export interface TextResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
  url: string
}

export interface JsonResponse<T> extends TextResponse {
  data: T | null
}

/** 带 HTTP 状态码的错误，便于判断是否需要用镜像兜底 */
export class HttpError extends Error {
  status: number
  url: string

  constructor(message: string, status: number, url: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

/** 网络错误、超时、限流等临时性错误可以使用镜像兜底；404/401 等确定性错误不兜底 */
export const isTransientError = (error: unknown): boolean => {
  if (error instanceof HttpError) {
    if (error.status === 0) return true
    if (error.status === 403 || error.status === 429 || error.status >= 500) return true
    return false
  }
  return true
}

const cleanHeaders = (headers?: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {}
  if (!headers) return result
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) result[key] = value
  }
  return result
}

/** 把 fetch 的 Headers 对象转成普通对象（统一小写 key） */
export const headersToObject = (headers: any): Record<string, string> => {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (typeof headers.forEach === 'function') {
    headers.forEach((value: string, key: string) => {
      result[String(key).toLowerCase()] = value
    })
    return result
  }
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) result[String(key).toLowerCase()] = value
    return result
  }
  if (Array.isArray(headers)) {
    for (const item of headers) {
      if (Array.isArray(item)) result[String(item[0]).toLowerCase()] = String(item[1])
    }
  }
  return result
}

const fetchWithTimeout = async(url: string, options: RequestOptions): Promise<Response> => {
  const timeout = options.timeout ?? REQUEST_TIMEOUT
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = controller
    ? setTimeout(() => {
        controller.abort()
      }, timeout)
    : null
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers: cleanHeaders({ 'User-Agent': USER_AGENT, ...options.headers }),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (error: any) {
    if (controller?.signal.aborted) throw new HttpError(`Request timeout after ${timeout}ms`, 0, url)
    throw new HttpError(`Network request failed: ${error?.message ?? String(error)}`, 0, url)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 请求文本内容；网络错误/超时抛 HttpError，HTTP 错误状态不抛（由调用方判断） */
export const requestText = async(url: string, options: RequestOptions = {}): Promise<TextResponse> => {
  const response = await fetchWithTimeout(url, options)
  let text: string
  try {
    text = await response.text()
  } catch (error: any) {
    throw new HttpError(`Failed to read response body: ${error?.message ?? String(error)}`, response.status, url)
  }
  return {
    status: response.status,
    ok: response.ok,
    headers: headersToObject(response.headers),
    text,
    url,
  }
}

/** 请求 JSON；HTTP 错误状态不抛，但 JSON 解析失败会抛错 */
export const requestJson = async<T = unknown>(url: string, options: RequestOptions = {}): Promise<JsonResponse<T>> => {
  const response = await requestText(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  })
  if (!response.ok) {
    return { ...response, data: null }
  }
  try {
    return { ...response, data: response.text ? JSON.parse(response.text) as T : null }
  } catch {
    throw new HttpError('Invalid JSON response', response.status, url)
  }
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
let base64Lookup: Int16Array | null = null
const getBase64Lookup = () => {
  if (base64Lookup) return base64Lookup
  const lookup = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) lookup[B64_CHARS.charCodeAt(i)] = i
  base64Lookup = lookup
  return lookup
}

/** 纯 JS 的 base64 解码（不依赖 Buffer/atob），支持 data URL 与 URL-safe 变体 */
export const base64ToBytes = (input: string): Uint8Array => {
  if (typeof input !== 'string') throw new Error('Invalid base64 string')
  let str = input.trim()
  if (str.startsWith('data:')) {
    const commaIndex = str.indexOf(',')
    if (commaIndex > 0) str = str.slice(commaIndex + 1)
  }
  str = str.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const lookup = getBase64Lookup()
  const output = new Uint8Array(Math.floor(str.length * 3 / 4))
  let buffer = 0
  let bits = 0
  let index = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (str[i] === '=') break
    const value = code < 128 ? lookup[code] : -1
    if (value < 0) throw new Error('Invalid base64 string')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output[index++] = (buffer >> bits) & 0xFF
    }
  }
  return index === output.length ? output : output.subarray(0, index)
}

/** 纯 JS 的 UTF-8 解码（不依赖 TextDecoder），非法字节替换为 U+FFFD */
export const bytesToUtf8 = (bytes: Uint8Array): string => {
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch { /* 环境实现异常时走手动解码 */ }
  }
  let result = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]
    let codePoint: number
    if (byte < 0x80) {
      codePoint = byte
      i += 1
    } else if (byte >= 0xC0 && byte < 0xE0) {
      if (i + 1 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80) {
        result += '\uFFFD'
        i += 1
        continue
      }
      codePoint = ((byte & 0x1F) << 6) | (bytes[i + 1] & 0x3F)
      i += 2
    } else if (byte >= 0xE0 && byte < 0xF0) {
      if (i + 2 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80) {
        result += '\uFFFD'
        i += 1
        continue
      }
      codePoint = ((byte & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)
      i += 3
    } else if (byte >= 0xF0 && byte < 0xF8) {
      if (i + 3 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80 || (bytes[i + 3] & 0xC0) !== 0x80) {
        result += '\uFFFD'
        i += 1
        continue
      }
      codePoint = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F)
      i += 4
    } else {
      result += '\uFFFD'
      i += 1
      continue
    }
    if (codePoint > 0xFFFF) {
      codePoint -= 0x10000
      result += String.fromCharCode(0xD800 + (codePoint >> 10), 0xDC00 + (codePoint & 0x03FF))
    } else {
      result += String.fromCharCode(codePoint)
    }
  }
  return result
}

/** 纯 JS 的 base64 字符串转 UTF-8 文本 */
export const base64ToUtf8 = (input: string): string => bytesToUtf8(base64ToBytes(input))

/** 纯 JS 的 UTF-8 编码（不依赖 TextEncoder） */
export const utf8ToBytes = (text: string): Uint8Array => {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    let codePoint = text.charCodeAt(i)
    if (codePoint >= 0xD800 && codePoint <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (next - 0xDC00)
        i++
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F))
    } else if (codePoint < 0x10000) {
      bytes.push(0xE0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F))
    } else {
      bytes.push(
        0xF0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3F),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F),
      )
    }
  }
  return new Uint8Array(bytes)
}

const BYTES_B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 纯 JS 的字节数组转 base64（用于 Basic 认证） */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    result += BYTES_B64_CHARS[b0 >> 2]
    result += BYTES_B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    result += i + 1 < bytes.length ? BYTES_B64_CHARS[((b1 & 0x0F) << 2) | (b2 >> 6)] : '='
    result += i + 2 < bytes.length ? BYTES_B64_CHARS[b2 & 0x3F] : '='
  }
  return result
}

/** 纯 JS 的 UTF-8 文本转 base64 */
export const utf8ToBase64 = (text: string): string => bytesToBase64(utf8ToBytes(text))

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader is not available'))
      return
    }
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Failed to read blob'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 请求二进制内容。
 *
 * React Native 的 fetch 不保证实现 `arrayBuffer()`，因此依次尝试：
 * `arrayBuffer()` → `blob()` + `FileReader.readAsDataURL` → 抛错。
 */
export const requestBinary = async(url: string, options: RequestOptions = {}): Promise<Uint8Array> => {
  const response = await fetchWithTimeout(url, options)
  if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status, url)

  if (typeof (response as any).arrayBuffer === 'function') {
    return new Uint8Array(await response.arrayBuffer())
  }
  if (typeof (response as any).blob === 'function') {
    const blob = await response.blob()
    const dataUrl = await blobToDataUrl(blob)
    return base64ToBytes(dataUrl)
  }
  throw new HttpError('Binary response is not supported in this environment', 0, url)
}

/**
 * 合并用户填写的认证信息与仓库地址中携带的认证信息。
 * 地址中的密码（`https://user:token@host`）作为 token 兜底。
 */
export const mergeAuth = (ref: Pick<GitRepoRef, 'urlAuth'>, auth?: GitRepoAuth | null): GitRepoAuth => {
  const urlAuth = ref.urlAuth
  return {
    token: auth?.token || urlAuth?.password || '',
    username: auth?.username || urlAuth?.username || '',
  }
}

/** 是否提供了任意一种认证信息 */
export const hasAuth = (auth: GitRepoAuth): boolean => !!auth.token || !!auth.username

/** 把认证信息编码为 Basic 认证头内容 */
export const buildBasicAuth = (username: string, password: string) => {
  return `Basic ${utf8ToBase64(`${username}:${password}`)}`
}
