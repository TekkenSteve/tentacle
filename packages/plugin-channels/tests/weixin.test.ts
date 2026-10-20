import { afterEach, describe, expect, it } from 'vitest'
import {
  WeixinAdapter,
  weixinContentParts,
} from '../src/adapter/weixin.js'
import type { InboundMessage, OffsetStore } from '../src/types.js'
import { FakeWeixinApi, weixinTextMessage } from './fake-weixin-api.js'

const servers: FakeWeixinApi[] = []
const adapters: WeixinAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

async function fakeServer(options: ConstructorParameters<typeof FakeWeixinApi>[0] = {}): Promise<FakeWeixinApi> {
  const server = new FakeWeixinApi(options)
  servers.push(server)
  await server.listen()
  return server
}

function memoryOffsets(initial: Record<string, number | string> = {}): {
  store: OffsetStore
  values: Record<string, number | string>
} {
  const values = { ...initial }
  return {
    values,
    store: {
      load: async (id) => values[id],
      save: async (id, offset) => { values[id] = offset },
    },
  }
}

function makeAdapter(server: FakeWeixinApi, options: {
  id?: string
  store?: OffsetStore
  messages?: InboundMessage[]
  sessionPauseMs?: number
} = {}): { adapter: WeixinAdapter; messages: InboundMessage[] } {
  const messages = options.messages ?? []
  const adapter = new WeixinAdapter({
    id: options.id ?? 'wx-instance',
    baseUrl: server.baseUrl,
    credentials: { accountId: 'bot-account', token: 'test-token' },
    botUin: 'dGVzdA==',
    retryBaseMs: 5,
    sessionPauseMs: options.sessionPauseMs ?? 100,
    ...(options.store === undefined ? {} : { offsetStore: options.store }),
  })
  adapter.onMessage(async (message) => { messages.push(message) })
  adapters.push(adapter)
  return { adapter, messages }
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('WeixinAdapter getUpdates protocol and cursor', () => {
  it('sends the iLink auth envelope, advances/persists opaque buf, and resumes it', async () => {
    const server = await fakeServer()
    const { store, values } = memoryOffsets({ 'wx-instance': 'opaque-start/β' })
    server.pushUpdates({
      msgs: [weixinTextMessage(11, 'hello')],
      get_updates_buf: 'opaque-next/✓',
      longpolling_timeout_ms: 1_234,
    })
    const { adapter, messages } = makeAdapter(server, { store })
    await adapter.start()

    const first = server.callsTo('/ilink/bot/getupdates')[0]!
    expect(first.method).toBe('POST')
    expect(first.body).toEqual({
      get_updates_buf: 'opaque-start/β',
      base_info: { channel_version: '2.2.0' },
      longpolling_timeout_ms: 35_000,
    })
    expect(first.headers).toMatchObject({
      authorizationtype: 'ilink_bot_token',
      authorization: 'Bearer test-token',
      'x-wechat-uin': 'dGVzdA==',
      'ilink-app-id': 'bot',
      'ilink-app-clientversion': '131584',
    })
    expect(adapter.channelType).toBe('weixin')
    expect(adapter.identity).toEqual({ id: 'bot-account' })
    expect(messages[0]).toMatchObject({
      channelId: 'wx-instance',
      channelType: 'weixin',
      messageId: 'weixin:wx-instance:11',
      subject: { chatId: 'user-7', kind: 'dm' },
      sender: { platformId: 'user-7' },
      content: [{ type: 'text', text: 'hello' }],
      receivedAt: 1_700_000_000_123,
    })

    await server.waitForCall('/ilink/bot/getupdates', (call) =>
      call.body['get_updates_buf'] === 'opaque-next/✓' && call.body['longpolling_timeout_ms'] === 1_234)
    await until(() => values['wx-instance'] === 'opaque-next/✓')
    expect(values).toEqual({ 'wx-instance': 'opaque-next/✓' })

    await adapter.stop()
    const callCount = server.callsTo('/ilink/bot/getupdates').length
    const restarted = makeAdapter(server, { store }).adapter
    await restarted.start()
    const resumed = server.callsTo('/ilink/bot/getupdates')[callCount]!
    expect(resumed.body['get_updates_buf']).toBe('opaque-next/✓')
  })

  it('uses the adapter instance id, not a platform-wide cursor key', async () => {
    const server = await fakeServer()
    const { store, values } = memoryOffsets({ 'wx-a': 'buf-a', 'wx-b': 'buf-b' })
    server.pushUpdates({ msgs: [], get_updates_buf: 'next-a' })
    const a = makeAdapter(server, { id: 'wx-a', store }).adapter
    await a.start()
    await until(() => values['wx-a'] === 'next-a')
    expect(values['wx-b']).toBe('buf-b')
  })
})

describe('WeixinAdapter inbound normalization', () => {
  it('drops bot authors and does not invent group/mention semantics absent from the wire contract', async () => {
    const server = await fakeServer()
    server.pushUpdates({
      msgs: [
        weixinTextMessage(1, 'bot output', { message_type: 2 }),
        weixinTextMessage(2, 'user input', { session_id: 'unclassified-conversation' }),
      ],
      get_updates_buf: 'next',
    })
    const { messages } = makeAdapter(server)
    await adapters.at(-1)!.start()
    await until(() => messages.length === 1)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      messageId: 'weixin:wx-instance:2',
      subject: { chatId: 'user-7', kind: 'dm' },
      metadata: { sessionId: 'unclassified-conversation' },
    })
  })

  it('normalizes text and media references and degrades unknown parts deterministically', () => {
    expect(weixinContentParts({
      message_id: 99,
      item_list: [
        { type: 1, text_item: { text: 'caption' } },
        { type: 2, image_item: { url: 'https://cdn.example/image' } },
        { type: 2, image_item: { media: { encrypt_query_param: 'encrypted' } } },
        { type: 3, voice_item: { text: 'transcript' } },
        { type: 4, file_item: { file_name: 'report.pdf', url: 'https://cdn.example/file' } },
        { type: 5, video_item: { url: 'https://cdn.example/video' } },
        { type: 42 },
      ],
    })).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', reference: 'https://cdn.example/image' },
      { type: 'image', reference: 'weixin:99:image:2' },
      { type: 'text', text: 'transcript' },
      { type: 'file', name: 'report.pdf', reference: 'https://cdn.example/file' },
      { type: 'file', name: 'video', reference: 'https://cdn.example/video' },
      { type: 'text', text: '[weixin: unsupported item type "42"]' },
    ])
    expect(weixinContentParts({ content: 'raw fallback', item_list: [] })).toEqual([
      { type: 'text', text: 'raw fallback' },
    ])
    expect(weixinContentParts({ item_list: [{ type: 2, image_item: {} }, { type: 4, file_item: { file_name: 'x.bin' } }] })).toEqual([
      { type: 'text', text: '[weixin: image message without reference]' },
      { type: 'text', text: '[weixin: file message "x.bin" without reference]' },
    ])
  })
})

