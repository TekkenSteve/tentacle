/**
 * DingTalk Stream channel adapter.
 *
 * Inbound rides one authenticated WebSocket; outbound replies prefer the
 * sessionWebhook captured from the latest inbound message and otherwise use
 * robot/oToMessages/batchSend for a DM. The host's ChannelSubject intentionally
 * carries no platform reply context, so that webhook stays in this adapter's
 * bounded private map rather than leaking into durable conversation metadata.
 */
import {
  createDingTalkApi,
  DINGTALK_TEXT_LIMIT,
  DingTalkError,
  type DingTalkApi,
} from './dingtalk-api.js'
import { splitMessage } from './telegram.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ChannelType,
  ContentPart,
  InboundMessage,
} from '../types.js'

// The central integration widens ChannelType with this same literal. The cast
// keeps this isolated, new-files-only deliverable typechecking before that
// one-line shared-file change is applied.
export const DINGTALK_CHANNEL_TYPE = 'dingtalk' as ChannelType
export const DINGTALK_MESSAGE_LIMIT = DINGTALK_TEXT_LIMIT
export const DINGTALK_CHATBOT_TOPIC = '/v1.0/im/bot/messages/get'

const MAX_BACKOFF_MS = 60_000
const REPLY_CACHE_CAP = 500

export interface DingTalkCredentials {
  readonly clientId: string
  readonly clientSecret: string
  readonly robotCode?: string
}

export interface DingTalkAdapterConfig {
  readonly id: string
  readonly credentials: DingTalkCredentials
  /** REST base; defaults to the official v1.0 OpenAPI host. */
  readonly apiBaseUrl?: string
  /** Stream handshake base; endpoint/ticket still come from the platform. */
  readonly streamUrl?: string
  /** First reconnect delay; subsequent failed attempts double it. */
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /** Injectable client seam, matching the other channel adapters. */
  readonly api?: DingTalkApi
}

/** Wire fields read from a /v1.0/im/bot/messages/get callback's decoded data. */
export interface DingTalkChatbotData {
  readonly msgId?: string
  readonly msgtype?: string
  readonly text?: { readonly content?: unknown }
  readonly content?: unknown
  readonly conversationId?: string
  readonly conversationType?: string
  readonly conversationTitle?: string
  readonly senderId?: string
  readonly senderStaffId?: string
  readonly senderNick?: string
  readonly senderCorpId?: string
  readonly chatbotUserId?: string
  readonly isInAtList?: boolean
  readonly createAt?: number | string
  readonly sessionWebhook?: string
  readonly sessionWebhookExpiredTime?: number | string
}

interface StreamFrame {
  readonly type?: unknown
  readonly headers?: {
    readonly messageId?: unknown
    readonly topic?: unknown
    readonly [key: string]: unknown
  }
  readonly data?: unknown
}

interface StreamConnection {
  readonly socket: WebSocket
  readonly closed: Promise<void>
}

interface ReplyContext {
  readonly sessionWebhook?: string
}

/** Small insertion-ordered LRU used for both retry dedupe and reply contexts. */
class LruMap<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly cap: number) {}

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
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

