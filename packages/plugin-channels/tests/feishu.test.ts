/**
 * Feishu adapter tests (design 06 §6, 07 §1).
 *
 * Two halves, matching the adapter's two edges:
 *
 * - the callback edge is driven IN-PROCESS through the captured
 *   `registerHook` handler (the service's gateway plumbing is covered by its
 *   own seam, so no HTTP stack is needed here): challenge echo, token and
 *   signature verification, decryption, dedupe, the mention gate;
 * - the platform edge runs against a local fake open-platform server
 *   (`fake-feishu-api.ts`): tenant-token caching, send/reply envelope shape,
 *   chunking, identity, token-failure reporting.
 */
import { createCipheriv, createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeFeishuApi, messageEvent } from './fake-feishu-api.js'
import {
  FEISHU_MESSAGE_LIMIT,
  FeishuAdapter,
  cleanMentionPlaceholders,
  feishuContentParts,
} from '../src/adapter/feishu.js'
import type { ChannelHookHandler, ChannelHookReply, ChannelHookRequest } from '../src/service.js'
import type { InboundMessage } from '../src/types.js'

const servers: FakeFeishuApi[] = []
const adapters: FeishuAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

/** Build a hook request; `body` objects are serialized, strings used raw. */
function hookRequest(body: unknown, headers: Record<string, string> = {}): ChannelHookRequest {
  return {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    header: (name) => headers[name.toLowerCase()],
  }
}

/**
 * Wrap a payload the way the platform does in encrypted mode: AES-256-CBC
 * with key = sha256(encryptKey), IV = key[:16], then sign the OUTER body as
 * base64(sha256(timestamp + nonce + body + encryptKey)).
 */
function encryptHookBody(payload: unknown, encryptKey: string, options: { signature?: string } = {}): ChannelHookRequest {
  const key = createHash('sha256').update(encryptKey).digest()
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  const encrypt = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64')
  const body = JSON.stringify({ encrypt })
  const timestamp = '1700000000'
  const nonce = 'nonce-1'
  const signature = options.signature ?? createHash('sha256').update(timestamp + nonce + body + encryptKey).digest('base64')
  return hookRequest(body, {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  })
}

interface Started {
  readonly adapter: FeishuAdapter
  readonly messages: InboundMessage[]
  /** Drive one platform callback through the registered hook handler. */
  readonly hook: (request: ChannelHookRequest) => Promise<ChannelHookReply>
  readonly hookDisposed: () => boolean
}

async function startAdapter(server: FakeFeishuApi, options: {
  readonly id?: string
  readonly credentials?: { encryptKey?: string; verificationToken?: string }
} = {}): Promise<Started> {
  const messages: InboundMessage[] = []
  let captured: ChannelHookHandler | undefined
  let disposed = false
  const adapter = new FeishuAdapter({
    id: options.id ?? 'ch-feishu',
    apiBaseUrl: server.baseUrl,
    credentials: { appId: 'cli_fake', appSecret: 'app-secret', ...options.credentials },
    registerHook: (handler) => {
      captured = handler
      return () => { disposed = true }
    },
  })
  adapter.onMessage(async (message) => { messages.push(message) })
  adapters.push(adapter)
  await adapter.start()
  return {
    adapter,
    messages,
    hook: (request) => {
      if (captured === undefined) throw new Error('the adapter did not register a hook')
      return captured(request)
    },
    hookDisposed: () => disposed,
  }
}

async function fakeServer(options: ConstructorParameters<typeof FakeFeishuApi>[0] = {}): Promise<FakeFeishuApi> {
  const server = new FakeFeishuApi(options)
  servers.push(server)
  await server.listen()
  return server
}

