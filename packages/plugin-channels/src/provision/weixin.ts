/**
 * WeChat personal-account (iLink Bot) scan-to-create flow (design 08 §4).
 *
 * Protocol source: channels/weixin/login_qr.py
 * - :23-29,117-143 — GET get_bot_qrcode?bot_type=3 with client-version 1;
 * - :173-219 — GET get_qrcode_status?qrcode=... The platform HOLDS each
 *   request for up to 35s and delivers each state transition (scaned /
 *   confirmed / expired) as the response to the request in flight at that
 *   moment. Transitions are one-shot: an abandoned request loses its event
 *   forever. The reference implementation therefore never aborts a status request early — its httpx
 *   client timeout is the long-poll ceiling plus headroom (35s + 5s) and the
 *   loop runs server-side, decoupled from the dashboard's 3s UI poll.
 * - :180-187 — transient failures retry after a 1s pause, never terminal;
 * - :69-73 — ilink_bot_id normalization ('@' and '.' become '-').
 *
 * This port keeps that two-layer split: `start()` launches ONE background
 * follower loop owned by the host session (sequential long polls; only
 * stop()/expiry cancels them), and `poll()` is a projection that returns the
 * loop's latest recorded outcome instantly — the admin route never waits on,
 * and never aborts, a platform long poll. Collapsing the two layers was the
 * original bug: truncating each status request at the console cadence (2s)
 * discarded the one-time confirmed event, leaving the wizard stuck on the QR
 * screen while WeChat had already issued the bot_token.
 *
 * qrcode is an opaque POLLING TOKEN and remains in session.data. Only the
 * platform's directly renderable qrcode_img_content is returned as qrUrl.
 * Confirmed bot_token crosses the flow boundary only in ProvisionPoll.credentials.
 */
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

const DEFAULT_QR_BASE_URL = 'https://ilinkai.weixin.qq.com'
const QR_TTL_MS = 8 * 60_000
const QR_START_TIMEOUT_MS = 15_000
const PLATFORM_LONG_POLL_MS = 35_000
const LONG_POLL_HEADROOM_MS = 5_000
const RETRY_AFTER_MS = 1_000
const DEFAULT_CLIENT_POLL_MS = 2_000
const SCANNED_MESSAGE = 'QR code scanned; confirm login in WeChat.'

interface WeixinQrState {
  readonly abort: AbortController
  /** Empty until the platform answers start(); poll() treats that as uninitialized. */
  qrcode: string
  qrUrl: string
  /** Latest outcome recorded by the follower loop; never carries the token. */
  latest: ProvisionPoll
  /** Resolves when the loop reaches a terminal outcome or is cancelled. */
  settled: Promise<void>
}

export interface WeixinProvisionOptions {
  /**
   * Trusted deployment/test override, never read from the console or session.
   * Production defaults to the fixed iLink host; HTTPS is required except for
   * loopback fakes. This is the SSRF boundary corresponding to login_qr.py:99-113.
   */
  readonly baseUrl?: string
  /** Suggested management-plane cadence (default 2s, design 08 §1). */
  readonly pollAfterMs?: number
  /**
   * Provider-side ceiling for ONE follower long-poll request. Default: the
   * platform hold ceiling plus headroom (35s + 5s, mirroring login_qr.py:173).
   * This must stay independent of `pollAfterMs`: the platform delivers its
   * one-shot state transitions through the held response, so a request cut
   * short at the console cadence loses its event forever.
   */
  readonly pollTimeoutMs?: number
  readonly startTimeoutMs?: number
  readonly now?: () => number
  /** Test seam; production uses Node 24's built-in fetch. */
  readonly fetch?: typeof fetch
}

export class WeixinProvisionFlow implements ProvisionFlow {
  readonly channelType: ProvisionFlow['channelType'] = 'weixin' as ProvisionFlow['channelType']