export class DingTalkAdapter implements ChannelAdapter {
  readonly channelType = DINGTALK_CHANNEL_TYPE
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: DINGTALK_MESSAGE_LIMIT,
    supportsTyping: false,
  }

  private readonly api: DingTalkApi
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private controller: AbortController | undefined
  private current: StreamConnection | undefined
  private loop: Promise<void> | undefined
  private readChain: Promise<void> = Promise.resolve()
  private fatal: Error | undefined
  private readonly seenMessages = new LruMap<true>(REPLY_CACHE_CAP)
  private readonly replyContexts = new LruMap<ReplyContext>(REPLY_CACHE_CAP)

  constructor(config: DingTalkAdapterConfig, api?: DingTalkApi) {
    if (config.id.trim() === '') throw new Error('dingtalk adapter requires an instance id')
    if (config.credentials.clientId.trim() === '' || config.credentials.clientSecret.trim() === '') {
      throw new Error('dingtalk adapter requires clientId and clientSecret credentials')
    }
    this.channelId = config.id
    this.reconnectBaseMs = config.reconnectBaseMs ?? 1_000
    this.reconnectMaxMs = config.reconnectMaxMs ?? MAX_BACKOFF_MS
    this.log = config.log ?? (() => undefined)
    this.api = api ?? config.api ?? createDingTalkApi({
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
      ...(config.streamUrl === undefined ? {} : { streamUrl: config.streamUrl }),
      clientId: config.credentials.clientId,
      clientSecret: config.credentials.clientSecret,
      ...(config.credentials.robotCode === undefined ? {} : { robotCode: config.credentials.robotCode }),
    })
  }

  /** Non-recoverable authentication/configuration failure, when one occurred. */
  get failure(): Error | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  /**
   * A full connections/open + WebSocket-open handshake is the identity check.
   * DingTalk exposes no bot-info call in the cited protocol, and the Python SDK
   * starts its read loop immediately after this point (stream.py:60-79,148-181).
   */
  async start(): Promise<ChannelStartHandle> {
    if (this.controller !== undefined) throw new Error('dingtalk adapter already started')
    this.fatal = undefined
    const controller = new AbortController()
    this.controller = controller
    try {
      const connection = await this.connect(controller.signal)
      this.current = connection
      this.loop = this.reconnectLoop(connection, controller.signal)
      this.log('info', `dingtalk adapter ${this.channelId} connected`)
      return { stop: () => this.stop() }
    } catch (error) {
      if (isFatal(error)) this.fatal = asError(error)
      controller.abort()
      this.controller = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    controller?.abort(new Error('dingtalk adapter stopped'))
    const current = this.current
    this.current = undefined
    if (current !== undefined) closeSocket(current.socket)
    await this.loop?.catch(() => undefined)
    this.loop = undefined
    await this.readChain
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return
    const context = this.replyContexts.get(subjectKey(subject))
    try {
      for (const chunk of splitMessage(text, this.constraints.maxMessageChars)) {
        if (context?.sessionWebhook !== undefined) {
          await this.api.sendSessionWebhook(context.sessionWebhook, chunk)
        } else {
          if (subject.kind !== 'dm') {
            // The cited fallback is oToMessages (a DM API), not a group
            // send API (dingtalk.py:378-407). Never silently turn a group reply
            // into a DM to a conversation id.
            throw new DingTalkError('api', 'dingtalk group reply requires a live sessionWebhook')
          }
          await this.api.sendDirectMessage(subject.chatId, chunk)
        }
      }
    } catch (error) {
      if (isFatal(error)) this.fatal = asError(error)
      throw error
    }
  }

  /** Open one ticketed socket and resolve only after its WS OPEN transition. */
  private async connect(signal: AbortSignal): Promise<StreamConnection> {
    const ticketed = await this.api.openConnection(signal)
    if (signal.aborted) throw new DingTalkError('transport', 'dingtalk adapter stopped')
    let socket: WebSocket
    try {
      // quote_plus in stream.py:73 is equivalent for a query parameter; encode
      // every reserved ticket character instead of concatenating it raw.
      socket = new WebSocket(`${ticketed.endpoint}${ticketed.endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticketed.ticket)}`)
    } catch {
      throw new DingTalkError('transport', 'dingtalk websocket constructor failed')
    }

    let openSettled = false
    let resolveOpen!: () => void
    let rejectOpen!: (error: Error) => void
    let resolveClosed!: () => void
    const opened = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve
      rejectOpen = reject
    })
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    const connection: StreamConnection = { socket, closed }

    socket.addEventListener('open', () => {
      openSettled = true
      resolveOpen()
    }, { once: true })
    socket.addEventListener('message', (event) => {
      this.readChain = this.readChain
        .then(async () => {
          const text = await websocketText(event.data)
          await this.handleFrame(socket, text)
        })
        .catch((error: unknown) => {
          // Frame contents and platform credentials are never logged here.
          this.log('warn', `dingtalk frame processing failed: ${describe(error)}`)
        })
    })
    socket.addEventListener('error', () => {
      const error = new DingTalkError('transport', 'dingtalk websocket transport failed')
      if (!openSettled) {
        openSettled = true
        rejectOpen(error)
      }
      closeSocket(socket)
    })
    socket.addEventListener('close', () => {
      resolveClosed()
      if (!openSettled) {
        openSettled = true
        rejectOpen(new DingTalkError('transport', 'dingtalk websocket closed before open'))
      }
    }, { once: true })

    try {
      await opened
      if (signal.aborted) throw new DingTalkError('transport', 'dingtalk adapter stopped')
      return connection
    } catch (error) {
      closeSocket(socket)
      throw error
    }
  }

  /**
   * Reconnect with exponential backoff. A successful WS OPEN is READY for this
   * adapter and resets the sequence, matching the SDK's start-of-read-loop
   * boundary; consecutive failed handshakes are the attempts that back off.
   */
  private async reconnectLoop(initial: StreamConnection, signal: AbortSignal): Promise<void> {
    let connection: StreamConnection | undefined = initial
    let backoff = this.reconnectBaseMs
    while (!signal.aborted) {
      if (connection !== undefined) {
        await connection.closed
        if (this.current === connection) this.current = undefined
        connection = undefined
        if (signal.aborted) return
      }
      this.log('debug', `dingtalk reconnecting in ${backoff}ms`)
      if (!await delay(backoff, signal)) return
      try {
        connection = await this.connect(signal)
        this.current = connection
        backoff = this.reconnectBaseMs
        this.log('info', `dingtalk adapter ${this.channelId} reconnected`)
      } catch (error) {
        if (signal.aborted) return
        if (isFatal(error)) {
          this.fatal = asError(error)
          this.log('warn', `dingtalk adapter stopped after fatal platform error: ${describe(error)}`)
          return
        }
        this.log('warn', `dingtalk reconnect failed: ${describe(error)}`)
        backoff = Math.min(backoff * 2, this.reconnectMaxMs)
      }
    }
  }

  private async handleFrame(socket: WebSocket, raw: string): Promise<void> {
    const frame = parseFrame(raw)
    if (frame === undefined) {
      this.log('debug', 'dingtalk ignored a malformed stream frame')
      return
    }
    if (frame.type === 'SYSTEM') {
      await this.handleSystemFrame(socket, frame)
      return
    }
    if (frame.type !== 'CALLBACK' || frame.headers?.topic !== DINGTALK_CHATBOT_TOPIC) return

    let data: DingTalkChatbotData
    try {
      // CallbackMessage.from_dict JSON-decodes data (frames.py:143-160), and
      // The reference implementation accepts the resulting dict (dingtalk.py:741-760).
      const decoded: unknown = JSON.parse(requireFrameData(frame))
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('not an object')
      data = decoded as DingTalkChatbotData
    } catch {
      sendAck(socket, frame, 500, 'handler error')
      return
    }

    await this.consumeChatbot(data, frame)
    // CallbackHandler.raw_process wraps the handler result as {response}
    // (handlers.py:26-33) and AckMessage serializes data (frames.py:221-239).
    sendAck(socket, frame, 200, 'OK')
  }

  private async handleSystemFrame(socket: WebSocket, frame: StreamFrame): Promise<void> {
    const topic = frame.headers?.topic
    if (topic === 'ping') {
      // SystemHandler.raw_process ACKs system messages and echoes their data
      // (handlers.py:58-77). This is the application-level ping/pong, separate
      // from the RFC 6455 control frames managed by Node's WebSocket itself.
      sendAck(socket, frame, 200, 'OK')
      return
    }
    if (topic === 'disconnect') {
      sendAck(socket, frame, 200, 'OK')
      // The SDK closes after a disconnect frame; the close event then follows
      // the same fresh-ticket reconnect path (stream.py:102-137).
      closeSocket(socket)
    }
  }

  private async consumeChatbot(data: DingTalkChatbotData, frame: StreamFrame): Promise<void> {
    const msgId = data.msgId
    if (msgId === undefined || msgId === '') return
    // Stream retries are at-least-once. Dedupe before filtering so repeated
    // chatter cannot repeatedly invoke policy or fill logs (design 08 §5).
    if (this.seenMessages.has(msgId)) return
    this.seenMessages.set(msgId, true)

    // A callback produced by this bot itself is a feedback loop. The public
    // message protocol exposes chatbotUserId but no general author-type flag.
    if (data.chatbotUserId !== undefined && data.chatbotUserId !== ''
      && (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId)) return

    const kind = data.conversationType === '1' ? 'dm' : data.conversationType === '2' ? 'group' : undefined
    if (kind === undefined) return
    // isInAtList is DingTalk's structured "this bot was @'d" fact; do not infer
    // mentions from natural-language text (ChatbotMessage chatbot.py:163-220).
    if (kind === 'group' && data.isInAtList !== true) {
      this.log('debug', `dingtalk ignored group message ${msgId} not addressed to the bot`)
      return
    }
    const senderId = firstNonEmpty(data.senderStaffId, data.senderId)
    if (senderId === undefined) return
    const chatId = kind === 'dm' ? senderId : firstNonEmpty(data.conversationId)
    if (chatId === undefined) return
    const content = dingtalkContentParts(data)
    if (content.length === 0) return

    const subject: ChannelSubject = { chatId, kind }
    this.replyContexts.set(subjectKey(subject), {
      ...(typeof data.sessionWebhook === 'string' && data.sessionWebhook !== ''
        ? { sessionWebhook: data.sessionWebhook }
        : {}),
    })
    const handler = this.handler
    if (handler === undefined) return
    const createAt = Number(data.createAt)
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      // The platform msgId is stable across retries; the instance prefix keeps
      // two DingTalk bots from sharing a delivery identity.
      messageId: `dingtalk:${this.channelId}:${msgId}`,
      subject,
      sender: {
        platformId: senderId,
        ...(data.senderNick === undefined || data.senderNick === '' ? {} : { displayName: data.senderNick }),
      },
      content,
      ...(data.conversationTitle === undefined || data.conversationTitle === ''
        ? {}
        : { groupContext: data.conversationTitle }),
      receivedAt: Number.isFinite(createAt) && createAt > 0 ? createAt : Date.now(),
      metadata: {
        messageId: msgId,
        ...(typeof frame.headers?.messageId === 'string' ? { streamMessageId: frame.headers.messageId } : {}),
        ...(data.conversationId === undefined ? {} : { conversationId: data.conversationId }),
        conversationType: data.conversationType,
      },
    }
    try {
      await handler(inbound)
    } catch (error) {
      // The reference implementation schedules callback processing before returning 200; likewise a
      // router failure must not create an endless platform retry storm.
      this.log('warn', `dingtalk routing message ${inbound.messageId} failed: ${describe(error)}`)
    }
  }
}

