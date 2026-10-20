/**
 * Identity resolution: the five states and the fail-open rules.
 * The client must NEVER intervene on the direct loopback path (operator
 * bypassing the gateway), and only normal users get shadows.
 */
import { describe, expect, it } from 'vitest'
import {
  createIdentitySource,
  resolveIdentity,
  shouldRestrictUi,
  type ClientDeps,
  type IdentityState,
} from '../../src/client/identity.ts'

const ADMIN = { subjectId: 'did:key:z6MkAdmin', handle: 'admin', roles: ['admin'] }
const USER = { subjectId: 'did:key:z6MkAlice', handle: 'alice', roles: ['user'] }

interface Route { status: number; body?: unknown }
interface StubDeps extends ClientDeps { calls: string[] }

function deps(routes: Record<string, Route>, opts: { throwOn?: string[] } = {}): StubDeps {
  const calls: string[] = []
  return {
    calls,
    fetch: async (input: string) => {
      calls.push(input)
      if (opts.throwOn?.includes(input)) throw new Error('network down')
      const route = routes[input]
      if (!route) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
      return { ok: route.status < 400, status: route.status, json: async () => route.body }
    },
  }
}

describe('resolveIdentity', () => {
  it('resolves admin from an authenticated admin whoami (never touches /me)', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 200, body: { authenticated: true, identity: ADMIN } } })
    const state = await resolveIdentity(d)
    expect(state).toEqual({ kind: 'admin', identity: ADMIN })
    expect(d.calls).toEqual(['/tentacle/api/whoami'])
  })

  it('resolves user with the workspace fence from /me', async () => {
    const d = deps({
      '/tentacle/api/whoami': { status: 200, body: { authenticated: true, identity: USER } },
      '/tentacle/api/me': { status: 200, body: { identity: USER, workspaceRootDir: '/ws/alice' } },
    })
    const state = await resolveIdentity(d)
    expect(state).toEqual({ kind: 'user', identity: USER, workspaceRootDir: '/ws/alice' })
  })

  it('keeps the user state when /me fails (fence is display input, not a gate)', async () => {
    const d = deps(
      { '/tentacle/api/whoami': { status: 200, body: { authenticated: true, identity: USER } } },
      { throwOn: ['/tentacle/api/me'] },
    )
    const state = await resolveIdentity(d)
    expect(state).toEqual({ kind: 'user', identity: USER, workspaceRootDir: undefined })
  })

  it('resolves anonymous when the gateway reports no session', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 200, body: { authenticated: false } } })
    expect((await resolveIdentity(d)).kind).toBe('anonymous')
  })

  it('resolves anonymous on a malformed identity payload', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 200, body: { authenticated: true, identity: { handle: 7 } } } })
    expect((await resolveIdentity(d)).kind).toBe('anonymous')
  })

  it('resolves direct when whoami 404s (stock DSH webserver, no gateway)', async () => {
    const d = deps({})
    expect((await resolveIdentity(d)).kind).toBe('direct')
  })

  it('resolves direct when the probe throws (fail-open)', async () => {
    const d = deps({}, { throwOn: ['/tentacle/api/whoami'] })
    expect((await resolveIdentity(d)).kind).toBe('direct')
  })

  it('resolves direct on any non-OK whoami status (fail-open)', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 500, body: {} } })
    expect((await resolveIdentity(d)).kind).toBe('direct')
  })
})

describe('shouldRestrictUi', () => {
  it('restricts only the normal-user state', () => {
    const states: IdentityState[] = [
      { kind: 'resolving' },
      { kind: 'anonymous' },
      { kind: 'direct' },
      { kind: 'admin', identity: ADMIN },
      { kind: 'user', identity: USER, workspaceRootDir: '/ws/alice' },
    ]
    expect(states.map(shouldRestrictUi)).toEqual([false, false, false, false, true])
  })
})

describe('createIdentitySource', () => {
  it('publishes resolving synchronously, then the resolved state', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 200, body: { authenticated: true, identity: ADMIN } } })
    const { source, stop } = createIdentitySource(d)
    expect(source.get().kind).toBe('resolving')
    const seen: string[] = []
    source.subscribe(() => seen.push(source.get().kind))
    await new Promise((r) => setTimeout(r, 0))
    expect(source.get().kind).toBe('admin')
    expect(seen).toEqual(['admin'])
    stop()
  })

  it('swallows repeat publications of an equal state', async () => {
    const d = deps({ '/tentacle/api/whoami': { status: 200, body: { authenticated: false } } })
    const { source, stop } = createIdentitySource(d)
    await new Promise((r) => setTimeout(r, 0))
    let count = 0
    source.subscribe(() => { count += 1 })
    source.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(source.get().kind).toBe('anonymous')
    expect(count).toBe(0)
    stop()
  })

  it('stops publishing after stop()', async () => {
    let resolveWhoami: (v: { ok: boolean; status: number; json(): Promise<unknown> }) => void = () => {}
    const d: ClientDeps = {
      fetch: () => new Promise((r) => { resolveWhoami = r }),
    }
    const { source, stop } = createIdentitySource(d)
    stop()
    resolveWhoami({ ok: true, status: 200, json: async () => ({ authenticated: true, identity: ADMIN }) })
    await new Promise((r) => setTimeout(r, 0))
    expect(source.get().kind).toBe('resolving')
  })
})
