import type { GitProvider, GitProviderId } from '../types'
import { githubProvider } from './github'
import { giteeProvider } from './gitee'
import { gitlabProvider } from './gitlab'
import { giteaProvider } from './gitea'
import { codeupProvider } from './codeup'
import { clearProviderCache } from './common'

const providers: Record<GitProviderId, GitProvider> = {
  github: githubProvider,
  gitee: giteeProvider,
  gitlab: gitlabProvider,
  gitea: giteaProvider,
  codeup: codeupProvider,
}

/** 根据仓库提供方获取实现 */
export const getProvider = (id: GitProviderId): GitProvider => providers[id]

export {
  githubProvider,
  giteeProvider,
  gitlabProvider,
  giteaProvider,
  codeupProvider,
  clearProviderCache,
}
