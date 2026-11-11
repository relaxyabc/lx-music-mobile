import { useMemo, useRef } from 'react'

import DorpDownMenu, { type DorpDownMenuProps as _DorpDownMenuProps } from '@/components/common/DorpDownMenu'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import ScriptImportExport, { type ScriptImportExportType } from './ScriptImportExport'
import ScriptImportOnline, { type ScriptImportOnlineType } from './ScriptImportOnline'
import ScriptImportGit, { type ScriptImportGitType } from './ScriptImportGit'
import { state } from '@/store/userApi'
import { tipDialog } from '@/utils/tools'

import { useTheme } from '@/store/theme/hook'

interface BtnProps {
  btnStyle?: _DorpDownMenuProps<any[]>['btnStyle']
  onGitSourceChanged?: () => void
}


export default ({ btnStyle, onGitSourceChanged }: BtnProps) => {
  const t = useI18n()
  const theme = useTheme()
  const scriptImportExportRef = useRef<ScriptImportExportType>(null)
  const scriptImportOnlineRef = useRef<ScriptImportOnlineType>(null)
  const scriptImportGitRef = useRef<ScriptImportGitType>(null)

  const importTypes = useMemo(() => {
    return [
      { action: 'local', label: t('user_api_btn_import_local') },
      { action: 'online', label: t('user_api_btn_import_online') },
      { action: 'git', label: t('user_api_btn_import_git') },
    ] as const
  }, [t])

  type DorpDownMenuProps = _DorpDownMenuProps<typeof importTypes>

  const handleAction: DorpDownMenuProps['onPress'] = ({ action }) => {
    if (action != 'git' && state.list.length > 20) {
      void tipDialog({
        message: t('user_api_max_tip'),
        btnText: t('ok'),
      })
      return
    }

    switch (action) {
      case 'local':
        scriptImportExportRef.current?.import()
        break
      case 'online':
        scriptImportOnlineRef.current?.show()
        break
      case 'git':
        scriptImportGitRef.current?.show()
        break
    }
  }


  return (
    <DorpDownMenu
      btnStyle={btnStyle}
      menus={importTypes}
      center
      onPress={handleAction}
    >
      <Text size={14} color={theme['c-button-font']}>{t('user_api_btn_import')}</Text>
      <ScriptImportExport ref={scriptImportExportRef} />
      <ScriptImportOnline ref={scriptImportOnlineRef} />
      <ScriptImportGit ref={scriptImportGitRef} onChanged={onGitSourceChanged} />
    </DorpDownMenu>
  )
}
