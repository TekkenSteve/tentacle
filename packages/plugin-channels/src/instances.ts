/**
 * Channel instances — the managed resource (design: docs/design/07-channel-admin.md §1).
 *
 * An instance is one platform bot connection owned by a tenant. Secrets never
 * live here: the record carries only the non-secret `config` block plus an
 * optional deployment-provided `tokenRef`, while the token itself lives in the
 * official credentials store keyed by the instance id (design 07 §3).
 *
 * This module is cordis-free and pure: id/name/config validation, the per-type
 * field schema, and the error vocabulary shared by the Registry, the admin API
 * and the client form.
 */
import { randomUUID } from 'node:crypto'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { tenantId, type TenantId } from '@tentacle/identity'
import type { ChannelTarget, ChannelType } from './types.js'

/** One managed channel instance (design 07 §1). */
export interface ChannelInstance {
  readonly id: string
  /** Owning tenant — a real field, enforced by every write (design 07 §0 D2). */
  readonly tenant: TenantId
  readonly channelType: ChannelType
  /** Display name, unique within the tenant. */
  name: string
  /** Disable keeps config, bindings and cursor; only `remove` clears them. */
  enabled: boolean
  /** Non-secret platform parameters; never carries a token. */
  config: Record<string, unknown>
  /** Deployment-provided credential reference; wins over the instance record. */
  tokenRef?: string
  /**
   * Routing target (design 10 §7): the expert or team this channel routes to.
   * The target's preset, model, permission preset and shared workspace are
   * applied to every session created from this channel. Required — a channel
   * without a target is not a representable state (the reference implementation's
   * `channels.agent_id NOT NULL`).
   */
  target: ChannelTarget
  readonly createdAt: number
  updatedAt: number
}

/** Error vocabulary shared by Registry → admin API → client (design 07 §4). */
export type ChannelErrorCode =
  | 'name-taken'
  | 'no-such-channel'
  | 'invalid-name'
  | 'invalid-channel-type'
  | 'invalid-config'
  | 'invalid-credential-ref'
  | 'invalid-tenant'
  | 'credentials-unavailable'
  | 'forbidden-tenant'

export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode, message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

/** The platforms this build knows how to run. */
export const CHANNEL_TYPES: readonly ChannelType[] = ['telegram', 'feishu', 'dingtalk', 'wecom', 'qq', 'weixin', 'yuanbao', 'discord']

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as readonly string[]).includes(value)
}

export function requireChannelType(value: unknown): ChannelType {
  if (!isChannelType(value)) {
    throw new ChannelError('invalid-channel-type', `unknown channel type: ${String(value)}`)
  }
  return value
}

const MAX_NAME_CHARS = 64

/**
 * Trim and validate a display name. Control characters are rejected rather
 * than stripped: a name is operator input, and silently rewriting it hides a
 * client bug.
 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ChannelError('invalid-name', 'name must be a string')
  const name = raw.trim()
  if (name.length === 0) throw new ChannelError('invalid-name', 'name must not be empty')
  if (name.length > MAX_NAME_CHARS) throw new ChannelError('invalid-name', `name must be at most ${MAX_NAME_CHARS} characters`)
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) throw new ChannelError('invalid-name', 'name must not contain control characters')
  }
  return name
}

/** Target ids are slugs owned by plugin-persona (experts) / plugin-teams (teams). */
const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The target kinds this build can route to. */
const TARGET_KINDS = ['expert', 'team'] as const

export function isChannelTarget(value: unknown): value is ChannelTarget {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { kind?: unknown; id?: unknown }
  return typeof candidate.kind === 'string'
    && (TARGET_KINDS as readonly string[]).includes(candidate.kind)
    && typeof candidate.id === 'string'
    && TARGET_ID_PATTERN.test(candidate.id)
}

/**
 * Validate the SHAPE of a routing target (never its existence: the service
 * checks the id against the owning library, exactly as it did for experts).
 */
export function requireTarget(value: unknown): ChannelTarget {
  if (!isChannelTarget(value)) {
    throw new ChannelError('invalid-config', 'target must be { kind: expert|team, id }')
  }
  return value
}

/** Migrate a legacy record that only carries `expertId` (design 10 §7). */
export function targetOfLegacyExpertId(expertId: string): ChannelTarget {
  return { kind: 'expert', id: expertId }
}

export function normalizeTokenRef(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || !isCredentialRefName(raw)) {
    throw new ChannelError('invalid-credential-ref', `not a credential reference name: ${String(raw)}`)
  }
  return raw
}

