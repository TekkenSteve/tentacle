/**
 * TentacleChannels boot + instance lifecycle (design 07 §1, §8): the deployment
 * seed, migration, runtime CRUD with live reload, per-instance routing, and the
 * console projection. These tests boot a real cordis context with stand-in
 * services: no DSH runtime, no network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { tenantId } from '@tentacle/identity'
import * as channelsPlugin from '../src/index.js'
import type { ProvisionFlow, ProvisionPoll, ProvisionSession, ProvisionStart } from '../src/provision.js'
import type { RouterSessionEvent } from '../src/router/router.js'
import type { ChannelAdapter, InboundMessage } from '../src/types.js'
import type { ChannelActor } from '../src/registry.js'

const LOCAL = tenantId('local')
const OTHER = tenantId('other')
const ADMIN: ChannelActor = { tenant: LOCAL, isAdmin: true }
const ALICE: ChannelActor = { tenant: LOCAL, isAdmin: false }

/**
 * A faithful stand-in for the official storage facility.
 *
 * It validates every write against the SPEC's zod schemas (the real domain's
 * durable boundary) and keeps the same table/global surface, so the plugin's
 * production path — `openChannelsStore(ctx)` — is exercised instead of being
 * bypassed by a test-only store seam. Backing data lives at module scope so a
 * test can boot twice against the same durable state.
 */
interface StorageBacking {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

let storageBacking: StorageBacking = { tables: new Map(), global: undefined }

function resetStorage(): void {
  storageBacking = { tables: new Map(), global: undefined }
}

/** The plugin's `offsets` table, for durability assertions. */
function offsetsTable(): Map<string, unknown> {
  return storageBacking.tables.get('offsets') ?? new Map()
}

class FakeStorageDomain extends Service {
  static name = 'fake-storage-domain'
  static inject: string[] = []
  readonly openedDomains: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'storageDomain')
  }

  async open(spec: {
    readonly name: string
    readonly tables: Record<string, { readonly valueSchema: { parse(value: unknown): unknown } }>
    readonly global?: { readonly initial: unknown; readonly schema: { parse(value: unknown): unknown } }
  }): Promise<unknown> {
    this.openedDomains.push(spec.name)
    for (const table of Object.keys(spec.tables)) {
      if (!storageBacking.tables.has(table)) storageBacking.tables.set(table, new Map())
    }
    if (storageBacking.global === undefined && spec.global !== undefined) {
      storageBacking.global = structuredClone(spec.global.initial)
    }
    const backing = storageBacking
    return {
      name: spec.name,
      global: {
        get: () => backing.global,
        set: async (next: unknown) => {
          backing.global = spec.global?.schema.parse(next) ?? next
        },
      },
      table: (name: string) => {
        const map = backing.tables.get(name)
        const schema = spec.tables[name]?.valueSchema
        if (map === undefined || schema === undefined) throw new Error(`undeclared table ${name}`)
        return {
          get: (key: string) => map.get(key),
          entries: () => [...map.entries()][Symbol.iterator](),
          keys: () => [...map.keys()][Symbol.iterator](),
          get size() { return map.size },
          put: async (key: string, value: unknown) => { map.set(key, schema.parse(value)) },
          delete: async (key: string) => map.delete(key),
          update: async (key: string, mutate: (current: unknown) => unknown) => {
            const current = map.get(key)
            if (current === undefined) throw new Error(`missing-key: ${key}`)
            const next = schema.parse(mutate(current))
            map.set(key, next)
            return next
          },
        }
      },
      close: async () => {},
    }
  }
}

/** Minimal tenancy stand-in exposing the read-only directory face. */
class FakeTenancy extends Service {
  static name = 'fake-tenancy'
  static inject: string[] = []
  readonly directory = {
    listUsers: () => [
      { subjectId: 'did:key:zAlice', username: 'alice', tenant: 'local' },
      { subjectId: 'did:key:zBob', username: 'bob', tenant: 'local' },
    ],
    getPolicy: () => undefined,
  }
  constructor(ctx: Context) {
    super(ctx, 'tentacleTenancy')
  }
}

/** Minimal official-credentials stand-in: refs + write-only instance records. */
class FakeCredentials extends Service {
  static name = 'fake-credentials'
  static inject: string[] = []
  readonly refs = new Map<string, string>()
  readonly records = new Map<string, { kind: 'grant'; payload: Record<string, string> }>()
  constructor(ctx: Context, refs: Record<string, string> = {}) {
    super(ctx, 'credentials')
    for (const [key, value] of Object.entries(refs)) this.refs.set(key, value)
  }
  async resolve(ref: { toString(): string }) { const value = this.refs.get(String(ref)); return value === undefined ? undefined : { value } }
  async readRecord(key: { toString(): string }) { return this.records.get(String(key)) }
  async describeRecord(key: { toString(): string }) {
    const present = this.records.has(String(key))
    return { configured: present, writable: true, ...(present ? { kind: 'grant' as const } : {}) }
  }
  async modifyRecord(key: { toString(): string }, mutate: (current: { kind: 'grant'; payload: Record<string, string> } | undefined) => Promise<{ kind: 'grant'; payload: Record<string, string> } | undefined>) {
    const next = await mutate(this.records.get(String(key)))
    if (next !== undefined) this.records.set(String(key), next)
    return next
  }
  async deleteRecord(key: { toString(): string }) { this.records.delete(String(key)) }
}

