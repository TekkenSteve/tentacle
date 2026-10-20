/**
 * Session router (design: docs/design/06-channels.md §3) — the spine between
 * "a message arrived on a platform" and "a reply went back".
 *
 * Inbound: binding lookup → (dispatch into the official webhook runtime) →
 * correlate the created DSH session back to the conversation.
 *
 * Outbound: aggregate every `assistant/message` of a turn, then send the whole
 * turn's text at `turn/end`. Aggregating per turn (rather than per step or per
 * delta) is what keeps a multi-step, tool-using answer as one channel message
 * instead of a burst of fragments.
 *
 * Everything external is an injected port, so the whole policy is testable
 * without a DSH runtime.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ChannelsStore, ConversationIdentity, ConversationLink } from '../repo.js'
import { conversationKey } from '../repo.js'
import type { BindingStore } from '../bindings.js'
import type { ChannelAdapter, ChannelSubject, ChannelType, InboundMessage } from '../types.js'
import { textOf } from '../types.js'

/** Why the router needs webhook delivery identities from the official seam. */
export interface DeliveryIdentity {
  readonly deliveryId: string
  readonly source: string
  /**
   * The provider kind the runtime matches a rule on (the message's channel
   * type) — the runtime requires exact `kind` equality between rule and
   * delivery.
   */
  readonly kind: string
  readonly receivedAt: number
}

/**
 * The narrow face of `ctx.webhookRuntime` this router uses. The runtime's
 * verbs are `register(rule)` and `dispatch(delivery)`; declaring them
 * structurally keeps the router out of the DSH session/webhook types and lets
 * tests inject a recording fake.
 */
export interface WebhookDispatchPort {
  /**
   * Register the rule that turns a matching delivery into one Session. The
   * runtime calls `run` for every delivery whose `kind` matches; the rule
   * answers `null` for anything it does not own, which is exactly how a
   * channel-id-filtered adapter keeps two bots on one kind apart.
   */
  register(rule: {
    readonly id: string
    readonly kind: string
    run(
      delivery: {
        readonly kind: string
        readonly source: string
        readonly deliveryId: string
        readonly event?: unknown
      },
      signal: AbortSignal,
    ): { readonly workspacePath: string; readonly title: string; readonly prompt: string; readonly agentPreset: string; readonly permissionPreset: string } | null | Promise<null>
  }): () => Promise<void>
  dispatch(request: DispatchRequest): void
}

