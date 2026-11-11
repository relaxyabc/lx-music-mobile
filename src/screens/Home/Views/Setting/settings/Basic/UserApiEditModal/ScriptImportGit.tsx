import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import Text from '@/components/common/Text'
import Input from '@/components/common/Input'
import CheckBox from '@/components/common/CheckBox'
import { View } from 'react-native'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useUserApiList } from '@/store/userApi'
import { getGitSourceConfig, parseGitRepoUrl } from '@/core/gitSource'
import { applyGitBundle, fetchGitBundle, formatGitSourceVersion } from './gitSource'

export interface ScriptImportGitType {
  show: () => void
}

export interface ScriptImportGitProps {
  onChanged?: () => void
}

export default forwardRef<ScriptImportGitType, ScriptImportGitProps>(({ onChanged }, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const userApiList = useUserApiList()
  const alertRef = useRef<ConfirmAlertType>(null)
  const [visible, setVisible] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [token, setToken] = useState('')
  const [remember, setRemember] = useState(true)
  const [status, setStatus] = useState('')
  const [btn, setBtn] = useState({ disabled: false, text: '' })

  const resetBtn = useCallback(() => {
    setBtn({ disabled: false, text: t('user_api_btn_import_online_input_confirm') })
  }, [t])

  const handleShow = () => {
    alertRef.current?.setVisible(true)
    setStatus('')
    setRemember(true)
    resetBtn()
    setRepoUrl('')
    setToken('')
    void getGitSourceConfig().then(config => {
      if (!config) return
      setRepoUrl(config.url)
      setToken(config.token)
    })
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

  const handleImport = async() => {
    const url = repoUrl.trim()
    if (!url) return
    if (!parseGitRepoUrl(url)) {
      toast(t('git_source_invalid_url'), 'long')
      return
    }
    const tokenValue = token.trim()

    setBtn({ disabled: true, text: t('user_api_btn_import_online_input_loading') })
    setStatus(t('git_source_loading_repo'))

    let bundle
    try {
      bundle = await fetchGitBundle({ url, token: tokenValue, onProgress: setStatus })
    } catch (err: any) {
      resetBtn()
      setStatus('')
      toast(t('git_source_import_failed', { message: err?.message ?? '' }), 'long')
      return
    }

    if (!bundle.sources.length) {
      resetBtn()
      setStatus('')
      toast(t('git_source_no_source'), 'long')
      return
    }

    setStatus('')
    resetBtn()
    const version = formatGitSourceVersion(bundle.version)
    const confirm = await confirmDialog({
      message: t('git_source_import_confirm', {
        old: userApiList.length,
        new: bundle.sources.length,
        version,
      }),
      cancelButtonText: global.i18n.t('cancel_button_text_2'),
      confirmButtonText: global.i18n.t('confirm_button_text'),
      bgClose: false,
    })
    if (!confirm) return

    setBtn({ disabled: true, text: t('user_api_btn_import_online_input_loading') })
    setStatus(t('git_source_replacing', { current: 0, total: bundle.sources.length }))
    try {
      const result = await applyGitBundle(bundle, {
        url,
        token: tokenValue,
        remember,
        onProgress: setStatus,
      })
      if (result.failed.length) {
        toast(t('git_source_import_partial', {
          count: result.imported,
          failed: result.failed.length,
          version,
        }), 'long')
      } else {
        toast(t('git_source_import_success', { count: result.imported, version }), 'long')
      }
      alertRef.current?.setVisible(false)
      onChanged?.()
    } catch (err: any) {
      toast(t('git_source_import_failed', { message: err?.message ?? '' }), 'long')
    } finally {
      resetBtn()
      setStatus('')
    }
  }

  return (
    visible
      ? <ConfirmAlert
          ref={alertRef}
          onConfirm={handleImport}
          onHide={() => { setStatus('') }}
          disabledConfirm={btn.disabled}
          confirmText={btn.text || t('user_api_btn_import_online_input_confirm')}
        >
          <View style={styles.content}>
            <Text style={styles.title}>{t('git_source_title')}</Text>
            <Input
              value={repoUrl}
              onChangeText={setRepoUrl}
              placeholder={t('git_source_input_tip')}
              style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
            />
            <Input
              value={token}
              onChangeText={setToken}
              placeholder={t('git_source_token_tip')}
              secureTextEntry
              style={{ ...styles.input, marginTop: 10, backgroundColor: theme['c-primary-input-background'] }}
            />
            <View style={styles.checkBox}>
              <CheckBox
                check={remember}
                label={t('git_source_remember')}
                onChange={setRemember}
                marginBottom={5}
                size={0.86}
              />
            </View>
            {status ? <Text size={12} color={theme['c-font-label']} style={styles.status}>{status}</Text> : null}
            <Text size={11} color={theme['c-font-label']} style={styles.note}>{t('git_source_note')}</Text>
          </View>
        </ConfirmAlert>
      : null
  )
})

const styles = createStyle({
  content: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
    paddingBottom: 5,
  },
  title: {
    marginBottom: 10,
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 290,
    borderRadius: 4,
  },
  checkBox: {
    marginTop: 10,
  },
  status: {
    marginTop: 8,
  },
  note: {
    marginTop: 8,
  },
})