/** Minimal webhook runtime stand-in: records deliveries and exposes its rules. */
class FakeWebhookRuntime extends Service {
  static name = 'fake-webhook-runtime'
  static inject: string[] = []
  readonly deliveries: { source?: string; deliveryId?: string; kind?: string; event?: unknown }[] = []
  /** Registered rules, keyed by id, so a test can drive one like the runtime. */
  readonly rules = new Map<string, { kind: string; run(delivery: { source: string }, signal: AbortSignal): unknown }>()
  constructor(ctx: Context) {
    super(ctx, 'webhookRuntime')
  }
  register(rule: { id: string; kind: string; run(delivery: { source: string }, signal: AbortSignal): unknown }): () => Promise<void> {
    if (this.rules.has(rule.id)) throw new Error(`webhook rule "${rule.id}" is already registered`)
    this.rules.set(rule.id, rule)
    return async () => { this.rules.delete(rule.id) }
  }
  dispatch(delivery: unknown): void {
    this.deliveries.push(delivery as never)
  }
}

/** Recording adapter so a test can drive inbound messages and see replies. */
class FakeAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const
  readonly constraints = { maxMessageChars: 4096, supportsTyping: true }
  readonly sent: string[] = []
  handler: ((message: InboundMessage) => Promise<void>) | undefined
  started = false
  stopped = false
  constructor(readonly channelId: string, readonly config: Record<string, unknown> = {}) {}
  onMessage(handler: (message: InboundMessage) => Promise<void>): void { this.handler = handler }
  async start(): Promise<{ stop(): Promise<void> }> {
    this.started = true
    return { stop: async () => { this.stopped = true } }
  }
  async send(_subject: unknown, content: readonly { type: string; text?: string }[]): Promise<void> {
    this.sent.push(content.map((part) => part.text ?? '').join(''))
  }
}

/**
 * Minimal persona stand-in: the service requires `tentaclePersona` (channel
 * routing IS expert routing), so tests mount this instead of bypassing the
 * injection with a config seam. Routes point at per-boot temp workspaces.
 */
