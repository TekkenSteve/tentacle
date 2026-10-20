/**
 * Yuanbao scan-to-bind provisioning flow (design 08 §4).
 *
 * Wire contract is transcribed from
 * reference implementation: yuanbao_bot_creator.py:
 * GET get-scan-bind-code (187-221), POST check-scan-bind-status (239-315),
 * and the source/bot_type/query constants (59-73, 191-196).
 *
 * Expiry is returned directly as `expired` rather than silently replacing the
 * QR.  The reference retries the whole blocking loop up to three times, but
 * this host has a frontend-driven session/projection model: a new QR in the
 * middle of `poll` would need a new visible session and would make the status
 * contract surprising.  Terminal status 4 therefore has one clear meaning.
 */
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

const DEFAULT_API_BASE_URL = 'https://bot.yuanbao.tencent.com'
const DEFAULT_EXPIRES_IN_SECONDS = 900
const POLL_AFTER_MS = 2000

export interface YuanbaoProvisionOptions {
  /** Explicit replacement for the reference implementation's cloud metadata auto-detection. */
  readonly instanceId?: string
  /** Explicit replacement for the reference implementation's cloud metadata auto-detection. */
  readonly ip?: string
  /** HTTP origin override for a fake/self-hosted endpoint. */
  readonly apiBaseUrl?: string
  /** Test seam; production uses Node 24's built-in fetch. */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

interface YuanbaoQrState {
  scanCode: string
  accessCode: string
  scanUrl?: string
  apiDomain?: string
  stopped: boolean
}

interface ApiResult {
  readonly payload: Record<string, unknown>
  readonly status: number
}

export class YuanbaoProvisionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'YuanbaoProvisionError'
  }
}

export class YuanbaoProvisionFlow implements ProvisionFlow {
  // The central integration adds 'yuanbao' to ChannelType; this keeps the new
  // flow compilable before that shared one-line edit is applied.
  readonly channelType = 'yuanbao' as unknown as ProvisionFlow['channelType']
  private readonly instanceId: string
  private readonly ip: string
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(options: YuanbaoProvisionOptions = {}) {
    this.instanceId = options.instanceId ?? ''
    this.ip = options.ip ?? ''
    this.apiBaseUrl = normalizeBase(options.apiBaseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    const query = new URLSearchParams()
    // Keep all four parameters, including empty instance_id/ip: the reference
    // passes empty strings when metadata is unavailable (bot_creator.py:191-196).
    query.set('instance_id', this.instanceId)
    query.set('ip', this.ip)
    query.set('source', 'tx_cloud_lighthouse')
    query.set('bot_type', '1')
    const result = await this.request(`/api/v5/robotLogic/get-scan-bind-code?${query.toString()}`, {
      method: 'GET',
      headers: apiHeaders(),
    })
    const data = successData(result, 'get-scan-bind-code')
    const scanCode = requiredString(data, 'scan_code')
    const accessCode = requiredString(data, 'access_code')
    const scanUrl = optionalString(data, 'scan_url')
    const expiresIn = optionalNumber(data['expires_in']) ?? DEFAULT_EXPIRES_IN_SECONDS
    const apiDomain = optionalString(data, 'api_domain')
    const state: YuanbaoQrState = {
      scanCode,
      accessCode,
      ...(scanUrl === undefined ? {} : { scanUrl }),
      ...(apiDomain === undefined ? {} : { apiDomain }),
      stopped: false,
    }
    session.data = state
    return {
      ...(scanUrl === undefined ? {} : { qrUrl: scanUrl }),
      expiresAt: this.now() + expiresIn * 1000,
      pollAfterMs: POLL_AFTER_MS,
    }
  }

  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = session.data as YuanbaoQrState | undefined
    if (state === undefined || typeof state.scanCode !== 'string' || typeof state.accessCode !== 'string') {
      throw new YuanbaoProvisionError('yuanbao provisioning session is not initialized')
    }
    if (state.stopped) return { state: 'failed', error: 'yuanbao scan binding was cancelled' }

    let result: ApiResult
    try {
      result = await this.request('/api/v5/robotLogic/check-scan-bind-status', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ scan_code: state.scanCode, access_code: state.accessCode }),
      })
    } catch {
      // The reference retries transport/poll-envelope failures until the QR's
      // own deadline.  Keep the host projection non-terminal for the same case.
      return waiting(state)
    }

    let data: Record<string, unknown>
    try {
      data = successData(result, 'check-scan-bind-status')
    } catch {
      return waiting(state)
    }
    const status = optionalNumber(data['status']) ?? 0
    switch (status) {
      case 0:
        return waiting(state)
      case 1:
        return {
          state: 'waiting',
          ...(state.scanUrl === undefined ? {} : { qrUrl: state.scanUrl }),
          message: '已扫码，请在手机上确认',
        }
      case 2: {
        try {
          const appKey = requiredString(data, 'app_key')
          const appSecret = requiredString(data, 'app_secret')
          return {
            state: 'success',
            credentials: { appKey, appSecret },
            // Only an api_domain actually returned by the scan API is copied.
            // In particular, a local test apiBaseUrl is not silently persisted.
            ...(state.apiDomain === undefined ? {} : { config: { apiDomain: state.apiDomain } }),
          }
        } catch {
          // A terminal status without its credential pair is a failed bind,
          // not a reason to throw out of the host's polling state machine.
          return { state: 'failed', error: 'yuanbao scan binding succeeded without app credentials' }
        }
      }
      case 3:
        return { state: 'failed', error: 'yuanbao scan binding was cancelled' }
      case 4:
        return { state: 'expired' }
      default:
        return { state: 'failed', error: `yuanbao scan binding returned unknown status ${status}` }
    }
  }

  async stop(session: ProvisionSession): Promise<void> {
    const state = session.data as YuanbaoQrState | undefined
    if (state !== undefined) state.stopped = true
  }

  private async request(path: string, init: RequestInit): Promise<ApiResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, init)
    } catch {
      throw new YuanbaoProvisionError('yuanbao provisioning transport failed')
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      throw new YuanbaoProvisionError('yuanbao provisioning response could not be read', response.status)
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new YuanbaoProvisionError(`yuanbao provisioning returned non-JSON (HTTP ${response.status})`, response.status)
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new YuanbaoProvisionError('yuanbao provisioning returned a malformed envelope', response.status)
    }
    return { payload: payload as Record<string, unknown>, status: response.status }
  }
}

function apiHeaders(): Record<string, string> {
  // bot_creator.py:68-73 — retained verbatim, including X-Source.
  return {
    'user-agent': 'RobotManager/1.0',
    'content-type': 'application/json',
    accept: 'application/json',
    'x-source': 'robot_manager',
  }
}

function successData(result: ApiResult, operation: string): Record<string, unknown> {
  const code = result.payload['code']
  if (code !== 0) throw new YuanbaoProvisionError(`yuanbao ${operation} failed (code ${String(code)})`, result.status)
  const data = result.payload['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new YuanbaoProvisionError(`yuanbao ${operation} response missing data`, result.status)
  }
  return data as Record<string, unknown>
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value === '') throw new YuanbaoProvisionError(`yuanbao provisioning response missing ${key}`)
  return value
}

function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function waiting(state: YuanbaoQrState): ProvisionPoll {
  return {
    state: 'waiting',
    ...(state.scanUrl === undefined ? {} : { qrUrl: state.scanUrl }),
  }
}

function normalizeBase(value: string | undefined): string {
  let base = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`
  return base
}
