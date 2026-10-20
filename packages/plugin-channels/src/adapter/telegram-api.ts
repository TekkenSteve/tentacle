/**
 * Minimal HTTP client for the Telegram Bot API (design 06 §7: the adapter
 * talks to the platform through a thin injectable client so tests point it at
 * a local fake Bot API).
 *
 * `apiBaseUrl` is configuration, never a constant: the e2e suite and the unit
 * tests both run a fake Bot API on loopback, and a self-hosted Bot API server
 * uses the same seam. Zero third-party dependencies — `node:http`/`node:https`
 * only (the official `fetch` cannot express a long-poll read timeout).
 */
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'

export type TelegramErrorCode = 'config' | 'api' | 'transport' | 'invalid-response'

export class TelegramError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string,
    /** Telegram's own `error_code`, when it answered. */
    readonly status?: number,
    /** `retry_after` seconds from a 429, when the platform sent one. */
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'TelegramError'
  }
}

export interface TelegramApiOptions {
  /**
   * Bot API root without a trailing slash. Default `https://api.telegram.org`.
   * Injecting this is the whole testing story for the adapter.
   */
  readonly apiBaseUrl?: string
  /** Resolved bot token. Reads happen per call site, never cached here. */
  readonly token: string
  /**
   * Long-poll read timeout in seconds. Must be larger than the `timeout`
   * parameter of `getUpdates`, otherwise a healthy idle poll times out locally.
   */
  readonly readTimeoutSec?: number
}

/** One Bot API call, already unwrapped from the `{ ok, result }` envelope. */
export interface TelegramApi {
  listUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<readonly Update[]>
  sendMessage(chatId: string, text: string, threadId?: string, parseMode?: 'Markdown'): Promise<void>
  sendChatAction(chatId: string, action: 'typing', threadId?: string): Promise<void>
  getMe(): Promise<TelegramUser>
}

export interface TelegramUser {
  readonly id: number
  readonly is_bot: boolean
  readonly username?: string
  readonly first_name?: string
}

export interface TelegramChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
}

export interface TelegramMessageEntity {
  readonly type: string
  readonly offset: number
  readonly length: number
}

export interface TelegramMessage {
  readonly message_id: number
  readonly date: number
  readonly chat: TelegramChat
  readonly from?: TelegramUser
  readonly text?: string
  readonly caption?: string
  readonly entities?: readonly TelegramMessageEntity[]
  readonly caption_entities?: readonly TelegramMessageEntity[]
  readonly message_thread_id?: number
  readonly photo?: readonly { readonly file_id: string }[]
  readonly document?: { readonly file_id: string; readonly file_name?: string }
  readonly voice?: { readonly file_id: string }
  readonly audio?: { readonly file_id: string }
}

export interface Update {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly edited_message?: TelegramMessage
}

const DEFAULT_API_BASE_URL = 'https://api.telegram.org'
/** Allow headroom over the poll timeout before the socket itself gives up. */
const READ_TIMEOUT_HEADROOM_MS = 10_000

interface ApiEnvelope {
  ok?: boolean
  result?: unknown
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  const base = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  const readTimeoutMs = (options.readTimeoutSec ?? 60) * 1000 + READ_TIMEOUT_HEADROOM_MS

  async function call<T>(
    method: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (options.token.trim() === '') {
      throw new TelegramError('config', 'telegram bot token is empty')
    }
    const url = new URL(`${base}/bot${options.token}/${method}`)
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const envelope = await transport(url, body, signal)
    if (envelope.ok !== true) {
      const retryAfter = envelope.parameters?.retry_after
      throw new TelegramError(
        'api',
        `telegram ${method} failed: ${envelope.description ?? 'unknown error'}`,
        envelope.error_code,
        retryAfter,
      )
    }
    if (envelope.result === undefined) {
      throw new TelegramError('invalid-response', `telegram ${method} returned no result`)
    }
    return envelope.result as T
  }

  function transport(url: URL, body: string | undefined, signal?: AbortSignal): Promise<ApiEnvelope> {
    return new Promise<ApiEnvelope>((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(Buffer.byteLength(body))
      }
      const options: RequestOptions = {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        // A long poll holds the socket open; nothing may abort it early.
        timeout: readTimeoutMs,
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = send(url, options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: ApiEnvelope
          try {
            parsed = JSON.parse(text) as ApiEnvelope
          } catch {
            reject(new TelegramError('invalid-response', `telegram returned non-JSON: ${text.slice(0, 200)}`))
            return
          }
          resolve(parsed)
        })
      })
      req.on('timeout', () => req.destroy(new TelegramError('transport', `telegram read timeout after ${readTimeoutMs}ms`)))
      req.on('error', (error) => {
        // An abort is a controlled shutdown, not a transport failure.
        if (signal?.aborted === true || (error as Error).name === 'AbortError') {
          reject(new TelegramError('transport', 'telegram request aborted'))
          return
        }
        reject(error instanceof TelegramError ? error : new TelegramError('transport', String((error as Error).message)))
      })
      signal?.addEventListener('abort', () => req.destroy(new TelegramError('transport', 'telegram request aborted')), { once: true })
      req.end(body)
    })
  }

  return {
    async listUpdates(offset, timeoutSec, signal) {
      const result = await call<Update[]>('getUpdates', {
        offset,
        timeout: timeoutSec,
        // Only the update families this adapter routes are requested; Telegram
        // then drops the rest server-side instead of queueing them forever.
        allowed_updates: ['message'],
      }, signal)
      return result
    },
    async sendMessage(chatId, text, threadId, parseMode) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        ...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }),
        ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      })
    },
    async sendChatAction(chatId, action, threadId) {
      await call('sendChatAction', {
        chat_id: chatId,
        action,
        ...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }),
      })
    },
    async getMe() {
      return await call<TelegramUser>('getMe')
    },
  }
}