/** One Agent handle, as much as the router uses to continue a conversation. */
export interface ResumePromptMessage {
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/**
 * The live-Agent lookup used to continue an existing conversation. Without it
 * every inbound message would start a fresh session and the conversation would
 * have no memory.
 *
 * `get` returns a bare Agent (the registry publishes the agent before the
 * creating call's promise resolves), so a miss immediately after
 * `session/created` means "not published yet", not "gone" — see
 * {@link SessionRouter.continueSession}.
 */
export interface AgentRegistryPort {
  get(sessionId: string): { readonly agent: { followup(message: ResumePromptMessage): void } } | undefined
}

/** The session facts the router correlates on (`session/created`). */
export interface CreatedSession {
  readonly id: string
  readonly cwd?: string
}

/**
 * The session event feed the router aggregates on (`session/event`). Expressed
 * as an injectable sink rather than a cordis subscription so the aggregation
 * logic is unit-testable.
 */
export interface SessionEventSink {
  onSessionCreated(listener: (session: CreatedSession) => void): () => void
  onSessionEvent(listener: (session: CreatedSession, event: RouterSessionEvent) => void): () => void
}

/**
 * One session event, as much of it as the outbound path reads. Payloads stay
 * `unknown` on purpose: the router extracts text through
 * {@link assistantTextOf} instead of depending on dsh-llm's block union, so a
 * new block type can never break the channel.
 */
export interface RouterSessionEvent {
  readonly type: string
  readonly data: unknown
}

/**
 * Session routing one target contributes (design 09 for experts, 10 §7 for
 * teams): the preset, model, permission preset and shared workspace that
 * replace the deployment defaults for every session created from the channel.
 */
export interface SessionRoute {
  readonly agentPresetId: string
  readonly model?: { readonly provider: string; readonly model: string; readonly maxTokens?: number }
  readonly permissionPreset?: string
  /** One workspace per expert instance, shared by all of its channels. */
  readonly workspacePath?: string
}

/** Outcome of asking the executor to turn one message into a session. */
export interface DispatchRequest {
  readonly workspacePath: string
  readonly title: string
  readonly prompt: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly model?: { readonly provider: string; readonly model: string; readonly maxTokens?: number }
  readonly delivery: DeliveryIdentity
}

export interface SessionRouterOptions {
  readonly permissionPreset: string
  readonly agentPreset: string
  readonly workspaceRoot: (subjectId: string) => string
  /**
   * Resolve the expert instance a channel routes to (design 09 §3.3). The
   * expert's preset, model, permission preset and shared workspace replace the
   * deployment defaults for every session created from that channel. Throwing
   * is honored as a dispatch failure (the channel claimed an expert that no
   * longer resolves); returning undefined is only for callers without an
   * expert concept (guest overrides, legacy tests).
   */
  readonly targetFor?: (channelId: string) => SessionRoute | undefined
  /** Reply to an unbound sender? `reject` (default) answers with guidance. */
  readonly replyToUnbound: boolean
  readonly unboundReply: string
  /** Text sent when a session could not be attributed back to the conversation. */
  readonly sessionTimeoutReply: string
  /** Text sent when dispatching to the agent runtime failed outright. */
  readonly dispatchFailureReply: string
  /** Suffix prefixed to a partial reply whose turn failed. */
  readonly turnErrorReply: string
  /** How long a dispatched session may take to appear before we give up. */
  readonly sessionClaimTimeoutMs: number
  /**
   * Resolve the tenant's owner user for the `owner` unbound policy; returns
   * undefined when there is no such user (the policy then falls back to reject).
   */
  readonly ownerFor?: (tenant: string) => string | undefined
  /** Guest sessions run in a dedicated read-only workspace, never a user's own. */
  readonly guestWorkspaceRoot?: (tenant: string | undefined) => string | undefined
  /** Quota gate consulted before dispatching for a bound or owner-mapped subject. */
  readonly agentQuota?: (subjectId: string) => { readonly ok: boolean; readonly reason?: string }
  /** Sent instead of dispatching when the quota gate refuses. */
  readonly quotaReply: string
  /** A channel session was claimed and linked: hand it to the quota ledger. */
  readonly onSessionClaimed?: (sessionId: string, subjectId: string) => void
  /** The agent runtime seam: message → one root Session. */
  readonly webhook: WebhookDispatchPort
  readonly bindings: BindingStore
  readonly store: ChannelsStore
  readonly log?: (level: 'warn' | 'debug' | 'info', message: string) => void
  /**
   * Reported when an unbound sender was refused under the `reject` policy, so
   * the console can offer a one-click bind ("待绑定来件" inbox). `preview` is
   * the already-trimmed text; the host truncates before persisting.
   */
  readonly onUnboundSender?: (message: InboundMessage, preview: string) => void | Promise<void>
  /**
   * Reported when a dispatched session never appears. The router cannot see
   * WHY it failed (the runtime is fire-and-forget), so this raises the fact
   * onto the operator surface instead of leaving it in a log line.
   */
  readonly onDispatchFailed?: (reason: string) => void
  /**
   * Live Agent lookup, used to continue an existing conversation. Optional:
   * without it each inbound message starts a fresh session, which is correct
   * but forgetful — production always wires it.
   */
  readonly agents?: AgentRegistryPort
}

/** A session we asked the runtime for and have not attributed yet. */
export interface PendingSession {
  readonly conversationId: string
  readonly subjectId: string
  readonly chatKind: 'dm' | 'group'
  readonly workspacePath: string
  readonly canonicalWorkspacePath: string
  readonly issuedAt: number
  /**
   * The message that opened the session. Retained so a dispatch that never
   * produces a session can still answer on the original platform surface.
   */
  readonly origin: InboundMessage
}

/** Cap on messages buffered while a conversation waits for its session. */
const MAX_BUFFERED_MESSAGES = 32
/** Bounded retry window for the session→agent publication gap (see continueSession). */
const GUEST_PERMISSION_PRESET = 'read-only'

const AGENT_LOOKUP_ATTEMPTS = 12
const AGENT_LOOKUP_RETRY_MS = 25

export class SessionRouter {
  private readonly log: (level: 'warn' | 'debug' | 'info', message: string) => void
  /** Live conversation → session links; the durable copy lives in `state`. */
  private readonly live = new Map<string, string>()
  /** Dispatched-but-unattributed sessions, in issue order (FIFO per workspace). */
  private readonly pending: PendingSession[] = []
  /** Inbound messages that arrived before their conversation had a session. */
  private readonly buffered = new Map<string, InboundMessage[]>()
  /**
   * Messages waiting for their workspace's single in-flight dispatch.
   *
   * The webhook runtime never returns a session id, so a created session is
   * attributed by canonical workspace path. Two concurrent dispatches into one
   * workspace would therefore be indistinguishable — and with several channel
   * instances (or several users on the default shared root) that would attach
   * one bot's session to another bot's conversation. Serializing per workspace
   * keeps the attribution exact without moving anyone's session directory.
   */
  private readonly workspaceQueue = new Map<string, { readonly message: InboundMessage; readonly subjectId: string }[]>()
  /** Identity carried alongside each pending dispatch (for the durable link). */
  private readonly pendingIdentities = new Map<string, ConversationIdentity>()
  /** Convincing expiry handles, so a dead dispatch cannot leak memory. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Live adapters by instance id. Replies are addressed by the conversation's
   * `channelId`, so two bots of the same platform never cross wires
   * (design 07 §1).
   */
  private readonly adapters = new Map<string, ChannelAdapter>()
  /** Registered webhook rules, one per channel kind (see {@link registerKind}). */
  private readonly ruleDisposers = new Map<string, () => Promise<void>>()
  /** How many live instances each kind's rule serves; the last stop removes it. */
  private readonly kinds = new Map<string, number>()
  private detach: Array<() => void> = []
  /**
   * Requests parked by {@link handleInbound}, consumed by the webhook rule.
   *
   * The runtime's rule signature returns a request rather than accepting one,
   * and `dispatch` starts the invocation asynchronously, so the decision the
   * router made synchronously must be handed across that boundary. The queue
   * is FIFO and each dispatch takes its own request, which also keeps two
   * in-flight messages on one rule from swapping prompts.
   */
  private readonly queued: Array<{
    readonly deliveryId: string
    /** Instance the message arrived on; the rule picks the request by source. */
    readonly channelId: string
    readonly request: {
      readonly workspacePath: string
      readonly title: string
      readonly prompt: string
      readonly agentPreset: string
      readonly permissionPreset: string
      readonly model?: { readonly provider: string; readonly model: string; readonly maxTokens?: number }
    }
  }> = []

