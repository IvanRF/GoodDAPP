// @flow
import axios from 'axios'
import Config from '../../config/dev.js'
import { AsyncStorage } from 'react-native'
import logger from '../logger/pino-logger'
import type { NameRecord } from '../../components/signup/NameForm'
import type { EmailRecord } from '../../components/signup/EmailForm'
import type { MobileRecord } from '../../components/signup/PhoneForm.web'

const log = logger.child({ from: 'API' })

export type Credentials = {
  pubkey: string,
  signature?: string,
  jwt: string
}

export type UserRecord = NameRecord & EmailRecord & MobileRecord & Credentials

class API {
  jwt: string
  client: axios

  constructor() {
    this.init()
  }

  init() {
    log.info('initializing api...')
    AsyncStorage.getItem('GoodDAPP_jwt').then(async jwt => {
      this.jwt = jwt
      this.client = await axios.create({
        baseURL: Config.GoodServer,
        timeout: 2000,
        headers: { Authorization: `Bearer ${this.jwt || ''}` }
      })
      log.info('API ready', this.client, this.jwt)
    })
  }
  auth(creds: Credentials) {
    return this.client.post(`/auth/eth`, creds)
  }

  async addUser(user: UserRecord) {
    try {
      let res = await this.client.post('/user/add', { user })
      log.info(res)
    } catch (e) {
      log.info(e)
    }
  }
}

export default new API()
