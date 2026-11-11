/**
 * Git 音源仓库
 *
 * 功能：从用户提供的 Git 仓库地址自动获取最新音源脚本，并用它替换本地全部自定义源。
 *
 * 支持的服务提供方：GitHub、Gitee、GitLab、Gitea（含 Forgejo 等兼容服务、自建服务）。
 * 支持带认证（access token）访问私有仓库。
 * 版本号解析支持 release tag/name/body 与 README，格式为 `V1.1.1-yyyydd`（日期后缀可省略）。
 *
 * 该目录下的 `url/version/request/zip/providers/manifest/bundle` 均为与 React Native
 * 无关的纯逻辑，可在 Node 环境下直接测试；只有 `config/apply` 依赖应用本地存储与自定义源模块。
 */
import { MAX_GIT_SOURCE_COUNT } from './constants'

export * from './types'
export { parseGitRepoUrl, getRepoLabel } from './url'
export { normalizeGitVersion, compareGitVersion } from './version'
export { fetchGitSourceBundle, checkGitSourceUpdate } from './bundle'
export { getGitSourceConfig, saveGitSourceConfig } from './config'
export { replaceAllUserApis } from './apply'

export { MAX_GIT_SOURCE_COUNT }