  constructor(private readonly options: SessionRouterOptions) {
    this.log = options.log ?? (() => undefined)
    for (const [key, conversation] of options.store.conversations.entries()) {
      this.live.set(key, conversation.sessionId)
    }
  }

  /** Wire a channel adapter whose subjects receive replies, by instance id. */
  attach(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelId, adapter)
  }

  /** Forget one instance's adapter (disable/remove/reload, design 07 §1). */
  detachAdapter(channelId: string): void {
    this.adapters.delete(channelId)
  }

  /**
   * Subscribe to the session feed. The webhook rules are registered separately
   * per channel kind ({@link registerKind}): the runtime matches rules by exact
   * `kind`, so one rule per kind, all feeding the same source-keyed queue.
   *
   * The rule is the ONLY way a message reaches an agent: the webhook runtime's
   * built-in action is `run() → WebhookSessionRequest`, and it is fire-and-forget
   * from there. The request itself is built and parked by {@link handleInbound}
   * before the dispatch, so the rule just hands over what the router already
   * decided — which is what keeps the runtime from having to know about
   * binding, chats or prompts.
   */
  start(sessions: SessionEventSink): void {
    // Subscription first, and synchronously: a session created by a message
    // that arrives before this returns would otherwise be invisible to the
    // router, and its conversation would never link.
    this.detach = [
      sessions.onSessionCreated((session) => this.claimSession(session)),
      sessions.onSessionEvent((session, event) => this.onSessionEvent(session, event)),
    ]
  }

