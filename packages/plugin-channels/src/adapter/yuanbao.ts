/**
 * Tencent Yuanbao channel adapter.
 *
 * Transport and lifecycle follow channel.py in the archived reference:
 * sign-token → one binary WebSocket → auth-bind (105-123, 456-489), request
 * futures keyed by ConnMsg.head.msg_id (648-724), need_ack push ACKs (726-742),
 * 30-second ping (775-783), and bounded reconnect backoff (785-810).
 *
 * The optional `probeMode: 'sign_token'` is intentionally an ephemeral/test
 * probe setting, not an instance config field.  It performs only the HTTP
 * credential check and never constructs a second WS (the single-effective-WS
 * lesson documented in manager.py:604-609).
 */
import { Buffer } from 'node:buffer'
import {
  CMD_AUTH_BIND,
  CMD_INBOUND_MESSAGE,
  CMD_KICKOUT,
  CMD_PING,
  CMD_SEND_C2C_MESSAGE,
  CMD_SEND_GROUP_HEARTBEAT,
  CMD_SEND_GROUP_MESSAGE,
  CMD_SEND_PRIVATE_HEARTBEAT,
  CMD_TYPE_PUSH,
  CMD_TYPE_RESPONSE,
  CMD_UPDATE_META,
  DEFAULT_WS_URL,
  HEARTBEAT_FINISH,
  HEARTBEAT_RUNNING,
  MODULE_BIZ,
  MODULE_CONN_ACCESS,
  MSG_TYPE_FILE,
  MSG_TYPE_IMAGE,
  MSG_TYPE_SOUND,
  MSG_TYPE_TEXT,
  MSG_TYPE_VIDEO,
  RET_ALREADY_AUTH,
  RET_SUCCESS,
  TOKEN_EXPIRED_CODES,
  buildFileMsgBody,
  buildImageMsgBody,
  decodeConnMsg,
  decodeStatusResponse,
  encodeAuthBindPayload,
  encodeC2CMessagePayload,
  encodeGroupHeartbeatPayload,
  encodeGroupMessagePayload,
  encodePrivateHeartbeatPayload,
  encodePushAck,
  encodeRequest,
  encodeTextBody,
  type YuanbaoConnHead,
  type YuanbaoMessageBody,
  type YuanbaoMessageElement,
} from './yuanbao-frames.js'
import {
  createYuanbaoApi,
  normalizeYuanbaoApiDomain,
  YuanbaoError,
  type YuanbaoApi,
  type YuanbaoToken,
} from './yuanbao-api.js'
import { splitMessage } from './telegram.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
} from '../types.js'

export const YUANBAO_CHANNEL_TYPE = 'yuanbao'
export const YUANBAO_PING_INTERVAL_MS = 30_000
export const YUANBAO_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const
const INBOUND_DEDUPE_TTL_MS = 300_000
const REPLY_CONTEXT_CAP = 500

export interface YuanbaoCredentials {
  readonly appKey: string
  readonly appSecret: string
}

export interface YuanbaoAdapterConfig {
  readonly id: string
  readonly credentials: YuanbaoCredentials
  /** HTTP origin; default https://bot.yuanbao.tencent.com. */
  readonly apiDomain?: string
  /** WS endpoint; default wss://bot-wss.yuanbao.tencent.com/wss/connection. */
  readonly wsUrl?: string
  /** Ephemeral probe mode; never put this in the persisted channel schema. */
  readonly probeMode?: 'sign_token'
  readonly requestTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly reconnectDelaysMs?: readonly number[]
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  readonly api?: YuanbaoApi
  readonly webSocketFactory?: YuanbaoWebSocketFactory
  readonly now?: () => number
}

export interface YuanbaoWebSocket {
  readonly readyState: number
  binaryType: string
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void
}

export type YuanbaoWebSocketFactory = (url: string) => YuanbaoWebSocket

interface PendingRequest {
  readonly resolve: (payload: Buffer) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface ReplyContext {
  readonly replyToAccount: string
  readonly msgId: string
  readonly privateFromGroupCode: string
}

type RawMessage = Record<string, unknown>

/** Normalize the URL forms handled by utils.py:77-89. */
export function normalizeYuanbaoMediaUrl(value: string, apiDomain: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) return `${normalizeYuanbaoApiDomain(apiDomain)}${trimmed}`
  return `https://${trimmed}`
}

