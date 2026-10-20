/**
 * TentacleChannels — cordis service for IM channel access
 * (design: docs/design/06-channels.md, 07-channel-admin.md).
 *
 * Wiring (06 §4, 07 §1):
 *
 *   lifecycle  store (official storage domain) → migrate/seed → start enabled instances
 *   inbound    adapter → router → binding lookup (per instance) → `ctx.webhookRuntime.dispatch`
 *   session    `ctx.on('session/created' | 'session/event')` → conversation link → turn/end aggregation
 *   outbound   router → adapter (selected by the conversation's channelId) → platform
 *   admin      Registry CRUD + probe + enable/disable, exposed at `/tentacle/api/admin/channels`
 *
 * Degradation is explicit rather than silent:
 *
 * - `tentacleTenancy` is REQUIRED. Binding an IM identity to a tenant user is
 *   the whole access-control story; without a directory the plugin must not
 *   come up pretending to have one (06 §5).
 * - `webhookRuntime` is REQUIRED: a message that cannot reach an agent is not
 *   a feature, so its absence is a hard startup failure.
 * - `tentacleGateway` is optional (nested inject): channels keep working
 *   without it, the admin REST surface just stays unregistered. Push-platform
 *   (feishu) instances are the exception: their public callback route needs
 *   the gateway, so they report `failed` until one is mounted.
 * - The credentials service is optional to BOOT but required to run a channel:
 *   an instance whose token cannot be resolved reports `failed` on the console
 *   instead of preventing the console from coming up.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `session/created` / `session/event` declarations into
// this compilation so the feed is checked against the real event map.
import type { Session } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { tenantId, type SubjectId, type TenantId } from '@tentacle/identity'
import type { GatewayRoute } from '@tentacle/gateway'
import { FeishuProvisionFlow } from './provision/feishu.js'
import { DingTalkProvisionFlow } from './provision/dingtalk.js'
import { WeComProvisionFlow } from './provision/wecom.js'
import { QQProvisionFlow } from './provision/qq.js'
import { WeixinProvisionFlow } from './provision/weixin.js'
import { YuanbaoProvisionFlow } from './provision/yuanbao.js'
import {
  ProvisionError,
  ProvisionSessions,
  type ProvisionFlow,
  type ProvisionSession as ProvisionSessionLike,
  type ProvisionStatus,
} from './provision.js'
import { BindingStore, type TenancyDirectory } from './bindings.js'
import { createChannelRoutes } from './admin-api.js'
import { RecordCredentials, UnavailableCredentials, type CredentialValues, type InstanceCredentials } from './credentials.js'
import {
  allSchemas,
  normalizeTenant,
  requireChannelType,
  requireTarget,
  requiredCredentials,
  validateConfig,
  validateCredentials,
  type ChannelInstance,
  type ChannelTypeSchema,
  ChannelError,
} from './instances.js'
import { ChannelRegistry, type ChannelActor } from './registry.js'
import { bindingKey, type ChannelsStore, type ConversationLink, type PendingSender } from './repo.js'
import { openChannelsStore } from './storage.js'
import { TelegramAdapter } from './adapter/telegram.js'
import { createTelegramApi } from './adapter/telegram-api.js'
import { FeishuAdapter } from './adapter/feishu.js'
import { DingTalkAdapter } from './adapter/dingtalk.js'
import { WeComAdapter } from './adapter/wecom.js'
import { QQAdapter } from './adapter/qq.js'
import { WeixinAdapter } from './adapter/weixin.js'
import { YuanbaoAdapter } from './adapter/yuanbao.js'
import { DiscordAdapter } from './adapter/discord.js'
import { SessionRouter, type AgentRegistryPort, type SessionEventSink, type SessionRoute, type WebhookDispatchPort } from './router/router.js'
import type { ChannelAdapter, ChannelTarget, ChannelType, InboundMessage, OffsetStore } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleChannels: TentacleChannels
  }
}

/** Structural view of the tenancy seam this service needs (read-only). */
interface TenancyLike {
  readonly directory: TenancyDirectory & {
    getPolicy(subjectId: SubjectId, name: 'workspace_root_dir'): string | undefined
  }
  /** Quota gate (design 05 §2.4); optional so structural fakes stay small. */
  canStartAgent?(subjectId: SubjectId): { readonly ok: boolean; readonly reason?: string }
  /** Attribute a claimed channel session to its owner in the quota ledger. */
  registerSession?(subjectId: SubjectId, sessionId: string): void
}

/** Structural view of the gateway seam (optional dependency). */
interface GatewayLike {
  registerRoute(route: GatewayRoute): () => void
}

/** Structural view of the official webhook runtime seam. */
interface WebhookDispatchPortLike {
  register(rule: unknown): () => Promise<void>
  dispatch(delivery: unknown): void
}

/** Structural view of the agent seam, used to continue a live conversation. */
interface AgentsLike {
  get(sessionId: string): { followup(message: unknown): void } | undefined
}

/**
 * The DEPLOYMENT seed: the static profile config an operator used before
 * instances existed (design 07 §8). Read once, materialized as one instance,
 * never consulted again — otherwise deleting that instance in the console
 * would resurrect it on the next boot.
 */
export interface TelegramChannelConfig {
  readonly enabled?: boolean
  readonly tokenRef?: string
  readonly token?: string
  readonly apiBaseUrl?: string
  readonly pollTimeoutSec?: number
  readonly typing?: boolean
}

/** What the persona service exposes to channel routing (design 09). */
export interface ExpertRoutingApi {
  /**
   * Resolves once the expert library is planted and mounted. Channels wait on
   * this before migrating bindings or starting adapters: an expert resolved
   * from a half-initialised library would create a preset-less session.
   */
  readonly ready: Promise<void>
  /** The expert a channel with no recorded binding is migrated onto. */
  readonly defaultExpertId: string
  resolveForSession(expertId: string): SessionRoute | undefined
  listExpertRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[]
  /**
   * Register a veto over expert deletion — channels point at experts, so an
   * expert that is still routed to must not disappear (design 09 §3.4).
   * Returns the disposer.
   */
  registerExpertRemovalGuard(guard: (expertId: string) => string | undefined): () => void
}

/**
 * What the team service exposes to channel routing (design 10 §7). Same seam
 * shape as persona: resolve one team's session route, list the routable
 * teams for the console, and veto deletion of a team a channel points at.
 */
export interface TeamRoutingApi {
  readonly ready: Promise<void>
  resolveForSession(teamId: string): SessionRoute | undefined
  listTeamRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[]
  /** Register a veto over team deletion — channels point at teams too. */
  registerRemovalGuard(guard: (teamId: string) => string | undefined): () => void
}

export interface TentacleChannelsConfig {
  /** Legacy state root: where the pre-instances `channels.json` lives (import only). */
  readonly stateRoot?: string
  /**
   * Root directory for sessions created from channel messages. Per-user
   * `workspace_root_dir` policies (tenancy design 05) win over this value.
   */
  readonly workspaceRoot?: string
  /** Tenant that owns deployment-seeded instances (default `local`). */
  readonly tenant?: string
  /** Official agent preset every channel session is composed from. */
  readonly agentPreset?: string
  /**
   * Permission preset pinned onto every channel session. Fixed by design
   * (06 §3): a channel message must never pick its own sandbox level.
   */
  readonly permissionPreset?: string
  /** Reply to an unbound sender with guidance instead of silently dropping. */
  readonly replyToUnbound?: boolean
  readonly unboundReply?: string
  readonly sessionTimeoutReply?: string
  readonly dispatchFailureReply?: string
  readonly turnErrorReply?: string
  /** Replies for the `/bind <code>` self-service flow (design 06 §5). */
  /** Sent when the subject's quota (max_agents / token_quota) refuses a prompt. */
  readonly quotaReply?: string
  /** How long a dispatched session may take to appear before we give up. */
  readonly sessionClaimTimeoutMs?: number
  /** Deployment seed for one Telegram instance (design 07 §8). */
  readonly telegram?: TelegramChannelConfig
  /** Test seam: mount a credential store instead of the official one. */
  readonly credentials?: InstanceCredentials
  /** Quick-setup (QR) flows this deployment offers, by channel type (design 08). */
  readonly provisionFlows?: readonly ProvisionFlow[]
  /** Test seam: build adapters without the token-resolution path. */
  readonly adapterFactory?: ChannelAdapterFactory
  /** Test seam: override the webhook dispatch port. */
  readonly webhook?: WebhookDispatchPort
  /** Test seam: override the live-Agent lookup. */
  readonly agents?: AgentRegistryPort
  /** Test seam: override the session event feed. */
  readonly sessions?: SessionEventSink
}

/**
 * One inbound platform callback, normalized off `node:http` so an adapter's
 * hook handler is testable without any HTTP stack. `body` is the RAW payload
 * text — callback signature checks (feishu `X-Lark-Signature`) authenticate
 * the exact bytes, so no parsed form may ever be substituted here.
 */
