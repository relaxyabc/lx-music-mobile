import type { GitProviderId, GitRepoRef } from './types'

/**
 * 手动解析出的 http(s) 地址信息。
 *
 * 这里不使用全局 `URL`，因为 React Native（0.73 及之前）自带的 URL 实现并不完整，
 * 解析 userinfo、path 等会得到与浏览器不一致的结果。
 */
export interface ParsedHttpUrl {
  protocol: 'http' | 'https'
  /** 主机名（小写，不含端口与用户信息） */
  hostname: string
  /** 主机名 + 端口 */
  host: string
  port: string
  /** 路径（未解码），以 `/` 开头，不含 query/hash */
  path: string
  query: string
  hash: string
  username: string
  password: string
}

const HTTP_URL_RXP = /^(https?):\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i

const normalizeHostname = (hostname: string) => hostname.toLowerCase()

const isValidHostname = (hostname: string) => {
  if (!hostname) return false
  if (/\s/.test(hostname)) return false
  if (hostname.startsWith('[')) return /^\[[0-9a-f:.]+\]$/i.test(hostname)
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)
}

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const splitUserinfo = (userinfo: string): [string, string] => {
  if (!userinfo) return ['', '']
  const index = userinfo.indexOf(':')
  if (index < 0) return [safeDecode(userinfo), '']
  return [safeDecode(userinfo.slice(0, index)), safeDecode(userinfo.slice(index + 1))]
}

/** 解析一个 http(s) 地址，失败时返回 null（不抛异常） */
export const parseHttpUrl = (input: string): ParsedHttpUrl | null => {
  if (typeof input !== 'string') return null
  const match = HTTP_URL_RXP.exec(input.trim())
  if (!match) return null

  const protocol = match[1].toLowerCase() as 'http' | 'https'
  const hostname = normalizeHostname(match[3] ?? '')
  if (!isValidHostname(hostname)) return null
  const port = match[4] ?? ''
  const [username, password] = splitUserinfo(match[2] ?? '')
  const path = match[5] || '/'

  return {
    protocol,
    hostname,
    host: port ? `${hostname}:${port}` : hostname,
    port,
    path,
    query: match[6] ?? '',
    hash: match[7] ?? '',
    username,
    password,
  }
}

/** 判断地址是否使用了 https 协议 */
export const isHttpsUrl = (input: string) => /^https:\/\//i.test(input.trim())

