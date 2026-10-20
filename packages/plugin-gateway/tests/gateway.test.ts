import http from 'node:http'
import net from 'node:net'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalProvider } from '@tentacle/identity'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, verifyPassword } from '@tentacle/crypto'
import { isPrivilegedRpc, DefaultPolicy } from '../src/policy.js'
import { SessionStore } from '../src/sessions.js'
import { TentacleGateway } from '../src/service.js'
import { subjectId, tenantId, type Identity } from '@tentacle/identity'

const alice: Identity = { subjectId: subjectId('did:key:zAlice'), tenant: tenantId('local'), createdAt: 0 }

describe('crypto', () => {
  it('round-trips scrypt envelopes and fails closed on garbage', () => {
    const envelope = hashPassword('s3cret')
    expect(verifyPassword('s3cret', envelope)).toBe(true)
    expect(verifyPassword('wrong', envelope)).toBe(false)
    expect(verifyPassword('s3cret', 'not-an-envelope')).toBe(false)
    expect(verifyPassword('s3cret', 'scrypt$zz$yy')).toBe(false)
  })
})

describe('SessionStore', () => {
  it('mints, authenticates, and revokes with subject cascade', () => {
    const store = new SessionStore(60_000)
    const s1 = store.mint(alice)
    const s2 = store.mint(alice)
    expect(store.authenticate(s1.token)).toBe(s1)
    expect(store.authenticate('garbage')).toBeUndefined()
    expect(store.revokeSubject(alice.subjectId)).toBe(2)
    expect(store.authenticate(s1.token)).toBeUndefined()
    expect(store.authenticate(s2.token)).toBeUndefined()
  })

  it('revocation aborts the session controller', () => {
    const store = new SessionStore(60_000)
    const s = store.mint(alice)
    let aborted = false
    s.controller.signal.addEventListener('abort', () => { aborted = true })
    store.revoke(s)
    expect(aborted).toBe(true)
  })

  it('expires sessions', () => {
    const store = new SessionStore(-1) // already expired
    const s = store.mint(alice)
    expect(store.authenticate(s.token)).toBeUndefined()
  })
})

describe('DefaultPolicy', () => {
  const policy = new DefaultPolicy()
  it('denies anonymous', async () => {
    expect((await policy.resolve(undefined, { channel: 'http', method: 'GET', path: '/' })).allow).toBe(false)
  })
  it('denies privileged RPC for ordinary users', async () => {
    const fact = { channel: 'rpc' as const, method: 'POST', path: '/api/commands/execute' }
    expect((await policy.resolve(alice, fact)).allow).toBe(false)
    const admin = { ...alice, roles: ['admin'] }
    expect((await policy.resolve(admin, fact)).allow).toBe(true)
  })
  it('allows ordinary RPC', async () => {
    expect((await policy.resolve(alice, { channel: 'rpc', method: 'POST', path: '/api/session.list' })).allow).toBe(true)
  })
  it('admits privileged RPC by permission key, not by role name', async () => {
    const fact = (path: string) => ({ channel: 'rpc' as const, method: 'POST', path })
    const withSettings = { ...alice, permissions: ['settings'] }
    expect((await policy.resolve(withSettings, fact('/api/settings.write'))).allow).toBe(true)
    expect((await policy.resolve(withSettings, fact('/api/credentials.list'))).allow).toBe(false)

    const withCredentials = { ...alice, permissions: ['credentials'] }
    expect((await policy.resolve(withCredentials, fact('/api/credentials.list'))).allow).toBe(true)
    expect((await policy.resolve(withCredentials, fact('/api/llm.discoverModels'))).allow).toBe(true)
    expect((await policy.resolve(withCredentials, fact('/api/plugin_manager/install'))).allow).toBe(false)

    const withPlugins = { ...alice, permissions: ['plugins'] }
    expect((await policy.resolve(withPlugins, fact('/api/dynamicCordisRunner/start'))).allow).toBe(true)
    expect((await policy.resolve(withPlugins, fact('/api/settings.write'))).allow).toBe(false)
  })

  it('never delegates escalation paths, even with the whole catalog granted', async () => {
    const fact = (path: string) => ({ channel: 'rpc' as const, method: 'POST', path })
    const everything = {
      ...alice,
      permissions: ['users', 'roles', 'invites', 'policies', 'sessions', 'experts', 'settings', 'credentials', 'plugins'],
    }
    // permission-mode flip, approval answering, host path opening: admin only
    expect((await policy.resolve(everything, fact('/api/commands/execute'))).allow).toBe(false)
    expect((await policy.resolve(everything, fact('/api/respond'))).allow).toBe(false)
    expect((await policy.resolve(everything, fact('/api/host.openPath'))).allow).toBe(false)
    // ...while the admin bypass still reaches them
    const admin = { ...alice, roles: ['admin'] }
    expect((await policy.resolve(admin, fact('/api/commands/execute'))).allow).toBe(true)
  })

  it('recognizes the #853 privileged surface', () => {
    expect(isPrivilegedRpc('/api/commands/execute')).toBe(true)
    expect(isPrivilegedRpc('/api/session.export')).toBe(true)
    expect(isPrivilegedRpc('/api/settings.write')).toBe(true)
    expect(isPrivilegedRpc('/api/session.list')).toBe(false)
  })
})

