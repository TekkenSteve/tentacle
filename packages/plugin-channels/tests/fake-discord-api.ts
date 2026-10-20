/**
 * Loopback Discord gateway + REST fake. Every HTTP call and every accepted
 * socket frame is recorded so tests assert on protocol facts (Authorization
 * header, IDENTIFY payload, heartbeat sequence, send body) instead of on what
 * the adapter says it did. The frame shapes mirror Discord v10, not the
 * adapter's parser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'

export interface DiscordApiCall {
  readonly route: 'gateway' | 'me' | 'send'
  readonly path: string
  readonly body: Record<string, unknown>
  readonly authorization?: string
}

interface FakeStream {
  readonly socket: WsSocket
  readonly url: string
  readonly frames: Record<string, unknown>[]
}

export class FakeDiscordApi {
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly calls: DiscordApiCall[] = []
  private readonly streams: FakeStream[] = []

  constructor(private readonly botUser = { id: 'bot-9001', username: 'tentacle-bot', bot: true }) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.wss = new WebSocketServer({ server: this.server, path: '/stream' })
    this.wss.on('connection', (socket, request) => {
      const stream: FakeStream = { socket, url: request.url ?? '', frames: [] }
      this.streams.push(stream)
      socket.on('message', (raw) => {
        try {
          stream.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        } catch {
          stream.frames.push({ raw: raw.toString() })
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

  recorded(): readonly DiscordApiCall[] {
    return this.calls
  }

  callsTo(route: DiscordApiCall['route']): readonly DiscordApiCall[] {
    return this.calls.filter((call) => call.route === route)
  }

  socketCount(): number {
    return this.streams.length
  }

  socketUrl(index = this.streams.length - 1): string {
    return this.streams[index]?.url ?? ''
  }

  socketFrames(index = this.streams.length - 1): readonly Record<string, unknown>[] {
    return this.streams[index]?.frames ?? []
  }

  sendFrame(frame: Record<string, unknown>, index = this.streams.length - 1): void {
    const stream = this.streams[index]
    if (stream === undefined) throw new Error(`no fake discord socket at index ${index}`)
    stream.socket.send(JSON.stringify(frame))
  }

  closeSocket(code = 1000, index = this.streams.length - 1): void {
    const stream = this.streams[index]
    if (stream === undefined) throw new Error(`no fake discord socket at index ${index}`)
    stream.socket.close(code)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const url = new URL(req.url ?? '/', 'http://fake-discord')
    const path = url.pathname
    const authorization = req.headers['authorization']
    if (req.method === 'GET' && path === '/gateway/bot') {
      this.calls.push({ route: 'gateway', path, body, ...(typeof authorization === 'string' ? { authorization } : {}) })
      sendJson(res, 200, { url: `${this.baseUrl.replace(/^http/, 'ws')}/stream` })
      return
    }
    if (req.method === 'GET' && path === '/users/@me') {
      this.calls.push({ route: 'me', path, body, ...(typeof authorization === 'string' ? { authorization } : {}) })
      sendJson(res, 200, this.botUser)
      return
    }
    if (req.method === 'POST' && path.startsWith('/channels/') && path.endsWith('/messages')) {
      this.calls.push({ route: 'send', path, body, ...(typeof authorization === 'string' ? { authorization } : {}) })
      sendJson(res, 201, { id: `sent-${this.calls.length}` })
      return
    }
    sendJson(res, 404, { message: `unknown endpoint ${req.method ?? '?'} ${path}` })
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

/** The Discord v10 gateway frame builders, independent of the adapter. */
export function helloFrame(interval = 41_250): Record<string, unknown> {
  return { op: 10, d: { heartbeat_interval: interval } }
}

export function readyFrame(user = { id: 'bot-9001', username: 'tentacle-bot', bot: true }): Record<string, unknown> {
  return { op: 0, t: 'READY', s: 1, d: { session_id: 'session-e2e', user } }
}

export function messageCreateFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 2,
    d: {
      id: 'msg-1',
      channel_id: 'chan-dm',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000000+00:00',
      author: { id: 'user-7', username: 'ada', bot: false },
      ...overrides,
    },
  }
}
