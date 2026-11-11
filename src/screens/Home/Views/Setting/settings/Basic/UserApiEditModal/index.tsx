import { useRef, useImperativeHandle, forwardRef, useState, useEffect, useCallback } from 'react'
import Text from '@/components/common/Text'
import { View, TouchableOpacity } from 'react-native'
import { confirmDialog, createStyle, openUrl, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import Dialog, { type DialogType } from '@/components/common/Dialog'
import Button from '@/components/common/Button'
import List from './List'
import ImportBtn from './ImportBtn'
import {
  checkGitSourceUpdate,
  getGitSourceConfig,
  saveGitSourceConfig,
  type GitSourceConfig,
} from '@/core/gitSource'
import {
  applyGitBundle,
  fetchGitBundle,
  formatGitSourceVersion,
  getGitRepoDisplayName,
} from './gitSource'

// interface UrlInputType {
//   setText: (text: string) => void
//   getText: () => string
//   focus: () => void
// }
// const UrlInput = forwardRef<UrlInputType, {}>((props, ref) => {
//   const theme = useTheme()
//   const t = useI18n()
//   const [text, setText] = useState('')
//   const inputRef = useRef<InputType>(null)
//   const [height, setHeight] = useState(100)

//   useImperativeHandle(ref, () => ({
//     getText() {
//       return text.trim()
//     },
//     setText(text) {
//       setText(text)
//     },
//     focus() {
//       inputRef.current?.focus()
//     },
//   }))

//   const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
//     setHeight(nativeEvent.layout.height)
//   }, [])

//   return (
//     <View style={styles.inputContent} onLayout={handleLayout}>
//       <Input
//         ref={inputRef}
//         value={text}
//         onChangeText={setText}
//         textAlignVertical="top"
//         placeholder={t('setting_dislike_list_input_tip')}
//         size={12}
//         style={{ ...styles.input, height, backgroundColor: theme['c-primary-input-background'] }}
//       />
//     </View>
//   )
// })


// export interface UserApiEditModalProps {
//   onSave: (rules: string) => void
//   // onSourceChange: SourceSelectorProps['onSourceChange']
// }
export interface UserApiEditModalType {
  show: () => void
}

// 自动检查更新的时间间隔，避免频繁请求仓库接口
const AUTO_CHECK_INTERVAL = 60 * 60 * 1000

export default forwardRef<UserApiEditModalType, {}>((props, ref) => {
  const dialogRef = useRef<DialogType>(null)
  // const sourceSelectorRef = useRef<SourceSelectorType>(null)
  // const inputRef = useRef<UrlInputType>(null)
  const [visible, setVisible] = useState(false)
  const [gitConfig, setGitConfig] = useState<GitSourceConfig | null>(null)
  const [gitChecking, setGitChecking] = useState(false)
  const [gitStatus, setGitStatus] = useState('')
  const autoCheckedRef = useRef(false)
  const checkingRef = useRef(false)
  const theme = useTheme()
  const t = useI18n()

  const refreshGitConfig = useCallback(async() => {
    setGitConfig(await getGitSourceConfig())
  }, [])

  const doCheckGitSource = useCallback(async(manual: boolean) => {
    if (checkingRef.current) return
    checkingRef.current = true
    setGitChecking(true)
    try {
      const config = await getGitSourceConfig()
      if (!config) return
      const auth = config.token ? { token: config.token, username: config.username || undefined } : undefined
      if (manual) setGitStatus(t('git_source_loading_repo'))
      const result = await checkGitSourceUpdate(config, { auth })
      await saveGitSourceConfig({ ...config, lastCheckAt: Date.now() })
      if (!result.available) {
        if (manual) toast(t('git_source_latest_tip', { version: formatGitSourceVersion(result.version ?? config.version) }))
        return
      }
      setGitStatus('')
      const confirm = await confirmDialog({
        message: t('git_source_new_version_confirm', {
          version: formatGitSourceVersion(result.version ?? config.version),
          current: formatGitSourceVersion(config.version),
        }),
        cancelButtonText: global.i18n.t('cancel_button_text_2'),
        confirmButtonText: global.i18n.t('confirm_button_text'),
        bgClose: false,
      })
      if (!confirm) return
      const bundle = await fetchGitBundle({
        url: config.url,
        token: config.token,
        onProgress: setGitStatus,
      })
      if (!bundle.sources.length) throw new Error(t('git_source_no_source'))
      const applyResult = await applyGitBundle(bundle, {
        url: config.url,
        token: config.token,
        remember: true,
        onProgress: setGitStatus,
      })
      toast(t('git_source_update_success', {
        count: applyResult.imported,
        version: formatGitSourceVersion(bundle.version),
      }), 'long')
      await refreshGitConfig()
    } catch (err: any) {
      if (manual) toast(t('git_source_update_failed', { message: err?.message ?? '' }), 'long')
    } finally {
      checkingRef.current = false
      setGitChecking(false)
      setGitStatus('')
    }
  }, [t, refreshGitConfig])

  const handleUnlinkGitSource = useCallback(async() => {
    const confirm = await confirmDialog({
      message: t('git_source_unlink_confirm'),
      cancelButtonText: global.i18n.t('cancel_button_text_2'),
      confirmButtonText: global.i18n.t('confirm_button_text'),
      bgClose: false,
    })
    if (!confirm) return
    await saveGitSourceConfig(null)
    setGitConfig(null)
  }, [t])

  const handleShow = () => {
    dialogRef.current?.setVisible(true)
    setGitStatus('')
    void refreshGitConfig()
    // requestAnimationFrame(() => {
    // inputRef.current?.setText('')
    // sourceSelectorRef.current?.setSource(source)
    // setTimeout(() => {
    //   inputRef.current?.focus()
    // }, 300)
    // })
  }
  useImperativeHandle(ref, () => ({
    show() {
      if (visible) handleShow()
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShow()
        })
      }
    },
  }))

  useEffect(() => {
    if (visible) {
      void refreshGitConfig()
    } else {
      autoCheckedRef.current = false
      setGitConfig(null)
    }
  }, [visible, refreshGitConfig])

  const handleDialogHide = useCallback(() => {
    // 每次关闭后允许下次打开时再自动检查一次
    autoCheckedRef.current = false
  }, [])

  // 打开自定义源管理时，静默检查一次 Git 音源仓库是否有更新
  useEffect(() => {
    if (!visible || !gitConfig || autoCheckedRef.current) return
    autoCheckedRef.current = true
    if (Date.now() - gitConfig.lastCheckAt < AUTO_CHECK_INTERVAL) return
    void doCheckGitSource(false)
  }, [visible, gitConfig, doCheckGitSource])

  const handleCancel = () => {
    dialogRef.current?.setVisible(false)
  }

  const openFAQPage = () => {
    void openUrl('https://lyswhut.github.io/lx-music-doc/mobile/custom-source')
  }

  return (
    visible
      ? (
          <Dialog ref={dialogRef} bgHide={false} onHide={handleDialogHide}>
            <View style={styles.content}>
              {/* <UrlInput ref={inputRef} /> */}
              <Text size={16} style={styles.title}>{t('user_api_title')}</Text>
              <List />
              {
                gitConfig
                  ? (
                      <View style={styles.gitSource}>
                        <View style={styles.gitSourceInfo}>
                          <Text size={12} color={theme['c-font-label']} numberOfLines={1}>
                            {t('git_source_current', {
                              repo: getGitRepoDisplayName(gitConfig.url),
                              version: formatGitSourceVersion(gitConfig.version),
                            })}
                          </Text>
                          {gitStatus ? <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{gitStatus}</Text> : null}
                        </View>
                        <TouchableOpacity disabled={gitChecking} onPress={() => { void doCheckGitSource(true) }}>
                          <Text size={12} color={theme['c-primary-font']}>
                            {gitChecking ? t('git_source_checking') : t('git_source_check_update')}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity disabled={gitChecking} style={styles.gitSourceUnlink} onPress={() => { void handleUnlinkGitSource() }}>
                          <Text size={12} color={theme['c-primary-font']}>{t('git_source_unlink')}</Text>
                        </TouchableOpacity>
                      </View>
                    )
                  : null
              }
              <View style={styles.tips}>
                <Text style={styles.tipsText} size={12}>
                  {t('user_api_readme')}
                </Text>
                <TouchableOpacity onPress={openFAQPage}>
                  <Text style={{ ...styles.tipsText, textDecorationLine: 'underline' }} size={12} color={theme['c-primary-font']}>FAQ</Text>
                </TouchableOpacity>
                <View>
                  <Text style={styles.tipsText} size={12}>{t('user_api_note')}</Text>
                </View>
              </View>
            </View>
            <View style={styles.btns}>
              <Button style={{ ...styles.btn, backgroundColor: theme['c-button-background'] }} onPress={handleCancel}>
                <Text size={14} color={theme['c-button-font']}>{t('close')}</Text>
              </Button>
              <ImportBtn btnStyle={{ ...styles.btn, backgroundColor: theme['c-button-background'] }} onGitSourceChanged={refreshGitConfig} />
            </View>
          </Dialog>
        ) : null
  )
})


const styles = createStyle({
  content: {
    // flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingTop: 15,
    paddingBottom: 10,
    flexDirection: 'column',
  },
  title: {
    marginBottom: 15,
    textAlign: 'center',
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  gitSource: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    marginTop: 10,
  },
  gitSourceInfo: {
    flexGrow: 1,
    flexShrink: 1,
    marginRight: 10,
  },
  gitSourceUnlink: {
    marginLeft: 12,
  },
  tips: {
    paddingHorizontal: 7,
    marginTop: 15,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tipsText: {
    marginTop: 8,
    textAlignVertical: 'bottom',
    // lineHeight: 18,
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  btns: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingBottom: 15,
    paddingLeft: 15,
    // paddingRight: 15,
  },
  btn: {
    flex: 1,
    padding: 10,
    alignItems: 'center',
    borderRadius: 4,
    marginRight: 15,
  },
})
