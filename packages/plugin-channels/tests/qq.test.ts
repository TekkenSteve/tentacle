/**
 * QQ adapter protocol tests. REST headers/bodies and gateway frames are
 * asserted from the fake's own recordings, independently of adapter helpers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  QQAdapter,
  QQ_MESSAGE_LIMIT,
  qqContentParts,
} from '../src/adapter/qq.js'
import type { InboundMessage } from '../src/types.js'
import { FakeQQApi, type FakeQQConnection } from './fake-qq-api.js'

const fakes: FakeQQApi[] = []
const adapters: QQAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const fake of fakes.splice(0)) await fake.close()
})

interface Started {
  readonly fake: FakeQQApi
  readonly adapter: QQAdapter
  readonly messages: InboundMessage[]
}

async function startAdapter(options: { rejectFirstSendWith401?: boolean } = {}): Promise<Started> {
  const fake = await new FakeQQApi(options).listen()
  fakes.push(fake)
  const messages: InboundMessage[] = []
  const adapter = new QQAdapter({
    id: 'ch-qq-test',
    apiBaseUrl: fake.baseUrl,
    accessTokenUrl: `${fake.baseUrl}/app/getAppAccessToken`,
    credentials: { appId: 'qq-app', secret: 'qq-secret' },
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 20,
  })
  adapter.onMessage(async (message) => { messages.push(message) })
  adapters.push(adapter)
  await adapter.start()
  return { fake, adapter, messages }
}

async function hello(connection: FakeQQConnection, heartbeatInterval = 20): Promise<void> {
  connection.send({ op: 10, d: { heartbeat_interval: heartbeatInterval } })
  await connection.waitForFrame((frame) => frame['op'] === 2 || frame['op'] === 6)
}

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('QQAdapter gateway authentication and heartbeat', () => {
  it('authorizes /gateway/bot, sends exact IDENTIFY fields and heartbeats the last sequence', async () => {
    const { fake, adapter } = await startAdapter()
    const connection = await fake.waitForConnection(0)
    await hello(connection)

    expect(fake.tokenCalls).toHaveLength(1)
    expect(fake.tokenCalls[0]!.body).toEqual({ appId: 'qq-app', clientSecret: 'qq-secret' })
    expect(fake.gatewayCalls).toHaveLength(1)
    expect(fake.gatewayCalls[0]!.authorization).toBe('QQBot qq-token-1')
    const identify = await connection.waitForFrame((frame) => frame['op'] === 2)
    expect(identify).toEqual({
      op: 2,
      d: { token: 'QQBot qq-token-1', intents: 1_107_300_354, shard: [0, 1] },
    })

    connection.send({
      op: 0,
      s: 41,
      t: 'READY',
      d: { session_id: 'session-a', user: { id: 'bot-1', username: 'Tentacle QQ' } },
    })
    expect(await connection.waitForFrame((frame) => frame['op'] === 1 && frame['d'] === 41)).toEqual({ op: 1, d: 41 })
    expect(adapter.identity).toEqual({ id: 'bot-1', username: 'Tentacle QQ' })
  })
})

describe('QQAdapter inbound normalization and dedupe', () => {
  it('normalizes C2C as dm, prefixes ids with the instance and drops replayed ids', async () => {
    const { fake, messages } = await startAdapter()
    const connection = await fake.waitForConnection(0)
    await hello(connection)
    const event = {
      op: 0,
      s: 1,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-1',
        content: 'hello QQ',
        timestamp: 1_700_000_000,
        author: { user_openid: 'user-1', username: 'Ada' },
      },
    }
    connection.send(event)
    await until(() => messages.length === 1)
    expect(messages[0]).toEqual({
      channelId: 'ch-qq-test',
      channelType: 'qq',
      messageId: 'qq:ch-qq-test:msg-1',
      subject: { chatId: 'user-1', kind: 'dm' },
      sender: { platformId: 'user-1', displayName: 'Ada' },
      content: [{ type: 'text', text: 'hello QQ' }],
      receivedAt: 1_700_000_000_000,
      metadata: { eventType: 'C2C_MESSAGE_CREATE', messageId: 'msg-1', msgType: 'c2c' },
    })

    connection.send({ ...event, s: 2 })
    connection.send({
      ...event,
      s: 3,
      d: { ...event.d, id: 'msg-2', content: 'second' },
    })
    await until(() => messages.length === 2)
    expect(messages.map((message) => message.messageId)).toEqual([
      'qq:ch-qq-test:msg-1',
      'qq:ch-qq-test:msg-2',
    ])
  })

  it('gates ordinary group chatter, drops bot authors and normalizes group media', async () => {
    const { fake, messages } = await startAdapter()
    const connection = await fake.waitForConnection(0)
    await hello(connection)
    connection.send({
      op: 0,
      s: 1,
      t: 'GROUP_MESSAGE_CREATE',
      d: { id: 'plain-group', group_openid: 'group-1', content: 'not addressed', author: { member_openid: 'member-1' } },
    })
    connection.send({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'bot-message', content: 'beep', author: { user_openid: 'other-bot', bot: true } },
    })
    connection.send({
      op: 0,
      s: 3,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'group-msg',
        group_openid: 'group-1',
        content: '<@!qq-app> run <qqimg src="https://cdn.example/image.png">',
        mentions: [{ id: 'qq-app', is_you: true }],
        author: { member_openid: 'member-1', username: 'Ada' },
        attachments: [{ content_type: 'application/pdf', url: '//cdn.example/report.pdf', filename: 'report.pdf' }],
      },
    })
    await until(() => messages.length === 1)
    expect(messages[0]!.subject).toEqual({ chatId: 'group-1', kind: 'group' })
    expect(messages[0]!.sender).toEqual({ platformId: 'member-1', displayName: 'Ada' })
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'run' },
      { type: 'image', reference: 'https://cdn.example/image.png' },
      { type: 'file', name: 'report.pdf', reference: 'https://cdn.example/report.pdf' },
    ])
  })

  it('uses a deterministic placeholder for unsupported rich content', () => {
    expect(qqContentParts({ msg_elements: [{ type: 'sticker' }] })).toEqual([
      { type: 'text', text: '[qq: unsupported rich message]' },
    ])
    expect(qqContentParts({ message_type: 3, ark_data: { title: 'card' } })).toEqual([
      { type: 'text', text: '[qq: unsupported rich message]' },
    ])
  })
})

describe('QQAdapter reconnect lifecycle', () => {
  it('rotates on op=7 with RESUME containing the preserved session and sequence', async () => {
    const { fake } = await startAdapter()
    const first = await fake.waitForConnection(0)
    await hello(first)
    first.send({ op: 0, s: 7, t: 'READY', d: { session_id: 'resume-me' } })
    first.send({ op: 0, s: 8, t: 'SOME_OTHER_EVENT', d: {} })
    first.send({ op: 7, d: null })

    const second = await fake.waitForConnection(1)
    await hello(second)
    expect(await second.waitForFrame((frame) => frame['op'] === 6)).toEqual({
      op: 6,
      d: { token: 'QQBot qq-token-1', session_id: 'resume-me', seq: 8 },
    })
    expect(second.frames.some((frame) => frame['op'] === 2)).toBe(false)
    expect(fake.tokenCalls).toHaveLength(1)
  })

  it('forces OAuth refresh and a fresh IDENTIFY after non-resumable op=9', async () => {
    const { fake } = await startAdapter()
    const first = await fake.waitForConnection(0)
    await hello(first)
    first.send({ op: 0, s: 9, t: 'READY', d: { session_id: 'reject-me' } })
    first.send({ op: 9, d: false })

    const second = await fake.waitForConnection(1)
    await hello(second)
    await until(() => fake.tokenCalls.length === 2 && fake.gatewayCalls.length === 2)
    expect(fake.gatewayCalls[1]!.authorization).toBe('QQBot qq-token-2')
    expect(await second.waitForFrame((frame) => frame['op'] === 2)).toEqual({
      op: 2,
      d: { token: 'QQBot qq-token-2', intents: 1_107_300_354, shard: [0, 1] },
    })
    expect(second.frames.some((frame) => frame['op'] === 6)).toBe(false)
  })
})

describe('QQAdapter outbound REST messages', () => {
  it('sends exact DM/group bodies and refreshes a rejected token once before retrying', async () => {
    const { fake, adapter } = await startAdapter({ rejectFirstSendWith401: true })
    await adapter.send({ chatId: 'user-1', kind: 'dm' }, [{ type: 'text', text: 'hello' }])

    expect(fake.sendCalls).toHaveLength(2)
    expect(fake.sendCalls.map((call) => call.path)).toEqual([
      '/v2/users/user-1/messages',
      '/v2/users/user-1/messages',
    ])
    expect(fake.sendCalls.map((call) => call.body)).toEqual([
      { content: 'hello', msg_type: 0 },
      { content: 'hello', msg_type: 0 },
    ])
    expect(fake.sendCalls.map((call) => call.authorization)).toEqual(['QQBot qq-token-1', 'QQBot qq-token-2'])
    expect(fake.tokenCalls).toHaveLength(2)

    await adapter.send({ chatId: 'group-1', kind: 'group' }, [{ type: 'text', text: 'group hello' }])
    expect(fake.sendCalls[2]).toMatchObject({
      path: '/v2/groups/group-1/messages',
      body: { content: 'group hello', msg_type: 0 },
      authorization: 'QQBot qq-token-2',
    })
    expect(fake.tokenCalls).toHaveLength(2)
  })

  it('chunks long text at the declared ceiling and increments passive msg_seq', async () => {
    const { fake, adapter, messages } = await startAdapter()
    const connection = await fake.waitForConnection(0)
    await hello(connection)
    connection.send({
      op: 0,
      s: 1,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'incoming-1', content: 'reply here', author: { user_openid: 'user-1' } },
    })
    await until(() => messages.length === 1)

    await adapter.send({ chatId: 'user-1', kind: 'dm' }, [{ type: 'text', text: 'x'.repeat(QQ_MESSAGE_LIMIT + 10) }])
    expect(fake.sendCalls).toHaveLength(2)
    for (const call of fake.sendCalls) {
      expect(Array.from(String(call.body['content'])).length).toBeLessThanOrEqual(4000)
      expect(call.body['msg_type']).toBe(0)
      expect(call.body['msg_id']).toBe('incoming-1')
    }
    expect(typeof fake.sendCalls[0]!.body['msg_seq']).toBe('number')
    expect(fake.sendCalls[1]!.body['msg_seq']).toBe(Number(fake.sendCalls[0]!.body['msg_seq']) + 1)
  })
})
