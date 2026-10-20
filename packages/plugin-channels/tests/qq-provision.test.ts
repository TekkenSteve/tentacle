/** QQ scan-to-bind tests, including an independent node:crypto AES-GCM producer. */
import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import { QQ_CHANNEL_TYPE } from '../src/adapter/qq.js'
import type { ProvisionSession } from '../src/provision.js'
import { QQProvisionFlow } from '../src/provision/qq.js'

interface RecordedBindCall {
  readonly path: string
  readonly body: Record<string, unknown>
}

interface FakeReply {
  readonly status: number
  readonly payload: unknown
}

class FakeQQBindService {
  readonly calls: RecordedBindCall[] = []
  private readonly replies: FakeReply[] = []
  private readonly server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      this.calls.push({ path: req.url ?? '/', body })
      const reply = this.replies.shift() ?? { status: 500, payload: { message: 'no scripted reply' } }
      const text = JSON.stringify(reply.payload)
      res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error))
    })
  })
  private closed = false

  baseUrl = ''

  enqueue(status: number, payload: unknown): void {
    this.replies.push({ status, payload })
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

const services: FakeQQBindService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
})

function session(): ProvisionSession {
  return {
    flowId: 'prov-qq-test',
    channelType: QQ_CHANNEL_TYPE,
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: 1_700_000_000_000,
    expiresAt: 0,
    data: undefined,
  }
}

async function fakeService(): Promise<FakeQQBindService> {
  const service = await new FakeQQBindService().listen()
  services.push(service)
  return service
}

function flowFor(service: FakeQQBindService): QQProvisionFlow {
  return new QQProvisionFlow({ apiBaseUrl: service.baseUrl, now: () => 1_700_000_000_000 })
}

describe('QQProvisionFlow', () => {
  it('creates a 32-byte-key task and exact QR parameters, waits, then decrypts success with that same key', async () => {
    const service = await fakeService()
    service.enqueue(200, { retcode: 0, data: { task_id: 'task-abc' } })
    const flow = flowFor(service)
    const s = session()
    const started = await flow.start(s)

    expect(started).toEqual({
      qrUrl: `${service.baseUrl}/qqbot/openclaw/connect.html?task_id=task-abc&source=tentacle&_wv=2`,
      pollAfterMs: 2000,
      expiresAt: 1_700_000_480_000,
    })
    expect(service.calls).toHaveLength(1)
    expect(service.calls[0]!.path).toBe('/lite/create_bind_task')
    const createBody = service.calls[0]!.body
    expect(Object.keys(createBody)).toEqual(['key'])
    const key = createBody['key']
    expect(typeof key).toBe('string')
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    const rawKey = Buffer.from(String(key), 'base64')
    expect(rawKey).toHaveLength(32)
    expect(JSON.stringify(started)).not.toContain(String(key))

    const qr = new URL(started.qrUrl!)
    expect(qr.pathname).toBe('/qqbot/openclaw/connect.html')
    expect(qr.searchParams.get('task_id')).toBe('task-abc')
    expect(qr.searchParams.get('source')).toBe('tentacle')
    expect(qr.searchParams.get('_wv')).toBe('2')

    service.enqueue(200, { retcode: 0, data: { status: 1 } })
    expect(await flow.poll(s)).toEqual({ state: 'waiting', qrUrl: started.qrUrl })
    expect(service.calls[1]).toEqual({ path: '/lite/poll_bind_result', body: { task_id: 'task-abc' } })

    // Independent producer: nonce || ciphertext || 16-byte GCM auth tag.
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', rawKey, nonce)
    const ciphertext = Buffer.concat([cipher.update('decrypted-app-secret', 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
    service.enqueue(200, {
      retcode: 0,
      data: {
        status: 2,
        bot_appid: 'qq-app-id',
        bot_encrypt_secret: encrypted,
        user_openid: 'scanner-openid',
      },
    })
    expect(await flow.poll(s)).toEqual({
      state: 'success',
      credentials: { appId: 'qq-app-id', secret: 'decrypted-app-secret' },
      config: { userOpenid: 'scanner-openid' },
    })
    expect(service.calls[2]!.body).toEqual({ task_id: 'task-abc' })
    expect(JSON.stringify(service.calls)).not.toContain('decrypted-app-secret')
  })

  it('maps status=3 to expired and clears the session on stop', async () => {
    const service = await fakeService()
    service.enqueue(200, { retcode: 0, data: { task_id: 'task-expire' } })
    const flow = flowFor(service)
    const s = session()
    await flow.start(s)
    service.enqueue(200, { retcode: 0, data: { status: 3 } })
    expect(await flow.poll(s)).toEqual({ state: 'expired' })
    expect(s.data).not.toBeUndefined()

    await flow.stop(s)
    expect(s.data).toBeUndefined()
  })

  it('maps a transport failure to failed instead of throwing or leaking request secrets', async () => {
    const service = await fakeService()
    service.enqueue(200, { retcode: 0, data: { task_id: 'task-offline' } })
    const flow = flowFor(service)
    const s = session()
    await flow.start(s)
    const key = String(service.calls[0]!.body['key'])
    await service.close()

    const polled = await flow.poll(s)
    expect(polled.state).toBe('failed')
    if (polled.state !== 'failed') throw new Error('expected failed poll')
    expect(polled.error).toMatch(/QQ poll bind result request failed/)
    expect(polled.error).not.toContain(key)
  })
})
