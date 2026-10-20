/**
 * QQ official-bot channel adapter: OAuth + WebSocket gateway inbound and REST
 * outbound. The lifecycle follows the reference implementation's channel.py literally: HELLO supplies
 * the heartbeat cadence, IDENTIFY/RESUME use QQBot OAuth tokens, op=7 preserves
 * the session for RESUME, and a non-resumable op=9 forces a fresh token.
 *
 * There is deliberately no C2C streaming path (qq/stream.py is out of scope).
 */
import { createQQApi, type QQApi, type QQMessageType } from './qq-api.js'
import { splitMessage } from './telegram.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
} from '../types.js'

/**
 * The central integration adds `'qq'` to ChannelType. Until that shared-file
 * edit is applied, this assertion keeps this standalone deliverable typecheck-
 * able without touching types.ts; the runtime value is exactly `'qq'`.
 */
export const QQ_CHANNEL_TYPE = 'qq' as ChannelAdapter['channelType']
/**
 * Conservative Unicode-code-point send ceiling. UNVERIFIED: the supplied
 * The reference implementation's source and the official endpoint reference do not state the exact text
 * limit; chunking here prevents an unbounded single content field.
 */
export const QQ_MESSAGE_LIMIT = 4000
/** channel.py:77-89 — AT_MESSAGES | GUILD_MEMBERS | DIRECT_MESSAGE | GROUP_AND_C2C. */
export const QQ_DEFAULT_INTENTS = 1_107_300_354

const DEDUP_CAP = 1000 // channel.py:161-162, 1341-1352
const DEFAULT_HEARTBEAT_INTERVAL_MS = 41_250 // channel.py:303, 1172-1176
const MAX_RECONNECT_DELAY_MS = 60_000 // channel.py:310-311, 1151-1153

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10

const MESSAGE_EVENTS = new Set([
  'AT_MESSAGE_CREATE',
  'DIRECT_MESSAGE_CREATE',
  'C2C_MESSAGE_CREATE',
  'GROUP_AT_MESSAGE_CREATE',
  'GROUP_MESSAGE_CREATE',
  'MESSAGE_CREATE',
]) // channel.py:1302-1315

export interface QQCredentials {
  readonly appId: string
  readonly secret: string
}

export interface QQWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void
}

export type QQWebSocketFactory = (url: string) => QQWebSocket

export interface QQAdapterConfig {
  /** Managed channel-instance id; also prefixes every normalized message id. */
  readonly id: string
  readonly credentials: QQCredentials
  /** REST root; defaults to the reference implementation's https://api.sgroup.qq.com. */
  readonly apiBaseUrl?: string
  /** OAuth endpoint override used by local protocol fakes. */
  readonly accessTokenUrl?: string
  /** Override the default intent mask from channel.py:89. */
  readonly intents?: number
  readonly reconnectDelayMs?: number
  readonly maxReconnectDelayMs?: number
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /** Injectable REST seam; production uses the built-in-fetch client above. */
  readonly api?: QQApi
  /** Injectable only for tests; production defaults to Node 24's global WebSocket. */
  readonly webSocketFactory?: QQWebSocketFactory
}

interface ReplyRoute {
  readonly msgType: QQMessageType
  readonly targetId: string
  readonly messageId?: string
}

interface GatewayFrame {
  readonly op?: unknown
  readonly d?: unknown
  readonly s?: unknown
  readonly t?: unknown
}

type ConnectionOutcome = 'stopped' | 'closed' | 'server-reconnect' | 'invalid-session' | 'error'

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
    return this.get(key) !== undefined
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

