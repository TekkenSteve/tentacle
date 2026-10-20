/**
 * The browser half's REST client for `/tentacle/api/admin/channels`
 * (design 07 §4).
 *
 * The wire shapes are declared here as the CLIENT's view of the contract: the
 * bundle may not import the host half (`tsdown` inlines everything reachable,
 * and the host modules pull node-only dependencies), so the handful of fields
 * the console renders are mirrored rather than shared. The mirror is small on
 * purpose — anything the console does not display does not belong here.
 */
import type { ChannelsLocaleKey, Translate } from './locales.ts'

export const CHANNELS_API_PREFIX = '/tentacle/api/admin/channels'

// ---- wire shapes ---------------------------------------------------------

/** One instance's runtime projection (design 07 §4). */
export type InstanceRuntime =
  | { readonly state: 'disabled' }
  | { readonly state: 'pending' }
  // The identity id is numeric on Telegram but an opaque string (open_id) on
  // feishu — the console only ever renders it, so the union is safe.
  | { readonly state: 'connected'; readonly identity?: { readonly id: number | string; readonly username?: string } }
  | { readonly state: 'failed'; readonly error: string }

/** Credential facts only — the value never crosses this surface (design 07 §3). */
export interface CredentialStatus {
  readonly configured: boolean
  readonly writable: boolean
}

/** Where a channel routes (design 10 §7): an expert or a team. */
export type ChannelTarget =
  | { readonly kind: 'expert'; readonly id: string }
  | { readonly kind: 'team'; readonly id: string }

/** Encode one target as a `<select>` value (`expert:<id>` / `team:<id>`). */
export function targetKey(target: ChannelTarget): string {
  return `${target.kind}:${target.id}`
}

/** Decode a `<select>` value back into a target; undefined when malformed. */
export function targetOfKey(key: string): ChannelTarget | undefined {
  const separator = key.indexOf(':')
  if (separator <= 0) return undefined
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if ((kind !== 'expert' && kind !== 'team') || id === '') return undefined
  return { kind, id }
}

/** One channel instance as the admin API returns it. */
export interface ChannelInstanceView {
  readonly id: string
  readonly tenant: string
  readonly channelType: string
  readonly name: string
  readonly enabled: boolean
  readonly config: Readonly<Record<string, unknown>>
  readonly tokenRef?: string
  /** Routing target (design 10 §7) — an expert or a team; always present. */
  readonly target: ChannelTarget
  /** Resolved target display name; absent only if the binding is dangling. */
  readonly targetName?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly runtime: InstanceRuntime
  readonly credential: CredentialStatus
}

/** One platform-identity ↔ tenant-user binding row. */
export interface BindingView {
  readonly channelId: string
  readonly channelType: string
  readonly platformId: string
  readonly subjectId: string
  readonly boundAt: number
  readonly username?: string
}

/** One channel conversation ↔ DSH session link (read-only). */
export interface ConversationView {
  readonly channelId: string
  readonly conversation: string
  readonly sessionId: string
}

/** One expert instance offered to the channel form's routing dropdown. */
export interface ExpertRouteView {
  readonly id: string
  readonly name: string
  readonly agentPresetId: string
}

/** One team instance offered to the channel form's routing dropdown. */
export interface TeamRouteView {
  readonly id: string
  readonly name: string
  readonly agentPresetId: string
}

/** One refused unbound sender (reject policy) awaiting an admin decision. */
export interface PendingSenderView {
  readonly channelId: string
  readonly channelType: string
  readonly platformId: string
  readonly displayName?: string
  readonly preview?: string
  readonly lastSeen: number
  readonly messages: number
}

/** The whole admin overview in one round trip (`GET /`). */
export interface ChannelOverview {
  readonly instances: readonly ChannelInstanceView[]
  readonly bindings: readonly BindingView[]
  readonly conversations: readonly ConversationView[]
  readonly pendingSenders: readonly PendingSenderView[]
  readonly lastFailure?: string
}

/** Form control kinds the host may declare (`src/instances.ts` FieldKind). */
export type FieldKind = 'text' | 'password' | 'switch' | 'number' | 'select'

export interface FieldOption {
  readonly value: string
  /** Resolved by the client; falls back to `value` when unknown. */
  readonly labelKey: string
}

