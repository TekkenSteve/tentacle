/**
 * Telegram adapter tests, driven through a local fake Bot API (design 06 §7).
 *
 * What this suite pins down:
 * - the `getUpdates` cursor: loaded from the store, advanced only after a
 *   batch was handled, persisted through `onAck`;
 * - inbound parsing: DM vs group, the @-mention gate, commands, media;
 * - outbound: 4096-character chunking and the Markdown→plain fallback;
 * - shutdown: `stop()` ends the poll loop and releases the socket.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FakeBotApi, dmUpdate, groupUpdate } from './fake-bot-api.js'
import {
  TELEGRAM_MESSAGE_LIMIT,
  TelegramAdapter,
  contentPartsOf,
  isAddressedToBot,
  splitMessage,
} from '../src/adapter/telegram.js'
import type { InboundMessage, OffsetStore } from '../src/types.js'

const servers: FakeBotApi[] = []
const adapters: TelegramAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

async function startAdapter(server: FakeBotApi, options: {
  /** Instance id; defaults to the single-bot `telegram` instance. */
  id?: string
  store?: OffsetStore
  messages?: InboundMessage[]
  typing?: boolean
} = {}): Promise<{ adapter: TelegramAdapter; messages: InboundMessage[]; store: OffsetStore }> {
  const id = options.id ?? 'telegram'
  const messages = options.messages ?? []
  const persisted: Record<string, number> = {}
  const store: OffsetStore = options.store ?? {
    load: async (instanceId) => persisted[instanceId],
    save: async (instanceId, offset) => { persisted[instanceId] = offset },
  }
  const adapter = new TelegramAdapter({
    id,
    apiBaseUrl: server.baseUrl,
    token: 'test-token',
    pollTimeoutSec: 1,
    pollIntervalMs: 5,
    typing: options.typing ?? false,
    offsetStore: store,
    onAck: (offset) => { void store.save(id, offset) },
  })
  adapter.onMessage(async (message) => { messages.push(message) })
  adapters.push(adapter)
  await adapter.start()
  return { adapter, messages, store }
}

/** Wait until `predicate` holds; fails the test on timeout. */
async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('TelegramAdapter cursor', () => {
  it('starts from the persisted offset and advances it after handling a batch', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const persisted = { telegram: 41 }
    const store: OffsetStore = {
      load: async () => persisted.telegram,
      save: async (_id, offset) => { persisted.telegram = offset },
    }
    const { adapter, messages } = await startAdapter(server, { store })
    expect(adapter.channelId).toBe('telegram')
    server.push(dmUpdate(41, 'first'), dmUpdate(42, 'second'))

    await until(() => messages.length === 2)
    expect(messages.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])

    // The next poll must continue past the acknowledged batch, never replay it.
    const next = await server.waitForCall('getUpdates', (body) => body.offset === 43)
    expect(next.body).toMatchObject({ offset: 43, allowed_updates: ['message'] })
    await until(() => persisted.telegram === 43)
  })

  it('reads and writes the cursor of its own instance, not of another bot', async () => {
    // Two adapters of the same platform, two instance ids, one offset store:
    // each must load and persist under its own `channelId` (design 07 §1).
    const persisted: Record<string, number> = { 'bot-a': 41, 'bot-b': 7 }
    const store: OffsetStore = {
      load: async (id) => persisted[id],
      save: async (id, offset) => { persisted[id] = offset },
    }
    const firstOffsets: Record<string, number> = {}
    const make = (id: string): TelegramAdapter => new TelegramAdapter({
      id,
      token: 'test-token',
      pollIntervalMs: 5,
      typing: false,
      offsetStore: store,
      api: {
        getMe: async () => ({ id: 1, is_bot: true, username: 'bot' }),
        listUpdates: async (offset) => {
          firstOffsets[id] ??= offset
          return []
        },
        sendMessage: async () => undefined,
        sendChatAction: async () => undefined,
      },
    })
    const a = make('bot-a')
    const b = make('bot-b')
    adapters.push(a, b)
    await a.start()
    await b.start()

    expect(a.channelId).toBe('bot-a')
    expect(b.channelId).toBe('bot-b')
    await until(() => firstOffsets['bot-a'] !== undefined && firstOffsets['bot-b'] !== undefined)
    expect(firstOffsets).toEqual({ 'bot-a': 41, 'bot-b': 7 })

    a.setOffset(42)
    b.setOffset(8)
    await until(() => persisted['bot-a'] === 42 && persisted['bot-b'] === 8)
    expect(persisted).toEqual({ 'bot-a': 42, 'bot-b': 8 })
  })

  it('acknowledges a batch whose router decision failed, so one message cannot stall the channel', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const accepted: string[] = []
    const acks: number[] = []
    const adapter = new TelegramAdapter({
      id: 'telegram',
      apiBaseUrl: server.baseUrl,
      token: 'test-token',
      pollTimeoutSec: 1,
      pollIntervalMs: 5,
      typing: false,
      onAck: (offset) => acks.push(offset),
    })
    adapter.onMessage(async (message) => {
      accepted.push(message.messageId)
      // The router refuses this one, so nothing may be acknowledged.
      if (message.messageId.endsWith(':20')) throw new Error('router refused')
    })
    adapters.push(adapter)
    await adapter.start()
    server.push(dmUpdate(2, 'ok'), dmUpdate(3, 'rejected'))
    await until(() => accepted.length === 2)
    // The cursor moves once for the batch even though one message was
    // refused: Telegram will not redeliver an acknowledged update, and a
    // message that keeps failing must not pin the cursor forever.
    await until(() => acks.includes(4))
    expect(acks).toEqual([4])
  })

  it('acknowledges within a multi-update batch only once, at the highest id', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const acks: number[] = []
    const adapter = new TelegramAdapter({
      id: 'telegram',
      apiBaseUrl: server.baseUrl,
      token: 'test-token',
      pollTimeoutSec: 1,
      pollIntervalMs: 5,
      typing: false,
      onAck: (offset) => acks.push(offset),
    })
    adapter.onMessage(async () => undefined)
    adapters.push(adapter)
    await adapter.start()
    server.push(dmUpdate(7, 'a'), dmUpdate(8, 'b'), dmUpdate(9, 'c'))
    await until(() => acks.includes(10))
    expect(acks).toEqual([10])
  })
})

