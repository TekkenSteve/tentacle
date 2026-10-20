/**
 * Telegram channel adapter (design 06 §6: Bot API long polling — no public
 * callback needed, so the whole path is testable against a local fake Bot API).
 *
 * Responsibilities, and nothing else:
 *
 * - own the `getUpdates` cursor and hand the service a monotonically
 *   increasing offset to persist (the service acks, so a crash between poll
 *   and persist replays rather than drops);
 * - normalize a Telegram message into {@link InboundMessage} (chat kind,
 *   sender, group-mention gate, media → content part);
 * - send replies, split at the platform's 4096-character limit and falling
 *   back from Markdown to plain text when the platform rejects the entities.
 *
 * Routing, identity and sessions are the router's job.
 */
import {
  createTelegramApi,
  TelegramError,
  type TelegramApi,
  type TelegramMessage,
  type Update,
} from './telegram-api.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ContentPart,
  InboundMessage,
  OffsetStore,
} from '../types.js'

export const TELEGRAM_CHANNEL_TYPE = 'telegram'
/**
 * Bot API hard limit for `sendMessage.text`: "1-4096 characters after
 * entities parsing". Counted in Unicode code points (`Array.from`) because
 * Telegram counts characters, not UTF-8 bytes.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096

export interface TelegramAdapterConfig {
  /** Instance id of the channel this adapter serves (design 07 §1). */
  readonly id: string
  /** Bot API root; injected so tests can point at a fake server. */
  readonly apiBaseUrl?: string
  /** Direct bot token — local/testing only; the service prefers a credential ref. */
  readonly token: string
  /** `getUpdates` long-poll timeout in seconds. */
  readonly pollTimeoutSec?: number
  /** Wait between polls when the platform answered with no usable data. */
  readonly pollIntervalMs?: number
  /** Send `sendChatAction: typing` before replying (best effort). */
  readonly typing?: boolean
  /** Persisted cursor for this adapter (survives restarts). */
  readonly offsetStore?: OffsetStore
  /** Structured diagnostics; the service passes its cordis logger through. */
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /**
   * Cursor acknowledgement: called with the next `getUpdates` offset once a
   * batch has been handed to the router. The service persists it there — the
   * adapter never writes durable state itself.
   */
  readonly onAck?: (nextOffset: number) => void
  /** Injected client seam; tests pass a scripted API instead of HTTP. */
  readonly api?: TelegramApi
}

/** Backoff ceiling for the poll loop after a transport failure. */
const MAX_BACKOFF_MS = 60_000

interface MessageWithMedia {
  readonly text?: string
  readonly caption?: string
  readonly photo?: readonly { readonly file_id: string }[]
  readonly document?: { readonly file_id: string; readonly file_name?: string }
  readonly voice?: { readonly file_id: string }
  readonly audio?: { readonly file_id: string }
}

/**
 * Normalize message content. M1 admits text; media arrives as an honest
 * reference-shaped part rather than being silently dropped (06 §6 defers
 * rendering, it does not hide the fact).
 */
export function contentPartsOf(message: MessageWithMedia): ContentPart[] {
  const text = message.text ?? message.caption
  const parts: ContentPart[] = []
  if (typeof text === 'string' && text.trim() !== '') parts.push({ type: 'text', text })
  // Telegram sends every rendition of a photo; the last entry is the largest.
  const photo = message.photo === undefined ? undefined : message.photo[message.photo.length - 1]
  if (photo !== undefined) parts.push({ type: 'image', reference: photo.file_id })
  const file = message.document ?? message.voice ?? message.audio
  if (file !== undefined) {
    const name = 'file_name' in file && typeof file.file_name === 'string' && file.file_name !== ''
      ? file.file_name
      : 'attachment'
    parts.push({ type: 'file', name, reference: file.file_id })
  }
  return parts
}

/**
 * Group-message gate (06 §6: "群消息一期只回 @机器人 的消息").
 *
 * A message is addressed to the bot when it mentions the bot's username, when
 * it replies to one of the bot's own messages, or when it is a slash command.
 * Matching is entity-driven first, because Telegram reports the exact mention
 * span; the plain-text fallback only runs when the platform did not parse
 * entities at all (caption-less commands, forwarded text).
 */
export function isAddressedToBot(
  message: Pick<TelegramMessage, 'text' | 'caption' | 'entities' | 'caption_entities'>,
  botUsername: string,
): boolean {
  const text = message.text ?? message.caption ?? ''
  const entities = message.entities ?? message.caption_entities ?? []
  const handle = botUsername.startsWith('@') ? botUsername : `@${botUsername}`
  for (const entity of entities) {
    if (entity.type !== 'mention' && entity.type !== 'bot_command') continue
    if (entity.type === 'bot_command') return true
    const mentioned = Array.from(text).slice(entity.offset, entity.offset + entity.length).join('')
    if (mentioned.toLowerCase() === handle.toLowerCase()) return true
  }
  if (text.startsWith('/')) return true
  // `text_mention` arrives as an entity the span above already covers; a raw
  // `@handle` in the body is the only remaining signal.
  return text.toLowerCase().includes(handle.toLowerCase())
}

