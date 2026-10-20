/**
 * UserDirectory — the pure domain core of plugin-tenancy.
 *
 * Zero cordis imports: every dependency is injected (repo, clock, id mint),
 * so the whole lifecycle is unit-testable against MemoryRepo.
 *
 * Security properties (design 05):
 * - passwords live only as scrypt envelopes; invite codes only as sha256
 *   fingerprints; verification never throws — malformed input fails closed
 * - login is rate-limited per user (failure counter + timed lockout,
 *   the reference implementation's pattern), fixing king-bcolor's "no rate limit" gap
 * - disable() reports the subjectId so the caller cascades session
 *   revocation (the gateway destroys live connections)
 * - no default weak password: the bootstrap admin comes from explicit
 *   config, and only while the directory is empty
 */
import { createHash, randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from '@tentacle/crypto'
import { didKeyFromPublicKey, generateEd25519, rawEd25519PublicKey } from '@tentacle/identity'
import { subjectId, tenantId, type Identity, type SubjectId, type TenantId } from '@tentacle/identity'
import type { DirectoryRepo } from './repo.js'
import { ADMIN_ROLE, PERMISSIONS, USER_ROLE, isPermissionKey, knownPermissions } from './permissions.js'
import { emptyState, toIdentity, type DirectoryState, type Invite, type LocalizedText, type Membership, type ResourcePolicy, type Role, type RoleTemplate, type TenantUser } from './types.js'

export const MAX_LOGIN_FAILURES = 5
export const LOGIN_LOCK_MS = 15 * 60_000
export const INVITE_TTL_MS = 7 * 24 * 3_600_000

export class DirectoryError extends Error {
  constructor(
    readonly code: 'duplicate-user' | 'no-such-user' | 'invalid-invite' | 'login-locked' | 'disabled' | 'bad-credentials' | 'last-admin' | 'setup-required' | 'setup-closed' | 'no-such-role' | 'role-protected' | 'role-in-use' | 'duplicate-role' | 'invalid-permission',
    message: string,
  ) {
    super(message)
    this.name = 'DirectoryError'
  }
}

export interface DirectoryDeps {
  repo: DirectoryRepo
  now?: () => number
  defaultTenant?: string
  /** Bootstrap admin seeded while the directory is empty (no weak defaults). */
  bootstrapAdmin?: { username: string; passwordEnvelope: string }
}

export class UserDirectory {
  private state: DirectoryState | undefined
  private readonly now: () => number
  private readonly tenant: TenantId

  constructor(private readonly deps: DirectoryDeps) {
    this.now = deps.now ?? Date.now
    this.tenant = tenantId(deps.defaultTenant ?? 'local')
  }

  async boot(): Promise<void> {
    this.state = await this.deps.repo.load()
    // Older state roots predate roles entirely — backfill so `toIdentity`
    // never projects a user with no template.
    if (!Array.isArray(this.state.roles) || this.state.roles.length === 0) {
      this.state.roles = builtinRoles(this.now())
      await this.save()
    }
    // The usage ledger postdates the first state roots; start it empty instead
    // of migrating a version.
    if (!Array.isArray(this.state.usage)) {
      this.state.usage = []
      await this.save()
    }
    if (this.state.users.length === 0 && this.deps.bootstrapAdmin) {
      const { username, passwordEnvelope } = this.deps.bootstrapAdmin
      await this.createUser({ username, passwordEnvelope, role: ADMIN_ROLE })
    }
  }

  // ---- role templates (the reference implementation's user_role table) ----

  listRoles(): readonly RoleTemplate[] {
    return this.loaded().roles
  }

  getRole(id: string): RoleTemplate | undefined {
    return this.loaded().roles.find((r) => r.id === id)
  }

  private mustRole(id: string): RoleTemplate {
    const role = this.getRole(id)
    if (!role) throw new DirectoryError('no-such-role', `no such role template: ${id}`)
    return role
  }

  /** Effective permission keys of one user (admin bypasses → all catalog keys). */
  permissionsOf(username: string): readonly string[] {
    const user = this.mustFind(username)
    return effectivePermissions(user, this.getRole(user.role))
  }

  async createRole(input: { id: string; name: LocalizedText; description?: LocalizedText; permissionKeys: readonly string[] }): Promise<RoleTemplate> {
    const state = this.loaded()
    const id = input.id.trim()
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new DirectoryError('bad-credentials', `invalid role id: ${id}`)
    if (state.roles.some((r) => r.id === id)) throw new DirectoryError('duplicate-role', `role exists: ${id}`)
    const unknown = input.permissionKeys.filter((k) => !isPermissionKey(k))
    if (unknown.length > 0) throw new DirectoryError('invalid-permission', `unknown permission keys: ${unknown.join(', ')}`)
    const role: RoleTemplate = {
      id,
      name: input.name,
      description: input.description,
      permissionKeys: knownPermissions(input.permissionKeys),
      builtin: false,
      createdAt: this.now(),
    }
    state.roles.push(role)
    await this.save()
    return role
  }

  async updateRole(id: string, patch: { name?: LocalizedText; description?: LocalizedText; permissionKeys?: readonly string[] }): Promise<RoleTemplate> {
    const role = this.mustRole(id)
    if (role.builtin) throw new DirectoryError('role-protected', `cannot modify builtin role: ${id}`)
    if (patch.name !== undefined) role.name = patch.name
    if (patch.description !== undefined) role.description = patch.description
    if (patch.permissionKeys !== undefined) {
      const unknown = patch.permissionKeys.filter((k) => !isPermissionKey(k))
      if (unknown.length > 0) throw new DirectoryError('invalid-permission', `unknown permission keys: ${unknown.join(', ')}`)
      role.permissionKeys = knownPermissions(patch.permissionKeys)
    }
    await this.save()
    return role
  }

  async deleteRole(id: string): Promise<void> {
    const state = this.loaded()
    const role = this.mustRole(id)
    if (role.builtin) throw new DirectoryError('role-protected', `cannot delete builtin role: ${id}`)
    if (state.users.some((u) => u.role === id)) throw new DirectoryError('role-in-use', `role still assigned: ${id}`)
    state.roles.splice(state.roles.indexOf(role), 1)
    await this.save()
  }

  /** Reassign a user's role template. */
  async setRole(username: string, roleId: string): Promise<void> {
    const user = this.mustFind(username)
    this.mustRole(roleId)
    if (user.role === ADMIN_ROLE && roleId !== ADMIN_ROLE) {
      const state = this.loaded()
      if (state.users.filter((u) => u.role === ADMIN_ROLE && !u.disabled).length <= 1) {
        throw new DirectoryError('last-admin', 'cannot demote the last admin')
      }
    }
    user.role = roleId
    await this.save()
  }

  private loaded(): DirectoryState {
    if (!this.state) throw new Error('tentacle tenancy: directory not booted')
    return this.state
  }

  private async save(): Promise<void> {
    await this.deps.repo.save(this.loaded())
  }

  /** True while no user exists — the one-shot setup window is open. */
  needsSetup(): boolean {
    return this.loaded().users.length === 0
  }

  /**
   * First-run wizard: create the initial admin. Works exactly once — the
   * emptiness check and the write are one synchronous mutation, so
   * concurrent setup attempts cannot both succeed.
   */
  async setupAdmin(username: string, password: string): Promise<TenantUser> {
    if (!this.needsSetup()) throw new DirectoryError('setup-closed', 'setup already completed')
    return this.createUser({ username, password, role: 'admin' })
  }

  // ---- users ----

  async createUser(input: { username: string; passwordEnvelope?: string; password?: string; role?: Role; displayName?: string }): Promise<TenantUser> {
    const state = this.loaded()
    const username = input.username.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(username)) throw new DirectoryError('bad-credentials', `invalid username: ${username}`)
    if (state.users.some((u) => u.username === username && u.tenant === this.tenant)) {
      throw new DirectoryError('duplicate-user', `user exists: ${username}`)
    }
    const envelope = input.passwordEnvelope ?? (input.password ? hashPassword(input.password) : undefined)
    if (!envelope) throw new DirectoryError('bad-credentials', 'password required')
    // A user must point at a real template — otherwise `toIdentity` would
    // project no permissions and the account silently loses access.
    this.mustRole(input.role ?? USER_ROLE)

    // A fresh keypair anchors the subjectId — a stable, self-certifying DID.
    // The private key is discarded: M1 never signs as the user.
    const { publicKey } = generateEd25519()
    const user: TenantUser = {
      subjectId: subjectId(didKeyFromPublicKey(rawEd25519PublicKey(publicKey))),
      tenant: this.tenant,
      username,
      displayName: input.displayName,
      role: input.role ?? USER_ROLE,
      passwordEnvelope: envelope,
      disabled: false,
      loginFailedCount: 0,
      loginLockedUntil: 0,
      createdAt: this.now(),
    }
    state.users.push(user)
    state.memberships.push({ subject: user.subjectId, relation: 'member', object: `tenant:${user.tenant}`, createdAt: this.now() })
    await this.save()
    return user
  }

  /** Authenticate by username/password; returns the public identity. */
  async authenticate(username: string, password: string): Promise<Identity> {
    const state = this.loaded()
    if (state.users.length === 0) throw new DirectoryError('setup-required', 'no users — bootstrap an admin first')
    const user = state.users.find((u) => u.username === username.trim() && u.tenant === this.tenant)
    if (!user) throw new DirectoryError('bad-credentials', 'invalid credentials')
    if (user.disabled) throw new DirectoryError('disabled', 'user disabled')
    if (user.loginLockedUntil > this.now()) throw new DirectoryError('login-locked', `locked until ${user.loginLockedUntil}`)
    if (!verifyPassword(password, user.passwordEnvelope)) {
      user.loginFailedCount++
      if (user.loginFailedCount >= MAX_LOGIN_FAILURES) {
        user.loginLockedUntil = this.now() + LOGIN_LOCK_MS
        user.loginFailedCount = 0
      }
      await this.save()
      throw new DirectoryError('bad-credentials', 'invalid credentials')
    }
    if (user.loginFailedCount > 0 || user.loginLockedUntil > 0) {
      user.loginFailedCount = 0
      user.loginLockedUntil = 0
      await this.save()
    }
    return toIdentity(user, this.getRole(user.role))
  }

  /** Disable a user. Returns the subjectId so the caller revokes sessions. */
  async disable(username: string): Promise<SubjectId> {
    const state = this.loaded()
    const user = this.mustFind(username)
    if (user.role === 'admin' && state.users.filter((u) => u.role === 'admin' && !u.disabled).length <= 1) {
      throw new DirectoryError('last-admin', 'cannot disable the last admin')
    }
    user.disabled = true
    await this.save()
    return user.subjectId
  }

  /** Re-enable a disabled user. */
  async enable(username: string): Promise<void> {
    const user = this.mustFind(username)
    if (!user.disabled) return
    user.disabled = false
    user.loginFailedCount = 0
    user.loginLockedUntil = 0
    await this.save()
  }

  /**
   * Delete a user outright. Returns the subjectId so the caller revokes
   * sessions. Memberships and policies owned by the user go with them.
   */
  async deleteUser(username: string): Promise<SubjectId> {
    const state = this.loaded()
    const user = this.mustFind(username)
    if (user.role === 'admin' && state.users.filter((u) => u.role === 'admin' && !u.disabled).length <= 1) {
      throw new DirectoryError('last-admin', 'cannot delete the last admin')
    }
    state.users.splice(state.users.indexOf(user), 1)
    state.memberships = state.memberships.filter((m) => m.subject !== user.subjectId)
    state.policies = state.policies.filter((p) => p.subjectId !== user.subjectId)
    await this.save()
    return user.subjectId
  }

  /** Clear the login lockout (the reference implementation's unlock-login). */
  async unlockLogin(username: string): Promise<void> {
    const user = this.mustFind(username)
    user.loginFailedCount = 0
    user.loginLockedUntil = 0
    await this.save()
  }

  /** Edit profile fields (display name, email). */
  async updateProfile(username: string, patch: { displayName?: string; email?: string }): Promise<void> {
    const user = this.mustFind(username)
    if (patch.displayName !== undefined) {
      const name = patch.displayName.trim()
      user.displayName = name || undefined
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DirectoryError('bad-credentials', `invalid email: ${email}`)
      user.email = email || undefined
    }
    await this.save()
  }

  /** Self-service password change — verifies the old password first. */
  async changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = this.mustFind(username)
    if (!verifyPassword(oldPassword, user.passwordEnvelope)) {
      throw new DirectoryError('bad-credentials', 'invalid credentials')
    }
    if (newPassword.length < 8) throw new DirectoryError('bad-credentials', 'password too short')
    await this.resetPassword(username, newPassword)
  }

  /**
   * Batch operations (the reference implementation's /users/batch). Each item reports its own
   * outcome — one bad row never sinks the batch; the last-admin guard
   * applies per item. Returns the per-item results in order, plus the
   * subjectIds of disabled/deleted users for session revocation.
   */
  async batch(usernames: string[], action: 'enable' | 'disable' | 'delete'): Promise<{
    results: Array<{ username: string; ok: boolean; code?: string }>
    revoked: SubjectId[]
  }> {
    const results: Array<{ username: string; ok: boolean; code?: string }> = []
    const revoked: SubjectId[] = []
    for (const username of usernames) {
      try {
        if (action === 'enable') await this.enable(username)
        else if (action === 'disable') revoked.push(await this.disable(username))
        else revoked.push(await this.deleteUser(username))
        results.push({ username, ok: true })
      } catch (error) {
        results.push({ username, ok: false, code: error instanceof DirectoryError ? error.code : 'bad-request' })
      }
    }
    return { results, revoked }
  }

  async resetPassword(username: string, newPassword: string): Promise<void> {
    const user = this.mustFind(username)
    user.passwordEnvelope = hashPassword(newPassword)
    user.loginFailedCount = 0
    user.loginLockedUntil = 0
    await this.save()
  }

  listUsers(): readonly TenantUser[] {
    return this.loaded().users.filter((u) => u.tenant === this.tenant)
  }

  getUser(username: string): TenantUser | undefined {
    return this.loaded().users.find((u) => u.username === username && u.tenant === this.tenant)
  }

  private mustFind(username: string): TenantUser {
    const user = this.getUser(username)
    if (!user) throw new DirectoryError('no-such-user', `no user: ${username}`)
    return user
  }

  // ---- invites ----

  async createInvite(role: Role = 'user', ttlMs = INVITE_TTL_MS): Promise<{ code: string; expiresAt: number }> {
    const code = randomBytes(9).toString('base64url')
    const invite: Invite = {
      codeFingerprint: createHash('sha256').update(code).digest('hex'),
      tenant: this.tenant,
      role,
      expiresAt: this.now() + ttlMs,
      createdAt: this.now(),
    }
    this.loaded().invites.push(invite)
    await this.save()
    return { code, expiresAt: invite.expiresAt }
  }

  listInvites(): readonly Invite[] {
    return this.loaded().invites.filter((i) => i.tenant === this.tenant)
  }

  /** Revoke an unredeemed invite by its code. */
  async revokeInvite(code: string): Promise<boolean> {
    const state = this.loaded()
    const fp = createHash('sha256').update(code).digest('hex')
    const index = state.invites.findIndex((i) => i.codeFingerprint === fp && i.tenant === this.tenant && !i.redeemedBy)
    if (index < 0) return false
    state.invites.splice(index, 1)
    await this.save()
    return true
  }

  /** Redeem an invite code into a new user account. One-shot. */
  async redeemInvite(code: string, username: string, password: string): Promise<TenantUser> {
    const state = this.loaded()
    const fp = createHash('sha256').update(code).digest('hex')
    const invite = state.invites.find((i) => i.codeFingerprint === fp && i.tenant === this.tenant)
    if (!invite || invite.redeemedBy || invite.expiresAt <= this.now()) {
      throw new DirectoryError('invalid-invite', 'invite invalid, expired, or already redeemed')
    }
    const user = await this.createUser({ username, password, role: invite.role })
    invite.redeemedBy = user.username
    await this.save()
    return user
  }

  // ---- resource policies ----

  async setPolicy(id: SubjectId, name: ResourcePolicy['name'], value: string | undefined): Promise<void> {
    const state = this.loaded()
    const index = state.policies.findIndex((p) => p.subjectId === id && p.name === name)
    if (value === undefined) {
      if (index >= 0) state.policies.splice(index, 1)
    } else if (index >= 0) {
      state.policies[index] = { ...state.policies[index]!, value }
    } else {
      state.policies.push({ subjectId: id, name, value })
    }
    await this.save()
  }

  listPolicies(id: SubjectId): readonly ResourcePolicy[] {
    return this.loaded().policies.filter((p) => p.subjectId === id)
  }

  getPolicy(id: SubjectId, name: ResourcePolicy['name']): string | undefined {
    return this.loaded().policies.find((p) => p.subjectId === id && p.name === name)?.value
  }

  /** Accumulate one step's token spend for a subject (design 05 §2.4). */
  async recordUsage(subjectId: SubjectId, inputTokens: number, outputTokens: number): Promise<void> {
    const state = this.loaded()
    if (!Array.isArray(state.usage)) state.usage = []
    const row = state.usage.find((candidate) => candidate.subjectId === subjectId)
    const now = this.now()
    if (row === undefined) {
      state.usage.push({ subjectId, inputTokens: Math.max(0, inputTokens), outputTokens: Math.max(0, outputTokens), updatedAt: now })
    } else {
      row.inputTokens += Math.max(0, inputTokens)
      row.outputTokens += Math.max(0, outputTokens)
      row.updatedAt = now
    }
    await this.save()
  }

  /** One subject's accumulated spend; zeros when nothing was metered yet. */
  usageOf(subjectId: SubjectId): { inputTokens: number; outputTokens: number; updatedAt?: number } {
    const row = this.loaded().usage?.find((candidate) => candidate.subjectId === subjectId)
    return row === undefined
      ? { inputTokens: 0, outputTokens: 0 }
      : { inputTokens: row.inputTokens, outputTokens: row.outputTokens, updatedAt: row.updatedAt }
  }

  /** Clear a subject's spend (the quota is a lifetime budget; renewing is explicit). */
  async resetUsage(subjectId: SubjectId): Promise<void> {
    const state = this.loaded()
    if (!Array.isArray(state.usage)) state.usage = []
    state.usage = state.usage.filter((candidate) => candidate.subjectId !== subjectId)
    await this.save()
  }

  // ---- memberships (ReBAC tuples) ----

  async grant(subject: SubjectId, relation: Membership['relation'], object: string): Promise<void> {
    const state = this.loaded()
    if (!state.memberships.some((m) => m.subject === subject && m.relation === relation && m.object === object)) {
      state.memberships.push({ subject, relation, object, createdAt: this.now() })
      await this.save()
    }
  }

  async revokeMembership(subject: SubjectId, relation: Membership['relation'], object: string): Promise<void> {
    const state = this.loaded()
    const index = state.memberships.findIndex((m) => m.subject === subject && m.relation === relation && m.object === object)
    if (index >= 0) {
      state.memberships.splice(index, 1)
      await this.save()
    }
  }

  /** Direct tuple check — no graph expansion yet (M2 PDP). */
  check(subject: SubjectId, relation: Membership['relation'], object: string): boolean {
    return this.loaded().memberships.some((m) => m.subject === subject && m.relation === relation && m.object === object)
  }
}

/**
 * Builtin role templates: `admin` bypasses (see permissions.ts) and `user`
 * carries no management permission — chatting and one's own sessions are
 * never permission-gated.
 */
function builtinRoles(now: number): RoleTemplate[] {
  return [
    {
      id: ADMIN_ROLE,
      name: { zh: '管理员', en: 'Administrator' },
      description: { zh: '全部权限（含管理控制台）', en: 'Full access, including the admin console' },
      permissionKeys: PERMISSIONS.map((p) => p.key),
      builtin: true,
      createdAt: now,
    },
    {
      id: USER_ROLE,
      name: { zh: '普通用户', en: 'User' },
      description: { zh: '仅使用自己的会话与工作区', en: 'Own sessions and workspace only' },
      permissionKeys: [],
      builtin: true,
      createdAt: now,
    },
  ]
}

/** Explicit keys for normal roles; admin bypasses and reports the full catalog. */
export function effectivePermissions(user: TenantUser, template: RoleTemplate | undefined): readonly string[] {
  if (user.role === ADMIN_ROLE) return PERMISSIONS.map((p) => p.key)
  return template?.permissionKeys ?? []
}