  /**
   * Register the webhook rule for one channel kind (refcounted): several
   * instances of one platform share it, and the LAST stop tears it down.
   * Registration is synchronous at the seam (`register` validates and installs,
   * then hands back the disposer); a malformed rule or a closing runtime throws
   * here, and a channel that cannot register its rule can never reach an agent.
   */
  registerKind(kind: string): void {
    const count = this.kinds.get(kind) ?? 0
    if (count > 0) {
      this.kinds.set(kind, count + 1)
      return
    }
    try {
      this.ruleDisposers.set(kind, this.options.webhook.register({
        id: `tentacle-channels:${kind}`,
        kind,
        run: (delivery) => this.takeNextRequest(delivery.source),
      }))
      this.kinds.set(kind, 1)
    } catch (error) {
      this.options.onDispatchFailed?.(`webhook rule registration for ${kind} failed: ${describe(error)}`)
      this.log('warn', `channels: webhook rule registration for ${kind} failed: ${describe(error)}`)
    }
  }

  /** Unregister one kind when its last instance stops. */
  unregisterKind(kind: string): void {
    const count = this.kinds.get(kind) ?? 0
    if (count > 1) {
      this.kinds.set(kind, count - 1)
      return
    }
    this.kinds.delete(kind)
    const dispose = this.ruleDisposers.get(kind)
    this.ruleDisposers.delete(kind)
    void dispose?.().catch((error: unknown) => {
      this.log('warn', `channels: webhook rule unregister for ${kind} failed: ${describe(error)}`)
    })
  }

  async stop(): Promise<void> {
    for (const [kind, dispose] of this.ruleDisposers) {
      await dispose().catch((error: unknown) => {
        this.log('warn', `channels: webhook rule unregister for ${kind} failed: ${describe(error)}`)
      })
    }
    this.ruleDisposers.clear()
    this.kinds.clear()
    for (const dispose of this.detach) dispose()
    this.detach = []
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.length = 0
    this.queued.length = 0
    this.buffered.clear()
    this.workspaceQueue.clear()
    this.pendingIdentities.clear()
    this.turnBuffer.clear()
  }


  /**
   * One normalized inbound message.
   *
   * The adapter only gets a session through this path, so a refusal (unbound
   * sender) is answered here and never reaches the agent runtime. The one
   * command handled before binding lookup is `/bind <code>`: self-service
   * binding is precisely how an unbound sender gets bound (design 06 §5).
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    const text = textOf(message.content).trim()
    const binding = this.options.bindings.resolve(message.channelId, message.sender.platformId)
    const prompt = text
    if (binding === undefined) {
      // The three unbound policies (06 §5): reject by default, a read-only
      // guest session, or map to the tenant owner.
      const policy = this.unboundPolicyOf(message.channelId)
      if (policy === 'guest') {
        if (prompt.trim() === '') return
        const instance = this.options.store.channels.get(message.channelId)
        const tenant = instance?.tenant
        await this.route(message, `guest:${tenant ?? 'local'}`, prompt, {
          permissionPreset: GUEST_PERMISSION_PRESET,
          workspacePath: this.options.guestWorkspaceRoot?.(tenant),
        })
        return
      }
      if (policy === 'owner') {
        const owner = this.options.ownerFor?.(this.options.store.channels.get(message.channelId)?.tenant ?? '')
        if (owner !== undefined) {
          if (prompt.trim() === '') return
          await this.route(message, owner, prompt)
          return
        }
        // No owner could be resolved: never silently degrade into guest mode.
      }
      this.log('warn', `channels: refusing unbound sender ${message.channelType}:${message.sender.platformId}`)
      // Record the refusal for the console's pending-sender inbox. A failed
      // record must not change the refusal itself.
      try {
        await this.options.onUnboundSender?.(message, prompt)
      } catch (error) {
        this.log('warn', `channels: recording unbound sender failed: ${describe(error)}`)
      }
      if (this.options.replyToUnbound) {
        await this.reply(message, this.options.unboundReply)
      }
      return
    }
    if (prompt.trim() === '') {
      this.log('debug', `channels: dropping message ${message.messageId} with no text content`)
      return
    }
    await this.route(message, binding.subjectId, prompt)
  }

  /** The instance's declared unbound policy, normalized to the three real tiers. */
  private unboundPolicyOf(channelId: string): 'reject' | 'guest' | 'owner' {
    const raw = this.options.store.channels.get(channelId)?.config['unboundPolicy']
    return raw === 'guest' || raw === 'owner' ? raw : 'reject'
  }