export interface ChannelHookRequest {
  readonly method: string
  readonly body: string
  /** Case-insensitive header lookup. */
  header(name: string): string | undefined
}

/** What the adapter wants the gateway to answer the platform with. */
export interface ChannelHookReply {
  readonly status: number
  readonly json?: unknown
}

export type ChannelHookHandler = (request: ChannelHookRequest) => Promise<ChannelHookReply>

/** Everything an adapter factory may need from the live service. */
export interface ChannelServices {
  readonly offsetStore: OffsetStore
  readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void
  readonly resolveToken: (ref: string) => Promise<string | undefined>
  /**
   * Register a PUBLIC callback route for a push platform (feishu) and return
   * its disposer. The route skips gateway session auth (`public: true`), so
   * the adapter's own challenge/signature verification is the only
   * authentication — that is deliberate: the platform cannot hold a Tentacle
   * session. Present only when a gateway is mounted; a push-platform adapter
   * must refuse to start without it.
   */
  readonly registerHook?: (handler: ChannelHookHandler) => () => void
}

/** A factory receives the instance row and its credential-resolved adapter config. */
export type ChannelAdapterFactory = (
  instance: ChannelInstance,
  /** Platform-specific config block merged with the resolved credential map. */
  adapterConfig: unknown,
  services: ChannelServices,
) => ChannelAdapter | undefined

/** Runtime state of one instance, projected for the console (design 07 §4). */
export type InstanceRuntime =
  | { readonly state: 'disabled' }
  | { readonly state: 'pending' }
  // The identity id mirrors `ChannelAdapter.identity`: numeric on Telegram,
  // an opaque string (open_id) on feishu.
  | { readonly state: 'connected'; readonly identity?: { readonly id: number | string; readonly username?: string } }
  | { readonly state: 'failed'; readonly error: string }

/**
 * Credential facts as the console sees them: `configured` means every required
 * secret of the channel type is in place (a deployment reference resolving, or
 * a stored record covering the fields); `writable` says the console may edit it.
 */
export interface ChannelCredentialView {
  readonly configured: boolean
  readonly writable: boolean
}

/** One instance as the admin console sees it: record + runtime + credential facts. */
export interface ChannelInstanceView extends ChannelInstance {
  readonly runtime: InstanceRuntime
  readonly credential: ChannelCredentialView
  /** Display name of the bound target (expert or team); absent only if dangling. */
  readonly targetName?: string
}

/** One draft/saved connection probe (design 07 §4). */
export type ProbeResult =
  | { readonly ok: true; readonly identity?: { readonly id: number; readonly username?: string } }
  | { readonly ok: false; readonly error: string }

/** The whole admin overview in one round trip. */
export interface ChannelOverview {
  readonly instances: readonly ChannelInstanceView[]
  readonly bindings: readonly {
    readonly channelId: string
    readonly channelType: ChannelType
    readonly platformId: string
    readonly subjectId: string
    readonly boundAt: number
    readonly username?: string
  }[]
  readonly conversations: readonly { readonly channelId: string; readonly conversation: string; readonly sessionId: string }[]
  /** Refused unbound senders (reject policy only) — the console inbox. */
  readonly pendingSenders: readonly {
    readonly channelId: string
    readonly channelType: ChannelType
    readonly platformId: string
    readonly displayName?: string
    readonly preview?: string
    readonly lastSeen: number
    readonly messages: number
  }[]
  readonly lastFailure?: string
}

/** Status-map key for routing failures, which belong to no single adapter. */
const ROUTING_FAILURE_KEY = 'routing'
const DEFAULT_PERMISSION_PRESET = 'workspace-write'
const DEFAULT_AGENT_PRESET = 'standard'
const DEFAULT_TENANT = 'local'
/** Fixed id of the instance materialized from the legacy config/file. */
const LEGACY_INSTANCE_ID = 'telegram-legacy'
const DEFAULT_UNBOUND_REPLY = [
  'This account is not linked to a Tentacle user yet, so I cannot run anything for you.',
  'Ask an administrator to bind this Telegram account to your user, then send the message again.',
].join('\n')
const DEFAULT_SESSION_TIMEOUT_REPLY = 'Sorry — the session for this conversation could not be started. Please try again.'
const DEFAULT_DISPATCH_FAILURE_REPLY = 'Sorry — the agent runtime refused to start a session for this message.'
const DEFAULT_TURN_ERROR_REPLY = '(the turn failed before completing)'
const DEFAULT_QUOTA_REPLY = 'Your quota for this bot is exhausted. Ask an administrator to raise it or reset usage.'

/** Provisioning session TTL bounds (design 08 §1): the platform value wins, capped. */
const PROVISION_DEFAULT_TTL_MS = 10 * 60_000
const PROVISION_MAX_TTL_MS = 2 * 60 * 60_000
/** Inbox retention: refused-sender rows older than this are pruned on write. */
const PENDING_SENDER_TTL_MS = 7 * 24 * 60 * 60_000
/** Per-instance inbox cap; the oldest rows fall off first. */
const PENDING_SENDER_MAX_PER_CHANNEL = 50
/** Long enough to recognize "who is this?", short enough not to store chats. */
const PENDING_PREVIEW_CHARS = 80

export class TentacleChannels extends Service {
  // `storageDomain` is required: every durable record lives in the official
  // storage domain (design 07 §2 D3). Declaring it here is what makes the
  // facility available to `ctx.storageDomain` — cordis refuses an undeclared
  // cross-plugin read, and a channels plugin without durable state is not a
  // degraded plugin, it is a broken one.
  // `tentaclePersona` is required too: every channel routes to an expert
  // (design 09 §3.3); a channel plugin without expert routing has nothing to
  // dispatch to.
  static inject = ['tentacleTenancy', 'webhookRuntime', 'storageDomain', 'tentaclePersona']

  /**
   * Resolves once init has fully settled (store opened, migration done,
   * adapters started or reported failed). Awaiting the plugin fiber alone does
   * not cover this — the fiber activates its parent chain first — so
   * embedders, tests and the e2e harness wait on `ready`.
   */
  readonly ready: Promise<void>
  private markReady!: () => void

  private readonly config: TentacleChannelsConfig
  /** The injected persona service; set (and awaited) at the top of `init`. */
  private expertRouting!: ExpertRoutingApi
  /** Team routing seam; present only while the teams plugin is mounted. */
  private teamRouting: TeamRoutingApi | undefined
  private registry!: ChannelRegistry
  private store!: ChannelsStore
  private credentials!: InstanceCredentials
  private bindings!: BindingStore
  private readonly provisionSessions = new ProvisionSessions()
  private readonly provisionFlows = new Map<string, ProvisionFlow>()
  private router!: SessionRouter
  private tenancy!: TenancyLike
  private readonly running = new Map<string, { adapter: ChannelAdapter; handle: { stop(): Promise<void> } }>()
  /** Adapters that never started, keyed by instance id — surfaced on the console. */
  private readonly failures = new Map<string, string>()
  /** Cursor cache + coalescing, so a busy bot does not fsync per poll. */
  private readonly offsetCache = new Map<string, number | string>()
  private readonly offsetDirty = new Set<string>()
  private offsetWrite: Promise<void> | undefined

  constructor(ctx: Context, config: TentacleChannelsConfig = {}) {
    super(ctx, 'tentacleChannels')
    this.config = config
    this.ready = new Promise((resolve) => { this.markReady = resolve })
  }

