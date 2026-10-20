/**
 * Opaque forwarder (design 02 §4), adapted from the proven header/cookie
 * hygiene of dsh-isolated-runtime's connector/proxy.ts:
 *
 * - outbound headers are allow-listed; client cookie/authorization/host/
 *   origin/x-* are stripped and the upstream's own auth cookie is injected
 * - handshake timeouts only (connect 5s / response-head 30s); established
 *   model streams and WebSockets never get a blanket duration cap — the
 *   outcome of a timed-out write is unknowable, so it must not be treated
 *   as an interrupt
 * - session revocation aborts in-flight streams via the session's AbortSignal
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { GatewaySession } from './types.js'

const CONNECT_TIMEOUT_MS = 5_000
const HEADERS_TIMEOUT_MS = 30_000
/** JSON responses larger than this are streamed unobserved (see `observeJson`). */
const JSON_TEE_CAP = 2 * 1024 * 1024

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export class UpstreamAuth {
  private cookie: string | undefined

  constructor(
    /** Loopback base URL carrying the process launch token (`?token=…`). */
    private readonly authenticatedUrl: string,
  ) {}

  /** Exchange the launch token for the authority-bound `dsh-auth-*` cookie. */
  async bootstrap(): Promise<void> {
    const url = new URL(this.authenticatedUrl)
    const setCookies = await new Promise<string[]>((resolvePromise, reject) => {
      const req = http.request({
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, connection: 'close' },
        timeout: CONNECT_TIMEOUT_MS,
      }, (res) => {
        res.resume() // drain and let 'close' free the socket
        resolvePromise(res.headers['set-cookie'] ?? [])
      })
      req.once('error', reject)
      req.once('timeout', () => { req.destroy(); reject(new Error('tentacle gateway: upstream token exchange timed out')) })
      req.end()
    })
    const authCookies = setCookies
      .map((line) => line.split(';', 1)[0]!)
      .filter((pair) => pair.startsWith('dsh-auth-'))
    if (authCookies.length === 0) {
      throw new Error('tentacle gateway: upstream did not issue a dsh-auth-* cookie on token exchange')
    }
    this.cookie = authCookies.join('; ')
  }

  get sessionCookie(): string {
    if (!this.cookie) throw new Error('tentacle gateway: upstream auth not bootstrapped')
    return this.cookie
  }
}

/** Build the sanitized outbound headers for one forwarded request. */
export function outboundHeaders(req: http.IncomingMessage, upstreamHost: string, authCookie: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'cookie' || lower === 'authorization') continue
    if (lower === 'host' || lower === 'origin' || lower === 'forwarded') continue
    if (lower.startsWith('x-')) continue
    out[lower] = value
  }
  out['host'] = upstreamHost
  out['cookie'] = authCookie
  return out
}

/** Set-Cookie lines the gateway may pass back to the browser. */
export function filterSetCookies(lines: string[]): string[] {
  return lines.filter((line) => {
    const name = line.split('=', 1)[0]!.trim()
    if (!name.startsWith('dsh-auth-')) return false
    if (/domain\s*=/i.test(line)) return false
    return true
  })
}

export interface ForwardContext {
  upstreamHost: string
  upstreamPort: number
  auth: UpstreamAuth
  /** Owning session — its abort destroys in-flight upstream work. */
  session?: GatewaySession
  /**
   * Observe ONE successful JSON response (the gateway tees it, bounded) — used
   * to learn the session id that `session.create` minted without parsing every
   * stream. Never called for non-JSON, oversized or error responses.
   */
  observeJson?: (status: number, text: string) => void
}

/** Host header upstream: authority includes the port (cookie is authority-bound). */
export function upstreamAuthority(ctx: ForwardContext): string {
  return ctx.upstreamPort === 80 ? ctx.upstreamHost : `${ctx.upstreamHost}:${ctx.upstreamPort}`
}

