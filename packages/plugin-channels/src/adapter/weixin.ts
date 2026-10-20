/**
 * WeChat personal-account (iLink Bot) channel adapter.
 *
 * The transport and cursor mirror the reference implementation:
 * - channel.py:716-766: 35s getUpdates loop, server-supplied timeout, -14 pause;
 *   a -14 session is NOT a start failure — the loop keeps retrying every
 *   `sessionPauseMs` (default 5min) while the console reports "disconnected";
 * - channel.py:721-742: opaque getUpdatesBuf progression (persisted here through
 *   OffsetStore under the adapter instance id); a -14 clears it (protocol §9.2);
 * - channel.py:768-783: only message_type=1 is a user message, and inbound
 *   contextToken is cached for subsequent sends;
 * - channel.py:240-288: sends reuse refreshed context tokens and retry once
 *   without a token after -14/-2.
 *
 * There is no bot-info endpoint in api.py. start() therefore awaits the first
 * successful getUpdates before exposing the account identity / returning a
 * connected handle. No connection pool is hand-rolled: weixin-api.ts uses the
 * Node 24 global fetch and this class owns only AbortControllers.
 */
import { createHash } from 'node:crypto'
import {
  createWeixinApi,
  WEIXIN_CHANNEL_TYPE,
  WEIXIN_DEFAULT_LONG_POLL_MS,
  WeixinError,
  type WeixinApi,
  type WeixinMessage,
  type WeixinMessageItem,
  type WeixinUpdates,
} from './weixin-api.js'
import { splitMessage } from './telegram.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
  OffsetStore,
} from '../types.js'

export { WEIXIN_CHANNEL_TYPE } from './weixin-api.js'

/**
 * Conservative local outbound chunk size, not a claimed iLink hard limit.
 * UNVERIFIED: the supplied protocol reference publishes no text-length limit.
 */
export const WEIXIN_MESSAGE_LIMIT = 4_000

const USER_MESSAGE_TYPE = 1
const SESSION_EXPIRED_CODE = -14
const AUTH_FAILED_CODE = -2
const SESSION_PAUSE_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60_000

export interface WeixinCredentials {
  /** Exact credential-map keys produced by WeixinProvisionFlow. */
  readonly accountId: string
  readonly token: string
}

export interface WeixinAdapterConfig {
  /** Managed channel instance id; also the OffsetStore key. */
  readonly id: string
  readonly credentials: WeixinCredentials
  /** Defaults to https://ilinkai.weixin.qq.com (channel.py:41). */
  readonly baseUrl?: string
  /** Optional fixed X-WECHAT-UIN value. */
  readonly botUin?: string
  /** Initial long-poll timeout; the server may replace it per response. */
  readonly pollTimeoutMs?: number
  /** Initial transport-error backoff; tests inject a small value. */
  readonly retryBaseMs?: number
  /** -14 pause; production default is five minutes (channel.py:64-70). */
  readonly sessionPauseMs?: number
  readonly offsetStore?: OffsetStore
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /** Injected protocol seam for deterministic adapter tests. */
  readonly api?: WeixinApi
}

