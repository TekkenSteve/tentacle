/**
 * Discord adapter protocol tests against the loopback fake (real HTTP + WS):
 * the adapter is driven by real gateway frames and its REST/WS output is
 * asserted independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscordAdapter } from '../src/adapter/discord.js'
import { FakeDiscordApi, helloFrame, messageCreateFrame, readyFrame } from './fake-discord-api.js'
import type { InboundMessage } from '../src/types.js'

let fake: FakeDiscordApi
let adapter: DiscordAdapter | undefined
let connectionCount = 0
const received: InboundMessage[] = []

beforeEach(async () => {
  fake = new FakeDiscordApi()
  await fake.listen()
  received.length = 0
  connectionCount = 0
})

afterEach(async () => {
  await adapter?.stop().catch(() => undefined)
  adapter = undefined
  await fake.close()
})

function makeAdapter(overrides: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}): DiscordAdapter {
  return new DiscordAdapter({
    id: 'ch-discord',
    credentials: { token: 'bot-token-1' },
    apiBaseUrl: fake.baseUrl,
    reconnectDelayMs: 20,
    ...overrides,
  })
}

async function start(overrides: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}): Promise<DiscordAdapter> {
  adapter = makeAdapter(overrides)
  adapter.onMessage(async (message) => { received.push(message) })
  await adapter.start()
  // start() opens the socket asynchronously; frames may only be scripted once
  // the loopback connection actually exists. The counter distinguishes a fresh
  // connection from sockets left by earlier adapters.
  connectionCount += 1
  await vi.waitFor(() => expect(fake.socketCount()).toBeGreaterThanOrEqual(connectionCount))
  return adapter
}

function helloAndReady(interval = 40, index?: number): void {
  fake.sendFrame(helloFrame(interval), index)
  fake.sendFrame(readyFrame(), index)
}

describe('DiscordAdapter', () => {
  it('handshakes with the bot token, identifies on HELLO, and heartbeats with the last sequence', async () => {
    await start()
    helloAndReady()
    await vi.waitFor(() => expect(fake.socketCount()).toBe(1))
    await vi.waitFor(() => {
      const frames = fake.socketFrames()
      expect(frames.some((frame) => frame['op'] === 2)).toBe(true)
    })

    expect(fake.callsTo('gateway')[0]?.authorization).toBe('Bot bot-token-1')
    const identify = fake.socketFrames().find((frame) => frame['op'] === 2)!
    expect(identify['d']).toMatchObject({
      token: 'bot-token-1',
      intents: 1 | (1 << 9) | (1 << 12) | (1 << 15),
    })
    await vi.waitFor(() => {
      const heartbeats = fake.socketFrames().filter((frame) => frame['op'] === 1)
      expect(heartbeats.length).toBeGreaterThan(0)
    })
    expect(adapter?.identity).toEqual({ id: 'bot-9001', username: 'tentacle-bot' })
  })

  it('normalizes a DM message, refuses bots and unmentioned guild messages', async () => {
    await start()
    helloAndReady()
    fake.sendFrame(messageCreateFrame())
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({
      channelId: 'ch-discord',
      channelType: 'discord',
      messageId: 'ch-discord:msg-1',
      subject: { chatId: 'chan-dm', kind: 'dm' },
      sender: { platformId: 'user-7', displayName: 'ada' },
      content: [{ type: 'text', text: 'hello' }],
    })

    fake.sendFrame(messageCreateFrame({ id: 'msg-2', author: { id: 'user-8', username: 'other-bot', bot: true } }))
    fake.sendFrame(messageCreateFrame({ id: 'msg-3', channel_id: 'chan-guild', guild_id: 'guild-1' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toHaveLength(1)
  })

  it('routes guild messages only when the bot is mentioned (or @everyone), with attachments as references', async () => {
    await start()
    helloAndReady()
    fake.sendFrame(messageCreateFrame({
      id: 'msg-4',
      channel_id: 'chan-guild',
      guild_id: 'guild-1',
      content: 'ping',
      mentions: [{ id: 'bot-9001' }],
      attachments: [
        { id: 'a1', filename: 'photo.png', url: 'https://cdn.example/photo.png', content_type: 'image/png' },
        { id: 'a2', filename: 'spec.pdf', url: 'https://cdn.example/spec.pdf', content_type: 'application/pdf' },
      ],
    }))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]?.subject).toEqual({ chatId: 'chan-guild', kind: 'group' })
    expect(received[0]?.content).toEqual([
      { type: 'text', text: 'ping' },
      { type: 'image', reference: 'https://cdn.example/photo.png' },
      { type: 'file', name: 'spec.pdf', reference: 'https://cdn.example/spec.pdf' },
    ])

    fake.sendFrame(messageCreateFrame({ id: 'msg-5', channel_id: 'chan-guild', guild_id: 'guild-1', content: 'all', mention_everyone: true }))
    await vi.waitFor(() => expect(received).toHaveLength(2))
  })

  it('deduplicates re-delivered message ids', async () => {
    await start()
    helloAndReady()
    fake.sendFrame(messageCreateFrame())
    fake.sendFrame(messageCreateFrame())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toHaveLength(1)
  })

  it('sends split messages with the bot token', async () => {
    await start()
    await adapter!.send({ chatId: 'chan-dm', kind: 'dm' }, [{ type: 'text', text: 'x'.repeat(4500) }])
    const sends = fake.callsTo('send')
    expect(sends).toHaveLength(3)
    expect(sends.map((call) => call.body['content'])).toEqual(['x'.repeat(2000), 'x'.repeat(2000), 'x'.repeat(500)])
    expect(sends[0]?.authorization).toBe('Bot bot-token-1')
    expect(sends[0]?.path).toBe('/channels/chan-dm/messages')
  })

  it('resumes after a server-requested reconnect instead of re-identifying fresh', async () => {
    await start()
    helloAndReady()
    await vi.waitFor(() => expect(fake.socketFrames().some((frame) => frame['op'] === 2)).toBe(true))
    fake.sendFrame({ op: 7, d: null })
    await vi.waitFor(() => expect(fake.socketCount()).toBe(2))
    // Every fresh connection opens with HELLO, which is what triggers RESUME.
    fake.sendFrame(helloFrame(40), 1)
    await vi.waitFor(() => expect(fake.socketFrames(1).some((frame) => frame['op'] === 6)).toBe(true))
    const resume = fake.socketFrames(1).find((frame) => frame['op'] === 6)!
    expect(resume['d']).toMatchObject({ token: 'bot-token-1', session_id: 'session-e2e' })
  })

  it('treats 4004 as invalid token (fatal) and 4014 as intents required (fatal)', async () => {
    await start()
    fake.closeSocket(4004)
    await vi.waitFor(() => expect(adapter?.failure?.message).toBe('discord_invalid_token'))
    expect(fake.socketCount()).toBe(1)

    await adapter?.stop()
    await start()
    fake.closeSocket(4014)
    await vi.waitFor(() => expect(adapter?.failure?.message).toBe('discord_intents_required'))
  })

  it('reconnects with backoff after a plain close', async () => {
    await start()
    await vi.waitFor(() => expect(fake.socketCount()).toBe(1))
    fake.closeSocket(1001)
    await vi.waitFor(() => expect(fake.socketCount()).toBe(2))
    // The fresh connection re-identifies on its own HELLO (no READY to resume from).
    fake.sendFrame(helloFrame(40), 1)
    await vi.waitFor(() => expect(fake.socketFrames(1).some((frame) => frame['op'] === 2)).toBe(true))
  })

  it('stops cleanly without further heartbeats', async () => {
    await start()
    helloAndReady()
    await adapter?.stop()
    const before = fake.socketFrames().length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fake.socketFrames().length).toBe(before)
  })
})