  protected async [Service.init](): Promise<void> {
    // The store is opened here (the context owns the async seam) and every
    // collaborator is constructed against it, so nothing is late-bound.
    this.store = await openChannelsStore(this.ctx)
    // Expert routing is the reason a channel exists (design 09 §3.3): resolve
    // the injected persona, wait for its library to be fully planted, and only
    // then migrate bindings / start adapters — otherwise a message could be
    // dispatched against a half-initialised expert roster.
    const persona = (this.ctx as unknown as { tentaclePersona: ExpertRoutingApi }).tentaclePersona
    await persona.ready
    this.expertRouting = persona
    this.ctx.effect(() => persona.registerExpertRemovalGuard((expertId) => this.expertReferenceReason(expertId)))
    // Team routing is the second target kind (design 10 §7). The teams plugin
    // is optional: a persona-only deployment keeps expert-only routing, and a
    // channel that claims a team without the plugin fails loudly at dispatch.
    this.ctx.inject(['tentacleTeams'], (injected) => {
      const teams = (injected as unknown as { tentacleTeams?: TeamRoutingApi }).tentacleTeams
      if (teams === undefined) return
      const stopGuard = teams.registerRemovalGuard((teamId) => this.teamReferenceReason(teamId))
      void this.adoptTeamRouting(teams)
      return () => { stopGuard(); this.teamRouting = undefined }
    })
    this.registry = new ChannelRegistry(this.store)
    if (this.config.credentials !== undefined) {
      this.credentials = this.config.credentials
    } else {
      const provider = this.ctx.get('credentials') as CredentialProvider | undefined
      if (provider === undefined) {
        // Not fatal: a deployment that only uses `tokenRef` environment
        // references never needs the store, and the console must still come up
        // to report per-instance failures. A write attempt says so plainly.
        this.log('warn', 'tentacle channels: no credentials service is mounted; instance secrets cannot be stored')
        this.credentials = new UnavailableCredentials()
      } else {
        this.credentials = new RecordCredentials(provider)
      }
    }

    this.tenancy = (this.ctx as unknown as { tentacleTenancy: TenancyLike }).tentacleTenancy
    this.bindings = new BindingStore(this.store, this.tenancy.directory)
    // The accounts domain is a deployment knob (self-hosted Lark, and the
    // e2e's fake registration endpoint); empty means the vendor default.
    const qrDomain = process.env['TENTACLE_FEISHU_QR_DOMAIN']
    const flows = this.config.provisionFlows ?? [
      new FeishuProvisionFlow(qrDomain === undefined || qrDomain === '' ? {} : { domain: qrDomain }),
      // Same deployment knob as feishu's QR domain: a self-hosted or fake
      // device-registration endpoint (e2e) must never be hit by accident.
      new DingTalkProvisionFlow(
        process.env['TENTACLE_DINGTALK_QR_API_BASE_URL'] === undefined || process.env['TENTACLE_DINGTALK_QR_API_BASE_URL'] === ''
          ? {}
          : { apiBaseUrl: process.env['TENTACLE_DINGTALK_QR_API_BASE_URL'] },
      ),
      new WeComProvisionFlow(),
      new QQProvisionFlow(),
      new WeixinProvisionFlow(),
      new YuanbaoProvisionFlow(),
    ]
    for (const flow of flows) this.provisionFlows.set(flow.channelType, flow)

    const webhook = this.config.webhook ?? this.webhookPort()
    const agents = this.config.agents ?? this.agentRegistry()
    const sessions = this.config.sessions ?? this.sessionFeed()
    this.router = new SessionRouter({
      permissionPreset: this.config.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
      agentPreset: this.config.agentPreset ?? DEFAULT_AGENT_PRESET,
      workspaceRoot: (subjectId) => this.workspaceRootFor(subjectId),
      // Every channel routes through its target (design 09 §3.3 for experts,
      // 10 §7 for teams): preset id, model, permission preset and shared
      // workspace come from that instance. There is no unbound channel, so
      // this seam must always resolve — an unresolved target is a defect
      // (surfaced by the router as a dispatch failure), never a quiet fall
      // back to deployment defaults.
      targetFor: (channelId) => this.targetRouteFor(channelId),
      replyToUnbound: this.config.replyToUnbound ?? true,
      unboundReply: this.config.unboundReply ?? DEFAULT_UNBOUND_REPLY,
      sessionTimeoutReply: this.config.sessionTimeoutReply ?? DEFAULT_SESSION_TIMEOUT_REPLY,
      dispatchFailureReply: this.config.dispatchFailureReply ?? DEFAULT_DISPATCH_FAILURE_REPLY,
      turnErrorReply: this.config.turnErrorReply ?? DEFAULT_TURN_ERROR_REPLY,
      sessionClaimTimeoutMs: this.config.sessionClaimTimeoutMs ?? 20_000,
      // Unbound policy resolution (06 §5): the tenant's owner and the guest root.
      ownerFor: (tenant) => this.tenancy.directory.listUsers()
        .find((user) => user.role === 'admin' && user.tenant === tenant)?.subjectId,
      guestWorkspaceRoot: (tenant) => this.guestWorkspaceRoot(tenant),
      // Quota enforcement at the channel edge (design 05 §2.4): the tenancy
      // gate is optional so a deployment without tenancy keeps working.
      agentQuota: (subjectId) => this.tenancy.canStartAgent?.(subjectId as SubjectId) ?? { ok: true },
      quotaReply: this.config.quotaReply ?? DEFAULT_QUOTA_REPLY,
      onSessionClaimed: (sessionId, subjectId) => {
        this.tenancy.registerSession?.(subjectId as SubjectId, sessionId)
      },
      webhook,
      bindings: this.bindings,
      store: this.store,
      log: (level, message) => this.log(level, message),
      onUnboundSender: async (message, preview) => { await this.recordPendingSender(message, preview) },
      onDispatchFailed: (reason) => {
        this.failures.set(ROUTING_FAILURE_KEY, reason)
        // The webhook runtime is fire-and-forget: it logs its own failure and
        // returns no id, so this is the only surface on which a channel whose
        // sessions never materialize becomes visible.
        this.log('warn', `tentacle channels: ${reason}`)
      },
      ...(agents === undefined ? {} : { agents }),
    })
    this.router.start(sessions)

    // Legacy rows (pre-expert schema) and the deployment seed are bound to the
    // default expert BEFORE any adapter starts or any message can arrive.
    await this.migrate()
    await this.bindMissingTargets()
    await this.startEnabledInstances()

    this.ctx.inject(['tentacleGateway'], (gwCtx) => {
      const gateway = (gwCtx as unknown as { tentacleGateway: GatewayLike }).tentacleGateway
      const disposeRoutes = createChannelRoutes(this).map((route) => gateway.registerRoute(route))
      this.log('info', 'tentacle channels: admin routes registered on the gateway')
      return () => {
        for (const dispose of disposeRoutes) dispose()
      }
    })
    this.ctx.effect(() => () => this.shutdown(), 'tentacleChannels.lifecycle()')
    this.markReady()
  }

  private async shutdown(): Promise<void> {
    await this.router.stop()
    for (const [id, { handle }] of this.running) {
      await handle.stop().catch((error: unknown) => this.log('warn', `channel adapter ${id} stop failed: ${describe(error)}`))
    }
    this.running.clear()
    await this.flush().catch((error: unknown) => this.log('warn', `channel cursor flush failed: ${describe(error)}`))
    await this.store.close().catch((error: unknown) => this.log('warn', `channel store close failed: ${describe(error)}`))
  }

  // ---- instance lifecycle (design 07 §1) ----------------------------------

  /** Start every enabled instance; a failure is reported, never fatal. */
  private async startEnabledInstances(): Promise<void> {
    for (const [, instance] of this.store.channels.entries()) {
      if (!instance.enabled) continue
      await this.startInstance(instance)
    }
  }

  /** Build and start one adapter for one instance. */
  private async startInstance(instance: ChannelInstance): Promise<void> {
    // Never start an adapter whose expert does not resolve: it would accept
    // inbound messages that can only fail (or, worse, quietly run with
    // deployment defaults). The console shows the failure instead.
    if (this.resolveTarget(instance.target) === undefined) {
      const message = `routing target ${instance.target.kind} ${instance.target.id} does not exist`
      this.failures.set(instance.id, message)
      this.log('warn', `tentacle channels: ${instance.name} routes to unknown ${instance.target.kind} ${instance.target.id}`)
      return
    }
    const services = this.channelServices(instance)
    let adapter: ChannelAdapter | undefined
    try {
      adapter = await this.buildAdapter(instance, services)
    } catch (error) {
      // Missing CONFIGURATION (no token, no credentials service) is reported on
      // the console instead of killing the boot: the operator needs the console
      // to come up in order to see and fix it.
      const message = describe(error)
      this.failures.set(instance.id, message)
      this.log('warn', `tentacle channels: ${instance.name} is not usable: ${message}`)
      return
    }
    if (adapter === undefined) return
    this.router.attach(adapter)
    // The cursor is advanced once a message has been handed to the router,
    // whether or not the router acted on it: a refusal (unbound sender) or a
    // dispatch error must not pin the cursor, or one bad message would stall
    // every later one behind it.
    adapter.onMessage(async (message) => {
      try {
        await this.router.handleInbound(message)
      } finally {
        const updateId = message.metadata['updateId']
        if (typeof updateId === 'number') adapter.setOffset?.(updateId + 1)
      }
    })
    try {
      const handle = await adapter.start()
      this.running.set(instance.id, { adapter, handle })
      this.failures.delete(instance.id)
      // The runtime matches rules by exact kind: one rule per channel kind,
      // registered when the first instance of it starts (design 07 §1).
      this.router.registerKind(instance.channelType)
      this.log('info', `tentacle channels: ${instance.name} (${instance.id}) adapter started`)
    } catch (error) {
      // A platform that refuses the bot at startup (revoked token, another
      // poller) must not take the plugin down; the console reports it.
      this.router.detachAdapter(instance.id)
      const message = describe(error)
      this.failures.set(instance.id, message)
      this.log('warn', `tentacle channels: ${instance.name} adapter failed to start: ${message}`)
    }
  }

  /** Stop one adapter and forget its runtime entry (disable/update/remove). */
  private async stopInstance(id: string): Promise<void> {
    const entry = this.running.get(id)
    this.running.delete(id)
    this.router.detachAdapter(id)
    if (entry !== undefined) {
      await entry.handle.stop().catch((error: unknown) => {
        this.log('warn', `channel adapter ${id} stop failed: ${describe(error)}`)
      })
      this.router.unregisterKind(entry.adapter.channelType)
    }
  }