describe('WeixinAdapter context tokens and failures', () => {
  it('reuses/refreshes context_token and retries -2 once without it', async () => {
    const server = await fakeServer()
    server.pushUpdates({
      msgs: [weixinTextMessage(5, 'establish context', { context_token: 'ctx-a' })],
      get_updates_buf: 'after-context',
    })
    const { adapter } = makeAdapter(server)
    await adapter.start()

    server.pushSend({ ret: 0, context_token: 'ctx-b' })
    await adapter.send({ chatId: 'user-7', kind: 'dm' }, [{ type: 'text', text: 'first' }])
    server.pushSend({ ret: -2, errcode: -2 })
    server.pushSend({ ret: 0, context_token: 'ctx-c' })
    await adapter.send({ chatId: 'user-7', kind: 'dm' }, [{ type: 'text', text: 'second' }])
    await adapter.send({ chatId: 'user-7', kind: 'dm' }, [{ type: 'text', text: 'third' }])

    const sends = server.callsTo('/ilink/bot/sendmessage')
    expect(sends).toHaveLength(4)
    expect(sends.map((call) => (call.body['msg'] as Record<string, unknown>)['context_token'])).toEqual([
      'ctx-a', 'ctx-b', null, 'ctx-c',
    ])
    expect((sends[0]!.body['msg'] as Record<string, unknown>)).toMatchObject({
      from_user_id: '',
      to_user_id: 'user-7',
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'first' } }],
    })
    expect(sends[0]!.body['base_info']).toEqual({ channel_version: '2.2.0' })
  })

  it('records -14, pauses retries for the injected interval, then recovers', async () => {
    const server = await fakeServer()
    server.pushUpdates({ msgs: [], get_updates_buf: 'initial' })
    const { adapter } = makeAdapter(server, { sessionPauseMs: 100 })
    await adapter.start()
    server.pushUpdates({ ret: -14, errcode: -14 })
    server.pushUpdates({ msgs: [], get_updates_buf: 'recovered' })

    await until(() => adapter.failure !== undefined)
    const callsWhilePaused = server.callsTo('/ilink/bot/getupdates').length
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(server.callsTo('/ilink/bot/getupdates')).toHaveLength(callsWhilePaused)
    await until(() => adapter.failure === undefined && server.callsTo('/ilink/bot/getupdates').length > callsWhilePaused)
    await until(() => server.callsTo('/ilink/bot/getupdates').some((call) => call.body['get_updates_buf'] === 'recovered'))
  })

  it('starts in the paused/failed state when the first getUpdates is session-expired', async () => {
    const server = await fakeServer()
    server.pushUpdates({ ret: -14, errcode: -14 })
    const { adapter } = makeAdapter(server, { sessionPauseMs: 50 })
    // -14 at start is retryable (the reference implementation keeps pausing/retrying), not fatal.
    await adapter.start()
    expect(adapter.identity).toBeUndefined()
    expect(adapter.failure).toMatchObject({ errcode: -14 })
  })
})

