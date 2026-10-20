/**
 * Loopback iLink fake used by both Weixin suites. It records the actual HTTP
 * method, URL, headers and JSON body so assertions pin protocol fields rather
 * than merely checking a mocked TypeScript call signature.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeWeixinCall {
  readonly path: string
  readonly method: string
  readonly url: URL
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

export interface FakeWeixinApiOptions {
  /** Empty polls stay open this long; use a large value for cancellation tests. */
  readonly idleHoldMs?: number
  readonly qrcode?: string
  readonly qrcodeImageUrl?: string
}

type Payload = Record<string, unknown>

export class FakeWeixinApi {
  baseUrl = ''
  abortedRequests = 0

  private readonly server: Server
  private readonly calls: FakeWeixinCall[] = []
  private readonly updateResponses: Payload[] = []
  private readonly sendResponses: Payload[] = []
  private readonly qrStatusResponses: Payload[] = []
  private readonly waiters = new Set<() => void>()
  private closing = false

  constructor(private readonly options: FakeWeixinApiOptions = {}) {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  async close(): Promise<void> {
    this.closing = true
    for (const wake of [...this.waiters]) wake()
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
  }

  pushUpdates(payload: Payload): void {
    this.updateResponses.push(payload)
    this.wake()
  }

  pushSend(payload: Payload): void {
    this.sendResponses.push(payload)
  }

  pushQrStatus(payload: Payload): void {
    this.qrStatusResponses.push(payload)
    this.wake()
  }

  recorded(): readonly FakeWeixinCall[] {
    return this.calls
  }

  callsTo(path: string): readonly FakeWeixinCall[] {
    return this.calls.filter((call) => call.path === path)
  }

  waitForCall(
    path: string,
    predicate: (call: FakeWeixinCall) => boolean = () => true,
    timeoutMs = 4_000,
  ): Promise<FakeWeixinCall> {
    return new Promise((resolve, reject) => {
      const found = this.calls.find((call) => call.path === path && predicate(call))
      if (found !== undefined) {
        resolve(found)
        return
      }
      const started = Date.now()
      const poll = setInterval(() => {
        const hit = this.calls.find((call) => call.path === path && predicate(call))
        if (hit !== undefined) {
          clearInterval(poll)
          resolve(hit)
          return
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(poll)
          reject(new Error(`timed out waiting for ${path}; saw ${this.calls.map((call) => call.path).join(', ')}`))
        }
      }, 5)
    })
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Payload
    const url = new URL(req.url ?? '/', 'http://ilink.fake')
    this.calls.push({ path: url.pathname, method: req.method ?? '', url, headers: req.headers, body })
    res.on('close', () => {
      if (!res.writableEnded) this.abortedRequests += 1
    })

    switch (url.pathname) {
      case '/ilink/bot/getupdates': {
        const payload = await this.nextOrIdle(this.updateResponses, res, () => ({
          msgs: [],
          get_updates_buf: body['get_updates_buf'] ?? '',
        }))
        if (payload !== undefined) this.send(res, payload)
        return
      }
      case '/ilink/bot/sendmessage':
        this.send(res, this.sendResponses.shift() ?? { ret: 0, messageId: 1 })
        return
      case '/ilink/bot/get_bot_qrcode':
        this.send(res, {
          qrcode: this.options.qrcode ?? 'opaque-qr-token',
          qrcode_img_content: this.options.qrcodeImageUrl ?? 'https://ilinkai.weixin.qq.com/qr/renderable.png',
        })
        return
      case '/ilink/bot/get_qrcode_status': {
        const payload = await this.nextOrIdle(this.qrStatusResponses, res, () => ({ status: 'wait' }))
        if (payload !== undefined) this.send(res, payload)
        return
      }
      default:
        this.send(res, { ret: 404, errcode: 404 }, 404)
    }
  }

  /** Return a queued response, or hold like the platform's long poll. */
  private async nextOrIdle(
    queue: Payload[],
    res: ServerResponse,
    empty: () => Payload,
  ): Promise<Payload | undefined> {
    for (;;) {
      const queued = queue.shift()
      if (queued !== undefined) return queued
      if (this.closing || res.destroyed) return undefined
      const hold = this.options.idleHoldMs ?? 20
      const awakened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake)
          resolve(false)
        }, hold)
        const wake = (): void => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve(true)
        }
        this.waiters.add(wake)
      })
      if (!awakened) return this.closing || res.destroyed ? undefined : empty()
    }
  }

  private send(res: ServerResponse, payload: Payload, status = 200): void {
    if (this.closing || res.destroyed) return
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
}

/** Protocol-shaped user text message (responses use camelCase, types.py:63-74). */
export function weixinTextMessage(
  messageId: number,
  text: string,
  extra: Payload = {},
): Payload {
  return {
    message_id: messageId,
    from_user_id: 'user-7',
    to_user_id: 'bot-account',
    create_time_ms: 1_700_000_000_123,
    session_id: 'user-7',
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  }
}