// ---- integration: real upstream + real gateway over cordis ----

const UPSTREAM_COOKIE = 'dsh-auth-test=upstream-secret'

async function startUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET' && new URL(req.url, 'http://x').searchParams.get('token')) {
      // token exchange endpoint
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' && url.searchParams.get('token') === 'launch-token') {
      res.writeHead(302, { 'set-cookie': `${UPSTREAM_COOKIE}; HttpOnly; Path=/`, location: './' })
      res.end()
      return
    }
    const wantHost = `127.0.0.1:${(server.address() as AddressInfo).port}`
    if (req.headers.cookie !== UPSTREAM_COOKIE || req.headers.host !== wantHost) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, path: url.pathname, strippedXHeader: req.headers['x-evil'] === undefined }))
      return
    }
    if (url.pathname === '/api/session.create' && req.method === 'POST') {
      // The real RPC envelope: session.create names the session it minted.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: { sessionId: 'minted-session-1' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  const upgradedSockets = new Set<import('node:net').Socket>()
  server.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket)
    socket.on('close', () => upgradedSockets.delete(socket))
    if (req.headers.cookie !== UPSTREAM_COOKIE) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk)) // raw echo
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: async () => {
      server.closeAllConnections()
      for (const socket of upgradedSockets) socket.destroy()
      await new Promise((r) => server.close(() => r()))
    },
  }
}

async function startGateway(upstreamPort: number, config: Record<string, unknown>): Promise<{ port: number; dispose: () => Promise<void>; gateway: TentacleGateway }> {
  const app = new Context()
  app.reflect.provide('webServer', { port: upstreamPort })
  app.reflect.provide('connection', { authenticatedUrl: (base: string) => `${base}/?token=launch-token` })
  const identity = new LocalProvider(mkdtempSync(join(tmpdir(), 'tentacle-gw-test-')))
  await identity.boot()
  app.reflect.provide('tentacleIdentity', identity)
  const fiber = app.plugin(TentacleGateway, { listen: '127.0.0.1:0', ...config })
  await new Promise((r) => setImmediate(r)) // let [Service.init] settle
  await new Promise((r) => setTimeout(r, 50))
  const gw = app.tentacleGateway as TentacleGateway & { server?: http.Server }
  const address = (gw as never as { server: http.Server }).server.address() as AddressInfo
  gatewayFibers.push(fiber)
  return { port: address.port, dispose: () => fiber.dispose(), gateway: gw }
}

const gatewayFibers: { dispose: () => Promise<void> }[] = []

async function fetchRaw(port: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init })
}

