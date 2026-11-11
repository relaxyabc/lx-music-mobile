import { MAX_SCRIPT_SIZE } from './constants'
import type { GitSourceScript } from './types'
import { compareGitVersion } from './version'

/** 脚本必须以注释块开头 */
const COMMENT_BLOCK_RXP = /^\/\*[\S|\s]+?\*\//

const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const

export interface GitSourceScriptInfo {
  name: string
  version: string
  author: string
  description: string
  homepage: string
}

/** 去掉脚本开头的 BOM，避免注释块校验与导入失败 */
export const stripScriptBom = (script: string): string => {
  return script.charCodeAt(0) === 0xFEFF ? script.slice(1) : script
}

/** 提取脚本开头的注释块（与 src/utils/data.ts 的 addUserApi 校验规则保持一致） */
export const getScriptCommentBlock = (script: string): string | null => {
  if (typeof script !== 'string' || !script) return null
  return COMMENT_BLOCK_RXP.exec(stripScriptBom(script))?.[0] ?? null
}

/**
 * 解析脚本注释中的 @name/@version/@author/@description/@homepage。
 * 规则与 src/utils/data.ts 的 matchInfo 一致。
 */
export const parseScriptInfo = (script: string): GitSourceScriptInfo => {
  const block = getScriptCommentBlock(script) ?? script
  const infos: Record<keyof typeof INFO_NAMES, string> = {
    name: '',
    description: '',
    author: '',
    homepage: '',
    version: '',
  }
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  for (const line of block.split(/\r?\n/)) {
    const result = rxp.exec(line)
    if (!result) continue
    const key = result[1] as keyof typeof INFO_NAMES
    if (INFO_NAMES[key] == null) continue
    infos[key] = result[2].trim()
  }
  return infos
}

/** 判断一段文本是否是有效的洛雪自定义源脚本 */
export const isUserApiScript = (script: unknown): boolean => {
  if (typeof script !== 'string' || !script) return false
  const block = getScriptCommentBlock(script)
  if (!block) return false
  return parseScriptInfo(block).name.length > 0
}

export interface NormalizeSourcesResult {
  sources: GitSourceScript[]
  /** 因为无效脚本或同名重复被忽略的候选文件数量 */
  skipped: number
}

interface Candidate {
  source: GitSourceScript
  version: string
  order: number
}

const isBetterCandidate = (next: Candidate, current: Candidate): boolean => {
  const result = compareGitVersion(next.version, current.version)
  if (result !== 0) return result > 0

  const nextLatest = /latest\.js$/i.test(next.source.path)
  const currentLatest = /latest\.js$/i.test(current.source.path)
  if (nextLatest !== currentLatest) return nextLatest

  if (next.source.path.length !== current.source.path.length) {
    return next.source.path.length < current.source.path.length
  }
  return next.source.path < current.source.path
}

/**
 * 过滤无效脚本，并按 `@name` 去重：
 * 同名时保留 @version 更高的；版本相同优先 `latest.js`，再优先更短路径，最后按字典序。
 * 结果超过 max 时抛错。
 */
export const normalizeSources = (candidates: GitSourceScript[], max: number): NormalizeSourcesResult => {
  if (!(max > 0)) throw new Error('Invalid music source count limit')

  const sourceMap = new Map<string, Candidate>()
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    if (!candidate || typeof candidate.script !== 'string') continue
    if (!candidate.script || candidate.script.length > MAX_SCRIPT_SIZE) continue
    if (!isUserApiScript(candidate.script)) continue

    const info = parseScriptInfo(candidate.script)
    if (!info.name) continue

    const item: Candidate = {
      source: {
        path: candidate.path,
        script: stripScriptBom(candidate.script),
      },
      version: info.version,
      order: index,
    }
    const current = sourceMap.get(info.name)
    if (!current) {
      sourceMap.set(info.name, item)
      continue
    }
    if (isBetterCandidate(item, current)) sourceMap.set(info.name, item)
  }

  const sources = [...sourceMap.values()]
    .sort((a, b) => a.order - b.order)
    .map(item => item.source)

  if (sources.length > max) {
    throw new Error(`Too many music source scripts (${sources.length} > ${max})`)
  }

  return {
    sources,
    skipped: candidates.length - sources.length,
  }
}