  private async route(
    message: InboundMessage,
    subjectId: string,
    prompt: string,
    overrides: { permissionPreset?: string; workspacePath?: string } = {},
  ): Promise<void> {
    const quota = this.options.agentQuota?.(subjectId)
    if (quota !== undefined && !quota.ok) {
      // Refused at the edge: no session, no workspace, no prompt.
      this.log('warn', `channels: quota refused for ${subjectId}: ${quota.reason ?? 'over quota'}`)
      await this.reply(message, this.options.quotaReply)
      return
    }
    const identity = identityOf(message, subjectId)
    const id = conversationKey(identity)
    // A conversation whose session is still being created must not dispatch a
    // second one: buffer the message and flush it onto the claim.
    if (this.pending.some((p) => p.conversationId === id)) {
      const queue = this.buffered.get(id) ?? []
      if (queue.length < MAX_BUFFERED_MESSAGES) {
        queue.push(message)
        this.buffered.set(id, queue)
      } else {
        this.log('warn', `channels: buffer for ${id} is full; dropping ${message.messageId}`)
      }
      return
    }
    const linked = this.live.get(id)
    if (linked !== undefined) {
      const delivered = await this.continueSession(linked, prompt)
      if (delivered !== 'gone') return
      // The mapped session is gone (restart, archived, disposed): forget the
      // stale link and create a fresh session rather than failing forever.
      this.log('debug', `channels: conversation ${id} lost session ${linked}; creating a new one`)
      await this.unlink(id)
    }
    this.dispatch(message, identity, prompt, id, overrides)
  }

  /**
   * Continue a live conversation.
   *
   * The registry publishes a session before it publishes its agent — the
   * `session/created` event fires inside `agents.create()`, the registry entry
   * lands a moment later — so an immediate lookup can miss. A short bounded
   * retry rides out that window.
   *
   * `gone` means "no Agent for this session": the caller may start a fresh
   * session. `rejected` means the Agent exists but would not take the input
   * (a turn is already pending, or the Agent is shutting down) — re-dispatching
   * there would fork a duplicate session behind the user's back, so the
   * message is dropped instead and the state stays honest.
   */
  private async continueSession(sessionId: string, prompt: string): Promise<'delivered' | 'rejected' | 'gone'> {
    const registry = this.options.agents
    if (registry === undefined) return 'gone'
    for (let attempt = 0; attempt < AGENT_LOOKUP_ATTEMPTS; attempt++) {
      const handle = registry.get(sessionId)
      if (handle !== undefined) {
        try {
          handle.agent.followup({ role: 'user', content: [{ type: 'text', text: prompt }] })
          return 'delivered'
        } catch (error) {
          // Admission failures are ordinary (the loop rejects a second input
          // while a turn is pending); swallowing one here is what keeps a race
          // from becoming the process's last act.
          this.log('warn', `channels: session ${sessionId} refused input: ${describe(error)}`)
          return 'rejected'
        }
      }
      if (attempt < AGENT_LOOKUP_ATTEMPTS - 1) await delay(AGENT_LOOKUP_RETRY_MS)
    }
    return 'gone'
  }

