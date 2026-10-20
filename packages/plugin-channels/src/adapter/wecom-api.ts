/**
 * WeCom AI Bot WebSocket transport, implemented with Node's built-in WebSocket.
 *
 * Protocol references (read verbatim before implementing):
 * - `.tmp/sdks/wecom_aibot_sdk-1.0.8-py3-none-any/wecom_aibot_sdk/types.py:41-73`
 *   (frame commands and envelope);
 * - `.../ws.py:90-137,175-280` (connect → subscribe → authenticated loop);
 * - `.../ws.py:282-325` (30s application heartbeat, two missed pongs);
 * - `.../ws.py:327-396` (exponential reconnect, capped at 30s);
 * - `.../client.py:240-291,440-455` (passive stream replies and proactive send).
 *
 * No credential is ever included in a log line. In particular, errors are
 * constructed here rather than by formatting a URL or an outbound auth frame.
 */

import { randomBytes } from 'node:crypto'

export const WECOM_DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com'
export const WECOM_HEARTBEAT_INTERVAL_MS = 30_000
export const WECOM_RECONNECT_BASE_DELAY_MS = 1_000
export const WECOM_RECONNECT_MAX_DELAY_MS = 30_000
export const WECOM_REPLY_ACK_TIMEOUT_MS = 5_000

export type WeComErrorCode = 'config' | 'auth' | 'api' | 'transport' | 'invalid-response' | 'closed'

export class WeComError extends Error {
  constructor(
    readonly code: WeComErrorCode,
    message: string,
    readonly platformCode?: number,
  ) {
    super(message)
    this.name = 'WeComError'
  }
}

/** Only the wire fields used by this package; unknown protocol fields are preserved structurally by callers. */
export interface WeComFrame {
  readonly cmd?: string
  readonly headers?: { readonly req_id?: string }
  readonly body?: Record<string, unknown>
  readonly errcode?: number
  readonly errmsg?: string
}

export interface WeComStreamReply {
  readonly id: string
  readonly content: string
  readonly finish: boolean
}

export interface WeComApi {
  /** Resolve only after the subscribe response has authenticated successfully. */
  start(): Promise<void>
  stop(): Promise<void>
  replyStream(reqId: string, stream: WeComStreamReply): Promise<void>
  sendMarkdown(chatId: string, text: string): Promise<void>
}

export interface WeComApiOptions {
  readonly botId: string
  readonly secret: string
  /** The reference implementation passes a custom URL through; otherwise SDK ws.py:18,36 selects this default. */
  readonly wsUrl?: string
  readonly onMessage: (frame: WeComFrame) => void
  /** Called for every socket close so stale passive-reply contexts can be dropped. */
  readonly onDisconnect?: () => void
  /** Authentication refusal or a server-side replacement connection is not recoverable in-place. */
  readonly onFailure?: (error: WeComError) => void
  readonly log?: (level: 'info' | 'warn' | 'debug', message: string) => void
}

interface StartWaiter {
  readonly resolve: () => void
  readonly reject: (error: WeComError) => void
}

