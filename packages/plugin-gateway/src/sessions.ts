/**
 * Session store (design 02 §3, copying the proven patterns from
 * GuoMonth/dsh-multi-tenant's platform/sessions.ts):
 *
 * - tokens minted random, only sha256 fingerprints stored
 * - revocation is an AbortSignal cascade: destroying a session destroys every
 *   live HTTP stream / WebSocket it owns, immediately
 * - replace-permissions-then-revoke ordering leaves no async gap
 * - expired sessions are reaped lazily on access plus a periodic sweep
 */
import { newSessionToken, tokenFingerprint } from '@tentacle/crypto'
import type { GatewaySession } from './types.js'
import type { Identity } from '@tentacle/identity'

const MAX_SESSIONS = 1024

export class SessionStore {
  private byFingerprint = new Map<string, GatewaySession>()
  private sweeper: NodeJS.Timeout | undefined

  constructor(private readonly ttlMs: number) {}

  start(): void {
    this.sweeper = setInterval(() => this.reap(), Math.min(this.ttlMs, 60_000))
    this.sweeper.unref?.()
  }

  mint(identity: Identity): GatewaySession {
    if (this.byFingerprint.size >= MAX_SESSIONS) this.reap()
    if (this.byFingerprint.size >= MAX_SESSIONS) {
      throw new Error('tentacle gateway: session table full')
    }
    const token = newSessionToken()
    const session: GatewaySession = {
      token,
      identity,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      controller: new AbortController(),
    }
    this.byFingerprint.set(tokenFingerprint(token), session)
    return session
  }

  authenticate(token: string | undefined): GatewaySession | undefined {
    if (!token) return undefined
    const session = this.byFingerprint.get(tokenFingerprint(token))
    if (!session) return undefined
    if (session.expiresAt <= Date.now()) {
      this.revoke(session)
      return undefined
    }
    return session
  }

  /** Revoke a session and destroy its live connections. Idempotent. */
  revoke(session: GatewaySession): void {
    const fp = tokenFingerprint(session.token)
    if (!this.byFingerprint.delete(fp)) return
    session.controller.abort()
  }

  /** Revoke every session belonging to a subject (user disabled / logout-all). */
  revokeSubject(subjectId: string): number {
    let count = 0
    for (const session of [...this.byFingerprint.values()]) {
      if (session.identity.subjectId === subjectId) {
        this.revoke(session)
        count++
      }
    }
    return count
  }

  /** Active sessions snapshot for admin surfaces (identities only, never tokens). */
  snapshot(): ReadonlyArray<{ identity: GatewaySession['identity']; createdAt: number; expiresAt: number }> {
    const now = Date.now()
    return [...this.byFingerprint.values()]
      .filter((s) => s.expiresAt > now)
      .map((s) => ({ identity: s.identity, createdAt: s.createdAt, expiresAt: s.expiresAt }))
  }

  private reap(): void {
    const now = Date.now()
    for (const session of [...this.byFingerprint.values()]) {
      if (session.expiresAt <= now) this.revoke(session)
    }
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const session of [...this.byFingerprint.values()]) this.revoke(session)
    this.byFingerprint.clear()
  }
}
