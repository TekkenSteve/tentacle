/**
 * Minimal WeChat personal-account (iLink Bot) HTTP client.
 *
 * Protocol source (read verbatim before implementation):
 * - reference implementation: weixin/api.py:38-48
 *   (endpoints, channel version and auth constants)
 * - api.py:85-93 (request headers), api.py:140-180 (getUpdates/sendMessage)
 * - channels/weixin/types.py:63-94 (snake_case wire names; the reference implementation's pydantic
 *   aliases accept both casings, the official SDK README documents snake_case)
 *
 * Node's built-in fetch owns all connection pooling. The adapter supplies an
 * AbortSignal so stopping a channel also cancels an in-flight 35-second poll.
 * Secrets are never included in errors: response bodies and request headers are
 * deliberately excluded from every WeixinError message.
 */
import { randomBytes, randomUUID } from 'node:crypto'

export const WEIXIN_CHANNEL_TYPE = 'weixin'
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_DEFAULT_LONG_POLL_MS = 35_000

const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)
const HTTP_TIMEOUT_MS = 45_000
const LONG_POLL_TIMEOUT_HEADROOM_MS = 5_000

export type WeixinErrorCode = 'config' | 'api' | 'http' | 'transport' | 'timeout' | 'aborted' | 'invalid-response'

export class WeixinError extends Error {
  constructor(
    readonly code: WeixinErrorCode,
    message: string,
    readonly options: {
      readonly status?: number
      readonly ret?: number
      readonly errcode?: number
    } = {},
  ) {
    super(message)
    this.name = 'WeixinError'
  }

  get status(): number | undefined { return this.options.status }
  get ret(): number | undefined { return this.options.ret }
  get errcode(): number | undefined { return this.options.errcode }
}

export interface WeixinApiOptions {
  /** Messaging API root; QR provisioning returns this as `baseurl`. */
  readonly baseUrl?: string
  readonly token: string
  /** Optional pinned X-WECHAT-UIN; otherwise api.py:58-60 generates one per call. */
  readonly botUin?: string
  /** Non-long-poll request ceiling (api.py:48 defaults to 45 seconds). */
  readonly requestTimeoutMs?: number
  /** Test seam only; production uses Node 24's global fetch. */
  readonly fetch?: typeof fetch
}

export interface WeixinCdnMedia {
  readonly encrypt_query_param?: string
  readonly aes_key?: string
  readonly encrypt_type?: number
}

/**
 * Wire names are snake_case, end to end: the official
 * `@tencent-weixin/openclaw-weixin` README and live responses both use
 * `get_updates_buf` / `message_id` / `from_user_id` / `item_list`. The reference implementation's
 * pydantic models declare camelCase aliases with `populate_by_name=True`, so
 * its snake_case field names parse both shapes — a property this TypeScript
 * port did not inherit, which silently dropped every inbound message.
 */
export interface WeixinMessageItem {
  readonly type?: number
  readonly text_item?: { readonly text?: string }
  readonly image_item?: {
    readonly media?: WeixinCdnMedia
    readonly aeskey?: string
    readonly url?: string
  }
  readonly voice_item?: {
    readonly media?: WeixinCdnMedia
    readonly text?: string
  }
  readonly file_item?: {
    readonly media?: WeixinCdnMedia
    readonly file_name?: string
    readonly url?: string
  }
  readonly video_item?: {
    readonly media?: WeixinCdnMedia
    readonly url?: string
  }
  /** Raw fallback read by channel.py:524 for text items. */
  readonly content?: string
  /** Raw file-name fallbacks read by channel.py:541-547. */
  readonly filename?: string
  readonly file_name?: string
  readonly url?: string
}

export interface WeixinMessage {
  readonly seq?: number
  readonly message_id?: number | string
  readonly from_user_id?: string
  readonly to_user_id?: string
  readonly create_time_ms?: number
  readonly session_id?: string
  readonly message_type?: number
  readonly message_state?: number
  readonly item_list?: readonly WeixinMessageItem[]
  readonly context_token?: string
  /** Raw fallback read by channel.py:574-575. */
  readonly content?: string
}

export interface WeixinUpdates {
  readonly msgs: readonly WeixinMessage[]
  readonly get_updates_buf: string
  readonly longpolling_timeout_ms?: number
}

export interface WeixinSendResult {
  readonly context_token?: string
}

export interface WeixinApi {
  getUpdates(syncCursor: string, timeoutMs: number, signal?: AbortSignal): Promise<WeixinUpdates>
  sendTextMessage(toUserId: string, text: string, contextToken?: string): Promise<WeixinSendResult>
}

interface Envelope {
  readonly ret?: number
  readonly errcode?: number
  readonly msgs?: readonly WeixinMessage[]
  readonly get_updates_buf?: string
  readonly longpolling_timeout_ms?: number
  readonly context_token?: string
  readonly data?: { readonly context_token?: string }
}