class FakePersona extends Service {
  static name = 'fake-persona'
  static inject: string[] = []
  readonly ready = Promise.resolve()
  readonly experts: { id: string; name: string }[]
  readonly routes = new Map<string, { agentPresetId: string; workspacePath: string; model?: { provider: string; model: string }; permissionPreset?: string }>()
  readonly guards = new Set<(expertId: string) => string | undefined>()
  constructor(ctx: Context, experts: readonly { id: string; name: string }[] = DEFAULT_EXPERTS) {
    super(ctx, 'tentaclePersona')
    this.experts = [...experts]
    const root = mkdtempSync(join(tmpdir(), 'tentacle-persona-fake-'))
    for (const expert of this.experts) {
      this.routes.set(expert.id, {
        agentPresetId: `expert-${expert.id}`,
        workspacePath: join(root, expert.id, 'workspace'),
      })
    }
  }
  get defaultExpertId(): string { return this.experts[0]!.id }
  resolveForSession(expertId: string) { return this.routes.get(expertId) }
  listExpertRoutes() {
    return this.experts.map((expert) => ({ id: expert.id, name: expert.name, agentPresetId: `expert-${expert.id}` }))
  }
  registerExpertRemovalGuard(guard: (expertId: string) => string | undefined): () => void {
    this.guards.add(guard)
    return () => { this.guards.delete(guard) }
  }
  /** Test helper: what the registered channel guard says about one expert. */
  removalReason(expertId: string): string | undefined {
    for (const guard of this.guards) {
      const reason = guard(expertId)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

const DEFAULT_EXPERTS = [
  { id: 'general-assistant', name: 'General Assistant' },
  { id: 'ops', name: 'Ops' },
] as const

/**
 * Minimal teams stand-in (design 10 §7): mounted as the OPTIONAL `tentacleTeams`
 * seam. It publishes after the channels service's init (cordis inject order),
 * which is exactly the late-mount path the service adopts.
 */
class FakeTeams extends Service {
  static name = 'fake-teams'
  static inject: string[] = []
  /** Resolves on a microtask so `ready` behaves like the real planting wait. */
  readonly ready: Promise<void> = Promise.resolve()
  readonly routes = new Map<string, { agentPresetId: string; workspacePath: string; model?: { provider: string; model: string }; permissionPreset?: string }>()
  readonly guards = new Set<(teamId: string) => string | undefined>()
  constructor(ctx: Context) {
    super(ctx, 'tentacleTeams')
    const root = mkdtempSync(join(tmpdir(), 'tentacle-teams-fake-'))
    for (const team of [{ id: 'product-review', name: 'Product Review' }, { id: 'tech-review', name: 'Tech Review' }]) {
      this.routes.set(team.id, {
        agentPresetId: `team-${team.id}`,
        workspacePath: join(root, team.id, 'workspace'),
      })
    }
  }
  resolveForSession(teamId: string) { return this.routes.get(teamId) }
  listTeamRoutes() {
    return [...this.routes].map(([id, route]) => ({ id, name: id, agentPresetId: route.agentPresetId }))
  }
  registerRemovalGuard(guard: (teamId: string) => string | undefined): () => void {
    this.guards.add(guard)
    return () => { this.guards.delete(guard) }
  }
  /** Test helper: what the registered channel guard says about one team. */
  removalReason(teamId: string): string | undefined {
    for (const guard of this.guards) {
      const reason = guard(teamId)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

interface Boot {
  readonly app: Context
  readonly fiber: Fiber
  readonly adapters: FakeAdapter[]
  /** The mounted credential stand-in (available once the peers are up). */
  credentials(): FakeCredentials
  /** The mounted persona stand-in (available once the peers are up). */
  persona(): FakePersona
  /** The mounted teams stand-in, absent in a persona-only boot. */
  teams(): FakeTeams | undefined
  readonly service: Promise<channelsPlugin.TentacleChannels>
}

/** Boot a real cordis context with stand-in peer services. */
function boot(
  config: channelsPlugin.TentacleChannelsConfig = {},
  options: { withTenancy?: boolean; withTeams?: boolean; refs?: Record<string, string>; experts?: readonly { id: string; name: string }[]; adapter?: (instance: channelsPlugin.ChannelInstance, config: Record<string, unknown>) => ChannelAdapter } = {},
): Boot {
  const app = new Context()
  const adapters: FakeAdapter[] = []
  const peers = [app.plugin(FakeWebhookRuntime), app.plugin(FakeCredentials, options.refs ?? {}), app.plugin(FakeStorageDomain), app.plugin(FakePersona, options.experts ?? DEFAULT_EXPERTS)]
  if (options.withTenancy ?? true) peers.push(app.plugin(FakeTenancy))
  if (options.withTeams ?? true) peers.push(app.plugin(FakeTeams))
  const fiber = app.plugin(channelsPlugin, {
    // Hermetic by default: the plugin reads a legacy `channels.json` from its
    // state root, and a test must never look at the operator's real DSH home
    // (an empty leftover file there used to materialize a phantom instance).
    stateRoot: config.stateRoot ?? mkdtempSync(join(tmpdir(), 'tentacle-channels-state-')),
    adapterFactory: (instance, adapterConfig, services) => {
      const adapter = options.adapter === undefined
        ? new FakeAdapter(instance.id, adapterConfig as Record<string, unknown>)
        : options.adapter(instance, adapterConfig as Record<string, unknown>)
      if (adapter instanceof FakeAdapter) {
        adapters.push(adapter)
        // Exercise the offset store the service hands the adapter: a cursor
        // must round-trip through the durable store.
        void services.offsetStore.save(instance.id, 5)
      }
      return adapter
    },
    ...config,
  })
  const service = withTimeout((async (): Promise<channelsPlugin.TentacleChannels> => {
    // Peer fibers are started first so their services exist. Cordis then
    // publishes a service through an inject-driven reload that settles a
    // microtask after the fiber's thenable resolves, so wait for the published
    // value rather than assuming it is there the moment `await fiber` returns.
    await Promise.all(peers.map((peer) => peer.await()))
    await fiber
    const deadline = Date.now() + 2000
    for (;;) {
      const published = app.get('tentacleChannels') as channelsPlugin.TentacleChannels | undefined
      if (published !== undefined) return published
      if (Date.now() > deadline) throw new Error('channels service was not published')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })(), 'channels boot')
  return { app, fiber, adapters, credentials: () => app.get('credentials') as FakeCredentials, persona: () => app.get('tentaclePersona') as FakePersona, teams: () => app.get('tentacleTeams') as FakeTeams | undefined, service }
}

describe('TentacleChannels boot', () => {
  beforeEach(resetStorage)

  it('materializes the deployment config as one instance and starts it', async () => {
    const { fiber, adapters, service } = boot({ telegram: { enabled: true, tokenRef: 'TELEGRAM_BOT_TOKEN' } }, { refs: { TELEGRAM_BOT_TOKEN: 'token' } })
    const channels = await service
    await channels.ready
    const overview = await channels.overview(ADMIN)
    expect(overview.instances).toHaveLength(1)
    expect(overview.instances[0]).toMatchObject({
      id: 'telegram-legacy',
      tenant: LOCAL,
      name: 'telegram',
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      runtime: { state: 'connected' },
      // A deployment reference is not an instance record: reported as present,
      // never as writable through the console.
      credential: { configured: true, writable: false },
    })
    expect(adapters).toHaveLength(1)
    expect(adapters[0]!.channelId).toBe('telegram-legacy')
    await fiber.dispose()
    expect(adapters[0]!.stopped).toBe(true)
  })

  it('is inert when nothing is configured, and fails loudly without tenancy', async () => {
    const { fiber, adapters, service } = boot()
    const channels = await service
    await channels.ready
    expect((await channels.overview(ADMIN)).instances).toEqual([])
    expect(adapters).toHaveLength(0)
    await fiber.dispose()

    // Without `tentacleTenancy` the declared inject is never satisfied: the
    // service is not published at all, so the composition fails loudly at the
    // loader (unfulfilled dependency) instead of trusting an unbound channel.
    const { app: unbound, fiber: pending } = boot({}, { withTenancy: false })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unbound.get('tentacleChannels')).toBeUndefined()
    await pending.dispose()
  })

  it('reports an enabled instance with no usable token as failed, without killing the boot', async () => {
    const { fiber, service } = boot({ telegram: { enabled: true, tokenRef: 'MISSING_TOKEN' } })
    const channels = await service
    await channels.ready
    const [instance] = (await channels.overview(ADMIN)).instances
    expect(instance!.runtime.state).toBe('failed')
    expect((instance!.runtime as { error: string }).error).toMatch(/no usable bot token/)
    await fiber.dispose()
  })

  it('creates, disables, enables, updates and removes an instance at runtime', async () => {
    const { fiber, adapters, credentials: credentialsOf, service } = boot()
    const channels = await service
    await channels.ready
    const credentials = credentialsOf()

    const created = await channels.createChannel({ channelType: 'telegram', name: 'bot-a', credentials: { token: 'secret' }, target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    expect(created.runtime).toEqual({ state: 'connected' })
    expect(created.credential).toEqual({ configured: true, writable: true })
    expect(adapters).toHaveLength(1)
    expect([...credentials.records.values()]).toEqual([{ kind: 'grant', payload: { token: 'secret' } }])

    // Disable stops the adapter but keeps the record, config and credential.
    const disabled = await channels.setChannelEnabled(created.id, false, ADMIN)
    expect(disabled.runtime).toEqual({ state: 'disabled' })
    expect(adapters[0]!.stopped).toBe(true)

    // Enable builds a NEW adapter (a stopped one cannot restart).
    await channels.setChannelEnabled(created.id, true, ADMIN)
    expect(adapters).toHaveLength(2)
    expect(adapters[1]!).not.toBe(adapters[0]!)
    expect(adapters[1]!.started).toBe(true)

    // Update reloads live: the new adapter sees the new config.
    await channels.updateChannel({ id: created.id, name: 'bot-a-renamed', config: { typing: false } }, ADMIN)
    expect(adapters).toHaveLength(3)
    expect(adapters[2]!.config).toMatchObject({ typing: false, pollTimeoutSec: 30 })

    // Remove stops it, drops the credential, and forgets it.
    await channels.removeChannel(created.id, ADMIN)
    expect(adapters[2]!.stopped).toBe(true)
    expect(credentials.records.size).toBe(0)
    expect((await channels.overview(ADMIN)).instances).toEqual([])
    await fiber.dispose()
  })

  it('refuses duplicate names and fences other tenants through the service', async () => {
    const { fiber, service } = boot()
    const channels = await service
    await channels.ready
    await channels.createChannel({ channelType: 'telegram', name: 'bot-a', target: { kind: 'expert', id: 'general-assistant' } }, ALICE)
    await expect(channels.createChannel({ channelType: 'telegram', name: 'bot-a', target: { kind: 'expert', id: 'general-assistant' } }, ADMIN))
      .rejects.toMatchObject({ code: 'name-taken' })
    await expect(channels.createChannel({ channelType: 'telegram', name: 'bot-c', target: { kind: 'expert', id: 'general-assistant' }, tenant: OTHER }, ALICE))
      .rejects.toMatchObject({ code: 'forbidden-tenant' })
    const theirs = await channels.createChannel({ channelType: 'telegram', name: 'bot-b', target: { kind: 'expert', id: 'general-assistant' }, tenant: OTHER }, ADMIN)
    expect((await channels.overview(ALICE)).instances.map((instance) => instance.id)).not.toContain(theirs.id)
    expect((await channels.overview(ADMIN)).instances).toHaveLength(2)
    await fiber.dispose()
  })

  it('routes an inbound message through the parked request for ITS instance only', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'tentacle-channels-root-'))
    const { app, fiber, adapters, persona, service } = boot({ workspaceRoot })
    const channels = await service
    await channels.ready
    const created = await channels.createChannel({ channelType: 'telegram', name: 'bot-a', credentials: { token: 'secret' }, target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    await channels.bind({ channelId: created.id, platformId: '7', subjectId: 'did:key:zAlice' }, ADMIN)

    const adapter = adapters[0]!
    await adapter.handler!(inbound(created.id))
    const runtime = (app as unknown as { webhookRuntime: FakeWebhookRuntime }).webhookRuntime
    expect(runtime.deliveries).toHaveLength(1)
    expect(runtime.deliveries[0]).toMatchObject({ kind: 'telegram', deliveryId: 'telegram:7:1', source: created.id })

    const rule = runtime.rules.get('tentacle-channels:telegram')!
    expect(rule.kind).toBe('telegram')
    // The rule answers only for the instance that parked the request.
    expect(rule.run({ source: 'some-other-bot' }, new AbortController().signal)).toBeNull()
    // The expert decides the workspace/preset, not the deploy default
    // (`workspaceRoot` is only used when no expert resolves).
    expect(rule.run({ source: created.id }, new AbortController().signal)).toMatchObject({
      workspacePath: persona().routes.get('general-assistant')!.workspacePath,
      agentPreset: 'expert-general-assistant',
      title: 'telegram:7',
      prompt: 'hello',
      permissionPreset: 'workspace-write',
    })
    // The session feed is a real cordis subscription; a foreign session must
    // not produce a reply on this channel.
    const session = { id: 'webhook-1', header: { cwd: '/nonexistent-for-test' } } as never
    app.emit('session/created', session)
    const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } } as unknown as RouterSessionEvent
    app.emit('session/event', session, { type: event.type, data: event.data, seq: 0, time: 0 } as never)
    app.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 1, time: 0 } as never)
    expect(adapter.sent).toEqual([])
    await fiber.dispose()
  })

  it('keeps the deployment seed open until a real configuration arrives', async () => {
    // The bundle ships `telegram: { enabled: false }` and an operator overlay
    // arrives as a second config state (a reload) against the same store. The
    // seed must not be closed by the first, unconfigured pass — otherwise the
    // operator's configuration is swallowed and no instance ever appears.
    const first = boot({ telegram: { enabled: false } })
    const unconfigured = await first.service
    await unconfigured.ready
    expect((await unconfigured.overview(ADMIN)).instances).toEqual([])
    await first.fiber.dispose()

    const second = boot(
      { telegram: { enabled: true, tokenRef: 'TELEGRAM_BOT_TOKEN' } },
      { refs: { TELEGRAM_BOT_TOKEN: 'token' } },
    )
    const configured = await second.service
    await configured.ready
    const instances = (await configured.overview(ADMIN)).instances
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({ id: 'telegram-legacy', enabled: true, runtime: { state: 'connected' } })
    await second.fiber.dispose()
  })

  it('ignores an empty legacy document instead of materializing a phantom instance', async () => {
    // The pre-instances plugin created `channels.json` on its first write even
    // when nobody had bound anything. Such a file must not make a channel
    // appear out of nothing.
    const stateRoot = mkdtempSync(join(tmpdir(), 'tentacle-channels-empty-'))
    writeFileSync(join(stateRoot, 'channels.json'), JSON.stringify({
      version: 1,
      offsets: {},
      bindings: [],
      conversations: [],
    }))
    const { fiber, service } = boot({ stateRoot })
    const channels = await service
    await channels.ready
    expect((await channels.overview(ADMIN)).instances).toEqual([])
    await fiber.dispose()
  })

  it('imports legacy state once and never resurrects a deleted instance', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'tentacle-channels-legacy-'))
    writeFileSync(join(stateRoot, 'channels.json'), JSON.stringify({
      version: 1,
      offsets: { telegram: 41 },
      bindings: [{ channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice', boundAt: 1 }],
      conversations: [{ channelType: 'telegram', chatId: '7', chatKind: 'dm', subjectId: 'did:key:zAlice', sessionId: 'webhook-1', createdAt: 1, updatedAt: 1 }],
    }))
    const config = { stateRoot, telegram: { enabled: true, tokenRef: 'TELEGRAM_BOT_TOKEN' } }
    const first = boot(config, { refs: { TELEGRAM_BOT_TOKEN: 'token' } })
    const channels = await first.service
    await channels.ready
    const overview = await channels.overview(ADMIN)
    expect(overview.instances).toHaveLength(1)
    expect(overview.bindings).toHaveLength(1)
    expect(overview.bindings[0]).toMatchObject({ channelId: 'telegram-legacy', platformId: '7', username: 'alice' })
    expect(overview.conversations[0]).toMatchObject({ channelId: 'telegram-legacy', sessionId: 'webhook-1' })
    await channels.flush()
    expect(offsetsTable().get('telegram-legacy')).toBe(5)
    // The operator deletes it; a later boot with the same durable store must
    // not bring the config seed back.
    await channels.removeChannel('telegram-legacy', ADMIN)
    await first.fiber.dispose()

    const second = boot(config, { refs: { TELEGRAM_BOT_TOKEN: 'token' } })
    const restarted = await second.service
    await restarted.ready
    expect((await restarted.overview(ADMIN)).instances).toEqual([])
    await second.fiber.dispose()
  })
})

/** Scripted quick-setup flow: each poll pops the next scripted outcome. */
class FakeFlow implements ProvisionFlow {
  readonly channelType = 'telegram' as const
  readonly started: unknown[] = []
  readonly stopped: unknown[] = []
  script: ProvisionPoll[] = []
  async start(session: ProvisionSession): Promise<ProvisionStart> {
    this.started.push(session)
    return { qrUrl: 'https://qr.example/scan', userCode: 'ABCD-EFGH', expiresAt: Date.now() + 60_000 }
  }
  async poll(): Promise<ProvisionPoll> {
    return this.script.shift() ?? { state: 'waiting' }
  }
  async stop(session: ProvisionSession): Promise<void> {
    this.stopped.push(session)
  }
}

describe('quick-setup provisioning (design 08)', () => {
  beforeEach(resetStorage)

  it('walks waiting → success with the instance created, enabled and secret stored once', async () => {
    const flow = new FakeFlow()
    const { fiber, adapters, credentials: credentialsOf, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready

    const started = await channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    expect(started).toMatchObject({
      state: 'waiting',
      qrUrl: 'https://qr.example/scan',
      userCode: 'ABCD-EFGH',
    })
    const flowId = (started as { flowId: string }).flowId
    expect(await channels.pollProvision(flowId, ADMIN)).toMatchObject({ state: 'waiting', flowId })

    flow.script.push({
      state: 'success',
      name: 'scanned-bot',
      credentials: { token: 'qr-issued-token' },
      config: { pollTimeoutSec: 15 },
    })
    const done = await channels.pollProvision(flowId, ADMIN)
    expect(done).toMatchObject({ state: 'success', flowId })
    const instance = (done as { instance: { id: string; enabled: boolean; runtime: { state: string } } }).instance
    expect(instance.enabled).toBe(true)
    expect(instance.runtime.state).toBe('connected')
    expect(adapters).toHaveLength(1)
    expect([...credentialsOf().records.values()]).toEqual([{ kind: 'grant', payload: { token: 'qr-issued-token' } }])

    // One-time: the session is consumed by its terminal poll.
    await expect(channels.pollProvision(flowId, ADMIN)).rejects.toMatchObject({ code: 'no-such-flow' })
    await fiber.dispose()
  })

  it('starting a new flow cancels the previous one for the same actor', async () => {
    const flow = new FakeFlow()
    const { fiber, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready
    const first = await channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    const second = await channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    expect(flow.stopped).toHaveLength(1)
    expect((first as { flowId: string }).flowId).not.toBe((second as { flowId: string }).flowId)
    await expect(channels.stopProvision((first as { flowId: string }).flowId, ADMIN)).rejects.toMatchObject({ code: 'no-such-flow' })
    await channels.stopProvision((second as { flowId: string }).flowId, ADMIN)
    expect(flow.stopped).toHaveLength(2)
    await fiber.dispose()
  })

  it('hides a session from any other actor and reports terminal states honestly', async () => {
    const flow = new FakeFlow()
    const { fiber, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready
    const started = await channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    const flowId = (started as { flowId: string }).flowId
    // A fellow tenant member (non-admin) cannot even see it exists.
    await expect(channels.pollProvision(flowId, ALICE)).rejects.toMatchObject({ code: 'no-such-flow' })

    flow.script.push({ state: 'failed', error: 'platform refused the scan' })
    await expect(channels.pollProvision(flowId, ADMIN)).resolves.toMatchObject({
      state: 'failed',
      error: 'platform refused the scan',
    })
    await expect(channels.startProvision({ channelType: 'feishu' }, ADMIN)).rejects.toMatchObject({ code: 'no-provision-flow' })
    await fiber.dispose()
  })

  it('binds a newly created instance to the expert selected in the console', async () => {
    const flow = new FakeFlow()
    const { fiber, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready

    const started = await channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'ops' } }, ADMIN)
    const flowId = (started as { flowId: string }).flowId
    flow.script.push({ state: 'success', credentials: { token: 'qr-token' } })
    const done = await channels.pollProvision(flowId, ADMIN)
    expect(done).toMatchObject({ state: 'success' })
    expect((done as { instance: { target?: { kind: string; id: string } } }).instance.target)
      .toEqual({ kind: 'expert', id: 'ops' })
    await fiber.dispose()
  })

  it('repairs an existing instance in place when the flow targets it', async () => {
    const flow = new FakeFlow()
    const { fiber, credentials: credentialsOf, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready

    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      target: { kind: 'expert', id: 'general-assistant' },
      credentials: { token: 'old-token' },
      config: { pollTimeoutSec: 30, typing: true },
    }, ADMIN)

    const started = await channels.startProvision({ channelType: 'telegram', instanceId: created.id }, ADMIN)
    const flowId = (started as { flowId: string }).flowId
    flow.script.push({ state: 'success', credentials: { token: 'new-token' }, config: { pollTimeoutSec: 15 } })
    const done = await channels.pollProvision(flowId, ADMIN)
    expect(done).toMatchObject({ state: 'success' })
    const instance = (done as { instance: { id: string; name: string } }).instance
    // Same instance, same name — a re-scan must not create a duplicate bot.
    expect(instance.id).toBe(created.id)
    expect(instance.name).toBe('bot-a')
    // The credential is rotated, not appended; the config is merged, not replaced.
    expect([...credentialsOf().records.values()]).toEqual([{ kind: 'grant', payload: { token: 'new-token' } }])
    const overview = await channels.overview(ADMIN)
    expect(overview.instances).toHaveLength(1)
    expect(overview.instances[0]!.config).toEqual({ pollTimeoutSec: 15, typing: true })
    await fiber.dispose()
  })

  it('refuses a repair whose platform type or instance id does not match', async () => {
    const flow = new FakeFlow()
    const { fiber, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready

    await expect(channels.startProvision({ channelType: 'telegram', instanceId: 'missing' }, ADMIN))
      .rejects.toMatchObject({ code: 'no-such-channel' })

    const wx = await channels.createChannel({
      channelType: 'weixin',
      name: 'wx',
      target: { kind: 'expert', id: 'general-assistant' },
      credentials: { accountId: 'acc', token: 'tok' },
    }, ADMIN)
    await expect(channels.startProvision({ channelType: 'telegram', instanceId: wx.id }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-channel-type' })
    await fiber.dispose()
  })

  it('requires an expert for a creating flow and rejects one on a repair', async () => {
    const flow = new FakeFlow()
    const { fiber, service } = boot({ provisionFlows: [flow] })
    const channels = await service
    await channels.ready

    await expect(channels.startProvision({ channelType: 'telegram' }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(channels.startProvision({ channelType: 'telegram', target: { kind: 'expert', id: 'ghost' } }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })

    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      target: { kind: 'expert', id: 'general-assistant' },
      credentials: { token: 'old-token' },
    }, ADMIN)
    await expect(channels.startProvision({ channelType: 'telegram', instanceId: created.id, target: { kind: 'expert', id: 'ops' } }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await fiber.dispose()
  })
})

describe('unbound sender inbox (design 06 §5)', () => {
  beforeEach(resetStorage)

  it('lists a refused sender and drops the row once the admin binds them', async () => {
    const { fiber, adapters, service } = boot()
    const channels = await service
    await channels.ready
    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      target: { kind: 'expert', id: 'general-assistant' },
      credentials: { token: 't' },
    }, ADMIN)

    // The adapter's handler is the production inbound path (router included).
    await adapters[0]!.handler!(inbound(created.id))
    const overview = await channels.overview(ADMIN)
    expect(overview.pendingSenders).toEqual([{
      channelId: created.id,
      channelType: 'telegram',
      platformId: '7',
      preview: 'hello',
      lastSeen: expect.any(Number),
      messages: 1,
    }])

    await channels.bind({ channelId: created.id, platformId: '7', subjectId: 'did:key:zAlice' }, ADMIN)
    expect((await channels.overview(ADMIN)).pendingSenders).toEqual([])
    await fiber.dispose()
  })
})

/** Fail a hanging boot with a message instead of a bare vitest timeout. */
function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms).unref?.()
    }),
  ])
}

