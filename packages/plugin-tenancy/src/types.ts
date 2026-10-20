/**
 * Tenancy domain model (design: docs/design/03-tenancy.md, 05-admin-users.md).
 *
 * ReBAC-ready from day one (05 §4): memberships are stored as
 * `(subject, relation, object)` tuples even though M1 only uses the
 * `owner`/`member` relations.
 */
import type { Identity, SubjectId, TenantId } from '@tentacle/identity'

/**
 * Role template id: the builtins `admin`/`user` or a custom template id.
 * Kept as a plain string so custom templates are not a type-level special case.
 */
export type Role = string

/** Bilingual display text stored with the data (the roster has no locale). */
export interface LocalizedText {
  readonly zh: string
  readonly en: string
}

export interface RoleTemplate {
  readonly id: string
  name: LocalizedText
  description?: LocalizedText
  /** Permission keys this template grants (ignored for `admin`: it bypasses). */
  permissionKeys: string[]
  readonly builtin: boolean
  readonly createdAt: number
}

export interface TenantUser {
  // Internal mutable record — mutation happens only inside UserDirectory,
  // which persists through the repo after each change.
  subjectId: SubjectId
  tenant: TenantId
  username: string
  displayName?: string
  email?: string
  role: Role
  passwordEnvelope: string
  disabled: boolean
  loginFailedCount: number
  loginLockedUntil: number
  readonly createdAt: number
}

export interface Invite {
  /** sha256 of the invite code — the code itself is never stored. */
  readonly codeFingerprint: string
  readonly tenant: TenantId
  readonly role: Role
  readonly expiresAt: number
  /** Set by UserDirectory.redeemInvite; internal mutable record. */
  redeemedBy?: string
  readonly createdAt: number
}

/** Named per-user resource policy (reference-style): quota and fences. */
export interface ResourcePolicy {
  readonly subjectId: SubjectId
  readonly name: 'workspace_root_dir' | 'token_quota' | 'max_agents'
  readonly value: string
}

/** ReBAC tuple. Object ids follow `workspace:<id>` / `tenant:<id>` etc. */
export interface Membership {
  readonly subject: SubjectId
  readonly relation: 'owner' | 'admin' | 'editor' | 'viewer' | 'member'
  readonly object: string
  readonly createdAt: number
}

/**
 * Token spend accumulated for one subject (design 05 §2.4). The quota policy
 * (`token_quota`) is a LIFETIME budget: the admin resets a row explicitly when
 * a period rolls over — there is no implicit period, because none was ever
 * declared for the policy value.
 */
export interface UsageRow {
  readonly subjectId: SubjectId
  inputTokens: number
  outputTokens: number
  updatedAt: number
}

/** Persisted shape of the whole directory (one JSON document). */
export interface DirectoryState {
  version: 1
  users: TenantUser[]
  roles: RoleTemplate[]
  invites: Invite[]
  policies: ResourcePolicy[]
  memberships: Membership[]
  /** Token spend ledger; absent on state roots from before metering existed. */
  usage?: UsageRow[]
}

export function emptyState(): DirectoryState {
  return { version: 1, users: [], roles: [], invites: [], policies: [], memberships: [], usage: [] }
}

/**
 * Project a user into the public Identity DTO. Effective permissions come
 * from the user's role template; `admin` bypasses and therefore carries the
 * wildcard marker the policies understand (see permissions.ts).
 */
export function toIdentity(user: TenantUser, template?: RoleTemplate): Identity {
  return {
    subjectId: user.subjectId,
    tenant: user.tenant,
    handle: user.username,
    displayName: user.displayName,
    roles: [user.role],
    permissions: template?.permissionKeys ?? [],
    createdAt: user.createdAt,
  }
}
