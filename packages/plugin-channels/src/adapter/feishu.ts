/**
 * Feishu (Lark) channel adapter (design 06 §6: webhook push platform — the
 * first adapter that needs a public callback instead of a poll loop).
 *
 * Responsibilities, and nothing else:
 *
 * - own the callback verification story: `url_verification` challenge echo,
 *   optional `verificationToken` check, and — when an `encryptKey` is
 *   configured — `X-Lark-Signature` verification plus AES-256-CBC decryption
 *   of the `{encrypt}` envelope. All of it happens INSIDE the adapter because
 *   the gateway route is `public` (the platform cannot hold a Tentacle
 *   session), so this handler is the only authentication the hook has;
 * - normalize `im.message.receive_v1` events into {@link InboundMessage}
 *   (p2p vs group, the @-bot gate, mention-placeholder cleanup, media →
 *   reference-shaped parts), deduplicating by `event_id`;
 * - send replies through the tenant-token client, split at feishu's
 *   practical text limit, replying in-thread when the conversation has one.
 *
 * Push mode means there is no cursor and no `setOffset`: the platform
 * retries non-200 answers, and the in-memory event-id LRU (500 entries)
 * absorbs those retries. A restart may replay events the LRU forgot — an
 * accepted, documented trade-off (a durable event journal would buy
 * exactly-once at the cost of a new table for a platform that already
 * retries-at-least-once).
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { createFeishuApi, FeishuError, type FeishuApi } from './feishu-api.js'
import { splitMessage } from './telegram.js'
import type { ChannelHookHandler, ChannelHookReply, ChannelHookRequest } from '../service.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
} from '../types.js'

export const FEISHU_CHANNEL_TYPE = 'feishu'
/**
 * Practical single-message text ceiling. The documented limit is byte-based
 * and payload-dependent; 4000 Unicode code points (`Array.from` semantics,
 * shared with Telegram's {@link splitMessage}) stays safely under it.
 */
export const FEISHU_MESSAGE_LIMIT = 4000
/** Dedupe/thread LRU sizes: comfortably larger than any retry burst. */
const EVENT_CACHE_CAP = 500

/** The secrets one feishu instance runs with (from its credential record). */
export interface FeishuCredentials {
  readonly appId: string
  readonly appSecret: string
  /** Event-subscription encrypt key; its presence switches on encrypted mode. */
  readonly encryptKey?: string
  /** Plain-token callback check (unencrypted mode and challenge requests). */
  readonly verificationToken?: string
}

export interface FeishuAdapterConfig {
  /** Instance id of the channel this adapter serves (design 07 §1). */
  readonly id: string
  /** Open-platform root; injected so tests point at a fake server. */
  readonly apiBaseUrl?: string
  readonly credentials: FeishuCredentials
  /**
   * Registers the public callback route (`/tentacle/hooks/feishu/<id>`) and
   * returns its disposer. Absent when the deployment mounts no gateway —
   * a push platform without a public route cannot start, and says so.
   */
  readonly registerHook?: (handler: ChannelHookHandler) => () => void
  /** Structured diagnostics; the service passes its cordis logger through. */
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /** Injected client seam; tests may pass a scripted API instead of HTTP. */
  readonly api?: FeishuApi
}

// ---- wire shapes (only the fields this adapter reads) ---------------------

interface FeishuMention {
  readonly key?: string
  readonly id?: { readonly open_id?: string; readonly user_id?: string }
  readonly name?: string
}

interface FeishuEventMessage {
  readonly message_id?: string
  readonly chat_id?: string
  readonly chat_type?: string
  readonly message_type?: string
  /** JSON string whose shape depends on `message_type`. */
  readonly content?: string
  readonly thread_id?: string
  readonly create_time?: string
  readonly mentions?: readonly FeishuMention[]
}

interface FeishuEventSender {
  readonly sender_id?: { readonly open_id?: string; readonly user_id?: string }
  readonly sender_type?: string
}

interface FeishuEventEnvelope {
  readonly schema?: string
  readonly header?: {
    readonly event_id?: string
    readonly event_type?: string
    readonly create_time?: string
    readonly token?: string
  }
  readonly event?: {
    readonly sender?: FeishuEventSender
    readonly message?: FeishuEventMessage
  }
}

/**
 * Bounded insertion-ordered map used as an LRU: reading refreshes, inserting
 * past the cap evicts the oldest entry. Dedupe and thread bookkeeping both
 * need exactly this.
 */
