/**
 * TentacleTenancy — cordis service wrapping the pure UserDirectory.
 *
 * Wiring (design 04): `tenancy → gateway + identity`. On start it registers
 * the directory as the gateway's Authenticator; disabling a user cascades
 * into session revocation through `Authenticator.onRevoke` — live
 * connections are destroyed immediately.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Service } from '@deepseek-ai/cordis'
// Type-only: pulls the `session/created` / `session/event` / `session/disposed`
// declarations into this compilation so the event names below are checked.
import type { Session as DshSession } from '@deepseek-ai/dsh-session'

type _SessionDeclarationAnchor = DshSession
import type { Identity, SubjectId } from '@tentacle/identity'
import type { GatewayRoute, PermissionPolicy } from '@tentacle/gateway'
import { TenancyPolicy } from './policy.js'
import { AgentLedger, intPolicy, QuotaGate, type QuotaDecision } from './quota.js'
import { UserDirectory, DirectoryError, type DirectoryDeps } from './directory.js'
import { PERMISSIONS } from './permissions.js'
import { createAdminRoutes } from './admin-api.js'
import { createAdminPageRoute } from './admin-page.js'
import { JsonFileRepo, type DirectoryRepo } from './repo.js'
import type { RoleTemplate, TenantUser } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleTenancy: TentacleTenancy
  }
}

/** Structural view of the gateway seam we plug into. */
interface GatewayLike {
  registerPolicy(policy: PermissionPolicy): () => void
  listSessions?(): ReadonlyArray<{ identity: Identity; createdAt: number; expiresAt: number }>
  registerAuthenticator(authenticator: {
    kind: string
    authenticate(username: string, password: string): Promise<Identity | undefined>
    onRevoke?(subjectId: SubjectId): void
  }): () => void
  registerRoute(route: GatewayRoute): () => void
  registerSessionObserver?(observer: (subjectId: string, sessionId: string) => void): () => void
}

export interface TentacleTenancyConfig {
  /** State root for the directory JSON. Default `<cwd>/.tentacle/tenancy`. */
  stateRoot?: string
  defaultTenant?: string
  bootstrapAdmin?: { username: string; passwordEnvelope: string }
}

export class TentacleTenancy extends Service {
  readonly directory: UserDirectory
  /** Live agents per subject and the two quota decisions (design 05 §2.4). */
  readonly ledger = new AgentLedger()
  readonly gate: QuotaGate