describe('TelegramAdapter failure handling', () => {
  it('keeps the cursor where it was when a poll cannot complete', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const acks: number[] = []
    const baseUrl = server.baseUrl
    let calls = 0
    const adapter = new TelegramAdapter({
      id: 'telegram',
      apiBaseUrl: baseUrl,
      token: 'test-token',
      pollTimeoutSec: 1,
      pollIntervalMs: 5,
      typing: false,
      onAck: (offset) => acks.push(offset),
      api: {
        getMe: async () => ({ id: 1, is_bot: true, username: 'bot' }),
        listUpdates: async (offset) => {
          calls += 1
          if (calls === 1) throw new Error('socket closed mid-poll')
          if (calls === 2) return [{ update_id: 7, message: undefined } as never]
          return []
        },
        sendMessage: async () => undefined,
        sendChatAction: async () => undefined,
      },
    })
    adapter.onMessage(async () => undefined)
    adapters.push(adapter)
    await adapter.start()
    await until(() => acks.includes(8))
    // A failed poll must not fabricate a cursor movement of its own.
    expect(acks).toEqual([8])
  })
})

describe('TelegramAdapter cursor acknowledgement', () => {
  it('writes the cursor through the offset store when the service acks a message', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const persisted: Record<string, number> = {}
    const store: OffsetStore = {
      load: async (id) => persisted[id],
      save: async (id, offset) => { persisted[id] = offset },
    }
    const adapter = new TelegramAdapter({
      id: 'telegram',
      apiBaseUrl: server.baseUrl,
      token: 'test-token',
      pollTimeoutSec: 1,
      pollIntervalMs: 5,
      typing: false,
      offsetStore: store,
      onAck: (offset) => { void store.save('telegram', offset) },
    })
    adapter.onMessage(async (message) => {
      // What the service does once the router accepted the message.
      adapter.setOffset(Number(message.metadata['updateId']) + 1)
    })
    adapters.push(adapter)
    await adapter.start()
    server.push(dmUpdate(21, 'persist me'))
    await until(() => persisted.telegram === 22)
    expect(persisted.telegram).toBe(22)
  })
})

