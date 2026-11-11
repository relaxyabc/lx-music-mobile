import {
  fetchGitSourceBundle,
  getRepoLabel,
  parseGitRepoUrl,
  replaceAllUserApis,
  saveGitSourceConfig,
  type GitProgress,
  type GitSourceBundle,
  type ReplaceResult,
} from '@/core/gitSource'

export const formatGitSourceVersion = (version: string | null | undefined) => {
  return version || global.i18n.t('git_source_version_unknown')
}

export const getGitRepoDisplayName = (url: string) => {
  const ref = parseGitRepoUrl(url)
  return ref ? getRepoLabel(ref) : url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export const getGitProgressText = (progress: GitProgress) => {
  switch (progress.stage) {
    case 'repo':
      return global.i18n.t('git_source_loading_repo')
    case 'release':
      return global.i18n.t('git_source_loading_release')
    case 'files':
      return global.i18n.t('git_source_loading_files', { current: progress.current ?? 0, total: progress.total ?? 0 })
    case 'apply':
      return global.i18n.t('git_source_replacing', { current: progress.current ?? 0, total: progress.total ?? 0 })
    default:
      return ''
  }
}

export interface FetchGitBundleOptions {
  url: string
  token?: string
  onProgress?: (text: string) => void
}

export const fetchGitBundle = async({
  url,
  token,
  onProgress,
}: FetchGitBundleOptions): Promise<GitSourceBundle> => {
  return fetchGitSourceBundle(url, {
    auth: token ? { token } : undefined,
    onProgress: progress => { onProgress?.(getGitProgressText(progress)) },
  })
}

export interface ApplyGitBundleOptions {
  url: string
  token?: string
  remember: boolean
  onProgress?: (text: string) => void
}

export const applyGitBundle = async(bundle: GitSourceBundle, {
  url,
  token,
  remember,
  onProgress,
}: ApplyGitBundleOptions): Promise<ReplaceResult> => {
  const result = await replaceAllUserApis(bundle.sources, progress => {
    onProgress?.(getGitProgressText(progress))
  })
  if (remember) {
    const now = Date.now()
    await saveGitSourceConfig({
      // 保存用户输入的原始地址：其中可能携带认证信息（https://user:token@host/...），
      // 规范化后的 ref.url 会丢失这部分凭据
      url,
      token: token ?? '',
      username: '',
      version: bundle.version,
      headSha: bundle.headSha,
      sourceCount: result.imported,
      updatedAt: now,
      lastCheckAt: now,
    })
  } else {
    await saveGitSourceConfig(null)
  }
  return result
}
