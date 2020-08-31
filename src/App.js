// @flow
import React, { Fragment, memo, useCallback, useEffect, useState } from 'react'
import { Platform, SafeAreaView, StyleSheet } from 'react-native'
import { Provider as PaperProvider } from 'react-native-paper'
import { ActionSheetProvider } from '@expo/react-native-action-sheet'
import AsyncStorage from './lib/utils/asyncStorage'
import { isMobile } from './lib/utils/platform'
import './lib/gundb/gundb'
import { theme } from './components/theme/styles'
import SimpleStore, { initStore } from './lib/undux/SimpleStore'
import RouterSelector from './RouterSelector'
import LoadingIndicator from './components/common/view/LoadingIndicator'
import SplashDesktop from './components/splash/SplashDesktop'
import logger from './lib/logger/pino-logger'
import { SimpleStoreDialog } from './components/common/dialogs/CustomDialog'
import useServiceWorker from './lib/utils/useServiceWorker'
import Config from './config/config'
import { deleteGunDB } from './lib/hooks/useDeleteAccountDialog'

const log = logger.child({ from: 'App' })

const SplashOrRouter = memo(({ store }) => {
  const isLoggedIn = !!store.get('isLoggedIn')
  const [showDesktopSplash, setShowDesktopSplash] = useState(Config.showSplashDesktop && isLoggedIn === false)
  const dismissDesktopSplash = useCallback(() => setShowDesktopSplash(false), [setShowDesktopSplash])

  return !isMobile && showDesktopSplash ? (
    <SplashDesktop onContinue={dismissDesktopSplash} urlForQR={window.location.href} />
  ) : (
    <RouterSelector />
  )
})

const App = () => {
  const store = SimpleStore.useStore()

  useServiceWorker()
  useEffect(() => log.debug({ Config }), [])

  // onRecaptcha = (token: string) => {
  //   userStorage.setProfileField('recaptcha', token, 'private')
  // }

  const AppWrapper = isMobile ? Fragment : SafeAreaView

  return (
    <PaperProvider theme={theme}>
      <AppWrapper style={styles.safeAreaView}>
        <Fragment>
          <SimpleStoreDialog />
          <LoadingIndicator />
          <SplashOrRouter store={store} />
        </Fragment>
      </AppWrapper>
    </PaperProvider>
  )
}

const styles = StyleSheet.create({
  safeAreaView: {
    flexGrow: 1,
  },
})

const AppHolder = () => {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    /**
     * decide if we need to clear storage
     */
    /**
     * decide if we need to clear storage
     */
    const upgradeVersion = async () => {
      const valid = ['etoro', 'phase0-a']
      const required = Config.isEToro ? 'etoro' : 'phase0-a'
      const version = await AsyncStorage.getItem('GD_version')
      if (version == null || valid.includes(version)) {
        return
      }
      const req = deleteGunDB()

      //remove all local data so its not cached and user will re-login
      await Promise.all([AsyncStorage.clear(), req.catch()])
      return AsyncStorage.setItem('GD_version', required)
    }

    ;(async () => {
      if (Platform.OS === 'web') {
        await upgradeVersion()
      }

      await initStore()
      setReady(true)
    })()
  }, [])

  if (!ready) {
    return null
  }

  return (
    <ActionSheetProvider>
      <SimpleStore.Container>
        <App />
      </SimpleStore.Container>
    </ActionSheetProvider>
  )
}

export default AppHolder
