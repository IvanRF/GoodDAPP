// @flow
import React, { useCallback, useEffect, useState } from 'react'
import { Platform, ScrollView, StyleSheet, View } from 'react-native'
import { createSwitchNavigator } from '@react-navigation/core'
import { assign, get, isError, pickBy, toPairs } from 'lodash'
import { defer, from as fromPromise } from 'rxjs'
import { retry } from 'rxjs/operators'
import moment from 'moment'
import AsyncStorage from '../../lib/utils/asyncStorage'
import { isMobileSafari } from '../../lib/utils/platform'
import restart from '../../lib/utils/restart'

import {
  DESTINATION_PATH,
  GD_INITIAL_REG_METHOD,
  GD_USER_MNEMONIC,
  IS_LOGGED_IN,
} from '../../lib/constants/localStorage'

import { REGISTRATION_METHOD_SELF_CUSTODY, REGISTRATION_METHOD_TORUS } from '../../lib/constants/login'
import NavBar from '../appNavigation/NavBar'
import { navigationConfig } from '../appNavigation/navigationConfig'
import logger from '../../lib/logger/pino-logger'
import { decorate, ExceptionCode } from '../../lib/logger/exceptions'
import API, { getErrorMessage } from '../../lib/API/api'
import SimpleStore from '../../lib/undux/SimpleStore'
import { useDialog } from '../../lib/undux/utils/dialog'
import BackButtonHandler from '../../lib/utils/handleBackButton'
import retryImport from '../../lib/utils/retryImport'
import { showSupportDialog } from '../common/dialogs/showSupportDialog'
import { getUserModel, type UserModel } from '../../lib/gundb/UserModel'
import Config from '../../config/config'
import { fireEvent, identifyOnUserSignup, identifyWith } from '../../lib/analytics/analytics'
import { parsePaymentLinkParams } from '../../lib/share'
import { userExists } from '../../lib/login/userExists'
import { useAlreadySignedUp } from '../auth/torus/AuthTorus'
import type { SMSRecord } from './SmsForm'
import SignupCompleted from './SignupCompleted'
import EmailConfirmation from './EmailConfirmation'
import SmsForm from './SmsForm'
import PhoneForm from './PhoneForm'
import EmailForm from './EmailForm'
import NameForm from './NameForm'

// import MagicLinkInfo from './MagicLinkInfo'
const log = logger.child({ from: 'SignupState' })

export type SignupState = UserModel & SMSRecord & { invite_code?: string }

type Ready = Promise<{ goodWallet: any, userStorage: any }>

const routes = {
  Name: NameForm,
  Phone: PhoneForm,
  SMS: SmsForm,
  Email: EmailForm,
  EmailConfirmation,
  SignupCompleted,
}

// if (Config.enableSelfCustody) {
//   Object.assign(routes, { MagicLinkInfo })
// }

const SignupWizardNavigator = createSwitchNavigator(routes, navigationConfig)

