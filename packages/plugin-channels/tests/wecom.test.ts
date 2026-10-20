/**
 * WeCom adapter tests run against a real loopback WebSocket server. Assertions
 * inspect protocol frames independently: auth, ping, passive/proactive bodies,
 * reconnect authentication, and the normalized InboundMessage contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeWeComApi, textCallback } from './fake-wecom-api.js'
import { WeComAdapter } from '../src/adapter/wecom.js'
import type { InboundMessage } from '../src/types.js'

const servers: FakeWeComApi[] = []
const adapters: WeComAdapter[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

async function fakeServer(options: ConstructorParameters<typeof FakeWeComApi>[0] = {}): Promise<FakeWeComApi> {
  const server = new FakeWeComApi(options)
  servers.push(server)
  await server.listen()
  return server
}

async function startAdapter(server: FakeWeComApi): Promise<{
  readonly adapter: WeComAdapter
  readonly messages: InboundMessage[]
  readonly logs: string[]
}> {
  const messages: InboundMessage[] = []
  const logs: string[] = []
  const adapter = new WeComAdapter({
    id: 'ch-wecom',
    credentials: { botId: 'bot-1', secret: 'super-secret' },
    wsUrl: server.url,
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  adapters.push(adapter)
  adapter.onMessage(async (message) => { messages.push(message) })
  await adapter.start()
  return { adapter, messages, logs }
}

describe('WeComAdapter connection protocol', () => {
  it('sends the exact subscribe frame and finishes start only after authentication', async () => {
    const server = await fakeServer()
    const { adapter, logs } = await startAdapter(server)

    const subscriptions = server.recorded('aibot_subscribe')
    expect(subscriptions).toHaveLength(1)
    const frame = subscriptions[0]!.frame
    expect(frame).toEqual({
      cmd: 'aibot_subscribe',
      headers: { req_id: expect.stringMatching(/^aibot_subscribe_\d+_[0-9a-f]{8}$/) },
      body: { bot_id: 'bot-1', secret: 'super-secret' },
    })
    expect(adapter.channelType).toBe('wecom')
    expect(adapter.identity).toEqual({ id: 'bot-1' })
    expect(logs.join('\n')).not.toContain('super-secret')
  })

  it('emits the SDK application heartbeat after 30 seconds', async () => {
    const server = await fakeServer()
    vi.useFakeTimers()
    await startAdapter(server)
    const nextPing = server.waitForFrame((record) => record.frame.cmd === 'ping', 0)
    await vi.advanceTimersByTimeAsync(30_000)
    const ping = await nextPing
    expect(ping.frame).toEqual({
      cmd: 'ping',
      headers: { req_id: expect.stringMatching(/^ping_\d+_[0-9a-f]{8}$/) },
    })
    expect(ping.frame).not.toHaveProperty('body')
  })

  it('reconnects with exponential-delay scheduling and authenticates the new socket', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    expect(server.connectionCount()).toBe(1)

    const reauthenticated = server.waitForFrame((record) => (
      record.connectionId === 2 && record.frame.cmd === 'aibot_subscribe'
    ))
    server.drop(1)
    const secondAuth = await reauthenticated
    expect(secondAuth.frame.body).toEqual({ bot_id: 'bot-1', secret: 'super-secret' })
    expect(server.recorded('aibot_subscribe')).toHaveLength(2)

    server.send(textCallback({ reqId: 'req-after-reconnect', msgId: 'msg-after-reconnect' }), 2)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.messageId).toBe('ch-wecom:msg-after-reconnect')
  })

  it('marks a server-side replacement connection as non-recoverable', async () => {
    const server = await fakeServer()
    const { adapter } = await startAdapter(server)
    server.send({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'event-replaced' },
      body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } },
    })
    await vi.waitFor(() => expect(adapter.failure?.message).toContain('replaced by a newer connection'))
    // SDK semantics forbid reconnecting a connection replaced by a newer one.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(server.recorded('aibot_subscribe')).toHaveLength(1)
  })

  it('marks authentication refusal as failure without leaking the secret', async () => {
    const server = await fakeServer({ authError: { errcode: 40001, errmsg: 'invalid credentials' } })
    const logs: string[] = []
    const adapter = new WeComAdapter({
      id: 'ch-wecom',
      credentials: { botId: 'bot-1', secret: 'super-secret' },
      wsUrl: server.url,
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    adapters.push(adapter)
    await expect(adapter.start()).rejects.toThrow('wecom authentication failed (code 40001)')
    expect(adapter.failure).toBeDefined()
    expect(adapter.failure!.message).not.toContain('super-secret')
    expect(logs.join('\n')).not.toContain('super-secret')
  })
})

describe('WeComAdapter inbound normalization', () => {
  it('normalizes a single-chat text callback with an instance-prefixed message id', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    server.send(textCallback({ reqId: 'req-dm-1', msgId: 'msg-dm-1', text: '你好' }))
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    expect(messages[0]).toEqual({
      channelId: 'ch-wecom',
      channelType: 'wecom',
      messageId: 'ch-wecom:msg-dm-1',
      subject: { chatId: 'alice', kind: 'dm' },
      sender: { platformId: 'alice' },
      content: [{ type: 'text', text: '你好' }],
      receivedAt: 1_700_000_000_000,
      metadata: { messageId: 'msg-dm-1', chatType: 'single', botMentioned: false },
    })
  })

  it('treats group callbacks as platform-@-gated and drops an identifiable bot author', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    // Deliberately no @ token and no invented mention metadata: the valid
    // group callback itself is the protocol's addressing signal.
    server.send(textCallback({
      reqId: 'req-group-1',
      msgId: 'msg-group-1',
      chatType: 'group',
      chatId: 'room-42',
      text: 'inspect this',
    }))
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.subject).toEqual({ chatId: 'room-42', kind: 'group' })
    expect(messages[0]!.metadata).toMatchObject({ chatType: 'group', botMentioned: true })

    server.send(textCallback({ reqId: 'req-bot', msgId: 'msg-bot', senderId: 'bot-1', text: 'feedback loop' }))
    // A later valid callback is a barrier proving the bot frame was consumed.
    server.send(textCallback({ reqId: 'req-after-bot', msgId: 'msg-after-bot', text: 'real user' }))
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages.map((message) => message.messageId)).toEqual([
      'ch-wecom:msg-group-1',
      'ch-wecom:msg-after-bot',
    ])
  })

  it('turns image and file callbacks into reference-shaped content parts', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    server.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-image' },
      body: {
        msgid: 'msg-image', aibotid: 'bot-1', chattype: 'single', from: { userid: 'alice' },
        msgtype: 'image', image: { url: 'https://media.invalid/image', aeskey: 'not-logged' },
      },
    })
    server.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-file' },
      body: {
        msgid: 'msg-file', aibotid: 'bot-1', chattype: 'single', from: { userid: 'alice' },
        msgtype: 'file', file: { url: 'https://media.invalid/file', file_name: 'report.pdf' },
      },
    })
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages[0]!.content).toEqual([{ type: 'image', reference: 'https://media.invalid/image' }])
    expect(messages[1]!.content).toEqual([{ type: 'file', name: 'report.pdf', reference: 'https://media.invalid/file' }])
  })
})

describe('WeComAdapter outbound priority', () => {
  it('uses a passive stream reply with callback req_id, then proactive Markdown without one', async () => {
    const server = await fakeServer()
    const { adapter, messages } = await startAdapter(server)
    server.send(textCallback({ reqId: 'req-callback-1', msgId: 'msg-callback-1' }))
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    await adapter.send(messages[0]!.subject, [{ type: 'text', text: 'passive answer' }])
    const replies = server.recorded('aibot_respond_msg')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.frame.headers).toEqual({ req_id: 'req-callback-1' })
    expect(replies[0]!.frame.body).toEqual({
      msgtype: 'stream',
      stream: {
        id: expect.stringMatching(/^him_\d+_[0-9a-f]{8}$/),
        finish: true,
        content: 'passive answer',
      },
    })
    expect(server.recorded('aibot_send_msg')).toHaveLength(0)

    // The finished stream consumed its callback context, so the same chat now
    // takes the independent proactive path.
    await adapter.send(messages[0]!.subject, [{ type: 'text', text: 'proactive answer' }])
    const pushes = server.recorded('aibot_send_msg')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.frame).toEqual({
      cmd: 'aibot_send_msg',
      headers: { req_id: expect.stringMatching(/^aibot_send_msg_\d+_[0-9a-f]{8}$/) },
      body: {
        chatid: 'alice',
        msgtype: 'markdown',
        markdown: { content: 'proactive answer' },
      },
    })
  })
})
