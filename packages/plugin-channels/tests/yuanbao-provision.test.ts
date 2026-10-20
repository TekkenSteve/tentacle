import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import type { ProvisionSession } from '../src/provision.js'
import { YuanbaoProvisionFlow, type YuanbaoProvisionOptions } from '../src/provision/yuanbao.js'

interface ScanCall {
  readonly method: string
  readonly url: URL
  readonly body: Record<string, unknown>
  readonly headers: IncomingMessage['headers']
}

/** Fake scan-bind service; QR secrets stay in the host-side session in tests. */
class FakeYuanbaoScanApi {
  private readonly server: Server
  readonly calls: ScanCall[] = []
  status = 0
  apiDomain: string | undefined
  expiresIn: number | undefined = 30

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  baseUrl = ''

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    const url = new URL(req.url ?? '/', 'http://fake-yuanbao-scan')
    this.calls.push({ method: req.method ?? '', url, body, headers: req.headers })
    const send = (payload: unknown): void => {
      const text = JSON.stringify(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (req.method === 'GET' && url.pathname === '/api/v5/robotLogic/get-scan-bind-code') {
      send({
        code: 0,
        data: {
          scan_code: 'scan-code-secret',
          access_code: 'access-code-secret',
          scan_url: 'https://bot.yuanbao.tencent.com/scan/abc',
          ...(this.expiresIn === undefined ? {} : { expires_in: this.expiresIn }),
          ...(this.apiDomain === undefined ? {} : { api_domain: this.apiDomain }),
        },
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/v5/robotLogic/check-scan-bind-status') {
      send({
        code: 0,
        data: this.status === 2
          ? { status: 2, app_key: 'bound-app-key', app_secret: 'bound-app-secret' }
          : { status: this.status },
      })
      return
    }
    send({ code: 404, data: {} })
  }
}

const servers: FakeYuanbaoScanApi[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function fakeServer(): Promise<FakeYuanbaoScanApi> {
  const server = new FakeYuanbaoScanApi()
  servers.push(server)
  await server.listen()
  return server
}

function session(now = 1_700_000_000_000): ProvisionSession {
  return {
    flowId: 'prov-yuanbao-test',
    // See the adapter's transitional ChannelType assertion; the central union
    // integration makes this a plain 'yuanbao' literal afterwards.
    channelType: 'yuanbao' as unknown as ProvisionSession['channelType'],
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: now,
    expiresAt: 0,
    data: undefined,
  }
}

function flow(server: FakeYuanbaoScanApi, options: Partial<YuanbaoProvisionOptions> = {}): YuanbaoProvisionFlow {
  return new YuanbaoProvisionFlow({
    apiBaseUrl: server.baseUrl,
    now: () => 1_700_000_000_000,
    ...options,
  })
}

describe('YuanbaoProvisionFlow scan-bind wire contract', () => {
  it('sends the exact QR query and keeps scan secrets only in session.data', async () => {
    const server = await fakeServer()
    const instance = flow(server, { instanceId: 'lighthouse-1', ip: '203.0.113.7' })
    const s = session()
    const started = await instance.start(s)
    expect(started).toEqual({
      qrUrl: 'https://bot.yuanbao.tencent.com/scan/abc',
      expiresAt: 1_700_000_030_000,
      pollAfterMs: 2000,
    })
    const call = server.calls[0]!
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v5/robotLogic/get-scan-bind-code')
    expect(Object.fromEntries(call.url.searchParams.entries())).toEqual({
      instance_id: 'lighthouse-1',
      ip: '203.0.113.7',
      source: 'tx_cloud_lighthouse',
      bot_type: '1',
    })
    expect(call.headers['x-source']).toBe('robot_manager')
    expect(call.headers['user-agent']).toBe('RobotManager/1.0')
    expect(s.data).toMatchObject({ scanCode: 'scan-code-secret', accessCode: 'access-code-secret' })
    expect(JSON.stringify(started)).not.toContain('scan-code-secret')
    expect(JSON.stringify(started)).not.toContain('access-code-secret')

    server.status = 1
    const polled = await instance.poll(s)
    expect(polled).toEqual({
      state: 'waiting',
      qrUrl: 'https://bot.yuanbao.tencent.com/scan/abc',
      message: '已扫码，请在手机上确认',
    })
    const pollCall = server.calls[1]!
    expect(pollCall.method).toBe('POST')
    expect(pollCall.body).toEqual({ scan_code: 'scan-code-secret', access_code: 'access-code-secret' })
  })

  it('uses empty instance_id/ip by default and applies the 900-second TTL default', async () => {
    const server = await fakeServer()
    server.expiresIn = undefined
    const instance = flow(server)
    const s = session()
    const started = await instance.start(s)
    const query = server.calls[0]!.url.searchParams
    expect(query.get('instance_id')).toBe('')
    expect(query.get('ip')).toBe('')
    expect(query.get('source')).toBe('tx_cloud_lighthouse')
    expect(query.get('bot_type')).toBe('1')
    expect(started.expiresAt).toBe(1_700_000_900_000)
  })
})

describe('YuanbaoProvisionFlow status state machine', () => {
  it('maps status 0 and 1 to waiting (with confirmation copy for 1)', async () => {
    const server = await fakeServer()
    const instance = flow(server)
    const s = session()
    await instance.start(s)
    server.status = 0
    expect(await instance.poll(s)).toEqual({ state: 'waiting', qrUrl: 'https://bot.yuanbao.tencent.com/scan/abc' })
    server.status = 1
    expect(await instance.poll(s)).toMatchObject({ state: 'waiting', message: '已扫码，请在手机上确认' })
  })

  it('maps status 2 to appKey/appSecret credentials and optional apiDomain config', async () => {
    const server = await fakeServer()
    server.apiDomain = 'https://scan-returned.example'
    const instance = flow(server)
    const s = session()
    await instance.start(s)
    server.status = 2
    const result = await instance.poll(s)
    expect(result).toEqual({
      state: 'success',
      credentials: { appKey: 'bound-app-key', appSecret: 'bound-app-secret' },
      config: { apiDomain: 'https://scan-returned.example' },
    })
    expect(JSON.stringify(result)).not.toContain('scan-code-secret')
    expect(JSON.stringify(result)).not.toContain('access-code-secret')
    expect(result.state === 'success' && 'scanCode' in result).toBe(false)
    expect(result.state === 'success' && 'accessCode' in result).toBe(false)
  })

  it('omits config when the scan response has no api_domain', async () => {
    const server = await fakeServer()
    const instance = flow(server)
    const s = session()
    await instance.start(s)
    server.status = 2
    expect(await instance.poll(s)).toEqual({
      state: 'success',
      credentials: { appKey: 'bound-app-key', appSecret: 'bound-app-secret' },
    })
  })

  it('maps status 3 to failed and status 4 to expired', async () => {
    const server = await fakeServer()
    const cancelled = flow(server)
    const cancelledSession = session()
    await cancelled.start(cancelledSession)
    server.status = 3
    expect(await cancelled.poll(cancelledSession)).toEqual({ state: 'failed', error: 'yuanbao scan binding was cancelled' })

    const expired = flow(server)
    const expiredSession = session()
    await expired.start(expiredSession)
    server.status = 4
    expect(await expired.poll(expiredSession)).toEqual({ state: 'expired' })
  })
})