/** Forward one HTTP request and stream the response back. */
export function forwardHttp(ctx: ForwardContext, req: http.IncomingMessage, res: http.ServerResponse, bufferedBody?: Buffer): void {
  const headers = outboundHeaders(req, upstreamAuthority(ctx), ctx.auth.sessionCookie)
  if (bufferedBody !== undefined) {
    // The policy layer already consumed the body; replay it with an exact
    // length and drop any client-supplied transfer framing.
    delete headers['transfer-encoding']
    headers['content-length'] = String(bufferedBody.length)
  }
  const upstream = http.request({
    host: ctx.upstreamHost,
    port: ctx.upstreamPort,
    method: req.method,
    path: req.url,
    headers,
    timeout: HEADERS_TIMEOUT_MS,
  })

  const destroy = (): void => {
    upstream.destroy()
    if (!res.destroyed) res.destroy()
  }
  ctx.session?.controller.signal.addEventListener('abort', destroy, { once: true })
  req.on('aborted', destroy)

  upstream.setTimeout(HEADERS_TIMEOUT_MS, () => destroy())
  upstream.on('response', (up) => {
    const headers = { ...up.headers }
    if (headers['set-cookie']) {
      const filtered = filterSetCookies(Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [String(headers['set-cookie'])])
      if (filtered.length > 0) headers['set-cookie'] = filtered
      else delete headers['set-cookie']
    }
    headers['cache-control'] = 'no-store'
    res.writeHead(up.statusCode ?? 502, up.statusMessage, headers)
    const contentType = String(headers['content-type'] ?? '')
    if (ctx.observeJson !== undefined && contentType.includes('application/json')) {
      // Bounded tee: a JSON response we want to inspect is small; anything
      // larger than the cap is streamed through unobserved instead.
      const chunks: Buffer[] = []
      let size = 0
      let observed = true
      up.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        size += chunk.length
        if (size > JSON_TEE_CAP) observed = false
      })
      up.on('end', () => {
        const body = Buffer.concat(chunks)
        if (observed) {
          try {
            ctx.observeJson!(up.statusCode ?? 502, body.toString('utf8'))
          } catch {
            // Observation is best-effort; the response is already headed.
          }
        }
        if (!res.writableEnded) res.end(body)
      })
      up.on('error', destroy)
      return
    }
    up.pipe(res)
    up.on('error', destroy)
  })
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('tentacle gateway: upstream unreachable\n')
    } else {
      res.destroy()
    }
  })
  if (bufferedBody !== undefined) {
    upstream.end(bufferedBody)
  } else {
    req.pipe(upstream)
  }
}

/**
 * Forward a WebSocket upgrade: replay the client's handshake upstream with
 * sanitized headers, relay the 101 response, then pipe raw bytes both ways.
 */
export function forwardUpgrade(ctx: ForwardContext, req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
  const upstreamSocket = net.connect(ctx.upstreamPort, ctx.upstreamHost)

  const destroyAll = (): void => {
    upstreamSocket.destroy()
    clientSocket.destroy()
  }
  ctx.session?.controller.signal.addEventListener('abort', destroyAll, { once: true })

  const handshakeTimer = setTimeout(destroyAll, CONNECT_TIMEOUT_MS)
  handshakeTimer.unref?.()

  upstreamSocket.once('connect', () => {
    const headers = outboundHeaders(req, upstreamAuthority(ctx), ctx.auth.sessionCookie)
    headers['connection'] = 'Upgrade'
    headers['upgrade'] = req.headers['upgrade'] ?? 'websocket'
    let request = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [String(value)]) request += `${name}: ${v}\r\n`
    }
    request += '\r\n'
    upstreamSocket.write(request)
    if (head.length > 0) upstreamSocket.write(head)
  })

  let handshakeDone = false
  upstreamSocket.on('data', (chunk) => {
    // Until the 101 completes we must not pipe blindly: relay the upstream's
    // response head verbatim, then switch to raw piping.
    if (!handshakeDone) {
      handshakeDone = true
      clearTimeout(handshakeTimer)
      clientSocket.write(chunk)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    }
  })
  upstreamSocket.on('error', destroyAll)
  clientSocket.on('error', destroyAll)
  clientSocket.on('close', () => upstreamSocket.destroy())
}

/** Stable request fingerprint for audit lines — never log tokens. */
export function requestFingerprint(req: http.IncomingMessage): string {
  return createHash('sha256').update(`${req.method} ${req.url} ${req.headers['user-agent'] ?? ''}`).digest('hex').slice(0, 12)
}
