/**
 * SessionRouter tests: binding policy, conversation→session correlation
 * (including the races), turn-level outbound aggregation, and — since the
 * multi-instance refactor (design 07 §1) — the isolation guarantees between
 * two channel instances that share one platform. Every DSH seam is a fake:
 * no runtime, no sessions service, no network.
 *
 * The store is the real in-memory `MemoryStore`, so the tests assert the
 * durable key space (per-instance conversation and cursor keys) exactly as
 * production writes it.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tenantId } from '@tentacle/identity'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/bindings.js'
import {
  MemoryStore,
  conversationKey,
  type ConversationLink,
} from '../src/repo.js'
import {
  SessionRouter,
  assistantTextOf,
  canonicalize,
  type CreatedSession,
  type DispatchRequest,
  type ResumePromptMessage,
  type RouterSessionEvent,
  type SessionEventSink,
  type WebhookDispatchPort,
} from '../src/router/router.js'
import type { ChannelAdapter, ChannelSubject, ContentPart, InboundMessage } from '../src/types.js'

interface Sent {
  readonly subject: ChannelSubject
  readonly content: readonly ContentPart[]
}

/** Recording adapter: captures every outbound send for one instance. */
class FakeAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const
  readonly constraints = { maxMessageChars: 4096, supportsTyping: true }
  readonly sent: Sent[] = []
  handler: ((message: InboundMessage) => Promise<void>) | undefined
  failSend = false
  constructor(readonly channelId: string) {}
  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }
  async start(): Promise<{ stop(): Promise<void> }> {
    return { stop: async () => undefined }
  }
  async send(subject: ChannelSubject, content: readonly ContentPart[]): Promise<void> {
    if (this.failSend) throw new Error('platform refused the message')
    this.sent.push({ subject, content })
  }
  inbound(): readonly string[] {
    return this.sent.map((s) => s.content.map((c) => (c.type === 'text' ? c.text : '')).join(''))
  }
}

/** What the registered rule returns; the runtime turns it into one Session. */
interface SessionRequest {
  readonly workspacePath: string
  readonly title: string
  readonly prompt: string
  readonly agentPreset: string
  readonly permissionPreset: string
}

type RegisteredRule = Parameters<WebhookDispatchPort['register']>[0]

/**
 * Recording dispatch port that mirrors the official runtime's contract: one
 * registered rule per channel kind, `run(delivery, signal)` keyed by the
 * delivery's `source`, and a dispatch that starts the rule on a microtask.
 *
 * The request must be parked BEFORE the dispatch, and `run` must select by
 * `source` (the instance id) rather than FIFO across instances — the pairing
 * below is what the multi-instance isolation tests exercise.
 */
class FakeWebhook implements WebhookDispatchPort {
  readonly requests: DispatchRequest[] = []
  readonly sessions: SessionRequest[] = []
  /** When false, `dispatch` parks the delivery and the test drives `run`. */
  autoRun = true
  /** Simulate the runtime refusing a dispatch synchronously (closing/unload). */
  failDispatch = false
  private readonly rules = new Map<string, RegisteredRule>()

  register(rule: RegisteredRule): () => Promise<void> {
    if (this.rules.has(rule.id)) throw new Error(`webhook rule "${rule.id}" is already registered`)
    this.rules.set(rule.id, rule)
    return async () => { this.rules.delete(rule.id) }
  }

  dispatch(request: DispatchRequest): void {
    if (this.failDispatch) throw new Error('runtime refuses')
    this.requests.push(request)
    if (!this.autoRun) return
    // The real runtime starts the rule asynchronously; mirroring that catches a
    // router that dispatches before parking its request.
    void Promise.resolve().then(async () => {
      await this.run(request.delivery.source, request.delivery.deliveryId)
    })
  }

  /** Invoke the registered rule for one source, exactly as the runtime would. */
  async run(source: string, deliveryId = 'delivery'): Promise<SessionRequest | null> {
    for (const rule of this.rules.values()) {
      const result = await rule.run(
        { kind: rule.kind, source, deliveryId },
        new AbortController().signal,
      )
      if (result !== null) this.sessions.push(result)
      return result
    }
    return null
  }
}

/** Manual session feed: the test decides when a session appears and how. */
class FakeSessions implements SessionEventSink {
  private readonly created: Array<(session: CreatedSession) => void> = []
  private readonly events: Array<(session: CreatedSession, event: RouterSessionEvent) => void> = []
  onSessionCreated(listener: (session: CreatedSession) => void): () => void {
    this.created.push(listener)
    return () => { this.created.splice(this.created.indexOf(listener), 1) }
  }
  onSessionEvent(listener: (session: CreatedSession, event: RouterSessionEvent) => void): () => void {
    this.events.push(listener)
    return () => { this.events.splice(this.events.indexOf(listener), 1) }
  }
  emitCreated(session: CreatedSession): void {
    for (const listener of [...this.created]) listener(session)
  }
  emitEvent(session: CreatedSession, event: RouterSessionEvent): void {
    for (const listener of [...this.events]) listener(session, event)
  }
}