/** Tenant ids come from the request only for admins acting across tenants. */
export function normalizeTenant(raw: unknown): TenantId | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new ChannelError('invalid-tenant', 'tenant must be a string')
  try {
    return tenantId(raw)
  } catch {
    throw new ChannelError('invalid-tenant', `invalid tenant id: ${raw}`)
  }
}

/**
 * A fresh instance id.
 *
 * The id doubles as the instance's credential record id segment, and the
 * official key grammar requires that segment to start with a letter — so the
 * UUID is prefixed rather than used bare. Hyphens are allowed; uppercase and
 * digits-first are not.
 */
export function newInstanceId(): string {
  return `ch-${randomUUID()}`
}

// ---- per-type field schema (drives the client form, validates the server) ----

/**
 * Form control kinds. The client renders exactly these; an unknown kind is a
 * host bug, not a value the client should guess at.
 */
export type FieldKind = 'text' | 'password' | 'switch' | 'number' | 'select'

export interface FieldOption {
  readonly value: string
  /** Client locale key; the client falls back to `value` when unknown. */
  readonly labelKey: string
}

/**
 * One editable field. `labelKey`/`placeholderKey` are locale keys resolved by
 * the CLIENT (`tentacle-channels` namespace) — the host never ships UI copy.
 */
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

/** The credential a channel type needs (design 07 §3 — never part of `config`). */
export interface CredentialSpec {
  /** Field name in the create/update payload's `credentials` map. */
  readonly name: string
  readonly required: boolean
  readonly labelKey: string
  readonly placeholderKey?: string
  readonly helpKey?: string
}

export interface ChannelTypeSchema {
  readonly channelType: ChannelType
  /** Non-secret config fields persisted on the instance. */
  readonly config: readonly FieldSpec[]
  /**
   * The secrets this platform needs, as named fields — a platform may need
   * several (an app id's secret plus callback verification keys). They live
   * together in ONE per-instance credential record (design 07 §3); an empty
   * list means the platform authenticates inbound-only.
   */
  readonly credentials: readonly CredentialSpec[]
  /**
   * Whether this deployment offers a quick-setup (QR) flow for the type
   * (design 08). Filled by the service, which knows the registered flows.
   */
  readonly quickSetup?: boolean
}

/**
 * Telegram's non-secret knobs, mirroring `TelegramChannelConfig` minus
 * `enabled`/`tokenRef`/`token` (those are instance fields, not config).
 */
const TELEGRAM_SCHEMA: ChannelTypeSchema = {
  channelType: 'telegram',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.placeholder',
      helpKey: 'channels.field.apiBaseUrl.help',
    },
    {
      name: 'pollTimeoutSec',
      kind: 'number',
      labelKey: 'channels.field.pollTimeoutSec',
      helpKey: 'channels.field.pollTimeoutSec.help',
      default: 30,
    },
    {
      name: 'typing',
      kind: 'switch',
      labelKey: 'channels.field.typing',
      helpKey: 'channels.field.typing.help',
      default: true,
    },
  ],
  credentials: [
    {
      name: 'token',
      required: true,
      labelKey: 'channels.field.token',
      placeholderKey: 'channels.field.token.placeholder',
      helpKey: 'channels.field.token.help',
    },
  ],
}

/**
 * Feishu (Lark) — webhook push platform (design 06 §6 "未来平台").
 *
 * `appId` lives with the credentials, not in `config`: it and `appSecret` are
 * one deployment pair issued together by the open platform, and the console
 * renders the pair in one place. `encryptKey` / `verificationToken` are the
 * optional callback-verification secrets (event subscription encryption and
 * the plain-token check); both stay secrets because either one is enough to
 * forge inbound events.
 */
const FEISHU_SCHEMA: ChannelTypeSchema = {
  channelType: 'feishu',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.feishu.placeholder',
      helpKey: 'channels.field.apiBaseUrl.feishu.help',
    },
  ],
  credentials: [
    { name: 'appId', required: true, labelKey: 'channels.field.appId', helpKey: 'channels.field.appId.help' },
    { name: 'appSecret', required: true, labelKey: 'channels.field.appSecret', helpKey: 'channels.field.appSecret.help' },
    { name: 'encryptKey', required: false, labelKey: 'channels.field.encryptKey', helpKey: 'channels.field.encryptKey.help' },
    { name: 'verificationToken', required: false, labelKey: 'channels.field.verificationToken', helpKey: 'channels.field.verificationToken.help' },
  ],
}