export function createWeixinApi(options: WeixinApiOptions): WeixinApi {
  const base = normalizeBaseUrl(options.baseUrl ?? WEIXIN_DEFAULT_BASE_URL)
  const fetchImpl = options.fetch ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? HTTP_TIMEOUT_MS

  function headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // api.py:7-12,85-93 — all three auth fields are required for a bound session.
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${options.token}`,
      'X-WECHAT-UIN': options.botUin ?? randomWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    }
  }

  async function post(
    endpoint: string,
    payload: Record<string, unknown>,
    operation: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Envelope> {
    if (options.token.trim() === '') throw new WeixinError('config', 'weixin token is empty')
    const body = JSON.stringify(payload)
    const requestHeaders = { ...headers(), 'Content-Length': String(Buffer.byteLength(body)) }
    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => { controller.abort(signal?.reason) }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`weixin ${operation} timed out`))
    }, timeoutMs)

    let response: Response
    let text: string
    try {
      response = await fetchImpl(`${base}/${endpoint}`, {
        method: 'POST',
        headers: requestHeaders,
        body,
        signal: controller.signal,
      })
      // Keep the deadline and caller cancellation attached until the body is
      // consumed too; fetch() may resolve after headers while the body stalls.
      text = await response.text()
    } catch (error) {
      if (signal?.aborted === true) throw new WeixinError('aborted', `weixin ${operation} aborted`)
      if (timedOut) throw new WeixinError('timeout', `weixin ${operation} timed out`)
      throw new WeixinError('transport', `weixin ${operation} transport failed (${errorName(error)})`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WeixinError(
        'invalid-response',
        `weixin ${operation} returned non-JSON (HTTP ${response.status})`,
        { status: response.status },
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WeixinError('invalid-response', `weixin ${operation} returned a non-object`, { status: response.status })
    }
    const envelope = parsed as Envelope
    if (response.status !== 200) {
      throw new WeixinError('http', `weixin ${operation} failed with HTTP ${response.status}`, {
        status: response.status,
        ret: response.status,
        errcode: response.status,
      })
    }
    // api.py:119-125 checks errcode before ret; either can carry session -14.
    if (envelope.errcode !== undefined && envelope.errcode !== 0) {
      throw new WeixinError('api', `weixin ${operation} failed (errcode=${envelope.errcode})`, {
        status: response.status,
        ret: envelope.ret,
        errcode: envelope.errcode,
      })
    }
    if (envelope.ret !== undefined && envelope.ret !== 0) {
      throw new WeixinError('api', `weixin ${operation} failed (ret=${envelope.ret})`, {
        status: response.status,
        ret: envelope.ret,
        errcode: envelope.errcode,
      })
    }
    return envelope
  }

  return {
    async getUpdates(syncCursor, timeoutMs, signal) {
      // api.py:140-151 — snake_case requests, base_info and server-driven poll timeout.
      const envelope = await post('ilink/bot/getupdates', {
        get_updates_buf: syncCursor,
        base_info: { channel_version: CHANNEL_VERSION },
        longpolling_timeout_ms: timeoutMs,
      }, 'getUpdates', timeoutMs + LONG_POLL_TIMEOUT_HEADROOM_MS, signal)
      if (envelope.msgs !== undefined && !Array.isArray(envelope.msgs)) {
        throw new WeixinError('invalid-response', 'weixin getUpdates msgs was not an array')
      }
      if (envelope.get_updates_buf !== undefined && typeof envelope.get_updates_buf !== 'string') {
        throw new WeixinError('invalid-response', 'weixin get_updates_buf was not a string')
      }
      if (envelope.longpolling_timeout_ms !== undefined && typeof envelope.longpolling_timeout_ms !== 'number') {
        throw new WeixinError('invalid-response', 'weixin longpolling_timeout_ms was not a number')
      }
      return {
        msgs: envelope.msgs ?? [],
        get_updates_buf: envelope.get_updates_buf ?? '',
        ...(envelope.longpolling_timeout_ms === undefined ? {} : { longpolling_timeout_ms: envelope.longpolling_timeout_ms }),
      }
    },

    async sendTextMessage(toUserId, text, contextToken = '') {
      // api.py:155-180 — bot/finish are protocol values 2/2; null means no context.
      const envelope = await post('ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `hg-weixin-${randomUUID().replaceAll('-', '')}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken === '' ? null : contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }, 'sendMessage', requestTimeoutMs)
      const refreshed = envelope.context_token ?? envelope.data?.context_token
      return refreshed === undefined || refreshed === '' ? {} : { context_token: refreshed }
    },
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WeixinError('config', 'weixin baseUrl must be an absolute HTTP(S) URL')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw new WeixinError('config', 'weixin baseUrl must be an absolute HTTP(S) URL without userinfo')
  }
  return value.replace(/\/+$/, '')
}

function randomWechatUin(): string {
  // Official clients encode the DECIMAL STRING of a random uint32, then base64
  // it (official JS/TS clients use `Buffer.from(String(value))`; CowAgent uses
  // `str(val)`), not the raw four bytes. api.py:58-60 base64s the packed bytes
  // — the server tolerates both, but the documented contract is the decimal
  // string, so match the official client.
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}