  private dispatch(
    message: InboundMessage,
    identity: ConversationIdentity,
    prompt: string,
    conversationId: string,
    overrides: { permissionPreset?: string; workspacePath?: string } = {},
  ): void {
    let route: SessionRoute | undefined
    try {
      route = overrides.workspacePath === undefined ? this.options.targetFor?.(message.channelId) : undefined
    } catch (error) {
      // Target routing is mandatory (design 10 §7): an unresolvable binding is
      // a host defect. Answer it like a dispatch failure instead of quietly
      // falling back to deployment defaults for a channel that claims a target.
      this.log('warn', `channels: resolving the target for ${message.channelId} failed: ${describe(error)}`)
      void this.reply(message, this.options.dispatchFailureReply)
      return
    }
    const workspacePath = overrides.workspacePath ?? route?.workspacePath ?? this.options.workspaceRoot(identity.subjectId)
    const agentPreset = route?.agentPresetId ?? this.options.agentPreset
    const permissionPreset = overrides.permissionPreset ?? route?.permissionPreset ?? this.options.permissionPreset
    const model = route?.model
    const canonicalWorkspacePath = canonicalize(workspacePath)
    // One dispatch per workspace at a time (see `workspaceQueue`).
    if (this.pending.some((p) => p.canonicalWorkspacePath === canonicalWorkspacePath)) {
      const queue = this.workspaceQueue.get(canonicalWorkspacePath) ?? []
      if (queue.length < MAX_BUFFERED_MESSAGES) {
        queue.push({ message, subjectId: identity.subjectId })
        this.workspaceQueue.set(canonicalWorkspacePath, queue)
      } else {
        this.log('warn', `channels: workspace queue for ${canonicalWorkspacePath} is full; dropping ${message.messageId}`)
      }
      return
    }
    const pending: PendingSession = {
      conversationId,
      subjectId: identity.subjectId,
      chatKind: identity.chatKind,
      workspacePath,
      canonicalWorkspacePath,
      issuedAt: Date.now(),
      origin: message,
    }
    this.pending.push(pending)
    this.pendingIdentities.set(conversationId, identity)
    // Park the request BEFORE the dispatch: the runtime starts `run` on a
    // microtask, and a rule that finds nothing queued would silently drop the
    // message (the failure mode this queue exists to prevent).
    this.queued.push({
      deliveryId: message.messageId,
      channelId: message.channelId,
      request: {
        workspacePath,
        title: this.titleFor(message),
        prompt,
        agentPreset,
        permissionPreset,
        ...(model === undefined ? {} : { model }),
      },
    })
    const timer = setTimeout(() => {
      void this.expirePending(pending)
    }, this.options.sessionClaimTimeoutMs)
    // Node keeps the loop alive for its own timers; this one is bookkeeping.
    timer.unref?.()
    this.timers.set(conversationId, timer)
    try {
      this.options.webhook.dispatch({
        workspacePath,
        title: this.titleFor(message),
        prompt,
        agentPreset,
        permissionPreset,
        ...(model === undefined ? {} : { model }),
        delivery: {
          deliveryId: message.messageId,
          source: message.channelId,
          kind: message.channelType,
          receivedAt: message.receivedAt,
        },
      })
    } catch (error) {
      // A synchronous dispatch failure leaves nothing to correlate with.
      this.forgetPending(conversationId, message.messageId)
      this.drainWorkspace(canonicalWorkspacePath)
      this.dropQueued(message.messageId)
      this.log('warn', `channels: dispatching ${message.messageId} failed: ${describe(error)}`)
      void this.reply(message, this.options.dispatchFailureReply)
    }
  }

  /**
   * Hand the runtime's rule invocation the request parked for ITS delivery.
   *
   * The rule receives the delivery (`run(delivery, signal)`), so the parked
   * request is selected by `delivery.source` — the instance id. Matching on the
   * source (not simply taking the oldest) is what keeps two bots of one
   * platform from consuming each other's dispatch when both are in flight.
   */
  private takeNextRequest(source: string): null | {
    readonly workspacePath: string
    readonly title: string
    readonly prompt: string
    readonly agentPreset: string
    readonly permissionPreset: string
    readonly model?: { readonly provider: string; readonly model: string; readonly maxTokens?: number }
  } {
    const index = this.queued.findIndex((entry) => entry.channelId === source)
    if (index === -1) return null
    return this.queued.splice(index, 1)[0]!.request
  }

  /** Drop a parked request whose dispatch never reached the runtime. */
  private dropQueued(deliveryId: string): void {
    const index = this.queued.findIndex((entry) => entry.deliveryId === deliveryId)
    if (index !== -1) this.queued.splice(index, 1)
  }

  /**
   * Attribute a freshly created session to the conversation that asked for it.
   *
   * The webhook runtime exposes no session id to its rule, so correlation is
   * by canonical workspace path among sessions we just dispatched — plus the
   * `webhook-` id prefix the runtime stamps on every session it creates,
   * which keeps an ordinary user session in the same directory from being
   * captured. Ambiguity (two dispatches into one workspace) resolves FIFO,
   * which matches the order the runtime creates them in.
   */
  private claimSession(session: CreatedSession): void {
    if (!session.id.startsWith('webhook-')) return
    if (session.cwd === undefined) return
    const cwd = canonicalize(session.cwd)
    const index = this.pending.findIndex((p) => p.canonicalWorkspacePath === cwd)
    if (index === -1) return
    const pending = this.pending[index]!
    this.pending.splice(index, 1)
    this.clearTimer(pending.conversationId)
    // The ledger learns the session→subject binding here: this is the exact
    // moment a channel session becomes a live agent of that user.
    this.options.onSessionClaimed?.(session.id, pending.subjectId)
    void this.link(pending, session.id)
    this.drainWorkspace(pending.canonicalWorkspacePath)
  }

