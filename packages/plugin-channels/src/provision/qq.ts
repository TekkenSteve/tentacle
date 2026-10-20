/**
 * QQ official-bot scan-to-bind provisioning (design 08 §4).
 *
 * Protocol source: the reference implementation's QQ adapter.
 * login_qr.py:69-119, 145-171. The 32-byte AES key and task id live only in
 * ProvisionSession.data; the browser receives the QR URL, never the key or the
 * decrypted app secret (the host consumes the success result directly).
 */
import { createDecipheriv, randomBytes } from 'node:crypto'
import { QQ_CHANNEL_TYPE } from '../adapter/qq.js'
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

const DEFAULT_QQ_BIND_BASE_URL = 'https://q.qq.com'
const CREATE_BIND_TASK_PATH = '/lite/create_bind_task'
const POLL_BIND_RESULT_PATH = '/lite/poll_bind_result'
const STATUS_COMPLETED = 2
const STATUS_EXPIRED = 3
/** login_qr.py:121-139 uses a 480-second default wait window. */
const DEFAULT_TTL_MS = 480_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000 // login_qr.py:145-150

interface QQBindResult {
  readonly appId: string
  readonly secret: string
  readonly userOpenid?: string
}

interface QQBindState {
  readonly abort: AbortController
  readonly taskId: string
  readonly qrUrl: string
  /** One-time key; cleared on every terminal outcome and on stop. */
  key: string | undefined
  result: QQBindResult | undefined
  expired: boolean
  failure: string | undefined
}

export interface QQProvisionOptions {
  /** QR and bind API root; tests point this at a loopback fake. */
  readonly apiBaseUrl?: string
  /** QR `source` query value; the reference implementation's protocol value is the default. */
  readonly source?: string
  readonly now?: () => number
  readonly requestTimeoutMs?: number
}

export class QQProvisionFlow implements ProvisionFlow {
  readonly channelType = QQ_CHANNEL_TYPE