const GIT_SSH_RXP = /^git@([^:/\s]+)(?::(\d+))?[:/](.+)$/i
const SSH_SCHEME_RXP = /^ssh:\/\/(?:[^@/\s]+@)?([^/?#\s]+)(?:\/(.*))?$/i
const SCHEME_RXP = /^[a-z][a-z0-9+.-]*:\/\//i

/** 把用户输入统一转换成 http(s) 地址字符串 */
const toHttpUrl = (input: string): string | null => {
  let str = input.trim()
  if (!str) return null
  str = str.replace(/^git\+/i, '')

  if (/^git@/i.test(str)) {
    const match = GIT_SSH_RXP.exec(str)
    if (!match) return null
    const host = match[2] ? `${match[1]}:${match[2]}` : match[1]
    return `https://${host}/${match[3].replace(/^\/+/, '')}`
  }
  if (/^ssh:\/\//i.test(str)) {
    const match = SSH_SCHEME_RXP.exec(str)
    if (!match) return null
    return `https://${match[1]}/${(match[2] ?? '').replace(/^\/+/, '')}`
  }
  if (SCHEME_RXP.test(str)) {
    return /^https?:\/\//i.test(str) ? str : null
  }

  // 省略协议的写法：github.com/owner/repo
  return `https://${str.replace(/^\/+/, '')}`
}

const KNOWN_HOST_SUFFIX: Array<{ suffix: string, provider: GitProviderId }> = [
  { suffix: 'github.com', provider: 'github' },
  { suffix: 'gitee.com', provider: 'gitee' },
  { suffix: 'gitlab.com', provider: 'gitlab' },
  { suffix: 'devops.aliyuncs.com', provider: 'codeup' },
  { suffix: 'codeup.aliyun.com', provider: 'codeup' },
]

const detectProvider = (hostname: string): GitProviderId => {
  for (const { suffix, provider } of KNOWN_HOST_SUFFIX) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return provider
  }
  // 自建服务：按常见域名约定猜测（其余一律按 Gitea 处理）
  if (/^gitlab[.-]/.test(hostname) || /\.gitlab[.-]/.test(hostname)) return 'gitlab'
  return 'gitea'
}

const getApiBase = (provider: GitProviderId, parsed: ParsedHttpUrl) => {
  switch (provider) {
    case 'github':
      return 'https://api.github.com'
    case 'gitee':
      return 'https://gitee.com/api/v5'
    case 'gitlab':
      return parsed.hostname === 'gitlab.com' ? 'https://gitlab.com/api/v4' : `${parsed.protocol}://${parsed.host}/api/v4`
    case 'codeup':
      return `${parsed.protocol}://${parsed.host}/oapi/v1/codeup`
    case 'gitea':
    default:
      return `${parsed.protocol}://${parsed.host}/api/v1`
  }
}

/** 已知的 SaaS 服务固定使用 https，自建服务保留用户输入的协议 */
const getRepoProtocol = (provider: GitProviderId, parsed: ParsedHttpUrl) => {
  if (provider === 'github' || provider === 'gitee' || provider === 'gitlab' || provider === 'codeup') return 'https'
  return parsed.protocol
}

/**
 * 解析 Git 仓库地址。
 *
 * 支持：
 * - `https://host/owner/repo`、`http://`、结尾 `.git`/`/`、带 query/hash
 * - 带用户信息的 `https://user:token@host/owner/repo`
 * - SSH 形式的 `git@host:owner/repo.git`（转成 https）
 * - 省略协议的 `github.com/owner/repo`
 *
 * 无法识别时返回 null。
 */
export const parseGitRepoUrl = (input: string): GitRepoRef | null => {
  if (typeof input !== 'string') return null
  const httpUrl = toHttpUrl(input)
  if (!httpUrl) return null
  const parsed = parseHttpUrl(httpUrl)
  if (!parsed) return null

  const segments = parsed.path.split('/').filter(segment => segment.length > 0)
  if (segments.length < 2) return null

  const decoded = segments.map(safeDecode)
  const lastIndex = decoded.length - 1
  decoded[lastIndex] = decoded[lastIndex].replace(/\.git$/i, '')
  const lastSegment = decoded[lastIndex]
  if (!lastSegment || lastSegment === '.' || lastSegment === '..') return null
  for (const segment of decoded) {
    if (!segment || segment === '.' || segment === '..' || /[\s/]/.test(segment)) return null
  }

  const provider = detectProvider(parsed.hostname)
  let owner: string
  let repo: string
  let repoPath: string
  if (provider === 'gitlab') {
    // GitLab 支持 group/subgroup/repo 形式的多级命名空间
    owner = decoded[0]
    repo = lastSegment
    repoPath = decoded.join('/')
  } else {
    owner = decoded[0]
    repo = decoded[1]
    repoPath = `${owner}/${repo}`
  }

  const protocol = getRepoProtocol(provider, parsed)
  const urlAuth = parsed.username || parsed.password
    ? {
        ...(parsed.username ? { username: parsed.username } : {}),
        ...(parsed.password ? { password: parsed.password } : {}),
      }
    : undefined

  return {
    url: `${protocol}://${parsed.host}/${repoPath}`,
    protocol,
    provider,
    host: parsed.host,
    owner,
    repo,
    repoPath,
    apiBase: getApiBase(provider, parsed),
    ...(urlAuth ? { urlAuth } : {}),
  }
}

/** 用于界面展示的仓库名称，GitLab 使用多级命名空间 */
export const getRepoLabel = (ref: GitRepoRef): string => {
  return ref.provider === 'gitlab' ? ref.repoPath : `${ref.owner}/${ref.repo}`
}
