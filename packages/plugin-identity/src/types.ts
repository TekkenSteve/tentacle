/**
 * Tentacle identity model. See docs/design/01-identity.md.
 *
 * D1 — identity/name separation: `subjectId` is the immutable, verifiable
 * authorization subject; `handle`/`displayName` are presentation-only and
 * must never feed an authorization decision.
 */

/** Brand helper (nominal typing) so ids never mix across domains. */
declare const brand: unique symbol
export type Branded<Name extends string, Base extends string = string> = Base & { readonly [brand]: Name }

export type SubjectId = Branded<'SubjectId'>     // e.g. did:key:z6Mk...
export type TenantId = Branded<'TenantId'>

export interface Identity {
  readonly subjectId: SubjectId
  readonly tenant: TenantId
  /** Human-readable stable name (alice@tenant). Display/lookup only. */
  readonly handle?: string
  /** Display-only; never used for routing or authorization. */
  readonly displayName?: string
  /**
   * Authorization roles (role-template ids). Consulted for the admin bypass
   * and audit; fine-grained decisions read `permissions`.
   */
  readonly roles?: readonly string[]
  /**
   * Effective permission keys resolved from the role template (docs/design
   * 05 §3). Policies consult these plus `roles` — never handles or display
   * names (D1).
   */
  readonly permissions?: readonly string[]
  readonly createdAt: number
}

export function subjectId(raw: string): SubjectId {
  if (!raw.startsWith('did:')) throw new Error(`subjectId must be a DID, got: ${raw}`)
  return raw as SubjectId
}

export function tenantId(raw: string): TenantId {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw)) throw new Error(`invalid tenant id: ${raw}`)
  return raw as TenantId
}

/**
 * Pluggable identity provider (D3). The service owns the registry; a provider
 * answers "who is this" for the surfaces it authenticates.
 *
 * Secrets never leave the provider's Host process (D4): implementations must
 * not expose private keys, tokens, or signing capability through this
 * interface — only the public Identity DTO crosses the boundary.
 */
export interface IdentityProvider {
  readonly kind: string
  /** Provision or load this provider's local identity state (idempotent). */
  boot(): Promise<void>
  /** The identity this provider authenticates the local operator as. */
  current(): Promise<Identity>
  /** Resolve a subjectId back to its public identity, if known. */
  resolve(id: SubjectId): Promise<Identity | undefined>
}