describe('TelegramAdapter inbound parsing', () => {
  it('normalizes a DM into an InboundMessage with the sender identity', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { messages } = await startAdapter(server)
    server.push(dmUpdate(5, 'hello there'))
    await until(() => messages.length === 1)
    const message = messages[0]!
    expect(message.channelType).toBe('telegram')
    expect(message.subject).toEqual({ chatId: '7', kind: 'dm' })
    expect(message.sender).toMatchObject({ platformId: '7', displayName: 'Ada' })
    expect(message.metadata).toMatchObject({ updateId: 5 })
  })

  it('routes group messages only when the bot is addressed', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { messages } = await startAdapter(server)
    const bot = 'tentacle_test_bot'
    server.push(
      // plain chatter, no mention, no command
      { update_id: 1, message: { message_id: 11, date: 1, chat: { id: -100, type: 'supergroup', title: 'Ops' }, from: { id: 7, is_bot: false }, text: 'morning all' } },
      groupUpdate(2, 'run the tests'),
      { update_id: 3, message: { message_id: 13, date: 1, chat: { id: -100, type: 'supergroup', title: 'Ops' }, from: { id: 7, is_bot: false }, text: '/status' } },
    )
    await until(() => messages.length === 2)
    expect(messages.map((m) => m.subject.kind)).toEqual(['group', 'group'])
    expect(messages[0]!.content).toEqual([{ type: 'text', text: '@tentacle_test_bot run the tests' }])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '/status' }])
    expect(messages[1]!.groupContext).toBe('Ops')
    expect(isAddressedToBot({ text: '@other_bot hi', entities: [{ type: 'mention', offset: 0, length: 10 }] }, bot)).toBe(false)
  })

  it('ignores bot authors, channel posts and empty payloads', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { messages } = await startAdapter(server)
    server.push(
      { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, from: { id: 99, is_bot: true }, text: 'beep' } },
      { update_id: 2, message: { message_id: 2, date: 1, chat: { id: -5, type: 'channel' }, text: 'post' } },
      { update_id: 3, message: { message_id: 3, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false } } },
      dmUpdate(4, 'the only one')
    )
    await until(() => messages.length === 1)
    expect(messages[0]!.messageId).toBe('telegram:7:40')
  })

  it('turns media into honest content parts', () => {
    expect(contentPartsOf({ photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: 'look' })).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', reference: 'large' },
    ])
    expect(contentPartsOf({ document: { file_id: 'doc', file_name: 'report.pdf' } })).toEqual([
      { type: 'file', name: 'report.pdf', reference: 'doc' },
    ])
    expect(contentPartsOf({ voice: { file_id: 'v' } })).toEqual([{ type: 'file', name: 'attachment', reference: 'v' }])
    expect(contentPartsOf({})).toEqual([])
  })
})

describe('TelegramAdapter outbound', () => {
  it('splits a long reply at the platform limit', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { adapter } = await startAdapter(server)
    const paragraph = 'a'.repeat(2000)
    await adapter.send({ chatId: '7', kind: 'dm' }, [{ type: 'text', text: `${paragraph}\n\n${paragraph}\n\n${paragraph}` }])
    const sent = server.callsTo('sendMessage')
    expect(sent.length).toBeGreaterThan(1)
    for (const call of sent) {
      expect(Array.from(String(call.body.text)).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
    expect(sent.map((c) => c.body.text).join('\n\n').replaceAll('\n\n', '')).toBe(`${paragraph}${paragraph}${paragraph}`)
  })

  it('retries a rejected Markdown body as plain text', async () => {
    const server = new FakeBotApi({ sendMessageError: { error_code: 400, description: "Bad Request: can't parse entities", onlyWhenParseMode: true } })
    servers.push(server)
    await server.listen()
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: '7', kind: 'dm' }, [{ type: 'text', text: 'has *broken* entity' }])
    const sent = server.callsTo('sendMessage')
    expect(sent).toHaveLength(2)
    expect(sent[0]!.body.parse_mode).toBe('Markdown')
    expect(sent[1]!.body.parse_mode).toBeUndefined()
  })

  it('never sends an empty body and keeps the reply on the platform thread', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: '7', kind: 'group', threadId: '5' }, [{ type: 'text', text: '   ' }])
    expect(server.callsTo('sendMessage')).toHaveLength(0)
    await adapter.send({ chatId: '7', kind: 'group', threadId: '5' }, [{ type: 'text', text: 'threaded' }])
    expect(server.callsTo('sendMessage')[0]!.body).toMatchObject({ chat_id: '7', message_thread_id: 5 })
  })

  it('emits a typing action before the reply when enabled', async () => {
    const server = new FakeBotApi()
    servers.push(server)
    await server.listen()
    const { adapter } = await startAdapter(server, { typing: true })
    await adapter.send({ chatId: '7', kind: 'dm' }, [{ type: 'text', text: 'hi' }])
    expect(server.callsTo('sendChatAction')[0]!.body).toMatchObject({ chat_id: '7', action: 'typing' })
  })
})

describe('splitMessage', () => {
  it('leaves short text alone and prefers paragraph boundaries', () => {
    expect(splitMessage('short', 100)).toEqual(['short'])
    const text = `${'x'.repeat(60)}\n\n${'y'.repeat(60)}`
    expect(splitMessage(text, 80)).toEqual(['x'.repeat(60), 'y'.repeat(60)])
  })

  it('hard-cuts text with no boundary within the window', () => {
    const chunks = splitMessage('z'.repeat(250), 100)
    expect(chunks).toEqual(['z'.repeat(100), 'z'.repeat(100), 'z'.repeat(50)])
  })
})
