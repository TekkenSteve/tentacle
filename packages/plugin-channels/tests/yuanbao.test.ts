import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CMD_AUTH_BIND,
  CMD_INBOUND_MESSAGE,
  CMD_PING,
  CMD_SEND_C2C_MESSAGE,
  CMD_SEND_GROUP_MESSAGE,
  CMD_TYPE_PUSH_ACK,
  CMD_TYPE_REQUEST,
  MODULE_CONN_ACCESS,
  MSG_TYPE_FILE,
  MSG_TYPE_IMAGE,
  MSG_TYPE_TEXT,
} from '../src/adapter/yuanbao-frames.js'
import { YuanbaoAdapter } from '../src/adapter/yuanbao.js'
import type { InboundMessage } from '../src/types.js'
import { FakeYuanbaoApi, type FakeYuanbaoFrame } from './fake-yuanbao-api.js'

const servers: FakeYuanbaoApi[] = []
const adapters: YuanbaoAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

interface Started {
  readonly server: FakeYuanbaoApi
  readonly adapter: YuanbaoAdapter
  readonly messages: InboundMessage[]
}

async function startAdapter(options: {
  readonly heartbeatIntervalMs?: number
  readonly reconnectDelaysMs?: readonly number[]
  readonly probeMode?: 'sign_token'
  readonly server?: FakeYuanbaoApi
} = {}): Promise<Started> {
  const server = options.server ?? new FakeYuanbaoApi()
  if (options.server === undefined) {
    servers.push(server)
    await server.listen()
  }
  const messages: InboundMessage[] = []
  const adapter = new YuanbaoAdapter({
    id: 'ch-yuanbao-test',
    credentials: { appKey: 'app-key-test', appSecret: 'app-secret-test' },
    apiDomain: server.baseUrl,
    wsUrl: server.wsUrl,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    reconnectDelaysMs: options.reconnectDelaysMs ?? [10],
    ...(options.probeMode === undefined ? {} : { probeMode: options.probeMode }),
  })
  adapters.push(adapter)
  adapter.onMessage(async (message) => { messages.push(message) })
  await adapter.start()
  return { server, adapter, messages }
}

function textMessage(msgId: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callback_command: 'C2C.CallbackAfterSendMsg',
    msg_id: msgId,
    from_account: 'user-1',
    to_account: 'bot-yuanbao',
    sender_nickname: 'Ada',
    msg_body: [{ msg_type: MSG_TYPE_TEXT, msg_content: { text } }],
    ...extra,
  }
}

/** Independent protobuf literals for the byte-level auth assertion below. */
function testVarint(value: number): Buffer {
  const out: number[] = []
  let rest = value
  do {
    const byte = rest % 128
    rest = Math.floor(rest / 128)
    out.push(rest ? byte | 128 : byte)
  } while (rest)
  return Buffer.from(out)
}
function testField(field: number, wire: number, value: Buffer): Buffer {
  return Buffer.concat([testVarint(field * 8 + wire), value])
}
function testBytes(value: Uint8Array): Buffer {
  return Buffer.concat([testVarint(value.length), Buffer.from(value)])
}
function testString(value: string): Buffer {
  return testBytes(Buffer.from(value, 'utf8'))
}
function testLen(field: number, value: string | Uint8Array): Buffer {
  return testField(field, 2, typeof value === 'string' ? testString(value) : testBytes(value))
}
function testVarintField(field: number, value: number): Buffer {
  return testField(field, 0, testVarint(value))
}

function expectedFirstAuthFrame(): Buffer {
  const authInfo = Buffer.concat([
    testLen(1, 'bot-yuanbao'),
    testLen(2, 'source-yuanbao'),
    testLen(3, 'token-1'),
  ])
  const deviceInfo = Buffer.concat([
    testLen(1, '1.0.0'),
    testLen(2, process.platform),
    testLen(10, '17'),
    testLen(24, '1.0.0'),
  ])
  const payload = Buffer.concat([
    testLen(1, 'ybBot'),
    testLen(2, authInfo),
    testLen(3, deviceInfo),
  ])
  // First request: request_id auth-bind_1 consumes seq=1; head seq_no=2.
  const head = Buffer.concat([
    testLen(2, CMD_AUTH_BIND),
    testVarintField(3, 2),
    testLen(4, 'auth-bind_1'),
    testLen(5, MODULE_CONN_ACCESS),
  ])
  return Buffer.concat([testLen(1, head), testLen(2, payload)])
}

