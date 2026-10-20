/**
 * Yuanbao HTTP authentication client.
 *
 * Only sign-token belongs here.  In particular, probing this API must never
 * open a WebSocket: the reference manager forces `probe_mode="sign_token"`
 * because Yuanbao permits one effective bot WS session (manager.py:604-609).
 */
import { createHmac, randomBytes } from 'node:crypto'
import {
  DEFAULT_API_DOMAIN,
  HERMES_INSTANCE_ID,
  SIGN_TOKEN_PATH,
} from './yuanbao-frames.js'

export type YuanbaoErrorCode = 'config' | 'auth' | 'api' | 'transport' | 'invalid-response' | 'timeout'

export class YuanbaoError extends Error {
  constructor(
    readonly code: YuanbaoErrorCode,
    message: string,
    readonly status?: number,
    readonly platformCode?: number,
  ) {
    super(message)
    this.name = 'YuanbaoError'
  }
}

export interface YuanbaoToken {
  readonly token: string
  readonly botId: string
  readonly source: string
  readonly expiresAt: number
  readonly duration: number
}

export interface YuanbaoApi {
  /** `force` bypasses the expiry cache, as `_sign_token(force=True)` does. */
  signToken(force?: boolean): Promise<YuanbaoToken>
  /** Forget a token after the WS reports one of TOKEN_EXPIRED_CODES. */
  clearToken(): void
}

export interface YuanbaoApiOptions {
  readonly appKey: string
  readonly appSecret: string
  readonly apiDomain?: string
  readonly requestTimeoutMs?: number
  /** Test seams; production defaults are random nonce + wall clock. */
  readonly now?: () => number
  readonly nonce?: () => string
}

const TOKEN_REFRESH_MARGIN_SECONDS = 300
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function normalizeYuanbaoApiDomain(value: string | undefined): string {
  let domain = (value ?? '').trim().replace(/\/+$/, '')
  if (domain === '') return DEFAULT_API_DOMAIN
  if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`
  return domain
}

/** Python `datetime.now(CST).isoformat(timespec="seconds")` (channel.py:569-571). */
export function yuanbaoTimestamp(now: number): string {
  return `${new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`
}

/** Independent-of-adapter signature primitive, mirroring utils.py:19-22. */
export function computeYuanbaoSignature(appSecret: string, nonce: string, timestamp: string, appKey: string): string {
  return createHmac('sha256', appSecret).update(`${nonce}${timestamp}${appKey}${appSecret}`, 'utf8').digest('hex')
}

export function createYuanbaoApi(options: YuanbaoApiOptions): YuanbaoApi {
  const apiDomain = normalizeYuanbaoApiDomain(options.apiDomain)
  const now = options.now ?? Date.now
  const nonce = options.nonce ?? (() => randomBytes(16).toString('hex'))
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let cached: YuanbaoToken | undefined

  async function request(input: RequestInit): Promise<{ payload: Record<string, unknown>; status: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${apiDomain}${SIGN_TOKEN_PATH}`, {
        ...input,
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = controller.signal.aborted
      throw new YuanbaoError(
        timedOut ? 'timeout' : 'transport',
        timedOut ? 'yuanbao sign-token timed out' : 'yuanbao sign-token transport failed',
      )
    } finally {
      clearTimeout(timer)
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw new YuanbaoError('transport', 'yuanbao sign-token response could not be read', response.status)
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      // Do not include the body: upstream error pages can reflect credentials.
      throw new YuanbaoError('invalid-response', `yuanbao sign-token returned non-JSON (HTTP ${response.status})`, response.status)
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new YuanbaoError('invalid-response', 'yuanbao sign-token returned a malformed envelope', response.status)
    }
    return { payload: payload as Record<string, unknown>, status: response.status }
  }

  async function fetchToken(): Promise<YuanbaoToken> {
    if (options.appKey.trim() === '' || options.appSecret.trim() === '') {
      throw new YuanbaoError('config', 'yuanbao appKey and appSecret are required')
    }
    const tokenNonce = nonce()
    const timestamp = yuanbaoTimestamp(now())
    const signature = computeYuanbaoSignature(options.appSecret, tokenNonce, timestamp, options.appKey)
    let result: { payload: Record<string, unknown>; status: number }
    try {
      result = await request({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-appversion': '1.0.0',
          'x-operationsystem': process.platform,
          'x-instance-id': HERMES_INSTANCE_ID,
          'x-bot-version': '1.0.0',
        },
        body: JSON.stringify({
          app_key: options.appKey,
          nonce: tokenNonce,
          signature,
          timestamp,
        }),
      })
    } catch (error) {
      if (error instanceof YuanbaoError && (error.status === 401 || error.status === 403)) {
        throw new YuanbaoError('auth', 'yuanbao sign-token was rejected', error.status, error.platformCode)
      }
      throw error
    }

    const code = Number(result.payload['code'] || 0)
    if (code !== 0) {
      const errorCode = result.status === 401 || result.status === 403 ? 'auth' : 'api'
      // The platform message is intentionally not propagated: it is not needed
      // for recovery and could contain reflected request material.
      throw new YuanbaoError(errorCode, `yuanbao sign-token failed (code ${code})`, result.status, code)
    }
    const data = result.payload['data']
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new YuanbaoError('invalid-response', 'yuanbao sign-token response missing data', result.status)
    }
    const record = data as Record<string, unknown>
    const token = typeof record['token'] === 'string' ? record['token'] : ''
    const botId = typeof record['bot_id'] === 'string' ? record['bot_id'] : ''
    const source = typeof record['source'] === 'string' ? record['source'] : ''
    if (token === '' || botId === '') {
      throw new YuanbaoError('invalid-response', 'yuanbao sign-token response missing token or bot_id', result.status)
    }
    const rawDuration = Number(record['duration'] || 3600)
    const duration = Number.isFinite(rawDuration) ? rawDuration : 3600
    const expiresAt = now() + Math.max(duration - TOKEN_REFRESH_MARGIN_SECONDS, 60) * 1000
    const issued: YuanbaoToken = { token, botId, source, expiresAt, duration }
    cached = issued
    return issued
  }

  return {
    async signToken(force = false) {
      if (!force && cached !== undefined && now() < cached.expiresAt) return cached
      return await fetchToken()
    },
    clearToken() {
      cached = undefined
    },
  }
}