  /** Token spend of one subject plus quota facts, for the admin console. */
  usageOf(subjectId: SubjectId): { inputTokens: number; outputTokens: number; total: number; active: number; quota?: number; maxAgents?: number } {
    const usage = this.directory.usageOf(subjectId)
    const quota = intPolicy(this.directory.getPolicy(subjectId, 'token_quota'))
    const maxAgents = intPolicy(this.directory.getPolicy(subjectId, 'max_agents'))
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      total: usage.inputTokens + usage.outputTokens,
      active: this.ledger.activeCount(subjectId),
      ...(quota === undefined ? {} : { quota }),
      ...(maxAgents === undefined ? {} : { maxAgents }),
    }
  }

  async resetUsage(subjectId: SubjectId): Promise<void> {
    await this.directory.resetUsage(subjectId)
  }

  /** May this subject start one more agent? (channels consults this pre-dispatch) */
  canStartAgent(subjectId: SubjectId): QuotaDecision {
    return this.gate.canStartAgent(subjectId)
  }

  /** Attribute a channel session the router just claimed (quota + spend). */
  registerSession(subjectId: SubjectId, sessionId: string): void {
    this.ledger.register(subjectId, sessionId)
  }

  constructor(
    ctx: import('@deepseek-ai/cordis').Context,
    config: TentacleTenancyConfig = {},
    repo?: DirectoryRepo,
  ) {
    super(ctx, 'tentacleTenancy')
    const deps: DirectoryDeps = {
      repo: repo ?? new JsonFileRepo(config.stateRoot ?? dshHomePath('tentacle', 'tenancy')),
      defaultTenant: config.defaultTenant,
      bootstrapAdmin: config.bootstrapAdmin,
    }
    this.directory = new UserDirectory(deps)
    this.gate = new QuotaGate(this.directory, this.ledger)
  }

  protected async [Service.init](): Promise<void> {
    await this.directory.boot()
    // Token spend is accrued from the same durable events the token meter
    // replays: one usage-bearing assistant message per step. Attribution uses
    // the ledger (web sessions via the gateway observer, IM sessions via the
    // channels claim hook); unattributed sessions are ignored, never guessed.
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const subject = this.ledger.subjectOf(session.id)
      if (subject === undefined || event.data.usage === undefined) return
      void this.directory.recordUsage(subject, event.data.usage.inputTokens, event.data.usage.outputTokens)
        .catch((error: unknown) => this.ctx.logger?.warn?.('tentacle tenancy: usage ledger write failed', error instanceof Error ? error.message : String(error)))
    })
    this.ctx.on('session/disposed', (session) => {
      this.ledger.dispose(session.id)
    })

    // Optional dependency (king-bcolor's H7 idiom): a nested fiber with
    // inject activates only when the gateway is present and ready; without
    // it the directory still works (no login surface).
    this.ctx.inject(['tentacleGateway'], (gwCtx) => {
      const gateway = (gwCtx as unknown as { tentacleGateway: GatewayLike }).tentacleGateway
      this.gateway = gateway
      this.gatewaySessions = gateway.listSessions?.bind(gateway)
      const dispose = gateway.registerAuthenticator({
        kind: 'tenancy',
        authenticate: async (username, password) => {
          try {
            return await this.directory.authenticate(username, password)
          } catch (error) {
            if (error instanceof DirectoryError) return undefined
            throw error
          }
        },
        // onRevoke is assigned by the gateway: it points at the session store.
      })
      const disposeRoutes = [...createAdminRoutes(this), createAdminPageRoute()].map((route) => gateway.registerRoute(route))
      const disposePolicy = gateway.registerPolicy(new TenancyPolicy(this.directory, this.gate))
      const disposeObserver = gateway.registerSessionObserver?.((subjectId, sessionId) => {
        this.ledger.register(subjectId as SubjectId, sessionId)
      })
      this.ctx.logger?.info?.('tentacle tenancy: user directory plugged into gateway (authenticator + admin routes + workspace fence)')
      return () => {
        dispose()
        disposePolicy()
        disposeObserver?.()
        for (const d of disposeRoutes) d()
      }
    })
  }

  private gateway: GatewayLike | undefined
  /** Wired when the gateway is present; undefined otherwise. */
  gatewaySessions: (() => ReadonlyArray<{ identity: Identity; createdAt: number; expiresAt: number }>) | undefined

  /** Disable a user and revoke their live sessions immediately. */
  async disableUser(username: string): Promise<void> {
    const id = await this.directory.disable(username)
    this.revokeSessions(id)
  }

  /** Delete a user and revoke their live sessions immediately. */
  async deleteUser(username: string): Promise<void> {
    const id = await this.directory.deleteUser(username)
    this.revokeSessions(id)
  }

  /** Batch enable/disable/delete; revokes sessions of affected users. */
  async batchUsers(usernames: string[], action: 'enable' | 'disable' | 'delete') {
    const outcome = await this.directory.batch(usernames, action)
    for (const id of outcome.revoked) this.revokeSessions(id)
    return outcome.results
  }

  private revokeSessions(id: SubjectId): void {
    const auth = (this.gateway as unknown as { authenticator?: { onRevoke?(id: SubjectId): void } } | undefined)?.authenticator
    auth?.onRevoke?.(id)
  }

  listUsers(): readonly TenantUser[] {
    return this.directory.listUsers()
  }

  /** Permission catalog for the role editor (data-defined, design 05 §3). */
  permissionCatalog(): ReadonlyArray<{ key: string; category: string; labelZh: string; labelEn: string }> {
    return PERMISSIONS
  }

  listRoles(): readonly RoleTemplate[] {
    return this.directory.listRoles()
  }
}
