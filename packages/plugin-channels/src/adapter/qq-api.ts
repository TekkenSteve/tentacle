/**
 * Minimal QQ official-bot REST/OAuth client.
 *
 * Protocol source: the reference implementation's QQ adapter.
 * channel.py:1358-1371 (gateway), 1452-1474 (send routes), 1476-1572
 * (QQBot authorization, OAuth cache and one 401 retry). Only built-in fetch is
 * used; access tokens and app secrets are never included in error messages.
 */

export type QQErrorCode = 'config' | 'auth' | 'api' | 'transport' | 'invalid-response'

export class QQError extends Error {
  constructor(
    readonly code: QQErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'QQError'
  }
}

export type QQMessageType = 'c2c' | 'group' | 'direct' | 'channel'

export interface QQApiOptions {
  /** REST root; the reference implementation's production default is api.sgroup.qq.com. */
  readonly apiBaseUrl?: string
  /** OAuth endpoint override for a loopback fake or a compatible deployment. */
  readonly accessTokenUrl?: string
  readonly appId: string
  readonly secret: string
}

export interface QQApi {
  /** Return a cached token, or force a fresh OAuth token before re-IDENTIFY. */
  getAccessToken(forceRefresh?: boolean): Promise<string>
  /** GET /gateway/bot with `Authorization: QQBot <access_token>`. */
  getGatewayUrl(forceTokenRefresh?: boolean): Promise<string>
  /** POST one already-shaped message body to the inferred QQ route. */
  sendMessage(msgType: QQMessageType, targetId: string, body: Record<string, unknown>): Promise<void>
}

export const DEFAULT_QQ_API_BASE_URL = 'https://api.sgroup.qq.com'
export const DEFAULT_QQ_ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

interface HttpReply {
  readonly status: number
  readonly text: string
}

interface TokenPayload {
  readonly access_token?: unknown
  readonly expires_in?: unknown
}

interface CachedToken {
  readonly value: string
  readonly refreshAt: number
}

export function createQQApi(options: QQApiOptions): QQApi {
  if (options.appId.trim() === '' || options.secret.trim() === '') {
    throw new QQError('config', 'qq adapter requires appId and secret credentials')
  }
  const base = (options.apiBaseUrl ?? DEFAULT_QQ_API_BASE_URL).replace(/\/+$/, '')
  const accessTokenUrl = options.accessTokenUrl ?? DEFAULT_QQ_ACCESS_TOKEN_URL
  let cached: CachedToken | undefined
  let pending: Promise<string> | undefined

  async function request(url: string, init: RequestInit, operation: string): Promise<HttpReply> {
    try {
      const response = await fetch(url, init)
      return { status: response.status, text: await response.text() }
    } catch (error) {
      // Do not include a request/response body here: either side can contain
      // credentials. The operation and transport reason are sufficient.
      throw new QQError('transport', `qq ${operation} request failed: ${describe(error)}`)
    }
  }

  function parseObject(text: string, operation: string, status: number): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
      return value as Record<string, unknown>
    } catch {
      throw new QQError('invalid-response', `qq ${operation} returned malformed JSON`, status)
    }
  }

  async function fetchToken(): Promise<string> {
    const reply = await request(accessTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Exact field names from channel.py:1544-1549; `secret` is never logged.
      body: JSON.stringify({ appId: options.appId, clientSecret: options.secret }),
    }, 'access token')
    if (reply.status !== 200) {
      throw new QQError('auth', `qq access token request failed (HTTP ${reply.status})`, reply.status)
    }
    let payload: TokenPayload
    try {
      payload = parseObject(reply.text, 'access token', reply.status)
    } catch (error) {
      if (error instanceof QQError) throw new QQError('auth', error.message, error.status)
      throw error
    }
    const token = payload.access_token
    if (typeof token !== 'string' || token === '') {
      throw new QQError('auth', 'qq access token response carried no access_token', reply.status)
    }
    const rawTtl = payload.expires_in ?? 7200
    const ttl = typeof rawTtl === 'number' || typeof rawTtl === 'string' ? Number(rawTtl) : Number.NaN
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new QQError('auth', 'qq access token response carried an invalid expires_in', reply.status)
    }
    // channel.py:1563-1570 refreshes 60s early, or at half-life for short TTLs.
    const skew = Math.min(60, Math.max(1, Math.floor(ttl / 2)))
    const refreshAfterSeconds = Math.max(1, ttl - skew)
    cached = { value: token, refreshAt: Date.now() + refreshAfterSeconds * 1000 }
    return token
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) cached = undefined
    if (cached !== undefined && Date.now() < cached.refreshAt) return cached.value
    // Coalesce token refreshes from concurrent sends/reconnects.
    pending ??= fetchToken().finally(() => { pending = undefined })
    return await pending
  }

  async function tokenAfterRejection(rejectedToken: string): Promise<string> {
    // Another concurrent request may already have replaced the rejected token.
    if (cached !== undefined && cached.value !== rejectedToken && Date.now() < cached.refreshAt) {
      return cached.value
    }
    cached = undefined
    return await getAccessToken()
  }

  async function authed(
    url: string,
    init: RequestInit,
    operation: string,
    forceTokenRefresh = false,
  ): Promise<HttpReply> {
    const firstToken = await getAccessToken(forceTokenRefresh)
    const send = async (token: string): Promise<HttpReply> => await request(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `QQBot ${token}`,
      },
    }, operation)
    let reply = await send(firstToken)
    if (reply.status === 401) {
      // channel.py:1511-1528: invalidate and retry the same request exactly once.
      const secondToken = await tokenAfterRejection(firstToken)
      reply = await send(secondToken)
    }
    return reply
  }

  return {
    getAccessToken,

    async getGatewayUrl(forceTokenRefresh = false) {
      const reply = await authed(`${base}/gateway/bot`, { method: 'GET' }, 'gateway', forceTokenRefresh)
      if (reply.status !== 200) {
        throw new QQError(reply.status === 401 ? 'auth' : 'api', `qq gateway request failed (HTTP ${reply.status})`, reply.status)
      }
      const payload = parseObject(reply.text, 'gateway', reply.status)
      const url = payload['url']
      if (typeof url !== 'string' || url === '') {
        throw new QQError('invalid-response', 'qq gateway response carried no url', reply.status)
      }
      return url
    },

    async sendMessage(msgType, targetId, body) {
      if (targetId.trim() === '') throw new QQError('config', `qq ${msgType} send target is empty`)
      const path = sendPath(msgType, targetId)
      const reply = await authed(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, 'send message')
      // The reference implementation accepts the platform's 200/201/202/204 success family
      // (channel.py:1405-1415); a second 401 is not retried again.
      if (![200, 201, 202, 204].includes(reply.status)) {
        throw new QQError(reply.status === 401 ? 'auth' : 'api', `qq send message failed (HTTP ${reply.status})`, reply.status)
      }
    },
  }
}

function sendPath(msgType: QQMessageType, targetId: string): string {
  const id = encodeURIComponent(targetId)
  switch (msgType) {
    case 'c2c': return `/v2/users/${id}/messages`
    case 'group': return `/v2/groups/${id}/messages`
    case 'direct': return `/dms/${id}/messages`
    case 'channel': return `/channels/${id}/messages`
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