export class QQAdapter implements ChannelAdapter {
  readonly channelType = QQ_CHANNEL_TYPE
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: QQ_MESSAGE_LIMIT,
    supportsTyping: false,
  }

  private readonly api: QQApi
  private readonly appId: string
  private readonly intents: number
  private readonly initialReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly socketFactory: QQWebSocketFactory
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private readonly seenMessages = new LruMap<true>(DEDUP_CAP)
  private readonly replyRoutes = new LruMap<ReplyRoute>(DEDUP_CAP)
  private readonly messageSequences = new LruMap<number>(DEDUP_CAP)
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private controller: AbortController | undefined
  private loop: Promise<void> | undefined
  private socket: QQWebSocket | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatSocket: QQWebSocket | undefined
  private gatewayUrl: string | undefined
  private sessionId: string | undefined
  private lastSequence: number | undefined
  private forceTokenRefresh = false
  private reconnectDelayMs: number
  private bot: { readonly id: string; readonly username?: string } | undefined
  private fatal: Error | undefined

  constructor(config: QQAdapterConfig, api?: QQApi) {
    if (config.id.trim() === '') throw new Error('qq adapter requires an instance id')
    if (config.credentials.appId.trim() === '' || config.credentials.secret.trim() === '') {
      throw new Error('qq adapter requires appId and secret credentials')
    }
    this.channelId = config.id
    this.appId = config.credentials.appId
    this.intents = config.intents ?? QQ_DEFAULT_INTENTS
    this.initialReconnectDelayMs = config.reconnectDelayMs ?? 1000
    this.maxReconnectDelayMs = config.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS
    if (this.initialReconnectDelayMs <= 0 || this.maxReconnectDelayMs < this.initialReconnectDelayMs) {
      throw new Error('qq adapter reconnect delays are invalid')
    }
    this.reconnectDelayMs = this.initialReconnectDelayMs
    this.log = config.log ?? (() => undefined)
    this.api = api ?? config.api ?? createQQApi({
      appId: config.credentials.appId,
      secret: config.credentials.secret,
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
      ...(config.accessTokenUrl === undefined ? {} : { accessTokenUrl: config.accessTokenUrl }),
    })
    this.socketFactory = config.webSocketFactory ?? nativeWebSocket
  }

  get identity(): { readonly id: string; readonly username?: string } | undefined {
    return this.bot
  }

  get failure(): Error | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<ChannelStartHandle> {
    if (this.controller !== undefined) throw new Error('qq adapter already started')
    try {
      // channel.py:363-377 obtains OAuth and /gateway/bot before spawning the
      // reconnecting socket loop. start() does not wait for READY.
      this.gatewayUrl = await this.api.getGatewayUrl(this.forceTokenRefresh)
      this.forceTokenRefresh = false
    } catch (error) {
      this.fatal = asError(error)
      throw this.fatal
    }
    this.fatal = undefined
    this.controller = new AbortController()
    this.loop = this.socketLoop(this.controller.signal)
    this.log('info', `qq adapter ${this.channelId} started`)
    return { stop: async () => await this.stop() }
  }

  async stop(): Promise<void> {
    const controller = this.controller
    if (controller === undefined) return
    controller.abort()
    this.stopHeartbeat()
    try {
      this.socket?.close(1000, 'adapter stopped')
    } catch {
      // The abort path also settles a socket which is still connecting.
    }
    await this.loop
    this.loop = undefined
    this.controller = undefined
    this.socket = undefined
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return

    // channel.py:412-436 infers proactive C2C/group routing from chat kind.
    // A route learned from an inbound event additionally preserves guild/direct
    // semantics and the passive msg_id which ChannelSubject cannot carry.
    const known = this.replyRoutes.get(subjectKey(subject))
    const msgType = known?.msgType ?? (subject.kind === 'dm' ? 'c2c' : 'group')
    const targetId = known?.targetId ?? subject.chatId
    if (targetId.trim() === '') throw new Error(`qq ${msgType} send target is empty`)
    const chunks = splitMessage(text, this.constraints.maxMessageChars)
    for (const chunk of chunks) {
      const body: Record<string, unknown> = { content: chunk }
      if (msgType === 'c2c' || msgType === 'group') body['msg_type'] = 0
      if (known?.messageId !== undefined) {
        body['msg_id'] = known.messageId
        // channel.py:1390-1401 requires an incrementing msg_seq for passive
        // C2C/group replies; guild channel/direct bodies do not carry it.
        if (msgType === 'c2c' || msgType === 'group') {
          body['msg_seq'] = this.nextMessageSequence(known.messageId)
        }
      }
      await this.api.sendMessage(msgType, targetId, body)
    }
  }

  private nextMessageSequence(messageId: string): number {
    const previous = this.messageSequences.get(messageId) ?? Math.floor(Date.now() / 1000) % 1_000_000
    const next = previous + 1
    this.messageSequences.set(messageId, next)
    return next
  }

  private async socketLoop(signal: AbortSignal): Promise<void> {
    // Backoff is reset ONLY by READY/RESUMED in handleFrame, not by a TCP/WS
    // handshake (channel.py:1105-1111, 1199-1210).
    while (!signal.aborted) {
      try {
        if (this.forceTokenRefresh || this.gatewayUrl === undefined) {
          const force = this.forceTokenRefresh
          this.gatewayUrl = await this.api.getGatewayUrl(force)
          this.forceTokenRefresh = false
        }
        const outcome = await this.connect(this.gatewayUrl, signal)
        if (outcome === 'stopped' || signal.aborted) return
        const wait = this.reconnectDelayMs
        if (outcome === 'server-reconnect') {
          // Routine op=7 rotation preserves seq/session and does not inflate
          // backoff (channel.py:1140-1146, 1217-1222).
          await delay(wait, signal)
          continue
        }
        if (outcome !== 'closed') this.log('warn', `qq gateway reconnecting in ${wait}ms`)
        await delay(wait, signal)
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs)
      } catch (error) {
        if (signal.aborted) return
        const wait = this.reconnectDelayMs
        this.log('warn', `qq gateway failure; reconnecting in ${wait}ms: ${describe(error)}`)
        await delay(wait, signal)
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs)
      }
    }
  }

  /** Own one socket until close/a gateway reconnect directive. */
  private async connect(url: string, signal: AbortSignal): Promise<ConnectionOutcome> {
    const socket = this.socketFactory(url)
    this.socket = socket
    return await new Promise<ConnectionOutcome>((resolve) => {
      let requested: ConnectionOutcome | undefined
      let settled = false
      let frames: Promise<void> = Promise.resolve()

      const finish = (outcome: ConnectionOutcome): void => {
        requested ??= outcome
        try { socket.close() } catch { /* already closed */ }
      }
      const onAbort = (): void => {
        finish('stopped')
        settleWhenFramesDrain()
      }
      signal.addEventListener('abort', onAbort, { once: true })

      const settleWhenFramesDrain = (): void => {
        void frames.finally(() => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          this.stopHeartbeat(socket)
          if (this.socket === socket) this.socket = undefined
          resolve(requested ?? 'closed')
        })
      }

      socket.addEventListener('message', (event) => {
        frames = frames.then(async () => {
          if (requested !== undefined || signal.aborted) return
          const raw = await rawText(event.data)
          if (raw === undefined) return
          let frame: GatewayFrame
          try {
            const parsed: unknown = JSON.parse(raw)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
            frame = parsed as GatewayFrame
          } catch {
            this.log('debug', 'qq gateway ignored a non-JSON frame')
            return
          }
          const directive = await this.handleFrame(socket, frame)
          if (directive !== undefined) finish(directive)
        }).catch((error: unknown) => {
          this.log('debug', `qq gateway frame failed: ${describe(error)}`)
          finish('error')
        }).finally(() => {
          if (requested !== undefined) settleWhenFramesDrain()
        })
      })
      socket.addEventListener('close', () => {
        finish(requested ?? 'closed')
        settleWhenFramesDrain()
      })
      socket.addEventListener('error', () => {
        finish('error')
        settleWhenFramesDrain()
      })
      if (signal.aborted) onAbort()
    })
  }

  /** @returns a reconnect directive, or undefined to keep this socket alive. */
  private async handleFrame(socket: QQWebSocket, frame: GatewayFrame): Promise<ConnectionOutcome | undefined> {
    const op = frame.op
    if (op === OP_HELLO) {
      const data = recordOf(frame.d)
      const rawInterval = data?.['heartbeat_interval']
      const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
        ? rawInterval
        : DEFAULT_HEARTBEAT_INTERVAL_MS
      this.startHeartbeat(socket, interval)
      if (this.sessionId !== undefined && this.lastSequence !== undefined) await this.sendResume(socket)
      else await this.sendIdentify(socket)
      return undefined
    }
    if (op === OP_DISPATCH) {
      if (typeof frame.s === 'number') this.lastSequence = frame.s
      const eventType = typeof frame.t === 'string' ? frame.t : ''
      const data = recordOf(frame.d) ?? {}
      if (eventType === 'READY') {
        const sessionId = data['session_id']
        this.sessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
        const user = recordOf(data['user'])
        const id = user?.['id']
        if (typeof id === 'string' && id !== '') {
          const username = user?.['username']
          this.bot = { id, ...(typeof username === 'string' && username !== '' ? { username } : {}) }
        }
        this.reconnectDelayMs = this.initialReconnectDelayMs
        this.log('info', `qq adapter ${this.channelId} gateway READY`)
        return undefined
      }
      if (eventType === 'RESUMED') {
        this.reconnectDelayMs = this.initialReconnectDelayMs
        this.log('info', `qq adapter ${this.channelId} gateway RESUMED`)
        return undefined
      }
      await this.consumeDispatch(eventType, data)
      return undefined
    }
    if (op === OP_RECONNECT) return 'server-reconnect'
    if (op === OP_INVALID_SESSION) {
      // channel.py:1224-1235: d=true may RESUME; d=false drops both cursor
      // and session and forces OAuth refresh before a fresh IDENTIFY.
      if (frame.d !== true) {
        this.sessionId = undefined
        this.lastSequence = undefined
        this.forceTokenRefresh = true
      }
      return 'invalid-session'
    }
    return undefined
  }

  private startHeartbeat(socket: QQWebSocket, intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatSocket = socket
    const beat = (): void => {
      if (this.heartbeatSocket !== socket) return
      try {
        // Heartbeat carries the latest DISPATCH sequence, or null before one
        // (channel.py:1282-1295).
        socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSequence ?? null }))
      } catch {
        try { socket.close() } catch { /* close event owns reconnect */ }
      }
    }
    beat()
    this.heartbeat = setInterval(beat, intervalMs)
  }

  private stopHeartbeat(socket?: QQWebSocket): void {
    if (socket !== undefined && this.heartbeatSocket !== socket) return
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.heartbeatSocket = undefined
  }

  private async sendIdentify(socket: QQWebSocket): Promise<void> {
    const token = await this.api.getAccessToken()
    socket.send(JSON.stringify({
      op: OP_IDENTIFY,
      d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1] },
    })) // channel.py:1237-1258
  }

  private async sendResume(socket: QQWebSocket): Promise<void> {
    const token = await this.api.getAccessToken()
    socket.send(JSON.stringify({
      op: OP_RESUME,
      d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSequence },
    })) // channel.py:1261-1279
  }

  private async consumeDispatch(eventType: string, data: Record<string, unknown>): Promise<void> {
    if (!MESSAGE_EVENTS.has(eventType)) return
    const id = data['id']
    if (typeof id !== 'string' || id === '') return
    // RESUME can replay deliveries. Dedupe before routing (channel.py:1332-1352).
    if (this.seenMessages.has(id)) return
    this.seenMessages.set(id, true)

    const author = recordOf(data['author'])
    if (author?.['bot'] === true) return
    const route = routeOf(eventType, data)
    if (route === undefined) return
    const senderId = senderOf(eventType, data)
    if (senderId === undefined) return
    if (route.kind === 'group' && !isQQBotMentioned(data, eventType, this.appId)) {
      this.log('debug', `qq adapter ${this.channelId} ignored an unmentioned group message`)
      return
    }
    const content = qqContentParts(data, eventType)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return

    this.replyRoutes.set(`${route.kind}:${route.chatId}`, {
      msgType: route.msgType,
      targetId: route.chatId,
      messageId: id,
    })
    const username = author?.['username']
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      messageId: `qq:${this.channelId}:${id}`,
      subject: { chatId: route.chatId, kind: route.kind },
      sender: {
        platformId: senderId,
        ...(typeof username === 'string' && username !== '' ? { displayName: username } : {}),
      },
      content,
      receivedAt: timestampOf(data['timestamp']),
      metadata: { eventType, messageId: id, msgType: route.msgType },
    }
    try {
      await handler(inbound)
    } catch (error) {
      // A router failure must not kill the gateway or cause a reconnect replay.
      this.log('warn', `qq adapter ${this.channelId} failed to route message ${id}: ${describe(error)}`)
    }
  }
}