/** Map a Telegram message onto the reply subject (DM user / group chat+thread). */
export function subjectOf(message: TelegramMessage): ChannelSubject {
  const kind = message.chat.type === 'private' ? 'dm' : 'group'
  return {
    chatId: String(message.chat.id),
    kind,
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
  }
}

/**
 * Split text into platform-sized chunks.
 *
 * Prefers a paragraph break, then a line break, then a space, then a hard cut —
 * a long URL becomes one oversized chunk only when it has no boundary at all.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (Array.from(rest).length > limit) {
    const points = Array.from(rest)
    const window = points.slice(0, limit).join('')
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const head = cut > limit / 4 ? window.slice(0, cut) : window
    chunks.push(head.trimEnd())
    rest = rest.slice(head.length).replace(/^[\s]+/, '')
  }
  if (rest.trim() !== '') chunks.push(rest)
  return chunks
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = TELEGRAM_CHANNEL_TYPE
  /** Instance id: one bot connection (design 07 §1 — no longer a constant). */
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: TELEGRAM_MESSAGE_LIMIT,
    supportsTyping: true,
    // Telegram allows ~30 messages/second overall; 20/s is a safe self-imposed
    // ceiling for reply bursts (a turn ending with several chunks).
    rateLimitPerSec: 20,
  }

  readonly api: TelegramApi
  private readonly pollTimeoutSec: number
  private readonly pollIntervalMs: number
  private readonly typingEnabled: boolean
  private readonly offsetStore: OffsetStore | undefined
  private readonly onAck: ((nextOffset: number) => void) | undefined
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private controller: AbortController | undefined
  private loop: Promise<void> | undefined
  private offset: number | undefined
  private bot: { readonly id: number; readonly username?: string } | undefined
  /** Set once the platform reports a non-recoverable condition (401/404/409). */
  private fatal: TelegramError | undefined

  constructor(config: TelegramAdapterConfig, api?: TelegramApi) {
    if (config.id === undefined || config.id.trim() === '') {
      throw new Error('telegram adapter requires an instance id')
    }
    this.channelId = config.id
    this.api = api ?? config.api ?? createTelegramApi({
      apiBaseUrl: config.apiBaseUrl,
      token: config.token,
      readTimeoutSec: (config.pollTimeoutSec ?? 30) + 30,
    })
    this.pollTimeoutSec = config.pollTimeoutSec ?? 30
    this.pollIntervalMs = config.pollIntervalMs ?? 500
    this.typingEnabled = config.typing ?? true
    this.offsetStore = config.offsetStore
    this.onAck = config.onAck
    this.log = config.log ?? (() => undefined)
  }

  /** The bot identity resolved by `start()`, for diagnostics and the admin API. */
  get identity(): { readonly id: number; readonly username?: string } | undefined {
    return this.bot
  }

  /** Non-recoverable platform error, if the poll loop hit one. */
  get failure(): TelegramError | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  /**
   * Resume the persisted cursor, verify the token through `getMe` (a wrong
   * token must fail at startup, not as a silent poll loop), then poll.
   */
  async start(): Promise<ChannelStartHandle> {
    if (this.controller !== undefined) throw new Error('telegram adapter already started')
    // The shared store is `number | string` per platform; Telegram's own
    // cursor is the numeric update_id, so anything else is not ours to resume.
    const persisted = await this.offsetStore?.load(this.channelId)
    this.offset = typeof persisted === 'number' ? persisted : undefined
    this.bot = await this.api.getMe()
    this.controller = new AbortController()
    this.loop = this.pollLoop(this.controller.signal)
    this.log('info', `telegram adapter started as ${this.bot.username ?? this.bot.id} (offset ${this.offset ?? 'none'})`)
    return { stop: () => this.stop() }
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error('telegram adapter stopped'))
    this.controller = undefined
    await this.loop?.catch(() => undefined)
    this.loop = undefined
  }

  /**
   * Acknowledge the cursor: remember it for the next poll AND write it through
   * the offset store, so a restart resumes instead of replaying. The service
   * calls this once a message has been handed to the router.
   */
  setOffset(offset: number): void {
    this.offset = offset
    // Fire-and-forget on purpose: the poll loop must not block on disk, and a
    // failed write only costs a replay after restart.
    void this.offsetStore?.save(this.channelId, offset).catch((error: unknown) => {
      this.log('warn', `telegram: persisting cursor failed: ${describe(error)}`)
    })
  }

  /** `chat action: typing` — best effort, never fails a turn. */
  async setTyping(subject: ChannelSubject): Promise<void> {
    if (!this.typingEnabled) return
    try {
      await this.api.sendChatAction(subject.chatId, 'typing', subject.threadId)
    } catch (error) {
      this.log('debug', `telegram typing indicator failed: ${describe(error)}`)
    }
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return
    if (this.typingEnabled) await this.setTyping(subject)
    const chunks = splitMessage(text, this.constraints.maxMessageChars)
    for (const [index, chunk] of chunks.entries()) {
      try {
        await this.api.sendMessage(subject.chatId, chunk, subject.threadId, 'Markdown')
      } catch (error) {
        // A rejected Markdown body ("can't parse entities") must not lose the
        // reply: retry once as plain text, then give up loudly.
        if (error instanceof TelegramError && error.code === 'api' && error.status === 400) {
          this.log('debug', `telegram rejected Markdown, retrying plain: ${describe(error)}`)
          await this.api.sendMessage(subject.chatId, chunk, subject.threadId)
          continue
        }
        throw error
      }
      // Pace chunks of one long reply; a single-message reply must not pay it.
      if (index < chunks.length - 1 && this.constraints.rateLimitPerSec !== undefined) {
        await delay(Math.ceil(1000 / this.constraints.rateLimitPerSec))
      }
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoff = this.pollIntervalMs
    while (!signal.aborted) {
      let updates: readonly Update[]
      try {
        updates = await this.api.listUpdates(this.offset ?? 0, this.pollTimeoutSec, signal)
        backoff = this.pollIntervalMs
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof TelegramError && error.code === 'config') {
          // A misconfigured token cannot heal by retrying: stop and let the
          // service (and the admin console) report a dead adapter.
          this.fatal = error
          this.log('warn', `telegram adapter stopped: ${error.message}`)
          return
        }
        if (error instanceof TelegramError && (error.status === 401 || error.status === 404 || error.status === 409)) {
          this.fatal = error
          this.log('warn', `telegram adapter stopped after fatal platform error: ${error.message}`)
          return
        }
        const wait = error instanceof TelegramError && error.retryAfter !== undefined
          ? error.retryAfter * 1000
          : backoff
        this.log('warn', `telegram getUpdates failed (retrying in ${wait}ms): ${describe(error)}`)
        await delay(wait, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        continue
      }
      if (updates.length === 0) {
        await delay(this.pollIntervalMs, signal)
        continue
      }
      for (const update of updates) {
        if (signal.aborted) return
        await this.consume(update)
      }
      // Acknowledge the batch only after every update in it was handed to the
      // router. The service persists this cursor, so the durable offset never
      // runs ahead of work the router actually accepted.
      const next = Math.max(...updates.map((u) => u.update_id)) + 1
      this.offset = next
      this.onAck?.(next)
    }
  }

  private async consume(update: Update): Promise<void> {
    const message = update.message
    if (message === undefined) return
    const sender = message.from
    // Never prompt on another bot's output: that is a feedback loop, not a user.
    if (sender?.is_bot === true) return
    if (message.chat.type === 'channel') return
    const group = message.chat.type !== 'private'
    if (group && (this.bot?.username === undefined || !isAddressedToBot(message, this.bot.username))) {
      this.log('debug', `telegram: ignoring group message ${message.message_id} not addressed to the bot`)
      return
    }
    const content = contentPartsOf(message)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      messageId: `telegram:${String(message.chat.id)}:${String(message.message_id)}`,
      subject: subjectOf(message),
      sender: {
        // An anonymous group admin post carries no `from`; the chat itself is
        // then the only identity the platform exposes, and binding it is
        // meaningless — the router refuses it as unbound.
        platformId: sender === undefined ? `chat:${String(message.chat.id)}` : String(sender.id),
        ...(displayNameOf(sender) === undefined ? {} : { displayName: displayNameOf(sender)! }),
      },
      content,
      ...(message.chat.title === undefined ? {} : { groupContext: message.chat.title }),
      receivedAt: message.date * 1000,
      metadata: { updateId: update.update_id, messageId: message.message_id },
    }
    try {
      await handler(inbound)
    } catch (error) {
      // The cursor still advances: Telegram will not redeliver a message once
      // the offset moved past it, so failing here must not stall the channel.
      this.log('warn', `telegram: routing message ${inbound.messageId} failed: ${describe(error)}`)
    }
  }
}

function displayNameOf(user: { readonly first_name?: string; readonly username?: string } | undefined): string | undefined {
  if (user === undefined) return undefined
  return user.first_name ?? user.username
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Number of chunks a reply of this length would produce (admin/diagnostic use). */
export function chunkCount(text: string, limit = TELEGRAM_MESSAGE_LIMIT): number {
  return splitMessage(text, limit).length
}