describe('YuanbaoAdapter authentication and binary ConnMsg', () => {
  it('signs sign-token exactly and lays out auth-bind bytes field-for-field', async () => {
    const { server, adapter } = await startAdapter()
    const sign = server.callsTo('/api/v5/robotLogic/sign-token')[0]!
    expect(sign.method).toBe('POST')
    expect(sign.body['app_key']).toBe('app-key-test')
    expect(sign.body['nonce']).toMatch(/^[0-9a-f]{32}$/)
    expect(sign.body['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
    const independentSignature = createHmac('sha256', 'app-secret-test')
      .update(`${sign.body['nonce']}${sign.body['timestamp']}app-key-testapp-secret-test`, 'utf8')
      .digest('hex')
    expect(sign.body['signature']).toBe(independentSignature)
    expect(sign.headers['x-appversion']).toBe('1.0.0')
    expect(sign.headers['x-instance-id']).toBe('17')
    expect(sign.headers['x-bot-version']).toBe('1.0.0')
    expect(sign.headers['x-operationsystem']).toBe(process.platform)

    const auth = server.framesFor(CMD_AUTH_BIND)[0]!
    expect(auth.message.head.cmdType).toBe(CMD_TYPE_REQUEST)
    expect(auth.message.head.msgId).toBe('auth-bind_1')
    // Full byte equality is intentional: this catches accidental JSON framing,
    // double length prefixes, wrong field numbers, and omitted request type 0.
    expect(auth.bytes.equals(expectedFirstAuthFrame())).toBe(true)
    expect(auth.bytes[0]).toBe(0x0a)
    expect(auth.bytes.includes(Buffer.from('ybBot'))).toBe(true)
    expect(adapter.identity).toEqual({ id: 'bot-yuanbao' })
    expect(adapter.connected).toBe(true)
  })

  it('correlates responses by msg_id, not by arrival order', async () => {
    const { server, adapter } = await startAdapter()
    server.autoRespond = false
    let settled = false
    const sending = adapter.send({ chatId: 'user-1', kind: 'dm' }, [{ type: 'text', text: 'hello' }])
    void sending.then(() => { settled = true })
    const request = await server.waitForFrame((frame) => frame.message.head.cmd === CMD_SEND_C2C_MESSAGE)
    server.respond(request, 0, 'an-unrelated-response')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    server.respond(request, 0)
    await sending
    expect(settled).toBe(true)
    expect(request.message.head.msgId).toMatch(/^c2c_\d+$/)
  })

  it('ACKs need_ack pushes with the original cmd, module and msg_id', async () => {
    const { server, messages } = await startAdapter()
    server.push(textMessage('m-ack', 'hello'), { msgId: 'push-ack-1', needAck: true })
    const ack = await server.waitForFrame((frame) => frame.message.head.cmdType === CMD_TYPE_PUSH_ACK)
    expect(ack.message.head.cmd).toBe(CMD_INBOUND_MESSAGE)
    expect(ack.message.head.msgId).toBe('push-ack-1')
    expect(ack.message.head.module).toBe('yuanbao_openclaw_proxy')
    expect(ack.message.data).toHaveLength(0)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.messageId).toBe('yuanbao:ch-yuanbao-test:m-ack')
  })
})

describe('YuanbaoAdapter inbound normalization', () => {
  it('normalizes dm/group/media and applies the shared mention gate', async () => {
    const { server, messages } = await startAdapter()
    server.push(textMessage('dm-1', '你好'))
    server.push(textMessage('group-ignored', 'not for us', {
      callback_command: 'Group.CallbackAfterSendMsg',
      group_code: 'group-1',
      bot_mentioned: false,
    }))
    server.push(textMessage('group-ok', '@bot run', {
      callback_command: 'Group.CallbackAfterSendMsg',
      group_code: 'group-1',
      group_name: 'Ops',
      bot_mentioned: true,
    }))
    server.push(textMessage('bot-own', 'echo', { from_account: 'bot-yuanbao' }))
    server.push({
      msg_id: 'media-1',
      from_account: 'user-2',
      msg_body: [
        { msg_type: MSG_TYPE_IMAGE, msg_content: { image_info_array: [{ url: '/image/a.png', width: 10 }] } },
        { msg_type: MSG_TYPE_FILE, msg_content: { url: 'cdn.example/file.pdf', file_name: 'a.pdf' } },
      ],
    })
    await vi.waitFor(() => expect(messages).toHaveLength(3))
    expect(messages[0]!.subject).toEqual({ chatId: 'user-1', kind: 'dm' })
    expect(messages[0]!.sender).toMatchObject({ platformId: 'user-1', displayName: 'Ada' })
    expect(messages[1]!.subject).toEqual({ chatId: 'group-1', kind: 'group' })
    expect(messages[1]!.groupContext).toBe('Ops')
    expect(messages[2]!.content).toEqual([
      { type: 'image', reference: 'http://127.0.0.1:' + new URL(server.baseUrl).port + '/image/a.png' },
      { type: 'file', name: 'a.pdf', reference: 'https://cdn.example/file.pdf' },
    ])
  })

  it('deduplicates a redelivered platform msg_id', async () => {
    const { server, messages } = await startAdapter()
    server.push(textMessage('same-id', 'once'))
    server.push(textMessage('same-id', 'once'))
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(messages).toHaveLength(1)
  })
})

describe('YuanbaoAdapter lifecycle', () => {
  it('sends ping and reconnects with auth-bind after an unexpected close', async () => {
    const { server, adapter } = await startAdapter({ heartbeatIntervalMs: 25, reconnectDelaysMs: [10] })
    await server.waitForFrame((frame) => frame.message.head.cmd === CMD_PING)
    const initialConnections = server.connectionCount
    server.closeLatest()
    await vi.waitFor(() => {
      expect(server.connectionCount).toBeGreaterThan(initialConnections)
      expect(server.framesFor(CMD_AUTH_BIND).length).toBeGreaterThanOrEqual(2)
    })
    expect(adapter.connected).toBe(true)
  })

  it('probe mode verifies sign-token without opening a second WS', async () => {
    const first = await startAdapter()
    expect(first.server.connectionCount).toBe(1)
    const probe = new YuanbaoAdapter({
      id: 'ch-yuanbao-probe',
      credentials: { appKey: 'app-key-test', appSecret: 'app-secret-test' },
      apiDomain: first.server.baseUrl,
      wsUrl: first.server.wsUrl,
      probeMode: 'sign_token',
    })
    adapters.push(probe)
    await probe.start()
    expect(first.server.connectionCount).toBe(1)
    expect(first.server.callsTo('/api/v5/robotLogic/sign-token')).toHaveLength(2)
    expect(probe.connected).toBe(false)
    await probe.stop()
    expect(first.adapter.connected).toBe(true)
  })

  it('marks rejected credentials as failure without exposing the secret', async () => {
    const server = new FakeYuanbaoApi({ signTokenError: { code: 401, status: 401 } })
    servers.push(server)
    await server.listen()
    const adapter = new YuanbaoAdapter({
      id: 'ch-yuanbao-bad',
      credentials: { appKey: 'app-key-test', appSecret: 'do-not-log-this' },
      apiDomain: server.baseUrl,
      wsUrl: server.wsUrl,
    })
    adapters.push(adapter)
    await expect(adapter.start()).rejects.toThrow(/sign-token/)
    expect(adapter.failure).toBeDefined()
    expect(adapter.failure!.message).not.toContain('do-not-log-this')
    expect(server.connectionCount).toBe(0)
  })
})

describe('YuanbaoAdapter outbound routing', () => {
  it('uses send_c2c_message for DMs and send_group_message for groups', async () => {
    const { server, adapter } = await startAdapter()
    await adapter.send({ chatId: 'user-9', kind: 'dm' }, [{ type: 'text', text: 'dm' }])
    await adapter.send({ chatId: 'group-9', kind: 'group' }, [{ type: 'text', text: 'group' }])
    expect(server.framesFor(CMD_SEND_C2C_MESSAGE)).toHaveLength(1)
    expect(server.framesFor(CMD_SEND_GROUP_MESSAGE)).toHaveLength(1)
    const dm = server.framesFor(CMD_SEND_C2C_MESSAGE)[0]!
    const group = server.framesFor(CMD_SEND_GROUP_MESSAGE)[0]!
    expect(dm.message.head.module).toBe('yuanbao_openclaw_proxy')
    expect(group.message.head.module).toBe('yuanbao_openclaw_proxy')
  })
})