interface NormalizedRoute {
  readonly kind: 'dm' | 'group'
  readonly chatId: string
  readonly msgType: QQMessageType
}

function routeOf(eventType: string, data: Record<string, unknown>): NormalizedRoute | undefined {
  if (eventType === 'C2C_MESSAGE_CREATE') {
    const author = recordOf(data['author'])
    const chatId = stringField(author?.['user_openid']) ?? stringField(data['user_openid'])
    return chatId === undefined ? undefined : { kind: 'dm', chatId, msgType: 'c2c' }
  }
  if (eventType === 'DIRECT_MESSAGE_CREATE') {
    const chatId = stringField(data['guild_id'])
    return chatId === undefined ? undefined : { kind: 'dm', chatId, msgType: 'direct' }
  }
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
    const chatId = stringField(data['group_openid']) ?? stringField(data['group_id'])
    return chatId === undefined ? undefined : { kind: 'group', chatId, msgType: 'group' }
  }
  const chatId = stringField(data['channel_id'])
  return chatId === undefined ? undefined : { kind: 'group', chatId, msgType: 'channel' }
}

function senderOf(eventType: string, data: Record<string, unknown>): string | undefined {
  const author = recordOf(data['author'])
  if (eventType === 'C2C_MESSAGE_CREATE') {
    return stringField(author?.['user_openid']) ?? stringField(author?.['id']) ?? stringField(data['user_openid'])
  }
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
    return stringField(author?.['member_openid']) ?? stringField(author?.['id']) ?? stringField(data['member_openid'])
  }
  return stringField(author?.['id']) ?? stringField(author?.['user_openid'])
}