describe('FeishuAdapter callback verification', () => {
  it('answers a url_verification challenge verbatim', async () => {
    const server = await fakeServer()
    const { hook } = await startAdapter(server)
    const reply = await hook(hookRequest({ type: 'url_verification', challenge: 'ch-abc', token: 'whatever' }))
    expect(reply).toEqual({ status: 200, json: { challenge: 'ch-abc' } })
  })

  it('rejects events whose token mismatches the configured verificationToken', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server, { credentials: { verificationToken: 'vt-good' } })

    const rejected = await hook(hookRequest(messageEvent({ eventId: 'evt-bad', token: 'vt-bad' })))
    expect(rejected.status).toBe(403)
    expect(messages).toHaveLength(0)

    const accepted = await hook(hookRequest(messageEvent({ eventId: 'evt-good', token: 'vt-good', content: { text: 'hi' } })))
    expect(accepted.status).toBe(200)
    expect(messages).toHaveLength(1)
  })

  it('rejects a challenge whose token mismatches, even though it asks for an echo', async () => {
    const server = await fakeServer()
    const { hook } = await startAdapter(server, { credentials: { verificationToken: 'vt-good' } })
    const reply = await hook(hookRequest({ type: 'url_verification', challenge: 'ch-abc', token: 'vt-bad' }))
    expect(reply.status).toBe(403)
  })

  it('round-trips an encrypted event: signature verified, body decrypted, message routed', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server, {
      credentials: { encryptKey: 'ek-test', verificationToken: 'vt-good' },
    })
    const event = messageEvent({ eventId: 'evt-enc', token: 'vt-good', content: { text: 'secret hello' } })
    const reply = await hook(encryptHookBody(event, 'ek-test'))
    expect(reply.status).toBe(200)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'secret hello' }])
  })

  it('refuses a bad signature and an undecryptable body without crashing', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server, { credentials: { encryptKey: 'ek-test' } })
    const event = messageEvent({ eventId: 'evt-forged', content: { text: 'forged' } })

    const forged = await hook(encryptHookBody(event, 'ek-test', { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }))
    expect(forged.status).toBe(403)

    // A VALID signature over a body whose encrypt payload is garbage: the
    // decryption failure is a drop, never a crash.
    const garbage = 'not-base64!!!'
    const body = JSON.stringify({ encrypt: garbage })
    const timestamp = '1700000000'
    const nonce = 'nonce-2'
    const signature = createHash('sha256').update(timestamp + nonce + body + 'ek-test').digest('base64')
    const broken = await hook(hookRequest(body, {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    }))
    expect(broken.status).toBe(403)
    expect(messages).toHaveLength(0)
  })

  it('answers only POST', async () => {
    const server = await fakeServer()
    const { hook } = await startAdapter(server)
    const reply = await hook({ method: 'GET', body: '', header: () => undefined })
    expect(reply.status).toBe(405)
  })
})

