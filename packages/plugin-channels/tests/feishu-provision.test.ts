/**
 * The feishu quick-setup flow against the OFFICIAL SDK's contract:
 * `registerApp` runs in the background, the QR arrives via `onQRCodeReady`,
 * terminal outcomes via resolution/rejection. The SDK itself is stubbed at
 * the module boundary; the flow's session state machine is what is tested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tenantId } from '@tentacle/identity'
import type { ProvisionSession } from '../src/provision.js'
import { FeishuProvisionFlow } from '../src/provision/feishu.js'

interface RegisterOptions {
  createOnly?: boolean
  source?: string
  signal?: AbortSignal
  onQRCodeReady(info: { url: string; expireIn: number }): void
  onStatusChange?(info: { status: string }): void
}

const registerApp = vi.hoisted(() => vi.fn())
vi.mock('@larksuiteoapi/node-sdk', () => ({ registerApp }))

let options: RegisterOptions | undefined
let settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void }

beforeEach(() => {
  options = undefined
  registerApp.mockReset()
  registerApp.mockImplementation((opts: RegisterOptions) => {
    options = opts
    return new Promise((resolve, reject) => {
      settle = { resolve, reject }
      queueMicrotask(() => opts.onQRCodeReady({ url: 'https://accounts.feishu.cn/device/verify?code=x', expireIn: 600 }))
    })
  })
})

function session(): ProvisionSession {
  return {
    flowId: 'prov-test',
    channelType: 'feishu',
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: Date.now(),
    expiresAt: 0,
    data: undefined,
  }
}

describe('FeishuProvisionFlow', () => {
  it('starts on QR-ready with createOnly, then succeeds with the credential pair', async () => {
    const flow = new FeishuProvisionFlow()
    const s = session()
    const started = await flow.start(s)
    expect(started.qrUrl).toContain('accounts.feishu.cn/device/verify')
    expect(started.expiresAt).toBeGreaterThan(Date.now() + 500_000)
    expect(options?.createOnly).toBe(true)
    expect(options?.source).toBe('tentacle')

    expect(await flow.poll(s)).toMatchObject({ state: 'waiting', qrUrl: started.qrUrl })
    options?.onStatusChange?.({ status: 'polling' })
    expect(await flow.poll(s)).toMatchObject({ state: 'waiting', message: 'polling' })

    settle.resolve({ client_id: 'cli_scanned', client_secret: 'scanned-secret' })
    await vi.waitFor(() => undefined)
    expect(await flow.poll(s)).toEqual({
      state: 'success',
      credentials: { appId: 'cli_scanned', appSecret: 'scanned-secret' },
    })
  })

  it('maps denial to failed and expiry to expired', async () => {
    const flow = new FeishuProvisionFlow()
    const denied = session()
    await flow.start(denied)
    settle.reject({ code: 'access_denied', description: 'user refused' })
    await vi.waitFor(() => undefined)
    expect(await flow.poll(denied)).toEqual({ state: 'failed', error: 'user refused' })

    const expired = session()
    await flow.start(expired)
    settle.reject({ code: 'expired_token', description: 'QR timed out' })
    await vi.waitFor(() => undefined)
    expect(await flow.poll(expired)).toEqual({ state: 'expired' })
  })

  it('aborts the SDK run on stop', async () => {
    const flow = new FeishuProvisionFlow()
    const s = session()
    await flow.start(s)
    expect(options?.signal?.aborted).toBe(false)
    await flow.stop(s)
    expect(options?.signal?.aborted).toBe(true)
  })
})