/** One row the tenancy directory would report for a bindable user. */
interface DirectoryUser {
  readonly subjectId: string
  readonly username: string
  readonly tenant?: string
}

interface BindSpec {
  readonly channelId: string
  readonly platformId: string
  readonly subjectId: string
}

interface HarnessOptions {
  /** Adapter instance ids to attach; the first is the default binding target. */
  readonly instances?: readonly string[]
  readonly users?: readonly DirectoryUser[]
  readonly binds?: readonly BindSpec[]
  readonly agents?: ReadonlyMap<string, { readonly agent: { followup(message: ResumePromptMessage): void } }>
  readonly replyToUnbound?: boolean
  /** Pre-existing durable links, for restart scenarios. */
  readonly conversations?: readonly ConversationLink[]
  /** Workspace root per bound subject; defaults to one shared temp dir. */
  readonly workspaceRoot?: (subjectId: string) => string
  readonly sessionClaimTimeoutMs?: number
  readonly webhook?: FakeWebhook
  /** Quota gate override; defaults to "allowed". */
  readonly agentQuota?: (subjectId: string) => { readonly ok: boolean; readonly reason?: string }
  /** Refused-sender recorder (the console inbox seam). */
  readonly onUnboundSender?: (message: InboundMessage, preview: string) => void
  /** Successful-binding notifier (the inbox row is dropped on it). */
  readonly onBound?: (channelId: string, platformId: string) => void
  /** Target routing seam (design 09 for experts, 10 §7 for teams). */
  readonly targetFor?: (channelId: string) => {
    agentPresetId: string
    model?: { provider: string; model: string; maxTokens?: number }
    permissionPreset?: string
    workspacePath?: string
  } | undefined
}

interface Harness {
  readonly router: SessionRouter
  readonly store: MemoryStore
  readonly bindings: BindingStore
  readonly webhook: FakeWebhook
  readonly sessions: FakeSessions
  readonly workspace: string
  readonly adapters: ReadonlyMap<string, FakeAdapter>
  /** Recording adapter for one instance; throws when nothing is attached. */
  adapter(channelId: string): FakeAdapter
  /** Durable conversation links currently in the store. */
  links(): ConversationLink[]
}

const routers: SessionRouter[] = []

afterEach(async () => {
  for (const router of routers.splice(0)) await router.stop()
})

const DEFAULT_USERS: readonly DirectoryUser[] = [
  { subjectId: 'did:key:zAlice', username: 'alice' },
  { subjectId: 'did:key:zBob', username: 'bob' },
]

