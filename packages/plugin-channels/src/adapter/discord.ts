/**
 * Discord channel adapter: gateway WebSocket inbound and REST outbound.
 *
 * The gateway lifecycle is the Discord protocol (v10): HELLO supplies the
 * heartbeat cadence, IDENTIFY carries the bot token and the minimal intent
 * mask, READY/RESUMED carries the bot identity and the session for RESUME.
 * Reconnects use exponential backoff (1s→60s) that resets only after a
 * successful READY/RESUME. Close codes are the taxonomy, not log strings:
 * 4004 = invalid token, 4013/4014 = invalid intents — those are fatal, never
 * retried. op=7 (server asks for a reconnect) preserves the session for RESUME;
 * op=9 (invalid session) forces a fresh IDENTIFY.
 *
 * The reference implementation's adapter delegates this lifecycle to discord.py, so there is no
 * authoritative line-by-line source to copy; what is implemented here is the
 * documented gateway protocol itself, verified against loopback fakes that
 * replay the real frame shapes.
 */
import { createDiscordApi, type DiscordApi } from './discord-api.js'
import { splitMessage } from './telegram.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
} from '../types.js'

export const DISCORD_CHANNEL_TYPE = 'discord' as ChannelAdapter['channelType']
/** Discord's documented 2000-character per-message cap (unlike other platforms' 4000). */
export const DISCORD_MESSAGE_LIMIT = 2000
/**
 * Minimal intent mask: GUILDS (1) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12)
 * | MESSAGE_CONTENT (1<<15). Privileged intent requirements are surfaced as
 * `discord_intents_required`, never silently widened.
 */
export const DISCORD_DEFAULT_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15)

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

const CLOSE_INVALID_TOKEN = 4004
const CLOSE_INVALID_INTENT = 4013
const CLOSE_DISALLOWED_INTENT = 4014

const DEDUP_CAP = 1000
const MAX_RECONNECT_DELAY_MS = 60_000

export interface DiscordCredentials {
  readonly token: string
}

export interface DiscordWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: { readonly data?: unknown; readonly code?: number }) => void): void
}

export type DiscordWebSocketFactory = (url: string) => DiscordWebSocket

export interface DiscordAdapterConfig {
  readonly id: string
  readonly credentials: DiscordCredentials
  readonly apiBaseUrl?: string
  readonly intents?: number
  readonly reconnectDelayMs?: number
  readonly maxReconnectDelayMs?: number
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  readonly api?: DiscordApi
  readonly webSocketFactory?: DiscordWebSocketFactory
}

interface DiscordEventMessage {
  readonly id?: unknown
  readonly channel_id?: unknown
  readonly guild_id?: unknown
  readonly content?: unknown
  readonly timestamp?: unknown
  readonly author?: {
    readonly id?: unknown
    readonly username?: unknown
    readonly bot?: unknown
  }
  readonly mentions?: readonly { readonly id?: unknown }[]
  readonly mention_everyone?: unknown
  readonly attachments?: readonly {
    readonly id?: unknown
    readonly filename?: unknown
    readonly url?: unknown
    readonly content_type?: unknown
  }[]
}

interface ReadyPayload {
  readonly session_id?: unknown
  readonly user?: { readonly id?: unknown; readonly username?: unknown; readonly bot?: unknown }
}

class LruSet {
  private readonly entries = new Set<string>()
  constructor(private readonly cap: number) {}
  has(key: string): boolean {
    return this.entries.has(key)
  }
  add(key: string): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    }
    this.entries.add(key)
    if (this.entries.size > this.cap) {
      const oldest = this.entries.values().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}

