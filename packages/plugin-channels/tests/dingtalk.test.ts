/**
 * DingTalk adapter contract tests against real loopback HTTP and WebSocket
 * servers. Assertions inspect the fake's independently recorded protocol
 * fields: credential names, ticket encoding, Stream ACKs and OpenAPI bodies.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FakeDingTalkApi, callbackFrame, chatbotData } from './fake-dingtalk-api.js'
import {
  DINGTALK_CHATBOT_TOPIC,
  DingTalkAdapter,
  dingtalkContentParts,
  stripAtMention,
} from '../src/adapter/dingtalk.js'
import type { InboundMessage } from '../src/types.js'

const servers: FakeDingTalkApi[] = []
const adapters: DingTalkAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

async function fakeServer(options: ConstructorParameters<typeof FakeDingTalkApi>[0] = {}): Promise<FakeDingTalkApi> {
  const server = new FakeDingTalkApi(options)
  servers.push(server)
  await server.listen()
  return server
}

interface Started {
  readonly adapter: DingTalkAdapter
  readonly messages: InboundMessage[]
  readonly logs: string[]
}

async function startAdapter(server: FakeDingTalkApi, options: {
  readonly id?: string
  readonly robotCode?: string
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
} = {}): Promise<Started> {
  const messages: InboundMessage[] = []
  const logs: string[] = []
  const adapter = new DingTalkAdapter({
    id: options.id ?? 'ch-ding',
    apiBaseUrl: server.baseUrl,
    streamUrl: server.baseUrl,
    credentials: {
      clientId: 'cli_fake',
      clientSecret: 'client-secret',
      ...(options.robotCode === undefined ? {} : { robotCode: options.robotCode }),
    },
    reconnectBaseMs: options.reconnectBaseMs ?? 20,
    reconnectMaxMs: options.reconnectMaxMs ?? 50,
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  adapter.onMessage(async (message) => { messages.push(message) })
  adapters.push(adapter)
  await adapter.start()
  return { adapter, messages, logs }
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('DingTalkAdapter Stream lifecycle', () => {
  it('posts the real handshake credentials and appends an encoded ticket to the WS URL', async () => {
    const server = await fakeServer({ ticket: 'ticket +/%?=' })
    const { adapter } = await startAdapter(server)

    expect(server.callsTo('open')).toHaveLength(1)
    expect(server.callsTo('open')[0]!.body).toEqual({
      clientId: 'cli_fake',
      clientSecret: 'client-secret',
      subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_CHATBOT_TOPIC }],
      ua: 'tentacle-dingtalk/1.0',
      localIp: '',
    })
    expect(server.socketCount()).toBe(1)
    const rawUrl = server.socketUrl()
    expect(rawUrl).toBe('/stream?ticket=ticket%20%2B%2F%25%3F%3D')
    expect(new URL(rawUrl, 'ws://fake').searchParams.get('ticket')).toBe('ticket +/%?=')
    // No bot-info endpoint exists in the cited contract; WS OPEN is enough.
    expect(adapter.identity).toBeUndefined()
    expect(adapter.failure).toBeUndefined()
  })

  it('answers an application-level SYSTEM ping with the protocol ACK and echoed data', async () => {
    const server = await fakeServer()
    await startAdapter(server)
    server.sendFrame({
      specVersion: '1.0',
      type: 'SYSTEM',
      headers: { messageId: 'system-ping-1', topic: 'ping', contentType: 'application/json' },
      data: JSON.stringify({ pingAt: 1700000000000 }),
    })

    await until(() => server.socketFrames().length === 1)
    expect(server.socketFrames()[0]).toEqual({
      code: 200,
      headers: { messageId: 'system-ping-1', contentType: 'application/json' },
      message: 'OK',
      data: JSON.stringify({ pingAt: 1700000000000 }),
    })
  })

  it('reconnects a fresh ticket with exponential backoff and resets it after READY', async () => {
    const server = await fakeServer()
    const { logs } = await startAdapter(server, { reconnectBaseMs: 20, reconnectMaxMs: 50 })
    expect(server.openAttempts).toHaveLength(1)

    // Two failed handshakes precede the successful fresh-ticket connection.
    server.failOpenAttempts = 2
    server.closeSocket(0)
    await until(() => server.openAttempts.length === 4 && server.socketCount() === 2)
    expect(logs.filter((line) => line.includes('reconnecting in'))).toEqual([
      'debug:dingtalk reconnecting in 20ms',
      'debug:dingtalk reconnecting in 40ms',
      'debug:dingtalk reconnecting in 50ms',
    ])
    expect(server.callsTo('open')).toHaveLength(4)

    // WS OPEN (the adapter's READY boundary) resets the next disconnect to 20ms.
    server.closeSocket(1)
    await until(() => server.openAttempts.length === 5 && server.socketCount() === 3)
    expect(logs.filter((line) => line.includes('reconnecting in')).at(-1)).toBe('debug:dingtalk reconnecting in 20ms')
  })

  it('marks rejected Stream credentials as a non-recoverable failure', async () => {
    const server = await fakeServer({ openErrorStatus: 401 })
    const adapter = new DingTalkAdapter({
      id: 'ch-ding',
      apiBaseUrl: server.baseUrl,
      streamUrl: server.baseUrl,
      credentials: { clientId: 'cli_bad', clientSecret: 'do-not-log-this' },
    })
    adapters.push(adapter)
    await expect(adapter.start()).rejects.toThrow(/HTTP 401/)
    expect(adapter.failure).toBeDefined()
    expect(adapter.failure!.message).not.toContain('do-not-log-this')
    expect(server.socketCount()).toBe(0)
  })
})

describe('DingTalkAdapter inbound normalization and ACK', () => {
  it('normalizes a DM using msgId/senderStaffId and writes the callback ACK', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    server.sendFrame(callbackFrame(chatbotData({ msgId: 'msg-dm' }), 'frame-dm'))

    await until(() => messages.length === 1)
    expect(messages[0]).toMatchObject({
      channelId: 'ch-ding',
      channelType: 'dingtalk',
      messageId: 'dingtalk:ch-ding:msg-dm',
      subject: { chatId: 'staff-7', kind: 'dm' },
      sender: { platformId: 'staff-7', displayName: 'Ada' },
      content: [{ type: 'text', text: 'hello' }],
      receivedAt: 1_700_000_000_000,
      metadata: { messageId: 'msg-dm', streamMessageId: 'frame-dm', conversationId: 'cid-dm', conversationType: '1' },
    })
    await until(() => server.socketFrames().length === 1)
    expect(server.socketFrames()[0]).toEqual({
      code: 200,
      headers: { messageId: 'frame-dm', contentType: 'application/json' },
      message: 'OK',
      data: JSON.stringify({ response: 'OK' }),
    })
  })

  it('uses isInAtList for the group gate, strips the leading mention and dedupes retries', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    const common = {
      conversationId: 'cid-group',
      conversationType: '2',
      conversationTitle: 'Ops',
      text: { content: '@Tentacle run the tests' },
    }
    server.sendFrame(callbackFrame(chatbotData({ ...common, msgId: 'group-ignore', isInAtList: false }), 'frame-g1'))
    const accepted = chatbotData({ ...common, msgId: 'group-accept', isInAtList: true })
    server.sendFrame(callbackFrame(accepted, 'frame-g2'))
    await until(() => messages.length === 1)

    expect(messages[0]!.subject).toEqual({ chatId: 'cid-group', kind: 'group' })
    expect(messages[0]!.groupContext).toBe('Ops')
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'run the tests' }])

    // Same platform msgId on a new Stream delivery: ACK, but no second route.
    server.sendFrame(callbackFrame(accepted, 'frame-g3'))
    await until(() => server.socketFrames().length === 3)
    expect(messages).toHaveLength(1)
    expect(server.socketFrames().map((frame) => frame.code)).toEqual([200, 200, 200])
  })

  it('drops a message authored by the bot itself before invoking the router', async () => {
    const server = await fakeServer()
    const { messages } = await startAdapter(server)
    server.sendFrame(callbackFrame(chatbotData({ msgId: 'from-bot', senderId: 'bot-user', senderStaffId: 'bot-user' }), 'frame-bot'))
    server.sendFrame(callbackFrame(chatbotData({ msgId: 'from-user' }), 'frame-user'))

    await until(() => messages.length === 1 && server.socketFrames().length === 2)
    expect(messages[0]!.messageId).toBe('dingtalk:ch-ding:from-user')
  })

  it('maps media to references and other types to deterministic placeholders', () => {
    expect(dingtalkContentParts({ msgtype: 'picture', content: { downloadCode: 'picture-code' } })).toEqual([
      { type: 'image', reference: 'dingtalk:picture-code' },
    ])
    expect(dingtalkContentParts({ msgtype: 'file', content: { downloadCode: 'file-code', fileName: 'report.pdf' } })).toEqual([
      { type: 'file', name: 'report.pdf', reference: 'dingtalk:file-code' },
    ])
    expect(dingtalkContentParts({
      msgtype: 'richText',
      content: { richText: [{ text: 'look' }, { type: 'picture', downloadCode: 'rich-image' }] },
    })).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', reference: 'dingtalk:rich-image' },
    ])
    expect(dingtalkContentParts({ msgtype: 'video', content: {} })).toEqual([
      { type: 'text', text: '[dingtalk: video without downloadCode]' },
    ])
    expect(dingtalkContentParts({ msgtype: 'location', content: {} })).toEqual([
      { type: 'text', text: '[dingtalk: unsupported message type "location"]' },
    ])
    expect(stripAtMention('@Tentacle hello')).toBe('hello')
  })
})

describe('DingTalkAdapter outbound and access tokens', () => {
  it('prefers sessionWebhook, then sends a DM through OpenAPI with the exact body', async () => {
    const server = await fakeServer()
    const { adapter, messages } = await startAdapter(server, { robotCode: 'robot-custom' })
    const webhook = `${server.baseUrl}/robot/sendBySession?session=reply-secret`
    server.sendFrame(callbackFrame(chatbotData({ msgId: 'reply-here', sessionWebhook: webhook }), 'frame-reply'))
    await until(() => messages.length === 1)

    await adapter.send(messages[0]!.subject, [{ type: 'text', text: 'webhook reply' }])
    expect(server.callsTo('webhook')).toHaveLength(1)
    expect(server.callsTo('webhook')[0]!.body).toEqual({
      msgtype: 'markdown',
      markdown: { title: 'Tentacle', text: 'webhook reply' },
    })
    expect(server.callsTo('token')).toHaveLength(0)
    expect(server.callsTo('direct')).toHaveLength(0)

    await adapter.send({ chatId: 'staff-proactive', kind: 'dm' }, [{ type: 'text', text: 'proactive reply' }])
    expect(server.callsTo('token')[0]!.body).toEqual({ appKey: 'cli_fake', appSecret: 'client-secret' })
    const direct = server.callsTo('direct')[0]!
    expect(direct.accessToken).toBe('dt-token-1')
    expect(direct.body).toEqual({
      robotCode: 'robot-custom',
      userIds: ['staff-proactive'],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'Tentacle', text: 'proactive reply' }),
    })
  })

  it('reuses a valid accessToken and defaults robotCode to clientId', async () => {
    const server = await fakeServer({ expireInSeconds: 7200 })
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: 'staff-1', kind: 'dm' }, [{ type: 'text', text: 'one' }])
    await adapter.send({ chatId: 'staff-2', kind: 'dm' }, [{ type: 'text', text: 'two' }])

    expect(server.callsTo('token')).toHaveLength(1)
    expect(server.callsTo('direct').map((call) => call.accessToken)).toEqual(['dt-token-1', 'dt-token-1'])
    expect(server.callsTo('direct')[0]!.body.robotCode).toBe('cli_fake')
  })

  it('refreshes an accessToken inside the five-minute expiry margin', async () => {
    const server = await fakeServer({ expireInSeconds: 30 })
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: 'staff-1', kind: 'dm' }, [{ type: 'text', text: 'one' }])
    await adapter.send({ chatId: 'staff-2', kind: 'dm' }, [{ type: 'text', text: 'two' }])

    expect(server.callsTo('token')).toHaveLength(2)
    expect(server.callsTo('direct').map((call) => call.accessToken)).toEqual(['dt-token-1', 'dt-token-2'])
  })
})