/** The instance every single-instance test runs against. */
const DEFAULT_INSTANCE = 'telegram'

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'tentacle-channels-ws-'))
  const store = new MemoryStore()
  const instanceIds = options.instances ?? [DEFAULT_INSTANCE]
  const users = (options.users ?? DEFAULT_USERS).map((user) => ({ ...user, tenant: user.tenant ?? 'local' }))
  const bindings = new BindingStore(store, { listUsers: () => users })
  const binds = options.binds ?? [{ channelId: instanceIds[0]!, platformId: '7', subjectId: 'did:key:zAlice' }]
  for (const bind of binds) {
    // Synchronous for the test: `MemoryTable.put` sets before it resolves, so
    // the router sees the binding immediately, mirroring an admin who bound
    // the identity earlier (the directory write is awaited here for clarity).
    await bindings.bind({
      channelId: bind.channelId,
      channelType: 'telegram',
      platformId: bind.platformId,
      subjectId: bind.subjectId,
      tenant: tenantId('local'),
    })
  }
  for (const conversation of options.conversations ?? []) {
    await store.conversations.put(conversationKey(conversation), conversation)
  }
  const webhook = options.webhook ?? new FakeWebhook()
  const sessions = new FakeSessions()
  const agents = options.agents
  // The bind-code store shares the harness's durable store, exactly like the
  // production wiring where router and codes read the same tables.
  const router = new SessionRouter({
    permissionPreset: 'workspace-write',
    agentPreset: 'standard',
    workspaceRoot: options.workspaceRoot ?? (() => workspace),
    replyToUnbound: options.replyToUnbound ?? true,
    unboundReply: 'please bind first',
    sessionTimeoutReply: 'session timeout',
    dispatchFailureReply: 'dispatch failed',
    turnErrorReply: '(turn failed)',
    sessionClaimTimeoutMs: options.sessionClaimTimeoutMs ?? 50,
    ...(options.agentQuota === undefined ? {} : { agentQuota: options.agentQuota }),
    ...(options.onUnboundSender === undefined ? {} : { onUnboundSender: options.onUnboundSender }),
    ...(options.onBound === undefined ? {} : { onBound: options.onBound }),
    ...(options.targetFor === undefined ? {} : { targetFor: options.targetFor }),
    quotaReply: 'quota exhausted',
    ownerFor: (tenant) => tenant === 'local' ? 'did:key:zAdmin' : undefined,
    guestWorkspaceRoot: (tenant) => `/guest-ws/${tenant ?? 'local'}`,
    webhook,
    bindings,
    store,
    ...(agents === undefined ? {} : { agents: { get: (id: string) => agents.get(id) } }),
  })
  const adapters = new Map<string, FakeAdapter>()
  for (const id of instanceIds) {
    const adapter = new FakeAdapter(id)
    adapters.set(id, adapter)
    router.attach(adapter)
  }
  router.start(sessions)
  // Rules are registered per kind when adapters start in production; the
  // harness attaches its fakes directly, so it registers the kind itself.
  router.registerKind('telegram')
  routers.push(router)
  return {
    router, store, bindings, webhook, sessions, workspace, adapters,
    adapter(channelId) {
      const found = adapters.get(channelId)
      if (found === undefined) throw new Error(`no adapter attached for ${channelId}`)
      return found
    },
    links: () => [...store.conversations.entries()].map(([, conversation]) => conversation),
  }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelId: DEFAULT_INSTANCE,
    channelType: 'telegram',
    messageId: 'telegram:7:10',
    subject: { chatId: '7', kind: 'dm' },
    sender: { platformId: '7', displayName: 'Ada' },
    content: [{ type: 'text', text: 'hello' }],
    receivedAt: 1_700_000_000_000,
    metadata: {},
    ...overrides,
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('SessionRouter binding policy', () => {
  it('refuses an unbound sender, warns, and replies with guidance', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound({ sender: { platformId: '999' } }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['please bind first'])
  })

  it('routes a bound sender through the target: preset, model, permission and shared workspace', async () => {
    const targetWorkspace = mkdtempSync(join(tmpdir(), 'tentacle-target-ws-'))
    const h = await harness({
      targetFor: () => ({
        agentPresetId: 'expert-ops',
        model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 },
        permissionPreset: 'read-only',
        workspacePath: targetWorkspace,
      }),
    })
    await h.router.handleInbound(inbound({ messageId: 'target-1' }))
    expect(h.webhook.requests).toHaveLength(1)
    expect(h.webhook.requests[0]).toMatchObject({
      agentPreset: 'expert-ops',
      permissionPreset: 'read-only',
      workspacePath: targetWorkspace,
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 },
    })
  })

  it('fails the dispatch instead of falling back when target resolution throws', async () => {
    // Target routing is mandatory: a channel claiming a target that no longer
    // resolves must never run with deployment defaults behind the operator's back.
    const h = await harness({
      targetFor: () => { throw new Error('expert ops is gone') },
    })
    await h.router.handleInbound(inbound({ messageId: 'missing-target-1' }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['dispatch failed'])
  })

  it('stays silent for an unbound sender when replying is disabled', async () => {
    const h = await harness({ replyToUnbound: false })
    await h.router.handleInbound(inbound({ sender: { platformId: '999' } }))
    expect(h.adapter(DEFAULT_INSTANCE).sent).toHaveLength(0)
  })

  it('dispatches a bound sender with a pinned permission preset and stable title', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound())
    expect(h.webhook.requests).toHaveLength(1)
    const request = h.webhook.requests[0]!
    expect(request).toMatchObject({
      workspacePath: h.workspace,
      title: 'telegram:7',
      prompt: 'hello',
      agentPreset: 'standard',
      permissionPreset: 'workspace-write',
      delivery: { deliveryId: 'telegram:7:10', source: DEFAULT_INSTANCE },
    })
    // The runtime only creates a session from a rule's return value; a router
    // that never registers one would leave this empty while still looking
    // healthy.
    await tick()
    expect(h.webhook.sessions).toEqual([
      { workspacePath: h.workspace, title: 'telegram:7', prompt: 'hello', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    ])
  })

  it('drops messages whose content carries no text', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound({ content: [{ type: 'image', reference: 'f' }] }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(DEFAULT_INSTANCE).sent).toHaveLength(0)
  })
})