describe('FeishuAdapter inbound parsing', () => {
  it('normalizes a p2p text event and cleans mention placeholders', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server)
    await hook(hookRequest(messageEvent({
      eventId: 'evt-1',
      content: { text: '@_user_1 你好 @_user_2' },
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_ada' }, name: 'Ada' }],
    })))
    expect(messages).toHaveLength(1)
    const message = messages[0]!
    expect(message.channelId).toBe('ch-feishu')
    expect(message.channelType).toBe('feishu')
    expect(message.messageId).toBe('feishu:oc_chat:om_msg')
    expect(message.subject).toEqual({ chatId: 'oc_chat', kind: 'dm' })
    expect(message.sender).toMatchObject({ platformId: 'ou_user', displayName: 'ou_user' })
    // Known mentions resolve to their name; unknown placeholders vanish.
    expect(message.content).toEqual([{ type: 'text', text: '@Ada 你好' }])
    expect(message.receivedAt).toBe(1_700_000_000_000)
    expect(message.metadata).toMatchObject({ eventId: 'evt-1', messageId: 'om_msg' })
  })

  it('routes group messages only when the bot is mentioned', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server)
    // Plain chatter: no mention of the bot (ou_bot) — dropped.
    await hook(hookRequest(messageEvent({
      eventId: 'evt-g1',
      chatType: 'group',
      content: { text: '@_user_1 morning all' },
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone_else' }, name: 'Bo' }],
    })))
    expect(messages).toHaveLength(0)
    // @'ing the bot routes the message with kind 'group'.
    await hook(hookRequest(messageEvent({
      eventId: 'evt-g2',
      chatType: 'group',
      content: { text: '@_user_1 run the tests' },
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'tentacle-test-bot' }],
    })))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.subject).toEqual({ chatId: 'oc_chat', kind: 'group' })
    expect(messages[0]!.content).toEqual([{ type: 'text', text: '@tentacle-test-bot run the tests' }])
  })

  it('drops messages written by another bot', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server)
    await hook(hookRequest(messageEvent({ eventId: 'evt-bot', senderType: 'app', content: { text: 'beep' } })))
    expect(messages).toHaveLength(0)
  })

  it('turns image/file messages into reference-shaped parts', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server)
    await hook(hookRequest(messageEvent({ eventId: 'evt-img', messageType: 'image', content: { image_key: 'img_v2_x' } })))
    await hook(hookRequest(messageEvent({ eventId: 'evt-file', messageType: 'file', content: { file_key: 'file_v2_y', file_name: 'report.pdf' } })))
    expect(messages).toHaveLength(2)
    expect(messages[0]!.content).toEqual([{ type: 'image', reference: 'feishu:om_msg:img_v2_x' }])
    expect(messages[1]!.content).toEqual([{ type: 'file', name: 'report.pdf', reference: 'feishu:om_msg:file_v2_y' }])
    expect(feishuContentParts({ message_type: 'sticker', content: '{}' })).toEqual([
      { type: 'text', text: '[feishu: unsupported message type "sticker"]' },
    ])
  })

  it('dedupes platform retries by event_id', async () => {
    const server = await fakeServer()
    const { hook, messages } = await startAdapter(server)
    const event = messageEvent({ eventId: 'evt-dupe', content: { text: 'once' } })
    const first = await hook(hookRequest(event))
    const second = await hook(hookRequest(event))
    expect(first.status).toBe(200)
    // A retry gets a cheap 200 — feishu stops retrying — but no re-dispatch.
    expect(second.status).toBe(200)
    expect(messages).toHaveLength(1)
  })
})

describe('FeishuAdapter lifecycle', () => {
  it('fills identity from bot/v3/info at start', async () => {
    const server = await fakeServer({ bot: { open_id: 'ou_bot_2', app_name: 'ops-bot' } })
    const { adapter } = await startAdapter(server)
    expect(adapter.identity).toEqual({ id: 'ou_bot_2', username: 'ops-bot' })
    expect(server.callsTo('botInfo')).toHaveLength(1)
    expect(server.callsTo('botInfo')[0]!.authorization).toBe('Bearer t-fake-1')
  })

  it('refuses to start without a gateway hook route', async () => {
    const server = await fakeServer()
    const adapter = new FeishuAdapter({
      id: 'ch-feishu',
      apiBaseUrl: server.baseUrl,
      credentials: { appId: 'cli_fake', appSecret: 'app-secret' },
    })
    adapters.push(adapter)
    await expect(adapter.start()).rejects.toThrow(/gateway is required for feishu \(callback route\)/)
  })

  it('unregisters the hook route on stop', async () => {
    const server = await fakeServer()
    const { adapter, hookDisposed } = await startAdapter(server)
    expect(hookDisposed()).toBe(false)
    await adapter.stop()
    expect(hookDisposed()).toBe(true)
  })

  it('records a failure when the tenant token cannot be fetched', async () => {
    const server = await fakeServer({ tokenError: { code: 10003, msg: 'invalid app_secret' } })
    const adapter = new FeishuAdapter({
      id: 'ch-feishu',
      apiBaseUrl: server.baseUrl,
      credentials: { appId: 'cli_fake', appSecret: 'wrong' },
      registerHook: () => () => undefined,
    })
    adapters.push(adapter)
    await expect(adapter.start()).rejects.toThrow(/tenant token failed/)
    expect(adapter.failure).toBeDefined()
    expect(adapter.failure!.message).toMatch(/tenant token failed/)
    // The error must never carry the secret itself.
    expect(adapter.failure!.message).not.toContain('wrong')
  })
})

