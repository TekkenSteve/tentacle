/**
 * WeCom (Enterprise WeChat / WeChat Work) AI Bot channel adapter.
 *
 * The transport is an outbound WebSocket, so no public callback route is
 * required. Inbound `aibot_msg_callback` bodies are normalized at this edge;
 * replies use the callback req_id when one is available and proactive
 * `aibot_send_msg` otherwise (the reference implementation's wecom.py:157-228).
 *
 * Group @ gate: WeCom delivers a group callback for a message addressed to the
 * bot. The protocol has no mention-list field, and the reference implementation does not invent one or
 * parse display text (wecom.py:548-661,678-705). Consequently every valid
 * group callback is already @-gated by the platform; parsing `@...` text here
 * would be both unreliable and contrary to the reference implementation.
 */

import { splitMessage } from './telegram.js'
import {
  createWeComApi,
  generateWeComReqId,
  WeComError,
  type WeComApi,
  type WeComFrame,
} from './wecom-api.js'
import type {
  ChannelAdapter,
  ChannelConstraints,
  ChannelStartHandle,
  ChannelSubject,
  ChannelType,
  ContentPart,
  InboundMessage,
} from '../types.js'

export const WECOM_CHANNEL_TYPE = 'wecom' as ChannelType
/**
 * Conservative adapter chunk ceiling in Unicode code points. This is a
 * self-imposed value for the shared Constraints contract, not a claim about a
 * platform character-counting rule.
 */
export const WECOM_MESSAGE_LIMIT = 4000
const REPLY_CONTEXT_CAP = 500
const SEEN_MESSAGE_CAP = 500
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'file', 'voice', 'video', 'mixed'])

export interface WeComCredentials {
  /** Credential-map key is botId, exactly matching the scode flow output. */
  readonly botId: string
  readonly secret: string
}

export interface WeComAdapterConfig {
  readonly id: string
  readonly credentials: WeComCredentials
  /** Optional private-deployment endpoint; default comes from the SDK. */
  readonly wsUrl?: string
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
  /** Injected transport seam; production uses Node's global WebSocket. */
  readonly api?: WeComApi
}

interface WeComText {
  readonly content?: string
}

interface WeComMedia {
  readonly url?: string
  readonly file_name?: string
  readonly content?: string
}

interface WeComMixedItem {
  readonly msgtype?: string
  readonly text?: WeComText
  readonly image?: WeComMedia
}

/** Message-body fields evidenced by the reference implementation's wecom.py:548-661 and the SDK types. */
export interface WeComMessageBody {
  readonly msgid?: string
  readonly aibotid?: string
  readonly chatid?: string
  readonly chattype?: string
  readonly from?: { readonly userid?: string }
  readonly create_time?: number
  readonly msgtype?: string
  readonly text?: WeComText
  readonly image?: WeComMedia
  readonly file?: WeComMedia
  readonly voice?: WeComMedia
  readonly video?: WeComMedia
  readonly mixed?: { readonly msg_item?: readonly WeComMixedItem[] }
}

/** Convert one supported callback body into honest text/reference parts. */
export function weComContentParts(body: WeComMessageBody): ContentPart[] {
  switch (body.msgtype) {
    case 'text': {
      const text = body.text?.content
      return typeof text === 'string' && text !== '' ? [{ type: 'text', text }] : []
    }
    case 'image': {
      const reference = body.image?.url
      return typeof reference === 'string' && reference !== '' ? [{ type: 'image', reference }] : []
    }
    case 'file': {
      const reference = body.file?.url
      if (typeof reference !== 'string' || reference === '') return []
      const name = typeof body.file?.file_name === 'string' && body.file.file_name !== ''
        ? body.file.file_name
        : 'attachment'
      return [{ type: 'file', name, reference }]
    }
    case 'voice': {
      // SDK metadata describes voice transcription as text; the reference implementation also handles
      // deployments that provide a downloadable URL (wecom.py:604-609).
      const transcript = body.voice?.content
      if (typeof transcript === 'string' && transcript !== '') return [{ type: 'text', text: transcript }]
      const reference = body.voice?.url
      return typeof reference === 'string' && reference !== ''
        ? [{ type: 'file', name: 'voice', reference }]
        : []
    }
    case 'video': {
      const reference = body.video?.url
      return typeof reference === 'string' && reference !== ''
        ? [{ type: 'file', name: 'video', reference }]
        : []
    }
    case 'mixed': {
      const parts: ContentPart[] = []
      for (const item of body.mixed?.msg_item ?? []) {
        if (item.msgtype === 'text') {
          const text = item.text?.content
          if (typeof text === 'string' && text !== '') parts.push({ type: 'text', text })
        } else if (item.msgtype === 'image') {
          const reference = item.image?.url
          if (typeof reference === 'string' && reference !== '') parts.push({ type: 'image', reference })
        }
      }
      return parts
    }
    default:
      return []
  }
}

export class WeComAdapter implements ChannelAdapter {
  readonly channelType = WECOM_CHANNEL_TYPE
  readonly channelId: string
  readonly constraints: ChannelConstraints = {
    maxMessageChars: WECOM_MESSAGE_LIMIT,
    supportsTyping: false,
    // The reference implementation's default is two user-visible sends per five seconds (wecom.py:100-108).
    rateLimitPerSec: 0.4,
  }

  private readonly api: WeComApi
  private readonly credentials: WeComCredentials
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private handler: ((message: InboundMessage) => Promise<void>) | undefined
  private fatal: Error | undefined
  private running = false
  private readonly replyContexts = new LruMap<string>(REPLY_CONTEXT_CAP)
  private readonly seenMessages = new LruMap<true>(SEEN_MESSAGE_CAP)