describe('WeixinAdapter shutdown', () => {
  it('aborts an in-flight long poll instead of waiting 35 seconds', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    server.pushUpdates({ msgs: [], get_updates_buf: 'initial' })
    const { adapter } = makeAdapter(server)
    const handle = await adapter.start()
    await until(() => server.callsTo('/ilink/bot/getupdates').length >= 2)

    const started = Date.now()
    await handle.stop()
    expect(Date.now() - started).toBeLessThan(500)
    const calls = server.callsTo('/ilink/bot/getupdates').length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.callsTo('/ilink/bot/getupdates')).toHaveLength(calls)
    await until(() => server.abortedRequests >= 1)
  })
})

describe('WeixinAdapter official wire shape', () => {
  it('parses the snake_case envelope the official SDK documents (captured live)', async () => {
    const server = await fakeServer()
    // Verbatim shape from GET /ilink/bot/getupdates: snake_case cursor, the
    // extra sync_buf, and a snake_case message. The adapter used to read
    // camelCase only and silently dropped every message.
    server.pushUpdates({
      msgs: [{
        seq: 429,
        message_id: 9812451782375,
        from_user_id: 'o9cq800kum@im.wechat',
        to_user_id: 'bot-account',
        create_time_ms: 1_700_000_000_123,
        session_id: 'o9cq800kum@im.wechat#bot-account',
        message_type: 1,
        message_state: 2,
        context_token: 'ctx-official',
        item_list: [{ type: 1, text_item: { text: 'official shape' } }],
      }],
      sync_buf: 'CAEYh5D1xZQ0',
      get_updates_buf: 'CgkIARiHkPXFlDQ',
    })
    const { store, values } = memoryOffsets()
    const { adapter, messages } = makeAdapter(server, { store })
    await adapter.start()
    await until(() => messages.length === 1)
    expect(messages[0]).toMatchObject({
      messageId: 'weixin:wx-instance:9812451782375',
      subject: { chatId: 'o9cq800kum@im.wechat', kind: 'dm' },
      sender: { platformId: 'o9cq800kum@im.wechat' },
      content: [{ type: 'text', text: 'official shape' }],
    })
    await until(() => values['wx-instance'] === 'CgkIARiHkPXFlDQ')
  })
})

describe('WeixinAdapter session expiry (-14)', () => {
  it('keeps a session-expired start retryable and recovers once the platform revives it', async () => {
    const server = await fakeServer()
    const { store, values } = memoryOffsets({ 'wx-instance': 'stale-cursor' })
    server.pushUpdates({ ret: -14, errcode: -14, errmsg: 'session timeout' })
    const { adapter, messages } = makeAdapter(server, { store, sessionPauseMs: 50 })

    // Old behaviour rejected start() here and left the instance stranded.
    await adapter.start()
    expect(adapter.failure?.message).toMatch(/session expired/)
    // The dead session's cursor and context are cleared (protocol §9.2).
    await until(() => values['wx-instance'] === '')

    server.pushUpdates({
      msgs: [weixinTextMessage(21, 'recovered')],
      get_updates_buf: 'fresh-cursor',
    })
    await until(() => messages.length === 1)
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'recovered' }])
    // A successful round trip clears the failure verdict.
    expect(adapter.failure).toBeUndefined()
    await until(() => values['wx-instance'] === 'fresh-cursor')
  })

  it('clears the persisted cursor when a live session expires mid-poll', async () => {
    const server = await fakeServer()
    const { store, values } = memoryOffsets()
    server.pushUpdates({ msgs: [], get_updates_buf: 'buf-1' })
    const { adapter } = makeAdapter(server, { store, sessionPauseMs: 60_000 })
    await adapter.start()
    await until(() => values['wx-instance'] === 'buf-1')

    server.pushUpdates({ ret: -14, errcode: -14, errmsg: 'session timeout' })
    await until(() => values['wx-instance'] === '')
    expect(adapter.failure?.message).toMatch(/re-scan the QR/)
  })
})