describe('TentacleGateway integration', () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>
  beforeAll(async () => { upstream = await startUpstream() })
  afterAll(async () => {
    await Promise.all(gatewayFibers.map((fiber) => fiber.dispose()))
    await upstream.close()
  })

  it('passthrough mode forwards with the upstream cookie injected and x-* stripped', async () => {
    const { port } = await startGateway(upstream.port, { mode: 'passthrough' })
    const res = await fetchRaw(port, '/api/echo', { method: 'POST', headers: { 'x-evil': '1', 'content-type': 'text/plain' }, body: 'hi' })
    expect(res.status).toBe(200)
    const body = await res.json() as { strippedXHeader: boolean }
    expect(body.strippedXHeader).toBe(true)
  })

  it('required mode blocks unauthenticated requests and admits after login', async () => {
    const envelope = hashPassword('admin-password')
    const { port } = await startGateway(upstream.port, { mode: 'required', adminPasswordEnvelope: envelope })

    expect((await fetchRaw(port, '/api/echo', { method: 'POST' })).status).toBe(403)

    const login = await fetchRaw(port, '/tentacle/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!

    const authed = await fetchRaw(port, '/api/echo', { method: 'POST', headers: { cookie } })
    expect(authed.status).toBe(200)

    // Privileged RPC is denied even for authenticated non-admin-handle... admin logs in as admin handle.
    const privileged = await fetchRaw(port, '/api/commands/execute', { method: 'POST', headers: { cookie } })
    expect(privileged.status).toBe(200) // admin bypasses deny-list

    // logout kills the session
    await fetchRaw(port, '/tentacle/api/logout', { method: 'POST', headers: { cookie } })
    expect((await fetchRaw(port, '/api/echo', { method: 'POST', headers: { cookie } })).status).toBe(403)
  })

  it('wrong password fails closed', async () => {
    const envelope = hashPassword('admin-password')
    const { port } = await startGateway(upstream.port, { mode: 'required', adminPasswordEnvelope: envelope })
    const res = await fetchRaw(port, '/tentacle/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('csrf fence rejects cross-site state changes', async () => {
    const { port } = await startGateway(upstream.port, { mode: 'passthrough' })
    const res = await fetchRaw(port, '/api/echo', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('attributes a minted session.create response to the requesting identity', async () => {
    const envelope = hashPassword('admin-password')
    const { port, gateway } = await startGateway(upstream.port, { mode: 'required', adminPasswordEnvelope: envelope })
    const seen: Array<[string, string]> = []
    gateway.registerSessionObserver((subjectId, sessionId) => { seen.push([subjectId, sessionId]) })

    const login = await fetchRaw(port, '/tentacle/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!
    const created = await fetchRaw(port, '/api/session.create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    })
    expect(created.status).toBe(200)
    // The tee must not alter the response the client sees.
    expect(await created.json()).toEqual({ ok: true, value: { sessionId: 'minted-session-1' } })
    expect(seen).toHaveLength(1)
    expect(seen[0]![1]).toBe('minted-session-1')
    expect(seen[0]![0]).toMatch(/^did:/)
  })

  it('relays websocket upgrades after admission', async () => {
    const { port } = await startGateway(upstream.port, { mode: 'passthrough' })
    const socket = net.connect(port, '127.0.0.1')
    await new Promise((r) => socket.once('connect', r))
    socket.write('GET /api/remote.mux HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n')
    const head = await new Promise<Buffer>((r) => socket.once('data', r))
    expect(head.toString()).toContain('101')
    socket.write('ping-through-gateway')
    const echo = await new Promise<Buffer>((r) => socket.once('data', r))
    expect(echo.toString()).toContain('ping-through-gateway')
    socket.destroy()
  })
})

describe('login page', () => {
  it('serves the login page to unauthenticated browsers, JSON to API clients', async () => {
    const upstream = await startUpstream()
    const gw = await startGateway(upstream.port, { mode: 'required', adminPasswordEnvelope: hashPassword('pw') })
    try {
      const { port } = gw

      const browser = await fetchRaw(port, '/', { headers: { accept: 'text/html,application/xhtml+xml' } })
      expect(browser.status).toBe(200)
      const html = await browser.text()
      expect(html).toContain('Sign in')
      expect(html).toContain('/tentacle/api/login')

      const api = await fetchRaw(port, '/', { headers: { accept: 'application/json' } })
      expect(api.status).toBe(403)
      expect((await api.json()).error).toBeTruthy()

      const invite = await fetchRaw(port, '/?invite=abc123', { headers: { accept: 'text/html' } })
      expect(await invite.text()).toContain('abc123')
    } finally {
      await gw.dispose()
      await upstream.close()
    }
  })
})
