/** Binary-capable fake Yuanbao HTTP + WebSocket platform for adapter tests. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CMD_AUTH_BIND,
  CMD_TYPE_REQUEST,
  CMD_TYPE_RESPONSE,
  MODULE_BIZ,
  decodeConnMsg,
  encodeConnMsg,
  encodeStatusResponse,
  type YuanbaoConnMsg,
} from '../src/adapter/yuanbao-frames.js'

export interface FakeYuanbaoCall {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string | string[] | undefined>
}

export interface FakeYuanbaoFrame {
  readonly socketId: number
  readonly bytes: Buffer
  readonly message: YuanbaoConnMsg
}

export interface FakeYuanbaoOptions {
  readonly botId?: string
  readonly source?: string
  readonly duration?: number
  readonly signTokenError?: { readonly code: number; readonly msg?: string; readonly status?: number }
  readonly authCode?: number
}

export class FakeYuanbaoApi {
  private readonly server: Server
  private readonly wsServer: WebSocketServer
  private readonly sockets = new Map<number, WebSocket>()
  private readonly calls: FakeYuanbaoCall[] = []
  private readonly frames: FakeYuanbaoFrame[] = []
  private nextSocketId = 0
  private tokenCount = 0
  /** Tests can disable automatic responses to drive msg_id futures manually. */
  autoRespond = true

  constructor(private readonly options: FakeYuanbaoOptions = {}) {
    this.server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    this.wsServer = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://fake-yuanbao')
      if (url.pathname !== '/wss/connection') {
        socket.destroy()
        return
      }
      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.wsServer.emit('connection', ws, req)
      })
    })
    this.wsServer.on('connection', (socket) => this.acceptSocket(socket))
  }

  baseUrl = ''
  wsUrl = ''

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    this.wsUrl = `ws://127.0.0.1:${port}/wss/connection`
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.values()) socket.terminate()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get connectionCount(): number {
    return this.nextSocketId
  }

  get activeConnectionCount(): number {
    return this.sockets.size
  }

  recordedCalls(): readonly FakeYuanbaoCall[] {
    return this.calls
  }

  callsTo(path: string): readonly FakeYuanbaoCall[] {
    return this.calls.filter((call) => call.path === path)
  }

  recordedFrames(): readonly FakeYuanbaoFrame[] {
    return this.frames
  }

  framesFor(cmd: string): readonly FakeYuanbaoFrame[] {
    return this.frames.filter((frame) => frame.message.head.cmd === cmd && frame.message.head.cmdType === CMD_TYPE_REQUEST)
  }

  async waitForFrame(predicate: (frame: FakeYuanbaoFrame) => boolean, timeoutMs = 8000): Promise<FakeYuanbaoFrame> {
    const started = Date.now()
    for (;;) {
      const found = this.frames.find(predicate)
      if (found !== undefined) return found
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for Yuanbao WS frame')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /** Send a response correlated to a captured request's msg_id. */
  respond(request: FakeYuanbaoFrame, code = 0, msgId = request.message.head.msgId): void {
    const socket = this.sockets.get(request.socketId)
    if (socket === undefined) throw new Error('request socket is no longer connected')
    socket.send(encodeConnMsg({
      cmdType: CMD_TYPE_RESPONSE,
      cmd: request.message.head.cmd,
      module: request.message.head.module,
      msgId,
      seqNo: request.message.head.seqNo,
      payload: encodeStatusResponse(code),
    }))
  }

  /** Push a binary inbound_message frame, optionally requiring an ACK. */
  push(payload: Record<string, unknown>, options: { msgId?: string; needAck?: boolean; module?: string } = {}): void {
    const socket = this.sockets.get(this.nextSocketId)
    if (socket === undefined) throw new Error('no Yuanbao WS connection')
    socket.send(encodeConnMsg({
      cmdType: 2,
      cmd: 'inbound_message',
      module: options.module ?? MODULE_BIZ,
      msgId: options.msgId ?? `push-${this.frames.length + 1}`,
      seqNo: 99,
      needAck: options.needAck ?? false,
      payload: Buffer.from(JSON.stringify(payload), 'utf8'),
    }))
  }

  closeLatest(): void {
    this.sockets.get(this.nextSocketId)?.close()
  }

  private acceptSocket(socket: WebSocket): void {
    this.nextSocketId += 1
    const id = this.nextSocketId
    this.sockets.set(id, socket)
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      const message = decodeConnMsg(bytes)
      const frame: FakeYuanbaoFrame = { socketId: id, bytes: Buffer.from(bytes), message }
      this.frames.push(frame)
      if (!this.autoRespond || message.head.cmdType !== CMD_TYPE_REQUEST) return
      if (message.head.cmd === CMD_AUTH_BIND) {
        this.respond(frame, this.options.authCode ?? 0)
      } else if (message.head.cmd.startsWith('send_')) {
        this.respond(frame, 0)
      }
    })
    socket.on('close', () => {
      this.sockets.delete(id)
    })
    socket.on('error', () => {
      // The close event owns lifecycle bookkeeping; test errors are transport-only.
    })
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    const url = new URL(req.url ?? '/', 'http://fake-yuanbao')
    const path = `${url.pathname}${url.search}`
    this.calls.push({ method: req.method ?? '', path, body, headers: req.headers })
    const send = (payload: unknown, status = 200): void => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (req.method === 'POST' && url.pathname === '/api/v5/robotLogic/sign-token') {
      const error = this.options.signTokenError
      if (error !== undefined) {
        send({ code: error.code, msg: error.msg ?? 'sign token failed' }, error.status ?? 200)
        return
      }
      this.tokenCount += 1
      send({
        code: 0,
        data: {
          token: `token-${this.tokenCount}`,
          bot_id: this.options.botId ?? 'bot-yuanbao',
          source: this.options.source ?? 'source-yuanbao',
          duration: this.options.duration ?? 3600,
        },
      })
      return
    }
    send({ code: 404, msg: 'not found' }, 404)
  }
}
