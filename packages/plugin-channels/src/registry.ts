/**
 * ChannelRegistry — the CRUD domain for channel instances
 * (design: docs/design/07-channel-admin.md §1, §4).
 *
 * Pure domain logic over the {@link ChannelsStore} port: no cordis, no HTTP, no
 * credentials. Secrets are the host's business (design 07 §3): `remove` returns
 * the deleted record and the SERVICE compensates (credential record, bindings,
 * conversation links, cursor), the same division of labour persona uses for
 * preset mount/unmount.
 *
 * Two invariants are enforced here and nowhere else:
 *
 *  - **tenant fencing** (design 07 §0 D2): every read and write is filtered by
 *    the acting tenant; an admin may act across tenants, anyone else may not;
 *  - **name uniqueness per tenant**: `(tenant, name)` is unique, which spans
 *    records — so mutations run on one serialized chain. `ChannelsStore.update`
 *    is atomic per key, but a create-plus-name-check is not a single key, and a
 *    single-process chain is the honest way to make it so.
 */
import type { TenantId } from '@tentacle/identity'
import {
  ChannelError,
  newInstanceId,
  normalizeName,
  normalizeTokenRef,
  requireChannelType,
  requireTarget,
  validateConfig,
  type ChannelInstance,
} from './instances.js'
import type { ChannelsStore } from './repo.js'

/** The acting principal, resolved by the host from the authenticated identity. */
export interface ChannelActor {
  readonly tenant: TenantId
  readonly isAdmin: boolean
}

export interface CreateChannelInput {
  readonly channelType: unknown
  readonly name: unknown
  readonly config?: unknown
  readonly enabled?: unknown
  readonly tokenRef?: unknown
  /** Routing target (design 10 §7) — an expert or a team; required. */
  readonly target: unknown
  /** Admin-only: create on behalf of another tenant (design 07 §7 #22). */
  readonly tenant?: TenantId
}

export interface UpdateChannelInput {
  readonly name?: unknown
  readonly channelType?: unknown
  readonly config?: unknown
  readonly enabled?: unknown
  /** `null` clears the deployment reference; `undefined` leaves it alone. */
  readonly tokenRef?: unknown
  /**
   * Rebinds the channel to another target; `undefined` leaves the binding
   * alone. Clearing is rejected: a channel always routes to an expert or a
   * team (design 10 §7).
   */
  readonly target?: unknown
}

export interface ChannelRegistryDeps {
  readonly now?: () => number
  readonly newId?: () => string
}

export class ChannelRegistry {
  private readonly now: () => number
  private readonly newId: () => string
  /** Serializes mutations so name checks and writes cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: ChannelsStore, deps: ChannelRegistryDeps = {}) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? newInstanceId
  }

  /** Instances visible to the actor, sorted by name (stable list contract). */
  list(actor: ChannelActor): ChannelInstance[] {
    const visible: ChannelInstance[] = []
    for (const [, instance] of this.store.channels.entries()) {
      if (actor.isAdmin || instance.tenant === actor.tenant) visible.push(instance)
    }
    return visible.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** One instance, tenant-fenced. */
  get(id: string, actor: ChannelActor): ChannelInstance {
    const instance = this.store.channels.get(id)
    if (instance === undefined) throw new ChannelError('no-such-channel', `no such channel: ${id}`)
    this.assertTenant(instance, actor)
    return instance
  }

  async create(input: CreateChannelInput, actor: ChannelActor): Promise<ChannelInstance> {
    return await this.run(async () => {
      const channelType = requireChannelType(input.channelType)
      const name = normalizeName(input.name)
      const config = validateConfig(channelType, input.config)
      const tokenRef = normalizeTokenRef(input.tokenRef)
      const target = requireTarget(input.target)
      const tenant = this.targetTenant(input.tenant, actor)
      this.assertNameFree(tenant, name, undefined)

      const now = this.now()
      const instance: ChannelInstance = {
        id: this.newId(),
        tenant,
        channelType,
        name,
        enabled: input.enabled === undefined ? true : input.enabled === true,
        config,
        ...(tokenRef === undefined ? {} : { tokenRef }),
        target,
        createdAt: now,
        updatedAt: now,
      }
      await this.store.channels.put(instance.id, instance)
      return instance
    })
  }

  async update(id: string, patch: UpdateChannelInput, actor: ChannelActor): Promise<ChannelInstance> {
    return await this.run(async () => {
      const current = this.get(id, actor)
      const channelType = patch.channelType === undefined ? current.channelType : requireChannelType(patch.channelType)
      const name = patch.name === undefined ? current.name : normalizeName(patch.name)
      const config = patch.config === undefined ? current.config : validateConfig(channelType, patch.config)
      // A type change without a fresh config still has to typecheck: silently
      // carrying telegram fields onto another platform is exactly the kind of
      // state the strict validator exists to prevent.
      if (patch.channelType !== undefined && patch.config === undefined && channelType !== current.channelType) {
        validateConfig(channelType, current.config)
      }
      if (name !== current.name) this.assertNameFree(current.tenant, name, current.id)

      const tokenRef = patch.tokenRef === undefined
        ? current.tokenRef
        : patch.tokenRef === null ? undefined : normalizeTokenRef(patch.tokenRef)
      const target = patch.target === undefined ? current.target : requireTarget(patch.target)
      const next: ChannelInstance = {
        id: current.id,
        tenant: current.tenant,
        channelType,
        name,
        config,
        enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
        ...(tokenRef === undefined ? {} : { tokenRef }),
        target,
        createdAt: current.createdAt,
        updatedAt: this.now(),
      }
      await this.store.channels.put(next.id, next)
      return next
    })
  }

  /** Delete one instance; returns the removed record so the host can compensate. */
  async remove(id: string, actor: ChannelActor): Promise<ChannelInstance> {
    return await this.run(async () => {
      const instance = this.get(id, actor)
      await this.store.channels.delete(instance.id)
      return instance
    })
  }

  // ---- internals ----

  private assertTenant(instance: ChannelInstance, actor: ChannelActor): void {
    if (!actor.isAdmin && instance.tenant !== actor.tenant) {
      throw new ChannelError('forbidden-tenant', `channel ${instance.id} belongs to another tenant`)
    }
  }

  private targetTenant(requested: TenantId | undefined, actor: ChannelActor): TenantId {
    if (requested === undefined || requested === actor.tenant) return actor.tenant
    if (!actor.isAdmin) throw new ChannelError('forbidden-tenant', 'only an admin may target another tenant')
    return requested
  }

  private assertNameFree(tenant: TenantId, name: string, exceptId: string | undefined): void {
    for (const [id, instance] of this.store.channels.entries()) {
      if (instance.tenant !== tenant || id === exceptId) continue
      if (instance.name === name) throw new ChannelError('name-taken', `channel name already used in this tenant: ${name}`)
    }
  }

  /** Run one mutation after the previous one, keeping check-then-write atomic. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => undefined)
    return await next
  }
}