/**
 * The reference implementation's shared group manager activates on `metadata.bot_mentioned`
 * (group_context.py:198-204, 248-251).  The Yuanbao parser in the reference
 * does not document another mention field, so an absent explicit signal is
 * conservatively not an activation; see the UNVERIFIED note in the delivery.
 */
export function isYuanbaoGroupAddressed(data: RawMessage): boolean {
  return data['bot_mentioned'] === true
}

function rawString(data: RawMessage, key: string): string {
  return typeof data[key] === 'string' ? data[key] as string : ''
}

function rawObject(value: unknown): RawMessage | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RawMessage : undefined
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function firstMediaUrl(content: RawMessage, apiDomain: string): string {
  const direct = normalizeYuanbaoMediaUrl(rawString(content, 'url'), apiDomain)
  if (direct !== '') return direct
  const images = content['image_info_array']
  if (Array.isArray(images)) {
    for (const item of images) {
      const image = rawObject(item)
      if (image !== undefined) {
        const url = normalizeYuanbaoMediaUrl(rawString(image, 'url'), apiDomain)
        if (url !== '') return url
      }
    }
  }
  return normalizeYuanbaoMediaUrl(rawString(content, 'sound'), apiDomain)
}

function contentFilename(content: RawMessage): string {
  // These are the three names accepted by the reference helper (utils.py:73-75).
  return rawString(content, 'file_name') || rawString(content, 'fileName') || rawString(content, 'filename') || 'attachment'
}

/** Convert the current TIM message body to Tentacle's three ContentPart kinds. */
export function yuanbaoContentParts(data: RawMessage, apiDomain: string): ContentPart[] {
  const body = data['msg_body']
  if (!Array.isArray(body)) return []
  const parts: ContentPart[] = []
  for (const item of body) {
    const element = rawObject(item)
    if (element === undefined) continue
    const type = rawString(element, 'msg_type')
    const content = rawObject(element['msg_content']) ?? {}
    if (type === MSG_TYPE_TEXT) {
      const text = rawString(content, 'text')
      if (text !== '') parts.push({ type: 'text', text })
      continue
    }
    if (type === MSG_TYPE_IMAGE) {
      const url = firstMediaUrl(content, apiDomain)
      if (url !== '') parts.push({ type: 'image', reference: url })
      else parts.push({ type: 'text', text: '[yuanbao: image without a media reference]' })
      continue
    }
    if (type === MSG_TYPE_FILE) {
      const url = normalizeYuanbaoMediaUrl(rawString(content, 'url'), apiDomain)
      if (url !== '') parts.push({ type: 'file', name: contentFilename(content), reference: url })
      else parts.push({ type: 'text', text: `[yuanbao: file "${contentFilename(content)}" without a media reference]` })
      continue
    }
    if (type === MSG_TYPE_SOUND || type === MSG_TYPE_VIDEO) {
      const url = firstMediaUrl(content, apiDomain)
      // ContentPart has no audio/video variants; a file reference is the only
      // honest reference-shaped representation available in this package.
      if (url !== '') parts.push({ type: 'file', name: type === MSG_TYPE_SOUND ? 'audio' : 'video', reference: url })
      else parts.push({ type: 'text', text: `[yuanbao: ${type === MSG_TYPE_SOUND ? 'audio' : 'video'} without a media reference]` })
      continue
    }
    const text = rawString(content, 'text') || rawString(content, 'desc')
    parts.push({ type: 'text', text: text || `[yuanbao: unsupported message type "${type || 'unknown'}"]` })
  }
  return parts
}