const WEIXIN_SCHEMA: ChannelTypeSchema = {
  channelType: 'weixin',
  config: [
    {
      name: 'baseUrl',
      kind: 'text',
      labelKey: 'channels.field.baseUrl',
      placeholderKey: 'channels.field.baseUrl.weixin.placeholder',
      helpKey: 'channels.field.baseUrl.weixin.help',
      default: 'https://ilinkai.weixin.qq.com',
    },
    { name: 'botUin', kind: 'text', labelKey: 'channels.field.botUin', helpKey: 'channels.field.botUin.help' },
  ],
  credentials: [
    { name: 'accountId', required: true, labelKey: 'channels.field.accountId', helpKey: 'channels.field.accountId.help' },
    { name: 'token', required: true, labelKey: 'channels.field.weixinToken', helpKey: 'channels.field.weixinToken.help' },
  ],
}

const QQ_SCHEMA: ChannelTypeSchema = {
  channelType: 'qq',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.qq.placeholder',
      helpKey: 'channels.field.apiBaseUrl.qq.help',
    },
    { name: 'userOpenid', kind: 'text', labelKey: 'channels.field.userOpenid', helpKey: 'channels.field.userOpenid.help' },
  ],
  credentials: [
    { name: 'appId', required: true, labelKey: 'channels.field.qqAppId', helpKey: 'channels.field.qqAppId.help' },
    { name: 'secret', required: true, labelKey: 'channels.field.qqSecret', helpKey: 'channels.field.qqSecret.help' },
  ],
}

const WECOM_SCHEMA: ChannelTypeSchema = {
  channelType: 'wecom',
  config: [
    {
      name: 'wsUrl',
      kind: 'text',
      labelKey: 'channels.field.wecomWsUrl',
      placeholderKey: 'channels.field.wecomWsUrl.placeholder',
      helpKey: 'channels.field.wecomWsUrl.help',
    },
  ],
  credentials: [
    { name: 'botId', required: true, labelKey: 'channels.field.wecomBotId', helpKey: 'channels.field.wecomBotId.help' },
    { name: 'secret', required: true, labelKey: 'channels.field.wecomSecret', helpKey: 'channels.field.wecomSecret.help' },
  ],
}

const DINGTALK_SCHEMA: ChannelTypeSchema = {
  channelType: 'dingtalk',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.dingtalk.placeholder',
      helpKey: 'channels.field.apiBaseUrl.dingtalk.help',
    },
    {
      name: 'streamUrl',
      kind: 'text',
      labelKey: 'channels.field.streamUrl',
      placeholderKey: 'channels.field.streamUrl.placeholder',
      helpKey: 'channels.field.streamUrl.help',
    },
  ],
  credentials: [
    { name: 'clientId', required: true, labelKey: 'channels.field.clientId', helpKey: 'channels.field.clientId.help' },
    { name: 'clientSecret', required: true, labelKey: 'channels.field.clientSecret', helpKey: 'channels.field.clientSecret.help' },
    { name: 'robotCode', required: false, labelKey: 'channels.field.robotCode', helpKey: 'channels.field.robotCode.help' },
  ],
}

const YUANBAO_SCHEMA: ChannelTypeSchema = {
  channelType: 'yuanbao',
  config: [
    { name: 'apiDomain', kind: 'text', labelKey: 'channels.field.apiDomain', placeholderKey: 'channels.field.apiDomain.yuanbao.placeholder', helpKey: 'channels.field.apiDomain.yuanbao.help' },
    { name: 'wsUrl', kind: 'text', labelKey: 'channels.field.wsUrl', placeholderKey: 'channels.field.wsUrl.yuanbao.placeholder', helpKey: 'channels.field.wsUrl.yuanbao.help' },
  ],
  credentials: [
    { name: 'appKey', required: true, labelKey: 'channels.field.appKey', helpKey: 'channels.field.appKey.yuanbao.help' },
    { name: 'appSecret', required: true, labelKey: 'channels.field.appSecret', helpKey: 'channels.field.appSecret.yuanbao.help' },
  ],
}

const DISCORD_SCHEMA: ChannelTypeSchema = {
  channelType: 'discord',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.discord.placeholder',
      helpKey: 'channels.field.apiBaseUrl.discord.help',
    },
  ],
  credentials: [
    { name: 'token', required: true, labelKey: 'channels.field.discordToken', helpKey: 'channels.field.discordToken.help' },
  ],
}

