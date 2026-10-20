/**
 * OIDC browser SSO login for the tentacle gateway (design 01 D3).
 *
 * A parallel login path to username/password: two PUBLIC gateway routes drive
 * an authorization-code + PKCE flow through the OFFICIAL openid-client library
 * (protocol details — discovery, PKCE, ID-token verification, clock skew —
 * belong to it, not to a hand copy), and a successful login mints a session
 * through the gateway's own `createSession` (same store, cookie and revocation
 * cascade as the built-in login).
 *
 * Identity mapping: the OIDC pair (iss, sub) is stable, so the subject id is
 * `did:oidc:<sha256(iss|sub) truncated>` — a plain, non-key DID method. It is
 * deliberately NOT a synthesized did:key (there is no keypair behind it); a
 * key-shaped id without a key would be a lie.
 *
 * Transactions (state/verifier/nonce) live in host memory only, bound to an
 * HttpOnly cookie and expired on sight: a restart logs nobody out, it just
 * makes in-flight logins start over.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as oidc from 'openid-client'
import { Service } from '@deepseek-ai/cordis'
import { subjectId, tenantId, type Identity } from '@tentacle/identity'
import type { GatewayRoute } from './gateway-types.js'

const TX_COOKIE = 'tentacle-oidc-tx'
const START_PATH = '/tentacle/auth/oidc/start'
const CALLBACK_PATH = '/tentacle/auth/oidc/callback'
const TX_TTL_MS = 10 * 60_000
const TX_CAP = 256

export interface TentacleOidcConfig {
  /** IdP issuer URL, e.g. https://accounts.google.com — discovery base. */
  readonly issuer?: string
  readonly clientId?: string
  readonly clientSecret?: string
  /**
   * Where the IdP redirects back. Defaults to
   * `<gateway origin>/tentacle/auth/oidc/callback`.
   */
  readonly redirectUri?: string
  /** Scopes; `openid` is always requested. */
  readonly scope?: string
  /** Tenant the SSO identity belongs to (default `local`). */
  readonly tenant?: string
  /** Role assigned to SSO identities (default `member`). */
  readonly role?: string
  /** Claim carrying the tenant (overrides `tenant`). */
  readonly tenantClaim?: string
  /**
   * Allow a plain-HTTP issuer (loopback tests, air-gapped self-hosted IdPs).
   * The library is HTTPS-only by default; this is the vendor's own switch.
   */
  readonly allowInsecureIssuer?: boolean
}

interface Transaction {
  readonly verifier: string
  readonly nonce: string
  readonly createdAt: number
}

export class TentacleOidc extends Service {
  static inject = ['tentacleGateway']

  private readonly transactions = new Map<string, Transaction>()
  private config!: oidc.Configuration | undefined
  private routes: Array<() => void> = []

  constructor(
    ctx: import('@deepseek-ai/cordis').Context,
    private readonly settings: TentacleOidcConfig = {},
  ) {
    super(ctx, 'tentacleOidc')
  }

