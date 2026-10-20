/** WeCom scode quick-provisioning tests with an independent loopback HTTP fake. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import type { ProvisionSession } from '../src/provision.js'
import { WECOM_QR_TTL_MS, WeComProvisionFlow, weComPlatCode } from '../src/provision/wecom.js'

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
}

class FakeScodeService {
  private readonly server: Server
  private readonly requests: RecordedRequest[] = []
  private pollData: Record<string, unknown>[] = []
  private listening = false
  baseUrl = ''

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      this.requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
      })
      const data = url.pathname === '/ai/qc/generate'
        ? { scode: 'scode-live-123', auth_url: 'https://work.weixin.qq.com/ai/qc/gen?scode=scode-live-123' }
        : this.pollData.shift() ?? { status: 'pending' }
      const body = JSON.stringify({ data })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.listening = true
    const address = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this.baseUrl
  }

  async close(): Promise<void> {
    if (!this.listening) return
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.listening = false
  }

  queuePoll(...data: Record<string, unknown>[]): void {
    this.pollData.push(...data)
  }

  recorded(): readonly RecordedRequest[] {
    return this.requests
  }
}

const services: FakeScodeService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
})

async function fakeService(): Promise<FakeScodeService> {
  const service = new FakeScodeService()
  services.push(service)
  await service.listen()
  return service
}

function session(now: number): ProvisionSession {
  return {
    flowId: 'prov-wecom-test',
    channelType: 'wecom' as ProvisionSession['channelType'],
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: now,
    expiresAt: 0,
    data: undefined,
  }
}

describe('WeComProvisionFlow', () => {
  it('uses the exact generate query, keeps scode in session.data, then returns only credentials on success', async () => {
    const service = await fakeService()
    service.queuePoll(
      { status: 'scanned' },
      { status: 'success', bot_info: { botid: 'bot-from-scan', secret: 'secret-from-scan' } },
    )
    let now = 1_700_000_000_000
    const flow = new WeComProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => now })
    const s = session(now)

    const started = await flow.start(s)
    expect(started).toEqual({
      qrUrl: 'https://work.weixin.qq.com/ai/qc/gen?scode=scode-live-123',
      expiresAt: now + WECOM_QR_TTL_MS,
      pollAfterMs: 2000,
    })
    expect(Object.keys(started)).not.toContain('scode')
    expect(s.data).toEqual({
      scode: 'scode-live-123',
      qrUrl: started.qrUrl,
      expiresAt: now + WECOM_QR_TTL_MS,
    })
    expect(service.recorded()[0]).toEqual({
      method: 'GET',
      path: '/ai/qc/generate',
      query: { source: 'tentacle', plat: String(weComPlatCode()) },
    })

    expect(await flow.poll(s)).toEqual({
      state: 'waiting',
      qrUrl: started.qrUrl,
      message: 'scanned',
    })
    expect(service.recorded()[1]).toEqual({
      method: 'GET',
      path: '/ai/qc/query_result',
      query: { scode: 'scode-live-123' },
    })

    now += 2000
    const success = await flow.poll(s)
    expect(success).toEqual({
      state: 'success',
      credentials: { botId: 'bot-from-scan', secret: 'secret-from-scan' },
    })
    expect(Object.keys(success)).toEqual(['state', 'credentials'])
    expect(JSON.stringify(success)).not.toContain('scode-live-123')
    expect(success.credentials.secret).toBe('secret-from-scan')
    expect(success.credentials.secret).not.toBe('scode-live-123')
    expect(s.data).toBeUndefined()
  })

  it('maps success without bot_info to a failed result with the protocol reason', async () => {
    const service = await fakeService()
    service.queuePoll({ status: 'success' })
    const now = 1_700_000_000_000
    const flow = new WeComProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => now })
    const s = session(now)
    await flow.start(s)
    expect(await flow.poll(s)).toEqual({
      state: 'failed',
      error: 'QR scan succeeded but bot info is missing',
    })
  })

  it('passes every non-terminal platform status through verbatim as waiting.message', async () => {
    const service = await fakeService()
    service.queuePoll({ status: 'a_future_vendor_status' })
    const now = 1_700_000_000_000
    const flow = new WeComProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => now })
    const s = session(now)
    const started = await flow.start(s)
    expect(await flow.poll(s)).toEqual({
      state: 'waiting',
      qrUrl: started.qrUrl,
      message: 'a_future_vendor_status',
    })
  })

  it('maps error with its reason and expired/timeout to their terminal states', async () => {
    const service = await fakeService()
    service.queuePoll(
      { status: 'error', reason: 'user cancelled' },
      { status: 'expired' },
      { status: 'timeout' },
    )
    const now = 1_700_000_000_000
    const flow = new WeComProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => now })

    const failed = session(now)
    await flow.start(failed)
    expect(await flow.poll(failed)).toEqual({ state: 'failed', error: 'user cancelled' })

    const expired = session(now)
    await flow.start(expired)
    expect(await flow.poll(expired)).toEqual({ state: 'expired' })

    const timedOut = session(now)
    await flow.start(timedOut)
    expect(await flow.poll(timedOut)).toEqual({ state: 'expired' })
  })

  it('expires a locally timed-out session and clears its scode without another request', async () => {
    const service = await fakeService()
    let now = 1_700_000_000_000
    const flow = new WeComProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => now })
    const s = session(now)
    await flow.start(s)
    now += WECOM_QR_TTL_MS
    expect(await flow.poll(s)).toEqual({ state: 'expired' })
    expect(s.data).toBeUndefined()
    expect(service.recorded()).toHaveLength(1)
  })

  it('maps Node platforms to the expected plat values', () => {
    expect(weComPlatCode('darwin')).toBe(1)
    expect(weComPlatCode('win32')).toBe(2)
    expect(weComPlatCode('linux')).toBe(3)
    expect(weComPlatCode('freebsd')).toBe(0)
  })
})