/** Structured mention gate from channel.py:1850-1865. */
export function isQQBotMentioned(data: Record<string, unknown>, eventType: string, appId: string): boolean {
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') return true
  const mentions = Array.isArray(data['mentions']) ? data['mentions'] : []
  for (const value of mentions) {
    const mention = recordOf(value)
    if (mention === undefined) continue
    if (mention['is_you'] === true) return true
    const id = stringField(mention['id']) ?? stringField(mention['user_openid']) ?? stringField(mention['member_openid'])
    if (id === appId) return true
  }
  const content = typeof data['content'] === 'string' ? data['content'] : ''
  return content.includes(`<@!${appId}>`) || content.includes(`<@${appId}>`)
}

const MEDIA_TAG = /<qq(?:img|video|audio|file)\s+[^>]*?(?:src|url)\s*=\s*["']([^"']+)["'][^>]*?>/gi
const ANY_MENTION = /<@!?[A-Za-z0-9_-]+>\s*/i
const IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']

/** Normalize text, inline media and attachments (channel.py:1578-1671). */
export function qqContentParts(data: Record<string, unknown>, eventType = ''): ContentPart[] {
  const raw = typeof data['content'] === 'string' ? data['content'] : ''
  const parts: ContentPart[] = []
  for (const match of raw.matchAll(MEDIA_TAG)) {
    const reference = match[1]
    if (reference === undefined) continue
    if (/^<qqimg\s/i.test(match[0])) parts.push({ type: 'image', reference })
    else parts.push({ type: 'file', name: 'attachment', reference })
  }
  const clean = stripQQBotMention(raw.replace(MEDIA_TAG, ''), data, eventType)
  const texts: string[] = clean === '' ? [] : [clean]

  const attachments = Array.isArray(data['attachments']) ? data['attachments'] : []
  const references = new Set(parts.map((part) => part.type === 'text' ? '' : part.reference))
  for (const value of attachments) {
    const attachment = recordOf(value)
    if (attachment === undefined) continue
    const contentType = stringField(attachment['content_type'])?.toLowerCase() ?? ''
    const wavUrl = stringField(attachment['voice_wav_url'])
    const voice = contentType === 'voice' || contentType.startsWith('audio/') || wavUrl !== undefined
    const transcript = stringField(attachment['asr_refer_text'])
    if (voice && transcript !== undefined) {
      if (!texts.includes(transcript)) texts.push(transcript)
      continue
    }
    const rawUrl = voice && wavUrl !== undefined ? wavUrl : stringField(attachment['url'])
    if (rawUrl === undefined) {
      texts.push(`[qq: unsupported attachment "${contentType || 'unknown'}"]`)
      continue
    }
    const reference = rawUrl.startsWith('//') ? `https:${rawUrl}` : /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    if (references.has(reference)) continue
    references.add(reference)
    const name = stringField(attachment['filename']) ?? stringField(attachment['file_name']) ?? stringField(attachment['name']) ?? 'attachment'
    if (contentType.startsWith('image/') || isImageUrl(reference, name)) parts.push({ type: 'image', reference })
    else parts.push({ type: 'file', name, reference })
  }
  if (texts.length > 0) parts.unshift({ type: 'text', text: texts.join('\n') })
  if (parts.length === 0 && (
    (Array.isArray(data['msg_elements']) && data['msg_elements'].length > 0)
    || data['ark_data'] !== undefined
  )) {
    return [{ type: 'text', text: '[qq: unsupported rich message]' }]
  }
  return parts
}