describe('FeishuAdapter outbound', () => {
  it('fetches the tenant token once and reuses it until its expiry margin', async () => {
    const server = await fakeServer({ expireSeconds: 3600 })
    const { adapter } = await startAdapter(server)
    expect(server.callsTo('token')).toHaveLength(1) // getBotInfo at start
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: 'one' }])
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: 'two' }])
    expect(server.callsTo('token')).toHaveLength(1)
    const sent = server.callsTo('send')
    expect(sent).toHaveLength(2)
    expect(sent[0]!.path).toBe('/open-apis/im/v1/messages?receive_id_type=chat_id')
    expect(sent[0]!.body).toEqual({ receive_id: 'oc_chat', msg_type: 'text', content: JSON.stringify({ text: 'one' }) })
    expect(sent[0]!.authorization).toBe('Bearer t-fake-1')
  })

  it('refetches the token once the cached one is inside its refresh margin', async () => {
    // expire 30s < the 60s refresh margin: every call sees a stale cache.
    const server = await fakeServer({ expireSeconds: 30 })
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: 'one' }])
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: 'two' }])
    expect(server.callsTo('token')).toHaveLength(3) // start + one per send
    expect(server.callsTo('send')[1]!.authorization).toBe('Bearer t-fake-3')
  })

  it('splits a long reply at the platform limit', async () => {
    const server = await fakeServer()
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: 'a'.repeat(5000) }])
    const sent = server.callsTo('send')
    expect(sent).toHaveLength(2)
    for (const call of sent) {
      const text = JSON.parse(String(call.body.content)) as { text: string }
      expect(Array.from(text.text).length).toBeLessThanOrEqual(FEISHU_MESSAGE_LIMIT)
    }
  })

  it('replies through the reply API when the conversation has a thread', async () => {
    const server = await fakeServer()
    const { adapter, hook } = await startAdapter(server)
    // A threaded group message teaches the adapter a message id in the thread.
    await hook(hookRequest(messageEvent({
      eventId: 'evt-thread',
      chatType: 'group',
      messageId: 'om_thread_root',
      threadId: 'omt_1',
      content: { text: '@_user_1 thread me' },
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'tentacle-test-bot' }],
    })))
    await adapter.send({ chatId: 'oc_chat', kind: 'group', threadId: 'omt_1' }, [{ type: 'text', text: 'in-thread' }])
    const replies = server.callsTo('reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.path).toBe('/open-apis/im/v1/messages/om_thread_root/reply')
    expect(replies[0]!.body).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'in-thread' }) })
    // Without a thread (or with an unknown one) the plain send is used.
    await adapter.send({ chatId: 'oc_chat', kind: 'group', threadId: 'omt_unknown' }, [{ type: 'text', text: 'plain' }])
    expect(server.callsTo('reply')).toHaveLength(1)
    expect(server.callsTo('send')).toHaveLength(1)
  })

  it('never sends an empty body', async () => {
    const server = await fakeServer()
    const { adapter } = await startAdapter(server)
    await adapter.send({ chatId: 'oc_chat', kind: 'dm' }, [{ type: 'text', text: '   ' }])
    expect(server.callsTo('send')).toHaveLength(0)
  })
})

describe('cleanMentionPlaceholders', () => {
  it('substitutes known mentions and strips unknown ones', () => {
    const mentions = [{ key: '@_user_1', id: { open_id: 'ou_a' }, name: 'Ada' }]
    expect(cleanMentionPlaceholders('@_user_1 hi @_user_2', mentions)).toBe('@Ada hi')
    expect(cleanMentionPlaceholders('no mentions', mentions)).toBe('no mentions')
  })
})
