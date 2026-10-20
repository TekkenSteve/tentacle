/**
 * Official persistence adapter (design: docs/design/07-channel-admin.md §2, D3).
 *
 * The durable tables live in an official storage domain — `defineDomain` +
 * zod record schemas + the JSON backend mounted by `dsh-base` — instead of a
 * hand-rolled JSON file. That buys three things a hand-rolled layer cannot:
 * validated records at the durable boundary, atomic `update` on the domain's
 * write chain (which the Registry's check-then-write needs), and the official
 * `domain/changed` event after durability.
 *
 * The adapter is deliberately thin: the domain's table handles already satisfy
 * the {@link Table} port structurally, so this file is the only place that
 * knows the official API.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Context } from '@deepseek-ai/cordis'
import { emptyGlobal, type ChannelBinding, type ChannelsStore, type ConversationLink, type PendingSender, type Table } from './repo.js'
import { isChannelType, type ChannelInstance } from './instances.js'

/**
 * Platform family at the durable boundary. Built from `isChannelType` (the
 * ONE place the union lives) rather than a parallel `z.enum` that could drift
 * from it.
 */
const channelTypeSchema = z.custom((value: unknown) => isChannelType(value), { message: 'unknown channel type' })

const instanceSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  channelType: channelTypeSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  tokenRef: z.string().optional(),
  // Optional ONLY at the durable boundary: a unit written before the routing
  // layer has no binding yet, and rejecting the whole domain on open would
  // strand every other table. The registry requires it for every write and
  // service init migrates legacy rows (including pre-target `expertId` rows)
  // before any adapter starts, so a missing value never reaches routing.
  target: z.object({ kind: z.enum(['expert', 'team']), id: z.string().min(1) }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const bindingSchema = z.object({
  channelId: z.string().min(1),
  channelType: channelTypeSchema,
  platformId: z.string().min(1),
  subjectId: z.string().min(1),
  boundAt: z.number(),
})

const conversationSchema = z.object({
  channelId: z.string().min(1),
  channelType: channelTypeSchema,
  chatId: z.string().min(1),
  chatKind: z.enum(['dm', 'group']),
  threadId: z.string().optional(),
  subjectId: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const pendingSenderSchema = z.object({
  channelId: z.string().min(1),
  channelType: channelTypeSchema,
  platformId: z.string().min(1),
  displayName: z.string().optional(),
  preview: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  messages: z.number(),
})

const globalSchema = z.object({
  legacyImported: z.boolean(),
  configSeeded: z.boolean(),
})

/**
 * The channels domain. `layout: 'single'` (the default) keeps the whole plugin
 * state in one document, matching the previous file-based medium's atomicity
 * while gaining schema validation and the write chain.
 */
export const CHANNELS_DOMAIN = defineDomain({
  // Domain names are POSIX-ish identifiers (no hyphens) — it doubles as the
  // backend unit name.
  name: 'tentacle_channels',
  version: 1,
  tables: {
    channels: domainTable(instanceSchema),
    bindings: domainTable(bindingSchema),
    conversations: domainTable(conversationSchema),
    offsets: domainTable(z.union([z.number(), z.string().min(1)])),
    pending_senders: domainTable(pendingSenderSchema),
  },
  global: { schema: globalSchema, initial: emptyGlobal() },
})

/**
 * Open the channels domain and project it onto the {@link ChannelsStore} port.
 *
 * The two `as unknown as` casts are the brand seam: record shapes are validated
 * by the zod schemas above, while `TenantId`/`ChannelType` are compile-time
 * markers that zod cannot reproduce. Nothing else in the plugin casts.
 */
export async function openChannelsStore(ctx: Context): Promise<ChannelsStore> {
  const domain = await ctx.storageDomain.open(CHANNELS_DOMAIN)
  return {
    channels: domain.table('channels') as unknown as Table<string, ChannelInstance>,
    bindings: domain.table('bindings') as unknown as Table<string, ChannelBinding>,
    conversations: domain.table('conversations') as unknown as Table<string, ConversationLink>,
    offsets: domain.table('offsets'),
    pendingSenders: domain.table('pending_senders') as unknown as Table<string, PendingSender>,
    readGlobal: () => domain.global.get(),
    writeGlobal: (next) => domain.global.set(next),
    close: () => domain.close(),
  }
}