  /**
   * Release the workspace's dispatch slot and start the next waiting message.
   *
   * Called when the in-flight dispatch is attributed or given up on; the queue
   * is drained one entry at a time because `dispatch` re-checks the slot.
   */
  private drainWorkspace(canonicalWorkspacePath: string): void {
    const queue = this.workspaceQueue.get(canonicalWorkspacePath)
    if (queue === undefined || queue.length === 0) return
    this.workspaceQueue.delete(canonicalWorkspacePath)
    for (const entry of queue) {
      const prompt = textOf(entry.message.content)
      if (prompt.trim() === '') continue
      const identity = identityOf(entry.message, entry.subjectId)
      this.dispatch(entry.message, identity, prompt, conversationKey(identity))
    }
  }

  private async link(pending: PendingSession, sessionId: string): Promise<void> {
    // Consumed here rather than in either branch: the pending identity is a
    // hand-off value, and forgetting it in only one branch would leak one
    // entry per linked conversation.
    const identity = this.pendingIdentities.get(pending.conversationId)
    this.pendingIdentities.delete(pending.conversationId)
    if (identity === undefined) {
      // Without the identity there is nothing to link; the pending entry is
      // the only place it was carried, so this is a programmer error.
      this.log('warn', `channels: no conversation identity for ${pending.conversationId}`)
      return
    }
    const existing = this.options.store.conversations.get(pending.conversationId)
    const now = Date.now()
    const next: ConversationLink = existing === undefined
      ? { ...identity, sessionId, createdAt: now, updatedAt: now }
      : { ...existing, sessionId, updatedAt: now }
    this.live.set(pending.conversationId, sessionId)
    try {
      // The durable write happens before the in-memory shortcut is trusted:
      // a link the store refused must not survive a restart as a phantom.
      await this.options.store.conversations.put(pending.conversationId, next)
    } catch (error) {
      this.live.delete(pending.conversationId)
      this.log('warn', `channels: persisting conversation link failed: ${describe(error)}`)
      return
    }
    this.log('info', `channels: conversation ${pending.conversationId} → session ${sessionId}`)
    const queued = this.buffered.get(pending.conversationId)
    this.buffered.delete(pending.conversationId)
    for (const message of queued ?? []) {
      const prompt = textOf(message.content)
      if (prompt.trim() === '') continue
      if ((await this.continueSession(sessionId, prompt)) === 'gone') {
        // Re-dispatch with the same durable identity: the conversation keeps
        // its key even though it lost its session.
        this.dispatch(message, identityOf(message, pending.subjectId), prompt, pending.conversationId)
      }
    }
  }

  private async expirePending(pending: PendingSession): Promise<void> {
    if (!this.pending.includes(pending)) return
    this.forgetPending(pending.conversationId, pending.origin.messageId)
    this.drainWorkspace(pending.canonicalWorkspacePath)
    const reason = `session for ${pending.conversationId} never appeared within ${this.options.sessionClaimTimeoutMs}ms`
    this.log('warn', `channels: ${reason}`)
    this.options.onDispatchFailed?.(reason)
    // Answer on the original surface: buffered follow-ups (if any) are dropped
    // here because there is no session they could ever have been delivered to.
    this.buffered.delete(pending.conversationId)
    await this.reply(pending.origin, this.options.sessionTimeoutReply)
  }

  private forgetPending(conversationId: string, messageId: string): void {
    const index = this.pending.findIndex((p) => p.conversationId === conversationId)
    if (index !== -1) this.pending.splice(index, 1)
    this.pendingIdentities.delete(conversationId)
    // A pending entry always parked exactly one request; dropping it keeps a
    // runtime that never called back (disposed registration, aborted signal)
    // from leaving a request for the next dispatch to pick up by mistake.
    this.dropQueued(messageId)
    this.clearTimer(conversationId)
  }