  private async buildAdapter(instance: ChannelInstance, services: ChannelServices): Promise<ChannelAdapter | undefined> {
    // Deployment-provided reference wins; otherwise the instance's own stored
    // record. Resolution happens BEFORE the factory seam so a test-injected
    // adapter is exercised against exactly the configuration a production
    // build would see — including the failure when none is usable. The whole
    // multi-key map is passed (`credentials`): telegram reads `token`, feishu
    // reads its `appId`/`appSecret` pair (plus optional callback keys).
    const values = await this.credentialValues(instance)
    const resolved = { ...instance.config, credentials: values }
    if (instance.channelType === 'telegram') {
      const token = values['token']
      if (token === undefined || token.trim() === '') {
        throw new Error(
          `tentacle channels: ${instance.name} has no usable bot token`
          + (instance.tokenRef === undefined ? ' (no credential is stored for this instance)' : ` (${instance.tokenRef} is empty)`),
        )
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new TelegramAdapter({
        id: instance.id,
        token,
        ...(instance.config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: instance.config['apiBaseUrl'] as string }),
        ...(instance.config['pollTimeoutSec'] === undefined ? {} : { pollTimeoutSec: instance.config['pollTimeoutSec'] as number }),
        ...(instance.config['typing'] === undefined ? {} : { typing: instance.config['typing'] as boolean }),
        offsetStore: services.offsetStore,
        log: services.log,
      })
    }
    if (instance.channelType === 'feishu') {
      const appId = values['appId']
      const appSecret = values['appSecret']
      if (appId === undefined || appId.trim() === '' || appSecret === undefined || appSecret.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable app credentials (appId and appSecret are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new FeishuAdapter({
        id: instance.id,
        credentials: {
          appId,
          appSecret,
          ...(values['encryptKey'] === undefined ? {} : { encryptKey: values['encryptKey'] }),
          ...(values['verificationToken'] === undefined ? {} : { verificationToken: values['verificationToken'] }),
        },
        ...(instance.config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: instance.config['apiBaseUrl'] as string }),
        ...(services.registerHook === undefined ? {} : { registerHook: services.registerHook }),
        log: services.log,
      })
    }
    if (instance.channelType === 'dingtalk') {
      const clientId = values['clientId']
      const clientSecret = values['clientSecret']
      if (clientId === undefined || clientId.trim() === '' || clientSecret === undefined || clientSecret.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable DingTalk credentials (clientId and clientSecret are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new DingTalkAdapter({
        id: instance.id,
        credentials: {
          clientId,
          clientSecret,
          ...(values['robotCode'] === undefined ? {} : { robotCode: values['robotCode'] }),
        },
        ...(instance.config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: instance.config['apiBaseUrl'] as string }),
        ...(instance.config['streamUrl'] === undefined ? {} : { streamUrl: instance.config['streamUrl'] as string }),
        log: services.log,
      })
    }
    if (instance.channelType === 'wecom') {
      const botId = values['botId']
      const secret = values['secret']
      if (botId === undefined || botId.trim() === '' || secret === undefined || secret.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable WeCom credentials (botId and secret are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new WeComAdapter({
        id: instance.id,
        credentials: { botId, secret },
        ...(instance.config['wsUrl'] === undefined ? {} : { wsUrl: instance.config['wsUrl'] as string }),
        log: services.log,
      })
    }
    if (instance.channelType === 'qq') {
      const appId = values['appId']
      const secret = values['secret']
      if (appId === undefined || appId.trim() === '' || secret === undefined || secret.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable QQ credentials (appId and secret are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new QQAdapter({
        id: instance.id,
        credentials: { appId, secret },
        ...(instance.config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: instance.config['apiBaseUrl'] as string }),
        log: services.log,
      })
    }
    if (instance.channelType === 'discord') {
      const token = values['token']
      if (token === undefined || token.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable Discord bot token`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new DiscordAdapter({
        id: instance.id,
        credentials: { token },
        ...(instance.config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: instance.config['apiBaseUrl'] as string }),
        log: services.log,
      })
    }
    if (instance.channelType === 'yuanbao') {
      const appKey = values['appKey']
      const appSecret = values['appSecret']
      if (appKey === undefined || appKey.trim() === '' || appSecret === undefined || appSecret.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable Yuanbao credentials (appKey and appSecret are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new YuanbaoAdapter({
        id: instance.id,
        credentials: { appKey, appSecret },
        ...(instance.config['apiDomain'] === undefined ? {} : { apiDomain: instance.config['apiDomain'] as string }),
        ...(instance.config['wsUrl'] === undefined ? {} : { wsUrl: instance.config['wsUrl'] as string }),
        log: services.log,
      })
    }
    if (instance.channelType === 'weixin') {
      const accountId = values['accountId']
      const token = values['token']
      if (accountId === undefined || accountId.trim() === '' || token === undefined || token.trim() === '') {
        throw new Error(`tentacle channels: ${instance.name} has no usable iLink credentials (accountId and token are required)`)
      }
      if (this.config.adapterFactory !== undefined) return this.config.adapterFactory(instance, resolved, services)
      return new WeixinAdapter({
        id: instance.id,
        credentials: { accountId, token },
        ...(instance.config['baseUrl'] === undefined ? {} : { baseUrl: instance.config['baseUrl'] as string }),
        ...(instance.config['botUin'] === undefined ? {} : { botUin: instance.config['botUin'] as string }),
        offsetStore: services.offsetStore,
        log: services.log,
      })
    }
    return undefined
  }

  // ---- service API (admin surface) ---------------------------------------

  /** Instances + runtime + credential facts + bindings + links, one round trip. */
  async overview(actor: ChannelActor): Promise<ChannelOverview> {
    const targetNames = new Map(this.targetRoutes().map((route) => [route.id, route.name]))
    const instances: ChannelInstanceView[] = []
    for (const instance of this.registry.list(actor)) {
      // The binding is required, but the name is a projection: a dangling id
      // (only possible after out-of-band storage edits) must still list.
      const targetName = targetNames.get(instance.target.id)
      instances.push({
        ...instance,
        runtime: this.runtimeOf(instance),
        credential: await this.credentialStatus(instance),
        ...(targetName === undefined ? {} : { targetName }),
      })
    }
    const known = new Map(instances.map((instance) => [instance.id, instance.channelType]))
    const users = this.tenancy.directory.listUsers()
    const bindings = this.bindings.list()
      .filter((binding) => known.has(binding.channelId))
      .map((binding) => {
        const user = users.find((candidate) => candidate.subjectId === binding.subjectId)
        return { ...binding, ...(user === undefined ? {} : { username: user.username }) }
      })
    const conversations = [...this.store.conversations.entries()]
      .filter(([, link]) => known.has(link.channelId))
      .map(([, link]) => ({
        channelId: link.channelId,
        conversation: conversationLabel(link),
        sessionId: link.sessionId,
      }))
    const lastFailure = this.failures.get(ROUTING_FAILURE_KEY)
    const pendingSenders = [...this.store.pendingSenders.entries()]
      .filter(([, row]) => known.has(row.channelId))
      .map(([, row]) => ({
        channelId: row.channelId,
        channelType: row.channelType,
        platformId: row.platformId,
        ...(row.displayName === undefined ? {} : { displayName: row.displayName }),
        ...(row.preview === undefined ? {} : { preview: row.preview }),
        lastSeen: row.lastSeen,
        messages: row.messages,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    return {
      instances,
      bindings,
      conversations,
      pendingSenders,
      ...(lastFailure === undefined ? {} : { lastFailure }),
    }
  }

  /** Expert instances available for channel routing (design 09). */
  listExpertRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[] {
    return this.expertRouting.listExpertRoutes()
  }

  /** Team instances available for channel routing (design 10 §7). */
  listTeamRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[] {
    return this.teamRouting?.listTeamRoutes() ?? []
  }

  /**
   * The session route for one channel (design 09 §3.3). Called by the router
   * at dispatch time so expert edits apply to the next message, not the next
   * restart. Throwing is deliberate: the router answers a thrown resolution
   * with the dispatch-failure reply instead of silently falling back to
   * deployment defaults for a channel that claims an expert.
   */
  private targetRouteFor(channelId: string): SessionRoute {
    const instance = this.store.channels.get(channelId)
    if (instance === undefined) throw new Error(`channel ${channelId} is not registered`)
    const route = this.resolveTarget(instance.target)
    if (route === undefined) {
      throw new Error(`channel ${channelId} routes to unknown ${instance.target.kind} ${instance.target.id}`)
    }
    return route
  }

  /**
   * Late-mount adoption (design 10 §7): `ctx.inject` fires after this
   * service's init, so a team-bound adapter may have been parked at boot with
   * "unknown team". Once the team library is planted, adopt it and (re)start
   * every enabled team-bound instance that is not running yet — no restart of
   * the whole plugin, and the failure entry clears on a successful start.
   */
  private async adoptTeamRouting(teams: TeamRoutingApi): Promise<void> {
    try {
      await teams.ready
    } catch {
      return
    }
    this.teamRouting = teams
    for (const [id, instance] of this.store.channels.entries()) {
      if (!instance.enabled || instance.target.kind !== 'team') continue
      if (this.running.has(id)) continue
      await this.startInstance(instance)
    }
  }

  /** Resolve one routing target through its owning library (design 10 §7). */
  private resolveTarget(target: ChannelTarget): SessionRoute | undefined {
    if (target.kind === 'team') return this.teamRouting?.resolveForSession(target.id)
    return this.expertRouting.resolveForSession(target.id)
  }

  /** Every routable target (experts first, then teams) for the console. */
  private targetRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[] {
    return [
      ...this.expertRouting.listExpertRoutes(),
      ...(this.teamRouting?.listTeamRoutes() ?? []),
    ]
  }

  /** Deletion veto reason for an expert still referenced by channels. */
  private expertReferenceReason(expertId: string): string | undefined {
    const bound = [...this.store.channels.entries()]
      .filter(([, instance]) => instance.target.kind === 'expert' && instance.target.id === expertId)
      .map(([, instance]) => instance.name)
    if (bound.length === 0) return undefined
    return `expert ${expertId} is still routed to by channel(s): ${bound.slice(0, 5).join(', ')}${bound.length > 5 ? ', …' : ''}`
  }

  /** Deletion veto reason for a team still referenced by channels (10 §8). */
  private teamReferenceReason(teamId: string): string | undefined {
    const bound = [...this.store.channels.entries()]
      .filter(([, instance]) => instance.target.kind === 'team' && instance.target.id === teamId)
      .map(([, instance]) => instance.name)
    if (bound.length === 0) return undefined
    return `team ${teamId} is still routed to by channel(s): ${bound.slice(0, 5).join(', ')}${bound.length > 5 ? ', …' : ''}`
  }

  /** Validate that a routing target exists before it is persisted (10 §7). */
  private requireKnownTarget(raw: unknown): ChannelTarget {
    const target = requireTarget(raw)
    if (this.resolveTarget(target) === undefined) {
      throw new ChannelError('invalid-config', `no such ${target.kind}: ${target.id}`)
    }
    return target
  }

  /**
   * Bind every pre-expert row to the default expert (design 09 §3.3). Runs
   * once per boot BEFORE adapters start; idempotent and logged because it
   * changes routing for rows created by an older build.
   */
  private async bindMissingTargets(): Promise<void> {
    const defaultTarget: ChannelTarget = { kind: 'expert', id: this.expertRouting.defaultExpertId }
    for (const [id, stored] of this.store.channels.entries()) {
      const legacy = (stored as { target?: ChannelTarget; expertId?: string })
      // Pre-target rows carry a bare expertId; pre-expert rows carry neither.
      const target = legacy.target ?? (legacy.expertId === undefined ? undefined : { kind: 'expert', id: legacy.expertId } as ChannelTarget)
      if (target !== undefined && legacy.target !== undefined) continue
      await this.store.channels.put(id, { ...stored, target: target ?? defaultTarget, updatedAt: Date.now() })
      this.log('info', `tentacle channels: bound legacy instance ${stored.name} (${id}) to ${target?.kind ?? 'expert'} ${target?.id ?? defaultTarget.id}`)
    }
  }

  /** The form schema for every supported type (the client renders it). */
  schemas(): readonly ChannelTypeSchema[] {
    // `quickSetup` is deployment knowledge (which flows are registered), so
    // the schema is decorated here rather than declared statically.
    return allSchemas().map((schema) => ({ ...schema, quickSetup: this.provisionFlows.has(schema.channelType) }))
  }

  /**
   * Create an instance: record first (unique name, tenant fence, routing
   * target), then the credential, then the adapter. A failure after the
   * record exists compensates by removing it, so a rejected create leaves no
   * half-installed row.
   */
  async createChannel(input: Record<string, unknown>, actor: ChannelActor): Promise<ChannelInstanceView> {
    const tenant = normalizeTenant(input['tenant'])
    // The target must exist now, not at the first inbound message: a channel
    // with a dangling binding would only fail later, in front of an end user.
    const target = this.requireKnownTarget(input['target'])
    const instance = await this.registry.create({
      channelType: input['channelType'],
      name: input['name'],
      target,
      ...(input['config'] === undefined ? {} : { config: input['config'] }),
      ...(input['enabled'] === undefined ? {} : { enabled: input['enabled'] }),
      ...(input['tokenRef'] === undefined ? {} : { tokenRef: input['tokenRef'] }),
      ...(tenant === undefined ? {} : { tenant }),
    }, actor)
    try {
      await this.writeChannelSecrets(instance.channelType, instance.id, input['credentials'], false)
      if (instance.enabled) await this.startInstance(instance)
    } catch (error) {
      await this.registry.remove(instance.id, actor).catch(() => undefined)
      throw error
    }
    return { ...instance, runtime: this.runtimeOf(instance), credential: await this.credentialStatus(instance) }
  }

  /**
   * Update an instance: the adapter is stopped first, the record is replaced,
   * and the adapter is restarted when the instance is enabled — a change is
   * live, not restart-pending (design 07 §7 #11).
   */
  async updateChannel(input: Record<string, unknown> & { id: string }, actor: ChannelActor): Promise<ChannelInstanceView> {
    const id = input['id']
    if (typeof id !== 'string' || id === '') throw new ChannelError('no-such-channel', 'id is required')
    await this.stopInstance(id)
    let next: ChannelInstance
    try {
      next = await this.registry.update(id, {
        ...(input['name'] === undefined ? {} : { name: input['name'] }),
        ...(input['channelType'] === undefined ? {} : { channelType: input['channelType'] }),
        ...(input['config'] === undefined ? {} : { config: input['config'] }),
        ...(input['enabled'] === undefined ? {} : { enabled: input['enabled'] }),
        // `null` is the documented "clear the deployment reference" value.
        ...(input['tokenRef'] === undefined ? {} : { tokenRef: input['tokenRef'] }),
        // Undefined leaves the binding alone; a provided value rebinds and must
        // name an existing expert or team. Clearing is rejected at the registry.
        ...(input['target'] === undefined ? {} : { target: this.requireKnownTarget(input['target']) }),
      }, actor)
      // Merge into the stored map: a field absent from the payload keeps its
      // previous secret, a present field replaces it.
      await this.writeChannelSecrets(next.channelType, next.id, input['credentials'], true)
    } catch (error) {
      // Bring the previous state back up before surfacing the rejection.
      const previous = this.store.channels.get(id)
      if (previous !== undefined && previous.enabled) await this.startInstance(previous)
      throw error
    }
    if (next.enabled) await this.startInstance(next)
    return { ...next, runtime: this.runtimeOf(next), credential: await this.credentialStatus(next) }
  }

  async setChannelEnabled(id: string, enabled: boolean, actor: ChannelActor): Promise<ChannelInstanceView> {
    const instance = await this.registry.update(id, { enabled }, actor)
    if (enabled) await this.startInstance(instance)
    else {
      await this.stopInstance(id)
      this.failures.delete(id)
    }
    return { ...instance, runtime: this.runtimeOf(instance), credential: await this.credentialStatus(instance) }
  }

  /** Delete an instance and everything that pointed at it. */
  async removeChannel(id: string, actor: ChannelActor): Promise<void> {
    const instance = await this.registry.remove(id, actor)
    await this.stopInstance(id)
    this.failures.delete(id)
    await this.bindings.removeChannel(id)
    for (const [key, link] of this.store.conversations.entries()) {
      if (link.channelId === id) await this.store.conversations.delete(key)
    }
    for (const [key, row] of this.store.pendingSenders.entries()) {
      if (row.channelId === id) await this.store.pendingSenders.delete(key)
    }
    await this.store.offsets.delete(id)
    this.offsetCache.delete(id)
    await this.instanceCredentials().remove(id).catch((error: unknown) => {
      // A credential the store refuses to drop must not block the deletion that
      // the operator asked for; it is reported instead.
      this.log('warn', `channel credential cleanup for ${id} failed: ${describe(error)}`)
    })
    this.log('info', `tentacle channels: ${instance.name} (${id}) removed`)
  }

  /** Probe with the SAVED configuration of one instance. */
  async testChannel(id: string, actor: ChannelActor): Promise<ProbeResult> {
    const instance = this.registry.get(id, actor)
    if (instance.channelType !== 'telegram') {
      return { ok: false, error: `no probe is implemented for ${instance.channelType}` }
    }
    const token = (await this.credentialValues(instance))['token']
    if (token === undefined || token.trim() === '') {
      return { ok: false, error: 'no usable bot token is configured for this instance' }
    }
    return await probeTelegram(instance.config, token)
  }

  /**
   * Probe a DRAFT configuration without persisting anything.
   *
   * The credential comes from the request alone: falling back to a deployment
   * reference here would report "connected" for a token the operator never
   * typed. Probing what the deployment provides is what `/test` (the SAVED
   * instance) is for.
   */
  async probeChannel(input: { channelType: unknown; config?: unknown; credentials?: unknown }): Promise<ProbeResult> {
    try {
      const channelType = requireChannelType(input.channelType)
      // Only telegram has a probe: feishu's token check belongs to the type
      // dispatch below, otherwise a feishu draft would always be reported as
      // "no bot token supplied" — a field feishu does not have.
      if (channelType !== 'telegram') {
        return { ok: false, error: `no probe is implemented for ${channelType}` }
      }
      const config = validateConfig(channelType, input.config)
      const token = validateCredentials(channelType, input.credentials)['token']
      if (token === undefined) {
        return { ok: false, error: 'no bot token was supplied to probe' }
      }
      return await probeTelegram(config, token)
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  /** Tenants users an admin may bind to THIS instance (design 07 §4). */
  listBindableUsers(channelId: string, actor: ChannelActor): readonly { readonly subjectId: string; readonly username: string }[] {
    const instance = this.registry.get(channelId, actor)
    return this.tenancy.directory.listUsers()
      .filter((user) => user.tenant === instance.tenant)
      .map((user) => ({ subjectId: user.subjectId, username: user.username }))
  }

  /**
   * Record one refused unbound sender for the console inbox. Called by the
   * router on the `reject` path only; guest/owner messages never reach it.
   */
  private async recordPendingSender(message: InboundMessage, preview: string): Promise<void> {
    const key = bindingKey({ channelId: message.channelId, platformId: message.sender.platformId })
    const now = this.now()
    const text = preview.trim().slice(0, PENDING_PREVIEW_CHARS)
    const existing = this.store.pendingSenders.get(key)
    const row: PendingSender = {
      channelId: message.channelId,
      channelType: message.channelType,
      platformId: message.sender.platformId,
      ...(message.sender.displayName === undefined || message.sender.displayName === ''
        ? {}
        : { displayName: message.sender.displayName }),
      ...(text === '' ? {} : { preview: text }),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      messages: (existing?.messages ?? 0) + 1,
    }
    await this.store.pendingSenders.put(key, row)
    await this.prunePendingSenders(message.channelId)
  }

  /** Expired rows and the per-instance cap (oldest first) are dropped here. */
  private async prunePendingSenders(channelId: string): Promise<void> {
    const cutoff = this.now() - PENDING_SENDER_TTL_MS
    const rows = [...this.store.pendingSenders.entries()]
      .filter(([, row]) => row.channelId === channelId)
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    const overflow = Math.max(0, rows.length - PENDING_SENDER_MAX_PER_CHANNEL)
    for (const [index, [key, row]] of rows.entries()) {
      if (row.lastSeen < cutoff || index < overflow) await this.store.pendingSenders.delete(key)
    }
  }

  async bind(input: { channelId: string; platformId: string; subjectId: string }, actor: ChannelActor) {
    const instance = this.registry.get(input.channelId, actor)
    const binding = await this.bindings.bind({
      channelId: instance.id,
      channelType: instance.channelType,
      platformId: input.platformId,
      subjectId: input.subjectId,
      tenant: instance.tenant,
    })
    // The person is known now; their inbox row has served its purpose.
    await this.store.pendingSenders.delete(bindingKey(binding)).catch(() => undefined)
    return binding
  }

  async unbind(input: { channelId: string; platformId: string }, actor: ChannelActor): Promise<boolean> {
    this.registry.get(input.channelId, actor)
    return await this.bindings.unbind(input.channelId, input.platformId)
  }

  // ---- quick-setup provisioning (design 08) --------------------------------

  /**
   * Begin a quick-setup flow. One live session per actor: starting a new one
   * stops the previous (the reference implementation's QQ single-task semantics).
   *
   * `instanceId` targets an existing instance for REPAIR (e.g. a weixin session
   * that expired with -14): a successful scan rotates that instance's
   * credentials in place instead of creating a duplicate bot.
   */
  async startProvision(input: { channelType: unknown; instanceId?: unknown; target?: unknown }, actor: ChannelActor): Promise<ProvisionStatus> {
    const channelType = requireChannelType(input.channelType)
    const flow = this.provisionFlows.get(channelType)
    if (flow === undefined) {
      throw new ProvisionError('no-provision-flow', `${channelType} declares no quick-setup flow`)
    }
    const instance = input.instanceId === undefined || input.instanceId === ''
      ? undefined
      // Registry lookup enforces the tenant fence and reports `no-such-channel`.
      : this.registry.get(String(input.instanceId), actor)
    if (instance !== undefined && instance.channelType !== channelType) {
      throw new ChannelError('invalid-channel-type', `instance ${instance.id} is a ${instance.channelType} channel`)
    }
    if (instance !== undefined && input.target !== undefined) {
      throw new ChannelError('invalid-config', 'a repair flow keeps the instance target; rebind it in the editor')
    }
    // A quick-setup that creates a new instance needs its target up front (the
    // console passes the one selected in the form); a repair keeps its own.
    const target = instance === undefined ? this.requireKnownTarget(input.target) : undefined
    const { session, previous } = this.provisionSessions.begin(
      channelType,
      actor,
      this.now() + PROVISION_DEFAULT_TTL_MS,
      instance?.id,
      target,
    )
    if (previous !== undefined) await flow.stop?.(previous).catch(() => undefined)
    try {
      const started = await flow.start(session)
      // The platform's own TTL governs the session from here on.
      session.expiresAt = Math.min(started.expiresAt, this.now() + PROVISION_MAX_TTL_MS)
      return {
        state: 'waiting',
        flowId: session.flowId,
        ...(started.qrUrl === undefined ? {} : { qrUrl: started.qrUrl }),
        ...(started.userCode === undefined ? {} : { userCode: started.userCode }),
        ...(started.message === undefined ? {} : { message: started.message }),
        ...(started.pollAfterMs === undefined ? {} : { pollAfterMs: started.pollAfterMs }),
      }
    } catch (error) {
      // A failed start leaves no session behind: the next attempt must not be
      // treated as "the previous flow" and the wizard must be able to retry.
      this.provisionSessions.drop(session.flowId)
      throw error
    }
  }

  /**
   * Advance one flow. `success` turns the platform credentials into a created
   * and ENABLED instance right here — the secrets cross no other boundary.
   */
  async pollProvision(flowId: string, actor: ChannelActor): Promise<ProvisionStatus> {
    const session = this.ownSession(flowId, actor)
    if (session.expiresAt <= this.now()) {
      this.provisionSessions.drop(flowId)
      // The flow may own background work (e.g. the weixin long-poll follower)
      // that only its stop() cancels — dropping the session row is not enough.
      await this.provisionFlows.get(session.channelType)?.stop?.(session).catch(() => undefined)
      return { state: 'expired', flowId }
    }
    const flow = this.provisionFlows.get(session.channelType)!
    const polled = await flow.poll(session)
    if (polled.state === 'waiting') {
      return {
        state: 'waiting',
        flowId,
        ...(polled.qrUrl === undefined ? {} : { qrUrl: polled.qrUrl }),
        ...(polled.userCode === undefined ? {} : { userCode: polled.userCode }),
        ...(polled.message === undefined ? {} : { message: polled.message }),
      }
    }
    // Terminal: the session is consumed whatever the outcome (one-time).
    this.provisionSessions.drop(flowId)
    if (polled.state === 'failed') return { state: 'failed', flowId, error: polled.error }
    if (polled.state === 'expired') return { state: 'expired', flowId }
    try {
      // Repair path: rotate the targeted instance's credentials in place so a
      // re-scan never leaves a duplicate bot behind (the -14 recovery story).
      if (session.instanceId !== undefined) {
        const current = this.registry.get(session.instanceId, actor)
        const instance = await this.updateChannel({
          id: current.id,
          credentials: polled.credentials,
          config: { ...current.config, ...(polled.config ?? {}) },
          enabled: true,
        }, actor)
        return { state: 'success', flowId, instance }
      }
      const instance = await this.createChannel({
        channelType: session.channelType,
        name: polled.name ?? `${session.channelType}-${session.flowId.slice(5, 13)}`,
        credentials: polled.credentials,
        ...(polled.config === undefined ? {} : { config: polled.config }),
        // Creation sessions always carry the target chosen when the flow
        // started; the service re-validates it like any other create.
        target: session.target,
        enabled: true,
      }, actor)
      return { state: 'success', flowId, instance }
    } catch (error) {
      // The credentials were one-time; a failed write means a re-scan.
      this.log('warn', `tentacle channels: provisioning write failed: ${describe(error)}`)
      return { state: 'failed', flowId, error: describe(error) }
    }
  }

  /** Cancel one flow (the wizard closing); the session is gone either way. */
  async stopProvision(flowId: string, actor: ChannelActor): Promise<void> {
    const session = this.ownSession(flowId, actor)
    this.provisionSessions.drop(flowId)
    const flow = this.provisionFlows.get(session.channelType)
    await flow?.stop?.(session).catch(() => undefined)
  }

  /** A session is visible only to the actor who started it (no existence leak). */
  private ownSession(flowId: string, actor: ChannelActor): ProvisionSessionLike {
    const session = this.provisionSessions.get(flowId)
    if (session === undefined || session.actor.tenant !== actor.tenant || session.actor.isAdmin !== actor.isAdmin) {
      throw new ProvisionError('no-such-flow', 'no such provisioning session')
    }
    return session
  }

  private now(): number {
    return Date.now()
  }

  /** The most recent routing failure (a dispatched session that never appeared). */
  get lastFailure(): string | undefined {
    return this.failures.get(ROUTING_FAILURE_KEY)
  }

  // ---- helpers ------------------------------------------------------------

  /** Runtime state of one instance, from the enabled flag + live maps. */
  private runtimeOf(instance: ChannelInstance): InstanceRuntime {
    if (!instance.enabled) return { state: 'disabled' }
    const entry = this.running.get(instance.id)
    const failure = this.failures.get(instance.id)
    if (entry !== undefined) {
      const identity = entry.adapter.identity
      const pollFailure = entry.adapter.failure
      if (pollFailure !== undefined) return { state: 'failed', error: pollFailure.message }
      return { state: 'connected', ...(identity === undefined ? {} : { identity }) }
    }
    if (failure !== undefined) return { state: 'failed', error: failure }
    return { state: 'pending' }
  }

  /**
   * The secret map an instance runs with. A deployment `tokenRef` maps to the
   * `token` field (it is Telegram's deployment override; a future platform with
   * several secrets composes its own deployment block instead of a tokenRef).
   */
  private async credentialValues(instance: ChannelInstance): Promise<CredentialValues> {
    if (instance.tokenRef !== undefined) {
      const value = await this.resolveToken(instance.tokenRef)
      return value === undefined ? {} : { token: value }
    }
    return (await this.credentials.read(instance.id)) ?? {}
  }

  /**
   * Write the request's `credentials` map for one instance: validated against
   * the channel type's declared fields (unknown keys rejected), empties
   * dropped, and on update merged over the stored map so an untouched field
   * keeps its secret.
   */
  private async writeChannelSecrets(channelType: ChannelType, id: string, raw: unknown, merge: boolean): Promise<void> {
    if (raw === undefined) return
    const values = validateCredentials(channelType, raw)
    if (Object.keys(values).length === 0) return
    const next = merge ? { ...((await this.credentials.read(id)) ?? {}), ...values } : values
    await this.credentials.write(id, next)
  }

  private async credentialStatus(instance: ChannelInstance): Promise<ChannelCredentialView> {
    if (instance.tokenRef !== undefined) {
      // A deployment reference is not an instance record; report its presence
      // rather than pretending the instance owns it.
      const value = await this.resolveToken(instance.tokenRef).catch(() => undefined)
      return { configured: value !== undefined && value !== '', writable: false }
    }
    let stored = false
    let writable = false
    try {
      const info = await this.credentials.describe(instance.id)
      stored = info.stored
      writable = info.writable
    } catch {
      // A broken credential store degrades the badge to "not configured",
      // never to a lie.
    }
    let configured = false
    if (stored) {
      const values = await this.credentials.read(instance.id).catch(() => undefined)
      configured = requiredCredentials(instance.channelType).every((field) => {
        const value = values?.[field]
        return value !== undefined && value !== ''
      })
    }
    return { configured, writable }
  }

  private instanceCredentials(): InstanceCredentials {
    return this.credentials
  }
  /** The coalescing cursor store + seams handed to adapters (06 §7). */
  private channelServices(instance: ChannelInstance): ChannelServices {
    return {
      offsetStore: {
        load: async (instanceId) => {
          const cached = this.offsetCache.get(instanceId)
          if (cached !== undefined) return cached
          const stored = this.store.offsets.get(instanceId)
          if (stored !== undefined) this.offsetCache.set(instanceId, stored)
          return stored
        },
        save: async (instanceId, offset) => {
          this.offsetCache.set(instanceId, offset)
          this.offsetDirty.add(instanceId)
          this.offsetWrite ??= this.drainOffsets()
        },
      },
      log: (level, message) => this.log(level, message),
      resolveToken: (ref) => this.resolveToken(ref),
      // The hook seam exists only where a gateway can host it: without one the
      // adapter gets `undefined` and refuses to start (reported `failed`),
      // instead of silently running a channel nothing can reach.
      ...(this.gateway() === undefined
        ? {}
        : {
            registerHook: (handler: ChannelHookHandler) =>
              this.registerPublicRoute(`/tentacle/hooks/${instance.channelType}/${instance.id}`, handler),
          }),
    }
  }

  /** The optional gateway seam, resolved lazily (see `agentRegistry`). */
  private gateway(): GatewayLike | undefined {
    return this.ctx.get('tentacleGateway') as GatewayLike | undefined
  }

  /**
   * Mount a PUBLIC platform-callback route on the gateway. `public: true`
   * skips session auth by design — the platform authenticates itself inside
   * the handler (challenge echo / signature), and a session cookie is
   * something a feishu server can never present. The handler outcome is
   * always answered: a thrown adapter error becomes a 500 (which tells the
   * platform to retry) rather than a hung socket.
   */
  private registerPublicRoute(prefix: string, handler: ChannelHookHandler): () => void {
    const gateway = this.gateway()
    if (gateway === undefined) throw new Error('gateway is required for feishu (callback route)')
    return gateway.registerRoute({
      prefix,
      public: true,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        let reply: ChannelHookReply
        try {
          reply = await handler({
            method: req.method ?? 'GET',
            body: await readBody(req),
            header: (name) => {
              const value = req.headers[name.toLowerCase()]
              return Array.isArray(value) ? value[0] : value
            },
          })
        } catch (error) {
          this.log('warn', `tentacle channels: hook ${prefix} failed: ${describe(error)}`)
          reply = { status: 500 }
        }
        const payload = reply.json === undefined ? '' : JSON.stringify(reply.json)
        res.writeHead(reply.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(payload),
        })
        res.end(payload)
      },
    })
  }

  private async drainOffsets(): Promise<void> {
    try {
      while (this.offsetDirty.size > 0) {
        const ids = [...this.offsetDirty]
        this.offsetDirty.clear()
        for (const id of ids) {
          const value = this.offsetCache.get(id)
          if (value !== undefined) await this.store.offsets.put(id, value)
        }
      }
    } finally {
      this.offsetWrite = undefined
      if (this.offsetDirty.size > 0) this.offsetWrite = this.drainOffsets()
    }
  }

  /** Await any pending cursor write; used by shutdown and by tests. */
  async flush(): Promise<void> {
    if (this.offsetDirty.size > 0) this.offsetWrite ??= this.drainOffsets()
    await this.offsetWrite
  }

  /** Resolve one credential reference through the credentials seam. */
  private async resolveToken(ref: string): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials') as CredentialProvider | undefined
    if (credentials === undefined) {
      throw new Error(`tentacle channels: no credentials service is mounted to resolve ${ref}`)
    }
    const resolved = await credentials.resolve(credentialRef(ref))
    return resolved?.value
  }

  private defaultTenant(): TenantId {
    return tenantId(this.config.tenant ?? DEFAULT_TENANT)
  }

  // ---- migration (design 07 §8) ------------------------------------------

  /**
   * Bring a pre-instances deployment forward, once.
   *
   * The legacy document (cursors, bindings, links) is imported and the static
   * `config.telegram` seed is materialized as one instance. Both are guarded by
   * domain-global flags so a deleted instance never comes back on the next
   * boot, which is the failure mode a config-driven seed would otherwise have.
   */
  private async migrate(): Promise<void> {
    const global = this.store.readGlobal()
    if (global.legacyImported && global.configSeeded) return
    const next = { ...global }
    if (!global.legacyImported) {
      const { found } = await this.importLegacyState()
      // The file's absence is final, so the flag only gates the import.
      next.legacyImported = true
      // A legacy document that carried records justifies a row on its own, so
      // its bindings stay reachable and visible.
      if (found && !this.store.channels.get(LEGACY_INSTANCE_ID)) await this.ensureLegacyInstance(true)
    }
    // The config seed stays open until a real configuration shows up: the
    // bundle's own entry config and an operator overlay arrive as SEPARATE
    // config states (the overlay is a reload), so a flag written during the
    // first, unconfigured pass would swallow the operator's configuration.
    if (!next.configSeeded && await this.ensureLegacyInstance(false)) next.configSeeded = true
    if (next.legacyImported !== global.legacyImported || next.configSeeded !== global.configSeeded) {
      await this.store.writeGlobal(next)
    }
  }

  /**
   * Import the legacy `channels.json` document.
   *
   * @returns `{ found: true }` only when the document actually carried state.
   * An empty legacy file — a deployment whose old plugin created it but never
   * bound anyone — must NOT materialize a phantom instance: the file's mere
   * existence is not evidence of a configured channel.
   */
  private async importLegacyState(): Promise<{ found: boolean }> {
    const file = join(this.config.stateRoot ?? dshHomePath('tentacle', 'channels'), 'channels.json')
    let legacy: {
      offsets?: Record<string, number>
      bindings?: readonly { channelType: ChannelType; platformId: string; subjectId: string; boundAt: number }[]
      conversations?: readonly (ConversationLink & { channelType: ChannelType })[]
    }
    try {
      legacy = JSON.parse(readFileSync(file, 'utf8')) as typeof legacy
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false }
      this.log('warn', `tentacle channels: legacy state at ${file} is unreadable: ${describe(error)}`)
      return { found: false }
    }
    let imported = 0
    for (const binding of legacy.bindings ?? []) {
      if (binding.subjectId === '' || binding.platformId === '') continue
      const key = bindingKey({ channelId: LEGACY_INSTANCE_ID, platformId: binding.platformId })
      if (this.store.bindings.get(key) !== undefined) continue
      await this.store.bindings.put(key, {
        channelId: LEGACY_INSTANCE_ID,
        channelType: binding.channelType,
        platformId: binding.platformId,
        subjectId: binding.subjectId,
        boundAt: binding.boundAt,
      })
      imported += 1
    }
    for (const link of legacy.conversations ?? []) {
      const migrated: ConversationLink = { ...link, channelId: LEGACY_INSTANCE_ID }
      const key = `${LEGACY_INSTANCE_ID}:${link.chatId}${link.threadId === undefined ? '' : `#${link.threadId}`}@${link.subjectId}`
      if (this.store.conversations.get(key) !== undefined) continue
      await this.store.conversations.put(key, migrated)
      imported += 1
    }
    const offset = legacy.offsets?.['telegram']
    if (offset !== undefined && this.store.offsets.get(LEGACY_INSTANCE_ID) === undefined) {
      await this.store.offsets.put(LEGACY_INSTANCE_ID, offset)
      imported += 1
    }
    if (imported === 0) return { found: false }
    this.log('info', `tentacle channels: imported legacy state from ${file}`)
    return { found: true }
  }

  /**
   * Materialize the pre-instances deployment as one instance.
   *
   * The row is created when a legacy document carried records (`imported`) or
   * when a real Telegram configuration is present; it is NEVER updated once it
   * exists, which is what keeps an instance deleted in the console from
   * reappearing on the next boot.
   *
   * @returns true when the deployment CONFIG was present (and therefore
   * consumed) — the caller uses that, not the row, to close the seed.
   */
  private async ensureLegacyInstance(imported: boolean): Promise<boolean> {
    const telegram = this.config.telegram
    const hasConfiguration = telegram !== undefined && (
      telegram.enabled === true
      || (telegram.tokenRef !== undefined && telegram.tokenRef !== '')
      || (telegram.token !== undefined && telegram.token !== '')
    )
    if (this.store.channels.get(LEGACY_INSTANCE_ID) !== undefined || (!imported && !hasConfiguration)) {
      return hasConfiguration
    }

    let config: Record<string, unknown>
    try {
      config = validateConfig('telegram', {
        ...(telegram?.apiBaseUrl === undefined ? {} : { apiBaseUrl: telegram.apiBaseUrl }),
        ...(telegram?.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: telegram.pollTimeoutSec }),
        ...(telegram?.typing === undefined ? {} : { typing: telegram.typing }),
      })
    } catch (error) {
      this.log('warn', `tentacle channels: deployment seed is invalid: ${describe(error)}`)
      return false
    }
    const now = Date.now()
    await this.store.channels.put(LEGACY_INSTANCE_ID, {
      id: LEGACY_INSTANCE_ID,
      tenant: this.defaultTenant(),
      channelType: 'telegram',
      name: 'telegram',
      // Imported-but-unconfigured data stays visible and DISABLED: the operator
      // enables it on the console once a token is in place.
      enabled: telegram?.enabled === true,
      config,
      // The deployment seed has no routing configured; it starts on the
      // default expert like any other migrated row (design 09 §3.3).
      target: { kind: 'expert', id: this.expertRouting.defaultExpertId },
      ...(telegram?.tokenRef === undefined ? {} : { tokenRef: telegram.tokenRef }),
      createdAt: now,
      updatedAt: now,
    })
    // A deployment that used the local/testing direct token keeps working: the
    // secret moves into the credential store (where it belongs) instead of
    // being dropped, and never lands in the record or the config.
    const direct = telegram?.token
    if (direct !== undefined && direct.trim() !== '') {
      await this.credentials.write(LEGACY_INSTANCE_ID, { token: direct }).catch((error: unknown) => {
        this.log('warn', `tentacle channels: could not move the seeded token into the credential store: ${describe(error)}`)
      })
    }
    this.log('info', 'tentacle channels: materialized the deployment state as instance telegram-legacy')
    return true
  }

  // ---- DSH seams ----------------------------------------------------------

  /** Assemble the official webhook runtime port (public for tests). */
  webhookPort(): WebhookDispatchPort {
    const runtime = (this.ctx as unknown as {
      webhookRuntime: WebhookDispatchPortLike
    }).webhookRuntime
    return {
      register: (rule) => runtime.register(rule as never),
      dispatch: (request) => runtime.dispatch({
        // The runtime matches rule.kind === delivery.kind exactly; the router
        // stamps each message's own channel type, so several platforms can run
        // side by side under their own rules.
        kind: request.delivery.kind,
        source: request.delivery.source,
        deliveryId: request.delivery.deliveryId,
        receivedAt: request.delivery.receivedAt,
        event: { kind: 'channel-message', workspacePath: request.workspacePath, title: request.title },
      }),
    }
  }

  private agentRegistry(): AgentRegistryPort | undefined {
    // `ctx.get` honours the service registry without declaring an inject: the
    // agent plane is present in a real composition but NOT guaranteed to the
    // channels plugin, and a missing one must degrade (fresh session per
    // message) rather than fail the boot.
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (agents === undefined) return undefined
    return {
      get: (sessionId) => {
        const agent = agents.get(sessionId)
        if (agent === undefined) return undefined
        return {
          agent: {
            // The router owns the text-only user-turn shape; the runtime owns
            // the message factory. One cast at this boundary keeps every other
            // file free of dsh-llm types.
            followup: (message) => (agent.followup as (message: unknown) => void)(message),
          },
        }
      },
    }
  }

  /**
   * Subscribe to the session feed the outbound path needs.
   *
   * `session/created` is the only signal that carries the new session back to
   * us: the webhook runtime creates sessions fire-and-forget and never returns
   * an id, so correlation is by workspace path (see `SessionRouter.claimSession`).
   */
  private sessionFeed(): SessionEventSink {
    return {
      onSessionCreated: (listener) => this.ctx.on('session/created', (session) => {
        listener(createdSessionOf(session))
      }),
      onSessionEvent: (listener) => this.ctx.on('session/event', (session, event) => {
        listener(createdSessionOf(session), { type: event.type, data: event.data })
      }),
    }
  }

  /**
   * Session working directory for one subject: the per-user
   * `workspace_root_dir` policy when the tenancy set one, else the configured
   * default root. Created on demand because the DSH workspace registry refuses
   * a directory that does not exist.
   */
  /** A dedicated read-only workspace for guest sessions (never a user's own root). */
  private guestWorkspaceRoot(tenant: string | undefined): string {
    const root = dshHomePath('tentacle', 'channels', 'guest', tenant ?? 'local')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  }

  private workspaceRootFor(subjectId: string): string {
    const fenced = this.tenancy.directory.getPolicy(subjectId as SubjectId, 'workspace_root_dir')
    const root = fenced ?? this.config.workspaceRoot ?? dshHomePath('tentacle', 'channels', 'workspace')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  }

  private log(level: 'info' | 'warn' | 'debug', message: string): void {
    this.ctx.logger?.[level]?.(message)
  }
}

/** Human label of one conversation link for the admin console. */
function conversationLabel(link: ConversationLink): string {
  const thread = link.threadId === undefined ? '' : `#${link.threadId}`
  return `${link.channelType}:${link.chatId}${thread}`
}

/**
 * Read a hook request body verbatim (signature checks need the exact bytes),
 * with a hard cap: the route is public, so it must not be a memory sink.
 */
async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Probe one Telegram connection without touching the running adapter. */
async function probeTelegram(config: Record<string, unknown>, token: string): Promise<ProbeResult> {
  try {
    const api = createTelegramApi({
      ...(config['apiBaseUrl'] === undefined ? {} : { apiBaseUrl: config['apiBaseUrl'] as string }),
      token,
      readTimeoutSec: 30,
    })
    const me = await api.getMe()
    return { ok: true, identity: { id: me.id, ...(me.username === undefined ? {} : { username: me.username }) } }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}

/**
 * Project a live Session onto the two facts the router correlates on. The
 * session header carries the canonical cwd the workspace registry resolved,
 * which is exactly the key `SessionRouter.claimSession` matches against.
 */
function createdSessionOf(session: Session): { readonly id: string; readonly cwd?: string } {
  const cwd = session.header.cwd
  return { id: session.id, ...(cwd === undefined ? {} : { cwd }) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
