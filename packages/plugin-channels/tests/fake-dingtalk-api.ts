/**
 * Loopback DingTalk OpenAPI + Stream + device-registration fakes.
 *
 * Every request is recorded before a protocol-shaped answer is returned. Tests
 * assert against those independent recordings (and raw WS URLs/frames), rather
 * than mocking the adapter's own parsing functions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'

export type DingTalkRoute = 'open' | 'token' | 'direct' | 'webhook'

export interface DingTalkApiCall {
  readonly route: DingTalkRoute
  readonly path: string
  readonly body: Record<string, unknown>
  readonly accessToken?: string
}

interface FakeStream {
  readonly socket: WsSocket
  readonly url: string
  readonly frames: Record<string, unknown>[]
}

export interface FakeDingTalkApiOptions {
  readonly ticket?: string
  readonly expireInSeconds?: number
  /** Permanent handshake error, useful for fatal credential tests. */
  readonly openErrorStatus?: number
}

export class FakeDingTalkApi {
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly calls: DingTalkApiCall[] = []
  private readonly streams: FakeStream[] = []
  private tokensIssued = 0
  /** Number of temporary 503 answers before connections/open succeeds. */
  failOpenAttempts = 0
  /** connections/open attempt timestamps, including rejected attempts. */
  readonly openAttempts: number[] = []

  constructor(private readonly options: FakeDingTalkApiOptions = {}) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.wss = new WebSocketServer({ server: this.server, path: '/stream' })
    this.wss.on('connection', (socket, request) => {
      const stream: FakeStream = { socket, url: request.url ?? '', frames: [] }
      this.streams.push(stream)
      socket.on('message', (raw) => {
        const text = raw.toString()
        try {
          stream.frames.push(JSON.parse(text) as Record<string, unknown>)
        } catch {
          stream.frames.push({ raw: text })
        }
      })
    })
  }

  baseUrl = ''

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.socket.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  recorded(): readonly DingTalkApiCall[] {
    return this.calls
  }

  callsTo(route: DingTalkRoute): readonly DingTalkApiCall[] {
    return this.calls.filter((call) => call.route === route)
  }

  socketCount(): number {
    return this.streams.length
  }

  socketUrl(index = this.streams.length - 1): string {
    return this.streams[index]?.url ?? ''
  }

  /** Frames written by the adapter to one accepted Stream socket. */
  socketFrames(index = this.streams.length - 1): readonly Record<string, unknown>[] {
    return this.streams[index]?.frames ?? []
  }

  sendFrame(frame: Record<string, unknown>, index = this.streams.length - 1): void {
    const stream = this.streams[index]
    if (stream === undefined) throw new Error(`no fake DingTalk socket at index ${index}`)
    stream.socket.send(JSON.stringify(frame))
  }

  closeSocket(index = this.streams.length - 1): void {
    const stream = this.streams[index]
    if (stream === undefined) throw new Error(`no fake DingTalk socket at index ${index}`)
    stream.socket.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const url = new URL(req.url ?? '/', 'http://fake-dingtalk')
    const path = url.pathname
    if (req.method === 'POST' && path === '/v1.0/gateway/connections/open') {
      this.calls.push({ route: 'open', path, body })
      this.openAttempts.push(Date.now())
      if (this.options.openErrorStatus !== undefined) {
        sendJson(res, this.options.openErrorStatus, { message: 'invalid stream credentials' })
        return
      }
      if (this.failOpenAttempts > 0) {
        this.failOpenAttempts -= 1
        sendJson(res, 503, { message: 'temporary gateway failure' })
        return
      }
      const endpoint = `${this.baseUrl.replace(/^http/, 'ws')}/stream`
      sendJson(res, 200, { endpoint, ticket: this.options.ticket ?? 'ticket +/%?=' })
      return
    }
    if (req.method === 'POST' && path === '/v1.0/oauth2/accessToken') {
      this.calls.push({ route: 'token', path, body })
      this.tokensIssued += 1
      sendJson(res, 200, {
        accessToken: `dt-token-${this.tokensIssued}`,
        expireIn: this.options.expireInSeconds ?? 7200,
      })
      return
    }
    if (req.method === 'POST' && path === '/v1.0/robot/oToMessages/batchSend') {
      const token = req.headers['x-acs-dingtalk-access-token']
      this.calls.push({
        route: 'direct',
        path,
        body,
        ...(typeof token === 'string' ? { accessToken: token } : {}),
      })
      sendJson(res, 200, { processQueryKey: `query-${this.calls.length}`, requestId: `request-${this.calls.length}` })
      return
    }
    if (req.method === 'POST' && path === '/robot/sendBySession') {
      this.calls.push({ route: 'webhook', path: `${path}${url.search}`, body })
      sendJson(res, 200, { errcode: 0, errmsg: 'ok' })
      return
    }
    sendJson(res, 404, { message: `unknown endpoint ${req.method ?? '?'} ${path}` })
  }
}