/** Normalize the callback body into the host's text/reference content union. */
export function dingtalkContentParts(data: DingTalkChatbotData): ContentPart[] {
  const type = data.msgtype ?? 'text'
  const content = asRecord(data.content)
  switch (type) {
    case 'text': {
      const text = data.text?.content
      return typeof text === 'string' && text !== ''
        ? [{ type: 'text', text: stripAtMention(text) }]
        : []
    }
    case 'richText': {
      const parts: ContentPart[] = []
      const items = content?.['richText']
      if (!Array.isArray(items)) return []
      let text = ''
      for (const raw of items) {
        const item = asRecord(raw)
        if (item === undefined) continue
        if (typeof item['text'] === 'string') text += item['text']
        const downloadCode = nonEmptyString(item['downloadCode'])
        if (downloadCode !== undefined) parts.push({ type: 'image', reference: `dingtalk:${downloadCode}` })
      }
      // The reference implementation concatenates rich-text runs without inventing separators
      // (dingtalk.py:625-630,687-708); keep their original order before media.
      return text === '' ? parts : [{ type: 'text', text }, ...parts]
    }
    case 'picture': {
      const downloadCode = nonEmptyString(content?.['downloadCode']) ?? nonEmptyString(content?.['pictureDownloadCode'])
      return downloadCode === undefined
        ? [{ type: 'text', text: '[dingtalk: picture without downloadCode]' }]
        : [{ type: 'image', reference: `dingtalk:${downloadCode}` }]
    }
    case 'file': {
      const name = nonEmptyString(content?.['fileName']) ?? 'file'
      const downloadCode = nonEmptyString(content?.['downloadCode'])
      return downloadCode === undefined
        ? [{ type: 'text', text: `[dingtalk: file "${name}" without downloadCode]` }]
        : [{ type: 'file', name, reference: `dingtalk:${downloadCode}` }]
    }
    case 'audio':
    case 'video': {
      const downloadCode = nonEmptyString(content?.['downloadCode'])
      return downloadCode === undefined
        ? [{ type: 'text', text: `[dingtalk: ${type} without downloadCode]` }]
        : [{ type: 'file', name: type, reference: `dingtalk:${downloadCode}` }]
    }
    default:
      return [{ type: 'text', text: `[dingtalk: unsupported message type "${type}"]` }]
  }
}

