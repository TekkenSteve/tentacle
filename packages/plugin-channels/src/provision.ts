/**
 * Quick-setup (QR) provisioning for channel instances (design 08 §1).
 *
 * A platform may declare a ProvisionFlow: the operator starts it from the
 * console, a QR code appears, the platform-side user scans it, and the next
 * poll returns the credentials — which the HOST turns into a created and
 * enabled instance. The operator never copies a secret by hand.
 *
 * Security shape (mirrors the reference implementation's dingtalk device-code flow):
 *  - platform secrets (device codes, session tokens) live ONLY in the
 *    in-memory session (`data`), never in a response body;
 *  - a session is bound to the actor who started it: another actor polling it
 *    sees `no-such-flow`, not a hint that it exists;
 *  - sessions are short-lived (the platform's own TTL) and one live session
 *    per actor — starting a new one cancels the previous.
 */
import { randomUUID } from 'node:crypto'
import type { TenantId } from '@tentacle/identity'
import type { ChannelTarget, ChannelType } from './types.js'

/** One in-progress provisioning session (host memory only). */
export interface ProvisionSession {
  readonly flowId: string
  readonly channelType: ChannelType
  readonly tenant: TenantId
  /** The actor who started the flow; polls by anyone else are refused. */
  readonly actor: { readonly tenant: TenantId; readonly isAdmin: boolean }
  readonly createdAt: number
  /**
   * When set, a success REPAIRS this existing instance (credential rotation
   * after a platform session expiry) instead of creating a new one. The
   * console offers the same QR wizard on an instance's connection section for
   * exactly this: re-scan must not leave duplicate instances behind.
   */
  readonly instanceId?: string
  /** Routing target to bind when a NEW instance is created (ignored in repair). */
  readonly target?: ChannelTarget
  /** Platform TTL, applied after `flow.start` reports it (mutable by the host only). */
  expiresAt: number
  /** Platform-flow-private state (device codes, platform tokens) — never serialized. */
  data: unknown
}

/** What `start` reports to the console: everything the QR screen needs. */
export interface ProvisionStart {
  readonly qrUrl?: string
  readonly userCode?: string
  readonly message?: string
  /** Suggested client poll interval (default 2000ms, the reference implementation's cadence). */
  readonly pollAfterMs?: number
  /** When the platform-side session expires (epoch ms). */
  readonly expiresAt: number
}

/** One poll's outcome. `success` carries the secrets ONCE — straight into the credential store. */
export type ProvisionPoll =
  | { readonly state: 'waiting'; readonly qrUrl?: string; readonly userCode?: string; readonly message?: string }
  | { readonly state: 'success'; readonly name?: string; readonly credentials: Record<string, string>; readonly config?: Record<string, unknown> }
  | { readonly state: 'failed'; readonly error: string }
  | { readonly state: 'expired' }

/**
 * One platform's quick-setup flow. Implementations keep their platform state
 * on `session.data` and MUST NOT persist anything outside the session: a
 * stopped or expired session leaves no residue.
 */
export interface ProvisionFlow {
  readonly channelType: ChannelType
  /** Begin the platform flow; may be called again after a restart of the wizard. */
  start(session: ProvisionSession): Promise<ProvisionStart>
  /** Advance the state machine once. Called only by the console's poll. */
  poll(session: ProvisionSession): Promise<ProvisionPoll>
  /** Cancel/cleanup (the wizard closing, a new flow replacing this one). */
  stop?(session: ProvisionSession): Promise<void>
}

/** The status projection the admin API returns (never the platform secrets). */
export type ProvisionStatus =
  | { readonly state: 'pending' | 'waiting'; readonly flowId: string; readonly qrUrl?: string; readonly userCode?: string; readonly message?: string; readonly pollAfterMs?: number }
  | { readonly state: 'success'; readonly flowId: string; readonly instance: unknown }
  | { readonly state: 'failed'; readonly flowId: string; readonly error: string }
  | { readonly state: 'expired'; readonly flowId: string }

export class ProvisionError extends Error {
  constructor(readonly code: 'no-provision-flow' | 'no-such-flow', message: string) {
    super(message)
    this.name = 'ProvisionError'
  }
}

/** In-memory session table with expiry and per-actor singularity. */
export class ProvisionSessions {
  private readonly sessions = new Map<string, ProvisionSession>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `prov-${randomUUID()}`,
  ) {}

  /** The actor's live session, if any (expired ones are pruned on sight). */
  liveOf(actor: { tenant: TenantId; isAdmin: boolean }): ProvisionSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.actor.tenant === actor.tenant && session.actor.isAdmin === actor.isAdmin) {
        if (session.expiresAt > this.now()) return session
        this.sessions.delete(session.flowId)
      }
    }
    return undefined
  }

  get(flowId: string): ProvisionSession | undefined {
    return this.sessions.get(flowId)
  }

  /** Create a session, replacing (and returning) the actor's previous one. */
  begin(
    channelType: ChannelType,
    actor: { tenant: TenantId; isAdmin: boolean },
    expiresAt: number,
    instanceId?: string,
    target?: ChannelTarget,
  ): { session: ProvisionSession; previous: ProvisionSession | undefined } {
    const previous = this.liveOf(actor)
    this.sessions.delete(previous?.flowId ?? '')
    const session: ProvisionSession = {
      flowId: this.newId(),
      channelType,
      tenant: actor.tenant,
      actor,
      createdAt: this.now(),
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(target === undefined ? {} : { target }),
      expiresAt,
      data: undefined,
    }
    this.sessions.set(session.flowId, session)
    return { session, previous }
  }

  /** Expire one session on sight; false when absent. */
  drop(flowId: string): boolean {
    return this.sessions.delete(flowId)
  }
}