  constructor(config: WeComAdapterConfig) {
    if (config.id.trim() === '') throw new Error('wecom adapter requires an instance id')
    if (config.credentials.botId.trim() === '' || config.credentials.secret.trim() === '') {
      throw new Error('wecom adapter requires botId and secret credentials')
    }
    this.channelId = config.id
    this.credentials = config.credentials
    this.log = config.log ?? (() => undefined)
    this.api = config.api ?? createWeComApi({
      botId: config.credentials.botId,
      secret: config.credentials.secret,
      ...(config.wsUrl === undefined ? {} : { wsUrl: config.wsUrl }),
      onMessage: (frame) => { void this.consume(frame) },
      onDisconnect: () => this.replyContexts.clear(),
      onFailure: (error) => {
        this.fatal = error
        this.log('warn', `wecom adapter stopped: ${error.message}`)
      },
      log: this.log,
    })
  }

  get identity(): { readonly id: string } | undefined {
    return this.running ? { id: this.credentials.botId } : undefined
  }

  get failure(): Error | undefined {
    return this.fatal
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<ChannelStartHandle> {
    if (this.running) throw new Error('wecom adapter already started')
    try {
      // Unlike the SDK's fire-and-forget connect(), the adapter start contract
      // resolves only after aibot_subscribe receives errcode=0.
      await this.api.start()
      this.running = true
    } catch (error) {
      if (error instanceof WeComError && (error.code === 'auth' || error.code === 'config')) this.fatal = error
      throw error
    }
    this.log('info', 'wecom adapter started')
    return { stop: () => this.stop() }
  }

  async stop(): Promise<void> {
    this.running = false
    this.replyContexts.clear()
    await this.api.stop()
  }

  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    const text = content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') return
    const chunks = splitMessage(text, this.constraints.maxMessageChars)
    const key = subjectKey(subject)
    const replyReqId = this.replyContexts.get(key)
    try {
      if (replyReqId !== undefined) {
        // The reference implementation's wecom.py:168-181: passive responses are one finished stream.
        // Long text stays in ONE stream so chunking cannot create several final
        // responses to the same callback.
        const streamId = generateWeComReqId('him')
        for (const [index, chunk] of chunks.entries()) {
          await this.api.replyStream(replyReqId, {
            id: streamId,
            content: chunk,
            finish: index === chunks.length - 1,
          })
        }
        // A finished callback stream is consumed. A later proactive send must
        // not reuse a stale req_id; a new inbound turn installs a fresh one.
        if (this.replyContexts.get(key) === replyReqId) this.replyContexts.delete(key)
        return
      }

      // No callback frame: SDK client.py:440-455 proactive Markdown send.
      for (const [index, chunk] of chunks.entries()) {
        await this.api.sendMarkdown(subject.chatId, chunk)
        if (index < chunks.length - 1 && this.constraints.rateLimitPerSec !== undefined) {
          await delay(Math.ceil(1000 / this.constraints.rateLimitPerSec))
        }
      }
    } catch (error) {
      if (error instanceof WeComError && error.code === 'auth') this.fatal = error
      throw error
    }
  }

  private async consume(frame: WeComFrame): Promise<void> {
    if (frame.cmd !== 'aibot_msg_callback') return
    const body = frame.body as WeComMessageBody | undefined
    if (body === undefined || typeof body.msgtype !== 'string' || !SUPPORTED_MESSAGE_TYPES.has(body.msgtype)) return
    const senderId = body.from?.userid
    if (typeof senderId !== 'string' || senderId === '') return
    // The protocol exposes no generic is_bot flag. This check drops the one
    // bot-author shape that can be identified without inventing fields: the
    // callback's own aibotid is also its sender (feedback-loop prevention).
    if (senderId === body.aibotid) return
    if (typeof body.msgid !== 'string' || body.msgid === '' || this.seenMessages.has(body.msgid)) return

    const kind = body.chattype === 'single' ? 'dm' : body.chattype === 'group' ? 'group' : undefined
    if (kind === undefined) return
    const chatId = kind === 'dm' ? senderId : body.chatid
    if (typeof chatId !== 'string' || chatId === '') return
    const content = weComContentParts(body)
    if (content.length === 0) return
    const handler = this.handler
    if (handler === undefined) return

    const subject: ChannelSubject = { chatId, kind }
    const replyReqId = frame.headers?.req_id
    if (typeof replyReqId === 'string' && replyReqId !== '') this.replyContexts.set(subjectKey(subject), replyReqId)
    this.seenMessages.set(body.msgid, true)
    const createTime = body.create_time
    const inbound: InboundMessage = {
      channelId: this.channelId,
      channelType: this.channelType,
      // msgid is the platform delivery id; the INSTANCE prefix prevents two
      // WeCom bots receiving the same platform id from colliding in dispatch.
      messageId: `${this.channelId}:${body.msgid}`,
      subject,
      sender: { platformId: senderId },
      content,
      receivedAt: typeof createTime === 'number' && Number.isFinite(createTime) && createTime > 0
        ? createTime * 1000
        : Date.now(),
      metadata: {
        messageId: body.msgid,
        chatType: body.chattype,
        // True by the platform's group-delivery contract, not by text parsing.
        botMentioned: kind === 'group',
      },
    }
    try {
      await handler(inbound)
    } catch (error) {
      this.log('warn', `wecom: routing message ${inbound.messageId} failed: ${describe(error)}`)
    }
  }
}

function subjectKey(subject: ChannelSubject): string {
  return `${subject.kind}:${subject.chatId}:${subject.threadId ?? ''}`
}

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

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