/** The reference implementation's leading @-mention cleanup (dingtalk.py:672-685), without regex NLP. */
export function stripAtMention(text: string): string {
  const stripped = text.trim()
  if (!stripped.startsWith('@')) return stripped === '' ? text : stripped
  const index = stripped.indexOf(' ')
  if (index > 0 && index < 30) {
    const withoutMention = stripped.slice(index + 1).trim()
    return withoutMention === '' ? text : withoutMention
  }
  return stripped === '' ? text : stripped
}

function parseFrame(raw: string): StreamFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as StreamFrame
      : undefined
  } catch {
    return undefined
  }
}

function requireFrameData(frame: StreamFrame): string {
  // The protocol carries data as a JSON STRING (frames.py:143-160). Do not
  // accept a second object-shaped dialect: one real wire shape keeps parsing
  // and ACK behavior unambiguous.
  if (typeof frame.data !== 'string' || frame.data === '') throw new Error('callback data is not a JSON string')
  return frame.data
}

function sendAck(socket: WebSocket, frame: StreamFrame, code: 200 | 500, message: string): void {
  if (socket.readyState !== 1 || typeof frame.headers?.messageId !== 'string') return
  const data = frame.type === 'CALLBACK'
    ? JSON.stringify({ response: message })
    : typeof frame.data === 'string'
      ? frame.data
      : JSON.stringify(frame.data ?? {})
  const ack = {
    code,
    headers: { messageId: frame.headers.messageId, contentType: 'application/json' },
    message,
    data,
  }
  try {
    socket.send(JSON.stringify(ack))
  } catch {
    // The close event owns reconnect/reporting; an ACK to an already closed
    // socket cannot be recovered and must not crash the read chain.
  }
}

async function websocketText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (typeof data === 'object' && data !== null && 'text' in data) {
    const text = (data as { readonly text?: unknown }).text
    if (typeof text === 'function') return await (text as () => Promise<string>).call(data)
  }
  return String(data)
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function subjectKey(subject: ChannelSubject): string {
  return `${subject.kind}:${subject.chatId}:${subject.threadId ?? ''}`
}

function closeSocket(socket: WebSocket): void {
  try {
    socket.close()
  } catch {
    // close() during a failed CONNECTING handshake is allowed to throw; the
    // close/error event that follows still settles the connection promise.
  }
}

function isFatal(error: unknown): boolean {
  return error instanceof DingTalkError
    && (error.code === 'config' || error.code === 'auth' || error.status === 401 || error.status === 403)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve false on abort so reconnect sleeps never outlive stop(). */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal.aborted)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