export class DiscordAdapter implements ChannelAdapter {
  readonly channelType = DISCORD_CHANNEL_TYPE
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: DISCORD_MESSAGE_LIMIT,
    supportsTyping: true,
  }

  private readonly api: DiscordApi
  private readonly token: string
  private readonly intents: number
  private readonly initialReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly socketFactory: DiscordWebSocketFactory
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private readonly seenMessages = new LruSet(DEDUP_CAP)
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private controller: AbortController | undefined
  private loop: Promise<void> | undefined
  private socket: DiscordWebSocket | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatSocket: DiscordWebSocket | undefined
  private sessionId: string | undefined
  private lastSequence: number | undefined
  private reconnectDelayMs: number
  private bot: { readonly id: string; readonly username?: string } | undefined
  private fatal: Error | undefined

  constructor(config: DiscordAdapterConfig) {
    if (config.id.trim() === '') throw new Error('discord adapter requires an instance id')
    if (config.credentials.token.trim() === '') throw new Error('discord adapter requires a bot token')
    this.channelId = config.id
    this.token = config.credentials.token
    this.intents = config.intents ?? DISCORD_DEFAULT_INTENTS
    this.initialReconnectDelayMs = config.reconnectDelayMs ?? 1000
    this.maxReconnectDelayMs = config.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS
    if (this.initialReconnectDelayMs <= 0 || this.maxReconnectDelayMs < this.initialReconnectDelayMs) {
      throw new Error('discord adapter reconnect delays are invalid')
    }
    this.reconnectDelayMs = this.initialReconnectDelayMs
    this.log = config.log ?? (() => undefined)
    this.api = config.api ?? createDiscordApi({
      token: this.token,
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
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
    if (this.controller !== undefined) throw new Error('discord adapter already started')
    try {
      // The gateway URL is the only prerequisite; READY arrives inside the loop.
      const gatewayUrl = await this.api.getGatewayUrl()
      this.fatal = undefined
      this.controller = new AbortController()
      // A factory that throws during construction must not become an
      // unhandled rejection: it is a fatal start failure instead.
      this.loop = this.socketLoop(gatewayUrl, this.controller.signal)
        .catch((error: unknown) => { this.fatal = asError(error) })
      this.log('info', `discord adapter ${this.channelId} started`)
      return { stop: async () => await this.stop() }
    } catch (error) {
      this.fatal = asError(error)
      throw this.fatal
    }
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
    for (const chunk of splitMessage(text, DISCORD_MESSAGE_LIMIT)) {
      await this.api.sendMessage(subject.chatId, chunk)
    }
  }

  private async socketLoop(gatewayUrl: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const socket = this.socketFactory(gatewayUrl)
      this.socket = socket
      const outcome = await this.runSocket(socket, signal)
      this.stopHeartbeat()
      this.socket = undefined
      if (signal.aborted || outcome === 'stopped') return
      if (outcome === 'fatal') return
      // op=7 keeps the session for RESUME; everything else starts clean.
      if (outcome !== 'resume') {
        this.sessionId = undefined
        this.lastSequence = undefined
      }
      this.log('warn', `discord adapter ${this.channelId} reconnecting in ${this.reconnectDelayMs}ms`)
      await delay(this.reconnectDelayMs, signal)
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs)
    }
  }

  /** One socket's whole life: resolves 'stopped' | 'closed' | 'resume' | 'fatal' | 'error'. */
  private async runSocket(socket: DiscordWebSocket, signal: AbortSignal): Promise<'stopped' | 'closed' | 'resume' | 'fatal' | 'error'> {
    return await new Promise((resolve) => {
      const finish = (outcome: 'stopped' | 'closed' | 'resume' | 'fatal' | 'error'): void => {
        this.stopHeartbeat()
        this.heartbeatSocket = undefined
        resolve(outcome)
      }
      const onAbort = (): void => finish('stopped')
      if (signal.aborted) {
        finish('stopped')
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })

      socket.addEventListener('message', (event) => {
        let frame: { op?: unknown; d?: unknown; s?: unknown; t?: unknown }
        try {
          frame = JSON.parse(String(event.data)) as typeof frame
        } catch {
          return
        }
        if (typeof frame.s === 'number') this.lastSequence = frame.s
        const op = frame.op
        if (op === OP_HELLO) {
          const interval = heartbeatIntervalOf(frame.d)
          this.startHeartbeat(socket, interval)
          this.identify(socket)
          return
        }
        if (op === OP_HEARTBEAT_ACK) return
        if (op === OP_RECONNECT) {
          socket.close(4000, 'server requested reconnect')
          return
        }
        if (op === OP_INVALID_SESSION) {
          this.sessionId = undefined
          this.lastSequence = undefined
          socket.close(4001, 'invalid session')
          return
        }
        if (op !== OP_DISPATCH) return
        const eventName = frame.t
        if (eventName === 'READY' || eventName === 'RESUMED') {
          this.reconnectDelayMs = this.initialReconnectDelayMs
          const ready = (frame.d ?? {}) as ReadyPayload
          if (eventName === 'READY') {
            this.sessionId = typeof ready.session_id === 'string' ? ready.session_id : undefined
          }
          const user = ready.user
          if (user !== undefined && typeof user.id === 'string') {
            this.bot = {
              id: user.id,
              ...(typeof user.username === 'string' ? { username: user.username } : {}),
            }
          }
          return
        }
        if (eventName === 'MESSAGE_CREATE') {
          void this.handleMessage(frame.d as DiscordEventMessage)
        }
      })
      socket.addEventListener('close', (event) => {
        const code = event.code
        if (code === CLOSE_INVALID_TOKEN) {
          this.fatal = new Error('discord_invalid_token')
          finish('fatal')
          return
        }
        if (code === CLOSE_INVALID_INTENT || code === CLOSE_DISALLOWED_INTENT) {
          this.fatal = new Error('discord_intents_required')
          finish('fatal')
          return
        }
        finish(this.sessionId === undefined ? 'closed' : 'resume')
      })
      socket.addEventListener('error', () => {
        // Transport errors are a reconnectable close, not a fatal config error.
      })
    })
  }

  private identify(socket: DiscordWebSocket): void {
    if (this.sessionId !== undefined) {
      // RESUME keeps the session and the last observed sequence (op=6).
      socket.send(JSON.stringify({
        op: OP_RESUME,
        d: { token: this.token, session_id: this.sessionId, seq: this.lastSequence ?? 0 },
      }))
      return
    }
    socket.send(JSON.stringify({
      op: OP_IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: 'linux', browser: 'tentacle', device: 'tentacle' },
      },
    }))
  }

  private startHeartbeat(socket: DiscordWebSocket, intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatSocket = socket
    const beat = (): void => {
      if (this.heartbeatSocket !== socket) return
      // The last observed sequence number belongs in every heartbeat (op=1).
      socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSequence ?? null }))
    }
    beat()
    this.heartbeat = setInterval(beat, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private async handleMessage(message: DiscordEventMessage): Promise<void> {
    const id = message.id
    if (typeof id !== 'string' || id === '') return
    const dedupKey = `${this.channelId}:${id}`
    if (this.seenMessages.has(dedupKey)) return
    this.seenMessages.add(dedupKey)

    const author = message.author
    if (author?.bot === true) return
    if (this.bot !== undefined && author?.id === this.bot.id) return
    const chatId = message.channel_id
    if (typeof chatId !== 'string' || chatId === '') return
    if (author?.id === undefined || typeof author.id !== 'string') return

    const isGroup = typeof message.guild_id === 'string' && message.guild_id !== ''
    if (isGroup && !this.isAddressedToBot(message)) {
      this.log('debug', `discord adapter ${this.channelId} ignoring unmentioned guild message ${id}`)
      return
    }

    const content = discordContentParts(message)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return
    await handler({
      channelId: this.channelId,
      channelType: this.channelType,
      messageId: `${this.channelId}:${id}`,
      subject: { chatId, kind: isGroup ? 'group' : 'dm' },
      sender: {
        platformId: author.id,
        ...(typeof author.username === 'string' ? { displayName: author.username } : {}),
      },
      content,
      receivedAt: typeof message.timestamp === 'string' ? Date.parse(message.timestamp) || Date.now() : Date.now(),
      metadata: isGroup ? { guildId: message.guild_id } : {},
    })
  }

  private isAddressedToBot(message: DiscordEventMessage): boolean {
    if (this.bot === undefined) return false
    // @everyone pings also reach the bot (same as the reference implementation's mention semantics).
    if (message.mention_everyone === true) return true
    return (message.mentions ?? []).some((mention) => mention.id === this.bot?.id)
  }
}

/** Text + attachment normalization; unsupported parts are never silently dropped. */
export function discordContentParts(message: DiscordEventMessage): ContentPart[] {
  const parts: ContentPart[] = []
  if (typeof message.content === 'string' && message.content.trim() !== '') {
    parts.push({ type: 'text', text: message.content })
  }
  for (const attachment of message.attachments ?? []) {
    const url = attachment.url
    if (typeof url !== 'string' || url === '') continue
    const contentType = typeof attachment.content_type === 'string' ? attachment.content_type : ''
    const filename = typeof attachment.filename === 'string' && attachment.filename !== '' ? attachment.filename : 'attachment'
    if (contentType.startsWith('image/')) {
      parts.push({ type: 'image', reference: url })
    } else {
      parts.push({ type: 'file', name: filename, reference: url })
    }
  }
  return parts
}

function heartbeatIntervalOf(data: unknown): number {
  if (typeof data === 'object' && data !== null) {
    const value = (data as { heartbeat_interval?: unknown }).heartbeat_interval
    if (typeof value === 'number' && value > 0) return value
  }
  return 41_250
}

function nativeWebSocket(url: string): DiscordWebSocket {
  return new WebSocket(url) as unknown as DiscordWebSocket
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
