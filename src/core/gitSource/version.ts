import type { GitRelease } from './types'

/** 规范化后的版本号：V1.2.3 或 V1.2.3-260108 */
export type NormalizedGitVersion = string

const VERSION_EXACT_RXP = /^[Vv]?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-(\d{2,8}))?$/

/**
 * 在文本中查找版本号。
 * 前面要求不是字母/数字/下划线/点/斜杠/横线，避免匹配到 `xxx/v1.2.3.js` 这类 URL 片段；
 * 后面要求不是字母/数字/下划线/点，避免把 `1.2.3.js`、`1.2.34` 当成版本号；
 * 最后额外要求 `-` 后面必须跟数字，避免把 `1.2.3-beta` 这类 semver 预发布号截断成 `1.2.3`。
 */
const VERSION_SEARCH_RXP = /(^|[^0-9A-Za-z_./])([Vv]?)(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-(\d{2,8}))?(?![A-Za-z0-9_.])(?!-[^\d])/g

const formatVersion = (major: string, minor: string, patch: string, suffix?: string) => {
  const parts = [major, minor, patch].map(part => String(parseInt(part, 10)))
  return `V${parts.join('.')}${suffix ? `-${suffix}` : ''}`
}

interface VersionMatch {
  version: NormalizedGitVersion
  index: number
  hasPrefix: boolean
  inUrl: boolean
}

/** 判断某个位置是否位于 URL（或被 URL 包含的文本）中 */
const isUrlContext = (text: string, index: number) => {
  const boundary = Math.max(
    text.lastIndexOf('\n', index),
    text.lastIndexOf(' ', index),
    text.lastIndexOf('(', index),
    text.lastIndexOf('[', index),
    text.lastIndexOf('"', index),
    text.lastIndexOf('`', index),
  )
  const segment = text.slice(boundary + 1, index + 1)
  return /(?:https?:\/\/|www\.)\S*$/i.test(segment)
}

const collectVersionMatches = (text: string): VersionMatch[] => {
  const matches: VersionMatch[] = []
  VERSION_SEARCH_RXP.lastIndex = 0
  let result: RegExpExecArray | null
  while ((result = VERSION_SEARCH_RXP.exec(text)) != null) {
    const hasPrefix = result[2].length > 0
    const version = formatVersion(result[3], result[4], result[5], result[6])
    const index = result.index + result[1].length
    matches.push({
      version,
      index,
      hasPrefix,
      inUrl: isUrlContext(text, index),
    })
    // 防止零宽匹配导致的死循环
    if (result[0].length === 0) VERSION_SEARCH_RXP.lastIndex++
  }
  return matches
}

/** 从版本号文本中解析出三段数字与日期后缀 */
export const parseGitVersionParts = (version: string): { parts: [number, number, number], suffix: string | null } | null => {
  const normalized = normalizeGitVersion(version)
  if (!normalized) return null
  const match = VERSION_EXACT_RXP.exec(normalized)
  if (!match) return null
  return {
    parts: [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)],
    suffix: match[4] ?? null,
  }
}

/**
 * 从任意文本中提取并规范化版本号。
 *
 * 输出格式为 `V{major}.{minor}.{patch}[-{yyyydd}]`，例如 `V1.1.1-260108`、`V1.2.0`。
 * 文本整体就是版本号时优先；否则在文本中查找，带 `V` 前缀且不在 URL 中的匹配优先。
 */
export const normalizeGitVersion = (text?: string | null): NormalizedGitVersion | null => {
  if (text == null) return null
  const str = String(text).trim()
  if (!str) return null

  const exact = VERSION_EXACT_RXP.exec(str)
  if (exact) return formatVersion(exact[1], exact[2], exact[3], exact[4])

  const matches = collectVersionMatches(str)
  if (!matches.length) return null

  const ranked = (match: VersionMatch) => {
    // 优先级：带 V 前缀且不在 URL 中 > 带 V 前缀 > 不在 URL 中 > 其它
    if (match.hasPrefix && !match.inUrl) return 0
    if (match.hasPrefix) return 1
    if (!match.inUrl) return 2
    return 3
  }
  matches.sort((a, b) => ranked(a) - ranked(b) || a.index - b.index)
  return matches[0].version
}

/** README 中带标签的版本号，如「版本：V1.1.1-260108」「version: 1.2.0」 */
const LABELED_VERSION_RXP = /(?:版本(?:号)?|version)\s*[:：]?\s*([Vv]?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-\d{2,8})?)/gi

/**
 * 从 README 文本中解析版本号。
 *
 * 优先取「版本/version」标签后面的版本号（避免把 README 里其它项目的 badge、示例当成音源库版本），
 * 没有标签时才回退到第一处带 V/v 前缀且不在 URL 中的 semver。
 */
export const parseVersionFromReadme = (readme?: string | null): NormalizedGitVersion | null => {
  if (readme == null) return null
  const text = String(readme)

  LABELED_VERSION_RXP.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LABELED_VERSION_RXP.exec(text)) != null) {
    const index = match.index + match[0].indexOf(match[1])
    if (isUrlContext(text, index)) continue
    const version = normalizeGitVersion(match[1])
    if (version) return version
  }

  const matches = collectVersionMatches(text)
  const prefixed = matches.find(item => item.hasPrefix && !item.inUrl)
  return prefixed?.version ?? null
}

/** 从 release 的 tag → name → body 依次尝试解析版本号 */
export const parseVersionFromRelease = (release?: Pick<GitRelease, 'tag' | 'name' | 'body'> | null): NormalizedGitVersion | null => {
  if (!release) return null
  return normalizeGitVersion(release.tag) ??
    normalizeGitVersion(release.name) ??
    normalizeGitVersion(release.body)
}

const compareSuffix = (a: string | null, b: string | null) => {
  if (a && b) {
    const aNum = parseInt(a, 10)
    const bNum = parseInt(b, 10)
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum === bNum ? 0 : aNum > bNum ? 1 : -1
    return a === b ? 0 : a > b ? 1 : -1
  }
  if (a) return 1
  if (b) return -1
  return 0
}

/**
 * 比较两个版本号大小。
 * a > b 返回 1，相等返回 0，a < b 返回 -1；null/空视为最小。
 * 三段数字相同时，带日期后缀的视为更新；都有后缀时按数值比较。
 */
export const compareGitVersion = (a?: string | null, b?: string | null): number => {
  const aParts = a ? parseGitVersionParts(a) : null
  const bParts = b ? parseGitVersionParts(b) : null
  if (!aParts && !bParts) return 0
  if (!aParts) return -1
  if (!bParts) return 1

  for (let i = 0; i < 3; i++) {
    if (aParts.parts[i] === bParts.parts[i]) continue
    return aParts.parts[i] > bParts.parts[i] ? 1 : -1
  }
  return compareSuffix(aParts.suffix, bParts.suffix)
}
