/** 一次最多允许替换的音源数量，避免异常仓库导入过多脚本 */
export const MAX_GIT_SOURCE_COUNT = 50

/** 单个音源脚本大小上限，与在线导入保持一致（9MB） */
export const MAX_SCRIPT_SIZE = 9_000_000

/** 单个 release 资源 / 压缩包大小上限 */
export const MAX_ASSET_SIZE = 30_000_000

/** release 资源 / 脚本内容下载超时（毫秒） */
export const REQUEST_TIMEOUT = 20_000

/** 仓库元数据请求超时（毫秒） */
export const META_REQUEST_TIMEOUT = 12_000

/** 通过文件列表扫描音源时，允许的最大 .js 文件数量，超过则要求仓库提供 README 链接或 release 资源 */
export const MAX_TREE_SCAN_FILES = 60

/** 仓库根目录下可作为音源清单的文件名（按优先级） */
export const MANIFEST_FILE_NAMES = [
  'source-list.json',
  'sources.json',
  'source_list.json',
  'lx-source-list.json',
  'music-source-list.json',
  'api.json',
] as const

/** README 候选文件名（不区分大小写） */
export const README_FILE_NAMES = ['readme.md', 'readme.txt', 'readme'] as const

/** GitHub 文件镜像前缀（按可用性排序），用于 api.github.com 不可达时的兜底 */
export const GITHUB_RAW_MIRRORS = [
  'https://fastly.jsdelivr.net/gh',
  'https://gcore.jsdelivr.net/gh',
  'https://cdn.jsdmirror.com/gh',
  'https://jsd.onmicrosoft.cn/gh',
] as const

/** jsDelivr 文件清单 API，用于 GitHub 兜底时枚举文件 */
export const JSDELIVR_DATA_API = 'https://data.jsdelivr.com/v1/packages/gh'

/** 用户输入中允许出现的排除路径（不参与树扫描） */
export const TREE_IGNORE_PATHS = [
  '.git/',
  'node_modules/',
  '.github/',
  'dist/',
] as const
