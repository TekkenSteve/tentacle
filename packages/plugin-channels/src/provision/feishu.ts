/**
 * Feishu scan-to-create quick setup (design 08 §4), built on the OFFICIAL
 * `@larksuiteoapi/node-sdk` `registerApp` (OAuth 2.0 Device Authorization
 * Grant, RFC 8628) — the protocol and its edge cases (slow_down, Lark domain
 * switch, abort semantics) belong to the vendor, not to a hand copy.
 *
 * The SDK call runs in the BACKGROUND: `start` awaits only the QR-ready
 * callback, the console's own poll loop reads what the callbacks captured.
 * The `AbortSignal` is the SDK's supported cancellation path and is used by
 * `stop` — no timers or sockets are left behind when the wizard closes.
 */
import { registerApp } from '@larksuiteoapi/node-sdk'
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../provision.js'

/** Everything the flow remembers between the console's polls (host memory only). */
interface FeishuQrState {
  readonly abort: AbortController
  qr: { url: string; expireIn: number } | undefined
  qrReady: Promise<void>
  status: string | undefined
  result: { client_id: string; client_secret: string } | undefined
  error: { code: string; description: string } | undefined
}

export interface FeishuProvisionOptions {
  /** Source marker embedded in the QR URL (vendor's `sdk/{source}` convention). */
  readonly source?: string
  /** Overrides for tests/self-hosted deployments (host only, HTTPS by the SDK). */
  readonly domain?: string
  readonly larkDomain?: string
}

export class FeishuProvisionFlow implements ProvisionFlow {
  readonly channelType = 'feishu' as const

  constructor(private readonly options: FeishuProvisionOptions = {}) {}

  async start(session: ProvisionSession): Promise<ProvisionStart> {
    const abort = new AbortController()
    let signalQr!: () => void
    const state: FeishuQrState = {
      abort,
      qr: undefined,
      qrReady: new Promise<void>((resolve) => { signalQr = resolve }),
      status: undefined,
      result: undefined,
      error: undefined,
    }
    session.data = state

    void registerApp({
      ...(this.options.domain === undefined ? {} : { domain: this.options.domain }),
      ...(this.options.larkDomain === undefined ? {} : { larkDomain: this.options.larkDomain }),
      source: this.options.source ?? 'tentacle',
      signal: abort.signal,
      // Only create new apps: the confirm page must never offer "pick an
      // existing app" (a scan would then overwrite that app's config).
      createOnly: true,
      onQRCodeReady(info) {
        state.qr = { url: info.url, expireIn: info.expireIn }
        signalQr()
      },
      onStatusChange(info) {
        state.status = info.status
      },
    }).then((result) => {
      state.result = result
    }, (error: unknown) => {
      const shape = error as { code?: string; description?: string; message?: string }
      state.error = {
        code: shape.code ?? 'unknown',
        description: shape.description ?? shape.message ?? String(error),
      }
    })

    // The QR arrives after the SDK's first round trip; the start response is
    // the QR itself, so await exactly that (not the whole flow).
    await state.qrReady
    const qr = state.qr!
    return {
      qrUrl: qr.url,
      expiresAt: Date.now() + qr.expireIn * 1000,
      pollAfterMs: 2000,
    }
  }

  async poll(session: ProvisionSession): Promise<ProvisionPoll> {
    const state = session.data as FeishuQrState
    if (state.result !== undefined) {
      return {
        state: 'success',
        credentials: { appId: state.result.client_id, appSecret: state.result.client_secret },
      }
    }
    if (state.error !== undefined) {
      return state.error.code === 'expired_token'
        ? { state: 'expired' }
        : { state: 'failed', error: state.error.description }
    }
    return {
      state: 'waiting',
      ...(state.qr === undefined ? {} : { qrUrl: state.qr.url }),
      ...(state.status === undefined ? {} : { message: state.status }),
    }
  }

  async stop(session: ProvisionSession): Promise<void> {
    const state = session.data as FeishuQrState
    state.abort.abort()
  }
}
