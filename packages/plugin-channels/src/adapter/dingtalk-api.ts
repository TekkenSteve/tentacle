/**
 * Minimal DingTalk OpenAPI/Stream HTTP client.
 *
 * The Stream ticket endpoint and the reply/token endpoints deliberately have
 * separate bases: tests and private deployments can route them independently.
 * Only Node's built-in `fetch` is used; no SDK or other runtime dependency is
 * needed. Secrets are request fields, never URL parameters or log messages.
 */

export type DingTalkErrorCode = 'config' | 'auth' | 'api' | 'transport' | 'invalid-response'

export class DingTalkError extends Error {
  constructor(
    readonly code: DingTalkErrorCode,
    message: string,
    /** HTTP status, when DingTalk answered at all. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DingTalkError'
  }
}

export interface DingTalkApiOptions {
  /** OpenAPI root. The reference implementation uses api.dingtalk.com for these v1.0 endpoints. */
  readonly apiBaseUrl?: string
  /** Stream gateway root (`/v1.0/gateway/connections/open` is appended). */
  readonly streamUrl?: string
  readonly clientId: string
  readonly clientSecret: string
  /** Overrides the proactive-message robot code; defaults to clientId. */
  readonly robotCode?: string
}

export interface DingTalkConnection {
  readonly endpoint: string
  readonly ticket: string
}

export interface DingTalkApi {
  /** Obtain a fresh Stream endpoint/ticket pair. Tickets are single-use. */
  openConnection(signal?: AbortSignal): Promise<DingTalkConnection>
  /** Reply in the conversation that produced a sessionWebhook. */
  sendSessionWebhook(webhook: string, text: string): Promise<void>
  /** Proactively send a DM through robot/oToMessages/batchSend. */
  sendDirectMessage(userId: string, text: string): Promise<void>
}

export const DEFAULT_DINGTALK_API_BASE_URL = 'https://api.dingtalk.com'
export const DEFAULT_DINGTALK_STREAM_URL = 'https://api.dingtalk.com'
/** The reference implementation switches from Markdown to plain text above this code-point count. */
export const DINGTALK_TEXT_LIMIT = 3500
/** The v2 token lasts two hours; refresh five minutes early (SDK stream.py:227-229). */
const TOKEN_REFRESH_MARGIN_SECONDS = 300
/** The reference implementation additionally caps the cache interval at 1.5h (dingtalk.py:37-38,153-155). */
const TOKEN_MAX_CACHE_SECONDS = 5400
const CHATBOT_TOPIC = '/v1.0/im/bot/messages/get'

interface JsonObject {
  readonly [key: string]: unknown
}

interface JsonResponse {
  readonly status: number
  readonly payload: JsonObject
}

export function createDingTalkApi(options: DingTalkApiOptions): DingTalkApi {
  if (options.clientId.trim() === '' || options.clientSecret.trim() === '') {
    throw new DingTalkError('config', 'dingtalk clientId/clientSecret are required')
  }
  const apiBase = (options.apiBaseUrl ?? DEFAULT_DINGTALK_API_BASE_URL).replace(/\/+$/, '')
  const streamBase = (options.streamUrl ?? DEFAULT_DINGTALK_STREAM_URL).replace(/\/+$/, '')
  const robotCode = options.robotCode === undefined || options.robotCode.trim() === ''
    ? options.clientId
    : options.robotCode
  let cached: { readonly token: string; readonly expiresAt: number } | undefined
  let pending: Promise<string> | undefined

  /**
   * Parse without ever including a response body in an error. Apart from avoiding
   * accidental secret echoes, this also keeps HTML proxy pages out of logs.
   */
  async function request(
    url: string,
    init: RequestInit,
    operation: string,
    credentialOperation = false,
  ): Promise<JsonResponse> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      if (error instanceof DingTalkError) throw error
      // Do not append the fetch error: runtimes may include the full URL, and a
      // sessionWebhook URL itself is a short-lived reply credential.
      throw new DingTalkError('transport', `dingtalk ${operation} transport failed`)
    }
    const text = await response.text()
    let payload: JsonObject
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      payload = parsed as JsonObject
    } catch {
      throw new DingTalkError('invalid-response', `dingtalk ${operation} returned non-JSON (HTTP ${response.status})`, response.status)
    }
    if (!response.ok) {
      // A rejected credential exchange cannot heal by reconnecting. Other HTTP
      // failures remain retryable unless the adapter explicitly classifies them.
      const auth = response.status === 401 || response.status === 403 || (credentialOperation && response.status === 400)
      const detail = publicError(payload, options.clientSecret)
      throw new DingTalkError(
        auth ? 'auth' : 'api',
        `dingtalk ${operation} failed (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`,
        response.status,
      )
    }
    return { status: response.status, payload }
  }

  async function fetchToken(): Promise<string> {
    // The reference implementation's v2 credential call: dingtalk.py:126-155. The field names appKey
    // and appSecret belong to THIS endpoint; Stream uses clientId/clientSecret.
    const { payload } = await request(`${apiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ appKey: options.clientId, appSecret: options.clientSecret }),
    }, 'access token', true)
    const token = payload['accessToken']
    if (typeof token !== 'string' || token === '') {
      const detail = publicError(payload, options.clientSecret)
      throw new DingTalkError('auth', `dingtalk access token response carried no token${detail === undefined ? '' : `: ${detail}`}`)
    }
    const expireIn = typeof payload['expireIn'] === 'number' && payload['expireIn'] > 0
      ? payload['expireIn']
      : 7200
    const cacheSeconds = Math.max(0, Math.min(expireIn - TOKEN_REFRESH_MARGIN_SECONDS, TOKEN_MAX_CACHE_SECONDS))
    cached = { token, expiresAt: Date.now() + cacheSeconds * 1000 }
    return token
  }

  async function accessToken(): Promise<string> {
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.token
    // Reply bursts share one refresh rather than stampeding the token endpoint.
    pending ??= fetchToken().finally(() => { pending = undefined })
    return await pending
  }

  function textPayload(text: string): { readonly msgKey: string; readonly msgParam: string } {
    // The reference implementation's outbound format selection (dingtalk.py:387-399): Markdown for
    // normal replies, plain text for an oversized payload.
    if (Array.from(text).length > DINGTALK_TEXT_LIMIT) {
      return { msgKey: 'sampleText', msgParam: JSON.stringify({ content: text }) }
    }
    return { msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'Tentacle', text }) }
  }

  return {
    async openConnection(signal) {
      // Exact Stream handshake shape from dingtalk-stream stream.py:148-181 and
      // the chatbot topic from chatbot.py:158-160. localIp is optional in the
      // Node SDK; an empty value preserves the Python shape without probing the
      // host network merely to decorate a handshake.
      const { payload } = await request(`${streamBase}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          subscriptions: [{ type: 'CALLBACK', topic: CHATBOT_TOPIC }],
          ua: 'tentacle-dingtalk/1.0',
          localIp: '',
        }),
        ...(signal === undefined ? {} : { signal }),
      }, 'open stream connection', true)
      const endpoint = payload['endpoint']
      const ticket = payload['ticket']
      if (typeof endpoint !== 'string' || endpoint === '' || typeof ticket !== 'string' || ticket === '') {
        throw new DingTalkError('invalid-response', 'dingtalk stream handshake carried no endpoint/ticket')
      }
      return { endpoint, ticket }
    },

    async sendSessionWebhook(webhook, text) {
      // Reply mode takes precedence over proactive OpenAPI whenever an inbound
      // message supplied a webhook (the reference implementation's dingtalk.py:270-283,344-375).
      const markdown = Array.from(text).length <= DINGTALK_TEXT_LIMIT
      const { payload } = await request(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(markdown
          ? { msgtype: 'markdown', markdown: { title: 'Tentacle', text } }
          : { msgtype: 'text', text: { content: text } }),
      }, 'session webhook send')
      const errcode = payload['errcode']
      if (typeof errcode === 'number' && errcode !== 0) {
        throw new DingTalkError('api', `dingtalk session webhook send failed (${errcode})`)
      }
    },

    async sendDirectMessage(userId, text) {
      const token = await accessToken()
      const format = textPayload(text)
      try {
        const { payload } = await request(`${apiBase}/v1.0/robot/oToMessages/batchSend`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-acs-dingtalk-access-token': token,
          },
          body: JSON.stringify({
            // The reference implementation effective_robot_code falls back to app_key/clientId
            // (dingtalk.py:57-60,394-399); robotCode is required by this API.
            robotCode,
            userIds: [userId],
            msgKey: format.msgKey,
            msgParam: format.msgParam,
          }),
        }, 'direct message send')
        if (typeof payload['processQueryKey'] !== 'string' && typeof payload['requestId'] !== 'string') {
          throw new DingTalkError('api', 'dingtalk direct message send returned no processQueryKey/requestId')
        }
      } catch (error) {
        // A 401 makes the cached token unusable even if its local TTL has not
        // elapsed. The next send obtains a fresh one; do not retry the user
        // message automatically and risk a duplicate after an ambiguous send.
        if (error instanceof DingTalkError && error.status === 401) cached = undefined
        throw error
      }
    },
  }
}

function publicError(payload: JsonObject, clientSecret: string): string | undefined {
  const raw = payload['errmsg'] ?? payload['message']
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  // Platform errors are useful diagnostics, but a broken upstream can echo a
  // request field. Redact the one high-entropy secret this client owns.
  return raw.split(clientSecret).join('[redacted]').slice(0, 300)
}