/** One editable non-secret config field, as declared by the host. */
export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  readonly labelKey: string
  readonly placeholderKey?: string
  readonly helpKey?: string
  readonly required?: boolean
  readonly options?: readonly FieldOption[]
  readonly default?: unknown
}

/** One secret field a channel type needs; never part of `config`. */
export interface CredentialSpec {
  readonly name: string
  readonly required: boolean
  readonly labelKey: string
  readonly placeholderKey?: string
  readonly helpKey?: string
}

/** One channel type's form schema (`GET /schema`). */
export interface ChannelTypeSchema {
  readonly channelType: string
  readonly config: readonly FieldSpec[]
  /** The named secrets this platform needs; empty for inbound-only platforms. */
  readonly credentials: readonly CredentialSpec[]
  /** Whether a quick-setup (QR) flow is offered for this type (design 08). */
  readonly quickSetup?: boolean
}

/** A draft or saved connection probe. */
export type ProbeResult =
  | { readonly ok: true; readonly identity?: { readonly id: number; readonly username?: string } }
  | { readonly ok: false; readonly error: string }

/**
 * The quick-setup (QR) flow's public projection (design 08). Secrets never
 * appear here: on success the instance has already been created and enabled
 * on the host.
 */
export type ProvisionStatus =
  | { readonly state: 'pending' | 'waiting'; readonly flowId: string; readonly qrUrl?: string; readonly userCode?: string; readonly message?: string; readonly pollAfterMs?: number }
  | { readonly state: 'success'; readonly flowId: string; readonly instance: ChannelInstanceView }
  | { readonly state: 'failed'; readonly flowId: string; readonly error: string }
  | { readonly state: 'expired'; readonly flowId: string }

/** A user a binding may point at, within the instance's tenant. */
export interface BindableUser {
  readonly subjectId: string
  readonly username: string
}

// ---- transport -----------------------------------------------------------

/** An API rejection carrying the host's stable error code (design 07 §4). */
export class ChannelsApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'ChannelsApiError'
  }
}

/** The `{error}` body the gateway/admin API writes on failure. */
function errorCode(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { error?: unknown }).error
    if (typeof code === 'string' && code !== '') return code
  }
  return String(status)
}

/**
 * One admin call. `body` present ⇒ POST; absent ⇒ GET. A non-2xx response is
 * rejected with {@link ChannelsApiError} so callers can localize the code.
 */
export async function channelsCall<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CHANNELS_API_PREFIX}${path}`, body !== undefined ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined)
  const payload: unknown = await res.json().catch(() => undefined)
  if (!res.ok) throw new ChannelsApiError(errorCode(payload, res.status), res.status)
  return payload as T
}

/**
 * Error code → dictionary key. The list is the host's error vocabulary
 * (`errorStatus` in `src/admin-api.ts`); a code outside it is shown verbatim
 * rather than swallowed into a generic message.
 */
const ERROR_KEYS: Readonly<Record<string, ChannelsLocaleKey>> = {
  'name-taken': 'channels.error.nameTaken',
  'no-such-channel': 'channels.error.noSuchChannel',
  'invalid-config': 'channels.error.invalidConfig',
  'invalid-name': 'channels.error.invalidName',
  'invalid-tenant': 'channels.error.invalidTenant',
  'invalid-credential-ref': 'channels.error.invalidCredentialRef',
  'credentials-unavailable': 'channels.error.credentialsUnavailable',
  'forbidden-tenant': 'channels.error.forbiddenTenant',
  'already-bound': 'channels.error.alreadyBound',
  'unknown-user': 'channels.error.unknownUser',
  'channel-tenant-mismatch': 'channels.error.channelTenantMismatch',
  'no-such-binding': 'channels.error.noSuchBinding',
  'invalid-channel-type': 'channels.error.invalidChannelType',
  'invalid-binding': 'channels.error.invalidBinding',
  'internal-error': 'channels.error.internalError',
}

/** Localized, human-readable text for a thrown error (unknown code verbatim). */
export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof ChannelsApiError
    ? error.code
    : error instanceof Error ? error.message : String(error)
  const key = ERROR_KEYS[code]
  return key === undefined ? code : t(key)
}
