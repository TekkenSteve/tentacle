/**
 * TentacleGateway — the authenticating reverse proxy (design 02).
 *
 * Architecture: DSH stays loopback-bound with its native launch-token fence
 * intact; this service is the only external entry point. It holds the
 * upstream `dsh-auth-*` cookie in memory (exchanged once from the launch
 * token via the official `ctx.connection.authenticatedUrl`), authenticates
 * Tentacle sessions, runs the permission policy, and opaquely forwards.
 *
 * All three channels (HTTP / RPC under /api / WS upgrades) pass through the
 * same `authenticate → policy → forward` pipeline — the cross-section #2679
 * asks for, implemented at the network boundary because DSH ships no
 * in-process hook for it (H1 gap).
 */
import http from 'node:http'
import type net from 'node:net'
import { Service } from '@deepseek-ai/cordis'
import type { Identity } from '@tentacle/identity'
import { hashPassword, verifyPassword } from '@tentacle/crypto'
import { loginPage } from './pages.js'
import { DefaultPolicy } from './policy.js'
import { filterSetCookies, forwardHttp, forwardUpgrade, UpstreamAuth, type ForwardContext } from './proxy.js'
import { SessionStore } from './sessions.js'
import { POLICY_BODY_ENDPOINTS } from './types.js'
import type { Authenticator, GatewayConfig, GatewayRoute, GatewaySession, PermissionPolicy, RouteFact } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleGateway: TentacleGateway
  }
}

/** Minimal structural view of the official services we consume. */
interface WebServerLike { readonly port: number | undefined }
interface ConnectionLike { authenticatedUrl(baseUrl: string): string }

const COOKIE_NAME = 'tentacle-session'
const LOGIN_PATH = '/tentacle/api/login'
const LOGOUT_PATH = '/tentacle/api/logout'
const WHOAMI_PATH = '/tentacle/api/whoami'

export class TentacleGateway extends Service {
  private server: http.Server | undefined
  private sessions: SessionStore
  private policy: PermissionPolicy = new DefaultPolicy()
  private upstream: ForwardContext | undefined
  private readonly sockets = new Set<net.Socket>()

  constructor(
    ctx: import('@deepseek-ai/cordis').Context,
    private readonly config: GatewayConfig = {},
  ) {
    super(ctx, 'tentacleGateway')
    const ttlMs = (config.sessionTtlHours ?? 72) * 3_600_000
    this.sessions = new SessionStore(ttlMs)
  }

  /** Replace the permission policy (single seat — tenancy owns it later). */
  registerPolicy(policy: PermissionPolicy): () => void {
    const previous = this.policy
    this.policy = policy
    return () => { this.policy = previous }
  }

  /**
   * Register the credential authenticator (single seat — plugin-tenancy's
   * user directory). Without one, login falls back to the config admin
   * envelope. Session revocation is wired back through `onRevoke`.
   */
  registerAuthenticator(authenticator: Authenticator): () => void {
    if (this.authenticator) {
      throw new Error(`tentacle gateway: authenticator seat already held by ${this.authenticator.kind}`)
    }
    authenticator.onRevoke = (id) => { this.sessions.revokeSubject(id) }
    this.authenticator = authenticator
    return () => {
      if (this.authenticator === authenticator) this.authenticator = undefined
    }
  }

  private authenticator: Authenticator | undefined

  /** Active session snapshot for admin surfaces (plugin-tenancy's console). */
  listSessions(): ReadonlyArray<{ identity: GatewaySession['identity']; createdAt: number; expiresAt: number }> {
    return this.sessions.snapshot()
  }

  /**
   * Register a gateway-local route (single owner per prefix — a duplicate
   * prefix is a composition error and throws). Local routes are evaluated
   * before upstream forwarding; non-public routes get an authenticated
   * session, public routes run the policy with an anonymous identity.
   */
  registerRoute(route: GatewayRoute): () => void {
    if (!route.prefix.startsWith('/')) throw new Error(`tentacle gateway: route prefix must start with /: ${route.prefix}`)
    if (this.routes.has(route.prefix)) {
      throw new Error(`tentacle gateway: duplicate route prefix ${JSON.stringify(route.prefix)}`)
    }
    this.routes.set(route.prefix, route)
    return () => {
      if (this.routes.get(route.prefix) === route) this.routes.delete(route.prefix)
    }
  }