  constructor(private readonly options: QQProvisionOptions = {}) {}

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    const now = this.options.now ?? Date.now
    const key = randomBytes(32).toString('base64') // login_qr.py:76-85
    const abort = new AbortController()
    try {
      const data = await this.post(abort, CREATE_BIND_TASK_PATH, { key }, 'create bind task')
      const taskId = requiredString(data['task_id'], 'QQ create bind task response missing task_id')
      const query = new URLSearchParams({ task_id: taskId, source: this.options.source ?? 'tentacle', _wv: '2' })
      const base = (this.options.apiBaseUrl ?? DEFAULT_QQ_BIND_BASE_URL).replace(/\/+$/, '')
      const qrUrl = `${base}/qqbot/openclaw/connect.html?${query.toString()}`
      const state: QQBindState = {
        abort,
        taskId,
        qrUrl,
        key,
        result: undefined,
        expired: false,
        failure: undefined,
      }
      session.data = state
      return { qrUrl, pollAfterMs: 2000, expiresAt: now() + DEFAULT_TTL_MS }
    } catch (error) {
      abort.abort()
      session.data = undefined
      throw asError(error)
    }
  }

  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = asBindState(session.data)
    if (state === undefined) return { state: 'failed', error: 'QQ binding flow is not started' }
    if (state.result !== undefined) return successOf(state.result)
    if (state.expired) return { state: 'expired' }
    if (state.failure !== undefined) return { state: 'failed', error: state.failure }
    if (state.key === undefined) return { state: 'failed', error: 'QQ binding flow has no decryption key' }

    try {
      // The key is intentionally NOT sent to the poll endpoint; only task_id is
      // (login_qr.py:92-100).
      const data = await this.post(state.abort, POLL_BIND_RESULT_PATH, { task_id: state.taskId }, 'poll bind result')
      const status = Number(data['status'] ?? 0)
      if (!Number.isFinite(status)) throw new Error('QQ poll bind result carried an invalid status')
      if (status === STATUS_COMPLETED) {
        const appId = requiredString(data['bot_appid'], 'QQ bind result missing bot_appid')
        const encrypted = requiredString(data['bot_encrypt_secret'], 'QQ bind result missing bot_encrypt_secret')
        const secret = decryptQQSecret(encrypted, state.key)
        const userOpenid = optionalString(data['user_openid'])
        state.result = { appId, secret, ...(userOpenid === undefined ? {} : { userOpenid }) }
        state.key = undefined
        return successOf(state.result)
      }
      if (status === STATUS_EXPIRED) {
        state.key = undefined
        state.expired = true
        return { state: 'expired' }
      }
      // Every other platform status is pending (login_qr.py:115-119).
      return { state: 'waiting', qrUrl: state.qrUrl }
    } catch (error) {
      state.key = undefined
      state.failure = describe(error)
      return { state: 'failed', error: state.failure }
    }
  }

  async stop(session: ProvisionSession): Promise<void> {
    const state = asBindState(session.data)
    state?.abort.abort()
    if (state !== undefined) state.key = undefined
    // Dropping the object removes the one-time key and any decrypted result.
    session.data = undefined
  }

  private async post(
    abort: AbortController,
    path: string,
    body: Record<string, string>,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const base = (this.options.apiBaseUrl ?? DEFAULT_QQ_BIND_BASE_URL).replace(/\/+$/, '')
    const timeout = setTimeout(() => abort.abort(), this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    let response: Response
    let text: string
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
      text = await response.text()
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`QQ ${operation} request was cancelled or timed out`)
      throw new Error(`QQ ${operation} request failed: ${describe(error)}`)
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) throw new Error(`QQ ${operation} failed (HTTP ${response.status})`)

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`QQ ${operation} returned malformed JSON`)
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(`QQ ${operation} returned a malformed response`)
    }
    const envelope = payload as Record<string, unknown>
    const retcode = Number(envelope['retcode'] ?? 0)
    if (!Number.isFinite(retcode)) throw new Error(`QQ ${operation} returned an invalid retcode`)
    if (retcode !== 0) {
      // Platform messages are forwarded as UI errors, never logged. Bodies and
      // request credentials are deliberately absent from this message.
      const message = optionalString(envelope['msg'])
      throw new Error(`QQ ${operation} failed: ${message ?? `retcode ${retcode}`}`)
    }
    const data = envelope['data']
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`QQ ${operation} response missing data`)
    }
    return data as Record<string, unknown>
  }
}

/**
 * AES-256-GCM layout from login_qr.py:163-171:
 * base64(nonce[12] || ciphertext || authTag[16]); no associated data.
 */
export function decryptQQSecret(encryptedSecret: string, keyBase64: string): string {
  const encrypted = decodeBase64(encryptedSecret, 'encrypted credentials')
  const key = decodeBase64(keyBase64, 'binding key')
  if (key.length !== 32 || encrypted.length < 29) {
    throw new Error('QQ bind result contains invalid encrypted credentials')
  }
  const nonce = encrypted.subarray(0, 12)
  const ciphertextAndTag = encrypted.subarray(12)
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('QQ bind result credentials could not be decrypted')
  }
}

function successOf(result: QQBindResult): ProvisionPoll {
  return {
    state: 'success',
    credentials: { appId: result.appId, secret: result.secret },
    // user_openid is non-secret routing context, never a credential alias.
    ...(result.userOpenid === undefined ? {} : { config: { userOpenid: result.userOpenid } }),
  }
}

function decodeBase64(value: string, label: string): Buffer {
  // Python's base64.b64decode(..., validate=True) rejects non-alphabet input;
  // Buffer.from alone is deliberately lenient, so check the shape first.
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`QQ ${label} is not valid base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error(`QQ ${label} is not canonical base64`)
  return decoded
}

function asBindState(value: unknown): QQBindState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<QQBindState>
  return typeof candidate.taskId === 'string' && typeof candidate.qrUrl === 'string' && candidate.abort instanceof AbortController
    ? candidate as QQBindState
    : undefined
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value)
  if (result === undefined) throw new Error(message)
  return result
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