export class WeixinAdapter implements ChannelAdapter {
  // The central integration adds 'weixin' to ChannelType. Keeping the value
  // typed through the port lets this new file typecheck before that one-line
  // shared-union edit is applied, while the runtime value is always 'weixin'.
  readonly channelType: ChannelAdapter['channelType'] = WEIXIN_CHANNEL_TYPE as ChannelAdapter['channelType']
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: WEIXIN_MESSAGE_LIMIT,
    // This adapter does not implement getConfig/sendTyping, so it must not
    // advertise a typing capability to the router.
    supportsTyping: false,
  }

  private readonly api: WeixinApi
  private readonly credentials: WeixinCredentials
  private readonly retryBaseMs: number
  private readonly sessionPauseMs: number
  private readonly offsetStore: OffsetStore | undefined
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private controller: AbortController | undefined
  private loop: Promise<void> | undefined
  private cursorWrite: Promise<void> = Promise.resolve()
  private buf = ''
  private pollTimeoutMs: number
  private bot: { readonly id: string } | undefined
  private fatal: Error | undefined
  private readonly contextTokens = new Map<string, string>()

  constructor(config: WeixinAdapterConfig, api?: WeixinApi) {
    if (config.id.trim() === '') throw new Error('weixin adapter requires an instance id')
    if (config.credentials.accountId.trim() === '' || config.credentials.token.trim() === '') {
      throw new Error('weixin adapter requires accountId and token credentials')
    }
    this.channelId = config.id
    this.credentials = config.credentials
    this.pollTimeoutMs = config.pollTimeoutMs ?? WEIXIN_DEFAULT_LONG_POLL_MS
    this.retryBaseMs = config.retryBaseMs ?? 1_000
    this.sessionPauseMs = config.sessionPauseMs ?? SESSION_PAUSE_MS
    this.offsetStore = config.offsetStore
    this.log = config.log ?? (() => undefined)
    this.api = api ?? config.api ?? createWeixinApi({
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      token: config.credentials.token,
      ...(config.botUin === undefined ? {} : { botUin: config.botUin }),
    })
  }

  get identity(): { readonly id: string } | undefined {
    return this.bot
  }

  get failure(): Error | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  /**
   * Restore the opaque buf, then use the first successful getUpdates as the
   * identity/auth check (there is no getBotInfo in the supplied API source).
   *
   * A session-expired (-14) first round trip is NOT fatal: the reference implementation's weixin
   * channel pauses five minutes and retries forever (channel.py:746-755)
   * because the platform can revive a paused session, and the console
   * meanwhile reports "disconnected" with an actionable hint. Treating it as a
   * permanent start failure (the old behaviour) stranded the instance until
   * someone toggled enable by hand.
   */
  async start(): Promise<ChannelStartHandle> {
    if (this.controller !== undefined) throw new Error('weixin adapter already started')
    const controller = new AbortController()
    this.controller = controller
    const persisted = await this.offsetStore?.load(this.channelId).catch(() => undefined)
    this.buf = typeof persisted === 'string' ? persisted : ''
    try {
      const first = await this.api.getUpdates(this.buf, this.pollTimeoutMs, controller.signal)
      // A successful authenticated round trip is the only identity probe the
      // platform exposes. accountId comes from the credential, not a response.
      this.bot = { id: this.credentials.accountId }
      this.fatal = undefined
      await this.acceptUpdates(first, controller.signal)
      if (controller.signal.aborted) throw new WeixinError('aborted', 'weixin adapter stopped during start')
    } catch (error) {
      if (!isSessionExpired(error)) {
        if (this.controller === controller) this.controller = undefined
        throw error
      }
      // Keep retrying in the same loop a connected adapter would have used.
      // The stale cursor/context of the dead session are meaningless (§9.2).
      this.buf = ''
      this.contextTokens.clear()
      this.persistCursor('')
      this.fatal = sessionExpiredError()
      this.log('warn', 'weixin session expired at start; retrying after the pause (scan a new QR via the console to recover)')
    }
    this.loop = this.pollLoop(controller.signal)
    if (this.fatal === undefined) this.log('info', `weixin adapter started as ${this.credentials.accountId}`)
    return { stop: () => this.stop() }
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error('weixin adapter stopped'))
    this.controller = undefined
    await this.loop?.catch(() => undefined)
    this.loop = undefined
    // Cursor writes are fire-and-forget during polling, but never left hanging
    // at shutdown. A failed write only causes at-least-once replay on restart.
    await this.cursorWrite
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return

    for (const chunk of splitMessage(text, this.constraints.maxMessageChars)) {
      let contextToken = this.contextTokens.get(subject.chatId) ?? ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.api.sendTextMessage(subject.chatId, chunk, contextToken)
          if (result.context_token !== undefined && result.context_token !== '') {
            this.contextTokens.set(subject.chatId, result.context_token)
          }
          break
        } catch (error) {
          // channel.py:272-281 — a stale context token is retried once without
          // it for both session expiry (-14) and auth failure (-2).
          if (attempt === 0 && contextToken !== '' && isContextRetry(error)) {
            this.contextTokens.delete(subject.chatId)
            contextToken = ''
            continue
          }
          throw error
        }
      }
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoff = this.retryBaseMs
    while (!signal.aborted) {
      let updates: WeixinUpdates
      try {
        updates = await this.api.getUpdates(this.buf, this.pollTimeoutMs, signal)
        backoff = this.retryBaseMs
        // A successful retry after the -14 pause makes the instance connected
        // again; runtimeOf() observes failure on every overview call.
        this.fatal = undefined
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeixinError && error.code === 'timeout') {
          // api.py:140-153 / channel.py:759-761 — idle timeout is normal.
          continue
        }
        if (isSessionExpired(error)) {
          // Spec (§9.2): a -14 session's cursor is meaningless — clear it so a
          // revived/repaired session starts from a clean position. Context
          // tokens die with the session too.
          this.buf = ''
          this.contextTokens.clear()
          this.persistCursor('')
          this.fatal = sessionExpiredError()
          this.log('warn', `weixin session expired; paused ${Math.round(this.sessionPauseMs / 1000)}s before retrying (scan a new QR via the console to recover)`)
          await delay(this.sessionPauseMs, signal)
          continue
        }
        const wait = backoff
        this.log('warn', `weixin getUpdates failed; retrying in ${wait}ms (${errorName(error)})`)
        await delay(wait, signal)
        backoff = Math.min(Math.max(1, backoff * 2), MAX_BACKOFF_MS)
        continue
      }
      await this.acceptUpdates(updates, signal)
    }
  }

  /** Consume first, then durably advance buf: a crash replays rather than drops. */
  private async acceptUpdates(updates: WeixinUpdates, signal: AbortSignal): Promise<void> {
    if (updates.longpolling_timeout_ms !== undefined
      && Number.isFinite(updates.longpolling_timeout_ms)
      && updates.longpolling_timeout_ms > 0) {
      this.pollTimeoutMs = updates.longpolling_timeout_ms
    }
    for (const message of updates.msgs) {
      if (signal.aborted) return
      try {
        await this.consume(message)
      } catch (error) {
        // A malformed platform item must not kill the long-poll fiber. The
        // cursor still advances after the batch, matching router-failure policy.
        this.log('warn', `weixin: skipping malformed inbound message (${errorName(error)})`)
      }
    }
    if (signal.aborted || updates.get_updates_buf === '') return
    this.buf = updates.get_updates_buf
    this.persistCursor(this.buf)
  }

  private async consume(message: WeixinMessage): Promise<void> {
    // channel.py:768-771 — bot/system authors (message_type != 1) never prompt.
    if (message.message_type !== USER_MESSAGE_TYPE) return
    const fromUserId = message.from_user_id
    if (fromUserId === undefined || fromUserId === '') return
    if (message.context_token !== undefined && message.context_token !== '') {
      this.contextTokens.set(fromUserId, message.context_token)
    }
    const content = weixinContentParts(message)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return
    const nativeId = nativeMessageId(message)
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      messageId: `weixin:${this.channelId}:${nativeId}`,
      // UNVERIFIED: types.py:63-74 and channel.py:505-592 expose no group kind,
      // group id, author-in-group id, or mention flag. Do not invent one from
      // sessionId; every protocol-verified message is therefore a DM.
      subject: { chatId: fromUserId, kind: 'dm' },
      sender: { platformId: fromUserId, displayName: fromUserId },
      content,
      receivedAt: validTimestamp(message.create_time_ms) ?? Date.now(),
      metadata: {
        messageId: nativeId,
        ...(message.seq === undefined ? {} : { seq: message.seq }),
        ...(message.session_id === undefined ? {} : { sessionId: message.session_id }),
      },
    }
    try {
      await handler(inbound)
    } catch (error) {
      // Match Telegram's at-least-once cursor policy: a router refusal must not
      // pin every later iLink message behind one poisonous payload.
      this.log('warn', `weixin: routing message ${inbound.messageId} failed (${errorName(error)})`)
    }
  }

  private persistCursor(cursor: string): void {
    const store = this.offsetStore
    if (store === undefined) return
    this.cursorWrite = this.cursorWrite.then(async () => {
      try {
        await store.save(this.channelId, cursor)
      } catch (error) {
        this.log('warn', `weixin: persisting cursor failed (${errorName(error)})`)
      }
    })
  }
}

