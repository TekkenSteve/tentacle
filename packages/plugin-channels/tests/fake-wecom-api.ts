/** Real-loopback WeCom WebSocket fake used by adapter protocol tests. */

import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { WeComFrame } from '../src/adapter/wecom-api.js'

export interface RecordedWeComFrame {
  readonly connectionId: number
  readonly frame: WeComFrame
}

export interface FakeWeComApiOptions {
  readonly authError?: { readonly errcode: number; readonly errmsg?: string }
  readonly autoPong?: boolean
  readonly autoAck?: boolean
}

interface FrameWaiter {
  readonly predicate: (record: RecordedWeComFrame) => boolean
  readonly resolve: (record: RecordedWeComFrame) => void
  readonly reject: (error: Error) => void
  readonly timer?: ReturnType<typeof setTimeout>
}

export class FakeWeComApi {
  private readonly server: WebSocketServer
  private readonly records: RecordedWeComFrame[] = []
  private readonly sockets = new Map<number, WebSocket>()
  private readonly waiters = new Set<FrameWaiter>()
  private nextConnectionId = 1
  private listening = false
  url = ''

  constructor(private readonly options: FakeWeComApiOptions = {}) {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.server.on('connection', (socket) => this.onConnection(socket))
  }

  async listen(): Promise<string> {
    if (this.listening) return this.url
    await new Promise<void>((resolve) => this.server.once('listening', resolve))
    this.listening = true
    const address = this.server.address() as AddressInfo
    this.url = `ws://127.0.0.1:${address.port}`
    return this.url
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(new Error('fake WeCom server closed'))
    }
    this.waiters.clear()
    for (const socket of this.sockets.values()) socket.terminate()
    this.sockets.clear()
    if (!this.listening) return
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.listening = false
  }

  recorded(command?: string): readonly RecordedWeComFrame[] {
    return this.records.filter((record) => command === undefined || record.frame.cmd === command)
  }

  connectionCount(): number {
    return this.sockets.size
  }

  activeConnectionId(): number {
    const active = [...this.sockets].findLast(([, socket]) => socket.readyState === WebSocket.OPEN)
    if (active === undefined) throw new Error('no open fake WeCom connection')
    return active[0]
  }

  send(frame: WeComFrame, connectionId = this.activeConnectionId()): void {
    const socket = this.sockets.get(connectionId)
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`fake WeCom connection ${connectionId} is not open`)
    }
    socket.send(JSON.stringify(frame))
  }

  drop(connectionId: number): void {
    const socket = this.sockets.get(connectionId)
    if (socket === undefined) throw new Error(`unknown fake WeCom connection ${connectionId}`)
    socket.terminate()
  }

  waitForFrame(
    predicate: (record: RecordedWeComFrame) => boolean,
    timeoutMs = 8_000,
  ): Promise<RecordedWeComFrame> {
    const found = this.records.find(predicate)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        predicate,
        resolve,
        reject,
        ...(timeoutMs <= 0 ? {} : {
          timer: setTimeout(() => {
            this.waiters.delete(waiter)
            reject(new Error('timed out waiting for fake WeCom frame'))
          }, timeoutMs),
        }),
      }
      this.waiters.add(waiter)
    })
  }

  private onConnection(socket: WebSocket): void {
    const connectionId = this.nextConnectionId
    this.nextConnectionId += 1
    this.sockets.set(connectionId, socket)
    socket.on('message', (data: RawData) => {
      const frame = JSON.parse(data.toString()) as WeComFrame
      const record = { connectionId, frame }
      this.records.push(record)
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(record)) continue
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(record)
      }
      this.answer(connectionId, frame)
    })
  }

  private answer(connectionId: number, frame: WeComFrame): void {
    const reqId = frame.headers?.req_id
    if (reqId === undefined) return
    if (frame.cmd === 'aibot_subscribe') {
      const error = this.options.authError
      this.send({
        headers: { req_id: reqId },
        errcode: error?.errcode ?? 0,
        errmsg: error?.errmsg ?? 'ok',
      }, connectionId)
      return
    }
    if (frame.cmd === 'ping') {
      if (this.options.autoPong !== false) this.send({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }, connectionId)
      return
    }
    if ((frame.cmd === 'aibot_respond_msg' || frame.cmd === 'aibot_send_msg') && this.options.autoAck !== false) {
      this.send({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }, connectionId)
    }
  }
}

export function textCallback(options: {
  readonly reqId: string
  readonly msgId: string
  readonly chatType?: 'single' | 'group'
  readonly chatId?: string
  readonly senderId?: string
  readonly botId?: string
  readonly text?: string
  readonly createTime?: number
}): WeComFrame {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: options.reqId },
    body: {
      msgid: options.msgId,
      aibotid: options.botId ?? 'bot-1',
      ...(options.chatType === 'group' ? { chatid: options.chatId ?? 'room-1' } : {}),
      chattype: options.chatType ?? 'single',
      from: { userid: options.senderId ?? 'alice' },
      create_time: options.createTime ?? 1_700_000_000,
      msgtype: 'text',
      text: { content: options.text ?? 'hello' },
    },
  }
}