  private readonly baseUrl: string
  private readonly pollAfterMs: number
  private readonly pollTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  constructor(options: WeixinProvisionOptions = {}) {
    this.baseUrl = validateQrBaseUrl(options.baseUrl ?? DEFAULT_QR_BASE_URL)
    this.pollAfterMs = options.pollAfterMs ?? DEFAULT_CLIENT_POLL_MS
    this.pollTimeoutMs = options.pollTimeoutMs ?? PLATFORM_LONG_POLL_MS + LONG_POLL_HEADROOM_MS
    this.startTimeoutMs = options.startTimeoutMs ?? QR_START_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch ?? fetch
  }

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    // A restart of the wizard must not leave a previous follower running.
    const prior = session.data as WeixinQrState | undefined
    prior?.abort.abort()
    const abort = new AbortController()
    // Install cancellation before the first network await; qrcode is filled in
    // only after the platform answers, so no partial token can escape.
    const state: WeixinQrState = {
      abort,
      qrcode: '',
      qrUrl: '',
      latest: { state: 'waiting' },
      settled: Promise.resolve(),
    }
    session.data = state
    const url = new URL(`${this.baseUrl}/ilink/bot/get_bot_qrcode`)
    url.searchParams.set('bot_type', '3')
    try {
      const outcome = await requestWithTimeout(this.fetchImpl, url, abort.signal, this.startTimeoutMs)
      if (outcome.kind === 'timeout') throw new Error('weixin QR generation timed out')
      if (outcome.kind === 'error') throw outcome.error
      const qrcode = requiredString(outcome.payload, 'qrcode')
      const qrUrl = requiredString(outcome.payload, 'qrcode_img_content')
      state.qrcode = qrcode
      state.qrUrl = qrUrl
      state.latest = { state: 'waiting', qrUrl }
      // login_qr.py:28-29 defines an eight-minute overall login window; the
      // QR response itself carries no expiry timestamp.
      const deadline = this.now() + QR_TTL_MS
      const following = this.follow(state, deadline)
      following.catch(() => undefined)
      state.settled = following
      return {
        qrUrl,
        pollAfterMs: this.pollAfterMs,
        expiresAt: deadline,
      }
    } catch (error) {
      abort.abort()
      session.data = undefined
      throw error
    }
  }

  /**
   * Instant projection of the follower loop's latest outcome. Deliberately
   * network-free: the admin route answers at once and never cancels a held
   * platform request (the event-loss bug this flow once had).
   */
  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = session.data as WeixinQrState | undefined
    if (state === undefined || state.qrcode === '') {
      return { state: 'failed', error: 'weixin provisioning session is not initialized' }
    }
    return state.latest
  }

  async stop(session: ProvisionSession): Promise<void> {
    const state = session.data as WeixinQrState | undefined
    state?.abort.abort()
    // Drop the opaque polling token eagerly rather than waiting for GC.
    session.data = undefined
  }

  /**
   * The reference implementation's wait_for_login equivalent: sequential long polls that only the
   * session's abort or the overall deadline can end. Writes every observed
   * transition onto `state.latest` and never throws — every failure mode maps
   * to a recorded outcome.
   */
  private async follow(state: WeixinQrState, deadline: number): Promise<void> {
    const { abort, qrcode, qrUrl } = state
    let scanned = false
    // scaned_but_redirect moves subsequent status polls to the platform's IDC
    // host (official protocol doc: "switch polling to https://<redirect_host>").
    let statusBase = this.baseUrl
    const waiting = (): ProvisionPoll => ({
      state: 'waiting',
      qrUrl,
      ...(scanned ? { message: SCANNED_MESSAGE } : {}),
    })
    try {
      while (!abort.signal.aborted && this.now() < deadline) {
        const url = new URL(`${statusBase}/ilink/bot/get_qrcode_status`)
        url.searchParams.set('qrcode', qrcode)
        const outcome = await requestWithTimeout(this.fetchImpl, url, abort.signal, this.pollTimeoutMs)
        if (abort.signal.aborted) return
        if (outcome.kind === 'timeout' || outcome.kind === 'error') {
          // login_qr.py:180-187 retries transport/HTTP/JSON failures after a
          // 1s pause; transient failures are never terminal.
          await sleepUnlessAborted(RETRY_AFTER_MS, abort.signal)
          continue
        }

        const status = outcome.payload['status']
        if (status === 'scaned') {
          // The misspelling is the actual wire value (login_qr.py:196).
          scanned = true
          state.latest = waiting()
          continue
        }
        if (status === 'scaned_but_redirect') {
          try {
            statusBase = resolveRedirectHost(outcome.payload['redirect_host'])
          } catch (error) {
            state.latest = { state: 'failed', error: describeError(error) }
            return
          }
          continue
        }
        if (status === 'need_verifycode') {
          // The WeChat side requires a pair code; the console has no input for
          // it yet, so fail honestly instead of silently waiting forever.
          state.latest = {
            state: 'failed',
            error: 'weixin requires a WeChat verification code for this account — regenerate the QR and try again',
          }
          return
        }
        if (status === 'verify_code_blocked') {
          state.latest = { state: 'failed', error: 'too many wrong verification codes — regenerate the QR and try again' }
          return
        }
        if (status === 'binded_redirect') {
          state.latest = {
            state: 'failed',
            error: 'this WeChat account is already bound to another session — repair that instance instead of scanning a new bot',
          }
          return
        }
        if (status === 'confirmed') {
          try {
            const token = requiredString(outcome.payload, 'bot_token')
            const ilinkBotId = requiredString(outcome.payload, 'ilink_bot_id')
            const baseUrl = requiredString(outcome.payload, 'baseurl')
            state.latest = {
              state: 'success',
              credentials: {
                accountId: ilinkBotId.replaceAll('@', '-').replaceAll('.', '-'),
                token,
              },
              config: { baseUrl },
            }
          } catch (error) {
            state.latest = {
              state: 'failed',
              error: error instanceof Error ? error.message : 'invalid confirmed response',
            }
          }
          return
        }
        if (status === 'expired') {
          state.latest = { state: 'expired' }
          return
        }
        // 'wait' and unknown statuses are non-terminal (login_qr.py:193-194,
        // :235-236): re-poll immediately — the server's own hold paces us.
        state.latest = waiting()
      }
      // Overall login window exhausted without confirmation
      // (login_qr.py:238-241 maps this to a not-connected result).
      if (!abort.signal.aborted) state.latest = { state: 'expired' }
    } catch {
      // Defensive only: every branch above maps its own failure. A follower
      // crash must surface as a terminal failure, never a silent hang.
      if (!abort.signal.aborted) {
        state.latest = { state: 'failed', error: 'weixin QR follower crashed' }
      }
    }
  }
}

