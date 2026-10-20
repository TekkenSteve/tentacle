/**
 * The quick-setup (QR) pane: start → poll → success/failed/expired lifecycle,
 * with flow cleanup on unmount. The HTTP seam is stubbed `fetch` exactly like
 * the console tests; `qrcode` is stubbed so the QR carries its source URL.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-stub.tsx'))
vi.mock('qrcode-generator', () => ({
  default: () => {
    let text = ''
    return {
      addData(value: string) { text = value },
      make() {},
      createDataURL: () => `data:image/gif;base64,qr(${encodeURIComponent(text)})`,
    }
  },
}))

import { ProvisionPane } from '../../src/client/console/editor/provision-pane.tsx'
import { zh, type ChannelsLocaleKey } from '../../src/client/locales.ts'
import type { ChannelInstanceView } from '../../src/client/api.ts'

const t = (key: ChannelsLocaleKey): string => zh[key]

interface StubCall { method: 'GET' | 'POST'; path: string; body?: unknown }
interface StubResponse { status: number; body: unknown }

let calls: StubCall[]
let responses: Map<string, StubResponse>

function stubFetch(): void {
  calls = []
  responses = new Map()
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input, 'http://localhost')
    const path = (url.pathname.replace('/tentacle/api/admin/channels', '') || '/') + url.search
    const method = init?.method === 'POST' ? 'POST' : 'GET'
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const stub = responses.get(`${method} ${path}`)
    if (stub === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not-stubbed' }) }
    return { ok: stub.status < 400, status: stub.status, json: async () => stub.body }
  }))
}

function okGet(path: string, body: unknown): void { responses.set(`GET ${path}`, { status: 200, body }) }
function okPost(path: string, body: unknown): void { responses.set(`POST ${path}`, { status: 200, body }) }
function failPost(path: string, status: number, code: string): void {
  responses.set(`POST ${path}`, { status, body: { error: code } })
}

function countCalls(path: string): number {
  return calls.filter((call) => call.path === path).length
}

const INSTANCE = {
  id: 'ch-1',
  tenant: 'local',
  channelType: 'feishu',
  name: 'feishu-ops',
  enabled: true,
  config: {},
  createdAt: 1,
  updatedAt: 1,
  runtime: { state: 'connected' },
  credential: { configured: true, writable: true },
} as unknown as ChannelInstanceView

let saved: ChannelInstanceView[]
let toasts: string[]

function mount(): ReturnType<typeof render> {
  saved = []
  toasts = []
  return render(
    <ProvisionPane
      t={t}
      channelType="feishu"
      onSaved={(instance) => saved.push(instance)}
      onToast={(message) => toasts.push(message)}
    />,
  ) as ReturnType<typeof render>
}

beforeEach(() => {
  stubFetch()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  cleanup()
})

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('quick-setup pane', () => {
  it('starts, renders the QR, and hands the created instance to the parent on success', async () => {
    okPost('/provision/start', { state: 'waiting', flowId: 'prov-1', qrUrl: 'https://qr.example/scan', userCode: 'ABCD-1234' })
    okGet('/provision/poll?flowId=prov-1', { state: 'waiting', flowId: 'prov-1' })
    mount()

    const img = await screen.findByRole('img', { name: zh['channels.provision.qrAlt'] })
    expect(img.getAttribute('src')).toContain(encodeURIComponent('https://qr.example/scan'))
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
    expect(callOfBody('/provision/start')).toEqual({ channelType: 'feishu' })

    okGet('/provision/poll?flowId=prov-1', { state: 'success', flowId: 'prov-1', instance: INSTANCE })
    await advance(2100)
    await waitFor(() => expect(saved).toEqual([INSTANCE]))
    expect(toasts).toContain(zh['channels.toast.created'])
    const pollsBefore = countCalls('/provision/poll?flowId=prov-1')
    await advance(6000)
    // Success is terminal: no more polling, and no stop call for a consumed flow.
    expect(countCalls('/provision/poll?flowId=prov-1')).toBe(pollsBefore)
    expect(countCalls('/provision/stop')).toBe(0)
  })

  it('stops the flow when the pane unmounts', async () => {
    okPost('/provision/start', { state: 'waiting', flowId: 'prov-2', qrUrl: 'https://qr.example/scan' })
    okGet('/provision/poll?flowId=prov-2', { state: 'waiting', flowId: 'prov-2' })
    okPost('/provision/stop', { ok: true })
    const view = mount()
    await screen.findByRole('img', { name: zh['channels.provision.qrAlt'] })
    view.unmount()
    await waitFor(() => expect(countCalls('/provision/stop')).toBe(1))
    expect(callOfBody('/provision/stop')).toEqual({ flowId: 'prov-2' })
  })

  it('reports a failure and regenerates on demand', async () => {
    okPost('/provision/start', { state: 'waiting', flowId: 'prov-3', qrUrl: 'https://qr.example/scan' })
    okGet('/provision/poll?flowId=prov-3', { state: 'failed', flowId: 'prov-3', error: 'user denied the scan' })
    mount()
    await screen.findByRole('img', { name: zh['channels.provision.qrAlt'] })
    await advance(2100)
    expect(await screen.findByText('user denied the scan')).toBeTruthy()
    expect(screen.getByText(zh['channels.provision.failedHint'])).toBeTruthy()

    okPost('/provision/start', { state: 'waiting', flowId: 'prov-4', qrUrl: 'https://qr.example/scan-2' })
    okGet('/provision/poll?flowId=prov-4', { state: 'waiting', flowId: 'prov-4' })
    fireEvent.click(screen.getByRole('button', { name: zh['channels.provision.regenerate'] }))
    await waitFor(() => expect(countCalls('/provision/start')).toBe(2))
    expect(callOfBody('/provision/start')).toEqual({ channelType: 'feishu' })
  })

  it('reports expiry and a start failure without inventing a QR', async () => {
    okPost('/provision/start', { state: 'waiting', flowId: 'prov-5' })
    okGet('/provision/poll?flowId=prov-5', { state: 'expired', flowId: 'prov-5' })
    const view = mount()
    await advance(2100)
    expect(await screen.findByText(zh['channels.provision.expired'])).toBeTruthy()
    expect(screen.getByText(zh['channels.provision.expiredHint'])).toBeTruthy()
    view.unmount()

    failPost('/provision/start', 400, 'no-provision-flow')
    mount()
    expect(await screen.findByText('no-provision-flow')).toBeTruthy()
  })
})

function callOfBody(path: string): unknown {
  const call = calls.find((candidate) => candidate.path === path)
  return call?.body
}
