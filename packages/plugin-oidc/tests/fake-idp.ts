/**
 * A minimal REAL-HTTP OIDC IdP for tests: discovery document, an authorize
 * endpoint that immediately redirects back with a code, a token endpoint
 * returning an RS256-signed ID token, and the matching JWKS. The point is to
 * drive the REAL openid-client (signature verification included), not a mock
 * of it.
 */
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface FakeIdpOptions {
  /** Extra claims merged into the ID token. */
  readonly claims?: Record<string, unknown>
  /** Reject the token exchange with this OAuth error (still signed JSON). */
  readonly tokenError?: string
}

export class FakeOidcIdp {
  private readonly server: Server
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private readonly kid = randomUUID()
  readonly codes = new Map<string, string>()

  baseUrl = ''

  constructor(private readonly options: FakeIdpOptions = {}) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl)
    const json = (payload: unknown, status = 200): void => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
      res.end(text)
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json({
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        jwks_uri: `${this.baseUrl}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      const jwk = this.keys.publicKey.export({ format: 'jwk' })
      json({ keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] })
      return
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      // Approve instantly: redirect back with a single-use code.
      const code = randomUUID()
      this.codes.set(code, url.searchParams.get('nonce') ?? '')
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const code = body.get('code') ?? ''
      const nonce = this.codes.get(code)
      if (nonce === undefined) {
        json({ error: 'invalid_grant' }, 400)
        return
      }
      this.codes.delete(code)
      if (this.options.tokenError !== undefined) {
        json({ error: this.options.tokenError }, 400)
        return
      }
      const idToken = this.signIdToken(body.get('client_id') ?? '', nonce)
      json({ access_token: 'at-fake', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
      return
    }
    json({ error: 'not_found' }, 404)
  }

  private signIdToken(audience: string, nonce: string): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: this.baseUrl,
      sub: 'user-42',
      aud: audience,
      exp: now + 300,
      iat: now,
      nonce,
      preferred_username: 'ada',
      name: 'Ada Lovelace',
      ...(this.options.claims ?? {}),
    }
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const signingInput = `${encode(header)}.${encode(payload)}`
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.keys.privateKey)
    return `${signingInput}.${signature.toString('base64url')}`
  }
}
