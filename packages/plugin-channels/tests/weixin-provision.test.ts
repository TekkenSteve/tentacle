import { afterEach, describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import type { ProvisionPoll, ProvisionSession } from '../src/provision.js'
import { WeixinProvisionFlow } from '../src/provision/weixin.js'
import { FakeWeixinApi } from './fake-weixin-api.js'

const servers: FakeWeixinApi[] = []
const live: { flow: WeixinProvisionFlow; session: ProvisionSession }[] = []

afterEach(async () => {
  for (const entry of live.splice(0)) await entry.flow.stop(entry.session).catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
})

async function fakeServer(options: ConstructorParameters<typeof FakeWeixinApi>[0] = {}): Promise<FakeWeixinApi> {
  const server = new FakeWeixinApi(options)
  servers.push(server)
  await server.listen()
  return server
}

function session(): ProvisionSession {
  return {
    flowId: 'prov-weixin-test',
    channelType: 'weixin' as ProvisionSession['channelType'],
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: 1_700_000_000_000,
    expiresAt: 0,
    data: undefined,
  }
}

async function startedFlow(server: FakeWeixinApi, options: {
  pollTimeoutMs?: number
  now?: () => number
} = {}): Promise<{ flow: WeixinProvisionFlow; session: ProvisionSession }> {
  const flow = new WeixinProvisionFlow({
    baseUrl: server.baseUrl,
    pollTimeoutMs: options.pollTimeoutMs ?? 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const s = session()
  live.push({ flow, session: s })
  await flow.start(s)
  return { flow, session: s }
}

/** Wait until flow.poll() reports something the predicate accepts. */
async function untilPoll(
  flow: WeixinProvisionFlow,
  s: ProvisionSession,
  accept: (poll: ProvisionPoll) => boolean,
  what: string,
): Promise<ProvisionPoll> {
  const deadline = Date.now() + 4_000
  for (;;) {
    const poll = await flow.poll(s)
    if (accept(poll)) return poll
    if (Date.now() > deadline) throw new Error(`timed out waiting for poll: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('WeixinProvisionFlow QR generation', () => {
  it('uses bot_type=3 and client-version 1, returning only the renderable image URL', async () => {
    const server = await fakeServer({
      qrcode: 'host-only-poll-token',
      qrcodeImageUrl: 'https://ilinkai.weixin.qq.com/qr/direct-image?id=42',
    })
    const flow = new WeixinProvisionFlow({ baseUrl: server.baseUrl, now: () => 10_000 })
    const s = session()
    live.push({ flow, session: s })
    const started = await flow.start(s)

    expect(started).toEqual({
      qrUrl: 'https://ilinkai.weixin.qq.com/qr/direct-image?id=42',
      pollAfterMs: 2_000,
      expiresAt: 10_000 + 8 * 60_000,
    })
    const generate = server.callsTo('/ilink/bot/get_bot_qrcode')[0]!
    expect(generate.method).toBe('GET')
    expect(generate.url.searchParams.get('bot_type')).toBe('3')
    expect(generate.url.searchParams.get('qrcode')).toBeNull()
    expect(generate.headers['ilink-app-clientversion']).toBe('1')
    expect(generate.headers.authorization).toBeUndefined()
    // The opaque qrcode polling token is host state, not a ProvisionStart field.
    expect(started).not.toHaveProperty('qrcode')
  })
})

describe('WeixinProvisionFlow status state machine', () => {
  it('follows wait and scaned to waiting, then splits confirmed credentials from config', async () => {
    // A long idle hold pins the follower to exactly one request per pushed
    // status, mirroring the platform's hold-until-transition long poll.
    const server = await fakeServer({ qrcode: 'host-only-poll-token', idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)

    server.pushQrStatus({ status: 'wait' })
    expect(await untilPoll(flow, s, (p) => p.state === 'waiting' && p.qrUrl !== undefined, 'wait')).toEqual({
      state: 'waiting',
      qrUrl: 'https://ilinkai.weixin.qq.com/qr/renderable.png',
    })
    server.pushQrStatus({ status: 'scaned' })
    expect(await untilPoll(flow, s, (p) => p.message !== undefined, 'scaned')).toEqual({
      state: 'waiting',
      qrUrl: 'https://ilinkai.weixin.qq.com/qr/renderable.png',
      message: 'QR code scanned; confirm login in WeChat.',
    })
    server.pushQrStatus({
      status: 'confirmed',
      bot_token: 'new-bot-token',
      ilink_bot_id: 'bot@personal.ilink',
      baseurl: 'https://messages.weixin.example',
      ilink_user_id: 'user-not-a-credential',
    })
    expect(await untilPoll(flow, s, (p) => p.state === 'success', 'confirmed')).toEqual({
      state: 'success',
      credentials: { accountId: 'bot-personal-ilink', token: 'new-bot-token' },
      config: { baseUrl: 'https://messages.weixin.example' },
    })

    const statusCalls = server.callsTo('/ilink/bot/get_qrcode_status')
    expect(statusCalls).toHaveLength(3)
    for (const call of statusCalls) {
      expect(call.method).toBe('GET')
      expect(call.url.searchParams.get('qrcode')).toBe('host-only-poll-token')
      expect(call.headers['ilink-app-clientversion']).toBe('1')
    }
    // The terminal state replays idempotently; nothing was aborted on the way.
    expect(await flow.poll(s)).toMatchObject({ state: 'success' })
    expect(server.abortedRequests).toBe(0)
  })

  it('maps platform expiry to the terminal expired state', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    server.pushQrStatus({ status: 'expired' })
    expect(await untilPoll(flow, s, (p) => p.state === 'expired', 'expired')).toEqual({ state: 'expired' })
  })

  it('maps an exhausted overall login window to expired', async () => {
    // Small idle hold: the follower cycles on wait responses, so the wall
    // clock is the only thing that can end it.
    const server = await fakeServer({ idleHoldMs: 20 })
    let now = 1_700_000_000_000
    const { flow, session: s } = await startedFlow(server, { now: () => now })
    await server.waitForCall('/ilink/bot/get_qrcode_status')
    now += 8 * 60_000 + 1
    expect(await untilPoll(flow, s, (p) => p.state === 'expired', 'login window exhausted')).toEqual({ state: 'expired' })
  })

  it('reports an uninitialized session as failed without touching the network', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    await flow.stop(s)
    expect(await flow.poll(s)).toEqual({ state: 'failed', error: 'weixin provisioning session is not initialized' })
    const statusCalls = server.callsTo('/ilink/bot/get_qrcode_status').length
    expect(await flow.poll(s)).toMatchObject({ state: 'failed' })
    expect(server.callsTo('/ilink/bot/get_qrcode_status')).toHaveLength(statusCalls)
  })
})

describe('WeixinProvisionFlow console-poll decoupling', () => {
  // The regression behind the field bug: get_qrcode_status delivers its
  // one-shot transitions through a held 35s long poll. Console polls must be
  // instant projections of the follower's latest outcome — they may neither
  // hang behind the hold nor abort the platform request and lose the event.
  it('answers instantly while a long poll is held, without aborting it, and still catches the confirmation', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    await server.waitForCall('/ilink/bot/get_qrcode_status')

    const started = Date.now()
    for (let i = 0; i < 3; i += 1) {
      expect(await flow.poll(s)).toEqual({
        state: 'waiting',
        qrUrl: 'https://ilinkai.weixin.qq.com/qr/renderable.png',
      })
    }
    expect(Date.now() - started).toBeLessThan(250)
    // Only the follower's single held request exists; console polls added none.
    expect(server.callsTo('/ilink/bot/get_qrcode_status')).toHaveLength(1)

    server.pushQrStatus({
      status: 'confirmed',
      bot_token: 'confirmed-under-hold',
      ilink_bot_id: 'bot@held.ilink',
      baseurl: 'https://messages.weixin.example',
    })
    expect(await untilPoll(flow, s, (p) => p.state === 'success', 'confirmed under hold')).toEqual({
      state: 'success',
      credentials: { accountId: 'bot-held-ilink', token: 'confirmed-under-hold' },
      config: { baseUrl: 'https://messages.weixin.example' },
    })
    // One request carried the entire flow; the terminal ended the follower.
    expect(server.callsTo('/ilink/bot/get_qrcode_status')).toHaveLength(1)
    expect(server.abortedRequests).toBe(0)
  })

  it('keeps waiting when the follower self-times an unanswered long poll', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server, { pollTimeoutMs: 20 })
    await server.waitForCall('/ilink/bot/get_qrcode_status')
    const started = Date.now()
    expect(await flow.poll(s)).toEqual({
      state: 'waiting',
      qrUrl: 'https://ilinkai.weixin.qq.com/qr/renderable.png',
    })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('aborts the in-flight status request and drops host-only state on stop', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    await server.waitForCall('/ilink/bot/get_qrcode_status')
    await flow.stop(s)
    expect(s.data).toBeUndefined()
    const deadline = Date.now() + 2_000
    while (server.abortedRequests < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(server.abortedRequests).toBeGreaterThanOrEqual(1)
  })
})

describe('WeixinProvisionFlow newer protocol states', () => {
  it('reports a verification-code challenge as an actionable failure', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    server.pushQrStatus({ status: 'need_verifycode' })
    const poll = await untilPoll(flow, s, (p) => p.state === 'failed', 'need_verifycode')
    expect((poll as { error: string }).error).toMatch(/verification code/)
  })

  it('follows scaned_but_redirect to the platform IDC host', async () => {
    const primary = await fakeServer({ idleHoldMs: 60_000 })
    const idc = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(primary)
    // The official wire value is a bare host; loopback fakes pass a full URL.
    primary.pushQrStatus({ status: 'scaned_but_redirect', redirect_host: idc.baseUrl })
    await idc.waitForCall('/ilink/bot/get_qrcode_status')
    idc.pushQrStatus({
      status: 'confirmed',
      bot_token: 'redirected-token',
      ilink_bot_id: 'bot@idc.ilink',
      baseurl: 'https://ilinkai.weixin.qq.com',
    })
    expect(await untilPoll(flow, s, (p) => p.state === 'success', 'confirmed after redirect')).toEqual({
      state: 'success',
      credentials: { accountId: 'bot-idc-ilink', token: 'redirected-token' },
      config: { baseUrl: 'https://ilinkai.weixin.qq.com' },
    })
    expect(idc.callsTo('/ilink/bot/get_qrcode_status')[0]!.url.searchParams.get('qrcode')).toBe('opaque-qr-token')
  })

  it('treats an already-bound redirect as an actionable failure, not a silent wait', async () => {
    const server = await fakeServer({ idleHoldMs: 60_000 })
    const { flow, session: s } = await startedFlow(server)
    server.pushQrStatus({ status: 'binded_redirect' })
    const poll = await untilPoll(flow, s, (p) => p.state === 'failed', 'binded_redirect')
    expect((poll as { error: string }).error).toMatch(/already bound/)
  })
})