function stripQQBotMention(text: string, data: Record<string, unknown>, eventType: string): string {
  let clean = text
  const mentions = Array.isArray(data['mentions']) ? data['mentions'] : []
  for (const value of mentions) {
    const mention = recordOf(value)
    if (mention?.['is_you'] !== true) continue
    for (const key of ['id', 'user_openid', 'member_openid']) {
      const id = stringField(mention[key])
      if (id !== undefined) clean = clean.replace(new RegExp(`<@!?${escapeRegExp(id)}>\\s*`, 'gi'), '')
    }
  }
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'AT_MESSAGE_CREATE') {
    clean = clean.replace(ANY_MENTION, '')
  }
  return clean.trim()
}

function isImageUrl(url: string, filename: string): boolean {
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  return IMAGE_SUFFIXES.some((suffix) => path.endsWith(suffix) || filename.toLowerCase().endsWith(suffix))
}

function timestampOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function nativeWebSocket(url: string): QQWebSocket {
  const Constructor = (globalThis as unknown as { WebSocket?: new (url: string) => QQWebSocket }).WebSocket
  if (Constructor === undefined) throw new Error('qq adapter requires Node 24 global WebSocket')
  return new Constructor(url)
}

function subjectKey(subject: ChannelSubject): string {
  return `${subject.kind}:${subject.chatId}`
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
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

async function rawText(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (typeof data === 'object' && data !== null && 'text' in data) {
    const text = (data as { text?: unknown }).text
    if (typeof text === 'function') return await (text as () => Promise<string>).call(data)
  }
  return undefined
}