/** Normalize only fields present in the supplied wire contract. */
export function weixinContentParts(message: WeixinMessage): ContentPart[] {
  const parts: ContentPart[] = []
  const items = message.item_list ?? []
  for (const [index, item] of items.entries()) {
    switch (item.type) {
      case 1: {
        const text = item.text_item?.text || item.content || ''
        if (text !== '') parts.push({ type: 'text', text })
        break
      }
      case 2: {
        const reference = firstNonEmpty(item.image_item?.url, item.url) ?? mediaReference(message, 'image', index, item)
        parts.push(reference === undefined
          ? { type: 'text', text: '[weixin: image message without reference]' }
          : { type: 'image', reference })
        break
      }
      case 3: {
        const transcript = item.voice_item?.text ?? ''
        if (transcript !== '') parts.push({ type: 'text', text: transcript })
        else {
          const reference = mediaReference(message, 'voice', index, item)
          parts.push(reference === undefined
            ? { type: 'text', text: '[weixin: voice message without transcript]' }
            : { type: 'file', name: 'voice', reference })
        }
        break
      }
      case 4: {
        const reference = firstNonEmpty(item.file_item?.url, item.url) ?? mediaReference(message, 'file', index, item)
        const name = item.file_item?.file_name || item.filename || item.file_name || 'attachment'
        parts.push(reference === undefined
          ? { type: 'text', text: `[weixin: file message "${name}" without reference]` }
          : { type: 'file', name, reference })
        break
      }
      case 5: {
        const reference = firstNonEmpty(item.video_item?.url, item.url) ?? mediaReference(message, 'video', index, item)
        parts.push(reference === undefined
          ? { type: 'text', text: '[weixin: video message]' }
          : { type: 'file', name: 'video', reference })
        break
      }
      default:
        parts.push({ type: 'text', text: `[weixin: unsupported item type "${String(item.type ?? 'unknown')}"]` })
    }
  }
  // channel.py:574-575 has a raw text fallback when no item produced content.
  if (parts.length === 0 && message.content !== undefined && message.content !== '') {
    parts.push({ type: 'text', text: message.content })
  }
  return parts
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '')
}

