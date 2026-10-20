// @vitest-environment jsdom
/**
 * Client-entry registration (design 07 §5): the console is an official global
 * panel — a `main` page plus the `sidebar.panellist` icon of the SAME id — and
 * both seats exist only for an admin arriving through the Tentacle gateway.
 *
 * Rendering tests cover the console itself; this covers the contract that makes
 * it reachable at all, which nothing else can observe without a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The console entry renders official UI primitives; the published package
// cannot be imported under jsdom (see primitives-stub.tsx).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-stub.tsx'))

import { apply } from '../../src/client/index.tsx'

interface Registration {
  readonly seat: string
  readonly options: Record<string, unknown>
}

/** Minimal client context: the two effects, the locale seat and the slot registry. */
function fakeContext(): { ctx: unknown; registrations: Registration[]; seats: string[] } {
  const registrations: Registration[] = []
  const seats: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (seat: string, callback: () => unknown) => {
        seats.push(seat)
        callback()
      },
      register: (options: Record<string, unknown>) => {
        registrations.push({ seat: String(options['name']), options })
        return () => {}
      },
    },
  }
  return { ctx, registrations, seats }
}

function whoami(roles: string[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: true, identity: { subjectId: 'did:key:zCaller', handle: 'caller', roles } }),
  })))
}

/** Let the identity probe settle and its subscribers run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('channels client entry', () => {
  it('registers the main panel and its sidebar entry under one id for an admin', async () => {
    whoami(['admin'])
    const { ctx, registrations, seats } = fakeContext()
    apply(ctx as never)
    await settle()

    expect(seats).toEqual(['main', 'sidebar.panellist'])
    const main = registrations.find((entry) => entry.seat === 'main')
    expect(main?.options).toMatchObject({ name: 'main', key: 'tentacle-channels', locale: 'tentacle-channels' })
    const panel = registrations.find((entry) => entry.seat === 'sidebar.panellist')
    expect(panel?.options).toMatchObject({ name: 'sidebar.panellist', id: 'tentacle-channels', order: 10, locale: 'tentacle-channels' })
    // The label is a thunk so a locale switch re-reads it without re-registering.
    expect(typeof panel?.options['label']).toBe('function')
  })

  it('registers nothing for a non-admin through the gateway', async () => {
    whoami(['user'])
    const { ctx, registrations, seats } = fakeContext()
    apply(ctx as never)
    await settle()
    expect(registrations).toEqual([])
    // The seats are still subscribed: a later admin flip (page reload in
    // practice) can mount without a re-apply.
    expect(seats).toEqual(['main', 'sidebar.panellist'])
  })

  it('registers nothing when the page is not behind the gateway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const { ctx, registrations } = fakeContext()
    apply(ctx as never)
    await settle()
    expect(registrations).toEqual([])
  })
})
