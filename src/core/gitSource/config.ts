import {
  getGitSourceConfig as getStoredGitSourceConfig,
  saveGitSourceConfig as saveStoredGitSourceConfig,
} from '@/utils/data'
import type { GitSourceConfig } from './types'

/** 读取本地保存的 Git 音源仓库配置 */
export const getGitSourceConfig = async(): Promise<GitSourceConfig | null> => {
  return await getStoredGitSourceConfig()
}

/** 保存 Git 音源仓库配置（传 null 时清除） */
export const saveGitSourceConfig = async(config: GitSourceConfig | null) => {
  await saveStoredGitSourceConfig(config)
}