// ---- Device-registration fake --------------------------------------------

export type RegistrationRoute = 'init' | 'begin' | 'poll'

export interface RegistrationCall {
  readonly route: RegistrationRoute
  readonly body: Record<string, unknown>
}

export interface FakeDingTalkRegistrationOptions {
  readonly init?: Record<string, unknown>
  readonly begin?: Record<string, unknown>
}

export class FakeDingTalkRegistration {
  private readonly server: Server
  private readonly calls: RegistrationCall[] = []
  private readonly polls: Record<string, unknown>[] = []

  constructor(private readonly options: FakeDingTalkRegistrationOptions = {}) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  baseUrl = ''

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  pushPoll(...responses: Record<string, unknown>[]): void {
    this.polls.push(...responses)
  }

  recorded(): readonly RegistrationCall[] {
    return this.calls
  }

  callsTo(route: RegistrationRoute): readonly RegistrationCall[] {
    return this.calls.filter((call) => call.route === route)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const path = new URL(req.url ?? '/', 'http://fake-registration').pathname
    if (req.method !== 'POST') {
      sendJson(res, 404, { errcode: 404, errmsg: 'not found' })
      return
    }
    if (path === '/app/registration/init') {
      this.calls.push({ route: 'init', body })
      sendJson(res, 200, { errcode: 0, errmsg: 'ok', nonce: 'nonce-1', expires_in: 300, ...this.options.init })
      return
    }
    if (path === '/app/registration/begin') {
      this.calls.push({ route: 'begin', body })
      sendJson(res, 200, {
        errcode: 0,
        errmsg: 'ok',
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH-IJKL',
        verification_uri_complete: 'https://open-dev.dingtalk.com/scan?code=public',
        expires_in: 600,
        interval: 5,
        ...this.options.begin,
      })
      return
    }
    if (path === '/app/registration/poll') {
      this.calls.push({ route: 'poll', body })
      const result = this.polls.shift() ?? { status: 'WAITING' }
      sendJson(res, 200, { errcode: 0, errmsg: 'ok', ...result })
      return
    }
    sendJson(res, 404, { errcode: 404, errmsg: 'not found' })
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

// ---- Independent protocol-frame builders ---------------------------------

export function callbackFrame(data: Record<string, unknown>, messageId = 'stream-1'): Record<string, unknown> {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      messageId,
      topic: '/v1.0/im/bot/messages/get',
      contentType: 'application/json',
      time: '1700000000000',
    },
    data: JSON.stringify(data),
  }
}

export function chatbotData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgId: 'msg-1',
    msgtype: 'text',
    text: { content: 'hello' },
    conversationId: 'cid-dm',
    conversationType: '1',
    senderId: 'encrypted-sender',
    senderStaffId: 'staff-7',
    senderNick: 'Ada',
    senderCorpId: 'corp-1',
    chatbotUserId: 'bot-user',
    isInAtList: false,
    createAt: 1_700_000_000_000,
    sessionWebhook: '',
    ...overrides,
  }
}