const SCHEMAS: Record<ChannelType, ChannelTypeSchema> = {
  telegram: TELEGRAM_SCHEMA,
  feishu: FEISHU_SCHEMA,
  dingtalk: DINGTALK_SCHEMA,
  wecom: WECOM_SCHEMA,
  qq: QQ_SCHEMA,
  weixin: WEIXIN_SCHEMA,
  yuanbao: YUANBAO_SCHEMA,
  discord: DISCORD_SCHEMA,
}

export function schemaOf(channelType: ChannelType): ChannelTypeSchema {
  // The shared policy field is decorated ONCE here: both the admin /schema
  // surface and validateConfig see the same declaration (no second copy).
  return { ...SCHEMAS[channelType], config: [...SCHEMAS[channelType].config, UNBOUND_POLICY_FIELD] }
}

/** The form schema for every type this build supports (served at `GET /schema`). */
/**
 * The unbound-sender policy, one of the three real tiers (06 §5), declared as a
 * shared schema field so every platform's create/edit form carries it.
 */
const UNBOUND_POLICY_FIELD: FieldSpec = {
  name: 'unboundPolicy',
  kind: 'select',
  labelKey: 'channels.field.unboundPolicy',
  helpKey: 'channels.field.unboundPolicy.help',
  // No materialized default: an absent value already means `reject` at routing
  // time, so new records must not gain a redundant key (existing tests pin this).
  options: [
    { value: 'reject', labelKey: 'channels.field.unboundPolicy.reject' },
    { value: 'guest', labelKey: 'channels.field.unboundPolicy.guest' },
    { value: 'owner', labelKey: 'channels.field.unboundPolicy.owner' },
  ],
}

export function allSchemas(): readonly ChannelTypeSchema[] {
  return CHANNEL_TYPES.map((type) => schemaOf(type))
}

/**
 * Validate a `credentials` map against its type schema: the SAME strictness as
 * {@link validateConfig} — an unknown key is an error. Empty strings count as
 * absent ("leave unchanged" on update); required-ness is a START-time fact (an
 * instance may exist unconfigured and say so on the console), not a create-time
 * one.
 */
export function validateCredentials(channelType: ChannelType, raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChannelError('invalid-config', 'credentials must be an object')
  }
  const input = raw as Record<string, unknown>
  const declared = new Set(schemaOf(channelType).credentials.map((field) => field.name))
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) throw new ChannelError('invalid-config', `unknown credential field for ${channelType}: ${key}`)
  }
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw new ChannelError('invalid-config', `credential ${key} must be a string`)
    if (value.trim() !== '') values[key] = value
  }
  return values
}

/** The credential fields a type declares, by name. */
export function requiredCredentials(channelType: ChannelType): readonly string[] {
  return schemaOf(channelType).credentials.filter((field) => field.required).map((field) => field.name)
}

/**
 * Validate and normalize a config block against its type schema.
 *
 * Strict by design: an unknown key is an error, not a value to carry along —
 * a typo must surface at the API boundary instead of silently becoming
 * durable state. Missing optional fields take their declared default; empty
 * strings count as absent.
 */
export function validateConfig(channelType: ChannelType, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChannelError('invalid-config', 'config must be an object')
  }
  const input = raw as Record<string, unknown>
  const schema = schemaOf(channelType)
  const declared = new Map(schema.config.map((field) => [field.name, field]))

  for (const key of Object.keys(input)) {
    if (!declared.has(key)) throw new ChannelError('invalid-config', `unknown config field for ${channelType}: ${key}`)
  }

  const config: Record<string, unknown> = {}
  for (const field of schema.config) {
    const value = input[field.name]
    if (value === undefined || value === null || value === '') {
      if (field.default !== undefined) config[field.name] = field.default
      else if (field.required === true) throw new ChannelError('invalid-config', `${field.name} is required`)
      continue
    }
    config[field.name] = coerceField(field, value)
  }
  return config
}

/** Coerce one declared field, rejecting anything the control cannot produce. */
function coerceField(field: FieldSpec, value: unknown): unknown {
  switch (field.kind) {
    case 'text':
    case 'password':
      if (typeof value !== 'string') throw new ChannelError('invalid-config', `${field.name} must be a string`)
      return value
    case 'switch':
      if (typeof value !== 'boolean') throw new ChannelError('invalid-config', `${field.name} must be a boolean`)
      return value
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ChannelError('invalid-config', `${field.name} must be a finite number`)
      }
      return value
    }
    case 'select': {
      const allowed = (field.options ?? []).map((option) => option.value)
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new ChannelError('invalid-config', `${field.name} must be one of: ${allowed.join(', ')}`)
      }
      return value
    }
  }
}