/** Encrypted CDN media stays an honest stable reference; no bytes are fetched. */
function mediaReference(
  message: WeixinMessage,
  kind: 'image' | 'voice' | 'file' | 'video',
  index: number,
  item: WeixinMessageItem,
): string | undefined {
  const media = item.image_item?.media ?? item.voice_item?.media ?? item.file_item?.media ?? item.video_item?.media
  if (media?.encrypt_query_param === undefined || media.encrypt_query_param === '') return undefined
  return `weixin:${nativeMessageId(message)}:${kind}:${index}`
}

function nativeMessageId(message: WeixinMessage): string {
  if (message.message_id !== undefined) return String(message.message_id)
  if (message.seq !== undefined) return `seq-${message.seq}`
  // messageId is optional in types.py. A deterministic content fallback keeps
  // delivery identity stable across retries without pretending it came from iLink.
  return `derived-${createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 16)}`
}

function validTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function isSessionExpired(error: unknown): error is WeixinError {
  return error instanceof WeixinError && (error.errcode === SESSION_EXPIRED_CODE || error.ret === SESSION_EXPIRED_CODE)
}

/** Actionable -14 projection; the console shows this message verbatim. */
function sessionExpiredError(): WeixinError {
  return new WeixinError(
    'api',
    "weixin session expired (errcode=-14) — re-scan the QR code from this instance's connection section",
    { errcode: SESSION_EXPIRED_CODE, ret: SESSION_EXPIRED_CODE },
  )
}

function isContextRetry(error: unknown): boolean {
  return error instanceof WeixinError
    && [error.ret, error.errcode].some((code) => code === SESSION_EXPIRED_CODE || code === AUTH_FAILED_CODE)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