function inbound(channelId: string): InboundMessage {
  return {
    channelId,
    channelType: 'telegram',
    messageId: 'telegram:7:1',
    subject: { chatId: '7', kind: 'dm' },
    sender: { platformId: '7' },
    content: [{ type: 'text', text: 'hello' }],
    receivedAt: 0,
    metadata: {},
  }
}

describe('expert routing binding (design 09 §3.3)', () => {
  beforeEach(resetStorage)

  it('requires a known expert on create and allows a rebind but never an unbind', async () => {
    const { fiber, persona, service } = boot()
    const channels = await service
    await channels.ready

    // No expert, an unknown expert, and a malformed id are all refused.
    await expect(channels.createChannel({ channelType: 'telegram', name: 'no-expert' }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(channels.createChannel({ channelType: 'telegram', name: 'ghost', target: { kind: 'expert', id: 'ghost' } }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(channels.createChannel({ channelType: 'telegram', name: 'bad', target: { kind: 'expert', id: 'Bad ID' } }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })

    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      credentials: { token: 't' },
      target: { kind: 'expert', id: 'general-assistant' },
    }, ADMIN)
    expect(created.target).toEqual({ kind: 'expert', id: 'general-assistant' })
    expect((await channels.overview(ADMIN)).instances[0]).toMatchObject({
      target: { kind: 'expert', id: 'general-assistant' },
      targetName: 'General Assistant',
    })
    expect(channels.listExpertRoutes()).toEqual(persona().listExpertRoutes())

    // Rebinding is a move; clearing is not a representable state.
    expect((await channels.updateChannel({ id: created.id, target: { kind: 'expert', id: 'ops' } }, ADMIN)).target)
      .toEqual({ kind: 'expert', id: 'ops' })
    await expect(channels.updateChannel({ id: created.id, target: null }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(channels.updateChannel({ id: created.id, target: { kind: 'expert', id: 'ghost' } }, ADMIN))
      .rejects.toMatchObject({ code: 'invalid-config' })
    expect((await channels.overview(ADMIN)).instances[0]!.target).toEqual({ kind: 'expert', id: 'ops' })
    await fiber.dispose()
  })

  it('carries the expert preset, model, permission and shared workspace into the dispatch', async () => {
    const { app, fiber, adapters, persona, service } = boot()
    const channels = await service
    await channels.ready
    const ops = persona().routes.get('ops')!
    persona().routes.set('ops', {
      ...ops,
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      permissionPreset: 'read-only',
    })
    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      credentials: { token: 't' },
      target: { kind: 'expert', id: 'ops' },
    }, ADMIN)
    await channels.bind({ channelId: created.id, platformId: '7', subjectId: 'did:key:zAlice' }, ADMIN)
    await adapters[0]!.handler!(inbound(created.id))

    const runtime = (app as unknown as { webhookRuntime: FakeWebhookRuntime }).webhookRuntime
    const rule = runtime.rules.get('tentacle-channels:telegram')!
    expect(rule.run({ source: created.id }, new AbortController().signal)).toMatchObject({
      agentPreset: 'expert-ops',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      permissionPreset: 'read-only',
      workspacePath: ops.workspacePath,
    })
    await fiber.dispose()
  })

  it('vetoes deleting an expert that a channel still routes to', async () => {
    const { fiber, persona, service } = boot()
    const channels = await service
    await channels.ready
    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'bot-a',
      credentials: { token: 't' },
      target: { kind: 'expert', id: 'ops' },
    }, ADMIN)

    expect(persona().removalReason('ops')).toContain('bot-a')
    expect(persona().removalReason('general-assistant')).toBeUndefined()

    // Rebinding away releases the veto; so does deleting the channel.
    await channels.updateChannel({ id: created.id, target: { kind: 'expert', id: 'general-assistant' } }, ADMIN)
    expect(persona().removalReason('ops')).toBeUndefined()
    expect(persona().removalReason('general-assistant')).toContain('bot-a')
    await channels.removeChannel(created.id, ADMIN)
    expect(persona().removalReason('general-assistant')).toBeUndefined()
    await fiber.dispose()
  })

  it('migrates a pre-expert channel row onto the default expert before starting it', async () => {
    // A row written by the channels build before design 09 has no expertId.
    // It must open (the durable schema tolerates it), get bound to the default
    // expert, and never start without a route.
    storageBacking.tables.set('channels', new Map([['legacy-bot', {
      id: 'legacy-bot',
      tenant: 'local',
      channelType: 'telegram',
      name: 'legacy-bot',
      enabled: false,
      config: {},
      createdAt: 1,
      updatedAt: 1,
    }]]))
    const { fiber, service } = boot()
    const channels = await service
    await channels.ready
    const [instance] = (await channels.overview(ADMIN)).instances
    expect(instance).toMatchObject({
      id: 'legacy-bot',
      target: { kind: 'expert', id: 'general-assistant' },
      targetName: 'General Assistant',
    })
    await fiber.dispose()
  })

  it('routes a channel bound to a team through the team preset and workspace', async () => {
    const { app, fiber, adapters, teams, service } = boot()
    const channels = await service
    await channels.ready
    const team = teams()!.routes.get('product-review')!
    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'team-bot',
      credentials: { token: 't' },
      target: { kind: 'team', id: 'product-review' },
    }, ADMIN)
    expect(created.target).toEqual({ kind: 'team', id: 'product-review' })
    // The late teams mount is adopted before the channel can start, so the
    // adapter is running (a persona-only boot could not even create it).
    const deadline = Date.now() + 2000
    while (!adapters[0]!.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(adapters[0]!.started).toBe(true)

    await channels.bind({ channelId: created.id, platformId: '7', subjectId: 'did:key:zAlice' }, ADMIN)
    await adapters[0]!.handler!(inbound(created.id))

    const runtime = (app as unknown as { webhookRuntime: FakeWebhookRuntime }).webhookRuntime
    const rule = runtime.rules.get('tentacle-channels:telegram')!
    expect(rule.run({ source: created.id }, new AbortController().signal)).toMatchObject({
      agentPreset: 'team-product-review',
      workspacePath: team.workspacePath,
    })
    await fiber.dispose()
  })

  it('vetoes deleting a team that a channel still routes to', async () => {
    const { fiber, teams, service } = boot()
    const channels = await service
    await channels.ready
    const created = await channels.createChannel({
      channelType: 'telegram',
      name: 'team-bot',
      credentials: { token: 't' },
      target: { kind: 'team', id: 'tech-review' },
    }, ADMIN)

    expect(teams()!.removalReason('tech-review')).toContain('team-bot')
    expect(teams()!.removalReason('product-review')).toBeUndefined()

    await channels.updateChannel({ id: created.id, target: { kind: 'team', id: 'product-review' } }, ADMIN)
    expect(teams()!.removalReason('tech-review')).toBeUndefined()
    expect(teams()!.removalReason('product-review')).toContain('team-bot')
    await fiber.dispose()
  })

  it('refuses a team binding when the teams plugin is absent', async () => {
    // Persona-only deployment: with no team library mounted the binding can
    // never resolve, so the write is refused up front instead of parking an
    // adapter that could only dispatch-fail in front of an end user.
    const { adapters, service } = boot({}, { withTeams: false })
    const channels = await service
    await channels.ready
    await expect(channels.createChannel({
      channelType: 'telegram',
      name: 'team-bot',
      credentials: { token: 't' },
      target: { kind: 'team', id: 'product-review' },
    }, ADMIN)).rejects.toMatchObject({ code: 'invalid-config' })
    expect(adapters).toHaveLength(0)
    expect(channels.listTeamRoutes()).toEqual([])
  })

  it('migrates a pre-target expertId row onto that expert', async () => {
    // A row written before design 10 §7 carries a bare expertId; the binding
    // it declares is kept instead of being rewritten to the default expert.
    storageBacking.tables.set('channels', new Map([['legacy-bot', {
      id: 'legacy-bot',
      tenant: 'local',
      channelType: 'telegram',
      name: 'legacy-bot',
      enabled: false,
      config: {},
      expertId: 'ops',
      createdAt: 1,
      updatedAt: 1,
    }]]))
    const { fiber, service } = boot()
    const channels = await service
    await channels.ready
    const [instance] = (await channels.overview(ADMIN)).instances
    expect(instance).toMatchObject({
      id: 'legacy-bot',
      target: { kind: 'expert', id: 'ops' },
      targetName: 'Ops',
    })
    await fiber.dispose()
  })
})