/**
 * Resolve the IDC redirect host from `scaned_but_redirect`. The wire value is a
 * bare host (`idc.weixin.qq.com`); tests may pass a full loopback URL. Only
 * https://*.<weixin.qq.com> (or a loopback fake) is accepted — this is the
 * SSRF boundary for the one platform-controlled hop in the flow.
 */
function resolveRedirectHost(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('weixin redirect status without redirect_host')
  }
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error('weixin redirect_host is not a valid host')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  const trusted = url.protocol === 'https:'
    && (url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))
  if (!trusted && !(url.protocol === 'http:' && loopback)) {
    throw new Error('weixin redirect_host is not a trusted WeChat host')
  }
  return url.origin
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'weixin QR redirect failed'
}

type RequestOutcome =
  | { readonly kind: 'ok'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly error: Error }

/**
 * Race the whole fetch+body operation against a provider deadline. The race is
 * intentional even though fetch receives an AbortSignal: it guarantees that a
 * custom fetch implementation cannot leave the follower awaiting forever.
 */
async function requestWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RequestOutcome> {
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = fetchJson(fetchImpl, url, controller.signal).then(
    (payload): RequestOutcome => ({ kind: 'ok', payload }),
    (error: unknown): RequestOutcome => ({
      kind: 'error',
      error: error instanceof Error ? error : new Error('weixin QR request failed'),
    }),
  )
  const timeout = new Promise<RequestOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('weixin QR request timed out'))
      resolve({ kind: 'timeout' })
    }, Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: URL, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      // login_qr.py:126-130,175-179 — QR endpoints use version 1, not the
      // messaging client's numeric 2.2.0 version.
      headers: { 'iLink-App-ClientVersion': '1' },
      signal,
    })
  } catch (error) {
    throw new Error(`weixin QR transport failed (${error instanceof Error ? error.name : 'UnknownError'})`)
  }
  const text = await response.text()
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`weixin QR request failed with HTTP ${response.status}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('weixin QR endpoint returned non-JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('weixin QR endpoint returned a non-object')
  }
  return payload as Record<string, unknown>
}

/** Sleep that a stop() can cut short; never rejects. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '') throw new Error(`weixin QR response missing ${key}`)
  return value
}

function validateQrBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('weixin QR baseUrl must be an absolute URL')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '') {
    throw new Error('weixin QR baseUrl must use HTTPS (HTTP is allowed only on loopback)')
  }
  return value.replace(/\/+$/, '')
}
