/**
 * Channel persistence ports and records (design: docs/design/07-channel-admin.md §2).
 *
 * The durable shape is a set of TABLES, not one document, because each table
 * has a different owner and a different write pattern (design 07 §2):
 *
 *  - `channels`      — one row per managed channel instance (the Registry owns it);
 *  - `bindings`      — `(channelId, platformId) → subjectId` (the BindingStore owns it);
 *  - `conversations` — conversation → session links (the Router owns it);
 *  - `offsets`       — per-instance platform cursor (the adapter owns it).
 *
 * The port deliberately mirrors the official `KvTable` contract from
 * `@deepseek-ai/dsh-storage-domain` (sync `get`/`entries`, durable `put`, atomic
 * `update`) so the Host mounts the official store with a thin adapter
 * (`./storage.ts`) instead of a hand-rolled JSON layer, and the domain core
 * stays testable against `MemoryStore`. Records are immutable data: the port
 * returns the stored objects themselves, so callers replace them through
 * `put`/`update` and never mutate in place.
 */
import type { TenantId } from '@tentacle/identity'
import type { ChannelType } from './types.js'
import type { ChannelInstance } from './instances.js'

/**
 * Identity binding between a platform account and a tenant user, scoped to ONE
 * channel instance: the same Telegram user may be bound differently on two bots
 * (design 07 §1). The key is `bindingKey()`.
 */
export interface ChannelBinding {
  /** Channel instance this binding belongs to (`ChannelInstance.id`). */
  readonly channelId: string
  readonly channelType: ChannelType
  /** Platform-native identity: a Telegram user id. */
  readonly platformId: string
  /** Tenant user this identity acts as; validated against the directory. */
  readonly subjectId: string
  readonly boundAt: number
}

/**
 * The durable identity of a routed conversation, scoped to one channel
 * instance. Keyed by `(channelId, chatId, threadId, subjectId)`: the instance
 * keeps two bots apart, the bound subject keeps a re-binding from inheriting
 * another user's session, and a group topic thread gets its own session.
 */
export interface ConversationIdentity {
  readonly channelId: string
  readonly channelType: ChannelType
  readonly chatId: string
  /** Chat kind is durable: a reply must go back to the same kind of surface. */
  readonly chatKind: 'dm' | 'group'
  readonly threadId?: string
  readonly subjectId: string
}

/** One routed conversation plus its live session. */
export interface ConversationLink extends ConversationIdentity {
  /** Webhook-created root session carrying this conversation's turns. */
  readonly sessionId: string
  readonly createdAt: number
  updatedAt: number
}

/**
 * One unbound platform identity that recently tried to talk on an instance.
 *
 * The router records these when it REFUSES a sender under the `reject` policy
 * (design 06 §5). The console lists them so an admin can bind a known person
 * with a dropdown — no `/bind` code needs to travel through the chat. Guest
 * and owner policies never create rows: those messages are already handled.
 *
 * Keyed like a binding (`bindingKey`): one row per (instance, platform identity).
 */
export interface PendingSender {
  readonly channelId: string
  readonly channelType: ChannelType
  readonly platformId: string
  /** Display name as the platform reports it; often identical to platformId. */
  readonly displayName?: string
  /** Last message preview (already truncated by the writer) — identifies the person. */
  readonly preview?: string
  readonly firstSeen: number
  lastSeen: number
  /** Refusal count for this identity; lets the console sort by activity. */
  messages: number
}

/**
 * Stable binding key. The ONE place the format lives, so the store, the routes
 * and the tests cannot drift apart.
 */
export function bindingKey(binding: { readonly channelId: string; readonly platformId: string }): string {
  return `${binding.channelId}/${binding.platformId}`
}

/**
 * Stable conversation key: safe as a record key and as a log field. Includes
 * the channel instance so the same chat reached through two bots never shares
 * a session.
 */
export function conversationKey(conversation: ConversationIdentity): string {
  const thread = conversation.threadId === undefined ? '' : `#${conversation.threadId}`
  return `${conversation.channelId}:${conversation.chatId}${thread}@${conversation.subjectId}`
}

/**
 * One table handle (the official `KvTable` surface). `update` runs on the
 * store's write chain, so concurrent read-modify-writes never interleave —
 * that is what makes instance creation and enable/disable race-free.
 */
export interface Table<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  /** Atomic read-modify-write; rejects when the key is absent. */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** Domain-wide singleton facts (migration bookkeeping, design 07 §8). */
export interface ChannelsGlobal {
  /** The legacy `channels.json` document was imported once. */
  legacyImported: boolean
  /** The static `config.telegram` seed was materialized once. */
  configSeeded: boolean
}

export function emptyGlobal(): ChannelsGlobal {
  return { legacyImported: false, configSeeded: false }
}

/** The whole durable surface the channels plugin owns. */
export interface ChannelsStore {
  readonly channels: Table<string, ChannelInstance>
  readonly bindings: Table<string, ChannelBinding>
  readonly conversations: Table<string, ConversationLink>
  /** Per-instance round-trip cursor: numeric on Telegram, opaque string on weixin. */
  readonly offsets: Table<string, number | string>
  /** Refused unbound senders awaiting an admin decision (console inbox). */
  readonly pendingSenders: Table<string, PendingSender>
  readGlobal(): ChannelsGlobal
  writeGlobal(next: ChannelsGlobal): Promise<void>
  /** Release backend resources; idempotent. */
  close(): Promise<void>
}

// ---- in-memory implementation (tests and pure-domain use) ----

class MemoryTable<K extends string, V> implements Table<K, V> {
  private readonly map = new Map<K, V>()

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  *entries(): IterableIterator<[K, V]> {
    for (const pair of [...this.map.entries()]) yield pair
  }

  *keys(): IterableIterator<K> {
    for (const key of [...this.map.keys()]) yield key
  }

  get size(): number {
    return this.map.size
  }

  async put(key: K, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.map.delete(key)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

/** In-memory `ChannelsStore` — the domain core's test double. */
export class MemoryStore implements ChannelsStore {
  readonly channels = new MemoryTable<string, ChannelInstance>()
  readonly bindings = new MemoryTable<string, ChannelBinding>()
  readonly conversations = new MemoryTable<string, ConversationLink>()
  readonly offsets = new MemoryTable<string, number>()
  readonly pendingSenders = new MemoryTable<string, PendingSender>()
  private global: ChannelsGlobal

  constructor(initial?: Partial<ChannelsGlobal>) {
    this.global = { ...emptyGlobal(), ...initial }
  }

  readGlobal(): ChannelsGlobal {
    return this.global
  }

  async writeGlobal(next: ChannelsGlobal): Promise<void> {
    this.global = next
  }

  async close(): Promise<void> {}
}
