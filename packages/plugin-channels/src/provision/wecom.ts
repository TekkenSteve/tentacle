/**
 * WeCom scode scan-to-create provisioning (design 08 §4).
 *
 * Protocol source: reference implementation: qr_bind.py:14-56.
 * The scode is host-only session state. The browser receives auth_url as qrUrl;
 * only the terminal success projection carries botId/secret, directly to the
 * framework's credential writer.
 */

import type { ChannelType } from '../types.js'
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

const DEFAULT_API_BASE_URL = 'https://work.weixin.qq.com'
const GENERATE_TIMEOUT_MS = 15_000
const POLL_TIMEOUT_MS = 10_000
/** The reference implementation's WeCom CLI scan window is 180s (cli/commands/channel.py:310-325). */
export const WECOM_QR_TTL_MS = 180_000

interface WeComQrState {
  readonly scode: string
  readonly qrUrl: string
  readonly expiresAt: number
}

export interface WeComProvisionOptions {
  /** Test/private-deployment endpoint root; production uses work.weixin.qq.com. */
  readonly apiBaseUrl?: string
  readonly now?: () => number
}

/** The reference implementation's qr_bind.py:14-22 mapped to Node's process.platform spellings. */
export function weComPlatCode(platform: NodeJS.Platform = process.platform): 0 | 1 | 2 | 3 {
  switch (platform) {
    case 'darwin': return 1
    case 'win32': return 2
    case 'linux': return 3
    default: return 0
  }
}

export class WeComProvisionFlow implements ProvisionFlow {
  readonly channelType = 'wecom' as ChannelType
  private readonly baseUrl: string
  private readonly now: () => number

  constructor(options: WeComProvisionOptions = {}) {
    this.baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.now = options.now ?? Date.now
  }

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    const query = new URLSearchParams({ source: 'tentacle', plat: String(weComPlatCode()) })
    // qr_bind.py:25-36 — GET generate, then read data.scode/auth_url.
    const payload = await this.request(`/ai/qc/generate?${query.toString()}`, 'generate', GENERATE_TIMEOUT_MS)
    const data = recordOf(payload['data'])
    const scode = data['scode']
    const authUrl = data['auth_url']
    if (typeof scode !== 'string' || scode === '' || typeof authUrl !== 'string' || authUrl === '') {
      throw new Error('unexpected WeCom QR response')
    }
    const expiresAt = this.now() + WECOM_QR_TTL_MS
    session.data = { scode, qrUrl: authUrl, expiresAt } satisfies WeComQrState
    return { qrUrl: authUrl, expiresAt, pollAfterMs: 2000 }
  }

  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = session.data as WeComQrState | undefined
    if (state === undefined) throw new Error('wecom provisioning session was not started')
    if (state.expiresAt <= this.now()) {
      session.data = undefined
      return { state: 'expired' }
    }
    const query = new URLSearchParams({ scode: state.scode })
    // qr_bind.py:39-56 — scode stays in this host-to-platform request only.
    const payload = await this.request(`/ai/qc/query_result?${query.toString()}`, 'query result', POLL_TIMEOUT_MS)
    const data = recordOf(payload['data'])
    const status = typeof data['status'] === 'string' ? data['status'] : 'pending'

    if (status === 'success') {
      const botInfo = recordOf(data['bot_info'])
      const botId = botInfo['botid']
      const secret = botInfo['secret']
      session.data = undefined
      if (typeof botId !== 'string' || botId === '' || typeof secret !== 'string' || secret === '') {
        return { state: 'failed', error: 'QR scan succeeded but bot info is missing' }
      }
      // Exact terminal shape: no scode, auth_url, or platform response fields.
      return { state: 'success', credentials: { botId, secret } }
    }
    if (status === 'error') {
      const reason = data['reason']
      session.data = undefined
      return {
        state: 'failed',
        error: typeof reason === 'string' && reason !== '' ? reason : 'WeCom QR provisioning failed',
      }
    }
    if (status === 'expired' || status === 'timeout') {
      session.data = undefined
      return { state: 'expired' }
    }
    // Every other platform status is informational and passes through verbatim;
    // it is NOT collapsed into a hard-coded pending/scanned enum (qr_bind.py:56).
    return { state: 'waiting', qrUrl: state.qrUrl, message: status }
  }

  async stop(session: ProvisionSession): Promise<void> {
    // The scode protocol has no cancellation endpoint; dropping the only host
    // reference is the complete local cleanup.
    session.data = undefined
  }

  private async request(pathAndQuery: string, operation: string, timeoutMs: number): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${pathAndQuery}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // Never include the request URL or original error: query_result carries
      // the live scode, and native transport errors may echo that URL.
      throw new Error(`WeCom QR ${operation} request failed`)
    }
    if (!response.ok) throw new Error(`WeCom QR ${operation} returned HTTP ${response.status}`)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(`WeCom QR ${operation} returned non-JSON`)
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(`WeCom QR ${operation} returned an invalid envelope`)
    }
    return payload as Record<string, unknown>
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
