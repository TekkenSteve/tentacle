/**
 * DingTalk scan-to-create provisioning (design 08 §4).
 *
 * This is the three-call device registration protocol, not an OAuth flow:
 * init obtains a nonce, begin exchanges it for public QR metadata plus a
 * device_code, and poll exchanges that code for the terminal status. The
 * device_code never leaves session.data except in DingTalk's own poll request.
 */
import type { ChannelType } from '../types.js'
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

const DEFAULT_REGISTRATION_BASE_URL = 'https://oapi.dingtalk.com'
const DEFAULT_EXPIRES_SECONDS = 600
const MAX_EXPIRES_SECONDS = 7200
const DEFAULT_INTERVAL_SECONDS = 5
const MAX_INTERVAL_SECONDS = 30

export interface DingTalkProvisionOptions {
  /** Registration API root; tests and compatible private deployments override it. */
  readonly apiBaseUrl?: string
  /** Clock seam for deterministic TTL assertions. */
  readonly now?: () => number
}

interface DingTalkRegistrationState {
  /** Platform secret: host memory only, never part of a public projection. */
  deviceCode: string
  readonly qrUrl: string
  readonly userCode: string
}

interface RegistrationResponse {
  readonly [key: string]: unknown
}

export class DingTalkProvisionFlow implements ProvisionFlow {
  // Central integration adds 'dingtalk' to ChannelType; see the adapter note.
  readonly channelType = 'dingtalk' as ChannelType
  private readonly baseUrl: string
  private readonly now: () => number

  constructor(options: DingTalkProvisionOptions = {}) {
    this.baseUrl = (options.apiBaseUrl ?? DEFAULT_REGISTRATION_BASE_URL).replace(/\/+$/, '')
    this.now = options.now ?? Date.now
  }

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    // Exact init→begin sequence and JSON bodies from
    // dingtalk_registration.py:22-46. No platform call is needed on stop.
    const initialized = await this.post('/app/registration/init', {}, 'registration init')
    const nonce = initialized['nonce']
    if (typeof nonce !== 'string' || nonce === '') {
      throw new Error('DingTalk registration init response is missing nonce')
    }
    const started = await this.post('/app/registration/begin', { nonce }, 'registration begin')
    const deviceCode = requiredString(started, 'device_code', 'registration begin')
    const userCode = requiredString(started, 'user_code', 'registration begin')
    const qrUrl = requiredString(started, 'verification_uri_complete', 'registration begin')

    // Only this private session object retains the code. ProvisionStart carries
    // precisely the fields the QR screen needs (design 08 §1 secret boundary).
    session.data = { deviceCode, qrUrl, userCode } satisfies DingTalkRegistrationState
    const expiresIn = boundedInteger(started['expires_in'], DEFAULT_EXPIRES_SECONDS, 1, MAX_EXPIRES_SECONDS)
    const interval = boundedInteger(started['interval'], DEFAULT_INTERVAL_SECONDS, 1, MAX_INTERVAL_SECONDS)
    return {
      qrUrl,
      userCode,
      expiresAt: this.now() + expiresIn * 1000,
      pollAfterMs: interval * 1000,
    }
  }

  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = session.data as DingTalkRegistrationState | undefined
    if (state === undefined || typeof state.deviceCode !== 'string' || state.deviceCode === '') {
      throw new Error('DingTalk registration flow has not been started')
    }
    // Exact poll body from dingtalk_registration.py:49-57. This request is the
    // only place the device code crosses the host boundary.
    const result = await this.post('/app/registration/poll', { device_code: state.deviceCode }, 'registration poll')
    const status = typeof result['status'] === 'string' ? result['status'].toUpperCase() : ''
    switch (status) {
      case 'WAITING':
        return { state: 'waiting', qrUrl: state.qrUrl, userCode: state.userCode }
      case 'EXPIRED':
        state.deviceCode = ''
        return { state: 'expired' }
      case 'FAIL': {
        const reason = typeof result['fail_reason'] === 'string' && result['fail_reason'] !== ''
          ? result['fail_reason']
          : 'DingTalk authorization failed.'
        // Even a malformed upstream reason cannot smuggle the device code into
        // the failed projection returned by this flow. Redact BEFORE clearing.
        const publicReason = reason.split(state.deviceCode).join('[redacted]')
        state.deviceCode = ''
        return { state: 'failed', error: publicReason }
      }
      case 'SUCCESS': {
        const clientId = requiredString(result, 'client_id', 'registration poll')
        const clientSecret = requiredString(result, 'client_secret', 'registration poll')
        state.deviceCode = ''
        // Names intentionally match DingTalkCredentials exactly: the host can
        // persist this map and construct the adapter without aliases.
        return { state: 'success', credentials: { clientId, clientSecret } }
      }
      default:
        throw new Error(`DingTalk returned an unknown registration status: ${status || 'missing'}`)
    }
  }

  /** Parse one registration response and enforce its errcode envelope. */
  private async post(path: string, body: Record<string, unknown>, operation: string): Promise<RegistrationResponse> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Do not include a fetch error or URL: poll URLs are safe but error text
      // could echo request data in some runtimes.
      throw new Error(`DingTalk ${operation} transport failed`)
    }
    const text = await response.text()
    let payload: RegistrationResponse
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      payload = parsed as RegistrationResponse
    } catch {
      throw new Error(`DingTalk ${operation} returned an invalid response`)
    }
    if (!response.ok) throw new Error(`DingTalk ${operation} failed (HTTP ${response.status})`)
    // _require_success requires an object with errcode == 0
    // (dingtalk_registration.py:13-19), rather than treating HTTP 200 as enough.
    if (payload['errcode'] !== 0) {
      const message = typeof payload['errmsg'] === 'string' && payload['errmsg'] !== ''
        ? payload['errmsg']
        : 'unknown error'
      throw new Error(`DingTalk ${operation} failed: ${message.slice(0, 300)}`)
    }
    return payload
  }
}

function requiredString(payload: RegistrationResponse, key: string, operation: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`DingTalk ${operation} response is incomplete: ${key}`)
  }
  return value
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(min, Math.min(number || fallback, max))
}