class LruMap<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly cap: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}

/**
 * The `@_user_N` placeholder feishu puts in text content for a mention. The
 * mention list gives the display name, so placeholders are substituted when
 * known (`@Ada`) and stripped when not — a raw `@_user_1` must never reach a
 * prompt, it is wire format, not language.
 */
const MENTION_PLACEHOLDER = /@_user_\d+/g

/**
 * Normalize feishu message content into content parts. Text has its mention
 * placeholders resolved; image/file arrive as honest `feishu:<message_id>:<key>`
 * references (never downloaded — design 06 §6 defers media rendering); any
 * other type degrades to a deterministic placeholder so nothing is silently
 * dropped (the `ContentPart` contract forbids inventing new part types).
 */
export function feishuContentParts(message: FeishuEventMessage): ContentPart[] {
  let content: Record<string, unknown> = {}
  if (typeof message.content === 'string' && message.content !== '') {
    try {
      const parsed: unknown = JSON.parse(message.content)
      if (typeof parsed === 'object' && parsed !== null) content = parsed as Record<string, unknown>
    } catch {
      // Malformed content is a platform bug, not a routable message.
      return []
    }
  }
  switch (message.message_type) {
    case 'text': {
      const text = cleanMentionPlaceholders(typeof content['text'] === 'string' ? content['text'] : '', message.mentions ?? [])
      return text === '' ? [] : [{ type: 'text', text }]
    }
    case 'image': {
      const key = content['image_key']
      if (typeof key !== 'string' || key === '' || message.message_id === undefined) return []
      return [{ type: 'image', reference: `feishu:${message.message_id}:${key}` }]
    }
    case 'file': {
      const key = content['file_key']
      if (typeof key !== 'string' || key === '' || message.message_id === undefined) return []
      const name = typeof content['file_name'] === 'string' && content['file_name'] !== '' ? content['file_name'] : 'attachment'
      return [{ type: 'file', name, reference: `feishu:${message.message_id}:${key}` }]
    }
    default:
      return [{ type: 'text', text: `[feishu: unsupported message type "${message.message_type ?? 'unknown'}"]` }]
  }
}