  private clearTimer(conversationId: string): void {
    const timer = this.timers.get(conversationId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(conversationId)
    }
  }

  private async unlink(conversationId: string): Promise<void> {
    this.live.delete(conversationId)
    try {
      await this.options.store.conversations.delete(conversationId)
    } catch (error) {
      this.log('warn', `channels: persisting unlink failed: ${describe(error)}`)
    }
  }

  /**
   * Turn boundaries drive the outbound path. Text is buffered per session and
   * flushed once, at `turn/end`, so a tool-using multi-step turn arrives as
   * one logical reply.
   */
  private onSessionEvent(session: CreatedSession, event: RouterSessionEvent): void {
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    const target = this.subjectForSession(session.id)
    if (target === undefined) return
    if (event.type === 'assistant/message') {
      const text = assistantTextOf(event.data)
      if (text === '') return
      const buffer = this.turnBuffer.get(session.id) ?? []
      buffer.push(text)
      this.turnBuffer.set(session.id, buffer)
      return
    }
    const buffer = this.turnBuffer.get(session.id)
    this.turnBuffer.delete(session.id)
    const failed = turnReasonKind(event.data) === 'error'
    const text = (buffer ?? []).join('\n\n')
    if (text === '' && !failed) return
    // A failed turn with partial text reports both: the user keeps what the
    // agent already said and learns that the rest never arrived.
    const body = failed ? (text === '' ? this.options.turnErrorReply : `${text}\n\n${this.options.turnErrorReply}`) : text
    void this.sendToSubject(target.channelId, target.subject, body)
  }

  /** Text accumulated for the in-flight turn of one session. */
  private readonly turnBuffer = new Map<string, string[]>()

  /**
   * The channel surface a session's replies belong to, if any: the instance it
   * must be sent through plus the platform subject.
   */
  private subjectForSession(sessionId: string): { readonly channelId: string; readonly subject: ChannelSubject } | undefined {
    for (const [, conversation] of this.options.store.conversations.entries()) {
      if (conversation.sessionId !== sessionId) continue
      return {
        channelId: conversation.channelId,
        subject: {
          chatId: conversation.chatId,
          kind: conversation.chatKind,
          ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
        },
      }
    }
    return undefined
  }

  private async sendToSubject(channelId: string, subject: ChannelSubject, text: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (adapter === undefined) return
    try {
      await adapter.send(subject, [{ type: 'text', text }])
    } catch (error) {
      // A platform failure must never take down the session feed: the turn is
      // already durable, only its delivery is lost.
      this.log('warn', `channels: sending reply to ${subject.chatId} failed: ${describe(error)}`)
    }
  }

  private async reply(message: InboundMessage, text: string): Promise<void> {
    await this.sendToSubject(message.channelId, message.subject, text)
  }

  /** Stable session title: `telegram:<chatId>` (06 §3 `sessionKey`). */
  private titleFor(message: InboundMessage): string {
    const thread = message.subject.threadId === undefined ? '' : `:${message.subject.threadId}`
    return `${message.channelType}:${message.subject.chatId}${thread}`
  }
}

/** Project an inbound message onto its durable conversation identity. */
function identityOf(message: InboundMessage, subjectId: string): ConversationIdentity {
  return {
    channelId: message.channelId,
    channelType: message.channelType,
    chatId: message.subject.chatId,
    chatKind: message.subject.kind,
    ...(message.subject.threadId === undefined ? {} : { threadId: message.subject.threadId }),
    subjectId,
  }
}

/**
 * One assistant message as channel text. Only `text` blocks are rendered;
 * reasoning stays on the DSH surface (it is not something a chat user asked
 * for) and tool blocks are visible through the session's own log.
 */
export function assistantTextOf(data: unknown): string {
  const message = (data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
  const content = message?.content ?? []
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function turnReasonKind(data: unknown): string {
  const reason = (data as { reason?: { kind?: string } }).reason
  return reason?.kind ?? 'completed'
}

/**
 * Canonical path for correlation. `ctx.workspaceRegistry.create()` realpaths
 * the directory it is handed, so the router must compare against the same
 * spelling. A path that does not exist yet cannot be correlated — the runtime
 * would have rejected it anyway.
 */
export function canonicalize(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