interface PendingAck {
  readonly resolve: () => void
  readonly reject: (error: WeComError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** `{prefix}_{millisecond timestamp}_{8 hex chars}` — SDK utils.py:11-24. */
export function generateWeComReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`
}

export function createWeComApi(options: WeComApiOptions): WeComApi {
  return new WeComClient(options)
}

class WeComClient implements WeComApi {
  private readonly wsUrl: string
  private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  private socket: WebSocket | undefined
  private started = false
  private authenticated = false
  private startWaiter: StartWaiter | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private missedPongs = 0
  private readonly pendingAcks = new Map<string, PendingAck>()
  /** SDK ws.py:405-512 serializes replies sharing one callback req_id. */
  private readonly replyQueues = new Map<string, Promise<void>>()

  constructor(private readonly options: WeComApiOptions) {
    this.wsUrl = options.wsUrl === undefined || options.wsUrl === ''
      ? WECOM_DEFAULT_WS_URL
      : options.wsUrl
    this.log = options.log ?? (() => undefined)
  }

  async start(): Promise<void> {
    if (this.started) throw new WeComError('config', 'wecom client is already started')
    if (this.options.botId.trim() === '' || this.options.secret.trim() === '') {
      const error = new WeComError('config', 'wecom botId and secret are required')
      this.options.onFailure?.(error)
      throw error
    }
    this.started = true
    this.authenticated = false
    const completed = new Promise<void>((resolve, reject) => {
      this.startWaiter = { resolve, reject }
    })
    try {
      this.openConnection()
    } catch (error) {
      const wrapped = this.asError(error, 'wecom websocket connection failed', 'transport')
      this.started = false
      this.startWaiter = undefined
      if (wrapped.code === 'config') this.options.onFailure?.(wrapped)
      throw wrapped
    }
    return completed
  }

  async stop(): Promise<void> {
    this.started = false
    this.authenticated = false
    this.stopHeartbeat()
    this.cancelReconnect()
    const waiter = this.startWaiter
    this.startWaiter = undefined
    waiter?.reject(new WeComError('closed', 'wecom client stopped before authentication'))
    this.rejectPending(new WeComError('closed', 'wecom client stopped'))
    const socket = this.socket
    if (socket === undefined) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 1_000)
      timer.unref?.()
      socket.addEventListener('close', finish, { once: true })
      try {
        // SDK ws.py:543-577 uses a normal manual close rather than reconnecting.
        socket.close(1000, 'Manual disconnect')
      } catch {
        finish()
      }
    })
  }

  async replyStream(reqId: string, stream: WeComStreamReply): Promise<void> {
    if (reqId === '') throw new WeComError('config', 'wecom passive reply requires the callback req_id')
    // SDK client.py:257-291 + ws.py:405-422: a stream reply reuses the inbound
    // callback req_id and is carried by aibot_respond_msg.
    await this.enqueue(reqId, {
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: {
        msgtype: 'stream',
        stream: { id: stream.id, finish: stream.finish, content: stream.content },
      },
    })
  }

  async sendMarkdown(chatId: string, text: string): Promise<void> {
    if (chatId === '') throw new WeComError('config', 'wecom proactive send requires a chat id')
    const reqId = generateWeComReqId('aibot_send_msg')
    // SDK client.py:440-455: chatid is merged into the proactive body, and a
    // fresh aibot_send_msg req_id correlates its acknowledgement.
    await this.enqueue(reqId, {
      cmd: 'aibot_send_msg',
      headers: { req_id: reqId },
      body: { chatid: chatId, msgtype: 'markdown', markdown: { content: text } },
    })
  }

  private openConnection(): void {
    let socket: WebSocket
    try {
      socket = new WebSocket(this.wsUrl)
    } catch (error) {
      throw this.asError(error, 'wecom websocket URL is invalid', 'config')
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket || !this.started) return
      this.missedPongs = 0
      const reqId = generateWeComReqId('aibot_subscribe')
      try {
        // SDK ws.py:175-186: subscribe immediately on open; credentials exist
        // only in this frame body, never in the URL or diagnostics.
        this.sendFrame(socket, {
          cmd: 'aibot_subscribe',
          headers: { req_id: reqId },
          body: { bot_id: this.options.botId, secret: this.options.secret },
        })
      } catch (error) {
        this.log('warn', 'wecom subscribe frame could not be sent')
        socket.close(4001, 'Subscribe failed')
        if (this.startWaiter !== undefined) {
          const wrapped = this.asError(error, 'wecom subscribe frame could not be sent', 'transport')
          const waiter = this.startWaiter
          this.startWaiter = undefined
          this.started = false
          waiter.reject(wrapped)
        }
      }
    })
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.handleRawMessage(socket, event.data)
    })
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.log('warn', 'wecom websocket transport error')
    })
    socket.addEventListener('close', (event) => {
      this.handleClose(socket, event.code)
    })
  }

  private handleRawMessage(socket: WebSocket, data: unknown): void {
    // WeCom sends JSON text frames (SDK ws.py:144-151); binary is not a message
    // protocol this adapter understands and is deliberately ignored.
    if (typeof data !== 'string') return
    let frame: WeComFrame
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      frame = parsed as WeComFrame
    } catch {
      this.log('debug', 'wecom ignored a malformed JSON websocket frame')
      return
    }
    const reqId = frame.headers?.req_id ?? ''
    if (frame.cmd === 'aibot_msg_callback' || frame.cmd === 'aibot_event_callback') {
      if (frame.cmd === 'aibot_event_callback' && this.isDisconnectedEvent(frame)) {
        // SDK ws.py:203-230: a replacement connection is a terminal condition;
        // reconnecting would just be disconnected again.
        const error = new WeComError('closed', 'wecom connection was replaced by a newer connection')
        this.fail(error)
        return
      }
      this.options.onMessage(frame)
      return
    }
    if (frame.cmd !== undefined) return

    // Authentication and heartbeat responses have no cmd and are classified by
    // req_id prefix before reply acknowledgements (SDK ws.py:236-280).
    if (reqId.startsWith('aibot_subscribe')) {
      if (frame.errcode !== 0) {
        this.fail(new WeComError(
          'auth',
          `wecom authentication failed${frame.errcode === undefined ? '' : ` (code ${frame.errcode})`}`,
          frame.errcode,
        ))
        return
      }
      this.authenticated = true
      this.reconnectAttempt = 0
      this.startHeartbeat()
      const waiter = this.startWaiter
      this.startWaiter = undefined
      waiter?.resolve()
      this.log('info', 'wecom websocket authenticated')
      return
    }
    if (reqId.startsWith('ping')) {
      if (frame.errcode === 0) this.missedPongs = 0
      return
    }
    const pending = this.pendingAcks.get(reqId)
    if (pending === undefined) return
    this.pendingAcks.delete(reqId)
    clearTimeout(pending.timer)
    if (frame.errcode === 0) pending.resolve()
    else pending.reject(new WeComError('api', `wecom reply was rejected (code ${String(frame.errcode)})`, frame.errcode))
  }

  private isDisconnectedEvent(frame: WeComFrame): boolean {
    const event = frame.body?.['event']
    return typeof event === 'object' && event !== null && !Array.isArray(event)
      && (event as Record<string, unknown>)['eventtype'] === 'disconnected_event'
  }

  private handleClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.authenticated = false
    this.stopHeartbeat()
    this.rejectPending(new WeComError('closed', 'wecom websocket closed before reply acknowledgement'))
    this.options.onDisconnect?.()
    if (!this.started) return
    if (this.startWaiter !== undefined) {
      const waiter = this.startWaiter
      this.startWaiter = undefined
      this.started = false
      waiter.reject(new WeComError('transport', `wecom websocket closed before authentication (code ${code})`))
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return
    // The reference implementation selects infinite reconnects (wecom.py:124-130); SDK doubles 1s →
    // 2s → 4s … and caps the delay at 30s (ws.py:365-396).
    const delay = Math.min(
      WECOM_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      WECOM_RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectAttempt += 1
    this.log('warn', `wecom websocket disconnected; reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.started) return
      try {
        this.openConnection()
      } catch (error) {
        this.log('warn', 'wecom reconnect could not create a websocket')
        this.scheduleReconnect()
      }
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // Heartbeats start only after authentication (SDK ws.py:254-260,282-301).
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), WECOM_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private sendHeartbeat(): void {
    const socket = this.socket
    if (!this.started || !this.authenticated || socket === undefined) return
    if (this.missedPongs >= 2) {
      // Two unanswered application pings mark the connection dead (SDK
      // ws.py:304-325); close triggers the ordinary reconnect path.
      this.stopHeartbeat()
      socket.close(4000, 'Heartbeat timeout')
      return
    }
    this.missedPongs += 1
    try {
      this.sendFrame(socket, {
        cmd: 'ping',
        headers: { req_id: generateWeComReqId('ping') },
      })
    } catch {
      this.log('warn', 'wecom heartbeat could not be sent')
      socket.close(4001, 'Heartbeat failed')
    }
  }

  private enqueue(reqId: string, frame: WeComFrame): Promise<void> {
    const previous = this.replyQueues.get(reqId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(() => this.roundTrip(reqId, frame))
    const tail = result.then(() => undefined, () => undefined)
    this.replyQueues.set(reqId, tail)
    void tail.then(() => {
      if (this.replyQueues.get(reqId) === tail) this.replyQueues.delete(reqId)
    })
    return result
  }

  private roundTrip(reqId: string, frame: WeComFrame): Promise<void> {
    const socket = this.socket
    if (!this.started || !this.authenticated || socket === undefined) {
      return Promise.reject(new WeComError('transport', 'wecom websocket is not authenticated'))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingAcks.get(reqId)
        if (pending === undefined) return
        this.pendingAcks.delete(reqId)
        pending.reject(new WeComError('transport', 'wecom reply acknowledgement timed out'))
      }, WECOM_REPLY_ACK_TIMEOUT_MS)
      timer.unref?.()
      this.pendingAcks.set(reqId, { resolve, reject, timer })
      try {
        this.sendFrame(socket, frame)
      } catch {
        const pending = this.pendingAcks.get(reqId)
        this.pendingAcks.delete(reqId)
        if (pending !== undefined) clearTimeout(pending.timer)
        reject(new WeComError('transport', 'wecom reply frame could not be sent'))
      }
    })
  }

  private sendFrame(socket: WebSocket, frame: WeComFrame): void {
    if (socket.readyState !== WebSocket.OPEN) throw new WeComError('transport', 'wecom websocket is not open')
    socket.send(JSON.stringify(frame))
  }

  private rejectPending(error: WeComError): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingAcks.clear()
  }

  private fail(error: WeComError): void {
    this.started = false
    this.authenticated = false
    this.stopHeartbeat()
    this.cancelReconnect()
    const waiter = this.startWaiter
    this.startWaiter = undefined
    waiter?.reject(error)
    this.rejectPending(error)
    this.options.onFailure?.(error)
    const socket = this.socket
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.close(4001, 'Connection stopped')
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private asError(error: unknown, message: string, code: WeComErrorCode): WeComError {
    if (error instanceof WeComError) return error
    // Do not append the original value: DOMException/fetch errors can include
    // the URL, and a private-deployment URL is operator-supplied input.
    return new WeComError(code, message)
  }
}
