/**
 * The schema ↔ form model of the channel editor (design 07 §5).
 *
 * The host ships a per-type schema (`GET /schema`): the field list, each
 * control kind, its required flag and its locale keys. This module owns the
 * pure translation between that declaration, the values a form holds, the
 * config block the API receives, and the draft written to `sessionStorage`.
 *
 * The one invariant worth restating: a `password`-kind config field is dropped
 * from every draft. Config is non-secret by contract, but `password` is a
 * declared kind, so the one kind that could carry a secret is excluded rather
 * than trusted.
 */
import type { ChannelInstanceView, ChannelTypeSchema, CredentialSpec, FieldSpec } from '../../api.ts'
import type { ChannelDraft, DraftScope } from '../../draft.ts'
import { localize, type Translate } from '../../locales.ts'
import type { EditTarget } from '../contracts.ts'

/** A form value in its control's native domain (checkbox/toggle → boolean). */
export type FormValue = string | boolean

export type FormValues = Record<string, FormValue>

export function scopeOf(target: EditTarget, channelType: string): DraftScope {
  return target.mode === 'edit'
    ? { kind: 'instance', id: target.instance.id }
    : { kind: 'new', channelType }
}

/** The schema's own defaults, in the form's control domain. */
export function defaultsFor(schema: ChannelTypeSchema | undefined): FormValues {
  const values: FormValues = {}
  for (const field of schema?.config ?? []) {
    values[field.name] = field.kind === 'switch'
      ? field.default === true
      : field.default === undefined || field.default === null ? '' : String(field.default)
  }
  return values
}

/** An instance's persisted config projected onto the form controls. */
export function configToForm(schema: ChannelTypeSchema | undefined, config: Readonly<Record<string, unknown>>): FormValues {
  const values: FormValues = {}
  for (const field of schema?.config ?? []) {
    const value = config[field.name]
    if (field.kind === 'switch') values[field.name] = value === true
    else if (value === undefined || value === null) values[field.name] = ''
    else values[field.name] = String(value)
  }
  return values
}

/** The baseline a restored draft is compared against (dirty detection). */
export function baselineFor(schema: ChannelTypeSchema | undefined, instance: ChannelInstanceView | undefined): FormValues {
  return instance === undefined ? defaultsFor(schema) : configToForm(schema, instance.config)
}

/** Accept a draft value only when its type fits the declared control. */
function coerceDraftValue(field: FieldSpec, value: unknown): FormValue | undefined {
  if (field.kind === 'switch') return typeof value === 'boolean' ? value : undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/** Overlay a restored draft on the baseline (unknown keys dropped). */
export function mergeDraft(
  schema: ChannelTypeSchema | undefined,
  base: FormValues,
  draft: ChannelDraft | undefined,
): FormValues {
  const values = { ...base }
  if (schema === undefined || draft === undefined) return values
  for (const field of schema.config) {
    const raw = draft.config[field.name]
    if (raw === undefined) continue
    const coerced = coerceDraftValue(field, raw)
    if (coerced !== undefined) values[field.name] = coerced
  }
  return values
}

/** Current values in schema order, normalized — the comparable/draft shape. */
export function pickSchemaValues(schema: ChannelTypeSchema | undefined, values: FormValues): FormValues {
  const picked: FormValues = {}
  for (const field of schema?.config ?? []) {
    const value = values[field.name]
    picked[field.name] = field.kind === 'switch'
      ? value === true
      : typeof value === 'string' ? value : value === undefined ? '' : String(value)
  }
  return picked
}

/**
 * The non-secret config block for the API. Empty controls are omitted so the
 * host applies its declared default; a switch always travels explicitly
 * (`false` is a value, not an absence).
 */
export function configPayload(schema: ChannelTypeSchema, values: FormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const field of schema.config) {
    const value = values[field.name]
    if (field.kind === 'switch') {
      payload[field.name] = value === true
      continue
    }
    const raw = typeof value === 'string' ? value : ''
    if (raw === '') continue
    payload[field.name] = field.kind === 'number' ? Number(raw) : raw
  }
  return payload
}

/**
 * The subset of a config snapshot that may be persisted as a draft: everything
 * except the one kind that could carry a secret.
 */
export function draftValues(schema: ChannelTypeSchema | undefined, values: FormValues): FormValues {
  if (schema === undefined) return {}
  const draftable: FormValues = {}
  for (const field of schema.config) {
    if (field.kind === 'password') continue
    draftable[field.name] = values[field.name] ?? (field.kind === 'switch' ? false : '')
  }
  return draftable
}

export function isBlank(value: FormValue | undefined): boolean {
  return value === undefined || value === ''
}

/** A host-declared label key, falling back to the raw field name. */
export function fieldLabel(t: Translate, field: FieldSpec): string {
  return localize(t, field.labelKey, field.name)
}

export function credentialLabel(t: Translate, spec: CredentialSpec): string {
  return localize(t, spec.labelKey, spec.name)
}

/**
 * The `credentials` map for the API. Empty controls are omitted (the host
 * keeps the stored value for those fields); `undefined` means "nothing to
 * change" and no key travels at all.
 */
export function credentialsPayload(secrets: Record<string, string>): Record<string, string> | undefined {
  const payload: Record<string, string> = {}
  for (const [field, value] of Object.entries(secrets)) {
    if (value.trim() !== '') payload[field] = value
  }
  return Object.keys(payload).length === 0 ? undefined : payload
}
