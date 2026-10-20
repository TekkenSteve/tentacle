/** Local QQ REST + WebSocket gateway fake used by qq.test.ts. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export interface QQRestCall {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
  readonly authorization: string | undefined
}

export interface FakeQQApiOptions {
  /** Return one token-rejecting 401 for the first outbound message POST. */
  readonly rejectFirstSendWith401?: boolean
}

export class FakeQQConnection {
  readonly frames: Record<string, unknown>[] = []

  constructor(readonly index: number, private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      this.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>)
    })
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame))
  }

  close(): void {
    this.socket.close()
  }

  terminate(): void {
    this.socket.terminate()
  }

  async waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const started = Date.now()
    for (;;) {
      const found = this.frames.find(predicate)
      if (found !== undefined) return found
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for gateway frame; got ${JSON.stringify(this.frames)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

export class FakeQQApi {
  readonly connections: FakeQQConnection[] = []
  readonly calls: QQRestCall[] = []
  private readonly server: Server
  private readonly wss: WebSocketServer
  private rejectedFirstSend = false
  private closed = false

  baseUrl = ''
  gatewayUrl = ''

  constructor(private readonly options: FakeQQApiOptions = {}) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.wss = new WebSocketServer({ server: this.server, path: '/socket' })
    this.wss.on('connection', (socket) => {
      this.connections.push(new FakeQQConnection(this.connections.length, socket))
    })
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    this.gatewayUrl = `ws://127.0.0.1:${port}/socket`
    return this
  }

  get tokenCalls(): readonly QQRestCall[] {
    return this.calls.filter((call) => call.path === '/app/getAppAccessToken')
  }

  get gatewayCalls(): readonly QQRestCall[] {
    return this.calls.filter((call) => call.path === '/gateway/bot')
  }

  get sendCalls(): readonly QQRestCall[] {
    return this.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))
  }

  async waitForConnection(index: number, timeoutMs = 4000): Promise<FakeQQConnection> {
    const started = Date.now()
    while (this.connections[index] === undefined) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for QQ socket ${index}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return this.connections[index]!
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const connection of this.connections) connection.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    this.calls.push({
      method: req.method ?? 'GET',
      path,
      body,
      authorization: req.headers.authorization,
    })
    if (path === '/app/getAppAccessToken') {
      const sequence = this.tokenCalls.length
      this.json(res, 200, { access_token: `qq-token-${sequence}`, expires_in: '7200' })
      return
    }
    if (path === '/gateway/bot') {
      this.json(res, 200, { url: this.gatewayUrl })
      return
    }
    if (req.method === 'POST' && path.endsWith('/messages')) {
      if (this.options.rejectFirstSendWith401 === true && !this.rejectedFirstSend) {
        this.rejectedFirstSend = true
        this.json(res, 401, { code: 11244, message: 'access token rejected' })
        return
      }
      this.json(res, 200, { id: `sent-${this.sendCalls.length}` })
      return
    }
    this.json(res, 404, { message: 'not found' })
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
}
