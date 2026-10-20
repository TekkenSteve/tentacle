/**
 * A fake Telegram Bot API server: the adapter's only external dependency is
 * `apiBaseUrl`, so pointing it at loopback HTTP is the whole integration test
 * (design 06 §7). It records every call verbatim — that recording is what the
 * assertions inspect: cursor progression, send chunking, Markdown fallback.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface BotApiCall {
  readonly method: string
  readonly body: Record<string, unknown>
}

export interface FakeBotApiOptions {
  /** getMe answer. Defaults to a bot named `tentacle_test_bot`. */
  readonly me?: { readonly id: number; readonly username: string; readonly is_bot: boolean }
  /** `sendMessage` / `sendChatAction` always succeed unless this is set. */
  readonly sendMessageError?: { readonly error_code: number; readonly description: string; readonly onlyWhenParseMode?: boolean }
  /**
   * How long an empty `getUpdates` is held open before answering, in ms.
   * Keeps the poll loop from spinning while the test drives the batches.
   */
  readonly idleHoldMs?: number
}

export class FakeBotApi {
  private readonly server: Server
  private readonly calls: BotApiCall[] = []
  private readonly batches: Array<readonly Record<string, unknown>[]> = []
  private readonly waiters: Array<() => void> = []

  constructor(private readonly options: FakeBotApiOptions = {}) {
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

  baseUrl = ''

  async close(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) waiter()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Queue one `getUpdates` result batch. */
  push(...updates: Record<string, unknown>[]): void {
    this.batches.push(updates)
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  recorded(): readonly BotApiCall[] {
    return this.calls
  }

  callsTo(method: string): readonly BotApiCall[] {
    return this.calls.filter((call) => call.method === method)
  }

  /** Resolve once a call of this method with a matching body arrives. */
  waitForCall(method: string, predicate: (body: Record<string, unknown>) => boolean = () => true, timeoutMs = 8000): Promise<BotApiCall> {
    return new Promise((resolve, reject) => {
      const found = this.calls.find((call) => call.method === method && predicate(call.body))
      if (found !== undefined) {
        resolve(found)
        return
      }
      const started = Date.now()
      const poll = setInterval(() => {
        const hit = this.calls.find((call) => call.method === method && predicate(call.body))
        if (hit !== undefined) {
          clearInterval(poll)
          resolve(hit)
          return
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(poll)
          reject(new Error(`timed out waiting for ${method}; recorded: ${JSON.stringify(this.calls.map((c) => c.method))}`))
        }
      }, 5)
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    const method = (req.url ?? '/').split('/').pop() ?? ''
    this.calls.push({ method, body })
    const send = (payload: unknown): void => {
      const text = JSON.stringify(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    switch (method) {
      case 'getMe':
        send({ ok: true, result: this.options.me ?? { id: 42, is_bot: true, username: 'tentacle_test_bot' } })
        return
      case 'getUpdates':
        await this.answerUpdates(send)
        return
      case 'sendMessage': {
        const error = this.options.sendMessageError
        if (error !== undefined && (error.onlyWhenParseMode !== true || body.parse_mode !== undefined)) {
          send({ ok: false, error_code: error.error_code, description: error.description })
          return
        }
        send({ ok: true, result: { message_id: this.calls.length, chat: { id: body.chat_id }, text: body.text } })
        return
      }
      case 'sendChatAction':
        send({ ok: true, result: true })
        return
      default:
        send({ ok: false, error_code: 404, description: `unknown method ${method}` })
    }
  }

  /** Answer with the next queued batch, or hold the request open while idle. */
  private async answerUpdates(send: (payload: unknown) => void): Promise<void> {
    for (;;) {
      const batch = this.batches.shift()
      if (batch !== undefined) {
        send({ ok: true, result: batch })
        return
      }
      const hold = this.options.idleHoldMs ?? 30
      const released = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), hold)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!released) {
        send({ ok: true, result: [] })
        return
      }
    }
  }
}

/** A Telegram `message` update for a private chat. */
export function dmUpdate(updateId: number, text: string, userId = 7): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000,
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Ada', username: 'ada' },
      text,
    },
  }
}

/** A Telegram `message` update for a group, with the bot mentioned. */
export function groupUpdate(updateId: number, text: string, chatId = -100, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mention = `@tentacle_test_bot `
  const full = mention + text
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'supergroup', title: 'Ops' },
      from: { id: 7, is_bot: false, first_name: 'Ada', username: 'ada' },
      text: full,
      entities: [{ type: 'mention', offset: 0, length: mention.trimEnd().length }],
      ...extra,
    },
  }
}
