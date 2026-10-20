/**
 * Identity binding (design: docs/design/06-channels.md §5, 07 §1) — Tentacle's
 * deliberate difference from the reference implementation: an IM identity is never implicitly the
 * agent owner. A platform id must be bound to a real tenant user by an admin,
 * and an unbound message is refused by default.
 *
 * Bindings are scoped to ONE channel instance: the same Telegram account may be
 * bound to a different user on each bot, and two bots of one platform must not
 * share a binding row (design 07 §1). Every mutation validates its subject
 * against the live tenancy directory and against the instance's tenant, so a
 * binding can never point at a deleted user or across a tenant boundary.
 */
import type { TenantId } from '@tentacle/identity'
import { bindingKey, type ChannelBinding, type ChannelsStore } from './repo.js'
import type { ChannelType } from './types.js'

/** What the binding store needs from the tenancy directory (no writes). */
export interface TenancyDirectory {
  listUsers(): readonly { readonly subjectId: string; readonly username: string; readonly tenant: string; readonly role: string }[]
}

export type BindingsErrorCode =
  | 'unknown-user'
  | 'already-bound'
  | 'invalid-binding'
  | 'no-such-binding'
  | 'channel-tenant-mismatch'

export class BindingsError extends Error {
  constructor(readonly code: BindingsErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'BindingsError'
  }
}

export interface BindInput {
  readonly channelId: string
  readonly channelType: ChannelType
  readonly platformId: string
  readonly subjectId: string
  /** The instance's tenant; a subject from another tenant is refused. */
  readonly tenant: TenantId
}

export class BindingStore {
  constructor(
    private readonly store: ChannelsStore,
    private readonly directory: TenancyDirectory,
    private readonly now: () => number = Date.now,
  ) {}

  /** Bindings, optionally limited to one channel instance (admin overview). */
  list(channelId?: string): readonly ChannelBinding[] {
    const rows: ChannelBinding[] = []
    for (const [, binding] of this.store.bindings.entries()) {
      if (channelId === undefined || binding.channelId === channelId) rows.push(binding)
    }
    return rows
  }

  /** The tenant subject an inbound platform identity acts as on this instance. */
  resolve(channelId: string, platformId: string): ChannelBinding | undefined {
    return this.store.bindings.get(bindingKey({ channelId, platformId }))
  }

  /** True when the subject id names a user the tenancy directory knows. */
  hasUser(subjectId: string): boolean {
    return this.directory.listUsers().some((user) => user.subjectId === subjectId)
  }

  /**
   * Bind a platform identity to a tenant user.
   *
   * An identity is bound to exactly one user per instance: re-pointing it is an
   * explicit unbind + bind, so a compromise cannot be laundered through an
   * "overwrite" and an audit reads one removal followed by one addition.
   */
  async bind(input: BindInput): Promise<ChannelBinding> {
    const platformId = input.platformId.trim()
    if (platformId === '') throw new BindingsError('invalid-binding', 'platformId is required')
    const user = this.directory.listUsers().find((candidate) => candidate.subjectId === input.subjectId)
    if (user === undefined) {
      throw new BindingsError('unknown-user', `no tenant user with subjectId ${input.subjectId}`)
    }
    // The binding is what an inbound message acts as; letting a subject from
    // another tenant through would hand that tenant's user a session it does
    // not own (design 07 §0 D2).
    if (user.tenant !== input.tenant) {
      throw new BindingsError('channel-tenant-mismatch', 'subject belongs to another tenant')
    }
    if (this.resolve(input.channelId, platformId) !== undefined) {
      throw new BindingsError('already-bound', `${input.channelId}:${platformId} is already bound`)
    }
    const binding: ChannelBinding = {
      channelId: input.channelId,
      channelType: input.channelType,
      platformId,
      subjectId: input.subjectId,
      boundAt: this.now(),
    }
    await this.store.bindings.put(bindingKey(binding), binding)
    return binding
  }

  /** Remove a binding. Returns false when the identity was not bound. */
  async unbind(channelId: string, platformId: string): Promise<boolean> {
    return await this.store.bindings.delete(bindingKey({ channelId, platformId }))
  }

  /**
   * Drop every binding of one instance. Called when the instance is deleted —
   * a binding whose instance is gone could never receive a message, and the
   * admin console would keep rendering it.
   */
  async removeChannel(channelId: string): Promise<number> {
    let removed = 0
    for (const [, binding] of this.store.bindings.entries()) {
      if (binding.channelId !== channelId) continue
      await this.store.bindings.delete(bindingKey(binding))
      removed += 1
    }
    return removed
  }
}
