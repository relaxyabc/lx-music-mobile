/**
 * Git 音源仓库相关类型定义
 *
 * 该目录下的代码只负责「从 Git 仓库获取最新音源」的纯逻辑，
 * 与界面层解耦，方便在 Node 环境下单独测试。
 */

export type GitProviderId = 'github' | 'gitee' | 'gitlab' | 'gitea' | 'codeup'

/** 访问私有仓库/提高 API 限额时需要的认证信息 */
export interface GitRepoAuth {
  /** access token、personal access token 或密码 */
  token?: string
  /** 部分自建服务（Gitea 等）需要用户名配合密码/令牌做 Basic 认证 */
  username?: string
}

/** 解析后的仓库地址信息 */
export interface GitRepoRef {
  /** 规范化后的仓库浏览地址，不含账号密码，如 https://github.com/owner/repo */
  url: string
  provider: GitProviderId
  /** 主机名，可能包含端口，如 github.com、git.example.com:3000 */
  host: string
  owner: string
  repo: string
  /** 仓库命名空间路径，如 owner/repo，GitLab 可能为 group/subgroup/repo */
  repoPath: string
  /** API 根地址，如 https://api.github.com、https://gitee.com/api/v5 */
  apiBase: string
  /** 从原始地址 userinfo 中解析出的认证信息（如 https://user:token@host/owner/repo） */
  urlAuth?: {
    username?: string
    password?: string
  }
  /** 仓库地址使用的协议；已知 SaaS 服务固定为 https，自建服务保留用户输入的协议 */
  protocol?: 'http' | 'https'
}

export interface GitRepoInfo {
  ref: GitRepoRef
  defaultBranch: string
  /**
   * 用于判断仓库内容是否发生变化的标识。
   * 优先使用分支根 tree 的 sha（内容哈希），不支持时使用最新 commit sha。
   * 当只能通过镜像（jsDelivr 等）访问时，允许使用由文件列表计算的指纹，并带 `mirror:` 前缀。
   */
  headSha: string
  description: string
  homepage: string
}

export interface GitFileEntry {
  /** 仓库内相对路径，如 changqing/latest.js */
  path: string
  /** 文件大小（字节），未知时为 0 */
  size: number
}

export interface GitReleaseAsset {
  id: string
  name: string
  size: number
  /** 可直接使用提供方认证信息请求的下载地址 */
  downloadUrl: string
}

export interface GitRelease {
  tag: string
  name: string
  body: string
  publishedAt: string
  assets: GitReleaseAsset[]
}

/** 单个自定义源脚本 */
export interface GitSourceScript {
  /** 仓库内路径或 release 资源文件名，用于诊断与去重 */
  path: string
  /** 脚本文本内容 */
  script: string
}

export type GitBundleOrigin = 'release' | 'manifest' | 'readme' | 'tree'

/** 从仓库解析出的音源集合 */
export interface GitSourceBundle {
  /** 规范化后的版本号，如 V1.1.1-260108；无法确定时为 null */
  version: string | null
  /** 获取时仓库的 headSha，用于后续判断更新 */
  headSha: string
  repo: GitRepoInfo
  /** 音源列表来源 */
  origin: GitBundleOrigin
  sources: GitSourceScript[]
  /** 因为无效脚本或重名被忽略的候选文件数量 */
  skipped: number
}

/** 保存在本地的 Git 音源仓库配置 */
export interface GitSourceConfig {
  /** 规范化后的仓库地址 */
  url: string
  token: string
  username: string
  /** 上次导入时的仓库版本，可能为 null */
  version: string | null
  /** 上次导入时的仓库 headSha */
  headSha: string
  /** 上次导入的音源数量 */
  sourceCount: number
  /** 上次导入时间（毫秒时间戳） */
  updatedAt: number
  /** 上次自动检查更新的时间（毫秒时间戳） */
  lastCheckAt: number
}

/** 检查更新结果 */
export interface GitSourceCheckResult {
  /** 远端是否存在比本地更新的内容 */
  available: boolean
  /** 远端最新的版本号，可能为 null */
  version: string | null
  /** 远端当前的 headSha */
  headSha: string
  repo: GitRepoInfo
  /** 本地保存的版本号 */
  currentVersion: string | null
}

export interface GitProgress {
  stage: 'repo' | 'release' | 'files' | 'apply'
  current?: number
  total?: number
}

/** 替换本地全部自定义源的结果 */
export interface ReplaceResult {
  /** 被移除的旧音源数量 */
  removed: number
  /** 成功导入的新音源数量 */
  imported: number
  /** 导入失败的脚本 */
  failed: Array<{ path: string, message: string }>
}

/** 内部使用的 Git 服务提供方接口 */
export interface GitProvider {
  readonly id: GitProviderId
  getRepoInfo(ref: GitRepoRef, auth: GitRepoAuth): Promise<GitRepoInfo>
  getLatestRelease(ref: GitRepoRef, auth: GitRepoAuth): Promise<GitRelease | null>
  /** 递归列出分支下所有文件（只返回 blob） */
  listFiles(ref: GitRepoRef, auth: GitRepoAuth, branch: string): Promise<GitFileEntry[]>
  readFile(ref: GitRepoRef, auth: GitRepoAuth, path: string, branch: string): Promise<string>
  readReadme(ref: GitRepoRef, auth: GitRepoAuth, branch: string): Promise<{ path: string, content: string } | null>
  downloadReleaseAsset(ref: GitRepoRef, auth: GitRepoAuth, asset: GitReleaseAsset): Promise<string>
  /** 下载 release 资源的二进制内容（用于 zip 包）；未实现时调用方应退化为文本下载 */
  downloadReleaseAssetBinary?(ref: GitRepoRef, auth: GitRepoAuth, asset: GitReleaseAsset): Promise<Uint8Array>
}
