/**
 * The SSO flow against the REAL openid-client and a REAL HTTP IdP fake: start
 * issues a PKCE redirect, the IdP round trip is replayed with fetch, and the
 * callback must verify the signed ID token and mint a gateway session.
 */
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { TentacleOidc } from '../src/oidc.js'
import { FakeOidcIdp } from './fake-idp.js'

let idp: FakeOidcIdp
let ctx: Context
let fiber: { dispose(): Promise<void> } | undefined

beforeEach(async () => {
  idp = new FakeOidcIdp()
  await idp.listen()
  recordedSessions.length = 0
})

afterEach(async () => {
  await fiber?.dispose().catch(() => undefined)
  fiber = undefined
  await idp.close()
})

class FakeGateway extends Service {
  static name = 'fake-gateway'
  static inject: string[] = []
  readonly routes = new Map<string, { isPublic: boolean | undefined; handler: (req: unknown, res: unknown) => void }>()
  private nextSession = 0

  constructor(ctx: import('@deepseek-ai/cordis').Context, private readonly sessions: string[]) {
    super(ctx, 'tentacleGateway')
  }

  registerRoute(route: { prefix: string; public?: boolean; handler: (req: unknown, res: unknown) => void }): () => void {
    this.routes.set(route.prefix, { isPublic: route.public, handler: route.handler })
    return () => this.routes.delete(route.prefix)
  }

  createSession(): { token: string } {
    const session = { token: `sess-${this.nextSession++}` }
    this.sessions.push(session.token)
    return session
  }
}

let gateway: FakeGateway

/**
 * Drive one registered route over REAL node HTTP: the handler runs against a
 * genuine IncomingMessage/ServerResponse pair, exactly as the gateway will
 * invoke it. The response is read back as a fetch Response (redirects manual).
 */
let server: import('node:http').Server
let serverUrl = ''

async function callRoute(path: string, init: { cookie?: string; query?: string } = {}): Promise<{
  status: number
  location: string | undefined
  cookies: string[]
  body: string
}> {
  const registered = gateway.routes.get(path)
  if (registered === undefined) throw new Error(`route not registered: ${path}`)
  server = createServer((req, res) => { void Promise.resolve(registered.handler(req, res)).catch(() => undefined) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  try {
    const response = await fetch(`${serverUrl}${path}${init.query ?? ''}`, {
      redirect: 'manual',
      headers: init.cookie === undefined ? {} : { cookie: init.cookie },
    })
    const cookies = ([] as string[]).concat(response.headers.getSetCookie?.() ?? [])
    return {
      status: response.status,
      location: response.headers.get('location') ?? undefined,
      cookies,
      body: await response.text(),
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const recordedSessions: string[] = []

async function bootOidc(overrides: Record<string, unknown> = {}): Promise<void> {
  ctx = new Context()
  // The gateway peer must be PUBLISHED before the oidc fiber resolves it:
  // `ctx.get` returns nothing for a service that has not finished starting.
  await ctx.plugin(FakeGateway, recordedSessions)
  gateway = ctx.get('tentacleGateway') as unknown as FakeGateway
  fiber = ctx.plugin(TentacleOidc, { issuer: idp.baseUrl, clientId: 'tentacle-test', allowInsecureIssuer: true, ...overrides })
  await fiber
}

describe('TentacleOidc', () => {
  it('registers two public SSO routes after discovery', async () => {
    await bootOidc()
    expect(gateway.routes.get('/tentacle/auth/oidc/start')?.isPublic).toBe(true)
    expect(gateway.routes.get('/tentacle/auth/oidc/callback')?.isPublic).toBe(true)
  })

  it('walks the full PKCE flow: start → IdP → callback mints a session', async () => {
    await bootOidc()
    const start = await callRoute('/tentacle/auth/oidc/start')
    expect(start.status).toBe(303)
    expect(start.location).toContain(idp.baseUrl)
    const authorizeUrl = new URL(start.location!)
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('nonce')).toBeTruthy()

    // Replay the IdP round trip over real HTTP (it redirects back with a code).
    const redirect = await fetch(start.location!, { redirect: 'manual' })
    const callbackUrl = new URL(redirect.headers.get('location')!)
    expect(callbackUrl.pathname).toBe('/tentacle/auth/oidc/callback')
    const state = authorizeUrl.searchParams.get('state')!
    const txCookie = start.cookies.find((c) => c.startsWith('tentacle-oidc-tx='))!

    const callback = await callRoute(callbackUrl.pathname, { query: callbackUrl.search, cookie: txCookie })
    expect(callback.status).toBe(303)
    expect(callback.location).toBe('/?sso=ok')
    const sessionCookie = callback.cookies.find((c) => c.startsWith('tentacle-session='))
    expect(sessionCookie).toBeTruthy()
    expect(sessionCookie).toContain('HttpOnly')
    // The transaction cookie is consumed exactly once.
    expect(callback.cookies.some((c) => c.startsWith('tentacle-oidc-tx=;') || c.includes('tentacle-oidc-tx=;'))).toBe(true)
  })

  it('rejects a callback whose state does not match the transaction cookie', async () => {
    await bootOidc()
    const start = await callRoute('/tentacle/auth/oidc/start')
    const authorizeUrl = new URL(start.location!)
    const redirect = await fetch(start.location!, { redirect: 'manual' })
    const callbackUrl = new URL(redirect.headers.get('location')!)

    // Replace (not append) the state param: a duplicate `?state=a&state=b`
    // would let searchParams.get() return the original and weaken the test.
    callbackUrl.searchParams.set('state', 'forged')
    const forged = await callRoute(callbackUrl.pathname, {
      query: callbackUrl.search,
      cookie: start.cookies.find((c) => c.startsWith('tentacle-oidc-tx='))!,
    })
    expect(forged.location).toBe('/?sso=state-mismatch')
    expect(recordedSessions).toHaveLength(0)
  })

  it('rejects a callback without any transaction cookie', async () => {
    await bootOidc()
    const failed = await callRoute('/tentacle/auth/oidc/callback', { query: '?code=x&state=y' })
    expect(failed.location).toBe('/?sso=state-mismatch')
  })

  it('surfaces a provider error as a stable denial, not an exception', async () => {
    await bootOidc()
    const denied = await callRoute('/tentacle/auth/oidc/callback', { query: '?error=access_denied' })
    expect(denied.location).toBe('/?sso=denied')
  })

  it('fails the callback when the token exchange is rejected', async () => {
    await idp.close()
    idp = new FakeOidcIdp({ tokenError: 'invalid_grant' })
    await idp.listen()
    await bootOidc()
    const start = await callRoute('/tentacle/auth/oidc/start')
    const redirect = await fetch(start.location!, { redirect: 'manual' })
    const callbackUrl = new URL(redirect.headers.get('location')!)
    const callback = await callRoute(callbackUrl.pathname, {
      query: callbackUrl.search,
      cookie: start.cookies.find((c) => c.startsWith('tentacle-oidc-tx='))!,
    })
    expect(callback.location).toBe('/?sso=token-exchange-failed')
    expect(recordedSessions).toHaveLength(0)
  })

  it('stays inert (no routes) when issuer/clientId are missing', async () => {
    ctx = new Context()
    await ctx.plugin(FakeGateway, recordedSessions)
    gateway = ctx.get('tentacleGateway') as unknown as FakeGateway
    await ctx.plugin(TentacleOidc, { clientId: 'x' })
    expect(gateway.routes.size).toBe(0)
  })
})
