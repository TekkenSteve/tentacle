/**
 * Channel domain types (design: docs/design/06-channels.md §2).
 *
 * Two layers live here and nothing else:
 *
 * 1. the **unified inbound contract** — what every adapter must hand to the
 *    router, normalized away from its platform's wire format;
 * 2. the **adapter port** — the small surface the service drives (start /
 *    stop / send + declared platform capabilities), with the optional
 *    typing/offset capabilities expressed as separate interfaces so an
 *    adapter only implements what its platform really has.
 *
 * This file is cordis-free on purpose: the routing policy is unit-testable
 * against these types without a DSH runtime.
 */

/** Platform family. A string union with room for later releases (06 §6). */
export type ChannelType = 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'qq' | 'weixin' | 'yuanbao' | 'discord'

/**
 * Where a channel routes (design 10 §7): one discriminated union — an
 * instance carries exactly one kind, never dual optional fields that could
 * disagree. `expert` resolves through the persona library (one expert's
 * session composition); `team` resolves through the team library (a team
 * session whose host prompt runs the collaboration contract).
 */
export type ChannelTarget =
  | { readonly kind: 'expert'; readonly id: string }
  | { readonly kind: 'team'; readonly id: string }

/** Where a reply must go: a DM user or a group chat, optionally a topic thread. */
export interface ChannelSubject {
  readonly chatId: string
  /**
   * Platform chat kind. Group messages are throttled harder by every platform
   * (and, in a group, a reply is public), so the router keeps the distinction.
   */
  readonly kind: 'dm' | 'group'
  /** Forum topic / thread id, when the platform has them. */
  readonly threadId?: string
}

/**
 * One piece of inbound content.
 *
 * M1 admits text only (06 §6: no voice/video/rich cards) but the union is a
 * discriminated one from day one — `image`/`file` arrive as *references*, so
 * adding them later is a new adapter case, never a contract change. Adapters
 * normalize unsupported media into `text` (a deterministic placeholder), they
 * never invent a part type the router cannot render.
 */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly reference: string }
  | { readonly type: 'file'; readonly name: string; readonly reference: string }

/** The text an adapter turned an inbound message into, for prompting. */
export function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** Who wrote the message on the platform (before identity binding). */
export interface ChannelSender {
  /** Platform-native user id — the key the binding table resolves. */
  readonly platformId: string
  readonly displayName?: string
  /** True when the platform marks the author as a bot (never prompted). */
  readonly isBot?: boolean
}

/** One normalized inbound message: the router's only input. */
export interface InboundMessage {
  /** Adapter instance id (`telegram`), matching the channel config row. */
  readonly channelId: string
  readonly channelType: ChannelType
  /**
   * Platform delivery identity, used for the webhook `deliveryId` and for
   * diagnostics. Stable across retries of the same update.
   */
  readonly messageId: string
  readonly subject: ChannelSubject
  readonly sender: ChannelSender
  readonly content: readonly ContentPart[]
  /** Human-readable group context (group title), when the platform has one. */
  readonly groupContext?: string
  readonly receivedAt: number
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Platform capability declaration (the reference implementation's ChannelConstraints, 06 §2). */
export interface ChannelConstraints {
  /** Maximum payload size of a single platform message, in Unicode code points. */
  readonly maxMessageChars: number
  readonly supportsTyping: boolean
  /** Upper bound the adapter itself throttles to, when the platform publishes one. */
  readonly rateLimitPerSec?: number
}

/** Handle returned by {@link ChannelAdapter.start}. */
export interface ChannelStartHandle {
  stop(): Promise<void>
}

/**
 * A platform adapter (06 §2). `start` may open a long poll or a webhook
 * route; `send` is the only outbound verb — the router never knows a
 * platform's HTTP shape.
 */
export interface ChannelAdapter {
  /** Stable adapter kind, matching {@link InboundMessage.channelType}. */
  readonly channelType: ChannelType
  /** Instance id, matching the channel config row (`channelId`). */
  readonly channelId: string
  /** Deliver one normalized inbound message. Injected by the service. */
  onMessage(handler: (message: InboundMessage) => Promise<void>): void
  start(): Promise<ChannelStartHandle>
  send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void>
  /**
   * Acknowledge the platform round-trip cursor (Telegram `update_id + 1`) once
   * a message was routed, so a restart resumes instead of replaying. Optional:
   * adapters without a cursor (webhook-based platforms) omit it.
   */
  setOffset?(offset: number): void
  readonly constraints: ChannelConstraints
  /**
   * Bot identity reported at start, when the platform exposes one. The id is
   * a number on Telegram but a string on platforms whose ids are opaque
   * (`open_id` on feishu), so the union is `number | string` from the start.
   */
  readonly identity?: { readonly id: number | string; readonly username?: string }
  /** Non-recoverable platform failure that stopped the adapter, when any. */
  readonly failure?: Error
}

/**
 * Platform round-trip cursor, persisted under the channels state root so a
 * restart resumes instead of replaying every unacknowledged update
 * (06 §7 test strategy). The value is opaque per platform: a numeric
 * `update_id` on Telegram, an opaque string `buf` on weixin iLink.
 */
export interface OffsetStore {
  load(adapterId: string): Promise<number | string | undefined>
  save(adapterId: string, offset: number | string): Promise<void>
}

/**
 * Optional adapter capability: show a "bot is thinking" affordance. Declared
 * separately from {@link ChannelAdapter} so an adapter whose platform has no
 * such concept does not have to implement a no-op method.
 */
export interface TypingAwareAdapter {
  setTyping(subject: ChannelSubject): Promise<void>
}