  protected async [Service.init](): Promise<void> {
    const gateway = (this.ctx as unknown as { tentacleGateway: {
      registerRoute(route: GatewayRoute): () => void
    } }).tentacleGateway
    if (gateway === undefined) throw new Error('tentacle oidc: requires @tentacle/gateway in the composition')
    if (this.settings.issuer === undefined || this.settings.issuer === '' || this.settings.clientId === undefined || this.settings.clientId === '') {
      // An optional login path stays INERT until a deployment configures it:
      // the gateway is fully usable without SSO, so an unconfigured provider
      // must not fail the boot. A configured-but-broken issuer still throws.
      this.ctx.logger?.info?.('tentacle oidc: no issuer/clientId configured — SSO login stays inactive')
      return
    }
    try {
      this.config = await oidc.discovery(
        new URL(this.settings.issuer),
        this.settings.clientId,
        this.settings.clientSecret === undefined ? {} : { client_secret: this.settings.clientSecret },
        undefined,
        {
          // A booting deployment whose IdP is briefly down must fail loudly, not
          // serve a half-registered SSO path. Plain-HTTP issuers opt in
          // explicitly through the vendor's own escape hatch.
          ...(this.settings.allowInsecureIssuer === true ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      )
    } catch (error) {
      throw new Error(`tentacle oidc: discovery failed for ${this.settings.issuer}: ${(error as Error).message}`)
    }
    this.routes = [
      gateway.registerRoute({ prefix: START_PATH, public: true, handler: (req, res) => void this.start(req, res) }),
      gateway.registerRoute({ prefix: CALLBACK_PATH, public: true, handler: (req, res) => void this.callback(req, res) }),
    ]
    this.ctx.effect(() => () => {
      for (const dispose of this.routes) dispose()
    }, 'tentacleOidc.routes()')
    // Completing init is readiness: the routes above are the whole surface.
  }

  /** `GET .../start` → 303 to the IdP with a fresh PKCE transaction in a cookie. */
  private async start(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const configuration = this.requireConfig()
      const origin = this.originOf(req)
      const redirectUri = this.settings.redirectUri ?? `${origin}${CALLBACK_PATH}`
      const state = randomBytes(24).toString('base64url')
      const nonce = randomBytes(24).toString('base64url')
      const verifier = oidc.randomPKCECodeVerifier()
      const challenge = await oidc.calculatePKCECodeChallenge(verifier)
      this.remember(state, { verifier, nonce, createdAt: Date.now() })
      const url = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: `openid ${this.settings.scope ?? ''}`.trim(),
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      this.redirect(res, url.href, { [TX_COOKIE]: `${state}.${TX_TTL_MS}` })
    } catch (error) {
      this.fail(res, error)
    }
  }

  /** `GET .../callback?code&state` → ID token verified → gateway session minted. */
  private async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const configuration = this.requireConfig()
      const url = new URL(req.url ?? '/', this.originOf(req))
      if (url.searchParams.get('error') !== null) {
        this.redirect(res, '/?sso=denied')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const txState = this.cookieTx(req)
      if (code === null || code === '' || state === null || state === '' || txState === undefined || state !== txState) {
        throw new OidcLoginError('state-mismatch')
      }
      const transaction = this.take(state)
      if (transaction === undefined) throw new OidcLoginError('state-mismatch')
      const origin = this.originOf(req)
      const redirectUri = this.settings.redirectUri ?? `${origin}${CALLBACK_PATH}`
      // openid-client verifies the ID token signature, issuer, audience, nonce
      // and exp — the entire reason this library is used.
      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers
      try {
        // All three checks travel in the `checks` argument: the library then
        // verifies PKCE, state and nonce against the signed ID token itself.
        tokens = await oidc.authorizationCodeGrant(
          configuration,
          new URL(url.href),
          {
            pkceCodeVerifier: transaction.verifier,
            expectedState: state,
            expectedNonce: transaction.nonce,
          },
        )
      } catch {
        throw new OidcLoginError('token-exchange-failed')
      }
      const claims = tokens.claims()
      if (claims === undefined || typeof claims.sub !== 'string' || claims.sub === '') {
        throw new OidcLoginError('no-claims')
      }
      const identity = this.identityOf(claims)
      const session = (this.ctx as unknown as { tentacleGateway: { createSession(identity: Identity): { token: string; expiresAt: number; createdAt: number } } })
        .tentacleGateway.createSession(identity)
      // The tx cookie is consumed; the gateway session cookie takes over.
      res.appendHeader('set-cookie', `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
      res.appendHeader(
        'set-cookie',
        `tentacle-session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}`,
      )
      this.redirect(res, '/?sso=ok')
    } catch (error) {
      this.fail(res, error)
    }
  }

  /** (iss, sub) → a stable, non-key DID; claims fill the display fields. */
  private identityOf(claims: oidc.IDToken): Identity {
    const iss = typeof claims.iss === 'string' ? claims.iss : this.settings.issuer
    const digest = createHash('sha256').update(`${iss}|${claims.sub}`).digest('hex').slice(0, 40)
    const tenantClaim = this.settings.tenantClaim
    const tenant = tenantClaim !== undefined && typeof claims[tenantClaim] === 'string'
      ? claims[tenantClaim] as string
      : (this.settings.tenant ?? 'local')
    const handle = typeof claims.preferred_username === 'string' && claims.preferred_username !== ''
      ? claims.preferred_username
      : typeof claims.email === 'string' ? claims.email : undefined
    const name = typeof claims.name === 'string' && claims.name !== '' ? claims.name : handle
    return {
      subjectId: subjectId(`did:oidc:${digest}`),
      tenant: tenantId(tenant),
      ...(handle === undefined ? {} : { handle }),
      ...(name === undefined ? {} : { displayName: name }),
      roles: [this.settings.role ?? 'member'],
      createdAt: Date.now(),
    }
  }

  private requireConfig(): oidc.Configuration {
    if (this.config === undefined) throw new OidcLoginError('not-configured')
    return this.config
  }

  private remember(state: string, transaction: Transaction): void {
    // Expire-on-sight + a hard cap: a login flood cannot grow memory.
    for (const [key, tx] of this.transactions) {
      if (Date.now() - tx.createdAt > TX_TTL_MS) this.transactions.delete(key)
    }
    while (this.transactions.size >= TX_CAP) {
      const oldest = this.transactions.keys().next().value
      if (oldest === undefined) break
      this.transactions.delete(oldest)
    }
    this.transactions.set(state, transaction)
  }

  private take(state: string): Transaction | undefined {
    const transaction = this.transactions.get(state)
    this.transactions.delete(state)
    if (transaction === undefined || Date.now() - transaction.createdAt > TX_TTL_MS) return undefined
    return transaction
  }

  private cookieTx(req: IncomingMessage): string | undefined {
    const pair = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((c) => c.startsWith(`${TX_COOKIE}=`))
    return pair?.slice(TX_COOKIE.length + 1).split('.')[0]
  }

  private originOf(req: IncomingMessage): string {
    const host = req.headers.host ?? '127.0.0.1'
    return `http://${host}`
  }

  private redirect(res: ServerResponse, location: string, cookie?: Record<string, string>): void {
    const headers: Record<string, string> = { location, 'cache-control': 'no-store' }
    if (cookie !== undefined) {
      for (const [name, value] of Object.entries(cookie)) {
        res.appendHeader('set-cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(TX_TTL_MS / 1000)}`)
      }
    }
    res.writeHead(303, headers)
    res.end()
  }

  /** Stable public failure page: a reason code, never provider internals. */
  private fail(res: ServerResponse, error: unknown): void {
    const code = error instanceof OidcLoginError ? error.code : 'login-failed'
    this.ctx.logger?.warn?.(`tentacle oidc: login failed (${code})`)
    if (!res.headersSent) this.redirect(res, `/?sso=${code}`)
  }
}

export class OidcLoginError extends Error {
  constructor(readonly code: 'state-mismatch' | 'token-exchange-failed' | 'no-claims' | 'not-configured') {
    super(code)
    this.name = 'OidcLoginError'
  }
}