export class YuanbaoAdapter implements ChannelAdapter {
  // The central integration adds 'yuanbao' to ChannelType.  This assertion is
  // only needed while this new file is checked before that one-line union edit.
  readonly channelType = YUANBAO_CHANNEL_TYPE as unknown as ChannelAdapter['channelType']
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    // The reference publishes no Yuanbao text-length limit.  Do not invent a
    // platform quota; sending remains one TIM request per logical reply.
    maxMessageChars: Number.MAX_SAFE_INTEGER,
    supportsTyping: true,
    // channel.py:97-103 — two calls per five seconds.
    rateLimitPerSec: 2 / 5,
  }

  private readonly credentials: YuanbaoCredentials
  private readonly api: YuanbaoApi
  private readonly apiDomain: string
  private readonly wsUrl: string
  private readonly probeMode: 'sign_token' | undefined
  private readonly requestTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly reconnectDelaysMs: readonly number[]
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private readonly now: () => number
  private readonly webSocketFactory: YuanbaoWebSocketFactory
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private ws: YuanbaoWebSocket | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private readonly seenMessageIds = new Map<string, number>()
  private readonly replyContexts = new Map<string, ReplyContext>()
  private seqNo = 0
  private botId = ''
  private bot: { readonly id: string; readonly username?: string } | undefined
  private fatal: Error | undefined
  private started = false
  private stopping = false
  private shouldReconnect = false
  private connectedState = false
  private connectInProgress = false
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0

  constructor(config: YuanbaoAdapterConfig) {
    if (config.id.trim() === '') throw new Error('yuanbao adapter requires an instance id')
    if (config.credentials.appKey.trim() === '' || config.credentials.appSecret.trim() === '') {
      throw new Error('yuanbao adapter requires appKey and appSecret credentials')
    }
    this.channelId = config.id
    this.credentials = config.credentials
    this.apiDomain = normalizeYuanbaoApiDomain(config.apiDomain)
    this.wsUrl = normalizeWsUrl(config.wsUrl)
    this.probeMode = config.probeMode
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000
    this.connectTimeoutMs = config.connectTimeoutMs ?? 15_000
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? YUANBAO_PING_INTERVAL_MS
    this.reconnectDelaysMs = config.reconnectDelaysMs ?? YUANBAO_RECONNECT_DELAYS_MS
    this.log = config.log ?? (() => undefined)
    this.now = config.now ?? Date.now
    this.api = config.api ?? createYuanbaoApi({
      appKey: config.credentials.appKey,
      appSecret: config.credentials.appSecret,
      apiDomain: this.apiDomain,
      requestTimeoutMs: this.requestTimeoutMs,
      now: this.now,
    })
    this.webSocketFactory = config.webSocketFactory ?? ((url) => {
      const socket = new WebSocket(url) as unknown as YuanbaoWebSocket
      socket.binaryType = 'arraybuffer'
      return socket
    })
  }

  get identity(): { readonly id: string; readonly username?: string } | undefined {
    return this.bot
  }

  get failure(): Error | undefined {
    return this.fatal
  }

  /** Useful for diagnostics; the service's connected state is start()'s result. */
  get connected(): boolean {
    return this.connectedState
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<ChannelStartHandle> {
    if (this.started || this.connectInProgress) throw new Error('yuanbao adapter already started')
    this.stopping = false
    this.fatal = undefined
    try {
      if (this.probeMode === 'sign_token') {
        const token = await this.api.signToken(true)
        this.setBot(token)
        this.started = true
        this.log('info', `yuanbao probe succeeded for ${this.channelId}`)
        return { stop: async () => await this.stop() }
      }
      await this.connectOnce(true)
      this.started = true
      this.shouldReconnect = true
      this.startPingLoop()
      this.log('info', `yuanbao adapter started for ${this.channelId}`)
      return { stop: async () => await this.stop() }
    } catch (error) {
      this.connectedState = false
      this.shouldReconnect = false
      this.stopPingLoop()
      this.failPending(new Error('yuanbao adapter start failed'))
      await this.closeCurrentSocket()
      this.rememberFailure(error)
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.shouldReconnect = false
    this.started = false
    this.connectedState = false
    this.stopPingLoop()
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.failPending(new Error('yuanbao adapter stopped'))
    await this.closeCurrentSocket()
  }

  /** Send the reference's running/finish reply heartbeat around a TIM send. */
  async setTyping(subject: ChannelSubject): Promise<void> {
    try {
      await this.sendReplyHeartbeat(subject, HEARTBEAT_RUNNING)
    } catch (error) {
      this.log('debug', `yuanbao typing heartbeat failed: ${describe(error)}`)
    }
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const body = outboundBody(content)
    if (body.length === 0) return
    await this.setTyping(subject)
    const context = this.replyContexts.get(replyContextKey(subject))
    const fromAccount = this.botId
    if (fromAccount === '') throw new YuanbaoError('auth', 'yuanbao adapter is not authenticated')
    const group = subject.kind === 'group'
    const msgId = this.nextBusinessMsgId(group ? 'grp' : 'c2c')
    try {
      const response = group
        ? await this.request(
          CMD_SEND_GROUP_MESSAGE,
          MODULE_BIZ,
          encodeGroupMessagePayload({
            groupCode: subject.chatId,
            fromAccount,
            msgBody: body,
            msgId,
            refMsgId: context?.msgId ?? '',
          }),
          msgId,
        )
        : await this.request(
          CMD_SEND_C2C_MESSAGE,
          MODULE_BIZ,
          encodeC2CMessagePayload({
            toAccount: context?.replyToAccount || subject.chatId,
            fromAccount,
            msgBody: body,
            msgId,
            groupCode: context?.privateFromGroupCode ?? '',
          }),
          msgId,
        )
      const status = decodeStatusResponse(response)
      if (status.code !== RET_SUCCESS) {
        throw new YuanbaoError('api', `yuanbao send failed (code ${status.code})`, undefined, status.code)
      }
    } finally {
      try {
        await this.sendReplyHeartbeat(subject, HEARTBEAT_FINISH)
      } catch (error) {
        this.log('debug', `yuanbao finish heartbeat failed: ${describe(error)}`)
      }
    }
  }

  /** Parse one current `inbound_message` JSON payload; malformed/non-message input is ignored. */
  parseInbound(rawPayload: unknown): InboundMessage | undefined {
    const data = typeof rawPayload === 'string' || Buffer.isBuffer(rawPayload)
      ? parseJson(rawPayload.toString())
      : rawObject(rawPayload)
    if (data === undefined || !Array.isArray(data['msg_body'])) return undefined
    const fromAccount = rawString(data, 'from_account') || 'unknown'
    if (fromAccount === this.botId && this.botId !== '') return undefined
    const groupCode = rawString(data, 'group_code')
    const callback = rawString(data, 'callback_command')
    const group = groupCode !== '' || callback.startsWith('Group.')
    if (group && !isYuanbaoGroupAddressed(data)) {
      this.log('debug', `yuanbao: ignoring group message ${rawString(data, 'msg_id')} without bot_mentioned`)
      return undefined
    }
    const subjectId = groupCode || fromAccount
    const msgId = rawString(data, 'msg_id') || rawString(data, 'msg_key') || rawString(data, 'MsgKey')
    const content = yuanbaoContentParts(data, this.apiDomain)
    if (content.length === 0) return undefined
    const subject: ChannelSubject = { chatId: subjectId, kind: group ? 'group' : 'dm' }
    this.replyContexts.set(replyContextKey(subject), {
      replyToAccount: fromAccount,
      msgId,
      privateFromGroupCode: rawString(data, 'private_from_group_code'),
    })
    if (this.replyContexts.size > REPLY_CONTEXT_CAP) {
      const oldest = this.replyContexts.keys().next().value
      if (oldest !== undefined) this.replyContexts.delete(oldest)
    }
    const metadata: Record<string, unknown> = {
      callbackCommand: data['callback_command'] ?? '',
      fromAccount,
      replyToAccount: fromAccount,
      toAccount: data['to_account'] ?? '',
      groupId: data['group_id'] ?? '',
      groupCode,
      groupName: data['group_name'] ?? '',
      msgId,
      msgKey: data['msg_key'] ?? data['MsgKey'] ?? '',
      msgSeq: data['msg_seq'] ?? 0,
      msgRandom: data['msg_random'] ?? 0,
      msgTime: data['msg_time'] ?? 0,
      botOwnerId: data['bot_owner_id'] ?? '',
      privateFromGroupCode: data['private_from_group_code'] ?? '',
      botMentioned: data['bot_mentioned'] === true,
      botId: this.botId,
    }
    const logExt = rawObject(data['log_ext'])
    metadata['traceId'] = rawString(data, 'trace_id') || (logExt === undefined ? '' : rawString(logExt, 'trace_id'))
    const displayName = rawString(data, 'sender_nickname')
    const groupName = rawString(data, 'group_name')
    return {
      channelId: this.channelId,
      channelType: this.channelType,
      // Include the instance id: two Yuanbao bots can reuse a platform msg_id.
      messageId: `yuanbao:${this.channelId}:${msgId}`,
      subject,
      sender: {
        platformId: fromAccount,
        ...(displayName === '' ? {} : { displayName }),
        ...(fromAccount === this.botId && this.botId !== '' ? { isBot: true } : {}),
      },
      content,
      ...(groupName === '' ? {} : { groupContext: groupName }),
      // The reference leaves timestamp at its default (models.py:185); do not
      // guess whether every msg_time variant is seconds or milliseconds.
      receivedAt: this.now(),
      metadata,
    }
  }

  private setBot(token: YuanbaoToken): void {
    this.botId = token.botId
    this.bot = { id: token.botId }
  }

  private async connectOnce(forceToken: boolean): Promise<void> {
    if (this.stopping) throw new Error('yuanbao adapter is stopping')
    this.connectInProgress = true
    let socket: YuanbaoWebSocket | undefined
    try {
      const token = await this.api.signToken(forceToken)
      this.setBot(token)
      if (this.stopping) throw new Error('yuanbao adapter is stopping')
      await this.closeCurrentSocket()
      socket = this.webSocketFactory(this.wsUrl)
      socket.binaryType = 'arraybuffer'
      this.ws = socket
      this.attachSocket(socket)
      await this.waitForOpen(socket)
      if (this.stopping) throw new Error('yuanbao adapter is stopping')
      this.connectedState = true
      const response = await this.request(CMD_AUTH_BIND, MODULE_CONN_ACCESS, encodeAuthBindPayload({
        botId: token.botId,
        source: token.source,
        token: token.token,
        appVersion: '1.0.0',
        appOperationSystem: process.platform,
        botVersion: '1.0.0',
      }))
      const status = decodeStatusResponse(response)
      if (status.code !== RET_SUCCESS && status.code !== RET_ALREADY_AUTH) {
        if (TOKEN_EXPIRED_CODES.has(status.code)) this.api.clearToken()
        throw new YuanbaoError('api', `yuanbao auth-bind failed (code ${status.code})`, undefined, status.code)
      }
      this.connectedState = true
      this.reconnectAttempt = 0
    } catch (error) {
      this.connectedState = false
      if (socket !== undefined && this.ws === socket) this.ws = undefined
      if (socket !== undefined) await closeSocket(socket)
      throw error
    } finally {
      this.connectInProgress = false
    }
  }

  private attachSocket(socket: YuanbaoWebSocket): void {
    socket.addEventListener('message', (event: { data?: unknown }) => {
      void this.handleSocketMessage(socket, event.data).catch((error: unknown) => {
        this.log('debug', `yuanbao message handling failed: ${describe(error)}`)
      })
    })
    socket.addEventListener('close', () => this.handleSocketClosed(socket))
    socket.addEventListener('error', () => {
      if (this.ws !== socket) return
      this.log('warn', 'yuanbao WebSocket transport error')
      void closeSocket(socket)
      this.handleSocketClosed(socket)
    })
  }

  private waitForOpen(socket: YuanbaoWebSocket): Promise<void> {
    if (socket.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(new YuanbaoError('timeout', 'yuanbao WebSocket connect timed out'))
      }, this.connectTimeoutMs)
      const onOpen = (): void => finish()
      const onError = (): void => finish(new YuanbaoError('transport', 'yuanbao WebSocket connect failed'))
      const onClose = (): void => finish(new YuanbaoError('transport', 'yuanbao WebSocket closed before auth-bind'))
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
        if (error === undefined) resolve()
        else reject(error)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
    })
  }

  private async handleSocketMessage(socket: YuanbaoWebSocket, rawData: unknown): Promise<void> {
    const data = await socketDataBytes(rawData)
    if (data === undefined) {
      if (typeof rawData === 'string') await this.handleTextFrame(rawData)
      return
    }
    let message
    try {
      message = decodeConnMsg(data)
    } catch (error) {
      this.log('debug', `yuanbao ignored malformed binary frame: ${describe(error)}`)
      return
    }
    const head = message.head
    if (head.cmdType === CMD_TYPE_RESPONSE) {
      const pending = this.pending.get(head.msgId)
      if (pending !== undefined) {
        this.pending.delete(head.msgId)
        clearTimeout(pending.timer)
        pending.resolve(message.data)
      }
      return
    }
    if (head.cmdType !== CMD_TYPE_PUSH) return
    if (head.needAck) {
      try {
        this.sendRaw(encodePushAck(head, this.nextSeqNo()), socket)
      } catch (error) {
        this.log('debug', `yuanbao push ACK failed: ${describe(error)}`)
      }
    }
    if (head.cmd === CMD_INBOUND_MESSAGE) {
      await this.handleTextFrame(message.data.toString('utf8'))
    } else if (head.cmd === CMD_KICKOUT) {
      this.log('warn', 'yuanbao channel received kickout push')
    } else if (head.cmd === CMD_UPDATE_META) {
      this.log('debug', 'yuanbao channel received update-meta push')
    }
  }

  private async handleTextFrame(frame: string): Promise<void> {
    const data = parseJson(frame)
    if (data === undefined || !Array.isArray(data['msg_body'])) return
    const msgId = rawString(data, 'msg_id') || rawString(data, 'msg_key') || rawString(data, 'MsgKey')
    if (msgId !== '' && !this.rememberMessageId(msgId)) return
    const inbound = this.parseInbound(data)
    if (inbound === undefined) return
    const handler = this.handler
    if (handler === undefined) return
    try {
      await handler(inbound)
    } catch (error) {
      this.log('warn', `yuanbao: routing message ${inbound.messageId} failed: ${describe(error)}`)
    }
  }

  private handleSocketClosed(socket: YuanbaoWebSocket): void {
    if (this.ws !== socket) return
    this.ws = undefined
    this.connectedState = false
    this.failPending(new Error('yuanbao WebSocket closed'))
    if (!this.stopping && this.shouldReconnect && !this.connectInProgress) {
      this.log('warn', 'yuanbao WebSocket closed; scheduling reconnect')
      this.scheduleReconnect()
    }
  }

  private startPingLoop(): void {
    this.stopPingLoop()
    this.heartbeatTimer = setInterval(() => {
      if (!this.connectedState || this.stopping) return
      // channel.py:775-783 — ping is fire-and-forget, with no future waiter.
      void this.request(CMD_PING, MODULE_CONN_ACCESS, Buffer.alloc(0), undefined, false).catch((error: unknown) => {
        this.log('debug', `yuanbao ping failed: ${describe(error)}`)
      })
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopPingLoop(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.shouldReconnect || this.reconnectTimer !== undefined) return
    const delays = this.reconnectDelaysMs.length === 0 ? YUANBAO_RECONNECT_DELAYS_MS : this.reconnectDelaysMs
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]!
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnectOnce()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private async reconnectOnce(): Promise<void> {
    if (this.stopping || !this.shouldReconnect) return
    try {
      await this.connectOnce(false)
      this.log('info', `yuanbao adapter reconnected for ${this.channelId}`)
    } catch (error) {
      if (this.rememberFailure(error)) {
        this.shouldReconnect = false
        return
      }
      this.reconnectAttempt += 1
      this.scheduleReconnect()
    }
  }

  private rememberFailure(error: unknown): boolean {
    if (error instanceof YuanbaoError && (error.code === 'auth' || error.code === 'config')) {
      this.fatal = error
      this.log('warn', `yuanbao adapter stopped after non-recoverable error: ${error.message}`)
      return true
    }
    return false
  }

  private async sendReplyHeartbeat(subject: ChannelSubject, heartbeat: number): Promise<void> {
    if (this.botId === '') return
    const context = this.replyContexts.get(replyContextKey(subject))
    if (subject.kind === 'group') {
      await this.request(CMD_SEND_GROUP_HEARTBEAT, MODULE_BIZ, encodeGroupHeartbeatPayload({
        fromAccount: this.botId,
        groupCode: subject.chatId,
        sendTime: Math.floor(this.now()),
        heartbeat,
      }), undefined, false)
      return
    }
    await this.request(CMD_SEND_PRIVATE_HEARTBEAT, MODULE_BIZ, encodePrivateHeartbeatPayload(
      this.botId,
      context?.replyToAccount || subject.chatId,
      heartbeat,
    ), undefined, false)
  }

  private request(cmd: string, module: string, payload: Uint8Array, msgId?: string, waitResponse = true): Promise<Buffer> {
    const socket = this.ws
    if (socket === undefined || !this.connectedState || socket.readyState === 3) {
      return Promise.reject(new YuanbaoError('transport', 'yuanbao adapter is not connected'))
    }
    const requestId = msgId ?? `${cmd}_${this.nextSeqNo()}`
    const packet = encodeRequest(cmd, module, requestId, this.nextSeqNo(), payload)
    if (!waitResponse) {
      try {
        socket.send(packet)
        return Promise.resolve(Buffer.alloc(0))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new YuanbaoError('timeout', `yuanbao request timed out: ${cmd}`))
      }, this.requestTimeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        socket.send(packet)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  private sendRaw(packet: Uint8Array, socket = this.ws): void {
    if (socket === undefined || socket.readyState === 3) throw new YuanbaoError('transport', 'yuanbao adapter is not connected')
    socket.send(packet)
  }

  private nextSeqNo(): number {
    this.seqNo = (this.seqNo + 1) & 0xffffffff
    return this.seqNo
  }

  private nextBusinessMsgId(prefix: string): string {
    return `${prefix}_${this.nextSeqNo()}`
  }

  private rememberMessageId(msgId: string): boolean {
    const now = this.now()
    for (const [key, expiresAt] of this.seenMessageIds) {
      if (expiresAt <= now) this.seenMessageIds.delete(key)
    }
    if ((this.seenMessageIds.get(msgId) ?? 0) > now) return false
    this.seenMessageIds.set(msgId, now + INBOUND_DEDUPE_TTL_MS)
    return true
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async closeCurrentSocket(): Promise<void> {
    const socket = this.ws
    this.ws = undefined
    this.connectedState = false
    if (socket !== undefined) await closeSocket(socket)
  }
}

function replyContextKey(subject: ChannelSubject): string {
  return `${subject.kind}:${subject.chatId}`
}

function outboundBody(content: readonly ContentPart[]): YuanbaoMessageBody {
  const body: YuanbaoMessageElement[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim() !== '') body.push(...encodeTextBody(part.text))
    } else if (part.type === 'image') {
      if (/^https?:\/\//i.test(part.reference)) body.push(...buildImageMsgBody({ url: part.reference, filename: 'image' }))
      else body.push(...encodeTextBody('[yuanbao: unsupported image reference]'))
    } else {
      if (/^https?:\/\//i.test(part.reference)) body.push(...buildFileMsgBody({ url: part.reference, filename: part.name }))
      else body.push(...encodeTextBody(`[yuanbao: unsupported file reference for "${part.name}"]`))
    }
  }
  return body
}

function normalizeWsUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return DEFAULT_WS_URL
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
  if (!/^wss?:\/\//i.test(trimmed)) return `wss://${trimmed}`
  return trimmed
}

function parseJson(value: string): RawMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return rawObject(parsed)
  } catch {
    return undefined
  }
}

async function socketDataBytes(data: unknown): Promise<Buffer | undefined> {
  if (typeof data === 'string') return undefined
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return Buffer.from(await data.arrayBuffer())
  return undefined
}

async function closeSocket(socket: YuanbaoWebSocket): Promise<void> {
  if (socket.readyState === 3) return
  // Do not open a replacement until the old effective session has had a
  // chance to close (channel.py:465-469); the timeout only covers a broken peer.
  await new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const onClose = (): void => finish()
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeEventListener('close', onClose)
      resolve()
    }
    timer = setTimeout(finish, 1_000)
    socket.addEventListener('close', onClose)
    try {
      socket.close()
    } catch {
      finish()
    }
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