describe('SessionRouter conversation correlation', () => {
  it('links the created session to the conversation and persists the link', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound())
    h.sessions.emitCreated({ id: 'webhook-1', cwd: h.workspace })
    await tick()
    const [key, conversation] = [...h.store.conversations.entries()][0]!
    expect(key).toBe('telegram:7@did:key:zAlice')
    expect(conversation).toMatchObject({
      channelId: DEFAULT_INSTANCE,
      channelType: 'telegram',
      chatId: '7',
      chatKind: 'dm',
      subjectId: 'did:key:zAlice',
      sessionId: 'webhook-1',
    })
  })

  it('matches a symlinked workspace through its canonical path', async () => {
    const real = mkdtempSync(join(tmpdir(), 'tentacle-channels-real-'))
    const linkPath = join(real, '..', `link-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    symlinkSync(real, linkPath)
    const h = await harness({ workspaceRoot: () => linkPath })
    // The router is told the symlink path; the runtime reports the real one.
    await h.router.handleInbound(inbound())
    expect(h.webhook.requests[0]!.workspacePath).toBe(linkPath)
    h.sessions.emitCreated({ id: 'webhook-2', cwd: canonicalize(linkPath) })
    await tick()
    expect(h.links()).toHaveLength(1)
  })

  it('never claims a session the webhook runtime did not create', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound())
    h.sessions.emitCreated({ id: 'ordinary-user-session', cwd: h.workspace })
    h.sessions.emitCreated({ id: 'webhook-9', cwd: '/somewhere/else' })
    await tick()
    expect(h.links()).toHaveLength(0)
  })

  it('buffers a follow-up that arrives before the session exists', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound({ messageId: 'telegram:7:10' }))
    await h.router.handleInbound(inbound({ messageId: 'telegram:7:11', content: [{ type: 'text', text: 'and another' }] }))
    // Only one dispatch: the second message waited for the session.
    expect(h.webhook.requests).toHaveLength(1)

    h.sessions.emitCreated({ id: 'webhook-3', cwd: h.workspace })
    await tick(10)
    // No agents port is wired, so the buffered message is re-dispatched instead.
    expect(h.webhook.requests).toHaveLength(2)
    expect(h.webhook.requests[1]!.prompt).toBe('and another')
  })

  it('continues an existing conversation through the live Agent', async () => {
    const seen: ResumePromptMessage[] = []
    const agents = new Map<string, { readonly agent: { followup(message: ResumePromptMessage): void } }>([
      ['webhook-4', { agent: { followup: (message) => { seen.push(message) } } }],
    ])
    // Seed the durable link before construction: a restart loads it at boot.
    const h = await harness({ agents, conversations: [link('webhook-4')] })
    await h.router.handleInbound(inbound({ content: [{ type: 'text', text: 'continue please' }] }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'continue please' }] })
    expect(h.webhook.requests).toHaveLength(0)
  })

  it('re-dispatches when the mapped session is gone', async () => {
    const h = await harness({ agents: new Map(), conversations: [link('webhook-dead')] })
    await h.router.handleInbound(inbound())
    expect(h.webhook.requests).toHaveLength(1)
    // The stale link is dropped before the new dispatch.
    expect(h.links()).toHaveLength(0)
  })

  it('drops a message an existing Agent will not admit instead of forking the session', async () => {
    let calls = 0
    const agents = new Map<string, { readonly agent: { followup(message: ResumePromptMessage): void } }>([
      ['webhook-6', {
        agent: {
          followup: () => {
            calls += 1
            throw new Error('message "undefined" is already pending')
          },
        },
      }],
    ])
    const h = await harness({ agents, conversations: [link('webhook-6')] })
    await h.router.handleInbound(inbound({ content: [{ type: 'text', text: 'while busy' }] }))
    expect(calls).toBe(1)
    // No duplicate session behind the user's back, and the link is untouched.
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.links()).toHaveLength(1)
  })

  it('reports a dispatch failure to the user instead of going quiet', async () => {
    const webhook = new FakeWebhook()
    webhook.failDispatch = true
    const h = await harness({ webhook })
    await h.router.handleInbound(inbound())
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toContain('dispatch failed')
  })

  it('gives up on a session that never appears and tells the user', async () => {
    const h = await harness()
    await h.router.handleInbound(inbound())
    const started = Date.now()
    while (h.adapter(DEFAULT_INSTANCE).sent.length === 0 && Date.now() - started < 3000) await tick(10)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['session timeout'])
  })
})

describe('SessionRouter outbound aggregation', () => {
  function linked(): Promise<Harness> {
    return harness({ conversations: [link('webhook-5')] })
  }

  it('joins every assistant message of a turn into one reply at turn/end', async () => {
    const h = await linked()
    const session = { id: 'webhook-5', cwd: h.workspace }
    h.sessions.emitEvent(session, assistantEvent('first step'))
    h.sessions.emitEvent(session, assistantEvent('second step'))
    h.sessions.emitEvent(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    expect(h.adapter(DEFAULT_INSTANCE).sent).toHaveLength(0)
    h.sessions.emitEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['first step\n\nsecond step'])
  })

  it('ignores reasoning blocks and empty text', async () => {
    const h = await linked()
    const session = { id: 'webhook-5', cwd: h.workspace }
    h.sessions.emitEvent(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }] } },
    })
    h.sessions.emitEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } })
    h.sessions.emitEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['answer'])
  })

  it('marks a failed turn and never leaves the user without an answer', async () => {
    const h = await linked()
    const session = { id: 'webhook-5', cwd: h.workspace }
    h.sessions.emitEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['(turn failed)'])

    const h2 = await linked()
    const session2 = { id: 'webhook-5', cwd: h2.workspace }
    h2.sessions.emitEvent(session2, assistantEvent('partial answer'))
    h2.sessions.emitEvent(session2, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
    await tick(5)
    expect(h2.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['partial answer\n\n(turn failed)'])
  })

  it('keeps a silent turn silent', async () => {
    const h = await linked()
    h.sessions.emitEvent({ id: 'webhook-5', cwd: h.workspace }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).sent).toHaveLength(0)
  })

  it('survives a platform that refuses the reply', async () => {
    const h = await linked()
    h.adapter(DEFAULT_INSTANCE).failSend = true
    const session = { id: 'webhook-5', cwd: h.workspace }
    h.sessions.emitEvent(session, assistantEvent('answer'))
    h.sessions.emitEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)
    // Nothing thrown, nothing sent, and the router still accepts the next turn.
    h.adapter(DEFAULT_INSTANCE).failSend = false
    h.sessions.emitEvent(session, assistantEvent('second'))
    h.sessions.emitEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).inbound()).toEqual(['second'])
  })

  it('never replies to a session it does not own', async () => {
    const h = await harness()
    h.sessions.emitEvent({ id: 'some-other-session', cwd: h.workspace }, assistantEvent('not for you'))
    h.sessions.emitEvent({ id: 'some-other-session', cwd: h.workspace }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)
    expect(h.adapter(DEFAULT_INSTANCE).sent).toHaveLength(0)
  })
})

/**
 * Multi-instance isolation (design 07 §1): two adapters of one platform share
 * the router and the store, and nothing may leak from one instance to the
 * other — not bindings, not conversations, not prompts, not replies, not
 * cursors.
 */
describe('SessionRouter multi-instance isolation', () => {
  const A = 'bot-a'
  const B = 'bot-b'
  const ALICE = 'did:key:zAlice'
  const BOB = 'did:key:zBob'
  const BINDS: readonly BindSpec[] = [
    // The SAME platform id on purpose: the instance decides who it acts as.
    { channelId: A, platformId: '7', subjectId: ALICE },
    { channelId: B, platformId: '7', subjectId: BOB },
  ]

  /** A workspace root that gives each bound subject its own directory. */
  function subjectWorkspaces(): (subjectId: string) => string {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-channels-multi-'))
    return (subjectId) => join(root, subjectId)
  }

  function twoAdapters(extra: HarnessOptions, workspaceRoot: (subjectId: string) => string): Promise<Harness> {
    return harness({ ...extra, instances: [A, B], binds: BINDS, workspaceRoot })
  }

  it('routes one platform sender on two instances into separate conversations', async () => {
    const wsOf = subjectWorkspaces()
    const seen = new Map<string, ResumePromptMessage[]>([
      ['webhook-a', []],
      ['webhook-b', []],
    ])
    const agents = new Map<string, { readonly agent: { followup(message: ResumePromptMessage): void } }>()
    for (const [sessionId, messages] of seen) {
      agents.set(sessionId, { agent: { followup: (message) => { messages.push(message) } } })
    }
    const h = await twoAdapters({ agents }, wsOf)

    // The same platform identity resolves to a different tenant user per instance.
    expect(h.bindings.resolve(A, '7')?.subjectId).toBe(ALICE)
    expect(h.bindings.resolve(B, '7')?.subjectId).toBe(BOB)

    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:1', content: [{ type: 'text', text: 'from bot-a' }] }))
    await h.router.handleInbound(inbound({ channelId: B, messageId: 'b:1', content: [{ type: 'text', text: 'from bot-b' }] }))
    expect(h.webhook.requests.map((r) => [r.delivery.source, r.prompt, r.workspacePath])).toEqual([
      [A, 'from bot-a', wsOf(ALICE)],
      [B, 'from bot-b', wsOf(BOB)],
    ])

    h.sessions.emitCreated({ id: 'webhook-a', cwd: wsOf(ALICE) })
    h.sessions.emitCreated({ id: 'webhook-b', cwd: wsOf(BOB) })
    await tick()

    const byKey = new Map(h.store.conversations.entries())
    const keyA = `${A}:7@${ALICE}`
    const keyB = `${B}:7@${BOB}`
    expect([...byKey.keys()].sort()).toEqual([keyA, keyB].sort())
    expect(keyA).not.toBe(keyB)
    expect(byKey.get(keyA)).toMatchObject({ channelId: A, subjectId: ALICE, sessionId: 'webhook-a' })
    expect(byKey.get(keyB)).toMatchObject({ channelId: B, subjectId: BOB, sessionId: 'webhook-b' })

    // A follow-up on bot-a continues alice's session and never bob's.
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:2', content: [{ type: 'text', text: 'more' }] }))
    expect(seen.get('webhook-a')).toEqual([{ role: 'user', content: [{ type: 'text', text: 'more' }] }])
    expect(seen.get('webhook-b')).toEqual([])
    expect(h.webhook.requests).toHaveLength(2)
  })

  it('sends each turn only through its own instance adapter', async () => {
    const wsOf = subjectWorkspaces()
    const h = await twoAdapters({
      conversations: [
        link('webhook-a', { channelId: A, subjectId: ALICE, chatId: '7' }),
        link('webhook-b', { channelId: B, subjectId: BOB, chatId: '8' }),
      ],
    }, wsOf)

    const sessionA = { id: 'webhook-a', cwd: wsOf(ALICE) }
    const sessionB = { id: 'webhook-b', cwd: wsOf(BOB) }
    h.sessions.emitEvent(sessionA, assistantEvent('reply from a'))
    h.sessions.emitEvent(sessionB, assistantEvent('reply from b'))
    h.sessions.emitEvent(sessionA, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.sessions.emitEvent(sessionB, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)

    expect(h.adapter(A).inbound()).toEqual(['reply from a'])
    expect(h.adapter(B).inbound()).toEqual(['reply from b'])
    // Exactly one call per instance: neither adapter ever sees the other's turn.
    expect(h.adapter(A).sent).toHaveLength(1)
    expect(h.adapter(B).sent).toHaveLength(1)
    expect(h.adapter(A).sent[0]!.subject.chatId).toBe('7')
    expect(h.adapter(B).sent[0]!.subject.chatId).toBe('8')
  })

  it('parks each delivery for its own source so interleaved runs cannot swap prompts', async () => {
    const wsOf = subjectWorkspaces()
    const webhook = new FakeWebhook()
    webhook.autoRun = false
    const h = await twoAdapters({ webhook }, wsOf)

    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:1', content: [{ type: 'text', text: 'alpha' }] }))
    await h.router.handleInbound(inbound({ channelId: B, messageId: 'b:1', content: [{ type: 'text', text: 'beta' }] }))
    expect(h.webhook.requests.map((r) => r.delivery.source)).toEqual([A, B])

    // The runtime may call the rule back in any order; each source must take
    // exactly the request parked for it.
    const fromB = await webhook.run(B)
    const fromA = await webhook.run(A)
    expect(fromB).toMatchObject({ prompt: 'beta', workspacePath: wsOf(BOB), title: 'telegram:7' })
    expect(fromA).toMatchObject({ prompt: 'alpha', workspacePath: wsOf(ALICE), title: 'telegram:7' })
    expect(webhook.sessions.map((session) => session.prompt)).toEqual(['beta', 'alpha'])
    // Nothing is left for either source to consume twice.
    expect(await webhook.run(B)).toBeNull()
    expect(await webhook.run(A)).toBeNull()
  })

  it('serializes dispatches that share one workspace so attribution cannot swap', async () => {
    // Several instances (or the default shared root) can dispatch into the SAME
    // workspace. The runtime hands back no session id, so a created session is
    // attributed by canonical workspace path — which is only unambiguous while
    // one dispatch per workspace is in flight.
    const shared = mkdtempSync(join(tmpdir(), 'tentacle-channels-shared-'))
    const webhook = new FakeWebhook()
    webhook.autoRun = false
    const h = await twoAdapters({ webhook }, () => shared)

    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:1', content: [{ type: 'text', text: 'alpha' }] }))
    await h.router.handleInbound(inbound({ channelId: B, messageId: 'b:1', content: [{ type: 'text', text: 'beta' }] }))
    // Only bot-a is parked; bot-b waits for the workspace slot.
    expect(h.webhook.requests.map((request) => request.delivery.source)).toEqual([A])
    expect(await webhook.run(A)).toMatchObject({ prompt: 'alpha', workspacePath: shared })

    // bot-a's session appears and is attributed to bot-a's conversation, which
    // releases the slot for the waiting message.
    h.sessions.emitCreated({ id: 'webhook-a', cwd: shared })
    await tick(3)
    expect(await h.store.conversations.get(`${A}:7@${ALICE}`)).toMatchObject({ sessionId: 'webhook-a' })
    expect(h.webhook.requests.map((request) => request.delivery.source)).toEqual([A, B])
    expect(await webhook.run(B)).toMatchObject({ prompt: 'beta', workspacePath: shared })
  })

  it('keeps conversation, binding and cursor records keyed per instance', async () => {
    const wsOf = subjectWorkspaces()
    const h = await twoAdapters({}, wsOf)
    // The service layer writes the platform cursor through the same store,
    // keyed by instance id; two bots never share one cursor.
    await h.store.offsets.put(A, 100)
    await h.store.offsets.put(B, 200)

    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:1' }))
    await h.router.handleInbound(inbound({ channelId: B, messageId: 'b:1' }))
    h.sessions.emitCreated({ id: 'webhook-a', cwd: wsOf(ALICE) })
    h.sessions.emitCreated({ id: 'webhook-b', cwd: wsOf(BOB) })
    await tick()

    const conversationKeys = [...h.store.conversations.keys()].sort()
    expect(conversationKeys).toEqual([`${A}:7@${ALICE}`, `${B}:7@${BOB}`].sort())
    for (const [key, conversation] of h.store.conversations.entries()) {
      expect(key.startsWith(`${conversation.channelId}:`)).toBe(true)
    }
    expect([...h.store.bindings.keys()].sort()).toEqual([`${A}/7`, `${B}/7`].sort())
    // Routing on one instance never consumes or overwrites the other's cursor.
    expect([...h.store.offsets.entries()]).toEqual([[A, 100], [B, 200]])
  })

  it('stops replying for a detached instance without touching the other', async () => {
    const wsOf = subjectWorkspaces()
    const h = await twoAdapters({
      conversations: [
        link('webhook-a', { channelId: A, subjectId: ALICE }),
        link('webhook-b', { channelId: B, subjectId: BOB }),
      ],
    }, wsOf)

    h.router.detachAdapter(A)
    const sessionA = { id: 'webhook-a', cwd: wsOf(ALICE) }
    const sessionB = { id: 'webhook-b', cwd: wsOf(BOB) }
    h.sessions.emitEvent(sessionA, assistantEvent('reply from a'))
    h.sessions.emitEvent(sessionA, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.sessions.emitEvent(sessionB, assistantEvent('reply from b'))
    h.sessions.emitEvent(sessionB, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(5)

    expect(h.adapter(A).sent).toHaveLength(0)
    expect(h.adapter(B).inbound()).toEqual(['reply from b'])
  })
})

describe('SessionRouter unbound policies (06 §5)', () => {
  const A = 'bot-a'

  function seedPolicy(store: MemoryStore, policy: string): Promise<void> {
    return store.channels.put(A, {
      id: A,
      tenant: tenantId('local'),
      channelType: 'telegram',
      name: A,
      enabled: true,
      config: { unboundPolicy: policy },
      createdAt: 0,
      updatedAt: 0,
    })
  }

  async function unboundHarness(policy: string) {
    const h = await harness({ instances: [A], binds: [] })
    await seedPolicy(h.store, policy)
    return h
  }

  it('guest: unbound senders get a read-only session in the isolated guest workspace', async () => {
    const h = await unboundHarness('guest')
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:g-1', content: [{ type: 'text', text: 'hello guest' }] }))
    expect(h.webhook.requests).toHaveLength(1)
    const request = h.webhook.requests[0]!
    expect(request.permissionPreset).toBe('read-only')
    expect(request.workspacePath).toBe('/guest-ws/local')
    // No guidance reply: the message was dispatched, not refused.
    expect(h.adapter(A).inbound()).toHaveLength(0)
  })

  it('owner: unbound senders run as the tenant admin with the normal preset', async () => {
    const h = await unboundHarness('owner')
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:o-1', content: [{ type: 'text', text: 'hello owner' }] }))
    expect(h.webhook.requests).toHaveLength(1)
    const request = h.webhook.requests[0]!
    expect(request.permissionPreset).toBe('workspace-write')
    expect(request.workspacePath).toBe(h.workspace)
    expect(h.adapter(A).inbound()).toHaveLength(0)
  })

  it('owner with no resolvable owner falls back to reject, never to guest', async () => {
    const h = await unboundHarness('owner')
    h.store.channels.put(A, {
      ...(await h.store.channels.get(A)!),
      tenant: tenantId('other'),
    })
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:o-2', content: [{ type: 'text', text: 'hello nobody' }] }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(A).inbound()).toEqual(['please bind first'])
  })

  it('records a refused sender for the console inbox, but not guest/owner traffic', async () => {
    const seen: { platformId: string; preview: string }[] = []
    const h = await harness({
      instances: [A],
      binds: [],
      onUnboundSender: (message, preview) => { seen.push({ platformId: message.sender.platformId, preview }) },
    })
    await seedPolicy(h.store, 'reject')
    await h.router.handleInbound(inbound({
      channelId: A,
      messageId: 'a:r-1',
      sender: { platformId: 'u-1', displayName: 'Alice' },
      content: [{ type: 'text', text: '  hello there  ' }],
    }))
    expect(seen).toEqual([{ platformId: 'u-1', preview: 'hello there' }])

    await seedPolicy(h.store, 'guest')
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:r-2', sender: { platformId: 'u-2' } }))
    await seedPolicy(h.store, 'owner')
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:r-3', sender: { platformId: 'u-3' } }))
    // Only the refused sender is inbox material.
    expect(seen).toHaveLength(1)
  })


  it('reject (default): no session is dispatched', async () => {
    const h = await unboundHarness('reject')
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:r-1', content: [{ type: 'text', text: 'hello stranger' }] }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(A).inbound()).toEqual(['please bind first'])
  })
})

describe('SessionRouter quota gate (design 05 §2.4)', () => {
  const A = 'bot-a'

  async function boundHarness(agentQuota?: (subjectId: string) => { ok: boolean; reason?: string }) {
    const h = await harness({ instances: [A], agentQuota })
    await h.store.channels.put(A, {
      id: A,
      tenant: tenantId('local'),
      channelType: 'telegram',
      name: A,
      enabled: true,
      config: {},
      createdAt: 0,
      updatedAt: 0,
    })
    return h
  }

  it('refuses at the edge when the quota gate denies, replying instead of dispatching', async () => {
    const h = await boundHarness((subjectId) => subjectId === 'did:key:zAlice'
      ? { ok: false, reason: 'max_agents quota: 1 of 1 agents are live' }
      : { ok: true })
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:q-1', content: [{ type: 'text', text: 'hello' }] }))
    expect(h.webhook.requests).toHaveLength(0)
    expect(h.adapter(A).inbound()).toEqual(['quota exhausted'])
  })

  it('dispatches normally when the gate allows', async () => {
    const h = await boundHarness(() => ({ ok: true }))
    await h.router.handleInbound(inbound({ channelId: A, messageId: 'a:q-2', content: [{ type: 'text', text: 'hello' }] }))
    expect(h.webhook.requests).toHaveLength(1)
  })
})

describe('router helpers', () => {
  it('extracts text blocks only', () => {
    expect(assistantTextOf({ message: { content: [{ type: 'text', text: ' a ' }, { type: 'reasoning', text: 'r' }] } })).toBe('a')
    expect(assistantTextOf({})).toBe('')
  })

  it('canonicalizes a path that does not exist without throwing', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'tentacle-channels-canon-')), 'nope')
    expect(canonicalize(missing)).toBe(missing)
    const nested = join(missing, 'deeper')
    mkdirSync(nested, { recursive: true })
    expect(canonicalize(nested)).toBe(realpathSync(nested))
  })

  it('derives a conversation key that scopes the instance', () => {
    expect(conversationKey(link('webhook-5'))).toBe('telegram:7@did:key:zAlice')
    expect(conversationKey(link('webhook-5', { channelId: 'bot-a' })))
      .not.toBe(conversationKey(link('webhook-5', { channelId: 'bot-b' })))
  })
})

function assistantEvent(text: string): RouterSessionEvent {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

/**
 * One durable conversation link for the DM chat used by most tests. The key is
 * derived from the same helper the router uses, so a test cannot silently
 * drift from the production key format.
 */
function link(sessionId: string, overrides: Partial<ConversationLink> = {}): ConversationLink {
  return {
    channelId: DEFAULT_INSTANCE,
    channelType: 'telegram',
    chatId: '7',
    chatKind: 'dm',
    subjectId: 'did:key:zAlice',
    sessionId,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}
