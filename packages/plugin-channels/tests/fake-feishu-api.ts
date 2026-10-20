/**
 * A fake feishu (Lark) open-platform server: the adapter's only platform
 * dependency is `apiBaseUrl`, so pointing it at loopback HTTP is the whole
 * integration test (mirroring `fake-bot-api.ts`). It records every call
 * verbatim — token fetches, sends, replies — which is what the assertions
 * inspect: token caching, envelope shape, reply-vs-send routing.
 *
 * The CALLBACK direction is not served here: the adapter's hook handler is a
 * pure request→reply function (see `FeishuAdapter.handleHook`), so tests
 * drive it in-process and only the platform client crosses HTTP.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FeishuRoute = 'token' | 'botInfo' | 'send' | 'reply'

export interface FeishuApiCall {
  readonly route: FeishuRoute
  /** Path with query string, exactly as requested. */
  readonly path: string
  readonly body: Record<string, unknown>
  /** The `authorization` header value, when sent. */
  readonly authorization?: string
}

export interface FakeFeishuApiOptions {
  /** bot/v3/info answer. Defaults to a bot named `tentacle-test-bot`. */
  readonly bot?: { readonly open_id: string; readonly app_name: string }
  /** Seconds the issued tenant token is valid for (default 3600). */
  readonly expireSeconds?: number
  /** When set, the token endpoint answers this business error. */
  readonly tokenError?: { readonly code: number; readonly msg: string }
  /** When set, send/reply answer this business error. */
  readonly sendError?: { readonly code: number; readonly msg: string }
}

export class FakeFeishuApi {
  private readonly server: Server
  private readonly calls: FeishuApiCall[] = []
  private tokensIssued = 0

  constructor(private readonly options: FakeFeishuApiOptions = {}) {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
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
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  recorded(): readonly FeishuApiCall[] {
    return this.calls
  }

  callsTo(route: FeishuRoute): readonly FeishuApiCall[] {
    return this.calls.filter((call) => call.route === route)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname
    const send = (payload: unknown, status = 200): void => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    const record = (route: FeishuRoute): void => {
      const authorization = req.headers['authorization']
      this.calls.push({
        route,
        path: `${path}${url.search}`,
        body,
        ...(authorization === undefined ? {} : { authorization }),
      })
    }

    if (req.method === 'POST' && path === '/open-apis/auth/v3/tenant_access_token/internal') {
      record('token')
      const error = this.options.tokenError
      if (error !== undefined) {
        send({ code: error.code, msg: error.msg })
        return
      }
      this.tokensIssued += 1
      send({ code: 0, msg: 'ok', tenant_access_token: `t-fake-${this.tokensIssued}`, expire: this.options.expireSeconds ?? 3600 })
      return
    }
    if (req.method === 'GET' && path === '/open-apis/bot/v3/info') {
      record('botInfo')
      // The real API answers the bot object at the top level (no `data` wrapper).
      send({ code: 0, msg: 'ok', bot: this.options.bot ?? { open_id: 'ou_bot', app_name: 'tentacle-test-bot' } })
      return
    }
    if (req.method === 'POST' && path === '/open-apis/im/v1/messages') {
      record('send')
      const error = this.options.sendError
      if (error !== undefined) {
        send({ code: error.code, msg: error.msg })
        return
      }
      send({ code: 0, msg: 'ok', data: { message_id: `om_${this.calls.length}` } })
      return
    }
    const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path)
    if (req.method === 'POST' && reply !== null) {
      record('reply')
      const error = this.options.sendError
      if (error !== undefined) {
        send({ code: error.code, msg: error.msg })
        return
      }
      send({ code: 0, msg: 'ok', data: { message_id: `om_reply_${this.calls.length}` } })
      return
    }
    send({ code: 404, msg: `unknown endpoint ${req.method ?? '?'} ${path}` }, 404)
  }
}

// ---- event builders -------------------------------------------------------

export interface FeishuEventInput {
  readonly eventId?: string
  readonly chatId?: string
  readonly chatType?: 'p2p' | 'group'
  readonly messageId?: string
  readonly messageType?: string
  readonly content?: Record<string, unknown>
  readonly threadId?: string
  readonly senderType?: string
  readonly openId?: string
  readonly mentions?: readonly { key: string; id: { open_id: string }; name?: string }[]
  readonly token?: string
}

/** A v2 `im.message.receive_v1` envelope, as the platform POSTs it. */
export function messageEvent(input: FeishuEventInput = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: input.eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
      ...(input.token === undefined ? {} : { token: input.token }),
      app_id: 'cli_fake',
      tenant_key: 'tenant_fake',
    },
    event: {
      sender: {
        sender_id: { open_id: input.openId ?? 'ou_user', user_id: 'u_user' },
        sender_type: input.senderType ?? 'user',
      },
      message: {
        message_id: input.messageId ?? 'om_msg',
        chat_id: input.chatId ?? 'oc_chat',
        chat_type: input.chatType ?? 'p2p',
        message_type: input.messageType ?? 'text',
        content: JSON.stringify(input.content ?? { text: 'hello' }),
        ...(input.threadId === undefined ? {} : { thread_id: input.threadId }),
        create_time: '1700000000000',
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      },
    },
  }
}
