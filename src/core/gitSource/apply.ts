import { setApiSource } from '@/core/apiSource'
import { importUserApi, removeUserApi } from '@/core/userApi'
import settingState from '@/store/setting/state'
import { state as userApiState } from '@/store/userApi/state'
import { getUserApiList, getUserApiScript } from '@/utils/data'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import type { GitProgress, GitSourceScript, ReplaceResult } from './types'

/** 用户自定义音源 id 的前缀 */
const USER_API_ID_RXP = /^user_api/

/**
 * 恢复音源选择：
 * 优先按原来的音源名称匹配新列表；原来选中的是用户自定义源时回退到内置源，最后回退到新列表第一个。
 */
const restoreActiveSource = (activeId: string, activeName: string, oldList: LX.UserApi.UserApiInfo[]) => {
  const newList = userApiState.list
  if (activeName) {
    const matched = newList.find(api => api.name === activeName)
    if (matched) {
      setApiSource(matched.id)
      return
    }
  }

  const activeWasUserApi = USER_API_ID_RXP.test(activeId) || oldList.some(api => api.id === activeId)
  if (!activeWasUserApi) return

  const builtin = apiSourceInfo.find(api => !api.disabled)
  if (builtin) {
    setApiSource(builtin.id)
    return
  }
  if (newList.length > 0) setApiSource(newList[0].id)
}

/**
 * 用给定的音源脚本替换本地全部自定义音源。
 *
 * 会先备份旧脚本（导入失败时尽力恢复），然后逐个导入新脚本并恢复原来的音源选择。
 */
export const replaceAllUserApis = async(
  sources: GitSourceScript[],
  onProgress?: (progress: GitProgress) => void,
): Promise<ReplaceResult> => {
  if (!Array.isArray(sources) || !sources.length) throw new Error('Failed to import any source script')

  const oldList = await getUserApiList()
  const activeId = settingState.setting['common.apiSource'] ?? ''
  const activeName = oldList.find(api => api.id === activeId)?.name ?? ''

  // 备份旧脚本，导入全部失败时恢复
  const backups: string[] = []
  for (const api of oldList) {
    const script = await getUserApiScript(api.id).catch(() => '')
    if (script) backups.push(script)
  }

  const removed = oldList.length
  if (removed > 0) await removeUserApi(oldList.map(api => api.id))

  const total = sources.length
  let completed = 0
  let imported = 0
  const failed: ReplaceResult['failed'] = []
  const report = () => {
    try {
      onProgress?.({ stage: 'apply', current: completed, total })
    } catch { /* 进度回调异常不影响主流程 */ }
  }

  report()
  for (const source of sources) {
    try {
      await importUserApi(source.script)
      imported++
    } catch (error: any) {
      failed.push({ path: source.path, message: error?.message ?? String(error) })
    }
    completed++
    report()
  }

  if (imported === 0) {
    // 尽力把旧音源恢复回去，避免用户自定义源全部丢失
    for (const script of backups) {
      await importUserApi(script).catch(() => { /* 忽略恢复失败 */ })
    }
    restoreActiveSource(activeId, activeName, oldList)
    throw new Error('Failed to import any source script')
  }

  restoreActiveSource(activeId, activeName, oldList)
  return { removed, imported, failed }
}