  /**
   * Mint a session for an identity that was authenticated OUTSIDE the built-in
   * username/password flow (OIDC SSO and future providers), using exactly the
   * same store, cookie and revocation cascade. Returns the minted session so
   * the caller can set the standard `tentacle-session` cookie.
   */
  createSession(identity: Identity): GatewaySession {
    return this.sessions.mint(identity)
  }

  private readonly routes = new Map<string, GatewayRoute>()
  /**
   * Observers of NEWLY MINTED sessions (session.create responses). Tenancy
   * uses this to attribute live agents and token spend to a subject; the
   * gateway itself never persists identities.
   */
  private readonly sessionObservers = new Set<(subjectId: string, sessionId: string) => void>()

  /** Observe `session.create` results; returns the unregister disposer. */
  registerSessionObserver(observer: (subjectId: string, sessionId: string) => void): () => void {
    this.sessionObservers.add(observer)
    return () => this.sessionObservers.delete(observer)
  }

  /** Parse one observed session.create response and notify every observer. */
  private observeSessionCreate(identity: Identity | undefined, status: number, text: string): void {
    if (identity === undefined || status < 200 || status >= 300) return
    let sessionId: unknown
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; value?: { sessionId?: unknown } }
      if (parsed.ok !== true) return
      sessionId = parsed.value?.sessionId
    } catch {
      return
    }
    if (typeof sessionId !== 'string' || sessionId === '') return
    for (const observer of this.sessionObservers) {
      try {
        observer(identity.subjectId, sessionId)
      } catch (error) {
        this.ctx.logger?.warn?.('tentacle gateway: session observer failed', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private matchRoute(path: string): GatewayRoute | undefined {
    let best: GatewayRoute | undefined
    for (const route of this.routes.values()) {
      if (path === route.prefix || path.startsWith(route.prefix + '/') || path === route.prefix + '/') {
        if (!best || route.prefix.length > best.prefix.length) best = route
      }
    }
    return best
  }

  /** Utility for setup tooling: mint a password envelope for config. */
  static hashPassword = hashPassword

  protected async [Service.init](): Promise<void> {
    const mode = this.config.mode ?? 'passthrough'
    if (mode === 'required' && !this.config.adminPasswordEnvelope) {
      // An authenticator (plugin-tenancy) may still register after init;
      // without either, login fails closed at request time.
      this.ctx.logger?.warn?.('tentacle gateway: mode=required without adminPasswordEnvelope — login requires an authenticator plugin (e.g. @tentacle/tenancy)')
    }

    // Discover the loopback upstream through the official services.
    const { webServer, connection } = this.ctx as unknown as {
      webServer?: WebServerLike
      connection?: ConnectionLike
    }
    if (!webServer?.port || !connection) {
      throw new Error('tentacle gateway: requires dsh-host-webserver and dsh-client-connection in the composition')
    }
    const auth = new UpstreamAuth(connection.authenticatedUrl(`http://127.0.0.1:${webServer.port}`))
    await auth.bootstrap()
    this.upstream = { upstreamHost: '127.0.0.1', upstreamPort: webServer.port, auth }

    this.sessions.start()
    this.server = http.createServer((req, res) => void this.handleHttp(req, res))
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head))
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    const [host, portText] = (this.config.listen ?? '127.0.0.1:8180').split(':')
    const port = Number(portText ?? '8180')
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, host, () => resolvePromise())
    })

    this.ctx.effect(() => async () => this.shutdown())
    this.ctx.logger?.info?.(`tentacle gateway listening on ${host}:${port} (mode=${mode}) → 127.0.0.1:${webServer.port}`)
  }

  private async shutdown(): Promise<void> {
    this.sessions.stop()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolvePromise) => this.server?.close(() => resolvePromise()) ?? resolvePromise())
  }

  // ---- request pipeline ----

  private sessionFrom(req: http.IncomingMessage): GatewaySession | undefined {
    const cookies = req.headers.cookie?.split(';').map((part) => part.trim()) ?? []
    const pair = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))
    return this.sessions.authenticate(pair?.slice(COOKIE_NAME.length + 1))
  }

  private factOf(req: http.IncomingMessage, channel: RouteFact['channel'], body?: unknown): RouteFact {
    const path = (req.url ?? '/').split('?', 1)[0]!
    const isRpc = path === '/api' || path.startsWith('/api/')
    return {
      channel: channel === 'ws' ? 'ws' : isRpc ? 'rpc' : 'http',
      method: req.method ?? 'GET',
      path,
      rpcEndpoint: isRpc ? path.replace(/^\/api\/?/, '') : undefined,
      body,
    }
  }

  /** CSRF fence for state-changing requests (design 02 §3). */
  private csrfOk(req: http.IncomingMessage): boolean {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true
    const fetchSite = req.headers['sec-fetch-site']
    if (fetchSite === 'cross-site') return false
    const origin = req.headers['origin']
    if (origin === undefined) return true // non-browser clients carry no Origin
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  private async admit(req: http.IncomingMessage, body?: unknown): Promise<{ session?: GatewaySession; deny?: { status: number; reason: string } }> {
    if ((this.config.mode ?? 'passthrough') === 'passthrough') return {}
    const session = this.sessionFrom(req)
    const identity = session?.identity
    const decision = await this.policy.resolve(identity, this.factOf(req, 'http', body))
    if (!decision.allow) return { deny: { status: decision.status, reason: decision.reason } }
    return { session }
  }

  /** Whether this request's body must be buffered for policy inspection. */
  private needsPolicyBody(req: http.IncomingMessage): boolean {
    if (req.method !== 'POST') return false
    const path = (req.url ?? '/').split('?', 1)[0]!
    if (!path.startsWith('/api/')) return false
    return POLICY_BODY_ENDPOINTS.has(path.replace(/^\/api\/?/, ''))
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?', 1)[0]!

    if (path === LOGIN_PATH || path === LOGOUT_PATH || path === WHOAMI_PATH) {
      await this.handleAuthApi(path, req, res)
      return
    }
    if (!this.csrfOk(req)) {
      this.writeJson(res, 403, { error: 'csrf check failed' })
      return
    }

    // Gateway-local routes (admin API, signup) are answered here, never
    // forwarded upstream — the handler gets the real authenticated identity.
    const local = this.matchRoute(path)
    if (local) {
      await this.handleLocalRoute(local, req, res)
      return
    }

    // Buffer the body when a policy needs it (allow-listed RPC endpoints).
    let bufferedBody: Buffer | undefined
    let parsedBody: unknown
    if (this.needsPolicyBody(req)) {
      try {
        bufferedBody = await this.readBody(req, 1024 * 1024)
        parsedBody = JSON.parse(bufferedBody.toString('utf8'))
      } catch {
        this.writeJson(res, 400, { error: 'unparseable rpc body' })
        return
      }
    }

    const { session, deny } = await this.admit(req, parsedBody)
    if (deny) {
      // Browser navigations get the login page; API clients get JSON.
      if (deny.status === 403 && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        const invite = new URL(req.url ?? '/', 'http://x').searchParams.get('invite') ?? undefined
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage({ inviteCode: invite }))
        return
      }
      this.ctx.logger?.debug?.(`deny ${req.method} ${path}: ${deny.reason}`)
      this.writeJson(res, deny.status, { error: deny.reason })
      return
    }

    // session.create is the one response the gateway inspects: its body names
    // the session it minted, which is how quota attribution stays exact.
    const observesCreate = path === '/api/session.create' && (req.method ?? 'GET') === 'POST'
    const identity = session?.identity ?? this.operatorIdentity
    forwardHttp(
      {
        ...this.upstream!,
        session,
        ...(observesCreate
          ? { observeJson: (status: number, text: string) => this.observeSessionCreate(identity, status, text) }
          : {}),
      },
      req,
      res,
      bufferedBody,
    )
  }

  private handleUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    void (async () => {
      const { session, deny } = await this.admit(req)
      if (deny) {
        socket.write(`HTTP/1.1 ${deny.status} Forbidden\r\nconnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      forwardUpgrade({ ...this.upstream!, session }, req, socket, head)
    })().catch(() => socket.destroy())
  }

  // ---- gateway-local routes ----

  private operatorIdentity: Identity | undefined

  private async handleLocalRoute(route: GatewayRoute, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if ((this.config.mode ?? 'passthrough') === 'passthrough') {
        // Loopback dev: the caller is the machine owner.
        this.operatorIdentity ??= {
          ...await this.ctx.tentacleIdentity.current(),
          roles: ['admin'],
        }
        await route.handler(req, res, { identity: this.operatorIdentity })
        return
      }
      if (route.public) {
        await route.handler(req, res, {})
        return
      }
      const session = this.sessionFrom(req)
      if (!session) {
        this.writeJson(res, 401, { error: 'authentication required' })
        return
      }
      await route.handler(req, res, { session, identity: session.identity })
    } catch (error) {
      this.ctx.logger?.warn?.('local route error', error instanceof Error ? error.message : error)
      if (!res.headersSent) this.writeJson(res, 400, { error: 'bad request' })
    }
  }

  /** Expose the body reader for local-route handlers. */
  readJsonBody(req: http.IncomingMessage, limit?: number): Promise<Buffer> {
    return this.readBody(req, limit)
  }

  // ---- auth API (never forwarded upstream) ----

  private async readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > limit) throw new Error('body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  private async handleAuthApi(path: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (path === WHOAMI_PATH) {
        const session = this.sessionFrom(req)
        this.writeJson(res, 200, session
          ? { authenticated: true, identity: session.identity }
          : { authenticated: false })
        return
      }
      if (req.method !== 'POST') {
        this.writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (!this.csrfOk(req)) {
        this.writeJson(res, 403, { error: 'csrf check failed' })
        return
      }

      if (path === LOGIN_PATH) {
        const body = JSON.parse((await this.readBody(req)).toString('utf8')) as { username?: string; password?: string }
        if (!body.username || !body.password) {
          this.writeJson(res, 400, { error: 'username and password required' })
          return
        }
        const identity = this.authenticator
          ? await this.authenticator.authenticate(body.username, body.password)
          : await this.configAdminIdentity(body.username, body.password)
        if (!identity) {
          this.writeJson(res, 401, { error: 'invalid credentials' })
          return
        }
        const session = this.sessions.mint(identity)
        const cookie = `${COOKIE_NAME}=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor((session.expiresAt - session.createdAt) / 1000)}`
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': cookie,
        })
        res.end(JSON.stringify({ authenticated: true, identity }))
        return
      }

      if (path === LOGOUT_PATH) {
        const session = this.sessionFrom(req)
        if (session) this.sessions.revoke(session)
        res.writeHead(204, {
          'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
    } catch (error) {
      // Never leak internals (design 02 §6: fixed vocabulary, no stack traces).
      this.ctx.logger?.warn?.('auth api error', error instanceof Error ? error.message : error)
      this.writeJson(res, 400, { error: 'bad request' })
    }
  }

  /** Config-envelope fallback when no authenticator is registered. */
  private async configAdminIdentity(username: string, password: string): Promise<Identity | undefined> {
    if (!this.config.adminPasswordEnvelope) return undefined
    if (username !== 'admin' || !verifyPassword(password, this.config.adminPasswordEnvelope)) return undefined
    const base = await this.ctx.tentacleIdentity.current()
    return { ...base, handle: 'admin', displayName: 'Administrator', roles: ['admin'] }
  }
}

export { filterSetCookies }