const Signup = ({ navigation }: { navigation: any, screenProps: any }) => {
  const store = SimpleStore.useStore()
  const showAlreadySignedUp = useAlreadySignedUp()

  const torusUserFromProps =
    get(navigation, 'state.params.torusUser') ||
    get(navigation.state.routes.find(route => get(route, 'params.torusUser')), 'params.torusUser', {})
  const _regMethod =
    get(navigation, 'state.params.regMethod') ||
    get(navigation.state.routes.find(route => get(route, 'params.regMethod')), 'params.regMethod', undefined)
  const _torusProvider =
    get(navigation, 'state.params.torusProvider') ||
    get(navigation.state.routes.find(route => get(route, 'params.torusProvider')), 'params.torusProvider', undefined)

  const [regMethod] = useState(_regMethod)
  const [torusProvider] = useState(_torusProvider)
  const [torusUser] = useState(torusUserFromProps)
  const isRegMethodSelfCustody = regMethod === REGISTRATION_METHOD_SELF_CUSTODY
  const skipEmail = !!torusUserFromProps.email
  const skipMobile = !!torusUserFromProps.mobile || Config.skipMobileVerification

  const requiredFields = ['fullName', 'email']
  if (Config.skipMobileVerification === false) {
    requiredFields.push('mobile')
  }

  const initialState: SignupState = {
    ...getUserModel({
      email: torusUserFromProps.email || '',
      fullName: torusUserFromProps.name || '',
      mobile: torusUserFromProps.mobile || '',
    }),
    smsValidated: false,
    isEmailConfirmed: skipEmail,
    skipEmail: skipEmail,
    skipPhone: skipMobile,
    skipSMS: skipMobile,
    skipEmailConfirmation: Config.skipEmailVerification || skipEmail,
    skipMagicLinkInfo: true, //isRegMethodSelfCustody === false,
  }

  const [unrecoverableError, setUnrecoverableError] = useState(null)
  const [ready, setReady]: [Ready, ((Ready => Ready) | Ready) => void] = useState()
  const [state, setState] = useState(initialState)
  const [loading, setLoading] = useState(false)
  const [countryCode, setCountryCode] = useState(undefined)
  const [createError, setCreateError] = useState(false)
  const [showNavBarGoBackButton, setShowNavBarGoBackButton] = useState(true)
  const [finishedPromise, setFinishedPromise] = useState(undefined)
  const [title, setTitle] = useState('Sign Up')
  const [, hideDialog, showErrorDialog] = useDialog()
  const shouldGrow = store.get && !store.get('isMobileSafariKeyboardShown')

  const navigateWithFocus = (routeKey: string) => {
    navigation.navigate(routeKey)
    setLoading(false)

    if (Platform.OS === 'web' && (isMobileSafari || routeKey === 'Phone')) {
      setTimeout(() => {
        const el = document.getElementById(routeKey + '_input')
        if (el) {
          el.focus()
        }
      }, 300)
    }
  }

  const fireSignupEvent = (event?: string, data) => {
    let curRoute = navigation.state.routes[navigation.state.index]

    fireEvent(`SIGNUP_${event || curRoute.key}`, data)
  }

  const getCountryCode = async () => {
    try {
      const { data } = await API.getLocation()
      data && setCountryCode(data.country)
    } catch (e) {
      log.error('Could not get user location', e.message, e)
    }
  }

  //keep privatekey from torus as master seed before initializing wallet
  //so wallet can use it, if torus is enabled and we dont have pkey then require re-login
  //this is true in case of refresh
  const checkTorusLogin = () => {
    const masterSeed = torusUserFromProps.privateKey
    if (regMethod === REGISTRATION_METHOD_TORUS && masterSeed === undefined) {
      log.debug('torus user information missing', { torusUserFromProps })
      return navigation.navigate('Auth')
    }
    return !!masterSeed
  }

  const verifyStartRoute = () => {
    //we dont support refresh if regMethod param is missing then go back to Auth
    //if regmethod is missing it means user did refresh on later steps then first 1
    if (!regMethod || (navigation.state.index > 0 && state.lastStep !== navigation.state.index)) {
      log.debug('redirecting to start, got index:', navigation.state.index, { regMethod, torusUserFromProps })
      return navigation.navigate('Auth')
    }

    // if we have name from torus we skip to phone
    if (state.fullName) {
      //if skipping phone is enabled
      if (skipMobile) {
        return navigation.navigate('SignupCompleted')
      }

      return navigation.navigate('Phone')
    }
  }

  /**
   * check if user arrived with invite code
   */
  const checkInviteCode = async () => {
    const destinationPath = await AsyncStorage.getItem(DESTINATION_PATH)
    const params = get(destinationPath, 'params')
    const paymentParams = params && parsePaymentLinkParams(params)

    //get inviteCode from url or from payment link
    return get(destinationPath, 'params.inviteCode') || get(paymentParams, 'inviteCode')
  }

  useEffect(() => {
    const onMount = async () => {
      //if email from torus then identify user
      state.email && identifyOnUserSignup(state.email)

      //lazy login in background while user starts registration
      const ready = (async () => {
        log.debug('ready: Starting initialization', { isRegMethodSelfCustody, torusUserFromProps })

        const { init } = await retryImport(() => import('../../init'))
        const { goodWallet, userStorage, source } = await init().catch(exception => {
          const { message } = exception

          // we've already awaited for userStorage.ready in init()
          // so here we just handling init exception

          // if initialization failed, logging exception
          log.error('failed initializing UserStorage', message, exception, { dialogShown: true })

          // and setting unrecoverable error in the state to trigger show "reload app" dialog
          setUnrecoverableError(exception)

          // re-throw exception
          throw exception
        })

        identifyWith(null, goodWallet.getAccountForType('login'))
        fireSignupEvent('STARTED', { source })

        // for QA
        global.wallet = goodWallet

        const apiReady = async () => {
          await API.ready
          log.debug('ready: signupstate ready')

          return { goodWallet, userStorage }
        }

        if (torusUserFromProps.privateKey) {
          log.debug('skipping ready initialization (already done in AuthTorus)')

          // now that we are loggedin, reload api with JWT
          return apiReady()
        }

        const login = retryImport(() => import('../../lib/login/GoodWalletLogin'))

        // the login also re-initialize the api with new jwt
        await login
          .then(l => l.default.auth())
          .catch(e => {
            log.error('failed auth:', e.message, e)

            // showErrorDialog('Failed authenticating with server', e)
          })

        return apiReady()
      })()

      setReady(ready)

      //get user country code for phone
      //read torus seed
      if (state.skipPhone === false) {
        await getCountryCode()
      }

      checkTorusLogin()

      verifyStartRoute()
    }

    onMount()
  }, [])

  // listening to the unrecoverable exception could happened if user storage fails to init
  useEffect(() => {
    if (!unrecoverableError) {
      return
    }

    // eslint-disable-next-line no-restricted-globals
    showErrorDialog('Wallet could not be loaded. Please refresh.', '', { onDismiss: restart })
  }, [unrecoverableError])

  // listening to the email changes in the state
  useEffect(() => {
    const { email } = state

    // perform this again for torus and on email change. torus has also mobile verification that doesnt set email
    if (!email) {
      return
    }

    // once email appears in the state - identifying and setting 'identified' flag
    identifyOnUserSignup(email)

    //if we are not skipping email confirmation, then the call to send confirmation email will add user to mautic
    //otherwise calling also addSignupContact can lead to duplicate mautic contact
    if (state.skipEmailConfirmation === false) {
      return
    }

    API.addSignupContact(state)
      .then(r => log.info('addSignupContact success', { state }))
      .catch(e => log.error('addSignupContact failed', e.message, e))
  }, [state.email])

  const finishRegistration = async () => {
    setCreateError(false)
    setLoading(true)

    log.info('Sending new user data', { state, regMethod, torusProvider })
    const { skipEmail, skipEmailConfirmation, skipMagicLinkInfo, ...requestPayload } = state
    try {
      const { goodWallet, userStorage } = await ready
      const inviteCode = await checkInviteCode()

      log.debug('invite code:', { inviteCode })

      requiredFields.forEach(field => {
        if (!requestPayload[field]) {
          const fieldNames = { email: 'Email', fullName: 'Name', mobile: 'Mobile' }

          throw new Error(`Seems like you didn't fill your ${fieldNames[field]}`)
        }
      })

      if (inviteCode) {
        requestPayload.inviteCode = inviteCode
      }

      requestPayload.regMethod = regMethod

      const [mnemonic] = await Promise.all([
        AsyncStorage.getItem(GD_USER_MNEMONIC).then(_ => _ || ''),

        //make sure profile is initialized, maybe solve gun bug where profile is undefined
        userStorage.profile.putAck({ initialized: true }).catch(e => {
          log.error('set profile initialized failed:', e.message, e)
          throw e
        }),

        // Stores creationBlock number into 'lastBlock' feed's node
        userStorage.saveJoinedBlockNumber(),
        userStorage.userProperties.updateAll({ regMethod, inviterInviteCode: inviteCode }),
      ])

      // trying to update profile 2 times, if failed anyway - re-throwing exception
      await defer(() =>
        fromPromise(
          userStorage.setProfile({
            ...requestPayload,
            walletAddress: goodWallet.account,
            mnemonic,
          }),
        ),
      )
        .pipe(retry(1))
        .toPromise()

      let newUserData

      if (regMethod === REGISTRATION_METHOD_TORUS) {
        const { mobile, email, privateKey, accessToken, idToken } = torusUser

        // create proof that email/mobile is the same one verified by torus
        assign(requestPayload, {
          torusProvider,
          torusAccessToken: accessToken,
          torusIdToken: idToken,
        })

        if (torusProvider !== 'facebook') {
          // if logged in via other provider that facebook - generating & signing proof
          const torusProofNonce = await API.ping()
            .then(_ => moment(get(_, 'data.ping', Date.now())))
            .catch(e => moment())
            .then(_ => Math.max(Date.now(), _.valueOf()))
          const msg = (mobile || email) + String(torusProofNonce)
          const proof = goodWallet.wallet.eth.accounts.sign(msg, '0x' + privateKey)

          assign(requestPayload, {
            torusProof: proof.signature,
            torusProofNonce,
          })
        }
      }

      await API.addUser(requestPayload)
        .then(({ data }) => (newUserData = data))
        .catch(e => {
          const message = getErrorMessage(e)
          const exception = new Error(message)

          // if user already exists just log.warn then continue signup
          if ('You cannot create more than 1 account with the same credentials' === message) {
            log.warn('User already exists during addUser() call:', message, exception)
          } else {
            // otherwise:
            // completing exception with response object received from axios
            if (!isError(e)) {
              exception.response = e
            }

            // re-throwing exception to be catched in the parent try {}
            throw exception
          }
        })

      //set tokens for other services returned from backedn
      await Promise.all(
        toPairs(pickBy(newUserData, (_, field) => field.endsWith('Token'))).map(([fieldName, fieldValue]) =>
          userStorage.setProfileField(fieldName, fieldValue, 'private'),
        ),
      )

      await Promise.all([
        userStorage.gunuser
          .get('registered')
          .putAck(true)
          .catch(e => {
            log.error('set user registered failed:', e.message, e)
            throw e
          }),

        userStorage.userProperties.set('registered', true),

        AsyncStorage.setItem(IS_LOGGED_IN, true),
        AsyncStorage.removeItem(GD_INITIAL_REG_METHOD),
      ])

      fireSignupEvent('SUCCESS')

      log.debug('New user created')
      setLoading(false)

      return true
    } catch (exception) {
      const { message } = exception
      const uiMessage = decorate(exception, ExceptionCode.E8)

      log.error('New user failure', message, exception, {
        dialogShown: true,
        requestPayload,
      })

      showSupportDialog(showErrorDialog, hideDialog, navigation.navigate, uiMessage)
      setCreateError(true)
      return false
    } finally {
      setLoading(false)
    }
  }

  const waitForRegistrationToFinish = async () => {
    try {
      let ok
      if (createError) {
        ok = await finishRegistration()
      } else {
        ok = await finishedPromise
      }
      log.debug('user registration synced and completed', { ok })
      return ok
    } catch (e) {
      log.error('waiting for user registration failed', e.message, e)
      return false
    } finally {
      setLoading(false)
    }
  }

  function getNextRoute(routes, routeIndex, state) {
    let nextRoute = routes[routeIndex + 1]

    if (state[`skip${nextRoute && nextRoute.key}`]) {
      return getNextRoute(routes, routeIndex + 1, state)
    }

    return nextRoute
  }

  function getPrevRoute(routes, routeIndex, state) {
    let prevRoute = routes[routeIndex - 1]

    if (state[`skip${prevRoute && prevRoute.key}`]) {
      return getPrevRoute(routes, routeIndex - 1, state)
    }

    return prevRoute
  }

  //check if email/mobile was used to register before and offer user to login instead
  const checkExisting = useCallback(
    async searchBy => {
      const existsResult = await userExists(searchBy).catch(e => {
        log.warn('userExists check failed:', e.message, e)
        return { exists: false }
      })

      log.debug('checking userAlreadyExist', { existsResult })

      let selection = 'signup'

      if (existsResult.exists) {
        selection = await showAlreadySignedUp(torusProvider, existsResult, searchBy.email ? 'email' : 'mobile')
        if (selection === 'signin') {
          return navigation.navigate('Auth', { screen: 'signin' })
        }
      }
      return selection
    },
    [navigation, showAlreadySignedUp],
  )

  const done = async (data: { [string]: string }) => {
    setLoading(true)
    fireSignupEvent()

    //We can wait for ready later, when we need stuff, we dont need it until usage of API first in sendOTP(that needs to be logged in)
    //and finally in finishRegistration
    // await ready

    log.info('signup data:', { data })

    let nextRoute = getNextRoute(navigation.state.routes, navigation.state.index, state)

    const newState = { ...state, ...data, lastStep: navigation.state.index }
    setState(newState)
    log.info('signup data:', { data, nextRoute, newState })

    if (nextRoute === undefined) {
      const ok = await waitForRegistrationToFinish()

      //this will cause a re-render and move user to the dashboard route
      if (ok) {
        store.set('isLoggedIn')(true)
      }
    } else if (nextRoute && nextRoute.key === 'SMS') {
      try {
        const result = await checkExisting({ mobile: newState.mobile })

        if (result !== 'signup') {
          return
        }

        let { data } = await API.sendOTP(newState)
        if (data.ok === 0) {
          const errorMessage =
            data.error === 'mobile_already_exists' ? 'Mobile already exists, please use a different one' : data.error
          log.error('Send mobile code failed', errorMessage, new Error(errorMessage), {
            data,
            dialogShown: true,
          })

          return showSupportDialog(showErrorDialog, hideDialog, navigation.navigate, errorMessage)
        }

        return navigateWithFocus(nextRoute.key)
      } catch (e) {
        log.error('Send mobile code failed', e.message, e, { dialogShown: true })
        return showErrorDialog('Could not send verification code. Please try again')
      } finally {
        setLoading(false)
      }
    } else if (nextRoute && nextRoute.key === 'EmailConfirmation') {
      try {
        setLoading(true)
        const result = await checkExisting({ email: newState.email })

        if (result !== 'signup') {
          return
        }

        const { data } = await API.sendVerificationEmail(newState)
        if (data.ok === 0) {
          const error = new Error('Some error occurred on server')
          log.error('Send verification code failed', error.message, error, {
            data,
            dialogShown: true,
          })
          return showErrorDialog('Could not send verification email. Please try again')
        }

        log.debug('skipping email verification?', { ...data, skip: Config.skipEmailVerification })
        if (Config.skipEmailVerification || data.onlyInEnv) {
          // Server is using onlyInEnv middleware (probably dev mode), email verification is not sent.

          // Skip EmailConfirmation screen
          nextRoute = navigation.state.routes[navigation.state.index + 2]

          // Set email as confirmed
          setState({ ...newState, isEmailConfirmed: true })
        }

        return navigateWithFocus(nextRoute.key)
      } catch (e) {
        // we need to assign our custom error code for the received error object which will be sent to the sentry
        // the general error message not required
        decorate(e, ExceptionCode.E9)

        log.error('email verification failed unexpected:', e.message, e, { dialogShown: true })
        return showErrorDialog('Could not send verification email. Please try again', ExceptionCode.E9)
      } finally {
        setLoading(false)
      }
    } else if (nextRoute.key === 'MagicLinkInfo') {
      let ok = await waitForRegistrationToFinish()

      if (ok) {
        const { userStorage } = await ready
        if (isRegMethodSelfCustody) {
          API.sendMagicLinkByEmail(userStorage.getMagicLink())
            .then(r => log.info('magiclink sent'))
            .catch(e => log.error('failed sendMagicLinkByEmail', e.message, e))
        }

        return navigateWithFocus(nextRoute.key)
      }
    } else if (nextRoute) {
      return navigateWithFocus(nextRoute.key)
    }
  }

  const back = () => {
    const prevRoute = getPrevRoute(navigation.state.routes, navigation.state.index, state)

    if (prevRoute) {
      navigateWithFocus(prevRoute.key)
    } else {
      navigation.navigate('Auth')
    }
  }

  useEffect(() => {
    const curRoute = navigation.state.routes[navigation.state.index]

    if (state === initialState) {
      return
    }

    if (curRoute && curRoute.key === 'MagicLinkInfo') {
      setTitle('Magic Link')
      setShowNavBarGoBackButton(false)
    }

    if (curRoute && curRoute.key === 'SignupCompleted') {
      const finishedPromise = finishRegistration()
      setFinishedPromise(finishedPromise)
    }
  }, [navigation.state.index])

  useEffect(() => {
    const backButtonHandler = new BackButtonHandler({ defaultAction: back })
    return () => {
      backButtonHandler.unregister()
    }
  }, [back])

  const { scrollableContainer, contentContainer } = styles

  return (
    <View style={{ flexGrow: shouldGrow ? 1 : 0 }}>
      <NavBar goBack={showNavBarGoBackButton ? back : undefined} title={title} />
      <ScrollView contentContainerStyle={scrollableContainer}>
        <View style={contentContainer}>
          {!unrecoverableError && (
            <SignupWizardNavigator
              navigation={navigation}
              screenProps={{
                data: { ...state, loading, createError, countryCode },
                doneCallback: done,
                back,
              }}
            />
          )}
        </View>
      </ScrollView>
    </View>
  )
}

Signup.router = SignupWizardNavigator.router
Signup.navigationOptions = SignupWizardNavigator.navigationOptions

const styles = StyleSheet.create({
  contentContainer: {
    flexGrow: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  scrollableContainer: {
    flexGrow: 1,
  },
})

export default Signup
