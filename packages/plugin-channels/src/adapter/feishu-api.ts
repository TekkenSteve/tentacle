/**
 * Minimal HTTP client for the feishu (Lark) open platform (design 06 §6).
 *
 * Same seam philosophy as the Telegram client: `apiBaseUrl` is configuration,
 * never a constant, so the unit tests and the e2e suite point the adapter at
 * a local fake platform. Unlike Telegram there is no long poll — feishu
 * pushes events to our callback route — so the global `fetch` is enough and
 * no third-party dependency appears.
 *
 * Auth model: every business call needs a `tenant_access_token`, fetched from
 * `/open-apis/auth/v3/tenant_access_token/internal` with the app id/secret
 * pair and cached until 60s before its platform-declared expiry. The cache
 * lives HERE (not in the adapter) because it is a property of the platform
 * client: every caller — identity probe, send, reply — shares one token.
 * Concurrent fetches coalesce onto one in-flight promise so a reply burst
 * never stampedes the token endpoint.
 *
 * Secrets never enter log/error messages: `FeishuError` carries the
 * platform's own `msg`, never the request body.
 */
export type FeishuErrorCode = 'config' | 'auth' | 'api' | 'transport' | 'invalid-response'

export class FeishuError extends Error {
  constructor(
    readonly code: FeishuErrorCode,
    message: string,
    /** HTTP status, when the platform answered at all. */
    readonly status?: number,
    /** feishu's own business `code`, when it answered with one. */
    readonly platformCode?: number,
  ) {
    super(message)
    this.name = 'FeishuError'
  }
}

export interface FeishuApiOptions {
  /**
   * Open-platform root without a trailing slash. Default
   * `https://open.feishu.cn` (Lark international deployments set
   * `https://open.larksuite.com`; tests set a loopback fake).
   */
  readonly apiBaseUrl?: string
  /** App credentials from the instance's credential record. */
  readonly appId: string
  readonly appSecret: string
}

/** Bot identity as `/open-apis/bot/v3/info` reports it. */
export interface FeishuBotInfo {
  readonly openId: string
  readonly appName?: string
}

/** The platform calls the adapter needs, already unwrapped from envelopes. */
export interface FeishuApi {
  getBotInfo(): Promise<FeishuBotInfo>
  sendTextMessage(chatId: string, text: string): Promise<void>
  replyTextMessage(messageId: string, text: string): Promise<void>
}

const DEFAULT_API_BASE_URL = 'https://open.feishu.cn'
/**
 * Refresh the tenant token this long BEFORE its declared expiry: a send that
 * starts just before expiry must not race the platform's own invalidation.
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/** feishu envelopes every answer as `{code, msg, ...}`; 0 means success. */
interface FeishuEnvelope {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
  /** bot/v3/info returns the bot object at the TOP level (no `data` wrapper). */
  bot?: { open_id?: string; app_name?: string }
  data?: {
    message_id?: string
  }
}

export function createFeishuApi(options: FeishuApiOptions): FeishuApi {
  const base = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  let cached: { readonly token: string; readonly expiresAt: number } | undefined
  let pending: Promise<string> | undefined

  async function request(url: string, init: RequestInit, operation: string): Promise<FeishuEnvelope> {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (error) {
      throw new FeishuError('transport', `feishu ${operation} failed: ${describe(error)}`)
    }
    const text = await res.text()
    let payload: FeishuEnvelope
    try {
      payload = JSON.parse(text) as FeishuEnvelope
    } catch {
      // Never log the body: an error page could quote the request back.
      throw new FeishuError('invalid-response', `feishu ${operation} returned non-JSON (HTTP ${res.status})`, res.status)
    }
    return payload
  }

  /** Unwrap the `{code, msg}` envelope or throw. */
  function assertOk(payload: FeishuEnvelope, operation: string, status?: number): void {
    if (payload.code !== 0) {
      throw new FeishuError(
        'api',
        `feishu ${operation} failed: ${payload.msg ?? 'unknown error'}`,
        status,
        payload.code,
      )
    }
  }

  /**
   * Fetch a fresh tenant token. Every failure — transport, envelope, shape —
   * is an `auth` error so the adapter can mark a single failure kind for
   * "the app credentials do not work" regardless of which step refused.
   */
  async function fetchToken(): Promise<string> {
    if (options.appId.trim() === '' || options.appSecret.trim() === '') {
      throw new FeishuError('auth', 'feishu appId/appSecret are empty')
    }
    let payload: FeishuEnvelope
    try {
      payload = await request(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
      }, 'tenant token')
    } catch (error) {
      throw error instanceof FeishuError
        ? new FeishuError('auth', error.message, error.status, error.platformCode)
        : error
    }
    if (payload.code !== 0) {
      throw new FeishuError('auth', `feishu tenant token failed: ${payload.msg ?? 'unknown error'}`, undefined, payload.code)
    }
    const token = payload.tenant_access_token
    if (typeof token !== 'string' || token === '') {
      throw new FeishuError('auth', 'feishu tenant token response carried no token')
    }
    // `expire` is seconds from now. A missing/absurd value (or one shorter
    // than the refresh margin) yields an already-stale cache entry, which is
    // the safe degenerate case: every call simply refetches.
    const ttlMs = typeof payload.expire === 'number' && payload.expire > 0 ? payload.expire * 1000 : 0
    cached = { token, expiresAt: Date.now() + ttlMs - TOKEN_REFRESH_MARGIN_MS }
    return token
  }

  async function tenantAccessToken(): Promise<string> {
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.token
    // Coalesce concurrent refreshes onto one in-flight request.
    pending ??= fetchToken().finally(() => { pending = undefined })
    return pending
  }

  async function authed(url: string, init: RequestInit, operation: string): Promise<FeishuEnvelope> {
    const token = await tenantAccessToken()
    return await request(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    }, operation)
  }

  return {
    async getBotInfo() {
      const payload = await authed(`${base}/open-apis/bot/v3/info`, { method: 'GET' }, 'bot info')
      assertOk(payload, 'bot info')
      // The real API puts `bot` at the top level; `data` belongs to list/send.
      const bot = payload.bot
      if (bot === undefined || typeof bot.open_id !== 'string' || bot.open_id === '') {
        throw new FeishuError('invalid-response', 'feishu bot info carried no bot.open_id')
      }
      return {
        openId: bot.open_id,
        ...(typeof bot.app_name === 'string' && bot.app_name !== '' ? { appName: bot.app_name } : {}),
      }
    },
    async sendTextMessage(chatId, text) {
      const payload = await authed(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
      }, 'send message')
      assertOk(payload, 'send message')
    },
    async replyTextMessage(messageId, text) {
      const payload = await authed(`${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
      }, 'reply message')
      assertOk(payload, 'reply message')
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