/** Resolve `@_user_N` placeholders against the mention list, then tidy space. */
export function cleanMentionPlaceholders(text: string, mentions: readonly FeishuMention[]): string {
  const names = new Map<string, string>()
  for (const mention of mentions) {
    if (mention.key !== undefined && typeof mention.name === 'string' && mention.name !== '') {
      names.set(mention.key, mention.name)
    }
  }
  return text
    .replace(MENTION_PLACEHOLDER, (placeholder) => {
      const name = names.get(placeholder)
      return name === undefined ? '' : `@${name}`
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** A group message is routable only when the platform says the bot was @'d. */
export function isMentioned(message: Pick<FeishuEventMessage, 'mentions'>, botOpenId: string | undefined): boolean {
  if (botOpenId === undefined) return false
  return (message.mentions ?? []).some((mention) => mention.id?.open_id === botOpenId)
}

export class FeishuAdapter implements ChannelAdapter {
  readonly channelType = FEISHU_CHANNEL_TYPE
  /** Instance id: one app connection (design 07 §1). */
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: FEISHU_MESSAGE_LIMIT,
    // feishu has no typing indicator for bots.
    supportsTyping: false,
  }

  private readonly api: FeishuApi
  private readonly credentials: FeishuCredentials
  private readonly registerHook: ((handler: ChannelHookHandler) => () => void) | undefined
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private disposeHook: (() => void) | undefined
  private bot: { readonly id: string; readonly username?: string } | undefined
  /** Non-recoverable platform failure (tenant-token acquisition refused). */
  private fatal: Error | undefined
  /** event_id dedupe — feishu retries until it sees a 200. */
  private readonly seenEvents = new LruMap<true>(EVENT_CACHE_CAP)
  /** thread_id → a message_id inside it, so replies can land in the thread. */
  private readonly threadMessages = new LruMap<string>(EVENT_CACHE_CAP)

  constructor(config: FeishuAdapterConfig, api?: FeishuApi) {
    if (config.id === undefined || config.id.trim() === '') {
      throw new Error('feishu adapter requires an instance id')
    }
    if (config.credentials.appId.trim() === '' || config.credentials.appSecret.trim() === '') {
      throw new Error('feishu adapter requires appId and appSecret credentials')
    }
    this.channelId = config.id
    this.credentials = config.credentials
    this.registerHook = config.registerHook
    this.log = config.log ?? (() => undefined)
    this.api = api ?? config.api ?? createFeishuApi({
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
      appId: config.credentials.appId,
      appSecret: config.credentials.appSecret,
    })
  }

  /** The bot identity resolved by `start()`, for diagnostics and the admin API. */
  get identity(): { readonly id: number | string; readonly username?: string } | undefined {
    return this.bot
  }

  /** Non-recoverable platform error, if one was recorded. */
  get failure(): Error | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  /**
   * Verify the app credentials through `bot/v3/info` (a wrong pair must fail
   * at startup, not as silent dropped sends), then mount the public callback
   * route. Without a gateway there is no inbound path at all, so the adapter
   * refuses to start and the console reports the instance `failed`.
   */
  async start(): Promise<ChannelStartHandle> {
    if (this.disposeHook !== undefined) throw new Error('feishu adapter already started')
    if (this.registerHook === undefined) {
      throw new Error('gateway is required for feishu (callback route)')
    }
    try {
      const info = await this.api.getBotInfo()
      this.bot = { id: info.openId, ...(info.appName === undefined ? {} : { username: info.appName }) }
    } catch (error) {
      // Token acquisition is the whole auth story of this platform: when it
      // fails the adapter cannot do anything, so record it as the failure.
      if (error instanceof FeishuError && error.code === 'auth') this.fatal = error
      throw error
    }
    this.disposeHook = this.registerHook((request) => this.handleHook(request))
    this.log('info', `feishu adapter started as ${this.bot.username ?? this.bot.id}`)
    return { stop: () => this.stop() }
  }

  async stop(): Promise<void> {
    this.disposeHook?.()
    this.disposeHook = undefined
  }

  /**
   * The callback handler mounted on the public gateway route. Pure in/out
   * (request description → reply description) so tests drive it without any
   * HTTP stack; the service owns the `node:http` plumbing.
   */
  async handleHook(request: ChannelHookRequest): Promise<ChannelHookReply> {
    if (request.method !== 'POST') return { status: 405 }
    const payload = this.decode(request)
    if (payload === undefined) {
      // A failed signature/decrypt is a forgery or a misconfiguration: refuse
      // loudly enough to surface in the platform's retry console, never crash.
      return { status: 403 }
    }
    // Endpoint setup handshake — feishu requires the challenge echoed back.
    if (payload['type'] === 'url_verification') {
      if (!this.checkToken(payload['token'])) return { status: 403 }
      return { status: 200, json: { challenge: payload['challenge'] } }
    }
    const envelope = payload as unknown as FeishuEventEnvelope
    const header = envelope.header
    if (!this.checkToken(header?.token)) return { status: 403 }
    // Dedupe before dispatch: feishu retries any non-200, and a 200 for an
    // already-seen event is the cheapest correct answer.
    const eventId = header?.event_id
    if (eventId !== undefined && eventId !== '') {
      if (this.seenEvents.has(eventId)) return { status: 200, json: {} }
      this.seenEvents.set(eventId, true)
    }
    if (header?.event_type !== 'im.message.receive_v1') return { status: 200, json: {} }
    await this.consume(envelope)
    return { status: 200, json: {} }
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return
    const chunks = splitMessage(text, this.constraints.maxMessageChars)
    // A thread reply goes through the reply API with a message we saw in that
    // thread (the reply then lands inside it); a thread we never saw a
    // message for — or a plain chat — takes the direct send.
    const replyTo = subject.threadId === undefined ? undefined : this.threadMessages.get(subject.threadId)
    for (const chunk of chunks) {
      try {
        if (replyTo !== undefined) await this.api.replyTextMessage(replyTo, chunk)
        else await this.api.sendTextMessage(subject.chatId, chunk)
      } catch (error) {
        if (error instanceof FeishuError && error.code === 'auth') this.fatal = error
        throw error
      }
    }
  }

  // ---- inbound ------------------------------------------------------------

  /**
   * Verify + unwrap the request into the payload object. `undefined` means
   * "refuse": bad signature, undecryptable body, or malformed JSON. None of
   * these is exceptional — the route is public, so garbage is expected.
   */
  private decode(request: ChannelHookRequest): Record<string, unknown> | undefined {
    const encryptKey = this.credentials.encryptKey
    if (encryptKey === undefined || encryptKey === '') return parseJson(request.body)
    if (!this.verifySignature(request, encryptKey)) {
      this.log('debug', `feishu: rejected a callback with a bad signature on ${this.channelId}`)
      return undefined
    }
    const wrapped = parseJson(request.body)
    const encrypt = wrapped?.['encrypt']
    if (typeof encrypt !== 'string') return undefined
    return decryptEvent(encrypt, encryptKey)
  }

  /**
   * `X-Lark-Signature` = base64(sha256(timestamp + nonce + body + encryptKey)).
   * Compared in constant time: the route is public, so the signature IS the
   * authentication.
   */
  private verifySignature(request: ChannelHookRequest, encryptKey: string): boolean {
    const timestamp = request.header('x-lark-request-timestamp')
    const nonce = request.header('x-lark-request-nonce')
    const signature = request.header('x-lark-signature')
    if (timestamp === undefined || nonce === undefined || signature === undefined) return false
    const expected = createHash('sha256').update(timestamp + nonce + request.body + encryptKey).digest('base64')
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** The plain-token check: skipped unless a verification token is configured. */
  private checkToken(token: unknown): boolean {
    const expected = this.credentials.verificationToken
    if (expected === undefined || expected === '') return true
    return typeof token === 'string' && token === expected
  }

  private async consume(envelope: FeishuEventEnvelope): Promise<void> {
    const message = envelope.event?.message
    const sender = envelope.event?.sender
    if (message === undefined || sender === undefined) return
    // Never prompt on another bot's output: that is a feedback loop, not a user.
    if (sender.sender_type === 'app') return
    const platformId = sender.sender_id?.open_id ?? sender.sender_id?.user_id
    if (platformId === undefined || message.chat_id === undefined || message.message_id === undefined) return
    const kind = message.chat_type === 'p2p' ? 'dm' : message.chat_type === 'group' ? 'group' : undefined
    if (kind === undefined) return
    // Group gate (06 §6): only messages that @ the bot are routed.
    if (kind === 'group' && !isMentioned(message, this.bot?.id)) {
      this.log('debug', `feishu: ignoring group message ${message.message_id} not addressed to the bot`)
      return
    }
    if (message.thread_id !== undefined && message.thread_id !== '') {
      // Remember a message id per thread as soon as the message is accepted:
      // outbound replies use the reply API with it and land inside the
      // thread instead of the main chat.
      this.threadMessages.set(message.thread_id, message.message_id)
    }
    const content = feishuContentParts(message)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return
    const createTime = Number(envelope.header?.create_time ?? message.create_time)
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      messageId: `feishu:${message.chat_id}:${message.message_id}`,
      subject: {
        chatId: message.chat_id,
        kind,
        ...(message.thread_id === undefined || message.thread_id === ''
          ? {}
          : { threadId: message.thread_id }),
      },
      sender: {
        platformId,
        // feishu events carry no display name; the open_id is the only honest
        // label until the binding table resolves a tenant user.
        ...(sender.sender_id?.open_id === undefined ? {} : { displayName: sender.sender_id.open_id }),
        ...(sender.sender_type === 'app' ? { isBot: true } : {}),
      },
      content,
      receivedAt: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
      metadata: {
        ...(envelope.header?.event_id === undefined ? {} : { eventId: envelope.header.event_id }),
        messageId: message.message_id,
      },
    }
    try {
      await handler(inbound)
    } catch (error) {
      // The callback already answered 200-ward: a routing failure must not
      // turn into a platform retry storm for a message that will keep failing.
      this.log('warn', `feishu: routing message ${inbound.messageId} failed: ${describe(error)}`)
    }
  }
}

/**
 * Decrypt an `{encrypt}` payload: AES-256-CBC with key = sha256(encryptKey)
 * (raw bytes) and IV = the key's first 16 bytes, per the platform's event
 * subscription docs. Any failure returns undefined — a malformed or forged
 * payload is dropped, never crashed on.
 */
export function decryptEvent(encrypt: string, encryptKey: string): Record<string, unknown> | undefined {
  try {
    const key = createHash('sha256').update(encryptKey).digest()
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]).toString('utf8')
    return parseJson(plain)
  } catch {
    return undefined
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
