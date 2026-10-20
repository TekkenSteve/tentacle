/**
 * Discord REST client, on built-in fetch: `Authorization: Bot <token>` on every
 * request, no OAuth exchange (the bot token is already the credential).
 *
 * Endpoints used: `GET /gateway/bot` (WS URL), `GET /users/@me` (identity
 * fallback), `POST /channels/{id}/messages` (outbound). Everything is overridable
 * via `apiBaseUrl` so loopback protocol fakes can stand in for the platform.
 */
import { DiscordError } from './discord-error.js'

export interface DiscordApiOptions {
  readonly token: string
  readonly apiBaseUrl?: string
  readonly fetchImpl?: typeof fetch
}

export interface DiscordUser {
  readonly id: string
  readonly username?: string
  readonly bot?: boolean
}

export interface DiscordApi {
  getGatewayUrl(): Promise<string>
  getMe(): Promise<DiscordUser>
  sendMessage(channelId: string, content: string): Promise<void>
}

export const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

interface HttpReply {
  readonly status: number
  readonly text: string
}

export function createDiscordApi(options: DiscordApiOptions): DiscordApi {
  const base = (options.apiBaseUrl ?? DEFAULT_DISCORD_API_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  async function request(url: string, init: RequestInit, operation: string): Promise<HttpReply> {
    let response: Response
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bot ${options.token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      })
    } catch (error) {
      throw new DiscordError('transport', `discord ${operation} transport failed: ${(error as Error).message}`)
    }
    return { status: response.status, text: await response.text() }
  }

  function parseObject(text: string, operation: string, status: number): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new DiscordError('invalid-response', `discord ${operation} returned non-JSON body (HTTP ${status})`, status)
    }
  }

  return {
    async getGatewayUrl() {
      const reply = await request(`${base}/gateway/bot`, { method: 'GET' }, 'gateway')
      if (reply.status !== 200) {
        throw new DiscordError(reply.status === 401 ? 'auth' : 'api', `discord gateway request failed (HTTP ${reply.status})`, reply.status)
      }
      const payload = parseObject(reply.text, 'gateway', reply.status)
      const url = payload['url']
      if (typeof url !== 'string' || url === '') {
        throw new DiscordError('invalid-response', 'discord gateway response carried no url', reply.status)
      }
      return url
    },

    async getMe() {
      const reply = await request(`${base}/users/@me`, { method: 'GET' }, 'bot identity')
      if (reply.status !== 200) {
        throw new DiscordError(reply.status === 401 ? 'auth' : 'api', `discord bot identity failed (HTTP ${reply.status})`, reply.status)
      }
      const payload = parseObject(reply.text, 'bot identity', reply.status)
      if (typeof payload['id'] !== 'string' || payload['id'] === '') {
        throw new DiscordError('invalid-response', 'discord bot identity carried no id', reply.status)
      }
      return {
        id: payload['id'] as string,
        ...(typeof payload['username'] === 'string' ? { username: payload['username'] as string } : {}),
        ...(payload['bot'] === true ? { bot: true } : {}),
      }
    },

    async sendMessage(channelId, content) {
      if (channelId.trim() === '') throw new DiscordError('config', 'discord send target channel id is empty')
      const reply = await request(`${base}/channels/${encodeURIComponent(channelId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      }, 'send message')
      // Discord answers 200 or 201 for created messages; a second 401 is not retried.
      if (reply.status !== 200 && reply.status !== 201) {
        throw new DiscordError(reply.status === 401 ? 'auth' : 'api', `discord send message failed (HTTP ${reply.status})`, reply.status)
      }
    },
  }
}
